import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isAlive as isPidAlive } from '../exec/kill.js';

/**
 * Shared file-registry locking (extracted from the worktree registry in Session 13, verbatim
 * semantics — the preview registry needs the identical machinery and the constitution forbids
 * a parallel implementation of the same behavior).
 *
 * A registry is a small JSON array at a known path, shared mutable cross-process state. Three
 * rules make mutation safe (V0.7.1 provenance, see runtime/worktrees.ts for the original
 * rationale):
 *  - every read-modify-write runs under `withRegistryLock` — an in-process async mutex per
 *    resolved file path (same-pid callers, e.g. a group's Promise.all fan-out, are only atomic
 *    if serialized) plus a token-based O_EXCL lock file for cross-process callers;
 *  - a live same-pid lock holder is NEVER treated as stale by pid (same-pid siblings are
 *    legitimate); staleness is dead-pid or an exceeded max hold age, and a stale break is
 *    delete-then-retry-create so exactly one breaker can win;
 *  - the lock is held only at registry read/write edges — callers must never hold it across
 *    slow work (git removals, process kills).
 */

export function registryLockFile(file: string): string {
  return `${file}.lock`;
}

/** Registry ops hold the lock for milliseconds; anything older than this is a crashed holder. */
export const REGISTRY_LOCK_STALE_MS = 60_000;
const LOCK_ATTEMPTS = 40;
const LOCK_RETRY_DELAY_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LivenessOpts {
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
    // same-pid rule must NOT be copied here: same-pid siblings are legitimate).
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
  throw new Error(`registry lock unavailable (held live): ${lockFile}`);
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

export async function withRegistryLock<T>(file: string, fn: () => T | Promise<T>, opts?: Partial<LivenessOpts>): Promise<T> {
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

/** Lenient array load: corrupt/missing files read as empty; entries failing the guard are dropped. */
export function loadRegistryArray<T>(file: string, isValid: (e: unknown) => e is T): T[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

/** Atomic same-dir temp + rename save (a torn read is structurally impossible). */
export function saveRegistryArray(file: string, entries: readonly unknown[]): void {
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
