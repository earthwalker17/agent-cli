import fs from 'node:fs';
import path from 'node:path';
import type { SessionEvent, MutationKind } from '../types.js';
import type { SnapshotStore } from '../store/snapshots.js';
import { sha256 } from '../shared/hash.js';
import { DIFF_MAX_BYTES, isProbablyBinary, unifiedDiff } from '../shared/diff.js';

/**
 * The attributable session diff (V0.5): for every path the session's file tools mutated,
 * a unified diff from the FIRST recorded pre-image (the snapshot blob) to the CURRENT bytes
 * on disk. Attribution is exact — it derives only from file.mutated evidence, so it covers
 * precisely what the report's "Files changed" covers (run_command side effects are, by the
 * same contract, out of scope). Undo activity is folded in: a path undone back to its
 * pre-image reads as net-unchanged, and external edits after the last recorded action are
 * flagged as drift rather than silently attributed to the session.
 */

export interface SessionDiffFile {
  /** Absolute recorded path. */
  path: string;
  /** Workspace-relative POSIX path used in the rendered diff. */
  relPath: string;
  kind: MutationKind | 'unchanged';
  /** True when current disk bytes differ from the last state the session recorded. */
  drifted: boolean;
  /** Unified diff (may be ''), absent when skipped. */
  patch?: string;
  /** Why there is no patch (binary, too large, net-unchanged, missing blob). */
  note?: string;
}

export function buildSessionDiff(events: readonly SessionEvent[], snapshots: SnapshotStore, workspaceRoot: string): SessionDiffFile[] {
  // First pre-image and last expected state per path, with undo restores folded in.
  const firstBefore = new Map<string, string | null>();
  const expectedNow = new Map<string, string | null>();
  for (const e of events) {
    if (e.type === 'file.mutated') {
      if (!firstBefore.has(e.path)) firstBefore.set(e.path, e.beforeSha256);
      expectedNow.set(e.path, e.afterSha256);
    } else if (e.type === 'undo.applied') {
      for (const r of e.restored) {
        if (expectedNow.has(r.path)) expectedNow.set(r.path, r.toSha256);
      }
    }
  }

  const out: SessionDiffFile[] = [];
  for (const [p, baseline] of [...firstBefore.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const relPath = path.relative(workspaceRoot, p).split(path.sep).join('/');
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(p);
    } catch {
      current = null;
    }
    const currentSha = current !== null ? sha256(current) : null;
    const drifted = currentSha !== (expectedNow.get(p) ?? null);
    const kind: SessionDiffFile['kind'] =
      currentSha === baseline ? 'unchanged' : baseline === null ? 'create' : currentSha === null ? 'delete' : 'modify';
    if (kind === 'unchanged') {
      out.push({ path: p, relPath, kind, drifted, note: 'net-unchanged (edited then restored)' });
      continue;
    }
    let before: Buffer;
    try {
      before = baseline !== null ? snapshots.getBlob(baseline) : Buffer.alloc(0);
    } catch {
      out.push({ path: p, relPath, kind, drifted, note: 'pre-image blob missing; cannot render a diff' });
      continue;
    }
    const after = current ?? Buffer.alloc(0);
    if (before.length > DIFF_MAX_BYTES || after.length > DIFF_MAX_BYTES) {
      out.push({ path: p, relPath, kind, drifted, note: `too large to diff (${before.length} → ${after.length} bytes)` });
      continue;
    }
    if (isProbablyBinary(before) || isProbablyBinary(after)) {
      out.push({ path: p, relPath, kind, drifted, note: `binary change (${before.length} → ${after.length} bytes)` });
      continue;
    }
    out.push({ path: p, relPath, kind, drifted, patch: unifiedDiff(relPath, before.toString('utf8'), after.toString('utf8')) });
  }
  return out;
}

/** Render the session diff for a terminal/stdout surface. Deterministic given the same inputs. */
export function renderSessionDiff(files: SessionDiffFile[]): string {
  if (files.length === 0) return 'no file-tool changes recorded in this session\n(note: run_command side effects are not tracked here)';
  const L: string[] = [];
  for (const f of files) {
    const drift = f.drifted ? '  [DRIFTED: the file changed outside this session after the last recorded action]' : '';
    L.push(`${f.kind} ${f.relPath}${drift}`);
    if (f.note) L.push(`  (${f.note})`);
    else if (f.patch && f.patch.length > 0) L.push(f.patch);
  }
  L.push('');
  L.push('note: this diff covers file-tool changes only; run_command side effects are not tracked.');
  return L.join('\n');
}
