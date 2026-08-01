import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAnsi } from '../src/shared/text.js';
import { parsePortCandidates, waitForReady } from '../src/preview/ready.js';
import { resolveChecks } from '../src/checks/recipes.js';
import { detectProject } from '../src/checks/detect.js';
import { createSharedWorkspace } from '../src/checks/session-workspace.js';
import { completionGateState } from '../src/plan/graph-state.js';
import { createRunCheckTool } from '../src/tools/run-check.js';
import { createProjectSetupTool } from '../src/tools/project-setup.js';
import { createBrowserFlowTool, type BrowserToolDeps } from '../src/tools/browser-flow.js';
import { decide, Grants } from '../src/policy/engine.js';
import type { ActivePreview } from '../src/tools/preview.js';
import type { PlanGraph } from '../src/plan/schema.js';
import type { SupervisedHandle } from '../src/preview/types.js';
import type { BrowserFlowEvidence, CheckEvidence, SessionEvent, ToolContext } from '../src/types.js';

/**
 * The defects that would have broken — or silently falsified — the FIRST real full-stack live run
 * (Session 16.5). Every one was found by the bounded adversarial review over the Session 16 change
 * set, and every one is here because the shape of the run is what exposed it: two projects, two
 * dev servers, a browser flow over the integrated stack, and an install that has to happen before
 * anything can be verified.
 *
 * They are pinned together because they share that provenance. Two of them were measured on real
 * behaviour of this platform before a line was changed, and neither would have been caught by any
 * amount of single-project testing.
 */

const tmpdir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-blockers-'));

/** The literal bytes Vite writes to a log file on win32: picocolors forces colour off-TTY. */
const VITE_BANNER =
  '\n  \x1b[32m\x1b[1mVITE\x1b[22m v6.0.7\x1b[39m  \x1b[2mready in 412 ms\x1b[22m\n\n' +
  '  \x1b[32m\x1b[1m➤\x1b[22m\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n' +
  '  \x1b[32m\x1b[1m➤\x1b[22m\x1b[39m  \x1b[2mNetwork: use \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\n';

function fakeHandle(tail: string, alive = true): SupervisedHandle {
  return {
    pid: 1,
    logFile: 'x.log',
    exited: new Promise(() => undefined),
    isAlive: () => alive,
    stop: () => Promise.resolve({ ok: true, detail: '' }),
    tail: () => tail,
  };
}

describe('a dev server that colourises its banner is still findable', () => {
  it('stripAnsi removes CSI/OSC/two-char escapes and leaves the text', () => {
    expect(stripAnsi('\x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toBe('http://localhost:5173/');
    expect(stripAnsi('\x1b]0;title\x07plain')).toBe('plain');
    expect(stripAnsi('a\x1b(Bb')).toBe('ab');
    expect(stripAnsi('nothing to strip')).toBe('nothing to strip');
  });

  it('parsePortCandidates finds the port in a REAL colourised Vite banner', () => {
    // Before the strip this returned [] — the port sits behind an SGR sequence, so a parser
    // anchored on `localhost:` matched nothing and a healthy Vite server was reported as never
    // having announced a port. The frontend half of a full-stack session was unstartable.
    expect(parsePortCandidates(VITE_BANNER)).toEqual([5173]);
    // A plain backend log still works, and IPv6 literals are recognised too.
    expect(parsePortCandidates('depot-api listening on http://localhost:3001')).toEqual([3001]);
    expect(parsePortCandidates('Listening on http://[::1]:4000/')).toEqual([4000]);
  });
});

describe('readiness reaches a server bound to IPv6 loopback', () => {
  it('probes 127.0.0.1 then [::1], and records the address that answered', async () => {
    // Node 22 resolves `localhost` verbatim, which on this platform is ::1 first — so a dev
    // server told to listen on the string "localhost" refuses every IPv4 connection. Measured
    // before the fix: listen(0,'localhost') bound ::1 and http://127.0.0.1 was ECONNREFUSED.
    const probed: string[] = [];
    const out = await waitForReady(fakeHandle('Local: http://localhost:5173/'), {
      expectedPort: 5173,
      probeHttp: (url) => {
        probed.push(url);
        return Promise.resolve(url.includes('[::1]') ? 200 : null);
      },
    });
    expect(out).toMatchObject({ ready: true, port: 5173, httpStatus: 200, url: 'http://[::1]:5173/' });
    expect(probed).toEqual(['http://127.0.0.1:5173/', 'http://[::1]:5173/']);
    expect(out.probeDetail).toContain('[::1]');
  });

  it('IPv4 still wins when it answers, and the timeout names both families', async () => {
    const ok = await waitForReady(fakeHandle('http://localhost:5173/'), { expectedPort: 5173, probeHttp: () => Promise.resolve(204) });
    expect(ok.url).toBe('http://127.0.0.1:5173/');

    const dead = await waitForReady(fakeHandle('http://localhost:5173/'), {
      expectedPort: 5173,
      waitMs: 30,
      pollMs: 5,
      probeHttp: () => Promise.resolve(null),
    });
    expect(dead.ready).toBe(false);
    expect(dead.probeDetail).toContain('127.0.0.1');
    expect(dead.probeDetail).toContain('[::1]');
  });
});

describe('an uninstalled project is UNVERIFIED, not unverifiable', () => {
  const write = (root: string, rel: string, body: string): void => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };

  it('a missing node_modules resolves precondition-curable, which does NOT waive a declared gate', () => {
    const root = tmpdir();
    write(root, 'package.json', JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: 'vitest run' }, dependencies: { vitest: '^4' } }));
    const uninstalled = detectProject(root, '.');
    expect(uninstalled.hasDependencies && !uninstalled.hasNodeModules).toBe(true);

    const r = resolveChecks(uninstalled, ['build', 'test']);
    expect(r.resolved).toEqual([]);
    expect(r.unsupported.map((u) => u.why)).toEqual(['build', 'test'].map(() => 'precondition-curable'));
    expect(r.unsupported[0]!.reason).toContain('project_setup');

    // A project-capability precondition is a different answer and still waives.
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    write(root, 'package.json', JSON.stringify({ name: 'x', scripts: {}, dependencies: { vitest: '^4' } }));
    const installed = detectProject(root, '.');
    expect(resolveChecks(installed, ['lint']).unsupported[0]!.why).toBe('no-recipe');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a completion gate stays PENDING over a curable precondition and is waived by a genuine one', () => {
    const graph = { version: 1, goal: 'g', tasks: [], gates: { completion: ['test'] } } as unknown as PlanGraph;
    const base = { v: 1, ts: 't', callId: 'c' } as const;
    const change = { ...base, seq: 1, type: 'file.mutated' } as unknown as SessionEvent;
    const unsupported = (why: string, seq: number): SessionEvent =>
      ({ ...base, seq, type: 'check.completed', check: 'test', recipeId: 'r', status: 'unsupported', unsupportedReason: why, exitCode: null, durationMs: 1, summary: 's' }) as unknown as SessionEvent;

    // Curable: the project was never installed. The gate must NOT go green with a caveat.
    const curable = completionGateState(graph, [change, unsupported('precondition-curable', 2)]);
    expect(curable).toMatchObject({ pending: ['test'], waived: [] });

    // Genuine capability gap: the project has no test recipe at all. Waived, with a caveat.
    const genuine = completionGateState(graph, [change, unsupported('no-recipe', 2)]);
    expect(genuine).toMatchObject({ pending: [], waived: ['test'] });

    // Legacy events (no reason at all) keep the old permissive reading.
    const legacy = completionGateState(graph, [
      change,
      { ...base, seq: 2, type: 'check.completed', check: 'test', recipeId: 'r', status: 'unsupported', exitCode: null, durationMs: 1, summary: 's' } as unknown as SessionEvent,
    ]);
    expect(legacy).toMatchObject({ pending: [], waived: ['test'] });
  });
});

describe('browser evidence carries the project it verified', () => {
  const preview = (over: Partial<ActivePreview> = {}): ActivePreview => ({
    previewId: 'pv-web',
    recipeId: 'preview.script.dev@web',
    projectId: 'web',
    command: 'npm run dev',
    startedAtMs: 0,
    readyObserved: true,
    port: 5173,
    url: 'http://127.0.0.1:5173',
    handle: fakeHandle(''),
    ...over,
  });

  const deps = (over: Partial<BrowserToolDeps> = {}): { deps: BrowserToolDeps; checks: CheckEvidence[]; flows: BrowserFlowEvidence[] } => {
    const checks: CheckEvidence[] = [];
    const flows: BrowserFlowEvidence[] = [];
    const d: BrowserToolDeps = {
      preview: { readyPreview: () => preview(), active: () => [preview()] },
      putBlob: () => 'sha',
      caps: { checksRun: 0 },
      artifactBudget: { usedBytes: 0 },
      probe: () => Promise.resolve({ available: true, channel: 'msedge' }),
      run: (_f, d2) => {
        d2.onBrowserLaunched?.();
        return Promise.resolve({
          status: 'pass' as const,
          steps: [{ n: 1, kind: 'goto', target: '/', ok: true }],
          artifacts: [],
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          offOriginRequests: [],
          finalUrl: 'http://127.0.0.1:5173/',
          durationMs: 5,
          signals: [],
          summary: "flow 'ui': pass",
        });
      },
      ...over,
    };
    return { deps: d, checks, flows };
  };

  const FLOW = { flow: { name: 'ui', steps: [{ do: 'goto' as const, path: '/', ready_when: { selector: '#app' } }] } };

  it('a passing flow records projectId, so a project-scoped browser gate can go green', async () => {
    const h = deps();
    const t = createBrowserFlowTool(h.deps);
    const ctx: ToolContext = { workspaceRoot: tmpdir(), stateDir: tmpdir(), reportCheck: (e) => h.checks.push(e), reportBrowser: (e) => h.flows.push(e) };
    const res = await t.execute(FLOW, ctx);
    expect(res.ok).toBe(true);
    // Both the spawn record and the verdict are attributed — a gate reads the verdict, the
    // report reads both.
    expect(h.checks.map((c) => c.projectId)).toEqual(['web', 'web']);
    // And the result says what it drove: an unbound flow binds to whatever single preview is
    // ready, which in a full-stack session can legitimately be the wrong service.
    expect(res.output).toContain('drove preview pv-web [project web]');
    expect(res.output).toContain('no preview_id was given');

    // The gate this unblocks: `gates.projects: ['web']` over kind 'browser'.
    const graph = { version: 1, goal: 'g', tasks: [], gates: { completion: ['browser'], projects: ['web'] } } as unknown as PlanGraph;
    const events = [
      { v: 1, seq: 1, ts: 't', callId: 'c', type: 'file.mutated' },
      { v: 1, seq: 2, ts: 't', callId: 'c', type: 'check.completed', check: 'browser', recipeId: 'browser.flow/ui', status: 'pass', projectId: 'web', exitCode: null, durationMs: 5, summary: 'ok' },
    ] as unknown as SessionEvent[];
    expect(completionGateState(graph, events)).toMatchObject({ pending: [], waived: [] });
  });

  it('with TWO previews ready and none named, the denial NAMES them instead of saying "start one first"', () => {
    const two = [preview(), preview({ previewId: 'pv-api', projectId: 'api', port: 3001 })];
    const h = deps({ preview: { readyPreview: () => null, active: () => two } });
    const t = createBrowserFlowTool(h.deps);
    const d = decide(t, FLOW, { workspaceRoot: tmpdir(), stateDir: tmpdir() }, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'browser.no-preview' });
    expect(d.reason).toContain('2 previews are running');
    expect(d.reason).toContain('pv-web [project web]');
    expect(d.reason).toContain('pv-api [project api]');
    expect(d.reason).toContain('preview_id');
    // The old message told a model with two live servers to start a third.
    expect(d.reason).not.toContain('start one with the preview tool first');
  });

  it('a named preview that is not ready is refused with what IS ready', () => {
    const h = deps({ preview: { readyPreview: () => null, active: () => [preview()] } });
    const t = createBrowserFlowTool(h.deps);
    const d = decide(t, { flow: { ...FLOW.flow, preview_id: 'pv-gone' } }, { workspaceRoot: tmpdir(), stateDir: tmpdir() }, new Grants());
    expect(d.reason).toContain("no READY preview with id 'pv-gone'");
    expect(d.reason).toContain('pv-web [project web]');
  });
});

describe('the session sees its own install', () => {
  it('after project_setup, the next run_check resolves the real command instead of a false drift refusal', () => {
    const root = tmpdir();
    const api = path.join(root, 'api');
    fs.mkdirSync(api, { recursive: true });
    fs.writeFileSync(path.join(api, 'package.json'), JSON.stringify({ name: 'api', scripts: { build: 'tsc' }, dependencies: { express: '^4' } }));
    fs.writeFileSync(path.join(api, 'package-lock.json'), '{"lockfileVersion":3}');

    const shared = createSharedWorkspace(root);
    const check = createRunCheckTool({ workspaceRoot: root, caps: { checksRun: 0 }, shared });
    const setup = createProjectSetupTool({ workspaceRoot: root, caps: { setupsRun: 0 }, shared });

    // Before the install nothing resolves: the project declares dependencies and has none.
    expect(check.check?.({ checks: ['build'], project: 'api' }).resolved).toEqual([]);
    expect(setup.check?.({ action: 'install', project: 'api' }).resolved[0]?.command).toBe('npm ci');

    // The install happens (its effect, not its execution — this is about snapshot propagation).
    fs.mkdirSync(path.join(api, 'node_modules'), { recursive: true });
    shared.refresh();

    // The very next check now resolves a REAL command at DECIDE time, so the human is asked
    // about `npm run build` rather than the call being allowed as "nothing to run" and then
    // refused at execute with "the project changed after this call was approved".
    const resolved = check.check?.({ checks: ['build'], project: 'api' }).resolved ?? [];
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ command: 'npm run build', projectId: 'api' });
    expect(check.workspaceSnapshot().units.map((u) => u.id)).toEqual(['api']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('all three tools share ONE snapshot, so any refresh is visible to the others', () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'solo', scripts: { test: 'vitest run' } }));
    const shared = createSharedWorkspace(root);
    const check = createRunCheckTool({ workspaceRoot: root, caps: { checksRun: 0 }, shared });
    const setup = createProjectSetupTool({ workspaceRoot: root, caps: { setupsRun: 0 }, shared });
    expect(check.workspaceSnapshot()).toBe(setup.workspaceSnapshot());

    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }));
    setup.refresh();
    expect(check.workspaceSnapshot().units.map((u) => u.id)).toEqual(['.', 'web']);
    expect(check.workspaceSnapshot()).toBe(setup.workspaceSnapshot());
    fs.rmSync(root, { recursive: true, force: true });
  });
});

