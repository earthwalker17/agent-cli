import { z } from 'zod';
import { gitPushArgv, renderArgv } from '../remote/argv.js';
import { RemoteError, classifyRemoteFailure, remoteFailureMessage } from '../remote/errors.js';
import { renderPushOutcome } from '../remote/format.js';
import {
  describeRelation,
  expectedPushFlags,
  firstLine,
  lsRemoteOid,
  parsePushPorcelain,
  resolveRev,
  runRemoteGit,
  type RemoteGitDeps,
} from '../remote/observe.js';
import { qualifyBranch, qualifyTag, shortOid, shortRef } from '../remote/refs.js';
import { REMOTE_PUSH_TIMEOUT_MS, type RemoteEndpoint, type RemoteObservation } from '../remote/types.js';
import { truncateForModel } from '../shared/hash.js';
import type { RemoteBlockKind, RemoteTargetFact, RemoteWriteFact, SessionEvent, Tool, ToolResult } from '../types.js';
import { localEvidenceLine, type RemoteState } from './remote-state.js';

/**
 * remote_push (Session 20) — publish ONE explicitly named ref to ONE explicitly named remote.
 *
 * The design in one sentence: the object that reaches the remote is the object the human read in
 * the approval prompt, and the harness proves it three ways.
 *
 *  1. The refspec source is the observed OID, not a branch name. Git accepts an arbitrary commit-ish
 *     as a refspec source, so a local branch that moves while a human reads the prompt cannot
 *     change what is sent.
 *  2. Execute re-reads the remote ref and the local rev before sending. Either having moved
 *     abandons the operation — nothing is pushed, and the model is told to re-inspect.
 *  3. A `--dry-run --porcelain` pass runs first and its flag column is compared against what the
 *     observed relation permits. A surprise is refused rather than accepted.
 *
 * And one thing it deliberately does NOT do: it never commits. Pushing transmits committed refs
 * only, and committing in this harness is still a user-typed `/commit`. The model therefore cannot
 * publish content a human did not commit — an invariant of the two capabilities together, not a
 * promise about this file's behaviour.
 */

const PushInput = z
  .object({
    ref: z.string().min(1).max(255).describe("The branch or tag to publish, e.g. 'session-20' or 'v1.6.0'. The SAME name is used on the remote."),
    ref_kind: z.enum(['branch', 'tag']).optional().describe("Whether `ref` is a branch (default) or a tag."),
    remote: z.string().min(1).max(100).optional().describe("Which configured git remote. Required when several are configured."),
    local_rev: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Which local rev to publish. Defaults to the same-named local ref. Must match the rev the observation was taken against.'),
    force: z
      .boolean()
      .optional()
      .describe(
        'Overwrite remote history that the local ref does not contain. Classified DESTRUCTIVE, bound to the exact commit the remote held ' +
          'when observed (so the server refuses if it has moved), and never granted for a session.',
      ),
  })
  .strict();

export type PushInputT = z.infer<typeof PushInput>;

export interface RemotePushDeps {
  state: RemoteState;
  git: { gitPath: string; repoRoot: string; workspaceRoot: string } | null;
  /** Live session events, for the local-verification line the prompt shows (never enforces). */
  events: () => readonly SessionEvent[];
}

function targetOf(e: RemoteEndpoint): RemoteTargetFact {
  return {
    remoteName: e.name,
    host: e.host ?? '',
    slug: e.slug,
    display: `${e.host ?? '(unknown host)'}${e.slug !== null ? `/${e.slug}` : ''} via remote '${e.name}'`,
  };
}

function blocked(op: string, target: RemoteTargetFact, exact: string, error: string, kind: RemoteBlockKind, remaining: string): RemoteWriteFact {
  return {
    operation: op,
    target,
    exactTarget: exact,
    overwrites: false,
    effect: ['(refused before an effect could be computed)'],
    argvPreview: '(refused before composition)',
    blocked: error,
    blockedKind: kind,
    budgetRemaining: remaining,
    timeoutMs: REMOTE_PUSH_TIMEOUT_MS,
  };
}

/** Effect lines derived from the observation. Everything here is machine-computed, never prose. */
function effectLines(o: RemoteObservation, force: boolean, state: RemoteState, endpoint: RemoteEndpoint): string[] {
  const lines = [describeRelation(o)];
  if (o.commits.length > 0) {
    const head = o.commits.slice(0, 3).map((c) => `${c.oid.slice(0, 12)} ${c.subject}`);
    lines.push(`commits: ${head.join(' | ')}${o.commits.length > 3 || o.commitsOmitted > 0 ? ` | …+${String(o.commits.length - head.length + o.commitsOmitted)} more` : ''}`);
  }
  if (force && (o.relation === 'diverged' || o.relation === 'behind')) {
    lines.push(`DISCARDS ${String(o.behind)} commit(s) that exist only on the remote — anyone who already pulled them keeps them, and history diverges`);
  }
  if (o.touchesWorkflows) {
    const identity = endpoint.host !== null ? state.identityFor(endpoint.host) : undefined;
    lines.push(
      identity !== undefined && !identity.scopes.includes('workflow')
        ? `TOUCHES .github/workflows/ and the gh account '${identity.account}' has no 'workflow' scope — GitHub will REJECT this push (cure: gh auth refresh -h ${identity.host} -s workflow)`
        : 'touches .github/workflows/ — GitHub rejects this unless the credential carries the `workflow` scope',
    );
  }
  if (o.dirtyCount !== null && o.dirtyCount > 0) {
    lines.push(`${String(o.dirtyCount)} uncommitted workspace entr(ies) are NOT included — a push publishes commits, not the working tree`);
  }
  lines.push(`also updates the local remote-tracking ref refs/remotes/${o.remoteName}/${shortRef(o.refName)}`);
  return lines;
}

export function createRemotePushTool(deps: RemotePushDeps): Tool<PushInputT> {
  const { state } = deps;

  const factOf = (input: PushInputT): RemoteWriteFact => {
    const remaining = state.remaining('write');
    const op = input.ref_kind === 'tag' ? 'push.tag' : 'push.branch';
    const unresolved: RemoteTargetFact = { remoteName: input.remote ?? '(default)', host: '', slug: null, display: '(unresolved)' };

    const spent = state.exhausted('write');
    if (spent !== undefined) return blocked(op, unresolved, '(unresolved)', `${spent}; this call is refused`, 'budget', remaining);
    if (deps.git === null) return blocked(op, unresolved, '(unresolved)', 'the workspace is not inside a git repository', 'unavailable', remaining);

    const resolution = state.resolveEndpoint(input.remote);
    if ('error' in resolution) return blocked(op, unresolved, '(unresolved)', resolution.error, resolution.kind, remaining);
    const endpoint = resolution.endpoint;
    const target = targetOf(endpoint);
    if (endpoint.host === null) {
      return blocked(op, target, '(unresolved)', `remote '${endpoint.name}' has no host this harness can identify`, 'ambiguous', remaining);
    }

    const q = input.ref_kind === 'tag' ? qualifyTag(input.ref) : qualifyBranch(input.ref);
    if ('error' in q) return blocked(op, target, input.ref, q.error, 'precondition', remaining);
    const refName = q.ref;

    // Publishing to GitHub must know WHICH ACCOUNT is about to act. Not a formality: a machine can
    // hold several, gh picks the active one, and "who published this" is the first question anyone
    // asks afterwards. Non-GitHub remotes are exempt because gh has no answer for them — and the
    // effect lines say so rather than implying an identity was checked.
    if (endpoint.isGitHub && state.identityFor(endpoint.host) === undefined) {
      return blocked(
        op,
        target,
        refName,
        `no gh identity is established for ${endpoint.host}; read remote_status view=auth first so the account that would publish is on the record`,
        'unauthenticated',
        remaining,
      );
    }

    const obs = state.observationFor(endpoint.name, refName);
    if (obs === undefined) {
      return blocked(
        op,
        target,
        refName,
        `no live observation covers ${refName} on '${endpoint.name}'; run remote_status view=refs for that exact ref first`,
        'unobserved',
        remaining,
      );
    }

    const force = input.force === true;
    const relation = obs.relation;
    if (relation === 'up-to-date') {
      return blocked(op, target, refName, `${refName} on '${endpoint.name}' already holds ${shortOid(obs.localOid)}; there is nothing to publish`, 'precondition', remaining);
    }
    if (relation === 'unknown') {
      return blocked(
        op,
        target,
        refName,
        `the remote holds ${shortOid(obs.remoteOid)}, a commit this repository has never fetched, so the harness cannot say what a force would discard. ` +
          'Fetch it yourself first; this is refused rather than guessed',
        'precondition',
        remaining,
      );
    }
    if ((relation === 'behind' || relation === 'diverged') && !force) {
      return blocked(
        op,
        target,
        refName,
        `${describeRelation(obs)} — a normal push cannot succeed. Integrate the remote commits first, or ask explicitly for force (which is classified destructive)`,
        'precondition',
        remaining,
      );
    }

    // `overwrites` is derived from the OBSERVED relation, not from the flag. Asking for force on a
    // fast-forward does not overwrite anything, and calling it destructive would spend the word.
    const overwrites = force && (relation === 'behind' || relation === 'diverged');
    const argv = gitPushArgv({
      remoteName: endpoint.name,
      refName,
      sourceOid: obs.localOid,
      ...(force ? { lease: { expect: obs.remoteOid } } : {}),
      dryRun: false,
    });

    return {
      operation: op,
      target,
      exactTarget: refName,
      overwrites,
      effect: effectLines(obs, force, state, endpoint),
      argvPreview: renderArgv('git', argv),
      observation: { id: obs.id, ageMs: state.now() - obs.observedAtMs, remoteOid: obs.remoteOid, localOid: obs.localOid },
      localEvidence: localEvidenceLine(deps.events()),
      budgetRemaining: remaining,
      timeoutMs: REMOTE_PUSH_TIMEOUT_MS,
    };
  };

  return {
    name: 'remote_push',
    description:
      'Publish one named branch or tag to one named git remote. Requires a fresh remote_status view=refs observation of that exact ref — ' +
      'the effect shown to the user is computed from what the remote actually holds, and the harness re-checks it immediately before sending ' +
      'and verifies the remote afterwards. A push transmits COMMITS: uncommitted work is never included, and this tool cannot commit. ' +
      'Every call asks the user individually; there is no session-wide permission to publish, and there never will be.',
    schema: PushInput,
    mutates: () => ({ paths: [] }),
    remoteWrite: factOf,
    async execute(input, ctx): Promise<ToolResult> {
      const started = Date.now();
      const op = input.ref_kind === 'tag' ? 'push.tag' : 'push.branch';
      const done = (ok: boolean, output: string, error?: string): ToolResult => ({
        ok,
        output,
        durationMs: Date.now() - started,
        truncated: false,
        ...(error !== undefined ? { error } : {}),
      });

      const spent = state.exhausted('write');
      if (spent !== undefined) return done(false, '', `${spent}; no further remote mutations this session`);
      if (deps.git === null) return done(false, '', 'the workspace is not inside a git repository');

      const resolution = state.resolveEndpoint(input.remote);
      if ('error' in resolution) return done(false, '', resolution.error);
      const endpoint = resolution.endpoint;
      const host = endpoint.host ?? '';
      const q = input.ref_kind === 'tag' ? qualifyTag(input.ref) : qualifyBranch(input.ref);
      if ('error' in q) return done(false, '', q.error);
      const refName = q.ref;

      const obs = state.observationFor(endpoint.name, refName);
      if (obs === undefined) return done(false, '', `the observation of ${refName} on '${endpoint.name}' expired; re-read it before publishing`);

      const force = input.force === true;
      const overwrites = force && (obs.relation === 'behind' || obs.relation === 'diverged');
      const account = state.identityFor(host)?.account;
      const gitDeps: RemoteGitDeps = {
        ...deps.git,
        ssh: endpoint.scheme === 'ssh' || endpoint.scheme === 'scp',
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      };

      const report = (ok: boolean, verified: boolean, extra: { afterOid?: string | null; detail?: string }): void => {
        ctx.reportRemote?.({
          kind: 'mutated',
          operation: op,
          host,
          target: endpoint.slug ?? endpoint.name,
          exactTarget: refName,
          ...(account !== undefined ? { account } : {}),
          beforeOid: obs.remoteOid,
          ...(extra.afterOid !== undefined ? { afterOid: extra.afterOid } : {}),
          overwrote: overwrites,
          ok,
          verified,
          ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
          durationMs: Date.now() - started,
        });
      };

      try {
        // 1. The local side must still be exactly what was observed. The refspec sends the observed
        //    OID either way, so a moved branch would silently publish something the human did not
        //    read — refusing is the only honest response.
        const localNow = await resolveRev(gitDeps, input.local_rev ?? obs.localRef);
        if (localNow !== obs.localOid) {
          return done(
            false,
            '',
            `nothing was sent: the local ref moved since it was observed (${shortOid(obs.localOid)} → ${shortOid(localNow)}). Re-read the ref and ask again.`,
          );
        }

        // 2. The remote side must still be exactly what was observed. This is the approval-window
        //    TOCTOU guard: decide() ran before a human read the prompt.
        const remoteNow = await lsRemoteOid(gitDeps, endpoint.name, refName);
        if (remoteNow !== obs.remoteOid) {
          return done(
            false,
            '',
            `nothing was sent: ${refName} on '${endpoint.name}' moved since it was observed (${shortOid(obs.remoteOid)} → ${shortOid(remoteNow)}). Re-read it and ask again.`,
          );
        }
      } catch (e) {
        return done(false, '', `nothing was sent — ${remoteFailureMessage(e)}`);
      }

      const baseArgs = {
        remoteName: endpoint.name,
        refName,
        sourceOid: obs.localOid,
        ...(force ? { lease: { expect: obs.remoteOid } } : {}),
      };

      // 3. Dry run. Its porcelain flag is the machine-checkable statement of what the real push
      //    will do, compared against what the observed relation permits.
      const dry = await runRemoteGit(gitDeps, gitPushArgv({ ...baseArgs, dryRun: true }), REMOTE_PUSH_TIMEOUT_MS);
      if (!dry.ok) {
        const text = `${dry.stdout}\n${dry.stderr}`;
        const { reason, cure } = classifyRemoteFailure(text, dry.termination === 'timeout' ? 'timeout' : 'network');
        report(false, false, { detail: `dry-run ${reason}: ${firstLine(dry.stderr) || firstLine(dry.stdout)}` });
        return done(false, '', `nothing was sent — the dry run failed: ${remoteFailureMessage(new RemoteError(firstLine(dry.stderr) || firstLine(dry.stdout) || `exit ${String(dry.exitCode)}`, reason, { exitCode: dry.exitCode, ...(cure !== undefined ? { cure } : {}) }))}`);
      }
      const preview = parsePushPorcelain(dry.stdout);
      const allowed = expectedPushFlags(obs.relation, force);
      const surprise = preview.lines.find((l) => !allowed.includes(l.flag));
      if (surprise !== undefined || preview.lines.length === 0) {
        report(false, false, { detail: `dry-run disagreed with the approved effect: ${surprise?.flag ?? 'no ref lines'}` });
        return done(
          false,
          '',
          `nothing was sent: the dry run says this push would '${surprise?.flag ?? 'do nothing'}', which is not what was approved ` +
            `(the observed relation '${obs.relation}' permits ${allowed.join(', ') || 'nothing'}). Re-read the ref and ask again.`,
        );
      }

      // 4. The real push.
      const push = await runRemoteGit(gitDeps, gitPushArgv({ ...baseArgs, dryRun: false }), REMOTE_PUSH_TIMEOUT_MS);
      const porcelain = parsePushPorcelain(push.stdout);
      if (!push.ok) {
        const text = `${push.stdout}\n${push.stderr}`;
        const { reason, cure } = classifyRemoteFailure(text, push.termination === 'timeout' ? 'timeout' : 'rejected');
        const detail = porcelain.lines.find((l) => l.flag === 'rejected')?.reason ?? firstLine(push.stderr) ?? '';
        report(false, false, { detail: `${reason}: ${detail}` });
        return done(false, '', remoteFailureMessage(new RemoteError(detail || `git push exited ${String(push.exitCode)}`, reason, { exitCode: push.exitCode, ...(cure !== undefined ? { cure } : {}) })));
      }

      // 5. Verify from the remote's own answer, not from git's exit code.
      let after: string | null = null;
      let verified = false;
      try {
        after = await lsRemoteOid(gitDeps, endpoint.name, refName);
        verified = after === obs.localOid;
      } catch {
        verified = false;
      }
      state.charge('write');
      report(true, verified, { afterOid: after, ...(verified ? {} : { detail: `post-push read returned ${shortOid(after)}, expected ${shortOid(obs.localOid)}` }) });

      const t = truncateForModel(
        renderPushOutcome({
          target: `${endpoint.host ?? '?'}${endpoint.slug !== null ? `/${endpoint.slug}` : ''} ${refName}`,
          porcelain,
          verifiedOid: after,
          expectedOid: obs.localOid,
          verified,
          dryRun: false,
        }),
      );
      return { ok: true, output: t.text, durationMs: Date.now() - started, truncated: t.truncated, ...(t.fullSha256 !== undefined ? { fullOutputSha256: t.fullSha256 } : {}) };
    },
  };
}
