import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSubagentTask, type SubagentDeps } from '../src/runtime/subagent.js';
import { createDelegateTool } from '../src/tools/delegate.js';
import { EventLog } from '../src/store/event-log.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import type { SubagentRoleName, TaskEvidence } from '../src/types.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * Session 11 supervision: bounded harness-side detection (loop, budget pressure, stall) with
 * honest annotation-before-intervention, the task-scoped cancellation seam, and the group
 * digest that survives head-biased truncation. All deterministic through the mock provider.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;
const MAP: WorkspaceMap = { text: 'a.txt\nb.txt\n', fileCount: 2, truncated: false, sha256: 'map-x' };

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-sup-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'beta\n');
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeDeps(script: ScriptTurn[], over: Partial<SubagentDeps> = {}): { deps: SubagentDeps; evidence: TaskEvidence[] } {
  const evidence: TaskEvidence[] = [];
  const deps: SubagentDeps = {
    layout,
    workspaceRoot: ws,
    model: 'mock',
    maxTokens: 1000,
    provider: new MockProvider(script),
    map: MAP,
    reportTask: (e) => evidence.push(e),
    ...over,
  };
  return { deps, evidence };
}

const READ_A = { name: 'read_file', input: { path: 'a.txt' } };
const READ_B = { name: 'read_file', input: { path: 'b.txt' } };

describe('loop detection: annotate at 3, cancel at 5', () => {
  it('five identical consecutive calls annotate then auto-cancel as stalled', async () => {
    const script: ScriptTurn[] = [
      ...Array.from({ length: 6 }, () => ({ say: 'looking', calls: [READ_A] })),
      { say: 'never reached' },
    ];
    const { deps, evidence } = makeDeps(script);
    const r = await runSubagentTask(deps, { role: 'explorer', task: 'inspect', parentSessionId: 'p' });

    expect(r.status).toBe('stalled');
    const loops = r.supervision.filter((s) => s.what === 'loop');
    expect(loops).toHaveLength(2); // one annotation at 3, one at the hard cancel
    expect(loops[0]!.detail).toContain('3 identical consecutive read_file calls');
    expect(loops[1]!.detail).toContain('auto-cancelled at 5');
    // The dual surface: the same observations were persisted through the evidence channel.
    expect(evidence.filter((e) => e.kind === 'supervision' && e.what === 'loop')).toHaveLength(2);
    const ended = evidence.find((e) => e.kind === 'ended');
    expect(ended).toMatchObject({ status: 'stalled' });
    // The child log honestly ends as aborted (the child only ever sees the abort).
    expect(EventLog.readLenient(layout.sessionFile(r.childSessionId)).events.at(-1)).toMatchObject({ reason: 'aborted' });
  });

  it('varying calls never trip the loop detector', async () => {
    const script: ScriptTurn[] = [
      { say: '1', calls: [READ_A] },
      { say: '2', calls: [READ_B] },
      { say: '3', calls: [READ_A] },
      { say: '4', calls: [READ_B] },
      { say: 'report: alternating reads are legitimate' },
    ];
    const { deps } = makeDeps(script);
    const r = await runSubagentTask(deps, { role: 'explorer', task: 'inspect', parentSessionId: 'p' });
    expect(r.status).toBe('completed');
    expect(r.supervision.filter((s) => s.what === 'loop')).toHaveLength(0);
  });
});

describe('budget pressure: one annotation at 80%, the cap still cancels', () => {
  it('token pressure fires ONCE at >=80% and the cap intervention still lands', async () => {
    const script: ScriptTurn[] = [
      { say: 'step 1', usage: { inputTokens: 0, outputTokens: 45 }, calls: [READ_A] },
      { say: 'step 2', usage: { inputTokens: 0, outputTokens: 45 }, calls: [READ_B] },
      { say: 'step 3', usage: { inputTokens: 0, outputTokens: 30 }, calls: [READ_A] },
      { say: 'never reached' },
    ];
    const { deps, evidence } = makeDeps(script, { budget: { maxOutputTokens: 100 } });
    const r = await runSubagentTask(deps, { role: 'explorer', task: 'inspect', parentSessionId: 'p' });

    expect(r.status).toBe('budget-tokens');
    const pressure = r.supervision.filter((s) => s.what === 'budget-pressure');
    expect(pressure).toHaveLength(1); // 90/100 → one annotation; 120 → the existing cancel
    expect(pressure[0]!.detail).toContain('90%');
    expect(evidence.find((e) => e.kind === 'ended')).toMatchObject({ status: 'budget-tokens' });
  });
});

describe('stall and wall pressure (scaled thresholds; production constants at real budgets)', () => {
  it('a silent child records one stall observation and wall pressure before the timeout', async () => {
    const { deps } = makeDeps([{ hang: true } as ScriptTurn], { budget: { timeoutMs: 500 } });
    const r = await runSubagentTask(deps, { role: 'explorer', task: 'inspect', parentSessionId: 'p' });

    expect(r.status).toBe('timeout');
    expect(r.supervision.filter((s) => s.what === 'stall')).toHaveLength(1);
    expect(r.supervision.filter((s) => s.what === 'budget-pressure')).toHaveLength(1);
    expect(r.supervision.find((s) => s.what === 'budget-pressure')!.detail).toContain('wall clock');
  });
});

describe('a command IN FLIGHT is working, not stalled (Session 16)', () => {
  /**
   * The chain fires on appended events, so a legitimate five-minute install inside an executor
   * looked exactly like a hung child and recorded a `stall` the reader had to learn to ignore.
   * Both directions matter: suppressed while a spawn is open, still recorded when genuinely idle.
   */
  const SLOW = { name: 'run_command', input: { command: 'node -e "setTimeout(()=>{},700)"', timeoutMs: 5000 } };

  it('records NO stall while a real command is running', async () => {
    const { deps } = makeDeps([{ say: 'installing', calls: [SLOW] }, { hang: true } as ScriptTurn], {
      budget: { timeoutMs: 900 },
      // An executor's asks FORWARD; without a forwarder it fails closed and the command never
      // spawns — which is what made the first version of this test pass for the wrong reason.
      forwardAsk: async () => ({ decision: 'allow', scope: 'once', source: 'user' }),
    });
    const r = await runSubagentTask(deps, { role: 'executor', task: 'install', parentSessionId: 'p' });
    expect(r.supervision.filter((s) => s.what === 'stall')).toHaveLength(0);
  }, 30_000);

  it('still records a stall for a child that is genuinely idle', async () => {
    const { deps } = makeDeps([{ hang: true } as ScriptTurn], { budget: { timeoutMs: 500 } });
    const r = await runSubagentTask(deps, { role: 'explorer', task: 'inspect', parentSessionId: 'p' });
    expect(r.supervision.filter((s) => s.what === 'stall')).toHaveLength(1);
  }, 30_000);
});

describe('task-scoped cancellation (the registerCancel seam)', () => {
  it('/cancel-style invocation ends THIS child as cancelled, with evidence and cleanup', async () => {
    let handle: (() => void) | null = null;
    let registeredId = '';
    let unregistered = false;
    const { deps, evidence } = makeDeps([{ hang: true } as ScriptTurn], {
      budget: { timeoutMs: 30_000 },
      registerCancel: (childSessionId, cancel) => {
        registeredId = childSessionId;
        handle = cancel;
        return () => {
          unregistered = true;
        };
      },
    });
    const run = runSubagentTask(deps, { role: 'explorer', task: 'inspect', parentSessionId: 'p' });
    await new Promise((res) => setTimeout(res, 50));
    expect(handle).not.toBeNull();
    handle!();
    const r = await run;

    expect(r.status).toBe('cancelled');
    expect(r.childSessionId).toBe(registeredId);
    expect(unregistered).toBe(true);
    expect(r.supervision.find((s) => s.what === 'cancelled')?.detail).toContain('/cancel');
    expect(evidence.find((e) => e.kind === 'ended')).toMatchObject({ status: 'cancelled' });
    expect(evidence.some((e) => e.kind === 'supervision' && e.what === 'cancelled')).toBe(true);
    expect(EventLog.readLenient(layout.sessionFile(r.childSessionId)).events.at(-1)).toMatchObject({ reason: 'aborted' });
  });
});

describe('the group digest survives truncation', () => {
  it('a huge child report cannot push statuses out of the model-visible head', async () => {
    const deps: SubagentDeps = {
      layout,
      workspaceRoot: ws,
      model: 'mock',
      maxTokens: 1000,
      provider: new MockProvider([{ say: 'unused' }]),
      map: MAP,
      providerForTask: (_i: number, _r: SubagentRoleName) => new MockProvider([{ say: 'X'.repeat(30_000) }]),
    };
    const tool = createDelegateTool(deps, 'parent-x');
    const r = await tool.execute(
      { tasks: [{ role: 'explorer', task: 'produce a huge report' }] } as never,
      { workspaceRoot: ws, stateDir: layout.projectDir },
    );
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    const head = r.output.slice(0, 400);
    expect(head).toContain('group digest:');
    expect(head).toContain('COMPLETED');
  });
});
