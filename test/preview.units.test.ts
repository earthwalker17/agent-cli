import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreviewTool, type PreviewToolDeps } from '../src/tools/preview.js';
import { resolvePreview, previewFact } from '../src/preview/recipes.js';
import { detectWorkspace } from '../src/checks/workspace.js';
import { checkReplayKey, decide, Grants } from '../src/policy/engine.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import type { PreviewStopReason, SupervisedExit, SupervisedHandle } from '../src/preview/types.js';
import type { PreviewEvidence, ToolContext } from '../src/types.js';

/**
 * Per-unit previews (Session 16). A full-stack session runs a frontend AND a backend at once;
 * before this both would have resolved from the same root package.json, so the second service was
 * not merely unsupported — it was unnameable.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-prevunits-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function nodeProject(rel: string, scripts: Record<string, string>): void {
  const dir = rel === '.' ? ws : path.join(ws, rel);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: rel.replace(/\//g, '-'), private: true, scripts }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
}

function fakeHandle(logFile: string): SupervisedHandle {
  let alive = true;
  let requestedStop: PreviewStopReason | null = null;
  let resolveExited!: (i: SupervisedExit) => void;
  const exited = new Promise<SupervisedExit>((r) => (resolveExited = r));
  return {
    pid: 4242,
    logFile,
    exited,
    isAlive: () => alive,
    stop: (reason) => {
      if (alive && requestedStop === null) requestedStop = reason;
      alive = false;
      resolveExited({ requestedStop, exitCode: null, signal: null, durationMs: 5 });
      return Promise.resolve({ ok: true, detail: 'fake kill' });
    },
    tail: () => 'listening on http://127.0.0.1:5199/\n',
  };
}

function harness(over: Partial<PreviewToolDeps> = {}): { deps: PreviewToolDeps; ctx: ToolContext; spawned: { cwd: string }[]; evidence: PreviewEvidence[] } {
  const spawned: { cwd: string }[] = [];
  const evidence: PreviewEvidence[] = [];
  let n = 0;
  const deps: PreviewToolDeps = {
    workspaceRoot: ws,
    projectDir: layout.projectDir,
    sessionId: 'test-session-0001',
    caps: { previewsStarted: 0 },
    appendEnded: () => undefined,
    start: (spec) => {
      spawned.push({ cwd: spec.cwd });
      return Promise.resolve(fakeHandle(spec.logFile));
    },
    readiness: () =>
      Promise.resolve({
        ready: true,
        cause: 'ready' as const,
        port: 5199,
        url: 'http://127.0.0.1:5199/',
        httpStatus: 200,
        waitedMs: 3,
        probeDetail: 'HTTP 200 on port parsed from server output 5199',
      }),
    newPreviewId: () => `pv-t${String(++n)}`,
    ...over,
  };
  return { deps, ctx: { workspaceRoot: ws, stateDir: layout.projectDir, reportPreview: (e) => evidence.push(e) }, spawned, evidence };
}

describe('preview resolution is per unit', () => {
  it('resolves each unit’s OWN dev script, qualified and rooted at that unit', () => {
    nodeProject('web', { dev: 'vite' });
    nodeProject('api', { dev: 'tsx watch src/index.ts' });
    const ws2 = detectWorkspace(ws);

    const web = resolvePreview(ws2.units.find((u) => u.id === 'web')!).resolved!;
    const api = resolvePreview(ws2.units.find((u) => u.id === 'api')!).resolved!;

    expect(web.recipeId).toBe('preview.script.dev@web');
    expect(api.recipeId).toBe('preview.script.dev@api');
    expect(web.cwd).toBe(path.join(ws, 'web'));
    expect(api.cwd).toBe(path.join(ws, 'api'));
    expect(web.command).toBe('npm run dev'); // the same STRING, two different servers
    expect(api.command).toBe('npm run dev');
  });

  it('leaves a single ROOT project’s recipe id byte-identical to pre-Session-16', () => {
    nodeProject('.', { dev: 'vite' });
    const root = detectWorkspace(ws).units[0]!;
    expect(resolvePreview(root).resolved!.recipeId).toBe('preview.script.dev');
  });

  it('gives the two servers different replay-consent identities, port suffix included', () => {
    nodeProject('web', { dev: 'vite' });
    nodeProject('api', { dev: 'tsx watch src/index.ts' });
    const w = detectWorkspace(ws);
    const key = (id: string, port?: number): string => {
      const f = previewFact(resolvePreview(w.units.find((u) => u.id === id)!).resolved!, 1000, port);
      return checkReplayKey(f.recipeId, f.command, f.bodySha, f.projectId);
    };
    expect(key('web')).not.toBe(key('api'));
    expect(key('web', 5173)).not.toBe(key('web'));
  });
});

describe('the preview tool serves the named unit', () => {
  it('spawns in the unit directory and labels the evidence with the project', async () => {
    nodeProject('web', { dev: 'vite' });
    nodeProject('api', { dev: 'tsx watch src/index.ts' });
    const h = harness();
    const t = createPreviewTool(h.deps);

    const r = await t.execute({ action: 'start', project: 'api' }, h.ctx);
    expect(r.ok, r.output).toBe(true);
    expect(h.spawned[0]!.cwd).toBe(path.join(ws, 'api'));
    expect(r.output).toContain('[project api]');

    const started = h.evidence.find((e) => e.kind === 'started') as { cwd: string; recipeId: string };
    expect(started.cwd).toBe(path.join(ws, 'api'));
    expect(started.recipeId).toBe('preview.script.dev@api');
    expect(t.active()[0]!.projectId).toBe('api');
  });

  it('runs a frontend and a backend AT THE SAME TIME — the whole point', async () => {
    nodeProject('web', { dev: 'vite' });
    nodeProject('api', { dev: 'tsx watch src/index.ts' });
    const h = harness();
    const t = createPreviewTool(h.deps);

    expect((await t.execute({ action: 'start', project: 'api' }, h.ctx)).ok).toBe(true);
    expect((await t.execute({ action: 'start', project: 'web' }, h.ctx)).ok).toBe(true);

    const alive = t.active();
    expect(alive.map((a) => a.projectId).sort()).toEqual(['api', 'web']);
    expect(h.spawned.map((s) => s.cwd).sort()).toEqual([path.join(ws, 'api'), path.join(ws, 'web')].sort());

    const status = await t.execute({ action: 'status' }, h.ctx);
    expect(status.output).toContain('[project api]');
    expect(status.output).toContain('[project web]');
  });

  it('refuses to guess which project to serve, and starts nothing', async () => {
    nodeProject('web', { dev: 'vite' });
    nodeProject('api', { dev: 'tsx watch src/index.ts' });
    const h = harness();
    const t = createPreviewTool(h.deps);

    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('api, web');
    expect(h.spawned).toHaveLength(0);
    expect(h.deps.caps.previewsStarted).toBe(0);
  });

  it('an [s] for one service does not silently start the other', () => {
    nodeProject('web', { dev: 'vite' });
    nodeProject('api', { dev: 'tsx watch src/index.ts' });
    const t = createPreviewTool(harness().deps);
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: layout.projectDir };
    const grants = new Grants();

    const ask = decide(t, { action: 'start', project: 'api' }, ctx, grants);
    expect(ask).toMatchObject({ decision: 'ask', rule: 'preview.approval-required' });
    for (const k of ask.checkReplayKeys ?? []) grants.addCheckReplay(k);

    expect(decide(t, { action: 'start', project: 'api' }, ctx, grants).decision).toBe('allow');
    expect(decide(t, { action: 'start', project: 'web' }, ctx, grants).decision).toBe('ask');
  });

  it('reports a unit that declares no preview-capable script as a capability gap, not a bad request', async () => {
    nodeProject('web', { dev: 'vite' });
    nodeProject('api', { build: 'tsc -p .' });
    const h = harness();
    const t = createPreviewTool(h.deps);

    const r = await t.execute({ action: 'start', project: 'api' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no preview-capable script');
    expect(h.spawned).toHaveLength(0);
  });
});
