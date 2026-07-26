import path from 'node:path';
import { loadRegistryArray, saveRegistryArray, withRegistryLock } from '../shared/registry-lock.js';
import { isPidAlive } from '../store/event-log.js';
import { killTree } from '../exec/kill.js';
import { expectedCommandLineToken, identityMatches, queryProcessIdentity, type IdentityQuery } from './identity.js';
import type { PreviewRegistryEntry } from './types.js';

/**
 * The preview crash registry (Session 13) — the worktree registry's sibling, with one calculus
 * change that shapes every rule here: the disposal action is KILLING A PROCESS, not deleting a
 * derived directory. Deleting late is safe; killing wrong is not. So:
 *  - a dead preview pid drops its entry (nothing to do);
 *  - a live pid whose OWNER harness process is alive is a sibling session's resource — skipped;
 *  - a live ORPHAN is killed only after positive identity verification (command-line token +
 *    creation-time tolerance, preview/identity.ts). Mismatch or an unanswerable query SKIPS the
 *    kill and reports it; there is deliberately NO age hatch on this path (the worktree hatch
 *    exists because delayed removal is safe — a forced kill past verification is exactly the
 *    recycled-pid accident this module exists to prevent).
 *
 * Ordering contract with the event log (load-bearing): the registry entry is written BEFORE
 * `preview.started` is appended, so a crash between the two leaves a sweepable entry with no
 * event — never an event whose promised sweep cannot find the process. The stop path is the
 * mirror: `preview.ended` first, THEN unregister (a crash between self-heals as a dead-pid drop).
 */

export function previewsFile(projectDir: string): string {
  return path.join(projectDir, 'previews.json');
}

/** Per-preview log files live under the project state dir — evidence, kept after the process. */
export function previewLogsDir(projectDir: string): string {
  return path.join(projectDir, 'previews');
}

export function previewLogFile(projectDir: string, sessionId: string, previewId: string): string {
  return path.join(previewLogsDir(projectDir), `${sessionId}-${previewId}.log`);
}

function isPreviewEntry(e: unknown): e is PreviewRegistryEntry {
  const p = e as PreviewRegistryEntry;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof p.previewId === 'string' &&
    Number.isInteger(p.pid) &&
    typeof p.command === 'string' &&
    typeof p.createdAt === 'string'
  );
}

export function loadPreviewRegistry(file: string): PreviewRegistryEntry[] {
  return loadRegistryArray(file, isPreviewEntry);
}

export async function registerPreview(file: string, entry: PreviewRegistryEntry): Promise<void> {
  await withRegistryLock(file, () => {
    saveRegistryArray(file, [...loadPreviewRegistry(file), entry]);
  });
}

export async function unregisterPreview(file: string, previewId: string): Promise<void> {
  await withRegistryLock(file, () => {
    saveRegistryArray(
      file,
      loadPreviewRegistry(file).filter((e) => e.previewId !== previewId),
    );
  });
}

export interface PreviewSweepResult {
  killed: { previewId: string; pid: number }[];
  killFailed: { previewId: string; pid: number; detail: string }[];
  /** Live orphans whose identity could not be positively verified — reported, never killed. */
  skippedUnverified: { previewId: string; pid: number; detail: string }[];
  /** Entries owned by a live harness process (a sibling session) — not orphans. */
  skippedLiveOwner: string[];
  /** Entries whose preview pid is already dead — dropped, nothing to do. */
  droppedDead: string[];
  /** The registry lock was contended past its retry budget; nothing was read or touched. */
  lockUnavailable?: boolean;
}

export interface PreviewSweepOptions {
  isAlive?: (pid: number) => boolean;
  nowMs?: () => number;
  queryIdentity?: IdentityQuery;
  kill?: (pid: number) => Promise<{ verified: boolean; detail: string }>;
}

const emptyResult = (): PreviewSweepResult => ({
  killed: [],
  killFailed: [],
  skippedUnverified: [],
  skippedLiveOwner: [],
  droppedDead: [],
});

/** Sweep crash-orphaned preview processes. Kills run UNLOCKED, like worktree removals. */
export async function sweepOrphanedPreviews(projectDir: string, opts: PreviewSweepOptions = {}): Promise<PreviewSweepResult> {
  const isAlive = opts.isAlive ?? isPidAlive;
  const nowMs = opts.nowMs ?? Date.now;
  const queryIdentity = opts.queryIdentity ?? queryProcessIdentity;
  const kill = opts.kill ?? killTree;
  const file = previewsFile(projectDir);

  let entries: PreviewRegistryEntry[];
  try {
    entries = await withRegistryLock(file, () => loadPreviewRegistry(file), { isAlive, nowMs });
  } catch {
    return { ...emptyResult(), lockUnavailable: true };
  }
  if (entries.length === 0) return emptyResult();

  const result = emptyResult();
  const dispose = new Set<string>(); // previewIds this sweep disposed of (dead or verified-killed)

  for (const e of entries) {
    if (!isAlive(e.pid)) {
      result.droppedDead.push(e.previewId);
      dispose.add(e.previewId);
      continue;
    }
    if (e.ownerPid !== undefined && Number.isInteger(e.ownerPid) && isAlive(e.ownerPid)) {
      result.skippedLiveOwner.push(e.previewId);
      continue;
    }
    // Live orphan: verify identity, then kill — or report why not.
    const identity = await queryIdentity(e.pid);
    const token = expectedCommandLineToken(e.command);
    if (identity === null) {
      result.skippedUnverified.push({ previewId: e.previewId, pid: e.pid, detail: 'identity query failed or pid vanished' });
      continue;
    }
    if (!identityMatches(identity, token, e.createdAt)) {
      result.skippedUnverified.push({
        previewId: e.previewId,
        pid: e.pid,
        detail: 'command line or creation time does not match the recorded start (possible pid reuse)',
      });
      continue;
    }
    const r = await kill(e.pid);
    if (r.verified) {
      result.killed.push({ previewId: e.previewId, pid: e.pid });
      dispose.add(e.previewId);
    } else {
      result.killFailed.push({ previewId: e.previewId, pid: e.pid, detail: r.detail });
    }
  }

  // Merge-on-save: drop only what this sweep disposed of; concurrent registrations survive;
  // kill-failed and unverified entries stay registered so the next session retries/reports.
  try {
    await withRegistryLock(
      file,
      () => {
        saveRegistryArray(
          file,
          loadPreviewRegistry(file).filter((e) => !dispose.has(e.previewId)),
        );
      },
      { isAlive, nowMs },
    );
  } catch {
    /* postponed: dead entries are harmless and drop on the next sweep */
  }
  return result;
}
