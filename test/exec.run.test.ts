import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runManaged, type ExecSpec } from '../src/exec/run.js';
import { buildChildEnv } from '../src/exec/env.js';
import { isAlive, killTree } from '../src/exec/kill.js';

/**
 * All fixtures spawn Node itself (process.execPath -e …): fast, quoting-safe without a shell,
 * and identical on every platform. Kill/drain assertions use bounded polls, never fixed sleeps.
 */

let tmp: string;
const leaked: number[] = [];
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-exec-')));
});
afterEach(async () => {
  for (const pid of leaked.splice(0)) if (isAlive(pid)) await killTree(pid);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function spec(script: string, extra: Partial<ExecSpec> = {}): ExecSpec {
  return {
    file: process.execPath,
    args: ['-e', script],
    cwd: tmp,
    env: buildChildEnv(process.env),
    timeoutMs: 30_000,
    ...extra,
  };
}

async function waitDead(pid: number, attempts = 40): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

describe('runManaged basics', () => {
  it('propagates a real exit code', async () => {
    const r = await runManaged(spec('process.exit(3)'));
    expect(r.termination).toBe('exited');
    expect(r.exitCode).toBe(3);
  });

  it('a throwing onSpawn observer never crashes the run (guarded evidence channel)', async () => {
    const r = await runManaged(
      spec(`console.log('survived')`, {
        onSpawn: () => {
          throw new Error('observer boom');
        },
      }),
    );
    expect(r.termination).toBe('exited');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/survived/);
  });

  it('live-preview decode is stateful: a rune split across chunks arrives intact', async () => {
    const chunks: string[] = [];
    // 'é' = 0xC3 0xA9: write the bytes in two flushes 80ms apart — two data events, split mid-rune.
    const script =
      `const b = Buffer.from([0xc3, 0xa9]);` +
      `process.stdout.write(b.subarray(0, 1));` +
      `setTimeout(() => process.stdout.write(b.subarray(1)), 80);`;
    const r = await runManaged(spec(script, { onOutput: (c) => chunks.push(c) }));
    expect(r.termination).toBe('exited');
    expect(chunks.join('')).toContain('é');
    for (const c of chunks) expect(c).not.toContain('�'); // no replacement chars in the preview
    expect(r.stdout).toContain('é'); // the captured result was already decode-once correct
  });

  it('captures stdout and stderr separately and interleaved', async () => {
    const r = await runManaged(spec(`console.log('to-out'); console.error('to-err');`));
    expect(r.termination).toBe('exited');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/to-out/);
    expect(r.stdout).not.toMatch(/to-err/);
    expect(r.stderr).toMatch(/to-err/);
    expect(r.combined).toMatch(/to-out/);
    expect(r.combined).toMatch(/to-err/);
  });

  it('reports spawn failure as spawn-error', async () => {
    const r = await runManaged({ ...spec(''), file: 'definitely-not-a-real-binary-xyz' });
    expect(r.termination).toBe('spawn-error');
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toMatch(/failed to spawn/);
  });

  it('returns aborted immediately (no spawn) for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    let spawnedPid: number | undefined;
    const r = await runManaged(spec(`console.log('x')`, { signal: controller.signal, onSpawn: (p) => (spawnedPid = p) }));
    expect(r.termination).toBe('aborted');
    expect(spawnedPid).toBeUndefined();
  });

  it('caps captured output head+tail and flags truncation', async () => {
    const r = await runManaged(
      spec(`for (let i = 0; i < 400; i++) console.log('L' + i + '-' + 'x'.repeat(64))`, { maxCaptureBytes: 4096 }),
    );
    expect(r.termination).toBe('exited');
    expect(r.captureTruncated).toBe(true);
    expect(r.stdout).toMatch(/L0-/); // head preserved
    expect(r.stdout).toMatch(/L399-/); // tail preserved
    expect(r.stdout).toMatch(/output capture truncated/);
  });
});

describe('runManaged kill paths', () => {
  it('kills on timeout: no exit code, verified killDetail', async () => {
    let pid: number | undefined;
    const r = await runManaged(spec('setInterval(() => {}, 1000)', { timeoutMs: 300, onSpawn: (p) => (pid = p) }));
    if (pid !== undefined) leaked.push(pid);
    expect(r.termination).toBe('timeout');
    expect(r.exitCode).toBeNull();
    expect(r.killDetail).toMatch(/probe: dead/);
    expect(pid).toBeDefined();
    expect(await waitDead(pid!)).toBe(true);
  }, 30000);

  it('kills on abort, triggered by observed output (event-driven, no sleeps)', async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    const r = await runManaged(
      spec(`console.log('started'); setInterval(() => {}, 1000)`, {
        signal: controller.signal,
        onSpawn: (p) => (pid = p),
        onOutput: (chunk) => {
          if (chunk.includes('started')) controller.abort();
        },
      }),
    );
    if (pid !== undefined) leaked.push(pid);
    expect(r.termination).toBe('aborted');
    expect(r.exitCode).toBeNull();
    expect(await waitDead(pid!)).toBe(true);
  }, 30000);

  // POSIX tree-kill (process-group kill of a non-detached child) is a recorded open item — see
  // the ROADMAP deferred pool; this pins the Windows taskkill /T contract only.
  it.runIf(process.platform === 'win32')('tree-kill: aborting the parent also kills the grandchild', async () => {
    const controller = new AbortController();
    let parentPid: number | undefined;
    let gcPid: number | undefined;
    let buf = '';
    // detached: the grandchild escapes the intermediate parent's libuv job object, so only OUR
    // taskkill /T (walking the still-intact parent chain) can be what kills it.
    const script = `
      const cp = require('child_process');
      const c = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
      c.unref();
      console.log('GC:' + c.pid);
      setInterval(() => {}, 1000);
    `;
    const r = await runManaged(
      spec(script, {
        signal: controller.signal,
        onSpawn: (p) => (parentPid = p),
        onOutput: (chunk) => {
          buf += chunk;
          const m = buf.match(/GC:(\d+)/);
          if (m && gcPid === undefined) {
            gcPid = Number(m[1]);
            leaked.push(gcPid);
            controller.abort();
          }
        },
      }),
    );
    if (parentPid !== undefined) leaked.push(parentPid);
    expect(r.termination).toBe('aborted');
    expect(gcPid).toBeDefined();
    expect(await waitDead(parentPid!)).toBe(true);
    expect(await waitDead(gcPid!)).toBe(true);
  }, 45000);

  it('a late abort during the post-exit drain window does NOT relabel a completed command', async () => {
    // The command exits 0 on its own, but a pipe-holding grandchild keeps 'close' from firing, so
    // the outcome sits in the drain window. An abort that lands THERE must not fabricate a kill or
    // destroy the real exit code (the evidence-falsification race caught in review).
    const controller = new AbortController();
    let gcPid: number | undefined;
    let buf = '';
    const script = `
      const cp = require('child_process');
      const c = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      c.unref();
      console.log('GC:' + c.pid);
      process.exit(0);
    `;
    const r = await runManaged(
      spec(script, {
        drainTimeoutMs: 2000,
        signal: controller.signal,
        onOutput: (chunk) => {
          buf += chunk;
          const m = buf.match(/GC:(\d+)/);
          if (m && gcPid === undefined) {
            gcPid = Number(m[1]);
            leaked.push(gcPid);
            // Fire the abort AFTER the parent has certainly exited but well within the 2s drain.
            setTimeout(() => controller.abort(), 400);
          }
        },
      }),
    );
    expect(r.termination).toBe('exited'); // NOT 'aborted'
    expect(r.exitCode).toBe(0); // real exit code preserved, not nulled
    expect(r.drainTimedOut).toBe(true);
  }, 30000);

  it('drain regression: a pipe-holding grandchild cannot hang the outcome (#21960 class)', async () => {
    let gcPid: number | undefined;
    let buf = '';
    // Parent starts a grandchild that INHERITS the stdout/stderr pipes, then exits immediately.
    // 'close' cannot fire while the grandchild lives; the bounded drain must settle the outcome.
    // detached: outside the intermediate parent's libuv kill-on-close job, so it SURVIVES the
    // parent's exit while holding the inherited pipe handles — the real-world hang scenario.
    const script = `
      const cp = require('child_process');
      const c = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
      c.unref(); // the parent must be able to exit while the grandchild lives (and holds our pipes)
      console.log('GC:' + c.pid);
    `;
    const started = Date.now();
    const r = await runManaged(
      spec(script, {
        drainTimeoutMs: 500,
        onOutput: (chunk) => {
          buf += chunk;
          const m = buf.match(/GC:(\d+)/);
          if (m && gcPid === undefined) {
            gcPid = Number(m[1]);
            leaked.push(gcPid);
          }
        },
      }),
    );
    const wall = Date.now() - started;
    expect(r.termination).toBe('exited');
    expect(r.exitCode).toBe(0);
    expect(r.drainTimedOut).toBe(true);
    expect(wall).toBeLessThan(10_000); // generous ceiling; the failure mode is a 30s+ hang
    expect(gcPid).toBeDefined();
    expect(isAlive(gcPid!)).toBe(true); // the grandchild genuinely outlived the parent (fixture is real)
  }, 30000);
});
