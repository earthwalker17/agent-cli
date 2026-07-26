import fs from 'node:fs';
import path from 'node:path';
import { loadRegistryArray, saveRegistryArray, withRegistryLock } from '../shared/registry-lock.js';
import { isPidAlive } from '../store/event-log.js';
import { killTree } from '../exec/kill.js';
import { readTail } from './process.js';
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
 *
 * HONEST RESIDUAL WINDOW: a crash between the OS spawn and the registry write (which may wait
 * on the registry lock) leaves a running server with no entry and no event. The only trace is
 * its log file, created before the spawn — so the sweep additionally scans the previews log
 * directory and REPORTS (never touches) any log with no registry record and no harness ended
 * marker. The exit listener writes that marker on every observed death, which is what keeps the
 * scan's noise near zero.
 */

/** The last line the exit listener appends to a preview's log file when the death was observed. */
export const LOG_ENDED_MARKER = '[agent-cli] preview ended';

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

export async function unregisterPreview(file: string, previewId: string, ownerSessionId?: string): Promise<void> {
  await withRegistryLock(file, () => {
    saveRegistryArray(
      file,
      // Scoped to the owner when known: preview ids are short random slugs in a SHARED
      // per-project file, and a cross-session collision must never delete a sibling's
      // crash coverage.
      loadPreviewRegistry(file).filter((e) => !(e.previewId === previewId && (ownerSessionId === undefined || e.ownerSessionId === ownerSessionId))),
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
  /** Unverifiable entries past the retirement age — DEREGISTERED, never killed (see below). */
  retiredStale: string[];
  /** Log files with no registry record and no ended marker — the spawn→register crash window. */
  unaccountedLogs: string[];
  /** The registry lock could not be acquired; nothing was read or touched. */
  lockUnavailable?: boolean;
  /** Why (held live vs a filesystem error) — "busy" must not mask a read-only state dir. */
  lockDetail?: string;
}

export interface PreviewSweepOptions {
  isAlive?: (pid: number) => boolean;
  nowMs?: () => number;
  queryIdentity?: IdentityQuery;
  kill?: (pid: number) => Promise<{ verified: boolean; detail: string }>;
  /** Total identity-query wall budget; entries past it are reported, not queried. */
  wallMs?: number;
}

/** Total identity-query budget per sweep — startup must not block on N × 15s queries. */
export const SWEEP_WALL_MS = 20_000;
/**
 * An unverifiable entry older than this is DEREGISTERED without a kill: a preview's TTL is
 * minutes, so nothing this old can still be ours — but a kill still needs positive identity,
 * and deregistration is the only action that is safe without it. The process (if any) is
 * simply no longer tracked; EADDRINUSE at the next start is the honest surface.
 */
export const RETIRE_UNVERIFIED_AFTER_MS = 24 * 60 * 60 * 1000;

const emptyResult = (): PreviewSweepResult => ({
  killed: [],
  killFailed: [],
  skippedUnverified: [],
  skippedLiveOwner: [],
  droppedDead: [],
  retiredStale: [],
  unaccountedLogs: [],
});

/** Sweep crash-orphaned preview processes. Kills run UNLOCKED, like worktree removals. */
export async function sweepOrphanedPreviews(projectDir: string, opts: PreviewSweepOptions = {}): Promise<PreviewSweepResult> {
  const isAlive = opts.isAlive ?? isPidAlive;
  const nowMs = opts.nowMs ?? Date.now;
  const queryIdentity = opts.queryIdentity ?? queryProcessIdentity;
  const kill = opts.kill ?? killTree;
  const wallMs = opts.wallMs ?? SWEEP_WALL_MS;
  const file = previewsFile(projectDir);

  let entries: PreviewRegistryEntry[];
  try {
    entries = await withRegistryLock(file, () => loadPreviewRegistry(file), { isAlive, nowMs });
  } catch (err) {
    return { ...emptyResult(), lockUnavailable: true, lockDetail: (err as Error).message };
  }

  const result = emptyResult();
  const dispose = new Set<string>(); // previewIds this sweep disposed of (dead, killed, or retired)
  const startedAt = nowMs();

  for (const e of entries) {
    if (!isAlive(e.pid)) {
      result.droppedDead.push(e.previewId);
      dispose.add(e.previewId);
      continue;
    }
    // A live owner means a sibling session manages it — EXCEPT our own pid: the sweep runs
    // before this process registers anything, so an entry "owned" by our pid is a crashed
    // predecessor whose pid was recycled onto us; it falls through to identity verification.
    if (e.ownerPid !== undefined && Number.isInteger(e.ownerPid) && e.ownerPid !== process.pid && isAlive(e.ownerPid)) {
      result.skippedLiveOwner.push(e.previewId);
      continue;
    }
    const age = nowMs() - Date.parse(e.createdAt);
    const overBudget = nowMs() - startedAt >= wallMs;
    const identity = overBudget ? null : await queryIdentity(e.pid);
    const token = expectedCommandLineToken(e.command);
    const verified = identity !== null && identityMatches(identity, token, e.createdAt);
    if (!verified) {
      // Retirement is NOT a kill: deregistering a >24h-old unverifiable record is safe (nothing
      // that old is ours — the TTL is minutes), while killing without identity never is.
      if (Number.isFinite(age) && age > RETIRE_UNVERIFIED_AFTER_MS) {
        result.retiredStale.push(e.previewId);
        dispose.add(e.previewId);
        continue;
      }
      result.skippedUnverified.push({
        previewId: e.previewId,
        pid: e.pid,
        detail: overBudget
          ? 'sweep identity budget exhausted; retried next session'
          : identity === null
            ? 'identity query failed or pid vanished'
            : 'command line or creation time does not match the recorded start (possible pid reuse)',
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

  // The spawn→register crash window: a log file with no registry record and no harness ended
  // marker is the only trace of a start that died before registration. Report, never touch.
  try {
    const dir = previewLogsDir(projectDir);
    const known = new Set(entries.map((e) => path.basename(e.logFile)));
    const logs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')).slice(0, 50) : [];
    for (const f of logs) {
      if (known.has(f)) continue;
      const full = path.join(dir, f);
      // Recency-bounded: a lost spawn matters near in time; aged logs are ordinary evidence.
      if (nowMs() - fs.statSync(full).mtimeMs > 48 * 60 * 60 * 1000) continue;
      if (readTail(full, 512).includes(LOG_ENDED_MARKER)) continue;
      result.unaccountedLogs.push(full);
    }
  } catch {
    /* the scan is best-effort reporting; it must never block a session */
  }

  if (entries.length === 0 && result.unaccountedLogs.length === 0) return result;

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
