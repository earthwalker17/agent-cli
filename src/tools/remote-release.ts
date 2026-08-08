import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ghReleaseCreateArgv, ghReleaseViewArgv, renderArgv } from '../remote/argv.js';
import { RemoteError, classifyRemoteFailure, remoteFailureMessage } from '../remote/errors.js';
import { renderReleaseOutcome } from '../remote/format.js';
import { firstLine, lsRemoteOid, type RemoteGitDeps } from '../remote/observe.js';
import { parseRelease, releaseUrlFromCreate } from '../remote/parse.js';
import { qualifyTag, shortOid, shortRef } from '../remote/refs.js';
import { targetFactOf } from '../remote/url.js';
import {
  MAX_RELEASE_NOTES_CHARS,
  REMOTE_CALL_TIMEOUT_MS,
  type GhRunner,
  type RemoteEndpoint,
} from '../remote/types.js';
import { sha256, truncateForModel } from '../shared/hash.js';
import { sanitizeLine } from '../shared/text.js';
import type { RemoteBlockKind, RemoteTargetFact, RemoteWriteFact, SessionEvent, Tool, ToolResult } from '../types.js';
import { localEvidenceLine, type RemoteState } from './remote-state.js';

/**
 * remote_release (Session 20) — publish a GitHub Release for a tag that is ALREADY on the remote.
 *
 * The `--verify-tag` flag is the whole reason this is a separate operation rather than a flag on
 * the push. Without it, `gh release create` silently CREATES the named tag from the latest state of
 * the default branch when it does not exist — a publish nobody asked for, at a commit nobody named.
 * So this tool refuses unless an observation shows the tag on the remote, `--verify-tag` is passed
 * unconditionally, and creating a tag stays a separate deliberate `remote_push` with its own ask.
 *
 * Notes travel through `--body-file`-style indirection (`--notes-file`) rather than argv: release
 * notes are model-authored prose that can run to thousands of characters, and an argument list is
 * neither the right size nor the right place for it (the `git commit -F` precedent).
 */

const ReleaseInput = z
  .object({
    tag: z.string().min(1).max(255).describe("The tag to publish a release for. It must ALREADY exist on the remote — push the tag first."),
    title: z.string().min(1).max(200).describe('The release title, e.g. "v1.6.0 — remote delivery".'),
    notes: z
      .string()
      .min(1)
      .max(MAX_RELEASE_NOTES_CHARS)
      .describe('Release notes in Markdown. Published publicly; the first lines are previewed to the user before anything is sent.'),
    draft: z.boolean().optional().describe('Create it unpublished so a human can review it on GitHub before it goes out.'),
    prerelease: z.boolean().optional().describe('Mark it a prerelease.'),
    remote: z.string().min(1).max(100).optional().describe('Which configured git remote. Required when several are configured.'),
  })
  .strict();

export type ReleaseInputT = z.infer<typeof ReleaseInput>;

export interface RemoteReleaseDeps {
  state: RemoteState;
  gh: GhRunner | null;
  git: { gitPath: string; repoRoot: string; workspaceRoot: string } | null;
  /** Where the notes file is written — the project state dir, never the workspace. */
  notesDir: string;
  events: () => readonly SessionEvent[];
}

function blocked(target: RemoteTargetFact, exact: string, error: string, kind: RemoteBlockKind, remaining: string): RemoteWriteFact {
  return {
    operation: 'release.create',
    target,
    exactTarget: exact,
    overwrites: false,
    effect: ['(refused before an effect could be computed)'],
    argvPreview: '(refused before composition)',
    blocked: error,
    blockedKind: kind,
    budgetRemaining: remaining,
    timeoutMs: REMOTE_CALL_TIMEOUT_MS,
  };
}

/** Deterministic notes path, so the argv shown in the prompt is the argv that runs. */
function notesPathFor(notesDir: string, notes: string): string {
  return path.join(notesDir, `release-notes-${sha256(notes).slice(0, 16)}.md`);
}

export function createRemoteReleaseTool(deps: RemoteReleaseDeps): Tool<ReleaseInputT> {
  const { state } = deps;

  const factOf = (input: ReleaseInputT): RemoteWriteFact => {
    const remaining = state.remaining('write');
    const unresolved: RemoteTargetFact = { remoteName: input.remote ?? '(default)', host: '', slug: null, display: '(unresolved)' };

    const spent = state.exhausted('write');
    if (spent !== undefined) return blocked(unresolved, input.tag, `${spent}; this call is refused`, 'budget', remaining);
    if (deps.gh === null) return blocked(unresolved, input.tag, 'the GitHub CLI (gh) is not installed, so a release cannot be published', 'unavailable', remaining);

    const resolution = state.resolveEndpoint(input.remote);
    if ('error' in resolution) return blocked(unresolved, input.tag, resolution.error, resolution.kind, remaining);
    const endpoint = resolution.endpoint;
    const target = targetFactOf(endpoint);
    if (!endpoint.isGitHub || endpoint.slug === null || endpoint.host === null) {
      return blocked(target, input.tag, `remote '${endpoint.name}' points at ${endpoint.displayUrl}, which is not a GitHub owner/repo destination`, 'not-github', remaining);
    }
    if (state.identityFor(endpoint.host) === undefined) {
      return blocked(
        target,
        input.tag,
        `no gh identity is established for ${endpoint.host}; read remote_status view=auth first so the account that would publish is on the record`,
        'unauthenticated',
        remaining,
      );
    }

    const q = qualifyTag(input.tag);
    if ('error' in q) return blocked(target, input.tag, q.error, 'precondition', remaining);
    const tagRef = q.ref;
    const tag = shortRef(tagRef);

    const obs = state.observationFor(endpoint.name, tagRef);
    if (obs === undefined) {
      return blocked(
        target,
        tag,
        `no live observation covers ${tagRef} on '${endpoint.name}'; run remote_status view=refs ref_kind=tag for that exact tag first`,
        'unobserved',
        remaining,
      );
    }
    if (obs.remoteOid === null) {
      return blocked(
        target,
        tag,
        `tag ${tag} does not exist on '${endpoint.name}'. This is refused rather than worked around: gh would otherwise CREATE the tag from the ` +
          'default branch as a side effect. Publish the tag first with remote_push (ref_kind=tag), which asks separately',
        'precondition',
        remaining,
      );
    }

    const notesPath = notesPathFor(deps.notesDir, input.notes);
    const argv = ghReleaseCreateArgv({
      slug: endpoint.slug,
      tag,
      title: input.title,
      notesFile: notesPath,
      draft: input.draft === true,
      prerelease: input.prerelease === true,
    });
    const noteLines = input.notes.split('\n');
    const notesHead = noteLines.slice(0, 6);
    return {
      operation: 'release.create',
      target,
      exactTarget: `release ${tag}`,
      // A release does not overwrite anything: gh refuses when one already exists for the tag.
      overwrites: false,
      effect: [
        `creates a ${input.draft === true ? 'DRAFT ' : ''}${input.prerelease === true ? 'pre' : ''}release for tag ${tag} in ${endpoint.slug}, at commit ${shortOid(obs.remotePeeledOid ?? obs.remoteOid)}` +
          (obs.remotePeeledOid != null ? ` (annotated tag object ${shortOid(obs.remoteOid)})` : ''),
        `title: ${sanitizeLine(input.title)}`,
        // Every model-authored value is sanitized before it becomes a prompt line: `sanitizeLine`
        // collapses newlines, and without it a title or a note could inject lines that look
        // harness-authored and push the truthful ones past the renderer's line cap (S20 review).
        `notes (${String(input.notes.length)} chars in ${String(noteLines.length)} line(s), published publicly) — first lines: ` +
          `${notesHead.map((l) => sanitizeLine(l)).join(' ⏎ ')}` +
          (noteLines.length > notesHead.length ? ` ⏎ …${String(noteLines.length - notesHead.length)} further line(s) NOT shown here` : ''),
        input.draft === true
          ? 'a draft is visible only to people who can write to the repository until it is published'
          : 'a published release is visible to everyone who can see the repository and notifies watchers',
      ],
      argvPreview: renderArgv('gh', argv),
      observation: { id: obs.id, ageMs: state.now() - obs.observedAtMs, remoteOid: obs.remoteOid, localOid: obs.localOid },
      localEvidence: localEvidenceLine(deps.events()),
      budgetRemaining: remaining,
      timeoutMs: REMOTE_CALL_TIMEOUT_MS,
    };
  };

  return {
    name: 'remote_release',
    description:
      'Publish a GitHub Release for a tag that ALREADY exists on the remote. Requires a fresh remote_status view=refs (ref_kind=tag) ' +
      'observation proving the tag is there — the tag is never created as a side effect. Notes are published publicly and are shown ' +
      'verbatim to the user before anything is sent; the release is read back afterwards to confirm it exists. ' +
      'Every call asks the user individually; there is no session-wide permission to publish.',
    schema: ReleaseInput,
    mutates: () => ({ paths: [] }),
    remoteWrite: factOf,
    async execute(input, ctx): Promise<ToolResult> {
      const started = Date.now();
      const done = (ok: boolean, output: string, error?: string): ToolResult => ({
        ok,
        output,
        durationMs: Date.now() - started,
        truncated: false,
        ...(error !== undefined ? { error } : {}),
      });

      const spent = state.exhausted('write');
      if (spent !== undefined) return done(false, '', `${spent}; no further remote mutations this session`);
      if (deps.gh === null) return done(false, '', 'the GitHub CLI (gh) is not installed');

      const resolution = state.resolveEndpoint(input.remote);
      if ('error' in resolution) return done(false, '', resolution.error);
      const endpoint = resolution.endpoint;
      if (endpoint.slug === null || endpoint.host === null) return done(false, '', 'the destination is not a GitHub owner/repo');
      const host = endpoint.host;
      const q = qualifyTag(input.tag);
      if ('error' in q) return done(false, '', q.error);
      const tagRef = q.ref;
      const tag = shortRef(tagRef);
      const account = state.identityFor(host)?.account;

      const obs = state.observationFor(endpoint.name, tagRef);
      if (obs === undefined || obs.remoteOid === null) {
        return done(false, '', `the observation of ${tagRef} on '${endpoint.name}' expired or showed no tag; re-read it before publishing`);
      }

      const report = (ok: boolean, verified: boolean, extra: { url?: string; detail?: string }): void => {
        ctx.reportRemote?.({
          kind: 'mutated',
          operation: 'release.create',
          host,
          target: endpoint.slug ?? endpoint.name,
          exactTarget: `release ${tag}`,
          ...(account !== undefined ? { account } : {}),
          beforeOid: null,
          afterOid: obs.remoteOid,
          ...(extra.url !== undefined ? { url: extra.url } : {}),
          overwrote: false,
          ok,
          verified,
          ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
          durationMs: Date.now() - started,
        });
      };

      // The tag must still be exactly where it was observed. A release names a commit through its
      // tag, so a tag that moved between the approval and the act would publish a different commit
      // under the name the human read.
      if (deps.git !== null) {
        const gitDeps: RemoteGitDeps = {
          ...deps.git,
          ssh: endpoint.scheme === 'ssh' || endpoint.scheme === 'scp',
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        };
        try {
          const now = await lsRemoteOid(gitDeps, endpoint.name, tagRef);
          if (now !== obs.remoteOid) {
            return done(false, '', `nothing was published: tag ${tag} moved on the remote since it was observed (${shortOid(obs.remoteOid)} → ${shortOid(now)}). Re-read it and ask again.`);
          }
        } catch (e) {
          return done(false, '', `nothing was published — ${remoteFailureMessage(e)}`);
        }
      }

      const notesPath = notesPathFor(deps.notesDir, input.notes);
      const argv = ghReleaseCreateArgv({
        slug: endpoint.slug,
        tag,
        title: input.title,
        notesFile: notesPath,
        draft: input.draft === true,
        prerelease: input.prerelease === true,
      });
      try {
        fs.mkdirSync(deps.notesDir, { recursive: true });
        fs.writeFileSync(notesPath, input.notes, 'utf8');
      } catch (e) {
        return done(false, '', `nothing was published: the release notes could not be staged (${(e as Error).message})`);
      }

      try {
        const created = await deps.gh({
          argv,
          cwd: deps.git?.repoRoot ?? process.cwd(),
          timeoutMs: REMOTE_CALL_TIMEOUT_MS,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        if (!created.ok) {
          const text = `${created.stdout}\n${created.stderr}`;
          const { reason, cure } = classifyRemoteFailure(text, created.termination === 'timeout' ? 'timeout' : 'precondition');
          const detail = firstLine(created.stderr) || firstLine(created.stdout) || `gh exited ${String(created.exitCode)}`;
          report(false, false, { detail: `${reason}: ${detail}` });
          return done(false, '', remoteFailureMessage(new RemoteError(detail, reason, { exitCode: created.exitCode, ...(cure !== undefined ? { cure } : {}) })));
        }
        const url = releaseUrlFromCreate(created.stdout);

        // Verify from GitHub's own answer, not from gh's exit code.
        let release = null;
        try {
          const view = await deps.gh({
            argv: ghReleaseViewArgv(endpoint.slug, tag),
            cwd: deps.git?.repoRoot ?? process.cwd(),
            timeoutMs: REMOTE_CALL_TIMEOUT_MS,
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          });
          if (view.ok) release = parseRelease(view.stdout);
        } catch {
          release = null;
        }
        state.charge('write');
        report(true, release !== null, {
          ...(release?.url !== undefined ? { url: release.url } : url !== null ? { url } : {}),
          ...(release === null ? { detail: 'the release could not be read back' } : {}),
        });
        const t = truncateForModel(renderReleaseOutcome(endpoint.slug, tag, release, url));
        return { ok: true, output: t.text, durationMs: Date.now() - started, truncated: t.truncated, ...(t.fullSha256 !== undefined ? { fullOutputSha256: t.fullSha256 } : {}) };
      } finally {
        // The notes file is a transient staging artifact, not evidence: the published release is
        // the record, and the prompt already showed what was in it.
        try {
          fs.rmSync(notesPath, { force: true });
        } catch {
          /* a leftover staging file must never fail a completed publish */
        }
      }
    },
  };
}
