import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../shared/hash.js';
import type { TaskChangeFile, Tool, ToolContext, ToolResult } from '../types.js';
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

function currentSha(target: string): { exists: boolean; sha: string | null } {
  try {
    return { exists: true, sha: sha256(fs.readFileSync(target)) };
  } catch {
    return { exists: false, sha: null };
  }
}

/** Is this file appliable against the CURRENT workspace state? (Side-effect-free: mutates() calls
 *  this at policy time; re-checked at execute time. Pre-image archiving is the snapshot's job.) */
function eligibility(f: TaskChangeFile, target: string): { ok: boolean; noop: boolean; reason?: string } {
  if (f.oversize === true || (f.kind !== 'delete' && f.blobSha256 === null)) {
    return { ok: false, noop: false, reason: 'content was over the capture cap and was never stored' };
  }
  const cur = currentSha(target);
  if (f.kind === 'delete') {
    if (!cur.exists) return { ok: true, noop: true }; // already gone
    if (cur.sha === f.baseSha256) return { ok: true, noop: false };
    return { ok: false, noop: false, reason: 'drift: the workspace file differs from the task base; refusing to delete it' };
  }
  if (cur.sha !== null && cur.sha === f.blobSha256) return { ok: true, noop: true }; // already applied
  if (f.kind === 'create' && !cur.exists) return { ok: true, noop: false };
  if (cur.exists && cur.sha === f.baseSha256) return { ok: true, noop: false };
  return {
    ok: false,
    noop: false,
    reason: cur.exists
      ? 'drift: the workspace file changed since the task base (external edit or another task applied first); refusing to overwrite'
      : 'drift: the workspace file was deleted since the task base',
  };
}

export function createApplyChangesTool(registry: TaskChangesRegistry, snapshots: SnapshotStore): Tool<ApplyInputT> {
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
        const e = eligibility(f, target);
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

      for (const f of files) {
        const target = path.join(ctx.workspaceRoot, f.relPath);
        const e = eligibility(f, target);
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
