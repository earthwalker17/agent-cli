import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { buildChildEnv, DEFAULT_ENV_EXCLUDE_SUBSTRINGS } from '../src/exec/env.js';
import { killTree, isAlive, runHelper } from '../src/exec/kill.js';

describe('buildChildEnv', () => {
  it('drops variables whose names look secret-like, case-insensitively', () => {
    const env = buildChildEnv({
      FAKE_API_KEY: 'a',
      my_secret: 'b',
      GH_TOKEN: 'c',
      Db_Password: 'd',
      X_CREDENTIAL: 'e',
      SAFE_VAR: 'keep',
    });
    expect(env['FAKE_API_KEY']).toBeUndefined();
    expect(env['my_secret']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['Db_Password']).toBeUndefined();
    expect(env['X_CREDENTIAL']).toBeUndefined();
    expect(env['SAFE_VAR']).toBe('keep');
  });

  it('covers every default exclude substring', () => {
    for (const sub of DEFAULT_ENV_EXCLUDE_SUBSTRINGS) {
      const name = `X_${sub.toUpperCase()}_X`;
      expect(buildChildEnv({ [name]: 'v' })[name]).toBeUndefined();
    }
  });

  it('always keeps the core floor, even when excludes would match', () => {
    const env = buildChildEnv(
      { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', PATH: 'p', PATHEXT: '.EXE', TEMP: 't' },
      { extraExcludeSubstrings: ['path', 'temp', 'systemroot', 'windir'] },
    );
    expect(env['SystemRoot']).toBe('C:\\Windows');
    expect(env['windir']).toBe('C:\\Windows');
    expect(env['PATH']).toBe('p');
    expect(env['PATHEXT']).toBe('.EXE');
    expect(env['TEMP']).toBe('t');
  });

  it('config extras drop additional names but never the proxy variables', () => {
    const env = buildChildEnv(
      { HTTPS_PROXY: 'http://user:pw@127.0.0.1:7897/', MY_PROXY_LIST: 'x', CUSTOM_CREDENTIALS: 'y' },
      { extraExcludeSubstrings: ['proxy'] },
    );
    expect(env['HTTPS_PROXY']).toBe('http://user:pw@127.0.0.1:7897/');
    expect(env['MY_PROXY_LIST']).toBeUndefined();
    expect(env['CUSTOM_CREDENTIALS']).toBeUndefined();
  });

  it('dedupes names case-insensitively, lexicographically-first wins (Node child-env rule)', () => {
    const env = buildChildEnv({ Path: 'lower', PATH: 'upper' });
    const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
    expect(keys).toEqual(['PATH']);
    expect(env['PATH']).toBe('upper');
  });

  it('skips undefined values and injects the AGENT_CLI marker', () => {
    const env = buildChildEnv({ UNSET: undefined, SET: 'v' });
    expect('UNSET' in env).toBe(false);
    expect(env['SET']).toBe('v');
    expect(env['AGENT_CLI']).toBe('1');
  });
});

describe('killTree / isAlive', () => {
  it('isAlive is true for this process and false for a exited child', async () => {
    expect(isAlive(process.pid)).toBe(true);
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    const pid = child.pid!;
    await new Promise<void>((r) => child.on('exit', () => r()));
    // exit fired; give the OS a beat to reap, then probe (bounded).
    for (let i = 0; i < 20 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(pid)).toBe(false);
  });

  it('kills a live child and verifies death', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const pid = child.pid!;
    expect(isAlive(pid)).toBe(true);
    const r = await killTree(pid);
    expect(r.verified).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect(r.detail).toMatch(/probe: dead/);
  });

  it('S20.5: a wedged kill helper cannot hang the caller — the exit wait is bounded', async () => {
    // runHelper awaited the helper's exit with NO bound, and run.ts's settle path awaits the
    // in-flight killTree — so a wedged taskkill hung the ExecOutcome promise forever, with
    // abort a no-op once killedFor was set. The helper wait now carries a bound (the same one
    // preview/process.ts already applied to the same call).
    const t0 = Date.now();
    const code = await runHelper(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 400);
    expect(code).toBeNull(); // outlived the bound → best-effort killed, resolved null
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('treats killing an already-exited pid as success (taskkill 128 contract)', async () => {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    const pid = child.pid!;
    await new Promise<void>((r) => child.on('exit', () => r()));
    for (let i = 0; i < 20 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    const r = await killTree(pid);
    expect(r.verified).toBe(true);
    if (process.platform === 'win32') expect(r.detail).toMatch(/128|exit \d/);
  });
});
