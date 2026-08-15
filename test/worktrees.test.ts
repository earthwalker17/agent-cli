import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRegistry,
  registerWorktree,
  registryFile,
  registryLockFile,
  sweepOrphanedWorktrees,
  unregisterWorktree,
  worktreesRoot,
  type WorktreeRegistryEntry,
} from '../src/runtime/worktrees.js';

/**
 * Registry concurrency contract (V0.7.1), git-free: the sweep's remover is injected, so these
 * tests pin the lock protocol, the liveness filter, and merge-on-save without a repository.
 * Real-git sweep behavior (path guard + live/dead/aged worktrees) lives in executor.e2e.test.ts.
 */

const DEAD_PID = 999_999_999; // no real process; isPidAlive → ESRCH → false

let projectDir: string;
let reg: string;
let root: string;

function entry(dir: string, over: Partial<WorktreeRegistryEntry> = {}): WorktreeRegistryEntry {
  return {
    dir,
    repoRoot: 'C:/unused',
    childSessionId: 'c',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wt-test-'));
  reg = registryFile(projectDir);
  root = worktreesRoot(projectDir);
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('worktree registry locking', () => {
  it('register/unregister roundtrip preserves owner stamps', async () => {
    const e = entry(path.join(root, 'a'), { ownerSessionId: 'parent1', pid: process.pid });
    await registerWorktree(reg, e);
    expect(loadRegistry(reg)).toEqual([e]);
    await unregisterWorktree(reg, e.dir);
    expect(loadRegistry(reg)).toEqual([]);
  });

  it('in-process fan-out (Promise.all) loses no entries', async () => {
    const dirs = ['a', 'b', 'c', 'd', 'e'].map((n) => path.join(root, n));
    await Promise.all(dirs.map((d) => registerWorktree(reg, entry(d))));
    expect(loadRegistry(reg).map((e) => e.dir).sort()).toEqual([...dirs].sort());
    await Promise.all([unregisterWorktree(reg, dirs[0]!), unregisterWorktree(reg, dirs[2]!)]);
    expect(loadRegistry(reg).map((e) => e.dir).sort()).toEqual([dirs[1]!, dirs[3]!, dirs[4]!].sort());
  });

  it('a LIVE same-pid lock holder is never stolen — register fails honestly', async () => {
    const lock = registryLockFile(reg);
    const foreign = JSON.stringify({ pid: process.pid, token: 'theirs', at: new Date().toISOString() });
    fs.writeFileSync(lock, foreign);
    await expect(registerWorktree(reg, entry(path.join(root, 'x')))).rejects.toThrow(/lock unavailable/);
    expect(loadRegistry(reg)).toEqual([]); // nothing was written
    expect(fs.readFileSync(lock, 'utf8')).toBe(foreign); // the holder's lock is intact
  }, 15_000);

  it('a dead-pid lock is broken (delete-then-recreate) and the operation proceeds', async () => {
    fs.writeFileSync(registryLockFile(reg), JSON.stringify({ pid: DEAD_PID, token: 't', at: new Date().toISOString() }));
    await registerWorktree(reg, entry(path.join(root, 'x')));
    expect(loadRegistry(reg)).toHaveLength(1);
    expect(fs.existsSync(registryLockFile(reg))).toBe(false); // released after the op
  });

  it('an over-age lock is broken even when its pid is alive (recycled-pid escape)', async () => {
    const staleAt = new Date(Date.now() - 2 * 60_000).toISOString(); // 2min > the 60s hold cap
    fs.writeFileSync(registryLockFile(reg), JSON.stringify({ pid: process.pid, token: 't', at: staleAt }));
    await registerWorktree(reg, entry(path.join(root, 'x')));
    expect(loadRegistry(reg)).toHaveLength(1);
  });

  it('a corrupt lock file is broken', async () => {
    fs.writeFileSync(registryLockFile(reg), 'not json');
    await registerWorktree(reg, entry(path.join(root, 'x')));
    expect(loadRegistry(reg)).toHaveLength(1);
  });
});

describe('sweep (injected remover — no git)', () => {
  it('skips live owners, sweeps dead and aged, keeps failures registered, merges concurrent registrations', async () => {
    const mk = (n: string): string => {
      const d = path.join(root, n);
      fs.mkdirSync(d, { recursive: true });
      return d;
    };
    const dGone = mk('gone-ok'); // dead owner, removal succeeds
    const dFail = mk('gone-fail'); // dead owner, removal fails → stays registered
    const dLive = mk('live'); // live owner → untouched
    // S22.5 regression (the removed age hatch): a live pid is NEVER swept on age. This entry is
    // 30 hours old — the shape of an executor whose forwarded approval waited overnight (approval
    // wait is excluded from the executor clock, so this is a LEGITIMATE live task, and the old
    // 8h hatch destroyed its uncaptured work with `worktree remove --force`).
    const dAged = mk('aged');
    const oldIso = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    await registerWorktree(reg, entry(dGone, { pid: 11 }));
    await registerWorktree(reg, entry(dFail, { pid: 22 }));
    await registerWorktree(reg, entry(dLive, { pid: 33 }));
    await registerWorktree(reg, entry(dAged, { pid: 44, createdAt: oldIso }));

    const dConcurrent = mk('concurrent');
    let registeredDuringRemoval = false;
    const swept = await sweepOrphanedWorktrees(projectDir, 'git-unused', {
      isAlive: (pid) => pid === 33 || pid === 44,
      remove: async (_g, _r, dir) => {
        // A sibling session registers a NEW worktree while this sweep is mid-removal: the
        // merge-on-save must preserve it (the old blind overwrite lost it).
        if (!registeredDuringRemoval) {
          registeredDuringRemoval = true;
          await registerWorktree(reg, entry(dConcurrent, { pid: process.pid }));
        }
        if (dir === dFail) return { ok: false, detail: 'EBUSY (simulated)' };
        fs.rmSync(dir, { recursive: true, force: true });
        return { ok: true };
      },
    });

    expect(swept.removed).toEqual([dGone]);
    expect(swept.failed).toEqual([{ dir: dFail, detail: 'EBUSY (simulated)' }]);
    expect(swept.skippedLive.sort()).toEqual([dAged, dLive].sort());
    expect(fs.existsSync(dLive)).toBe(true);
    expect(fs.existsSync(dAged)).toBe(true); // the overnight executor's work survives
    const after = loadRegistry(reg).map((e) => e.dir);
    expect(after.sort()).toEqual([dAged, dConcurrent, dFail, dLive].sort());
  });

  it('drops missing-dir entries without calling the remover', async () => {
    const ghost = path.join(root, 'never-created');
    await registerWorktree(reg, entry(ghost, { pid: DEAD_PID }));
    let removerCalls = 0;
    const swept = await sweepOrphanedWorktrees(projectDir, 'git-unused', {
      remove: async () => {
        removerCalls++;
        return { ok: true };
      },
    });
    expect(removerCalls).toBe(0);
    expect(swept.removed).toEqual([]);
    expect(loadRegistry(reg)).toEqual([]); // entry dropped in the merge window
  });

  it('a live-held registry lock makes the sweep skip honestly (lockUnavailable)', async () => {
    const d = path.join(root, 'x');
    fs.mkdirSync(d);
    await registerWorktree(reg, entry(d, { pid: DEAD_PID }));
    fs.writeFileSync(registryLockFile(reg), JSON.stringify({ pid: 4444, token: 't', at: new Date().toISOString() }));
    const swept = await sweepOrphanedWorktrees(projectDir, 'git-unused', {
      isAlive: () => true, // the holder reads as alive
      remove: async () => ({ ok: true }),
    });
    expect(swept.lockUnavailable).toBe(true);
    expect(swept.removed).toEqual([]);
    expect(fs.existsSync(d)).toBe(true); // nothing touched
    fs.unlinkSync(registryLockFile(reg)); // release for afterEach hygiene
    expect(loadRegistry(reg)).toHaveLength(1); // registry unread and unmodified
  }, 15_000);
});
