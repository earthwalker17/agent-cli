import { z } from 'zod';
import { createCheckpoint, DELIVERY_LABEL, type CheckpointContext } from '../git/checkpoint.js';
import { runGit } from '../git/client.js';
import { parsePorcelainV2 } from '../git/porcelain.js';
import { isSecretName } from '../policy/engine.js';
import { sanitizeLine } from '../shared/text.js';
import type { GitCheckpointFact, SessionEvent, Tool, ToolResult } from '../types.js';

/**
 * git_checkpoint (Session 21.6) — the model's recovery point, and nothing else.
 *
 * The schema takes one optional label and CANNOT express another action. That is the strongest
 * pin available for the invariant this session was told to keep verbatim: there is no restore
 * here, no reset, no commit, no push. Restoring discards the user's current bytes and stays theirs
 * (`/checkpoint restore <n>`, `agent checkpoint restore`); committing stays theirs
 * (`test/policy.test.ts`'s `hypothetical_git_commit` regression says why it must).
 *
 * The capture writes a commit object and one ref under `refs/agent-cli/checkpoints/`, built
 * against a TEMPORARY index file, so HEAD, the real index, branches, tags and the working tree are
 * byte-identical before and after. The ref rides `harness.checkpoint {kind:'agent'}`, which means
 * the owed-prune fold reclaims it at clean session end — the reason a model may take these freely
 * rather than accumulating twelve whole-tree refs per session in the user's repository forever.
 *
 * Three guards do the work an approval prompt would otherwise do:
 *
 *  1. **Secrets.** `git add -A` excludes exactly what `.gitignore` excludes and nothing else, so a
 *     non-ignored `.env` would be hashed into a blob that survives in `.git/objects`. A git blob
 *     cannot be redacted (the `artifact.inspect-secret-name` precedent, and `CLAUDE.md`'s "keep
 *     secrets outside … version control"), so this refuses rather than captures.
 *  2. **The label is not identity.** It is capped, sanitized, prefixed `[agent]` for provenance in
 *     the durable ref subject, and refused outright if it imitates the delivery anchor.
 *  3. **The untracked sweep.** No human is attached to a tool call, so the existing
 *     confirm-large-untracked guard cannot ask; it declines, and this translates that into a
 *     refusal that names `/checkpoint` instead of claiming somebody declined.
 */

/** No unbounded repetition: a model that checkpoints in a loop must hit a wall, not a disk quota. */
export const AGENT_CHECKPOINTS_PER_SESSION = 12;

/** A whole-tree `add -A` over a large cold repository legitimately outruns the 15 s client default. */
const CHECKPOINT_TIMEOUT_MS = 120_000;

const MAX_LABEL_CHARS = 120;
/** Refuse rather than truncate above this many secret-named paths in one message. */
const MAX_NAMED_SECRETS = 10;

const CheckpointInput = z
  .object({
    label: z
      .string()
      .min(1)
      .max(MAX_LABEL_CHARS)
      .optional()
      .describe('A short reason you are taking the point, e.g. "before the auth refactor". Shown to the user in the checkpoint listing.'),
  })
  .strict();

export type GitCheckpointInputT = z.infer<typeof CheckpointInput>;

/** Session-cumulative agent-checkpoint budget, REBUILT FROM EVENTS at assembly. */
export interface GitCheckpointCaps {
  taken: number;
}

/**
 * Counts the checkpoints that actually LANDED as events. The event is appended from the
 * onRefReady seam, before update-ref, so a phantom (event written, ref write failed) still counts
 * — which is the conservative direction for a budget: a capture that consumed the work must not be
 * refunded because its last step failed.
 */
export function gitCheckpointCapsFromEvents(events: readonly SessionEvent[]): GitCheckpointCaps {
  let taken = 0;
  for (const e of events) {
    if (e.type === 'harness.checkpoint' && e.kind === 'agent') taken++;
  }
  return { taken };
}

export interface GitCheckpointDeps {
  /** Null when the workspace is not inside a git repository — the fact then blocks by name. */
  git: { gitPath: string; repoRoot: string; workspaceRoot: string } | null;
  stateDir: string;
  sessionId: string;
  caps: GitCheckpointCaps;
  /** Extra secret-name patterns from the workspace configuration, same list the engine reads. */
  secretPatterns?: readonly string[];
}

export function createGitCheckpointTool(deps: GitCheckpointDeps): Tool<GitCheckpointInputT> {
  const remaining = (): number => Math.max(0, AGENT_CHECKPOINTS_PER_SESSION - deps.caps.taken);

  /** PURE: the repository presence and the in-memory counter, never a probe. */
  const factOf = (): GitCheckpointFact => {
    const base: GitCheckpointFact = {
      refRoot: 'refs/agent-cli/checkpoints/',
      argvPreview: 'git read-tree HEAD; git add -A -- . ; git write-tree; git commit-tree; git update-ref (all against a TEMPORARY index)',
      budgetRemaining: `${String(remaining())} of ${String(AGENT_CHECKPOINTS_PER_SESSION)} remaining this session`,
    };
    if (deps.git === null) {
      return { ...base, argvPreview: '(refused before composition)', blocked: 'the workspace is not inside a git repository, so there is nowhere to capture a checkpoint' };
    }
    if (remaining() === 0) {
      return {
        ...base,
        argvPreview: '(refused before composition)',
        blocked: `this session's agent-checkpoint allowance is spent (${String(deps.caps.taken)}/${String(AGENT_CHECKPOINTS_PER_SESSION)}); the user can still take one with /checkpoint`,
      };
    }
    return base;
  };

  return {
    name: 'git_checkpoint',
    description:
      'Capture the current workspace as a recovery point before risky work (a large refactor, a migration, anything you might need to walk back). ' +
      'It writes a hidden git ref only: HEAD, the index, branches and the working tree are untouched, and no history is created. ' +
      'The user restores one with /checkpoint restore <n>. This is the ONLY git write you can make — you cannot commit, restore, reset, branch or push. ' +
      'It refuses if capturing would sweep in secret-named files that .gitignore does not already exclude.',
    schema: CheckpointInput,
    mutates: () => ({ paths: [] }),
    gitCheckpoint: factOf,
    async execute(input, ctx): Promise<ToolResult> {
      const started = Date.now();
      const done = (ok: boolean, output: string, error?: string): ToolResult => ({
        ok,
        output,
        durationMs: Date.now() - started,
        truncated: false,
        ...(error !== undefined ? { error } : {}),
      });

      const git = deps.git;
      if (git === null) return done(false, '', 'the workspace is not inside a git repository');
      // Re-check at execute for the reason every budgeted tool does: decide() ran against the
      // counter as it stood then. Calls are serialized, so this is belt and braces — but a budget
      // enforced in one place is a budget one refactor away from not being enforced at all.
      if (remaining() === 0) {
        return done(false, '', `this session's agent-checkpoint allowance is spent (${String(deps.caps.taken)}/${String(AGENT_CHECKPOINTS_PER_SESSION)})`);
      }

      const rawLabel = input.label?.trim() ?? '';
      if (rawLabel.toLowerCase().includes(DELIVERY_LABEL)) {
        return done(
          false,
          '',
          `refused: a checkpoint label may not contain "${DELIVERY_LABEL}" — that phrase identifies the checkpoint the user's own /accept creates, and a recovery point must not imitate it`,
        );
      }
      const label = rawLabel === '' ? '[agent]' : `[agent] ${sanitizeLine(rawLabel).slice(0, MAX_LABEL_CHARS)}`;

      const cctx: CheckpointContext = {
        gitPath: git.gitPath,
        repoRoot: git.repoRoot,
        workspaceRoot: git.workspaceRoot,
        stateDir: deps.stateDir,
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      };

      // ── Guard 1: secrets. ───────────────────────────────────────────────────────────────────
      // The capture set is "everything git would add", which is everything not gitignored. A
      // status listing with --untracked-files=all enumerates exactly that (porcelain never reports
      // ignored paths without --ignored), so a secret-named entry here is a secret-named blob in
      // the object store one command later. Tracked-and-unmodified secrets are NOT a new exposure
      // (they are already in history) and do not appear in this listing either — which is the
      // correct scope: this guard is about what the capture would ADD.
      const status = await runGit({
        gitPath: git.gitPath,
        argv: ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.'],
        cwd: git.workspaceRoot,
        timeoutMs: CHECKPOINT_TIMEOUT_MS,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (!status.ok) {
        // Fail closed: unable to see what would be captured is not permission to capture it.
        const first = status.stderr.split(/\r?\n/).find((l) => l.trim().length > 0) ?? status.termination;
        return done(false, '', `refused: could not determine what the checkpoint would capture (git status failed: ${first}); nothing was written`);
      }
      const secretPaths = parsePorcelainV2(status.stdout)
        .entries.filter((e) => e.kind !== 'ignored' && isSecretName(e.path, deps.secretPatterns))
        .map((e) => e.path);
      if (secretPaths.length > 0) {
        const named = secretPaths.slice(0, MAX_NAMED_SECRETS).map((p) => sanitizeLine(p)).join(', ');
        return done(
          false,
          '',
          `refused: the capture would store secret-named file(s) in the git object database, where they cannot be redacted or removed by /undo: ` +
            `${named}${secretPaths.length > MAX_NAMED_SECRETS ? ` (and ${String(secretPaths.length - MAX_NAMED_SECRETS)} more)` : ''}. ` +
            `Add them to .gitignore first, or ask the user to take the checkpoint themselves with /checkpoint. Nothing was written.`,
        );
      }

      // ── The capture. ───────────────────────────────────────────────────────────────────────
      // No confirmLargeUntracked callback: there is no human on a tool call, and the guard's own
      // default is to decline. That decline is translated below rather than surfaced verbatim,
      // because its message says somebody declined and nobody was asked.
      let reported = false;
      const r = await createCheckpoint(cctx, deps.sessionId, {
        label,
        onRefReady: (ref, oid) => {
          // Event BEFORE ref, the contract every harness ref obeys: a crash between the two leaves
          // an owed ref that does not exist, and the prune fold counts a missing ref as deleted.
          // A throw here aborts the capture before the ref exists — which is why this is the last
          // thing that can fail, and why the budget is charged from the same fact.
          ctx.reportGit?.({ kind: 'checkpoint', ref, oid, ...(rawLabel !== '' ? { label: rawLabel } : {}) });
          reported = true;
          deps.caps.taken++;
        },
      });
      if (r.declined === true) {
        return done(
          false,
          '',
          'refused: an unusually large number of untracked files would be swept into the checkpoint. Deciding that is the user\'s — ask them to run /checkpoint, or gitignore whatever is not meant to be captured. Nothing was written.',
        );
      }
      if (!r.ok || r.ref === undefined || r.oid === undefined) {
        return done(false, '', `checkpoint not created: ${r.error ?? 'unknown error'}${reported ? ' (the creation was recorded before the ref write failed; it prunes as already-deleted)' : ''}`);
      }
      const notes = (r.notes ?? []).map((n) => `\nnote: ${sanitizeLine(n)}`).join('');
      return done(
        true,
        `Recovery point captured at ${r.oid.slice(0, 12)} (${r.filesChanged ?? 0} file(s) differ from HEAD). ` +
          `It is a hidden ref — no commit, no branch, no history change — and the user can walk the workspace back to it with /checkpoint restore. ` +
          `${String(remaining())} of ${String(AGENT_CHECKPOINTS_PER_SESSION)} checkpoint(s) remain this session.${notes}`,
      );
    },
  };
}
