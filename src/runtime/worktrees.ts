import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isInside } from '../shared/pathutil.js';
import {
  loadRegistryArray,
  registryLockFile,
  REGISTRY_LOCK_STALE_MS,
  saveRegistryArray,
  withRegistryLock,
} from '../shared/registry-lock.js';
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
 * must never destroy a LIVE sibling's worktree. The locking machinery lives in
 * shared/registry-lock.ts (extracted in Session 13 for the preview registry — identical
 * semantics, one implementation); the rules that stay HERE are the sweep policies:
 *  - entries are stamped with their owning session + pid; the sweep skips every entry whose pid
 *    is alive (conservative: a recycled pid delays a sweep, never the reverse — the removed age
 *    hatch is argued at length above SweepOptions);
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

// Re-exported so existing consumers (tests included) keep one import site per concept.
export { registryLockFile, REGISTRY_LOCK_STALE_MS };

/*
 * There is deliberately NO age hatch on live-pid entries (S22.5; it was 2h at V0.7.1, widened to
 * 8h in S20.5, removed here). The hatch's premise — "older than any live task can be" — died the
 * moment the executor wall clock started EXCLUDING forwarded-approval wait (S20.5): a live
 * executor whose human stepped away overnight is legitimately arbitrarily old, and NO finite age
 * distinguishes it from a crashed session whose pid was recycled onto a long-lived process.
 * Nothing file-based can either (a crashed owner's stale registry entry and lock file both show
 * the same live pid). Since one side of the ambiguity is destroying a live executor's uncaptured
 * work with `worktree remove --force` and the other is a temp-dir checkout lingering until its
 * squatter pid dies, the sweep now sides with the preview registry's doctrine — destruction
 * needs positive identity; a live pid ALWAYS skips. A DEAD pid is still swept immediately, which
 * covers the common crash (a crashed session's pid is normally dead, not recycled).
 */

function isWorktreeEntry(e: unknown): e is WorktreeRegistryEntry {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as WorktreeRegistryEntry).dir === 'string' &&
    typeof (e as WorktreeRegistryEntry).repoRoot === 'string' &&
    typeof (e as WorktreeRegistryEntry).childSessionId === 'string'
  );
}

export function loadRegistry(file: string): WorktreeRegistryEntry[] {
  return loadRegistryArray(file, isWorktreeEntry);
}

export async function registerWorktree(file: string, entry: WorktreeRegistryEntry): Promise<void> {
  await withRegistryLock(file, () => {
    saveRegistryArray(file, [...loadRegistry(file), entry]);
  });
}

export async function unregisterWorktree(file: string, dir: string): Promise<void> {
  await withRegistryLock(file, () => {
    saveRegistryArray(
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
    if (e.pid !== undefined && Number.isInteger(e.pid) && isAlive(e.pid)) {
      skippedLive.push(e.dir); // a live owner — never an orphan, however old (see the header)
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
        saveRegistryArray(
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
