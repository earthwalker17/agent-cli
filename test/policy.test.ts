import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { decide, Grants, classifyCommand, isSecretName, escalateOnSnapshotFailure } from '../src/policy/engine.js';
import type { Tool, ToolContext } from '../src/types.js';

let tmp: string;
let ctx: ToolContext;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-policy-')));
  ctx = { workspaceRoot: tmp, stateDir: path.join(tmp, '..', 'state') };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Minimal fake tools exercising each capability shape.
const reader: Tool<{ path: string }> = {
  name: 'read_file',
  description: '',
  schema: z.object({ path: z.string() }),
  mutates: () => null,
  readsPaths: (i) => [i.path],
  execute: async () => ({ ok: true, output: '', truncated: false, durationMs: 0 }),
};
const writer: Tool<{ path: string }> = {
  name: 'write_file',
  description: '',
  schema: z.object({ path: z.string() }),
  mutates: (i, c) => ({ paths: [path.resolve(c.workspaceRoot, i.path)] }),
  execute: async () => ({ ok: true, output: '', truncated: false, durationMs: 0 }),
};
const shell: Tool<{ command: string }> = {
  name: 'run_command',
  description: '',
  schema: z.object({ command: z.string() }),
  mutates: () => null,
  command: (i) => i.command,
  execute: async () => ({ ok: true, output: '', truncated: false, durationMs: 0 }),
};

describe('decide: reads', () => {
  it('in-workspace read is observe/allow', () => {
    const d = decide(reader, { path: 'src/a.ts' }, ctx, new Grants());
    expect(d).toMatchObject({ classification: 'observe', decision: 'allow' });
  });
  it('out-of-workspace read is sensitive/ask', () => {
    const d = decide(reader, { path: '..\\..\\secret' }, ctx, new Grants());
    expect(d).toMatchObject({ classification: 'sensitive', decision: 'ask', rule: 'path.outside-workspace-read' });
  });
  it('secret-named read is sensitive/ask and flags redaction', () => {
    const d = decide(reader, { path: '.env' }, ctx, new Grants());
    expect(d).toMatchObject({ classification: 'sensitive', decision: 'ask', rule: 'path.secret-name', redactOutput: true });
  });
  it('a session grant downgrades a sensitive read to allow', () => {
    const g = new Grants();
    g.add('read_file', 'sensitive');
    const d = decide(reader, { path: '.env' }, ctx, g);
    expect(d.decision).toBe('allow');
    expect(d.rule).toContain('+grant');
  });
});

describe('decide: writes', () => {
  it('in-workspace write is reversible/allow and requires a snapshot', () => {
    const d = decide(writer, { path: 'out.txt' }, ctx, new Grants());
    expect(d).toMatchObject({ classification: 'reversible', decision: 'allow', requiresSnapshot: true });
  });
  it('out-of-workspace write is denied', () => {
    const d = decide(writer, { path: '..\\evil.txt' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'path.outside-workspace' });
  });
  it('write to .git is denied as protected', () => {
    const d = decide(writer, { path: '.git\\hooks\\pre-commit' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'path.protected' });
  });
  it('a hard-invalid path (UNC) is denied with the path rule', () => {
    const d = decide(writer, { path: '\\\\srv\\share\\x' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'path.unc' });
  });
});

describe('decide: commands are always ask (no allowlist)', () => {
  it('a read-only command still asks', () => {
    const d = decide(shell, { command: 'git status' }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'ask', rule: 'cmd.always-ask', classification: 'observe', noUndo: true });
  });
  it('a smuggled write (redirection) still asks (never auto-runs)', () => {
    const d = decide(shell, { command: 'git status > ..\\evil.txt' }, ctx, new Grants());
    expect(d.decision).toBe('ask');
  });
  it('labels destructive and external commands (label informs, does not grant)', () => {
    expect(decide(shell, { command: 'git push origin main' }, ctx, new Grants()).classification).toBe('external');
    expect(decide(shell, { command: 'Remove-Item -Recurse -Force build' }, ctx, new Grants()).classification).toBe('destructive');
  });
  it('a session grant never applies to run_command', () => {
    const g = new Grants();
    g.add('run_command', 'external'); // ignored by Grants
    expect(decide(shell, { command: 'npm install' }, ctx, g).decision).toBe('ask');
  });
  it('circuit-breaker denies a workspace wipe even interactively', () => {
    const d = decide(shell, { command: `Remove-Item -Recurse -Force ${ctx.workspaceRoot}` }, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'cmd.circuit-breaker' });
  });
});

describe('helpers', () => {
  it('classifyCommand flags format and rm -rf / as circuit breakers', () => {
    expect(classifyCommand('format C:', 'C:\\ws').circuitBreaker).toBe(true);
    expect(classifyCommand('rm -rf /', 'C:\\ws').circuitBreaker).toBe(true);
  });
  it('isSecretName matches common secret files', () => {
    for (const n of ['.env', '.env.local', 'server.pem', 'id_rsa', 'aws_credentials', 'app.key']) {
      expect(isSecretName(n)).toBe(true);
    }
    expect(isSecretName('index.ts')).toBe(false);
  });
  it('Grants only stores grantable classes and never run_command', () => {
    const g = new Grants();
    g.add('write_file', 'reversible'); // not grantable
    g.add('read_file', 'sensitive'); // grantable
    g.add('run_command', 'external'); // never
    expect(g.has('write_file', 'reversible')).toBe(false);
    expect(g.has('read_file', 'sensitive')).toBe(true);
    expect(g.has('run_command', 'external')).toBe(false);
  });
  it('escalateOnSnapshotFailure produces a destructive no-undo ask', () => {
    expect(escalateOnSnapshotFailure()).toMatchObject({
      classification: 'destructive',
      decision: 'ask',
      rule: 'mutation.snapshot-failed',
      noUndo: true,
    });
  });
});
