import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isInside } from '../shared/pathutil.js';
import { removeWorktree } from '../git/worktree.js';
import { isPidAlive } from '../store/event-log.js';

/**
 * Task-worktree placement and lifecycle bookkeeping (V0.7).
 *
 * PLACEMENT IS POLICY-DICTATED: validatePath denies writes inside the state dir and any path
 * carrying a `.agent-cli` segment, and the workspace must not contain derived checkouts — so
 * worktrees live under the OS temp dir: `<tmp>/agent-cli-worktrees/<projectSlug>/<childId>`.
 * Ephemeral by design; the captured diff (blobs + task.changes events) is the durable record.
 *
 * The registry (`<projectDir>/worktrees.json`) exists for exactly one reason: a crash between
 * `worktree add` and the removal `finally` must leave a trail the next session can sweep. The
 * sweep is REGISTRY-DRIVEN and refuses to touch any path outside the worktrees root it derives
 * — it can never remove something it did not create.
 *
 * CONCURRENCY (V0.7.1): two parent sessions in one project are a supported scenario (session
 * locks are per-session), so the registry is shared mutable cross-process state and the sweep
 * must never destroy a LIVE sibling's worktree. Three rules make this safe:
 *  - entries are stamped with their owning session + pid; the sweep skips entries whose pid is
 *    alive (conservative: a recycled pid delays a sweep, never the reverse) unless the entry is
 *    older than any live task can be (executor wall clock is minutes; the age hatch is hours);
 *  - every registry read-modify-write runs under withRegistryLock — an in-process async mutex
 *    (register/unregister are called from inside a group's Promise.all fan-out and are only
 *    atomic if serialized) plus a token-based O_EXCL lock file for cross-process callers. A
 *    same-pid holder is NEVER treated as stale by pid (group members share the pid); staleness
 *    is dead-pid or an exceeded max hold age, and a stale break is delete-then-retry-create so
 *    exactly one breaker can win.
 *  - the lock is held only at the registry read/write edges — never across git removals, which
 *    can take minutes on a stuck handle. The sweep's final save is a MERGE (re-read, drop only
 *    what this sweep disposed of), so a concurrent registration always survives.
 */

export interface WorktreeRegistryEntry {
  dir: string;
  repoRoot: string;
  childSessionId: string;
  createdAt: string;
  /** Owning parent session + process (V0.7.1). Absent on legacy entries — always sweepable. */
  ownerSessionId?: string;
  pid?: number;
}

/** The per-project worktree home under the OS temp dir. */
export function worktreesRoot(projectDir: string): string {
  return path.join(os.tmpdir(), 'agent-cli-worktrees', path.basename(projectDir));
}

/** A fresh worktree dir for a child (random tail: child ids are unique, but never assume). */
export function newWorktreeDir(root: string, childSessionId: string): string {
  return path.join(root, `${childSessionId}-${randomBytes(2).toString('hex')}`);
}

export function registryFile(projectDir: string): string {
  return path.join(projectDir, 'worktrees.json');
}

export function registryLockFile(file: string): string {
  return `${file}.lock`;
}

/** Registry ops hold the lock for milliseconds; anything older than this is a crashed holder. */
export const REGISTRY_LOCK_STALE_MS = 60_000;
/**
 * Sweep age hatch: an entry older than this is swept even if its recorded pid is alive — the
 * executor wall clock is bounded in minutes, so no LIVE task's worktree can be hours old; only
 * a crashed session whose pid was recycled onto a long-lived process looks like this.
 */
export const SWEEP_LIVE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_DELAY_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface LivenessOpts {
  isAlive: (pid: number) => boolean;
  nowMs: () => number;
}

async function acquireRegistryLock(file: string, opts: LivenessOpts): Promise<string> {
  const lockFile = registryLockFile(file);
  const token = randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const payload = JSON.stringify({ pid: process.pid, token, at: new Date(opts.nowMs()).toISOString() });
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, payload, { flag: 'wx' });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // A holder exists. It is stale ONLY when its pid is dead or its hold outlived the max age
    // (which also frees a lock whose dead holder's pid was recycled — even onto this process).
    // A live same-pid holder is a sibling operation, never reclaimable (the event-log's
    // same-pid rule must NOT be copied here: group members share one pid).
    let stale = false;
    try {
      const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: unknown; at?: unknown };
      const age = opts.nowMs() - Date.parse(typeof holder.at === 'string' ? holder.at : '');
      const heldWithinAge = Number.isFinite(age) && age <= REGISTRY_LOCK_STALE_MS;
      stale = typeof holder.pid !== 'number' || !opts.isAlive(holder.pid) || !heldWithinAge;
    } catch {
      stale = true; // unreadable or corrupt lock: break it
    }
    if (stale) {
      // Delete-then-retry-create: after the unlink, only ONE contender's O_EXCL create wins.
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* already broken by someone else */
      }
      continue;
    }
    await sleep(LOCK_RETRY_DELAY_MS);
  }
  throw new Error(`worktree registry lock unavailable (held live): ${lockFile}`);
}

function releaseRegistryLock(file: string, token: string): void {
  const lockFile = registryLockFile(file);
  try {
    const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { token?: unknown };
    if (holder.token !== token) return; // ours was age-broken and re-acquired; never delete theirs
  } catch {
    return; // gone or unreadable — nothing of ours to release
  }
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* already gone */
  }
}

/** In-process serialization per registry file: the cross-process lock cannot arbitrate same-pid. */
const registryChains = new Map<string, Promise<unknown>>();

async function withRegistryLock<T>(file: string, fn: () => T | Promise<T>, opts?: Partial<LivenessOpts>): Promise<T> {
  const key = path.resolve(file);
  const liveness: LivenessOpts = { isAlive: opts?.isAlive ?? isPidAlive, nowMs: opts?.nowMs ?? Date.now };
  const prev = registryChains.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    const token = await acquireRegistryLock(file, liveness);
    try {
      return await fn();
    } finally {
      releaseRegistryLock(file, token);
    }
  });
  // The chain must survive a rejected operation (the caller still sees the rejection).
  registryChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function loadRegistry(file: string): WorktreeRegistryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is WorktreeRegistryEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as WorktreeRegistryEntry).dir === 'string' &&
        typeof (e as WorktreeRegistryEntry).repoRoot === 'string' &&
        typeof (e as WorktreeRegistryEntry).childSessionId === 'string',
    );
  } catch {
    return [];
  }
}

function saveRegistry(file: string, entries: WorktreeRegistryEntry[]): void {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

export async function registerWorktree(file: string, entry: WorktreeRegistryEntry): Promise<void> {
  await withRegistryLock(file, () => {
    saveRegistry(file, [...loadRegistry(file), entry]);
  });
}

export async function unregisterWorktree(file: string, dir: string): Promise<void> {
  await withRegistryLock(file, () => {
    saveRegistry(
      file,
      loadRegistry(file).filter((e) => e.dir !== dir),
    );
  });
}

export interface SweepResult {
  removed: string[];
  failed: { dir: string; detail: string }[];
  /** Entries left alone because their owning process is alive (a live sibling session). */
  skippedLive: string[];
  /** The registry lock was contended past its retry budget; nothing was read or touched. */
  lockUnavailable?: boolean;
}

export interface SweepOptions {
  isAlive?: (pid: number) => boolean;
  nowMs?: () => number;
  /** Injectable removal (tests); defaults to the real EBUSY-retrying git worktree removal. */
  remove?: (gitPath: string, repoRoot: string, dir: string) => Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Remove crash-orphaned task worktrees recorded in the registry. Path-guarded: entries outside
 * this project's worktrees root are dropped from the registry but NEVER touched on disk. Live
 * siblings' entries (alive pid, within the age hatch) are skipped untouched.
 */
export async function sweepOrphanedWorktrees(projectDir: string, gitPath: string, opts: SweepOptions = {}): Promise<SweepResult> {
  const isAlive = opts.isAlive ?? isPidAlive;
  const nowMs = opts.nowMs ?? Date.now;
  const remove = opts.remove ?? removeWorktree;
  const file = registryFile(projectDir);
  const root = worktreesRoot(projectDir);

  let entries: WorktreeRegistryEntry[];
  try {
    entries = await withRegistryLock(file, () => loadRegistry(file), { isAlive, nowMs });
  } catch {
    return { removed: [], failed: [], skippedLive: [], lockUnavailable: true };
  }
  if (entries.length === 0) return { removed: [], failed: [], skippedLive: [] };

  const dropDirs = new Set<string>(); // guarded-out or already gone: drop the entry, never touch disk
  const skippedLive: string[] = [];
  const candidates: WorktreeRegistryEntry[] = [];
  for (const e of entries) {
    if (!isInside(root, e.dir)) {
      dropDirs.add(e.dir); // not ours to touch
      continue;
    }
    if (!fs.existsSync(e.dir)) {
      dropDirs.add(e.dir); // already gone
      continue;
    }
    const age = nowMs() - Date.parse(e.createdAt);
    const beyondAgeHatch = Number.isFinite(age) && age > SWEEP_LIVE_MAX_AGE_MS;
    if (e.pid !== undefined && Number.isInteger(e.pid) && isAlive(e.pid) && !beyondAgeHatch) {
      skippedLive.push(e.dir); // a live sibling owns it — not an orphan
      continue;
    }
    candidates.push(e);
  }

  // Removals run UNLOCKED: a stuck removal retries for minutes and must never couple a live
  // sibling's registry access (register = executor availability) to this session's disk work.
  const removed: string[] = [];
  const failed: { dir: string; detail: string }[] = [];
  for (const e of candidates) {
    const r = await remove(gitPath, e.repoRoot, e.dir);
    if (r.ok) removed.push(e.dir);
    else failed.push({ dir: e.dir, detail: r.detail ?? 'removal failed' });
  }

  // Merge-on-save: drop ONLY what this sweep disposed of. Failed candidates stay registered for
  // a later retry; entries registered concurrently (a sibling spawning executors) survive.
  const disposed = new Set<string>([...dropDirs, ...removed]);
  try {
    await withRegistryLock(
      file,
      () => {
        saveRegistry(
          file,
          loadRegistry(file).filter((e) => !disposed.has(e.dir)),
        );
      },
      { isAlive, nowMs },
    );
  } catch {
    /* postponed: entries for removed dirs are harmless — a missing dir drops on the next sweep */
  }
  return { removed, failed, skippedLive };
}
