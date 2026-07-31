import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../shared/hash.js';
import { createCheckpoint, type CheckpointContext } from '../git/checkpoint.js';
import type { SessionEvent, TaskChangeFile, Tool, ToolContext, ToolResult } from '../types.js';
import type { SnapshotStore } from '../store/snapshots.js';

/**
 * apply_task_changes — the ONLY path by which an executor task's captured changes reach the
 * real workspace (V0.7). Parent-only, per-session (no role registry contains it — children can
 * never self-integrate). It rides the EXISTING snapshot-backed write machinery: `mutates()`
 * declares the concrete workspace paths it would touch (never null — the S6 observe-trap), so
 * policy classifies it as ordinary in-workspace reversible mutation and the runtime snapshots
 * first, records file.mutated, and keeps the whole call one undoable unit.
 *
 * Per-file conflict rule (the drift-refuse precedent): the workspace file must still hold the
 * task's BASE bytes (or already hold the target, or not exist for a create). Anything else is
 * refused per-file, honestly — partial applies are reported, never smoothed over.
 */

const ApplyInput = z
  .object({
    child_session_id: z.string().min(1).describe('The executor task whose captured changes to integrate (from its task report)'),
    files: z
      .array(z.string().min(1))
      .max(200)
      .optional()
      .describe('Optional subset of workspace-relative paths; omit to apply every captured change'),
  })
  .strict();
type ApplyInputT = z.infer<typeof ApplyInput>;

export interface CapturedTaskChanges {
  baseOid: string;
  files: TaskChangeFile[];
  /** Changed files DROPPED at capture by the file-count cap: never stored, never appliable. */
  omittedCount: number;
}

/** In-session registry of captured executor changes; rebuilt from task.changes events on resume. */
export interface TaskChangesRegistry {
  register(childSessionId: string, baseOid: string, files: TaskChangeFile[], omittedCount?: number): void;
  get(childSessionId: string): CapturedTaskChanges | undefined;
}

export function createTaskChangesRegistry(): TaskChangesRegistry {
  const byChild = new Map<string, CapturedTaskChanges>();
  return {
    register(childSessionId, baseOid, files, omittedCount) {
      if (childSessionId.length === 0) return;
      byChild.set(childSessionId, { baseOid, files, omittedCount: omittedCount ?? 0 });
    },
    get(childSessionId) {
      return byChild.get(childSessionId);
    },
  };
}

function selectFiles(rec: CapturedTaskChanges, subset: readonly string[] | undefined): { files: TaskChangeFile[]; unknown: string[] } {
  if (subset === undefined) return { files: rec.files, unknown: [] };
  const byRel = new Map(rec.files.map((f) => [f.relPath, f]));
  const files: TaskChangeFile[] = [];
  const unknown: string[] = [];
  for (const name of subset) {
    const f = byRel.get(name);
    if (f !== undefined) files.push(f);
    else unknown.push(name);
  }
  return { files, unknown };
}

function currentState(target: string): { exists: boolean; sha: string | null; bytes: Buffer | null } {
  try {
    const bytes = fs.readFileSync(target);
    return { exists: true, sha: sha256(bytes), bytes };
  } catch {
    return { exists: false, sha: null, bytes: null };
  }
}

/** S14.5 (A-i): true when two byte sequences differ ONLY by CRLF/LF normalization — the
 *  live-found refusal class where git's checkout filter, not an edit, produced the "drift".
 *  Binary content (NUL-bearing) never matches: EOL comparison is meaningless there. */
function eolOnlyMismatch(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return false;
  if (a.includes(0) || b.includes(0)) return false;
  const norm = (x: Buffer): string => x.toString('latin1').replace(/\r\n/g, '\n');
  return norm(a) === norm(b);
}

// The refusal must not prescribe an exit the scheduler refuses. A captured-but-unapplied task
// folds to 'integrating', and R5 then refuses re-spawning it — so "re-run the executor task"
// was a dead end (S14.5 review). The EOL pin also only engages for a UNIFORMLY-LF parent, so a
// mixed tree reaches here with no pin in force: name the exits that actually work.
const EOL_DRIFT_REASON =
  'line-ending normalization mismatch, not a content edit: the workspace file and the task base differ only by CRLF/LF ' +
  '(git checkout conversion — core.autocrlf materialized the capture in a different EOL form than this workspace holds). ' +
  'The executor worktree is EOL-pinned only when the parent tree is uniformly LF, which it is not here. ' +
  'Exits: normalize the workspace line endings (or set core.autocrlf=false and re-checkout) and apply again, ' +
  'or make this change directly as the parent — do NOT re-run the task, which the scheduler refuses while it holds captured changes';

/** Is this file appliable against the CURRENT workspace state? (Side-effect-free: mutates() calls
 *  this at policy time; re-checked at execute time. Pre-image archiving is the snapshot's job.)
 *  `readBlob` (optional) only ENRICHES a refusal reason — never changes the verdict. */
function eligibility(
  f: TaskChangeFile,
  target: string,
  readBlob?: (sha: string) => Buffer | null,
): { ok: boolean; noop: boolean; reason?: string } {
  if (f.oversize === true || (f.kind !== 'delete' && f.blobSha256 === null)) {
    return { ok: false, noop: false, reason: 'content was over the capture cap and was never stored' };
  }
  const cur = currentState(target);
  const baseBytes = (): Buffer | null => (f.baseSha256 !== null ? (readBlob?.(f.baseSha256) ?? null) : null);
  if (f.kind === 'delete') {
    if (!cur.exists) return { ok: true, noop: true }; // already gone
    if (cur.sha === f.baseSha256) return { ok: true, noop: false };
    return {
      ok: false,
      noop: false,
      reason: eolOnlyMismatch(cur.bytes, baseBytes())
        ? EOL_DRIFT_REASON
        : 'drift: the workspace file differs from the task base; refusing to delete it',
    };
  }
  if (cur.sha !== null && cur.sha === f.blobSha256) return { ok: true, noop: true }; // already applied
  if (f.kind === 'create' && !cur.exists) return { ok: true, noop: false };
  if (cur.exists && cur.sha === f.baseSha256) return { ok: true, noop: false };
  return {
    ok: false,
    noop: false,
    reason: cur.exists
      ? eolOnlyMismatch(cur.bytes, baseBytes())
        ? EOL_DRIFT_REASON
        : 'drift: the workspace file changed since the task base (external edit or another task applied first); refusing to overwrite'
      : 'drift: the workspace file was deleted since the task base',
  };
}

/**
 * Pre-integration checkpoint wiring (Session 14). Optional: absent without a git repo, and the
 * apply NEVER refuses over checkpoint machinery — per-file snapshots already make the apply
 * itself one undoable unit; the checkpoint is the whole-workspace point covering what snapshots
 * structurally cannot (writes by approved commands/checks/preview servers since the last
 * harness checkpoint).
 */
export interface ApplyCheckpointDeps {
  cctx: CheckpointContext;
  sessionId: string;
  /** The LIVE event view (session.log.events) — the covered-change rule reads it at call time. */
  events: () => readonly SessionEvent[];
  /** Test seam for the large-untracked decline path; production uses the module default. */
  untrackedWarnThreshold?: number;
}

/**
 * The covered-change rule (Session 14, critique-demoted from "every apply"): a pre-integration
 * checkpoint is created ONLY when an UN-SNAPSHOT-COVERED workspace change could have happened
 * since the last harness checkpoint — that is, a process spawned that can write files the
 * snapshot machinery never saw.
 *
 * The set is exactly the spawn events, for two reasons the review made concrete:
 * - `file.mutated` / `undo.applied` / `git.restore` are DELIBERATELY excluded: every one of
 *   them is snapshot-backed by construction (the runtime captures pre-images before a declared
 *   mutation; undo restores from those snapshots; a checkpoint restore snapshots first and is
 *   itself one undo unit). Including them made every apply after the first create a
 *   whole-tree checkpoint over changes that were already recoverable — the exact cost the
 *   demotion existed to avoid.
 * - The STARTED events, not the ended ones, are the trigger: a session that crashed mid-command
 *   leaves only `command.started`, and that is precisely the unknown-effects writer a recovery
 *   point is for. This is the same reasoning `WORK_EVENT_TYPES` uses in the acceptance fold.
 *
 * Known bound (accepted): `lastHarness` counts creation EVENTS, and under event-before-ref a
 * creation can be a phantom whose ref never landed. A phantom therefore suppresses the rule
 * until the next spawn. The checkpoint is best-effort by contract and the apply stays
 * snapshot-backed and drift-refusing, so the residual is one missing whole-tree convenience
 * point, never lost work.
 */
export function needsPreIntegrationCheckpoint(events: readonly SessionEvent[]): boolean {
  let lastHarness = 0;
  for (const e of events) {
    if (e.type === 'task.base-checkpoint' || e.type === 'harness.checkpoint') lastHarness = Math.max(lastHarness, e.seq);
  }
  for (const e of events) {
    if (e.seq <= lastHarness) continue;
    // `setup.started` joins the spawn set (Session 16): an install rewrites node_modules and a
    // migration rewrites a database — both are un-snapshot-covered writers by any measure.
    if (e.type === 'command.started' || e.type === 'check.started' || e.type === 'preview.started' || e.type === 'setup.started') return true;
  }
  return false;
}

export function createApplyChangesTool(
  registry: TaskChangesRegistry,
  snapshots: SnapshotStore,
  checkpoint?: ApplyCheckpointDeps,
): Tool<ApplyInputT> {
  return {
    name: 'apply_task_changes',
    description:
      'Integrate an executor task\'s captured changes into the workspace. Applies per-file with a drift-refuse rule ' +
      '(a workspace file that no longer matches the task\'s base is refused, never overwritten), snapshots first, and ' +
      'is one undoable unit (/undo reverts the whole apply). Review the changes before applying; refusals are listed ' +
      'honestly and are yours to resolve.',
    schema: ApplyInput,
    // Declared mutations: exactly the files whose CURRENT disk state permits an apply. Policy
    // validates each and requires the snapshot; conflicted files are never declared, so they
    // are never snapshotted and never pollute attribution.
    mutates(input, ctx) {
      const rec = registry.get(input.child_session_id);
      if (rec === undefined) return { paths: [] };
      const { files } = selectFiles(rec, input.files);
      const paths: string[] = [];
      for (const f of files) {
        const target = path.join(ctx.workspaceRoot, f.relPath);
        const e = eligibility(f, target); // no blob reads at policy time (reasons are unused here)
        if (e.ok && !e.noop) paths.push(target);
      }
      return { paths };
    },
    async execute(input, ctx: ToolContext): Promise<ToolResult> {
      const started = Date.now();
      const done = (ok: boolean, output: string, error?: string): ToolResult => ({
        ok,
        output,
        durationMs: Math.max(0, Date.now() - started),
        truncated: false,
        ...(error !== undefined ? { error } : {}),
      });
      const rec = registry.get(input.child_session_id);
      if (rec === undefined) {
        return done(false, '', `no captured changes for child session '${input.child_session_id}' in this session (see task.changes evidence, or re-run the executor task)`);
      }
      const { files, unknown } = selectFiles(rec, input.files);
      const applied: string[] = [];
      const refused: { relPath: string; reason: string }[] = [];
      for (const name of unknown) refused.push({ relPath: name, reason: 'not among this task\'s captured changes' });

      // Pre-integration checkpoint (Session 14): a whole-workspace recovery point BEFORE this
      // apply writes, created only when the covered-change rule says something un-snapshot-
      // covered happened since the last harness checkpoint. Best-effort by contract: a decline
      // (large untracked set — no confirm channel exists inside a model turn) or any failure
      // SKIPS with a recorded note and never refuses the apply, because the apply itself is
      // already snapshot-backed and drift-refusing.
      const checkpointNotes: string[] = [];
      if (checkpoint !== undefined && needsPreIntegrationCheckpoint(checkpoint.events())) {
        const cp = await createCheckpoint(checkpoint.cctx, checkpoint.sessionId, {
          label: 'pre-integration',
          ...(checkpoint.untrackedWarnThreshold !== undefined ? { untrackedWarnThreshold: checkpoint.untrackedWarnThreshold } : {}),
          onRefReady: (ref, oid) => ctx.reportTask?.({ kind: 'harness-checkpoint', checkpointKind: 'pre-integration', ref, oid }),
        });
        checkpointNotes.push(
          cp.ok
            ? `pre-integration checkpoint: ${cp.ref} (whole-workspace recovery point; restorable via /checkpoint restore)`
            : `pre-integration checkpoint SKIPPED: ${cp.error ?? 'unknown error'} — the apply proceeds; its own per-file snapshots still make it one undoable unit`,
        );
      }

      const readBlob = (sha: string): Buffer | null => {
        try {
          return snapshots.getBlob(sha);
        } catch {
          return null;
        }
      };
      for (const f of files) {
        const target = path.join(ctx.workspaceRoot, f.relPath);
        const e = eligibility(f, target, readBlob);
        if (!e.ok) {
          refused.push({ relPath: f.relPath, reason: e.reason ?? 'not appliable' });
          continue;
        }
        try {
          if (!e.noop) {
            if (f.kind === 'delete') {
              fs.rmSync(target, { force: true });
            } else {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, snapshots.getBlob(f.blobSha256!));
            }
          }
          applied.push(f.relPath);
        } catch (err) {
          refused.push({ relPath: f.relPath, reason: `apply failed: ${(err as Error).message}` });
        }
      }

      ctx.reportTask?.({ kind: 'applied', childSessionId: input.child_session_id, applied, refused });
      const lines = [
        ...checkpointNotes,
        `applied ${applied.length} of ${files.length + unknown.length} selected change(s) from task ${input.child_session_id} (base ${rec.baseOid.slice(0, 12)})`,
        // The capture-time cap must stay visible at APPLY time: a reader of only this output
        // would otherwise take "applied N of N" as the task's complete change set.
        ...(rec.omittedCount > 0
          ? [`  NOTE: ${rec.omittedCount} changed file(s) were OMITTED at capture (over the file-count cap) and are NOT part of this apply`]
          : []),
        ...applied.map((p) => `  applied  ${p}`),
        ...refused.map((r) => `  REFUSED  ${r.relPath}: ${r.reason}`),
        ...(applied.length > 0 ? ['this apply is one undoable unit (/undo reverts it); run a check before claiming success'] : []),
      ];
      return refused.length === 0
        ? done(true, lines.join('\n'))
        : done(applied.length > 0, lines.join('\n'), `${refused.length} change(s) refused`);
    },
  };
}
