import fs from 'node:fs';
import type { SessionEvent } from '../types.js';
import { SnapshotStore } from '../store/snapshots.js';

export interface UndoOutcome {
  target: 'last' | 'all';
  restored: { path: string; toSha256: string | null }[];
  refused: { path: string; reason: string }[];
}

/**
 * Undo file mutations recorded in a session log. V0.1 supports two targets: `last` (the most
 * recent mutating action) and `all` (every mutation, back to session start). Restores happen in
 * reverse order so a file mutated several times chains back to its original bytes. Any file that
 * has drifted since (external edit or a prior undo) is REFUSED, not clobbered.
 */
export function applyUndo(events: readonly SessionEvent[], snapshots: SnapshotStore, target: 'last' | 'all'): UndoOutcome {
  const muts = events.filter((e): e is Extract<SessionEvent, { type: 'file.mutated' }> => e.type === 'file.mutated');
  const restored: { path: string; toSha256: string | null }[] = [];
  const refused: { path: string; reason: string }[] = [];
  if (muts.length === 0) return { target, restored, refused };

  const lastCall = muts[muts.length - 1]!.callId;
  const selected = target === 'last' ? muts.filter((m) => m.callId === lastCall) : muts;
  const ordered = [...selected].sort((a, b) => b.seq - a.seq);

  for (const m of ordered) {
    const res = snapshots.restore({ path: m.path, beforeSha256: m.beforeSha256, expectedCurrentSha256: m.afterSha256 });
    if (res.ok) {
      restored.push({ path: m.path, toSha256: m.beforeSha256 });
      if (m.beforeSha256 === null) removeCreatedDirs(m.createdDirs);
    } else {
      refused.push({ path: m.path, reason: res.reason ?? 'unknown' });
    }
  }
  return { target, restored, refused };
}

/** Remove directories the mutation created, deepest first, only if now empty. */
function removeCreatedDirs(dirs: string[]): void {
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
    } catch {
      /* not empty or already gone */
    }
  }
}
