import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { runSubagentTask, TASKS_PER_SESSION, type SubagentDeps } from '../src/runtime/subagent.js';
import { createDelegateTool } from '../src/tools/delegate.js';
import { TOOLS } from '../src/tools/index.js';
import { latestSessionId } from '../src/cli/context.js';
import { EventLog } from '../src/store/event-log.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import { sha256 } from '../src/shared/hash.js';
import type { Tool } from '../src/types.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * Subagent primitives end to end: parent and child are SEPARATELY scripted MockProviders; the
 * child runs the same runTurn under a read-only registry, auto-deny approvals, its own log, and
 * a fixed budget; lineage joins through the runtime-bound callId + the child session id.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;
const MAP: WorkspaceMap = { text: 'a.txt\n', fileCount: 1, truncated: false, sha256: 'map-x' };

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function subagentDeps(childScript: ScriptTurn[], overrides: Partial<SubagentDeps> = {}): SubagentDeps {
  return {
    layout,
    workspaceRoot: ws,
    model: 'mock-child',
    maxTokens: 1000,
    provider: new MockProvider(childScript),
    map: MAP,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
    ...overrides,
  };
}

/** Mirrors assembly: start the parent, THEN attach a delegate tool bound to its real id. */
function makeParent(parentScript: ScriptTurn[], childDeps: SubagentDeps): Session {
  const parent = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-parent',
    mode: 'non-interactive',
    provider: new MockProvider(parentScript),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
  parent.tools = [createDelegateTool(childDeps, parent.id) as Tool];
  return parent;
}

const DELEGATE_CALL = {
  name: 'delegate_task',
  input: { tasks: [{ role: 'explorer', task: 'Survey the workspace and report what a.txt contains.' }] },
};

describe('delegate_task end to end', () => {
  it('happy path: lineage, callId join, resultSha256, isolated parent context', async () => {
    const childFinal = 'REPORT: a.txt contains "hello" (read_file a.txt).';
    const parent = makeParent(
      [{ say: 'delegating', calls: [DELEGATE_CALL] }, { say: 'summary for user' }],
      subagentDeps([
        { say: 'reading', calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
        { say: childFinal, usage: { inputTokens: 2, outputTokens: 9 } },
      ]),
    );
    const result = await runTurn(parent, 'survey via subagent');
    endSession(parent, 'completed');

    // Parent evidence order, all under the same runtime callId.
    const types: string[] = parent.log.events.map((e) => e.type);
    const order = ['tool.requested', 'policy.decision', 'task.started', 'task.ended', 'tool.completed'];
    const idx = order.map((t) => types.indexOf(t));
    expect(idx.every((v, i) => v > 0 && (i === 0 || v > idx[i - 1]!)), `order ${JSON.stringify(types)}`).toBe(true);
    const requested = parent.log.events.find((e) => e.type === 'tool.requested')!;
    const started = parent.log.events.find((e) => e.type === 'task.started')!;
    const ended = parent.log.events.find((e) => e.type === 'task.ended')!;
    const decision = parent.log.events.find((e) => e.type === 'policy.decision')!;
    expect(decision).toMatchObject({ decision: 'allow', rule: 'task.readonly-role' });
    expect(started.type === 'task.started' && requested.type === 'tool.requested' && started.callId === requested.callId).toBe(true);
    // steps counts completed tool-loop iterations (a call-turn + the final turn = 1).
    expect(ended).toMatchObject({ status: 'completed', steps: 1, usage: { inputTokens: 2, outputTokens: 9 } });
    expect(ended.type === 'task.ended' ? ended.resultSha256 : '').toBe(sha256(Buffer.from(childFinal, 'utf8')));

    // The child transcript never enters the parent history — only the one result block.
    expect(parent.log.events.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(parent.log.events.filter((e) => e.type === 'user.message').every((e) => e.type === 'user.message' && !e.text.includes('Delegated task'))).toBe(true);
    expect(result.finalText).toBe('summary for user');

    // Child log: lineage, clean end, and the report's provenance label reached the parent model.
    const childId = started.type === 'task.started' ? started.childSessionId : '';
    const child = EventLog.readLenient(layout.sessionFile(childId));
    const childStart = child.events.find((e) => e.type === 'session.started');
    expect(childStart).toMatchObject({ lineage: { parentSessionId: parent.id, role: 'explorer' } });
    expect(child.events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'completed' });
    const toolResultMsg = parent.messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes('subagent report begin'));
    expect(toolResultMsg).toBeDefined();
    expect(JSON.stringify(toolResultMsg!.content)).toContain('NOT verified evidence');

    // The newest MAIN session is still the parent, even though the child log sorts newer.
    expect(latestSessionId(layout)).toBe(parent.id);
    // The static registry stays pure.
    expect(TOOLS.some((t) => t.name === 'delegate_task')).toBe(false);
  });

  it('child cannot write and cannot escalate: write_file is unknown, run_command auto-denies', async () => {
    const deps = subagentDeps([
      {
        say: 'trying',
        calls: [
          { name: 'write_file', input: { path: 'evil.txt', content: 'x' } },
          { name: 'run_command', input: { command: 'npm test' } },
        ],
      },
      { say: 'report: could not write (no tool), command denied' },
    ]);
    const result = await runSubagentTask(deps, { role: 'explorer', task: 't', parentSessionId: 'p-1' });
    expect(result.status).toBe('completed');

    const child = EventLog.readLenient(layout.sessionFile(result.childSessionId)).events;
    const completions = child.filter((e) => e.type === 'tool.completed');
    expect(completions[0]).toMatchObject({ ok: false }); // unknown tool: write_file
    expect(child.find((e) => e.type === 'approval.resolved')).toMatchObject({ decision: 'deny', source: 'non-interactive' });
    expect(child.some((e) => e.type === 'file.mutated')).toBe(false);
    expect(fs.existsSync(path.join(ws, 'evil.txt'))).toBe(false);
    // The child registry never contained the delegate tool (depth 1 by construction): the child
    // log records only read-only tool names in tool.requested events.
    const requestedTools = child.filter((e) => e.type === 'tool.requested').map((e) => (e.type === 'tool.requested' ? e.tool : ''));
    expect(requestedTools).not.toContain('delegate_task');
  });

  it('budget matrix: steps / tokens / timeout / parent abort map to distinct statuses and child reasons', async () => {
    // Steps: two tool-calling turns against maxSteps 2.
    const steps = await runSubagentTask(
      subagentDeps(
        [
          { say: '1', calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
          { say: '2', calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
        ],
        { budget: { maxSteps: 2 } },
      ),
      { role: 'explorer', task: 't', parentSessionId: 'p' },
    );
    expect(steps.status).toBe('budget-steps');
    expect(EventLog.readLenient(layout.sessionFile(steps.childSessionId)).events.at(-1)).toMatchObject({ reason: 'max-steps' });

    // Output tokens: one huge turn against a 1k cap → aborted mid-turn as budget-tokens.
    const tokens = await runSubagentTask(
      subagentDeps(
        [{ say: 'huge', usage: { inputTokens: 1, outputTokens: 5000 }, calls: [{ name: 'read_file', input: { path: 'a.txt' } }] }],
        { budget: { maxOutputTokens: 1000 } },
      ),
      { role: 'explorer', task: 't', parentSessionId: 'p' },
    );
    expect(tokens.status).toBe('budget-tokens');
    expect(EventLog.readLenient(layout.sessionFile(tokens.childSessionId)).events.at(-1)).toMatchObject({ reason: 'budget' });

    // Wall clock: a hanging child against a tiny timeout.
    const timeout = await runSubagentTask(
      subagentDeps([{ say: 'hanging', hang: true }], { budget: { timeoutMs: 40 } }),
      { role: 'explorer', task: 't', parentSessionId: 'p' },
    );
    expect(timeout.status).toBe('timeout');
    expect(EventLog.readLenient(layout.sessionFile(timeout.childSessionId)).events.at(-1)).toMatchObject({ reason: 'budget' });

    // Parent abort cascades into the child.
    const controller = new AbortController();
    const pending = runSubagentTask(
      subagentDeps([{ say: 'hanging', hang: true }]),
      { role: 'explorer', task: 't', parentSessionId: 'p' },
      controller.signal,
    );
    controller.abort();
    const aborted = await pending;
    expect(aborted.status).toBe('aborted');
    expect(EventLog.readLenient(layout.sessionFile(aborted.childSessionId)).events.at(-1)).toMatchObject({ reason: 'aborted' });
  });

  it('caps delegation at TASKS_PER_SESSION, group-atomically; the refusal spawns nothing', async () => {
    const childScript: ScriptTurn[] = Array.from({ length: TASKS_PER_SESSION }, () => ({ say: 'ok' }));
    const tool = createDelegateTool(subagentDeps(childScript), 'p-1');
    const ctx = { workspaceRoot: ws, stateDir: layout.projectDir };
    for (let i = 0; i < TASKS_PER_SESSION - 1; i++) {
      const r = await tool.execute({ tasks: [{ role: 'explorer', task: `t${i}` }] }, ctx);
      expect(r.ok, `task ${i}`).toBe(true);
    }
    const before = fs.readdirSync(layout.sessionsDir).filter((f) => f.endsWith('.jsonl')).length;
    // One slot remains: a TWO-task group must be refused WHOLE (never a silent partial start)…
    const overflow = await tool.execute({ tasks: [{ role: 'explorer', task: 'a' }, { role: 'explorer', task: 'b' }] }, ctx);
    expect(overflow.ok).toBe(false);
    expect(overflow.error).toContain('task budget exhausted');
    expect(fs.readdirSync(layout.sessionsDir).filter((f) => f.endsWith('.jsonl')).length).toBe(before);
    // …while a single task still fits, and the next one is refused.
    const last = await tool.execute({ tasks: [{ role: 'explorer', task: 'last' }] }, ctx);
    expect(last.ok).toBe(true);
    const over = await tool.execute({ tasks: [{ role: 'explorer', task: 'one too many' }] }, ctx);
    expect(over.ok).toBe(false);
  });

  it('runs a parallel group: per-child providers, distinct child logs, one callId, group report', async () => {
    const scripts: ScriptTurn[][] = [
      [{ say: 'REPORT ONE', usage: { inputTokens: 1, outputTokens: 11 } }],
      [{ say: 'REPORT TWO', usage: { inputTokens: 2, outputTokens: 22 } }],
      [{ say: 'REPORT THREE', usage: { inputTokens: 3, outputTokens: 33 } }],
    ];
    const deps = subagentDeps([{ say: 'unused fallback' }], {
      providerForTask: (index) => new MockProvider(scripts[index]!),
    });
    const parent = makeParent(
      [
        {
          say: 'fanning out',
          calls: [
            {
              name: 'delegate_task',
              input: {
                tasks: [
                  { role: 'explorer', task: 'part one' },
                  { role: 'planner', task: 'part two', context: 'notes from the parent' },
                  { role: 'reviewer', task: 'part three' },
                ],
              },
            },
          ],
        },
        { say: 'combined summary' },
      ],
      deps,
    );
    const result = await runTurn(parent, 'go wide');
    endSession(parent, 'completed');
    expect(result.finalText).toBe('combined summary');

    const startedEvents = parent.log.events.filter((e) => e.type === 'task.started');
    const endedEvents = parent.log.events.filter((e) => e.type === 'task.ended');
    expect(startedEvents).toHaveLength(3);
    expect(endedEvents).toHaveLength(3);
    // One callId spans the whole group; childSessionId is the disambiguating join key.
    const callIds = new Set(startedEvents.map((e) => (e.type === 'task.started' ? e.callId : '')));
    expect(callIds.size).toBe(1);
    const childIds = startedEvents.map((e) => (e.type === 'task.started' ? e.childSessionId : ''));
    expect(new Set(childIds).size).toBe(3);
    expect(startedEvents.map((e) => (e.type === 'task.started' ? e.role : ''))).toEqual(['explorer', 'planner', 'reviewer']);

    // Every child has its own lineage-stamped, cleanly-ended log.
    for (const childId of childIds) {
      const child = EventLog.readLenient(layout.sessionFile(childId));
      expect(child.events.find((e) => e.type === 'session.started')).toMatchObject({ lineage: { parentSessionId: parent.id } });
      expect(child.events.at(-1)).toMatchObject({ type: 'session.ended', reason: 'completed' });
    }

    // The single tool_result carries all three labeled reports in task order.
    const toolResultMsg = parent.messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes('subagent group'));
    const text = JSON.stringify(toolResultMsg!.content);
    expect(text).toContain('3 tasks ran in parallel');
    for (const marker of ['REPORT ONE', 'REPORT TWO', 'REPORT THREE']) expect(text).toContain(marker);
    expect(text).toContain('NOT verified evidence');
    // The planner child received the parent-provided context verbatim in its delegation prompt.
    const plannerChild = EventLog.readLenient(layout.sessionFile(childIds[1]!));
    const plannerUserMsg = plannerChild.events.find((e) => e.type === 'user.message');
    expect(plannerUserMsg && plannerUserMsg.type === 'user.message' ? plannerUserMsg.text : '').toContain('notes from the parent');
  });

  it('parent abort mid-group cancels every child and the parent log stays complete', async () => {
    const deps = subagentDeps([{ say: 'unused' }], {
      providerForTask: () => new MockProvider([{ say: 'hanging', hang: true }]),
    });
    const parent = makeParent(
      [
        {
          say: 'fanning out',
          calls: [
            {
              name: 'delegate_task',
              input: { tasks: [{ role: 'explorer', task: 'a' }, { role: 'explorer', task: 'b' }] },
            },
          ],
        },
      ],
      deps,
    );
    const controller = new AbortController();
    const pending = runTurn(parent, 'go', { signal: controller.signal });
    await waitFor(() => parent.log.events.filter((e) => e.type === 'task.started').length === 2);
    controller.abort();
    const result = await pending;
    endSession(parent, 'aborted');

    expect(result.aborted).toBe(true);
    const ended = parent.log.events.filter((e) => e.type === 'task.ended');
    expect(ended).toHaveLength(2);
    for (const e of ended) expect(e).toMatchObject({ status: 'aborted' });
    expect(parent.log.events.map((e) => e.type)).toContain('turn.aborted');
  });

  it('parent aborted mid-child leaves a complete parent log (task.ended + tool.completed + turn.aborted)', async () => {
    const parent = makeParent([{ say: 'delegating', calls: [DELEGATE_CALL] }], subagentDeps([{ say: 'hanging', hang: true }]));
    const controller = new AbortController();
    const pending = runTurn(parent, 'go', { signal: controller.signal });
    // Abort once the child is actually running (its task.started reached the parent log).
    await waitFor(() => parent.log.events.some((e) => e.type === 'task.started'));
    controller.abort();
    const result = await pending;
    endSession(parent, 'aborted');

    expect(result.aborted).toBe(true);
    const types = parent.log.events.map((e) => e.type);
    for (const t of ['task.started', 'task.ended', 'tool.completed', 'turn.aborted']) {
      expect(types, `missing ${t}`).toContain(t);
    }
    expect(parent.log.events.find((e) => e.type === 'task.ended')).toMatchObject({ status: 'aborted' });
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
