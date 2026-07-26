import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadPreviewRegistry,
  previewsFile,
  registerPreview,
  sweepOrphanedPreviews,
  unregisterPreview,
} from '../src/preview/registry.js';
import { expectedCommandLineToken } from '../src/preview/identity.js';
import { registryLockFile } from '../src/shared/registry-lock.js';
import { isAlive, killTree } from '../src/exec/kill.js';
import type { PreviewRegistryEntry } from '../src/preview/types.js';
import type { ProcessIdentity } from '../src/preview/identity.js';

/**
 * The preview crash registry and its identity-verified sweep (Session 13). The load-bearing
 * property in every case: a kill happens ONLY after positive identity verification — a wrong
 * kill is the one irreversible mistake this module exists to prevent.
 */

const DEAD_PID = 999_999_499; // far beyond any real pid on this machine

let tmp: string;
let projectDir: string;
let children: ChildProcess[];

function spawnLongLived(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', windowsHide: true });
  children.push(c);
  return c;
}

function entry(over: Partial<PreviewRegistryEntry>): PreviewRegistryEntry {
  return {
    previewId: `pv-${Math.random().toString(16).slice(2, 8)}`,
    pid: DEAD_PID,
    command: 'npm run dev',
    cwd: tmp,
    ownerSessionId: 'test-session-0001',
    ownerPid: DEAD_PID,
    createdAt: new Date().toISOString(),
    logFile: path.join(tmp, 'p.log'),
    ...over,
  };
}

/** An identity that positively matches `command` started at `createdAt`. */
function matchingIdentity(command: string, createdAt: string): ProcessIdentity {
  return { commandLine: `prefix ${expectedCommandLineToken(command)} suffix`, startedAtMs: Date.parse(createdAt) + 500 };
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-prevreg-')));
  projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  children = [];
});

afterEach(async () => {
  for (const c of children) {
    if (c.pid !== undefined && isAlive(c.pid)) await killTree(c.pid);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('preview registry', () => {
  it('register / unregister round-trip', async () => {
    const file = previewsFile(projectDir);
    const e = entry({ previewId: 'pv-a' });
    await registerPreview(file, e);
    expect(loadPreviewRegistry(file)).toEqual([e]);
    await unregisterPreview(file, 'pv-a');
    expect(loadPreviewRegistry(file)).toEqual([]);
  });

  it('corrupt registry reads as empty; malformed entries are dropped', async () => {
    const file = previewsFile(projectDir);
    fs.writeFileSync(file, 'not json');
    expect(loadPreviewRegistry(file)).toEqual([]);
    fs.writeFileSync(file, JSON.stringify([{ nope: true }, entry({ previewId: 'pv-ok' })]));
    expect(loadPreviewRegistry(file).map((e) => e.previewId)).toEqual(['pv-ok']);
  });
});

describe('sweepOrphanedPreviews', () => {
  it('drops entries whose preview pid is dead — no identity query, no kill', async () => {
    const file = previewsFile(projectDir);
    await registerPreview(file, entry({ previewId: 'pv-dead', pid: DEAD_PID }));
    const queried: number[] = [];
    const res = await sweepOrphanedPreviews(projectDir, {
      queryIdentity: (pid) => {
        queried.push(pid);
        return Promise.resolve(null);
      },
    });
    expect(res.droppedDead).toEqual(['pv-dead']);
    expect(queried).toEqual([]);
    expect(loadPreviewRegistry(file)).toEqual([]);
  });

  it('skips a live preview owned by a live SIBLING harness process', async () => {
    const c = spawnLongLived();
    const owner = spawnLongLived(); // a live pid that is NOT this process
    const file = previewsFile(projectDir);
    await registerPreview(file, entry({ previewId: 'pv-sib', pid: c.pid!, ownerPid: owner.pid! }));
    const res = await sweepOrphanedPreviews(projectDir, {
      queryIdentity: () => Promise.reject(new Error('must not be queried')),
    });
    expect(res.skippedLiveOwner).toEqual(['pv-sib']);
    expect(isAlive(c.pid!)).toBe(true);
    expect(loadPreviewRegistry(file)).toHaveLength(1); // kept
  });

  it('an entry "owned" by OUR OWN pid is a recycled predecessor, not a sibling — identity path, not a skip', async () => {
    const c = spawnLongLived();
    const file = previewsFile(projectDir);
    // The sweep runs before this process registers anything, so ownerPid === process.pid can
    // only mean a crashed predecessor whose pid was recycled onto us.
    await registerPreview(file, entry({ previewId: 'pv-recycled', pid: c.pid!, ownerPid: process.pid }));
    const res = await sweepOrphanedPreviews(projectDir, { queryIdentity: () => Promise.resolve(null) });
    expect(res.skippedLiveOwner).toEqual([]);
    expect(res.skippedUnverified).toHaveLength(1); // it reached identity verification
    expect(isAlive(c.pid!)).toBe(true); // and was not killed without it
  });

  it('unverifiable entries older than the retirement age are DEREGISTERED, never killed', async () => {
    const c = spawnLongLived();
    const file = previewsFile(projectDir);
    const e = entry({
      previewId: 'pv-ancient',
      pid: c.pid!,
      ownerPid: DEAD_PID,
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    await registerPreview(file, e);
    const res = await sweepOrphanedPreviews(projectDir, { queryIdentity: () => Promise.resolve(null) });
    expect(res.retiredStale).toEqual(['pv-ancient']);
    expect(res.killed).toEqual([]);
    expect(isAlive(c.pid!)).toBe(true); // deregistration is safe without identity; a kill never is
    expect(loadPreviewRegistry(file)).toEqual([]);
  });

  it('the identity-query wall budget bounds the sweep; the remainder is reported, not queried', async () => {
    const file = previewsFile(projectDir);
    const kids = [spawnLongLived(), spawnLongLived(), spawnLongLived()];
    for (let i = 0; i < kids.length; i++) {
      await registerPreview(file, entry({ previewId: `pv-b${i}`, pid: kids[i]!.pid!, ownerPid: DEAD_PID }));
    }
    let queries = 0;
    let fake = 0;
    const res = await sweepOrphanedPreviews(projectDir, {
      nowMs: () => {
        // Each call advances fake time far past the budget after the first query completes.
        fake += 30_000;
        return fake;
      },
      queryIdentity: () => {
        queries++;
        return Promise.resolve(null);
      },
    });
    expect(queries).toBeLessThan(kids.length); // the budget stopped the querying
    expect(res.skippedUnverified.some((s) => s.detail.includes('budget exhausted'))).toBe(true);
  });

  it('a preview log with no registry record and no ended marker is reported as unaccounted', async () => {
    const dir = path.join(projectDir, 'previews');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-pv-lost.log'), 'server starting…\n');
    fs.writeFileSync(path.join(dir, 'sess-pv-done.log'), 'served\n[agent-cli] preview ended (stopped)\n');
    const res = await sweepOrphanedPreviews(projectDir, { queryIdentity: () => Promise.resolve(null) });
    expect(res.unaccountedLogs).toEqual([path.join(dir, 'sess-pv-lost.log')]);
  });

  it('unregister is scoped to the owning session: an id collision cannot delete a sibling entry', async () => {
    const file = previewsFile(projectDir);
    await registerPreview(file, entry({ previewId: 'pv-same', ownerSessionId: 'session-A' }));
    await registerPreview(file, entry({ previewId: 'pv-same', ownerSessionId: 'session-B' }));
    await unregisterPreview(file, 'pv-same', 'session-A');
    const left = loadPreviewRegistry(file);
    expect(left).toHaveLength(1);
    expect(left[0]!.ownerSessionId).toBe('session-B');
  });

  it('kills a live orphan ONLY after identity verification, and drops its entry', async () => {
    const c = spawnLongLived();
    const file = previewsFile(projectDir);
    const e = entry({ previewId: 'pv-orphan', pid: c.pid!, ownerPid: DEAD_PID });
    await registerPreview(file, e);
    const res = await sweepOrphanedPreviews(projectDir, {
      queryIdentity: () => Promise.resolve(matchingIdentity(e.command, e.createdAt)),
    });
    expect(res.killed).toEqual([{ previewId: 'pv-orphan', pid: c.pid! }]);
    expect(isAlive(c.pid!)).toBe(false);
    expect(loadPreviewRegistry(file)).toEqual([]);
  }, 30_000);

  it('SKIPS the kill on an identity mismatch (possible pid reuse) and keeps the entry', async () => {
    const c = spawnLongLived();
    const file = previewsFile(projectDir);
    const e = entry({ previewId: 'pv-mismatch', pid: c.pid!, ownerPid: DEAD_PID });
    await registerPreview(file, e);
    const res = await sweepOrphanedPreviews(projectDir, {
      queryIdentity: () => Promise.resolve({ commandLine: 'some entirely different process', startedAtMs: Date.parse(e.createdAt) }),
    });
    expect(res.killed).toEqual([]);
    expect(res.skippedUnverified).toHaveLength(1);
    expect(res.skippedUnverified[0]!.detail).toContain('pid reuse');
    expect(isAlive(c.pid!)).toBe(true); // the innocent process lives
    expect(loadPreviewRegistry(file)).toHaveLength(1); // reported next session too
  });

  it('SKIPS the kill when the identity query fails entirely', async () => {
    const c = spawnLongLived();
    const file = previewsFile(projectDir);
    await registerPreview(file, entry({ previewId: 'pv-noquery', pid: c.pid!, ownerPid: DEAD_PID }));
    const res = await sweepOrphanedPreviews(projectDir, { queryIdentity: () => Promise.resolve(null) });
    expect(res.killed).toEqual([]);
    expect(res.skippedUnverified).toHaveLength(1);
    expect(isAlive(c.pid!)).toBe(true);
  });

  it('SKIPS the kill when the creation time is outside tolerance, even with a matching command line', async () => {
    const c = spawnLongLived();
    const file = previewsFile(projectDir);
    const e = entry({
      previewId: 'pv-oldstamp',
      pid: c.pid!,
      ownerPid: DEAD_PID,
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // an hour ago
    });
    await registerPreview(file, e);
    const res = await sweepOrphanedPreviews(projectDir, {
      queryIdentity: () => Promise.resolve({ commandLine: `x ${expectedCommandLineToken(e.command)} y`, startedAtMs: Date.now() }),
    });
    expect(res.killed).toEqual([]);
    expect(res.skippedUnverified).toHaveLength(1);
    expect(isAlive(c.pid!)).toBe(true);
  });

  it('a failed kill keeps the entry for the next session and reports the detail', async () => {
    const c = spawnLongLived();
    const file = previewsFile(projectDir);
    const e = entry({ previewId: 'pv-stubborn', pid: c.pid!, ownerPid: DEAD_PID });
    await registerPreview(file, e);
    const res = await sweepOrphanedPreviews(projectDir, {
      queryIdentity: () => Promise.resolve(matchingIdentity(e.command, e.createdAt)),
      kill: () => Promise.resolve({ verified: false, detail: 'stubborn' }),
    });
    expect(res.killFailed).toEqual([{ previewId: 'pv-stubborn', pid: c.pid!, detail: 'stubborn' }]);
    expect(loadPreviewRegistry(file)).toHaveLength(1);
  });

  it('a live-held registry lock yields lockUnavailable with nothing read or touched', async () => {
    const file = previewsFile(projectDir);
    await registerPreview(file, entry({ previewId: 'pv-x' }));
    fs.writeFileSync(registryLockFile(file), JSON.stringify({ pid: process.pid, token: 't', at: new Date().toISOString() }));
    // A live same-pid holder is never reclaimable; from a foreign-pid perspective use an isAlive
    // stub that says the holder lives.
    const res = await sweepOrphanedPreviews(projectDir, { isAlive: () => true });
    expect(res.lockUnavailable).toBe(true);
    fs.rmSync(registryLockFile(file), { force: true });
  }, 30_000);

  it('merge-on-save: a concurrent registration survives the sweep', async () => {
    const file = previewsFile(projectDir);
    await registerPreview(file, entry({ previewId: 'pv-dead1', pid: DEAD_PID }));
    const orphan = spawnLongLived();
    await registerPreview(file, entry({ previewId: 'pv-orphan2', pid: orphan.pid!, ownerPid: DEAD_PID }));
    // The identity query (fires for the live orphan) registers a NEW sibling entry mid-sweep.
    const live = spawnLongLived();
    const e2 = entry({ previewId: 'pv-live-new', pid: live.pid!, ownerPid: process.pid });
    const res = await sweepOrphanedPreviews(projectDir, {
      queryIdentity: async () => {
        await registerPreview(file, e2);
        return null; // orphan stays unverified (kept)
      },
    });
    expect(res.droppedDead).toEqual(['pv-dead1']);
    expect(res.skippedUnverified).toHaveLength(1);
    const after = loadPreviewRegistry(file)
      .map((e) => e.previewId)
      .sort();
    expect(after).toEqual(['pv-live-new', 'pv-orphan2']); // dead dropped; sibling + unverified survive
  });
});
