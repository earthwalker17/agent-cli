import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('dist/cli/index.js');
const hasBuild = fs.existsSync(CLI);
const d = hasBuild ? describe : describe.skip;

let tmp: string;
let ws: string;
let state: string;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-cli-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws,
    env: { ...process.env, AGENT_CLI_STATE_DIR: state },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

d('CLI end-to-end via the built binary', () => {
  it('runs a scripted task, writes a file, and reports it', () => {
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(
      script,
      JSON.stringify([
        { say: 'creating', calls: [{ name: 'write_file', input: { path: 'hello.txt', content: 'hi there' } }] },
        { say: 'all done' },
      ]),
    );
    const res = run(['--provider', 'mock', '--script', script, '--no-input', 'create hello.txt']);
    expect(res.code).toBe(0);
    expect(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8')).toBe('hi there');
    expect(res.stdout).toMatch(/all done/);
    expect(res.stdout).toMatch(/1 file\(s\) changed/);
  });

  it('report --json emits a parseable evidence object', () => {
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, JSON.stringify([{ say: 'noop' }]));
    run(['--provider', 'mock', '--script', script, '--no-input', 'do nothing']);
    const res = run(['report', '--json']);
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout);
    expect(json.session.providerName).toBe('mock');
    expect(json.tasks).toContain('do nothing');
  });

  it('auto-denies a shell command in non-interactive mode and exits 2', () => {
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(
      script,
      JSON.stringify([{ calls: [{ name: 'run_command', input: { command: 'echo hi' } }] }, { say: 'blocked' }]),
    );
    const res = run(['--provider', 'mock', '--script', script, '--no-input', 'try a command']);
    expect(res.code).toBe(2);
  });

  it('undo reverts a written file', () => {
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(
      script,
      JSON.stringify([{ calls: [{ name: 'write_file', input: { path: 'gen.txt', content: 'generated' } }] }, { say: 'done' }]),
    );
    run(['--provider', 'mock', '--script', script, '--no-input', 'generate a file']);
    expect(fs.existsSync(path.join(ws, 'gen.txt'))).toBe(true);
    const res = run(['undo']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/restored/);
    expect(fs.existsSync(path.join(ws, 'gen.txt'))).toBe(false);
  });

  it('map lists workspace files', () => {
    fs.writeFileSync(path.join(ws, 'a.ts'), '');
    const res = run(['map']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/a\.ts/);
  });

  it('sessions lists prior runs with status', () => {
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, JSON.stringify([{ say: 'hi' }]));
    run(['--provider', 'mock', '--script', script, '--no-input', 'say hi']);
    const res = run(['sessions']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/\[completed\]/);
    expect(res.stdout).toMatch(/say hi/);
  });

  it('--help prints usage and the security note', () => {
    const res = run(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/NO OS sandbox/);
  });
});
