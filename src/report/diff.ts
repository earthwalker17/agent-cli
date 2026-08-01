import fs from 'node:fs';
import path from 'node:path';
import type { SessionEvent, MutationKind } from '../types.js';
import type { SnapshotStore } from '../store/snapshots.js';
import { sha256 } from '../shared/hash.js';
import { DIFF_MAX_BYTES, isProbablyBinary, lineDiffStat, unifiedDiff } from '../shared/diff.js';
import { isSecretName } from '../policy/engine.js';
import { collectPassingEvidence, firstPassingEvidenceAfter } from './report.js';

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
  /** S14.5 (F): the report's CHECKED verdict beside the diff — the SAME correlation, never a
   *  second meaning ("check ran, exit 0" after this path's last mutation; no correctness claim). */
  checked?: boolean;
  checkedBy?: string;
}

/**
 * Per-path session mutation state from the evidence log: the FIRST recorded pre-image and the
 * LAST state the session recorded (undo restores folded in). Keys are the recorded absolute
 * paths. This is the single source of session attribution — /diff and /commit both use it.
 */
export function sessionMutationState(events: readonly SessionEvent[]): {
  firstBefore: Map<string, string | null>;
  expectedNow: Map<string, string | null>;
} {
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
  return { firstBefore, expectedNow };
}

export function buildSessionDiff(
  events: readonly SessionEvent[],
  snapshots: SnapshotStore,
  workspaceRoot: string,
  /** Config's extra secret-name substrings, so the diff withholds exactly what the gate redacts. */
  secretPatterns?: readonly string[],
): SessionDiffFile[] {
  const { firstBefore, expectedNow } = sessionMutationState(events);
  // CHECKED annotation (S14.5): the last CONTENT-CHANGE seq per path (tracked here, NOT in
  // sessionMutationState — /commit shares that fold and its contract stays byte-stable), fed
  // through the report's own correlation so the verdict has exactly one implementation.
  // undo.applied and git.restore count: they write bytes back to disk while recording only
  // their own event, so anchoring on file.mutated alone printed [CHECKED] over content the
  // passing check never saw (a partial /undo after a green check — S14.5 review finding).
  const lastMutationSeq = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'file.mutated') lastMutationSeq.set(e.path, e.seq);
    else if (e.type === 'undo.applied' || e.type === 'git.restore') {
      // undo.applied records {path, toSha256}; git.restore records plain paths.
      for (const r of e.restored) lastMutationSeq.set(typeof r === 'string' ? r : r.path, e.seq);
    }
  }
  const passingEvidence = collectPassingEvidence(events);

  const out: SessionDiffFile[] = [];
  for (const [p, baseline] of [...firstBefore.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const relPath = path.relative(workspaceRoot, p).split(path.sep).join('/');
    const evidence = firstPassingEvidenceAfter(passingEvidence, lastMutationSeq.get(p) ?? Number.MAX_SAFE_INTEGER, relPath);
    const checkedFields = { checked: evidence !== undefined, ...(evidence !== undefined ? { checkedBy: evidence.command } : {}) };
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
      out.push({ path: p, relPath, kind, drifted, note: 'pre-image blob missing; cannot render a diff', ...checkedFields });
      continue;
    }
    const after = current ?? Buffer.alloc(0);
    if (before.length > DIFF_MAX_BYTES || after.length > DIFF_MAX_BYTES) {
      out.push({ path: p, relPath, kind, drifted, note: `too large to diff (${before.length} → ${after.length} bytes)`, ...checkedFields });
      continue;
    }
    if (isProbablyBinary(before) || isProbablyBinary(after)) {
      out.push({ path: p, relPath, kind, drifted, note: `binary change (${before.length} → ${after.length} bytes)`, ...checkedFields });
      continue;
    }
    // A secret-named file's CONTENTS are withheld (Session 16). Reading one is an ask-with-
    // redaction at the policy gate, and the log never persists the bytes — but the session diff
    // reconstructs them from the snapshot blob and prints them to a terminal that is routinely
    // pasted into issues and transcripts. Writing `.env` became a routine step this session, so
    // the diff now reports the SHAPE of the change and withholds the body. The stat still comes
    // from the real bytes, so "the agent changed 3 lines of .env" remains visible and reviewable.
    if (isSecretName(relPath, secretPatterns) || isSecretName(p, secretPatterns)) {
      const stat = lineDiffStat(before.toString('utf8'), after.toString('utf8'));
      out.push({
        path: p,
        relPath,
        kind,
        drifted,
        note: `contents withheld: secret-named file (+${String(stat.added)}/−${String(stat.removed)} lines)`,
        ...checkedFields,
      });
      continue;
    }
    out.push({ path: p, relPath, kind, drifted, patch: unifiedDiff(relPath, before.toString('utf8'), after.toString('utf8')), ...checkedFields });
  }
  return out;
}

/** Render the session diff for a terminal/stdout surface. Deterministic given the same inputs. */
export function renderSessionDiff(files: SessionDiffFile[]): string {
  if (files.length === 0) return 'no file-tool changes recorded in this session\n(note: run_command side effects are not tracked here)';
  const L: string[] = [];
  for (const f of files) {
    const drift = f.drifted ? '  [DRIFTED: the file changed outside this session after the last recorded action]' : '';
    const verdict = f.checked === true ? `  [CHECKED: ${f.checkedBy ?? ''} — check ran, exit 0; no correctness claim]` : f.checked === false ? '  [UNCHECKED]' : '';
    L.push(`${f.kind} ${f.relPath}${drift}${verdict}`);
    if (f.note) L.push(`  (${f.note})`);
    else if (f.patch && f.patch.length > 0) L.push(f.patch);
  }
  L.push('');
  L.push('note: this diff covers file-tool changes only; run_command side effects are not tracked.');
  return L.join('\n');
}
