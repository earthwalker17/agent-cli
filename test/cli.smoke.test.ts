import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grantTrust } from '../src/trust/store.js';

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
  // Session-starting commands require workspace trust; the suite pre-records consent
  // through the real store (dedicated untrusted-refusal tests skip this seeding).
  grantTrust(state, ws, 'command');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ws,
    env: { ...process.env, AGENT_CLI_STATE_DIR: state },
    encoding: 'utf8',
    ...(input !== undefined ? { input } : {}),
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Events of the first (or only) session recorded for the suite's workspace. */
function sessionEvents(): { type: string; [k: string]: unknown }[] {
  const projects = path.join(state, 'projects');
  if (!fs.existsSync(projects)) return [];
  for (const slug of fs.readdirSync(projects)) {
    const dir = path.join(projects, slug, 'sessions');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) continue;
    return fs
      .readFileSync(path.join(dir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
  }
  return [];
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

  it('runs when invoked through a symlinked path (npm link bin shim)', () => {
    // npm link points the global bin at <prefix>/node_modules/agent-cli -> repo junction.
    // Node realpaths the main module's import.meta.url, so the entry guard must realpath
    // argv[1] too — without that the CLI exits silently with code 0 and no output (the
    // V0.2 defect this test pins).
    const linkRoot = path.join(tmp, 'node_modules');
    fs.mkdirSync(linkRoot, { recursive: true });
    const link = path.join(linkRoot, 'agent-cli');
    fs.symlinkSync(path.resolve('.'), link, 'junction');
    const r = spawnSync(process.execPath, [path.join(link, 'dist', 'cli', 'index.js'), '--help'], {
      cwd: ws,
      env: { ...process.env, AGENT_CLI_STATE_DIR: state },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
  });

  it('drives a full piped REPL session: real approver, clean stdout, user-quit', () => {
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(
      script,
      JSON.stringify([
        { calls: [{ name: 'run_command', input: { command: 'echo smoke' } }] },
        { say: 'finished' },
      ]),
    );
    const res = run(['--provider', 'mock', '--script', script, '--interactive'], 'do the thing\ny\n/quit\n');
    expect(res.code).toBe(0);
    // Stream purity: stdout is ONLY model text; every prompt/status line went to stderr.
    expect(res.stdout).toBe('finished\n');
    expect(res.stderr).toContain('agent session');

    const events = sessionEvents();
    expect(events.find((e) => e.type === 'session.started')).toMatchObject({ mode: 'interactive' });
    // The piped 'y' was consumed by the REAL interactive approver, not auto-deny.
    expect(events.find((e) => e.type === 'approval.resolved')).toMatchObject({ decision: 'allow', source: 'user' });
    expect(events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: 'user-quit' });
  });

  it('bare agent without a TTY prints usage instead of a REPL nobody watches', () => {
    const res = run([], '');
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Usage:/);
    // No REPL means no session was started at all.
    expect(sessionEvents()).toHaveLength(0);
  });

  it('--no-input with --interactive is a hard contradiction', () => {
    const res = run(['--no-input', '--interactive', 'task']);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/contradictory/);
  });

  it('refuses an untrusted workspace non-interactively with exit 3', () => {
    const other = path.join(tmp, 'untrusted-ws');
    fs.mkdirSync(other);
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, JSON.stringify([{ say: 'never reached' }]));
    const r = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'task'], {
      cwd: other,
      env: { ...process.env, AGENT_CLI_STATE_DIR: state },
      encoding: 'utf8',
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/not trusted/);
    // The refusal must not create per-project state for the untrusted folder.
    const projects = path.join(state, 'projects');
    const slugs = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
    expect(slugs.some((s) => s.startsWith('untrusted-ws'))).toBe(false);
  });

  it('--trust-this-workspace runs once without recording trust', () => {
    const other = path.join(tmp, 'once-ws');
    fs.mkdirSync(other);
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, JSON.stringify([{ say: 'ran once' }]));
    const once = spawnSync(
      process.execPath,
      [CLI, '--provider', 'mock', '--script', script, '--no-input', '--trust-this-workspace', 'task'],
      { cwd: other, env: { ...process.env, AGENT_CLI_STATE_DIR: state }, encoding: 'utf8' },
    );
    expect(once.status).toBe(0);
    // Not persisted: the same run WITHOUT the flag refuses again.
    const r2 = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'task'], {
      cwd: other,
      env: { ...process.env, AGENT_CLI_STATE_DIR: state },
      encoding: 'utf8',
    });
    expect(r2.status).toBe(3);
  });

  it('agent trust records consent; trust --revoke withdraws it', () => {
    const other = path.join(tmp, 'trust-cmd-ws');
    fs.mkdirSync(other);
    const env = { ...process.env, AGENT_CLI_STATE_DIR: state };
    const trust = spawnSync(process.execPath, [CLI, 'trust'], { cwd: other, env, encoding: 'utf8' });
    expect(trust.status).toBe(0);
    expect(trust.stdout).toMatch(/trusted:/);

    const list = spawnSync(process.execPath, [CLI, 'trust', '--list'], { cwd: other, env, encoding: 'utf8' });
    expect(list.stdout).toMatch(/trust-cmd-ws/);

    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, JSON.stringify([{ say: 'hello from trusted ws' }]));
    const r = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'task'], {
      cwd: other,
      env,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);

    const revoke = spawnSync(process.execPath, [CLI, 'trust', '--revoke'], { cwd: other, env, encoding: 'utf8' });
    expect(revoke.status).toBe(0);
    const r2 = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'task'], {
      cwd: other,
      env,
      encoding: 'utf8',
    });
    expect(r2.status).toBe(3);
  });
});
