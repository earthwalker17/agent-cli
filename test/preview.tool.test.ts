import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPreviewTool,
  previewCapsFromEvents,
  MAX_CONCURRENT_PREVIEWS,
  PREVIEWS_PER_SESSION,
  type PreviewCaps,
  type PreviewToolDeps,
} from '../src/tools/preview.js';
import { resolvePreview, PREVIEW_SCRIPT_PREFERENCE } from '../src/preview/recipes.js';
import { parsePortCandidates, waitForReady } from '../src/preview/ready.js';
import { loadPreviewRegistry, previewsFile } from '../src/preview/registry.js';
import { decide, Grants } from '../src/policy/engine.js';
import { formatApprovalPrompt } from '../src/runtime/approvals.js';
import { startSession, resumeSession, endSession, runTurn } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { TOOLS } from '../src/tools/index.js';
import { EventLog } from '../src/store/event-log.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import { detectWorkspace } from '../src/checks/workspace.js';
import { sha256 } from '../src/shared/hash.js';
import type { DetectedProject } from '../src/checks/types.js';
import type { PreviewStopReason, SupervisedExit, SupervisedHandle } from '../src/preview/types.js';
import type { ApprovalOutcome, ApprovalRequest, Approver, PreviewEvidence, SessionEvent, ToolContext } from '../src/types.js';

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-prevtool-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function nodeProject(scripts: Record<string, string>): void {
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }));
  fs.writeFileSync(path.join(ws, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
}

/** A controllable in-memory SupervisedHandle: tests decide when and how it dies. */
function fakeHandle(logFile: string): SupervisedHandle & { die: (exitCode?: number) => void; stops: PreviewStopReason[] } {
  let alive = true;
  let requestedStop: PreviewStopReason | null = null;
  const stops: PreviewStopReason[] = [];
  let resolveExited!: (i: SupervisedExit) => void;
  const exited = new Promise<SupervisedExit>((r) => (resolveExited = r));
  const die = (exitCode = 0): void => {
    if (!alive) return;
    alive = false;
    resolveExited({ requestedStop, exitCode, signal: null, durationMs: 5 });
  };
  return {
    pid: 4242,
    logFile,
    exited,
    isAlive: () => alive,
    stop: (reason) => {
      stops.push(reason);
      if (alive && requestedStop === null) requestedStop = reason;
      die(null as unknown as number);
      return Promise.resolve({ ok: true, detail: 'fake kill' });
    },
    tail: () => 'listening on http://127.0.0.1:5199/\n',
    die,
    stops,
  };
}

interface Harness {
  deps: PreviewToolDeps;
  evidence: PreviewEvidence[];
  ended: { previewId: string; reason: string; exitCode: number | null }[];
  handles: (SupervisedHandle & { die: (c?: number) => void; stops: PreviewStopReason[] })[];
  ctx: ToolContext;
}

function harness(over: Partial<PreviewToolDeps> = {}): Harness {
  const evidence: PreviewEvidence[] = [];
  const ended: { previewId: string; reason: string; exitCode: number | null }[] = [];
  const handles: Harness['handles'] = [];
  let n = 0;
  const deps: PreviewToolDeps = {
    workspaceRoot: ws,
    projectDir: layout.projectDir,
    sessionId: 'test-session-0001',
    caps: { previewsStarted: 0 },
    appendEnded: (e) => ended.push({ previewId: e.previewId, reason: e.reason, exitCode: e.exitCode }),
    start: (spec) => {
      const h = fakeHandle(spec.logFile);
      handles.push(h);
      return Promise.resolve(h);
    },
    readiness: () =>
      Promise.resolve({ ready: true, cause: 'ready' as const, port: 5199, url: 'http://127.0.0.1:5199/', httpStatus: 200, waitedMs: 3, probeDetail: 'HTTP 200 on port parsed from server output 5199' }),
    newPreviewId: () => `pv-t${String(++n)}`,
    ...over,
  };
  const ctx: ToolContext = { workspaceRoot: ws, stateDir: layout.projectDir, reportPreview: (e) => evidence.push(e) };
  return { deps, evidence, ended, handles, ctx };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('resolvePreview', () => {
  const project = (scripts: Record<string, string>, over: Partial<DetectedProject> = {}): DetectedProject => ({
    root: ws,
    id: '.',
    kinds: ['node'],
    packageManager: 'npm',
    packageManagerSpec: null,
    scripts,
    // Mirror detectProject: consent binds the sha of the FULL script value.
    scriptShas: Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, sha256(v)])),
    nodeTools: [],
    pythonTools: [],
    hasNodeModules: true,
    hasDependencies: false,
    hasTsconfig: false,
    hasEslintConfig: false,
    hasPrettierConfig: false,
    lockfile: null,
    manifestSha256: null,
    npmrcSha256: null,
    installConfigSha256: null,
    envFiles: { examples: [], present: [] },
    evidence: [],
    stamps: [],
    ...over,
  });

  it('prefers dev > preview > serve > start and composes <pm> run <name>', () => {
    const r = resolvePreview(project({ start: 'node s.js', dev: 'node d.js', serve: 'node v.js' }));
    expect(r.resolved?.scriptName).toBe('dev');
    expect(r.resolved?.command).toBe('npm run dev');
    expect(r.resolved?.recipeId).toBe('preview.script.dev');
    expect(r.candidates).toEqual(['dev', 'serve', 'start']);
  });

  it('an explicitly requested script must be a conventional preview name — anything else is a bad request', () => {
    const r = resolvePreview(project({ dev: 'node d.js', deploy: 'rm -rf prod' }), 'deploy');
    expect(r.resolved).toBeNull();
    expect(r.badRequest).toBe(true);
    expect(r.reason).toContain('not a preview-capable script name');
  });

  it('a conventional name that is not declared refuses as a bad request naming the declared ones', () => {
    const r = resolvePreview(project({ dev: 'node d.js' }), 'serve');
    expect(r.resolved).toBeNull();
    expect(r.badRequest).toBe(true);
    expect(r.reason).toContain("'serve' is not declared");
  });

  it('declared dependencies without node_modules refuse as a capability gap, not a bad request', () => {
    const r = resolvePreview(project({ dev: 'vite' }, { hasDependencies: true, hasNodeModules: false }));
    expect(r.resolved).toBeNull();
    expect(r.badRequest).toBeUndefined();
    expect(r.reason).toContain('node_modules');
  });

  it('no preview-capable script / no package manager resolve nothing', () => {
    expect(resolvePreview(project({ build: 'tsc' })).resolved).toBeNull();
    expect(resolvePreview(project({ dev: 'x' }, { packageManager: null })).resolved).toBeNull();
  });
});

describe('preview policy (pure decide over the check fact)', () => {
  function tool(deps: Partial<PreviewToolDeps> = {}) {
    nodeProject({ dev: 'node server.js' });
    return createPreviewTool(harness(deps).deps);
  }
  const ctx = (): ToolContext => ({ workspaceRoot: ws, stateDir: layout.projectDir });

  it('start asks with the preview-specific rule, reason, and replay keys', () => {
    const t = tool();
    const d = decide(t, { action: 'start' }, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'ask', classification: 'reversible', rule: 'preview.approval-required', noUndo: true, execBoundary: 'unsandboxed' });
    expect(d.reason).toContain('KEEPS RUNNING');
    expect(d.reason).toContain('binds a local port');
    expect(d.checkReplayKeys).toHaveLength(1);
  });

  it('replay consent allows a re-start under the preview replay rule; a body edit re-asks', () => {
    const t = tool();
    const grants = new Grants();
    const first = decide(t, { action: 'start' }, ctx(), grants);
    for (const k of first.checkReplayKeys ?? []) grants.addCheckReplay(k);
    expect(decide(t, { action: 'start' }, ctx(), grants)).toMatchObject({ decision: 'allow', rule: 'preview.replay-consent' });
    // Rewriting the script changes the bodySha → a NEW key → ask again (after refresh).
    nodeProject({ dev: 'node evil.js' });
    t.refresh();
    expect(decide(t, { action: 'start' }, ctx(), grants)).toMatchObject({ decision: 'ask', rule: 'preview.approval-required' });
  });

  it('stop/status are MANAGE actions: allowed, but never recorded as observation', () => {
    const t = tool();
    for (const action of ['stop', 'status'] as const) {
      const d = decide(t, { action }, ctx(), new Grants());
      expect(d).toMatchObject({ decision: 'allow', classification: 'reversible', rule: 'preview.manage' });
      expect(d.reason).toContain('session itself started');
      expect(d.reason).not.toContain('no check resolved');
    }
  });

  it('a DECLARED port is part of the consent identity: a different port is a different replay key', () => {
    const t = tool();
    const grants = new Grants();
    const withPort = decide(t, { action: 'start', port: 5199 }, ctx(), grants);
    expect(withPort.decision).toBe('ask');
    for (const k of withPort.checkReplayKeys ?? []) grants.addCheckReplay(k);
    // Same port rides the consent; a different port (or none) re-asks.
    expect(decide(t, { action: 'start', port: 5199 }, ctx(), grants).decision).toBe('allow');
    expect(decide(t, { action: 'start', port: 4444 }, ctx(), grants).decision).toBe('ask');
    expect(decide(t, { action: 'start' }, ctx(), grants).decision).toBe('ask');
  });

  it('the approval prompt renders the preview header and the re-start [s] wording', () => {
    const req: ApprovalRequest = {
      callId: 'c1',
      tool: 'preview',
      classification: 'reversible',
      kind: 'preview',
      checkCount: 1,
      summary: 'preview: start preview.script.dev',
      detail: 'npm run dev   [preview.script.dev; KEEPS RUNNING up to 30min (or until stopped / session end); binds a local port; runs a script defined by this workspace]',
      reason: 'starts a harness-resolved preview server',
      noUndoWarning: true,
    };
    const prompt = formatApprovalPrompt(req);
    expect(prompt).toContain('[preview server — harness-resolved command; KEEPS RUNNING]');
    expect(prompt).toContain('[s] allow re-starts of THIS EXACT command this session');
    expect(prompt).not.toContain('allow for the rest of this session');
  });
});

describe('preview tool — lifecycle', () => {
  it('start: registry entry before the started event, ready evidence, and honest result text', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness();
    const t = createPreviewTool(h.deps);
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('ready: http://127.0.0.1:5199/');
    expect(r.output).toContain('application state is verified by browser flows');
    expect(h.evidence.map((e) => e.kind)).toEqual(['started', 'ready']);
    const reg = loadPreviewRegistry(previewsFile(layout.projectDir));
    expect(reg).toHaveLength(1);
    expect(reg[0]!.ownerPid).toBe(process.pid);
    expect(reg[0]!.command).toBe('npm run dev');
  });

  it('a registry write failure stops the process and reports NO started event (ordering pin)', async () => {
    nodeProject({ dev: 'node server.js' });
    // previews.json as a DIRECTORY makes the atomic rename fail — registration cannot succeed.
    fs.mkdirSync(previewsFile(layout.projectDir), { recursive: true });
    const h = harness();
    const t = createPreviewTool(h.deps);
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('crash-registry could not be written');
    expect(h.evidence).toEqual([]); // no preview.started without a registry entry — never the reverse
    expect(h.handles[0]!.stops).toContain('start-failed');
  });

  it('readiness timeout stops the process with reason start-failed (never "stopped")', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness({
      readiness: () => Promise.resolve({ ready: false, cause: 'timeout' as const, waitedMs: 50, probeDetail: 'no HTTP answer on candidate port(s) 5199 within 50ms' }),
    });
    const t = createPreviewTool(h.deps);
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('readiness timeout');
    await flush();
    expect(h.ended).toEqual([{ previewId: 'pv-t1', reason: 'start-failed', exitCode: null }]);
    expect(loadPreviewRegistry(previewsFile(layout.projectDir))).toEqual([]); // unregistered after ended
  });

  it('a process death during startup reports start-failed with the log tail', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness({
      readiness: async () => {
        h.handles[0]!.die(1);
        await flush();
        return { ready: false, cause: 'died' as const, waitedMs: 5, probeDetail: 'the process exited before answering any HTTP probe' };
      },
    });
    const t = createPreviewTool(h.deps);
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('FAILED TO START');
    await flush();
    expect(h.ended).toEqual([{ previewId: 'pv-t1', reason: 'start-failed', exitCode: 1 }]);
  });

  it('an aborted readiness wait leaves the preview RUNNING and says so', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness({
      readiness: () => Promise.resolve({ ready: false, cause: 'aborted' as const, waitedMs: 5, probeDetail: 'readiness wait aborted by the user; the process was not stopped' }),
    });
    const t = createPreviewTool(h.deps);
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('LEFT RUNNING');
    expect(h.handles[0]!.isAlive()).toBe(true);
    expect(h.ended).toEqual([]); // still running: no ended event
  });

  it('a crash AFTER readiness records reason crashed; a stop records stopped — one event each', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness();
    const t = createPreviewTool(h.deps);
    await t.execute({ action: 'start' }, h.ctx);
    h.handles[0]!.die(3);
    await flush();
    expect(h.ended).toEqual([{ previewId: 'pv-t1', reason: 'crashed', exitCode: 3 }]);

    await t.execute({ action: 'start' }, h.ctx);
    const r = await t.execute({ action: 'stop' }, h.ctx); // single running preview: id optional
    expect(r.ok).toBe(true);
    await flush();
    expect(h.ended).toHaveLength(2);
    expect(h.ended[1]).toMatchObject({ previewId: 'pv-t2', reason: 'stopped' });
  });

  it('budget and concurrency refusals spawn nothing', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness({ caps: { previewsStarted: PREVIEWS_PER_SESSION } });
    const t = createPreviewTool(h.deps);
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('budget');
    expect(h.handles).toHaveLength(0);

    const h2 = harness();
    const t2 = createPreviewTool(h2.deps);
    // Symbolic, so raising the cap never breaks this again: fill it exactly, then overflow by one.
    for (let i = 0; i < MAX_CONCURRENT_PREVIEWS; i++) {
      expect((await t2.execute({ action: 'start' }, h2.ctx)).ok, `start ${String(i)}`).toBe(true);
    }
    expect(MAX_CONCURRENT_PREVIEWS).toBe(4); // Session 16: a frontend + a backend + headroom
    const r3 = await t2.execute({ action: 'start' }, h2.ctx);
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('too many concurrent');
    expect(h2.handles).toHaveLength(MAX_CONCURRENT_PREVIEWS); // the refusal spawned nothing extra
  });

  it('TOCTOU: a script rewrite between gate and execute refuses with approved/now and spawns nothing', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness();
    const t = createPreviewTool(h.deps);
    // The gate resolved from the snapshot; now rewrite the script body on disk.
    await new Promise((r) => setTimeout(r, 30)); // mtime resolution
    nodeProject({ dev: 'node other.js' });
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('approved:');
    expect(r.output).toContain('now:');
    expect(h.handles).toHaveLength(0);
    expect(h.evidence).toEqual([]);
  });

  it('bad script names and script-less projects refuse honestly', async () => {
    nodeProject({ build: 'tsc' });
    const h = harness();
    const t = createPreviewTool(h.deps);
    const r = await t.execute({ action: 'start' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no preview-capable script');

    nodeProject({ dev: 'node server.js' });
    const t2 = createPreviewTool(harness().deps);
    const r2 = await t2.execute({ action: 'start', script: 'nonsense' }, h.ctx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('invalid preview request');
  });

  it('stop with several running requires the id; status lists live state', async () => {
    nodeProject({ dev: 'node server.js' });
    const h = harness();
    const t = createPreviewTool(h.deps);
    await t.execute({ action: 'start' }, h.ctx);
    await t.execute({ action: 'start' }, h.ctx);
    const r = await t.execute({ action: 'stop' }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('preview_id is required');
    const s = await t.execute({ action: 'status' }, h.ctx);
    expect(s.ok).toBe(true);
    expect(s.output).toContain('pv-t1');
    expect(s.output).toContain('pv-t2');
    const r2 = await t.execute({ action: 'stop', preview_id: 'pv-t1' }, h.ctx);
    expect(r2.ok).toBe(true);
  });

  it('previewCapsFromEvents counts started events', () => {
    const events = [
      { type: 'preview.started', previewId: 'a' },
      { type: 'preview.ready', previewId: 'a' },
      { type: 'preview.started', previewId: 'b' },
      { type: 'preview.ended', previewId: 'a' },
    ] as unknown as SessionEvent[];
    expect(previewCapsFromEvents(events)).toEqual({ previewsStarted: 2 });
  });
});

describe('readiness probe', () => {
  it('parsePortCandidates: unique, last occurrence first, host variants', () => {
    expect(parsePortCandidates('try http://localhost:3000 … retrying … listening on http://127.0.0.1:3001/')).toEqual([3001, 3000]);
    expect(parsePortCandidates('Local: http://0.0.0.0:8080')).toEqual([8080]);
    expect(parsePortCandidates('no ports here')).toEqual([]);
  });

  it('a declared port is probed only once the server ANNOUNCES it; parsed ports are probed; died/timeout/abort typed', async () => {
    const h = fakeHandle('x.log'); // tail announces 5199
    const probed: string[] = [];
    const ok = await waitForReady(h, {
      expectedPort: 5199,
      probeHttp: (url) => {
        probed.push(url);
        return Promise.resolve(200);
      },
    });
    expect(ok).toMatchObject({ ready: true, port: 5199, httpStatus: 200 });
    expect(ok.probeDetail).toContain('declared port');
    expect(ok.probeDetail).toContain('socket ownership not verified');
    expect(probed).toEqual(['http://127.0.0.1:5199/']);

    // A declared port the server never announced is NEVER probed — a foreign local service
    // answering there must not be adopted as the consented preview.
    const neverProbed: string[] = [];
    const unannounced = await waitForReady(h, {
      expectedPort: 4444,
      waitMs: 80,
      pollMs: 10,
      probeHttp: (url) => {
        neverProbed.push(url);
        return Promise.resolve(200);
      },
    });
    expect(unannounced.cause).toBe('timeout');
    expect(unannounced.probeDetail).toContain('never announced the declared port 4444');
    expect(neverProbed).toEqual([]);

    const parsed = await waitForReady(h, { probeHttp: (u) => Promise.resolve(u.includes('5199') ? 204 : null) });
    expect(parsed).toMatchObject({ ready: true, port: 5199 });
    expect(parsed.probeDetail).toContain('parsed from server output');

    // An answer arriving from a process that already DIED is somebody else's socket.
    const dying = fakeHandle('z.log');
    const raced = await waitForReady(dying, {
      probeHttp: () => {
        dying.die();
        return Promise.resolve(200);
      },
    });
    expect(raced.cause).toBe('died');
    expect(raced.probeDetail).toContain('exited while the port was being probed');

    h.die();
    const died = await waitForReady(h, { probeHttp: () => Promise.resolve(null) });
    expect(died.cause).toBe('died');

    const h2 = fakeHandle('y.log');
    const to = await waitForReady(h2, { waitMs: 60, pollMs: 10, probeHttp: () => Promise.resolve(null) });
    expect(to.cause).toBe('timeout');

    const ac = new AbortController();
    ac.abort();
    const ab = await waitForReady(h2, { signal: ac.signal, probeHttp: () => Promise.resolve(null) });
    expect(ab.cause).toBe('aborted');
  });
});

describe('preview consent through the session (replay, TOCTOU re-ask, resume re-ask)', () => {
  function scriptedApprover(outcomes: ApprovalOutcome[]): { approver: Approver; calls: ApprovalRequest[] } {
    const calls: ApprovalRequest[] = [];
    let i = 0;
    const approver: Approver = (req) => {
      calls.push(req);
      return Promise.resolve(outcomes[i++] ?? { decision: 'deny', scope: 'once', source: 'user' });
    };
    return { approver, calls };
  }

  function sessionWith(script: ScriptTurn[], approver: Approver, opts: { resumeId?: string } = {}) {
    // The assemble-style appendEnded: preview.ended goes to the SESSION LOG (closed-log-tolerant).
    const ref: { log: { append: (b: object) => unknown } | null } = { log: null };
    const h = harness({
      appendEnded: (e) => {
        try {
          ref.log?.append({ type: 'preview.ended', ...e });
        } catch {
          /* closed log */
        }
      },
    });
    const tool = createPreviewTool(h.deps);
    const common = {
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'interactive' as const,
      provider: new MockProvider(script),
      approver,
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
      tools: [...TOOLS, tool],
    };
    const session = opts.resumeId !== undefined ? resumeSession({ ...common, sessionId: opts.resumeId }) : startSession(common);
    ref.log = session.log as unknown as { append: (b: object) => unknown };
    return { session, h };
  }

  it('one [s] covers re-starts; grants are NOT restored on resume (the honest contract)', async () => {
    nodeProject({ dev: 'node server.js' });
    const { approver, calls } = scriptedApprover([{ decision: 'allow', scope: 'session', source: 'user' }]);
    const s1 = sessionWith(
      [
        { say: 'start', calls: [{ name: 'preview', input: { action: 'start' } }] },
        { say: 'stop', calls: [{ name: 'preview', input: { action: 'stop' } }] },
        { say: 'again', calls: [{ name: 'preview', input: { action: 'start' } }] },
        { say: 'done' },
      ],
      approver,
    );
    // ONE turn drives all three calls: the mock provider yields a scripted turn per STEP.
    await runTurn(s1.session, 'start a preview, stop it, start it again');
    expect(calls).toHaveLength(1); // the re-start rode replay consent — no second ask
    const decisions = s1.session.log.events.filter((e) => e.type === 'policy.decision');
    expect(decisions.map((d) => (d as { rule?: string }).rule)).toEqual([
      'preview.approval-required',
      'preview.manage', // the stop — a manage action, never recorded as observation
      'preview.replay-consent',
    ]);
    const id = s1.session.id;
    endSession(s1.session, 'user-quit');

    // Resume: the grants store is in-memory and session-scoped — the same start ASKS again.
    const { approver: approver2, calls: calls2 } = scriptedApprover([{ decision: 'allow', scope: 'session', source: 'user' }]);
    const s2 = sessionWith([{ say: 'resume-start', calls: [{ name: 'preview', input: { action: 'start' } }] }, { say: 'done' }], approver2, {
      resumeId: id,
    });
    await runTurn(s2.session, 'start the preview again');
    expect(calls2).toHaveLength(1);
    expect(calls2[0]!.kind).toBe('preview');
    endSession(s2.session, 'user-quit');

    const events = EventLog.readLenient(layout.sessionFile(id)).events;
    expect(events.filter((e) => e.type === 'preview.started')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'preview.ended' && e.reason === 'stopped')).toHaveLength(1);
  }, 30_000);
});

describe('preview — real process end-to-end (npm run dev, real HTTP readiness)', () => {
  it('starts a real node http server, observes readiness, stops it cleanly', async () => {
    nodeProject({ dev: 'node server.js' });
    fs.writeFileSync(
      path.join(ws, 'server.js'),
      `const http = require('node:http');
const srv = http.createServer((req, res) => { res.end('hello from fixture'); });
srv.listen(0, '127.0.0.1', () => { console.log('listening on http://127.0.0.1:' + srv.address().port + '/'); });
`,
    );
    const evidence: PreviewEvidence[] = [];
    const ended: { reason: string }[] = [];
    const t = createPreviewTool({
      workspaceRoot: ws,
      projectDir: layout.projectDir,
      sessionId: 'test-session-0001',
      caps: { previewsStarted: 0 },
      appendEnded: (e) => ended.push({ reason: e.reason }),
      detect: detectWorkspace,
    });
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: layout.projectDir, reportPreview: (e) => evidence.push(e) };
    const r = await t.execute({ action: 'start', wait_ms: 45_000 }, ctx);
    expect(r.ok, r.output).toBe(true);
    const ready = evidence.find((e) => e.kind === 'ready');
    expect(ready).toBeDefined();
    // The recorded URL genuinely answers (independent verification, not the tool's own claim).
    const res = await fetch((ready as { url: string }).url);
    expect(await res.text()).toBe('hello from fixture');
    const active = t.active()[0]!;
    expect(fs.existsSync(active.handle.logFile)).toBe(true);
    const stop = await t.execute({ action: 'stop' }, ctx);
    expect(stop.ok).toBe(true);
    await new Promise((r2) => setTimeout(r2, 200));
    expect(ended).toEqual([{ reason: 'stopped' }]);
    expect(active.handle.isAlive()).toBe(false);
    expect(loadPreviewRegistry(previewsFile(layout.projectDir))).toEqual([]);
  }, 60_000);
});

describe('preview script preference is the fixed allowlist', () => {
  it('exposes exactly dev/preview/serve/start', () => {
    expect([...PREVIEW_SCRIPT_PREFERENCE]).toEqual(['dev', 'preview', 'serve', 'start']);
  });
});
