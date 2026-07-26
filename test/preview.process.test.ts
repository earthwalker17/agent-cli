import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSupervised, readTail } from '../src/preview/process.js';
import { shellInvocation } from '../src/exec/shell.js';
import { expectedCommandLineToken, identityMatches, queryProcessIdentity } from '../src/preview/identity.js';
import { isAlive } from '../src/exec/kill.js';
import type { SupervisedHandle } from '../src/preview/types.js';

/**
 * The supervised runner (Session 13): real child processes, no mocks. These pins cover the
 * contracts everything above builds on — fd-based file logging, first-cause stop reasons,
 * typed TTL / log-overflow stops, and death observability.
 */

const NODE = process.execPath;
let tmp: string;
let handles: SupervisedHandle[];

const logPath = (): string => path.join(tmp, `p-${Math.random().toString(16).slice(2)}.log`);

/** A child that prints a line every `everyMs` and never exits on its own. */
const chatty = (everyMs: number): { file: string; args: string[] } => ({
  file: NODE,
  args: ['-e', `setInterval(() => console.log('tick ' + Date.now()), ${everyMs});`],
});

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-prevproc-')));
  handles = [];
});

afterEach(async () => {
  for (const h of handles) {
    if (h.isAlive()) await h.stop('stopped');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('startSupervised', () => {
  it('spawns, logs to the file (not a pipe), and tail() reads the recent bytes', async () => {
    const log = logPath();
    const h = await startSupervised({ ...chatty(25), cwd: tmp, env: { ...(process.env as Record<string, string>) }, logFile: log, ttlMs: 0 });
    handles.push(h);
    expect(h.pid).toBeGreaterThan(0);
    expect(h.isAlive()).toBe(true);
    await until(() => fs.existsSync(log) && fs.statSync(log).size > 20);
    expect(h.tail()).toContain('tick');
    const r = await h.stop('stopped');
    expect(r.ok).toBe(true);
  }, 30_000);

  it('stop() records the first-cause reason and the process is verifiably dead', async () => {
    const h = await startSupervised({ ...chatty(50), cwd: tmp, env: { ...(process.env as Record<string, string>) }, logFile: logPath(), ttlMs: 0 });
    handles.push(h);
    const r = await h.stop('session-end');
    expect(r.ok).toBe(true);
    const exit = await h.exited;
    expect(exit.requestedStop).toBe('session-end');
    expect(h.isAlive()).toBe(false);
    expect(isAlive(h.pid)).toBe(false);
    // A later stop with a different reason observes the first result; the reason does not change.
    const again = await h.stop('stopped');
    expect(again.ok).toBe(true);
    expect((await h.exited).requestedStop).toBe('session-end');
  }, 30_000);

  it('a natural death resolves exited with requestedStop null and the real exit code', async () => {
    const h = await startSupervised({
      file: NODE,
      args: ['-e', 'setTimeout(() => process.exit(3), 100);'],
      cwd: tmp,
      env: { ...(process.env as Record<string, string>) },
      logFile: logPath(),
      ttlMs: 0,
    });
    handles.push(h);
    const exit = await h.exited;
    expect(exit.requestedStop).toBeNull();
    expect(exit.exitCode).toBe(3);
    // stop() after a natural death is honest: nothing was killed.
    expect((await h.stop('stopped')).detail).toBe('already exited');
    expect((await h.exited).requestedStop).toBeNull();
  }, 30_000);

  it('the TTL stops the process with the typed reason', async () => {
    const h = await startSupervised({ ...chatty(50), cwd: tmp, env: { ...(process.env as Record<string, string>) }, logFile: logPath(), ttlMs: 400 });
    handles.push(h);
    const exit = await h.exited;
    expect(exit.requestedStop).toBe('ttl-timeout');
  }, 30_000);

  it('exceeding the log cap stops the process with reason log-overflow', async () => {
    const h = await startSupervised({
      ...chatty(5),
      cwd: tmp,
      env: { ...(process.env as Record<string, string>) },
      logFile: logPath(),
      ttlMs: 0,
      maxLogBytes: 256,
      logPollMs: 50,
    });
    handles.push(h);
    const exit = await h.exited;
    expect(exit.requestedStop).toBe('log-overflow');
  }, 30_000);

  it('a spawn failure rejects (the caller decides what a failed start means)', async () => {
    await expect(
      startSupervised({
        file: path.join(tmp, 'no-such-binary-xyz.exe'),
        args: [],
        cwd: tmp,
        env: { ...(process.env as Record<string, string>) },
        logFile: logPath(),
        ttlMs: 0,
      }),
    ).rejects.toThrow();
  }, 30_000);
});

describe('readTail', () => {
  it('returns the last bytes only, and empty string for a missing file', () => {
    const f = logPath();
    fs.writeFileSync(f, 'A'.repeat(100) + 'THE-END');
    expect(readTail(f, 7)).toBe('THE-END');
    expect(readTail(path.join(tmp, 'missing.log'), 64)).toBe('');
  });
});

const winDescribe = process.platform === 'win32' ? describe : describe.skip;
winDescribe('process identity (real Windows CIM round trip)', () => {
  it('a shellInvocation-spawned child is identity-verifiable via the -EncodedCommand token', async () => {
    // The pin behind the sweep's kill safety: the recorded plaintext command NEVER appears in
    // Win32_Process.CommandLine — the re-derived encoded form is what must match.
    const command = 'node -e "setInterval(function(){}, 1000)"';
    const inv = shellInvocation(command);
    const createdAt = new Date().toISOString();
    const h = await startSupervised({
      file: inv.file,
      args: inv.args,
      cwd: tmp,
      env: { ...(process.env as Record<string, string>) },
      logFile: logPath(),
      ttlMs: 0,
    });
    handles.push(h);
    const identity = await queryProcessIdentity(h.pid);
    expect(identity).not.toBeNull();
    const token = expectedCommandLineToken(command);
    expect(token.length).toBeGreaterThan(20);
    expect(identity!.commandLine).not.toContain('setInterval'); // plaintext absent — the whole point
    expect(identity!.commandLine).toContain(token);
    expect(identityMatches(identity!, token, createdAt)).toBe(true);
    // A different command's token must NOT match (the innocent-process case).
    expect(identityMatches(identity!, expectedCommandLineToken('node other.js'), createdAt)).toBe(false);
  }, 60_000);
});
