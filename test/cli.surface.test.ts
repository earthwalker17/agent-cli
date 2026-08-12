import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grantTrust } from '../src/trust/store.js';
import { trustPrompt } from '../src/trust/gate.js';
import { misdispatchGuard } from '../src/cli/index.js';

/**
 * Session 21.5 — the process-level surface fixes from the interaction audit.
 *
 * Each of these is a case where two spellings of the same operation disagreed, or where a
 * documented guarantee did not hold. The theme: `/x` and `agent x` are presented to users as one
 * surface, so any asymmetry between them is a defect, not a feature.
 */

const CLI = path.resolve('dist/cli/index.js');
const hasBuild = fs.existsSync(CLI);
const d = hasBuild ? describe : describe.skip;

let tmp: string;
let ws: string;
let state: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-surface-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
  grantTrust(state, ws, 'command');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runIn(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, AGENT_CLI_STATE_DIR: state },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
const run = (args: string[]): { code: number; stdout: string; stderr: string } => runIn(ws, args);

function scriptWriting(file: string, content: string): string {
  const script = path.join(tmp, `script-${path.basename(file)}.json`);
  fs.writeFileSync(
    script,
    JSON.stringify([{ say: 'writing', calls: [{ name: 'write_file', input: { path: file, content } }] }, { say: 'done' }]),
  );
  return script;
}

// ── the trust prompt's options line must describe what the caller can honour ─────────────────

describe('trustPrompt options line (S21.5)', () => {
  it('the session gate offers proceed-once', () => {
    const p = trustPrompt('C:\\demo');
    expect(p).toContain('[t] trust and remember');
    expect(p).toContain('[o] proceed once (not recorded)');
  });

  it('`agent trust` does NOT offer proceed-once, because it cannot honour it', () => {
    const p = trustPrompt('C:\\demo', { offerOnce: false });
    expect(p).toContain('[t] trust and remember');
    expect(p).not.toContain('[o] proceed once');
    expect(p).toContain('[anything else] cancel');
  });

  it('both forms carry the honest sandbox disclaimer', () => {
    for (const p of [trustPrompt('C:\\demo'), trustPrompt('C:\\demo', { offerOnce: false })]) {
      expect(p).toContain('Trust is recorded consent, NOT a sandbox.');
    }
  });
});

describe('misdispatchGuard — a typo must not cost money (S21.5)', () => {
  it('refuses a slash command typed at the shell and points at the REPL', () => {
    for (const w of ['status', 'accept', 'checks', 'review', 'repair', 'preview', 'tasks', 'remote']) {
      const msg = misdispatchGuard(w);
      expect(msg, w).toContain('is an in-session command');
      expect(msg, w).toContain(`/${w}`);
      expect(msg, w).toContain(`agent run "${w}"`);
    }
  });

  it('refuses a near-miss of a real subcommand', () => {
    expect(misdispatchGuard('reprot')).toContain('agent report');
    expect(misdispatchGuard('sesions')).toContain('agent sessions');
    expect(misdispatchGuard('comit')).toContain('agent commit');
  });

  it('refuses a near-miss of a SLASH command too — the case that used to bill', () => {
    // `agent stauts` started a real, paid one-shot session with the task string "stauts".
    expect(misdispatchGuard('stauts')).toContain('/status');
    expect(misdispatchGuard('accpet')).toContain('/accept');
  });

  it('leaves genuine tasks alone', () => {
    expect(misdispatchGuard('fix the parser')).toBeNull();
    expect(misdispatchGuard('refactor')).toBeNull();
    expect(misdispatchGuard('add a --json flag to the exporter')).toBeNull();
    // Multi-word wins even when it starts with a command name.
    expect(misdispatchGuard('status of the build is broken')).toBeNull();
  });
});

d('the typo guard end to end (S21.5)', () => {
  it('creates NO session and exits non-zero', () => {
    const other = path.join(tmp, 'typo-ws');
    fs.mkdirSync(other);
    const script = scriptWriting('x.txt', 'x\n');
    const r = spawnSync(
      process.execPath,
      [CLI, '--provider', 'mock', '--script', script, '--no-input', '--trust-this-workspace', 'stauts'],
      { cwd: other, env: { ...process.env, AGENT_CLI_STATE_DIR: state }, encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did you mean/);
    const projects = path.join(state, 'projects');
    const slugs = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
    expect(slugs.some((s) => s.startsWith('typo-ws'))).toBe(false);
  });

  it('agent run forces the same string through as a task', () => {
    const script = scriptWriting('forced.txt', 'forced\n');
    const r = run(['--provider', 'mock', '--script', script, '--no-input', 'run', 'stauts']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(ws, 'forced.txt'))).toBe(true);
  });
});

d('agent undo is trust-gated (S21.5)', () => {
  it('refuses with exit 3 in an untrusted workspace, and restores nothing', () => {
    const other = path.join(tmp, 'untrusted-undo-ws');
    fs.mkdirSync(other);
    // Create a real session (and a real file change) WITHOUT recording trust.
    const script = scriptWriting('note.txt', 'v1\n');
    const seeded = spawnSync(
      process.execPath,
      [CLI, '--provider', 'mock', '--script', script, '--no-input', '--trust-this-workspace', 'write note'],
      { cwd: other, env: { ...process.env, AGENT_CLI_STATE_DIR: state }, encoding: 'utf8' },
    );
    expect(seeded.status).toBe(0);
    expect(fs.readFileSync(path.join(other, 'note.txt'), 'utf8')).toBe('v1\n');

    // `agent undo` WRITES to the workspace. Before S21.5 it ran ungated.
    const r = runIn(other, ['undo']);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/not trusted/);
    expect(fs.readFileSync(path.join(other, 'note.txt'), 'utf8')).toBe('v1\n');
  });

  it('still works in a trusted workspace', () => {
    const script = scriptWriting('note.txt', 'v1\n');
    expect(run(['--provider', 'mock', '--script', script, '--no-input', 'write note']).code).toBe(0);
    const r = run(['undo']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/restored/);
    expect(fs.existsSync(path.join(ws, 'note.txt'))).toBe(false);
  });
});

d('agent diff honours secretPatterns exactly as /diff does (S21.5)', () => {
  it('withholds the body of a file made secret-like by workspace config', () => {
    fs.mkdirSync(path.join(ws, '.agent-cli'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agent-cli', 'config.json'), JSON.stringify({ secretPatterns: ['vault'] }));

    const script = scriptWriting('vault.txt', 'super-secret-token-value\n');
    expect(run(['--provider', 'mock', '--script', script, '--no-input', 'write the vault']).code).toBe(0);

    const r = run(['diff']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('contents withheld: secret-named file');
    // The whole point: the body must not reach a terminal that gets pasted into issues.
    expect(r.stdout).not.toContain('super-secret-token-value');
  });

  it('a file with no matching pattern still shows its body', () => {
    const script = scriptWriting('ordinary.txt', 'nothing-sensitive-here\n');
    expect(run(['--provider', 'mock', '--script', script, '--no-input', 'write it']).code).toBe(0);
    expect(run(['diff']).stdout).toContain('nothing-sensitive-here');
  });

  it('built-in secret names are withheld with or without config', () => {
    const script = scriptWriting('.env', 'API_KEY=zzz-do-not-print\n');
    expect(run(['--provider', 'mock', '--script', script, '--no-input', 'write env']).code).toBe(0);
    const r = run(['diff']);
    expect(r.stdout).toContain('contents withheld: secret-named file');
    expect(r.stdout).not.toContain('zzz-do-not-print');
  });

  it('a rejected config refuses the diff rather than printing it unredacted', () => {
    fs.mkdirSync(path.join(ws, '.agent-cli'), { recursive: true });
    const script = scriptWriting('vault.txt', 'super-secret-token-value\n');
    expect(run(['--provider', 'mock', '--script', script, '--no-input', 'write the vault']).code).toBe(0);
    // Break the config only AFTER the session exists, so the failure is the diff's own.
    fs.writeFileSync(path.join(ws, '.agent-cli', 'config.json'), '{ not json');

    const r = run(['diff']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/refusing to print a diff/);
    expect(r.stdout).not.toContain('super-secret-token-value');
  });
});
