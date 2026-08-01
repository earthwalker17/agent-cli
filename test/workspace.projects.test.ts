import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt } from '../src/workspace/system-prompt.js';
import { detectWorkspace } from '../src/checks/workspace.js';
import { runCommandTool } from '../src/tools/run-command.js';
import { buildSessionDiff } from '../src/report/diff.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { sha256 } from '../src/shared/hash.js';
import type { CommandEvidence, SessionEvent, ToolContext } from '../src/types.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * Session 16 surfaces that are not the tools themselves: what the model is TOLD about the
 * workspace, where a shell command actually runs, and what the session diff is willing to print.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-wsproj-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const MAP: WorkspaceMap = { text: '(files)', sha256: 'x'.repeat(64), fileCount: 1, truncated: false };

function project(rel: string, o: { scripts?: Record<string, string>; lock?: string; env?: boolean; deps?: boolean } = {}): void {
  const dir = rel === '.' ? ws : path.join(ws, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (o.deps !== false) fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: rel.replace(/[./]/g, '-') || 'root', private: true, scripts: o.scripts ?? {}, dependencies: { left: '^1' } }),
  );
  if (o.lock !== undefined) fs.writeFileSync(path.join(dir, o.lock), '{}');
  if (o.env === true) fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=1\n');
}

describe('the system prompt tells the model which projects exist', () => {
  it('lists each project with its manager, lockfile, install state and scripts', () => {
    project('api', { scripts: { dev: 'tsx watch .', migrate: 'node m.js' }, lock: 'package-lock.json', env: true });
    project('web', { scripts: { dev: 'vite' }, lock: 'package-lock.json' });

    const p = buildSystemPrompt(ws, MAP, undefined, undefined, undefined, detectWorkspace(ws));
    expect(p).toContain('Detected projects in this workspace (2), AS OBSERVED AT SESSION START');
    expect(p).toContain('- api (node; npm; lockfile package-lock.json; dependencies installed');
    expect(p).toContain('expects env config (.env.example) — none present');
    expect(p).toContain('scripts: dev, migrate');
    expect(p).toContain('- web (node; npm; lockfile package-lock.json');
  });

  it('warns that the harness refuses to guess ONLY when there is more than one project', () => {
    project('api', { scripts: { dev: 'x' } });
    expect(buildSystemPrompt(ws, MAP, undefined, undefined, undefined, detectWorkspace(ws))).not.toContain('REFUSES to guess');

    project('web', { scripts: { dev: 'y' } });
    expect(buildSystemPrompt(ws, MAP, undefined, undefined, undefined, detectWorkspace(ws))).toContain('REFUSES to guess');
  });

  it('always states the setup and env rules when any project exists', () => {
    project('.', { scripts: { dev: 'x' } });
    const p = buildSystemPrompt(ws, MAP, undefined, undefined, undefined, detectWorkspace(ws));
    expect(p).toContain('go through `project_setup`');
    expect(p).toContain('A setup is NOT verification');
    expect(p).toContain('ITS OWN .env file');
  });

  it('adds nothing at all when no project is detected — an empty workspace reads as it always did', () => {
    const p = buildSystemPrompt(ws, MAP, undefined, undefined, undefined, detectWorkspace(ws));
    expect(p).not.toContain('Detected projects');
    expect(p).toBe(buildSystemPrompt(ws, MAP));
  });
});

describe('run_command cwd', () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ workspaceRoot: ws, stateDir: layout.projectDir, ...over });

  it('runs in the named subdirectory and RECORDS that directory', async () => {
    fs.mkdirSync(path.join(ws, 'api'), { recursive: true });
    const evidence: CommandEvidence[] = [];
    const r = await runCommandTool.execute(
      { command: 'node -e "process.stdout.write(process.cwd())"', cwd: 'api' },
      ctx({ reportCommand: (e) => evidence.push(e) }),
    );
    expect(r.ok, r.output).toBe(true);
    expect(r.output.trim().toLowerCase()).toBe(path.join(ws, 'api').toLowerCase());
    const started = evidence.find((e) => e.kind === 'started') as { cwd: string };
    expect(started.cwd).toBe(path.join(ws, 'api'));
  }, 60_000);

  it('defaults to the workspace root, exactly as before', async () => {
    const evidence: CommandEvidence[] = [];
    await runCommandTool.execute({ command: 'node -e ""' }, ctx({ reportCommand: (e) => evidence.push(e) }));
    expect((evidence.find((e) => e.kind === 'started') as { cwd: string }).cwd).toBe(ws);
  }, 60_000);

  it('refuses an escaping, absolute, or non-existent cwd — and spawns nothing', async () => {
    for (const bad of ['../outside', 'nope', 'package.json']) {
      const evidence: CommandEvidence[] = [];
      const r = await runCommandTool.execute({ command: 'node -e ""', cwd: bad }, ctx({ reportCommand: (e) => evidence.push(e) }));
      expect(r.ok, bad).toBe(false);
      expect(r.error, bad).toBe('invalid cwd');
      expect(evidence, bad).toHaveLength(0);
    }
  }, 60_000);

  it('shows the directory in the approval prompt context', () => {
    expect(runCommandTool.approvalContext!({ command: 'npm ci', cwd: 'api' })).toEqual(['in: api']);
    expect(runCommandTool.approvalContext!({ command: 'npm ci' })).toEqual([]);
  });
});

describe('the session diff withholds secret-named contents', () => {
  let seq = 0;
  const ev = (body: Record<string, unknown>): SessionEvent =>
    ({ v: 1, seq: ++seq, ts: '2026-07-31T00:00:00.000Z', ...body }) as unknown as SessionEvent;

  function mutated(relPath: string, before: string, after: string): SessionEvent[] {
    const snapshots = new SnapshotStore(layout.objectsDir);
    const beforeSha = snapshots.putBlob(Buffer.from(before));
    fs.mkdirSync(path.dirname(path.join(ws, relPath)), { recursive: true });
    fs.writeFileSync(path.join(ws, relPath), after);
    return [
      ev({ type: 'snapshot.created', callId: 'c1', path: path.join(ws, relPath), sha256: beforeSha, bytes: before.length }),
      ev({
        type: 'file.mutated',
        callId: 'c1',
        path: path.join(ws, relPath),
        kind: 'edit',
        beforeSha256: beforeSha,
        afterSha256: sha256(Buffer.from(after)),
        createdDirs: [],
      }),
    ];
  }

  it('reports the SHAPE of an .env change without printing the secret', () => {
    seq = 0;
    const events = mutated('api/.env', 'PORT=3001\n', 'PORT=3001\nJWT_SECRET=hunter2\n');
    const files = buildSessionDiff(events, new SnapshotStore(layout.objectsDir), ws);
    const f = files.find((x) => x.relPath === 'api/.env')!;
    expect(f.patch).toBeUndefined();
    expect(f.note).toBe('contents withheld: secret-named file (+1/−0 lines)');
    expect(JSON.stringify(files)).not.toContain('hunter2');
  });

  it('still diffs an ordinary file in full', () => {
    seq = 0;
    const events = mutated('api/src/index.ts', 'const a = 1;\n', 'const a = 2;\n');
    const f = buildSessionDiff(events, new SnapshotStore(layout.objectsDir), ws).find((x) => x.relPath === 'api/src/index.ts')!;
    expect(f.patch).toContain('const a = 2;');
  });

  it('honours the config secretPatterns the policy gate uses', () => {
    seq = 0;
    const events = mutated('api/company-vault.txt', 'x\n', 'y\n');
    const plain = buildSessionDiff(events, new SnapshotStore(layout.objectsDir), ws).find((x) => x.relPath.endsWith('vault.txt'))!;
    expect(plain.patch).toBeDefined();

    const withRule = buildSessionDiff(events, new SnapshotStore(layout.objectsDir), ws, ['vault']).find((x) => x.relPath.endsWith('vault.txt'))!;
    expect(withRule.patch).toBeUndefined();
    expect(withRule.note).toContain('contents withheld');
  });
});
