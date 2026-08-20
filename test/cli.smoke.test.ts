import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grantTrust } from '../src/trust/store.js';
import { writeCanonicalPlan, setCanonicalStatus } from '../src/plan/canonical.js';
import { PlanGraphSchema } from '../src/plan/schema.js';
import { resolveLayout } from '../src/store/layout.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import { fixedClock } from '../src/shared/clock.js';

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
      // A piped command is never auto-runnable (metacharacter) → it asks → non-interactive auto-denies.
      JSON.stringify([{ calls: [{ name: 'run_command', input: { command: 'echo hi | findstr hi' } }] }, { say: 'blocked' }]),
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

  it('--help prints usage and the honest security note', () => {
    const res = run(['--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Low integrity/);
    expect(res.stdout).toMatch(/fail closed/);
  });

  it('`agent providers` lists the catalog with env NAMES only and NEVER starts a session (Session 15)', () => {
    const res = run(['providers']);
    expect(res.code).toBe(0);
    for (const name of ['anthropic', 'openai', 'deepseek', 'kimi', 'glm']) expect(res.stdout).toContain(name);
    expect(res.stdout).toContain('DEEPSEEK_API_KEY');
    expect(res.stdout).toContain('get a key:');
    expect(res.stdout).toContain('catalog verified');
    // Env var NAMES and presence only — never a value. Deterministic canary (S15 review
    // finding): the old assertion was conditional on the DEV MACHINE having a real key, so on a
    // keyless CI runner — the release gate — it silently checked nothing.
    const canary = 'sk-canary-DO-NOT-PRINT';
    const withKey = spawnSync(process.execPath, [CLI, 'providers'], {
      cwd: ws,
      env: { ...process.env, AGENT_CLI_STATE_DIR: state, DEEPSEEK_API_KEY: canary },
      encoding: 'utf8',
    });
    expect(withKey.status).toBe(0);
    expect(withKey.stdout).toContain('DEEPSEEK_API_KEY'); // the NAME is shown…
    expect(withKey.stdout).not.toContain(canary); // …the VALUE never is
    expect(sessionEvents()).toEqual([]); // read-only: no session log was ever created

    const asJson = run(['providers', '--json']);
    expect(asJson.code).toBe(0);
    const parsed = JSON.parse(asJson.stdout) as { providers: { name: string; models: unknown[] }[] };
    expect(parsed.providers).toHaveLength(5);
    expect(parsed.providers.every((p) => p.models.length > 0)).toBe(true);
    expect(sessionEvents()).toEqual([]);
  });

  it('--version and `agent version` print the package version and NEVER start a session', () => {
    // Regression pin: before 'version'/'help' joined KNOWN, the unknown-positional fallthrough
    // started a REAL one-shot agent session with the literal task string "version".
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
    for (const args of [['--version'], ['version'], ['help']]) {
      const res = run(args);
      expect(res.code).toBe(0);
      if (args[0] === 'help') expect(res.stdout).toMatch(/Usage:/);
      else expect(res.stdout.trim()).toBe(`agent-cli ${pkg.version}`);
      expect(sessionEvents()).toEqual([]); // no session log was ever created
    }
    // The usage header carries the live version, not a hardcoded stamp.
    expect(run(['--help']).stdout).toContain(`Agent CLI v${pkg.version}`);
  });

  it('agent plan <id> reads a CANONICAL plan through the one reader: real status, content sha, approval state', async () => {
    // Regression pin: cmdPlan read only the legacy markdown store for three sessions after the
    // canonical format shipped, so every modern plan printed "status: unknown" and a raw-file
    // sha instead of its approval state.
    const sid = '20260728-000000-planpin';
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state }, ensure: true });
    const snapshots = new SnapshotStore(layout.objectsDir);
    const graph = PlanGraphSchema.parse({
      objective: 'ship the pinned feature',
      tasks: [{ id: 't1', title: 'core', intent: 'build', role: 'executor', verify: 'tests pass', touches: ['src'] }],
    });
    const w = await writeCanonicalPlan(layout, sid, graph, snapshots, fixedClock(Date.UTC(2026, 6, 28), 1000));
    if ('error' in w) throw new Error(w.error);
    await setCanonicalStatus(layout, sid, 'approved', snapshots);
    const line = (seq: number, body: Record<string, unknown>): string => JSON.stringify({ v: 1, seq, ts: '2026-07-28T00:00:00.000Z', ...body });
    fs.writeFileSync(
      layout.sessionFile(sid),
      [
        line(1, { type: 'session.started', sessionId: sid, workspaceRoot: ws, model: 'mock', mode: 'confirm' }),
        line(2, { type: 'plan.approved', sha256: w.contentSha }),
        line(3, { type: 'session.ended', reason: 'user-quit' }),
      ].join('\n') + '\n',
    );
    const res = run(['plan', sid]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('canonical task graph · status: approved');
    expect(res.stderr).toContain(`content sha: ${w.contentSha}`);
    expect(res.stderr).toContain('executor gate: open (approved and current)');
    expect(res.stdout).toContain('ship the pinned feature');
    expect(res.stderr).not.toContain('status: unknown');
  });

  it('count flags refuse non-numeric values loudly instead of becoming NaN', () => {
    // Regression pin: NaN maxSteps made `stepsUsed >= maxSteps` false-shaped comparisons end
    // every turn after ZERO steps — the task "ran" and did nothing, with no error anywhere.
    const bad = run(['--max-turns', 'abc', 'do nothing']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/--max-turns requires a positive integer/);
    expect(sessionEvents()).toEqual([]); // refused before any session existed

    const conflict = run(['--max-steps', '5', '--max-turns', '6', 'do nothing']);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toMatch(/aliases for the same limit/);

    const budget = run(['map', '--budget', 'abc']);
    expect(budget.code).toBe(1);
    expect(budget.stderr).toMatch(/--budget requires a positive integer/);
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
        // Piped → always asks; the real interactive approver consumes the piped 'y'.
        { calls: [{ name: 'run_command', input: { command: 'echo smoke | findstr smoke' } }] },
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
    const res = run(['--no-input', '--interactive', 'do the task']);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/contradictory/);
  });

  it('refuses an untrusted workspace non-interactively with exit 3', () => {
    const other = path.join(tmp, 'untrusted-ws');
    fs.mkdirSync(other);
    const script = path.join(tmp, 'script.json');
    fs.writeFileSync(script, JSON.stringify([{ say: 'never reached' }]));
    const r = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'do the task'], {
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
      [CLI, '--provider', 'mock', '--script', script, '--no-input', '--trust-this-workspace', 'do the task'],
      { cwd: other, env: { ...process.env, AGENT_CLI_STATE_DIR: state }, encoding: 'utf8' },
    );
    expect(once.status).toBe(0);
    // Not persisted: the same run WITHOUT the flag refuses again.
    const r2 = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'do the task'], {
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
    const r = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'do the task'], {
      cwd: other,
      env,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);

    const revoke = spawnSync(process.execPath, [CLI, 'trust', '--revoke'], { cwd: other, env, encoding: 'utf8' });
    expect(revoke.status).toBe(0);
    const r2 = spawnSync(process.execPath, [CLI, '--provider', 'mock', '--script', script, '--no-input', 'do the task'], {
      cwd: other,
      env,
      encoding: 'utf8',
    });
    expect(r2.status).toBe(3);
  });
});
