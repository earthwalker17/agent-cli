import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  ARTIFACT_BYTES_PER_SESSION,
  artifactBytesFromEvents,
  createBrowserFlowTool,
  NO_SHELL_COMMAND,
  type BrowserToolDeps,
} from '../src/tools/browser-flow.js';
import { createViewImageTool } from '../src/tools/view-image.js';
import { createRunCheckTool, CHECKS_PER_SESSION } from '../src/tools/run-check.js';
import { decide, Grants } from '../src/policy/engine.js';
import { CHECK_KINDS, type CheckEvidence, type BrowserFlowEvidence, type SessionEvent, type Tool, type ToolContext } from '../src/types.js';
import { PlanGraphSchema, validatePlanGraph } from '../src/plan/schema.js';
import { completionGateState } from '../src/plan/graph-state.js';
import { buildReport } from '../src/report/report.js';
import { sha256 } from '../src/shared/hash.js';
import type { FlowRunResult } from '../src/browser/types.js';
import type { ActivePreview } from '../src/tools/preview.js';

let tmp: string;
let ws: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-brtool-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SHOT = Buffer.from('png-bytes-'.repeat(50));
const SHOT_SHA = sha256(SHOT);

function fakePreview(alive = true): ActivePreview {
  return {
    previewId: 'pv-x',
    recipeId: 'preview.script.dev',
    command: 'npm run dev',
    startedAtMs: 0,
    readyObserved: true,
    port: 5199,
    url: 'http://127.0.0.1:5199',
    handle: {
      pid: 1,
      logFile: 'x.log',
      exited: new Promise(() => undefined),
      isAlive: () => alive,
      stop: () => Promise.resolve({ ok: true, detail: '' }),
      tail: () => '',
    },
  };
}

function passResult(over: Partial<FlowRunResult> = {}): FlowRunResult {
  return {
    status: 'pass',
    steps: [{ n: 1, kind: 'goto', target: '/', ok: true }],
    artifacts: [{ kind: 'screenshot', bytes: SHOT, label: 'shot', mediaType: 'image/png' }],
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    offOriginRequests: [],
    finalUrl: 'http://127.0.0.1:5199/',
    durationMs: 10,
    signals: [],
    summary: "flow 'f': pass — 1/1 step(s), 1 screenshot(s)",
    ...over,
  };
}

interface Harness {
  deps: BrowserToolDeps;
  checks: CheckEvidence[];
  flows: BrowserFlowEvidence[];
  blobs: Map<string, Buffer>;
  ctx: ToolContext;
}

function harness(over: Partial<BrowserToolDeps> = {}): Harness {
  const checks: CheckEvidence[] = [];
  const flows: BrowserFlowEvidence[] = [];
  const blobs = new Map<string, Buffer>();
  const deps: BrowserToolDeps = {
    preview: { readyPreview: () => fakePreview() },
    putBlob: (b) => {
      const sha = sha256(b);
      blobs.set(sha, b);
      return sha;
    },
    caps: { checksRun: 0 },
    artifactBudget: { usedBytes: 0 },
    probe: () => Promise.resolve({ available: true, channel: 'msedge' }),
    run: (_spec, deps2) => {
      deps2.onBrowserLaunched?.();
      return Promise.resolve(passResult());
    },
    ...over,
  };
  const ctx: ToolContext = {
    workspaceRoot: ws,
    stateDir: tmp,
    reportCheck: (e) => checks.push(e),
    reportBrowser: (e) => flows.push(e),
  };
  return { deps, checks, flows, blobs, ctx };
}

const FLOW_INPUT = { flow: { name: 'smoke', steps: [{ do: 'goto' as const, path: '/', ready_when: { selector: '#app' } }] } };

describe('browser_flow policy', () => {
  it('preview-bound flows allow under browser.preview-bound; unbound deny; a throwing fact denies', () => {
    const h = harness();
    const t = createBrowserFlowTool(h.deps);
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: tmp };
    expect(decide(t, FLOW_INPUT, ctx, new Grants())).toMatchObject({
      decision: 'allow',
      classification: 'reversible',
      rule: 'browser.preview-bound',
      noUndo: true,
    });

    const none = createBrowserFlowTool(harness({ preview: { readyPreview: () => null } }).deps);
    const d = decide(none, FLOW_INPUT, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'browser.no-preview' });
    expect(d.reason).toContain('RUNNING harness-managed preview');

    const throwing = { ...t, browser: () => { throw new Error('nope'); } } as Tool<typeof FLOW_INPUT>;
    expect(decide(throwing, FLOW_INPUT, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'browser.invalid-contract' });
  });

  it('every fact combination with browser/evidenceRead denies in the first branch that sees it', () => {
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: tmp };
    const wide = z.object({}).passthrough();
    const base = { description: 'x', schema: wide, mutates: () => null, execute: () => Promise.resolve({ ok: true, output: '', durationMs: 0, truncated: false }) };
    const browserFact = () => ({ flowName: 'f', stepCount: 1, previewBound: true });
    const cases: { tool: Tool; rule: string }[] = [
      { tool: { ...base, name: 'a', delegates: () => ({ roles: ['explorer'] }), browser: browserFact } as unknown as Tool, rule: 'task.conflicting-contract' },
      { tool: { ...base, name: 'b', planDoc: () => ({ action: 'update' as const }), browser: browserFact } as unknown as Tool, rule: 'plan.conflicting-contract' },
      { tool: { ...base, name: 'c', check: () => ({ resolved: [] }), browser: browserFact } as unknown as Tool, rule: 'check.conflicting-contract' },
      { tool: { ...base, name: 'd', browser: browserFact, command: () => 'dir' } as unknown as Tool, rule: 'browser.conflicting-contract' },
      { tool: { ...base, name: 'e', browser: browserFact, evidenceRead: () => ({ sha256: 'x' }) } as unknown as Tool, rule: 'browser.conflicting-contract' },
      { tool: { ...base, name: 'f', evidenceRead: () => ({ sha256: 'x' }), command: () => 'dir' } as unknown as Tool, rule: 'evidence.conflicting-contract' },
    ];
    for (const c of cases) {
      expect(decide(c.tool, {}, ctx, new Grants()), c.rule).toMatchObject({ decision: 'deny', rule: c.rule });
    }
  });
});

describe('browser_flow evidence', () => {
  it('emits check.started on real launch + check.completed with the pinned field scheme + browser.flow detail', async () => {
    const h = harness();
    const t = createBrowserFlowTool(h.deps);
    const r = await t.execute(FLOW_INPUT, h.ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`objects/${SHOT_SHA}`);

    const started = h.checks.find((e) => e.kind === 'started')!;
    expect(started).toMatchObject({ check: 'browser', recipeId: 'browser.flow/smoke', command: NO_SHELL_COMMAND });
    const ended = h.checks.find((e) => e.kind === 'ended')!;
    expect(ended).toMatchObject({ check: 'browser', recipeId: 'browser.flow/smoke', status: 'pass', exitCode: null });
    expect('termination' in ended).toBe(false); // ALWAYS absent — no process exit exists

    expect(h.flows).toHaveLength(1);
    expect(h.flows[0]!.artifacts).toEqual([{ kind: 'screenshot', sha256: SHOT_SHA, bytes: SHOT.length, label: 'shot', mediaType: 'image/png' }]);
    expect(h.blobs.has(SHOT_SHA)).toBe(true);
    expect(h.deps.caps.checksRun).toBe(1);
    expect(h.deps.artifactBudget.usedBytes).toBe(SHOT.length);
  });

  it('a preview death between gate and execute is a typed ERROR with preview-died — never a pass, never a started', async () => {
    const h = harness({ preview: { readyPreview: () => null } });
    const t = createBrowserFlowTool(h.deps);
    const r = await t.execute(FLOW_INPUT, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('preview died');
    expect(h.checks.filter((e) => e.kind === 'started')).toHaveLength(0);
    expect(h.checks[0]).toMatchObject({ kind: 'ended', status: 'error', signals: ['preview-died'] });
    // Budget symmetry: this completed row counts in checkCapsFromEvents on resume, so the live
    // counter must count it too — otherwise resuming silently shrinks the budget.
    expect(h.deps.caps.checksRun).toBe(1);
  });

  it('an already-aborted turn refuses the call: nothing launched, nothing recorded', async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness();
    const t = createBrowserFlowTool(h.deps);
    const r = await t.execute(FLOW_INPUT, { ...h.ctx, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('turn aborted');
    expect(h.checks).toHaveLength(0);
    expect(h.deps.caps.checksRun).toBe(0);
  });

  it('no launchable browser yields unsupported/precondition (the gate-waiving form) and no budget burn', async () => {
    const h = harness({ probe: () => Promise.resolve({ available: false, reason: 'no browser anywhere' }) });
    const t = createBrowserFlowTool(h.deps);
    const r = await t.execute(FLOW_INPUT, h.ctx);
    expect(r.ok).toBe(false);
    expect(h.checks[0]).toMatchObject({ kind: 'ended', status: 'unsupported', unsupportedReason: 'precondition' });
    expect(h.deps.caps.checksRun).toBe(0);
  });

  it('budget refusals spawn nothing and record nothing', async () => {
    const h = harness({ caps: { checksRun: CHECKS_PER_SESSION } });
    const t = createBrowserFlowTool(h.deps);
    const r = await t.execute(FLOW_INPUT, h.ctx);
    expect(r.error).toContain('check budget');
    expect(h.checks).toHaveLength(0);

    const h2 = harness({ artifactBudget: { usedBytes: ARTIFACT_BYTES_PER_SESSION } });
    const r2 = await createBrowserFlowTool(h2.deps).execute(FLOW_INPUT, h2.ctx);
    expect(r2.error).toContain('artifact budget');
    expect(h2.checks).toHaveLength(0);
  });

  it('an over-budget trace is dropped with its size recorded, never silently', async () => {
    const bigTrace = Buffer.alloc(1024, 7);
    const h = harness({
      artifactBudget: { usedBytes: ARTIFACT_BYTES_PER_SESSION - SHOT.length - 10 }, // room for the shot, not the trace
      run: (_s, d2) => {
        d2.onBrowserLaunched?.();
        return Promise.resolve(passResult({ artifacts: [{ kind: 'screenshot', bytes: SHOT, label: 'shot', mediaType: 'image/png' }, { kind: 'trace', bytes: bigTrace, label: 't', mediaType: 'application/zip' }] }));
      },
    });
    const r = await createBrowserFlowTool(h.deps).execute(FLOW_INPUT, h.ctx);
    expect(r.output).toContain('trace NOT stored');
    expect(h.flows[0]!.traceOmittedBytes).toBe(bigTrace.length);
    expect(h.flows[0]!.artifacts.map((a) => a.kind)).toEqual(['screenshot']);
  });

  it('artifactBytesFromEvents rebuilds the budget from browser.flow events', () => {
    const events = [
      { type: 'browser.flow', artifacts: [{ bytes: 100 }, { bytes: 50 }] },
      { type: 'browser.flow', artifacts: [] },
      { type: 'preview.started' },
    ] as unknown as SessionEvent[];
    expect(artifactBytesFromEvents(events)).toBe(150);
  });
});

describe('view_image — the sha bound is a security boundary', () => {
  const flowEvent = (artifacts: { kind: string; sha256: string; bytes: number; label: string; mediaType: string }[]): SessionEvent =>
    ({ v: 1, seq: 1, ts: 't', type: 'browser.flow', callId: 'c1', flowName: 'smoke', previewId: 'pv-x', status: 'pass', steps: [], artifacts, consoleErrors: [], pageErrors: [], failedRequests: [], offOriginRequests: [], finalUrl: null }) as unknown as SessionEvent;

  it('returns the image for a recorded screenshot sha; refuses everything else', async () => {
    const spillSha = sha256(Buffer.from('spilled command output'));
    const traceSha = sha256(Buffer.from('trace-zip'));
    const t = createViewImageTool({
      getBlob: (sha) => (sha === SHOT_SHA ? SHOT : Buffer.from('secret bytes the model must not see')),
      events: () => [
        flowEvent([
          { kind: 'screenshot', sha256: SHOT_SHA, bytes: SHOT.length, label: 'shot', mediaType: 'image/png' },
          { kind: 'trace', sha256: traceSha, bytes: 9, label: 't', mediaType: 'application/zip' },
        ]),
      ],
    });
    const ctx: ToolContext = { workspaceRoot: ws, stateDir: tmp };

    const ok = await t.execute({ sha256: SHOT_SHA }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.images).toHaveLength(1);
    expect(ok.images![0]).toMatchObject({ sha256: SHOT_SHA, mediaType: 'image/png', label: 'shot' });

    // A sha that exists in the blob store but was NEVER a browser artifact — the spill/snapshot
    // class — is refused: the store holds bytes deliberately withheld from the model.
    const spill = await t.execute({ sha256: spillSha }, ctx);
    expect(spill.ok).toBe(false);
    expect(spill.output).toContain('deliberately not model-readable');

    const trace = await t.execute({ sha256: traceSha }, ctx);
    expect(trace.ok).toBe(false);
    expect(trace.output).toContain('trace zip');
  });

  it('the DECISION RECORD is honest: an admitted sha allows; an un-admitted sha DENIES at the gate', () => {
    const admittedTool = createViewImageTool({
      getBlob: () => SHOT,
      events: () => [flowEvent([{ kind: 'screenshot', sha256: SHOT_SHA, bytes: SHOT.length, label: 'shot', mediaType: 'image/png' }])],
    });
    const d = decide(admittedTool, { sha256: SHOT_SHA }, { workspaceRoot: ws, stateDir: tmp }, new Grants());
    expect(d).toMatchObject({ decision: 'allow', classification: 'observe', rule: 'observe.session-evidence' });
    expect(d.reason).toContain('image evidence this session recorded');

    // No such artifact: the gate itself refuses, so the log never carries an "allowed re-read"
    // record for bytes the tool would have refused (the honest-record rule).
    const bareTool = createViewImageTool({ getBlob: () => SHOT, events: () => [] });
    const deny = decide(bareTool, { sha256: SHOT_SHA }, { workspaceRoot: ws, stateDir: tmp }, new Grants());
    expect(deny).toMatchObject({ decision: 'deny', rule: 'evidence.not-session-artifact' });
    expect(deny.reason).toContain('deliberately not model-readable');
  });
});

describe('origin lock is a REAL origin comparison', () => {
  it('a port-prefix is not the same origin; unparsable URLs fail closed', async () => {
    const { isSameOrigin } = await import('../src/browser/flow.js');
    expect(isSameOrigin('http://127.0.0.1:3000/app', 'http://127.0.0.1:3000')).toBe(true);
    expect(isSameOrigin('http://127.0.0.1:30001/admin', 'http://127.0.0.1:3000')).toBe(false); // the startsWith trap
    expect(isSameOrigin('https://127.0.0.1:3000/', 'http://127.0.0.1:3000')).toBe(false);
    expect(isSameOrigin('not a url', 'http://127.0.0.1:3000')).toBe(false);
  });
});

describe('kind wiring pins', () => {
  it("CHECK_KINDS is append-only with 'browser' last; run_check's enum deliberately excludes it", () => {
    expect(CHECK_KINDS).toEqual(['build', 'test', 'test-targeted', 'typecheck', 'lint', 'format', 'static-analysis', 'browser']);
    const rc = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    expect(rc.schema.safeParse({ checks: ['browser'] }).success).toBe(false);
    expect(rc.schema.safeParse({ checks: ['test'] }).success).toBe(true);
  });

  it("plan schema accepts 'browser' in checks and gates; a browser pass satisfies the completion gate; unsupported/precondition waives", () => {
    const graph = validatePlanGraph(
      PlanGraphSchema.parse({
        objective: 'o',
        gates: { completion: ['browser'] },
        tasks: [{ id: 'a', title: 'A', intent: 'i', role: 'main', verify: 'v' }],
      }),
    ).graph!;
    const ev = (seq: number, body: Record<string, unknown>): SessionEvent => ({ v: 1, seq, ts: 't', ...body }) as unknown as SessionEvent;

    const pending = completionGateState(graph, [ev(1, { type: 'file.mutated', callId: 'c', path: 'x', kind: 'modify', beforeSha256: null, afterSha256: 'a', createdDirs: [] })]);
    expect(pending?.pending).toEqual(['browser']);

    const passed = completionGateState(graph, [
      ev(1, { type: 'file.mutated', callId: 'c', path: 'x', kind: 'modify', beforeSha256: null, afterSha256: 'a', createdDirs: [] }),
      ev(2, { type: 'check.completed', callId: 'c2', check: 'browser', recipeId: 'browser.flow/smoke', status: 'pass', exitCode: null, durationMs: 5, summary: 's' }),
    ]);
    expect(passed?.pending).toEqual([]);

    const waived = completionGateState(graph, [
      ev(1, { type: 'file.mutated', callId: 'c', path: 'x', kind: 'modify', beforeSha256: null, afterSha256: 'a', createdDirs: [] }),
      ev(2, { type: 'check.completed', callId: 'c2', check: 'browser', recipeId: '(none)', status: 'unsupported', unsupportedReason: 'precondition', exitCode: null, durationMs: 0, summary: 'no browser' }),
    ]);
    expect(waived?.pending).toEqual([]);
    expect(waived?.waived).toEqual(['browser']);
  });

  it('a browser pass NEVER makes a file CHECKED (structural: exitCode null fails the exit-0 rule)', () => {
    const ev = (seq: number, body: Record<string, unknown>): SessionEvent => ({ v: 1, seq, ts: 't', ...body }) as unknown as SessionEvent;
    const events = [
      ev(1, { type: 'session.started', workspaceRoot: ws, model: 'm', mode: 'non-interactive', argv: [] }),
      ev(2, { type: 'tool.requested', callId: 'w1', tool: 'write_file', inputPreview: '' }),
      ev(3, { type: 'file.mutated', callId: 'w1', path: path.join(ws, 'a.ts'), kind: 'create', beforeSha256: null, afterSha256: 'x', createdDirs: [] }),
      ev(4, { type: 'tool.completed', callId: 'w1', ok: true, outputPreview: '', durationMs: 1, truncated: false }),
      ev(5, { type: 'check.completed', callId: 'c1', check: 'browser', recipeId: 'browser.flow/smoke', status: 'pass', exitCode: null, durationMs: 5, summary: 'pass' }),
    ];
    const { json } = buildReport({ events });
    expect(json.filesChanged).toHaveLength(1);
    expect(json.filesChanged[0]!.checked).toBe(false); // a flow pass verifies behavior, not this file
  });
});
