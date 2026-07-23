import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/report/report.js';
import { reconstruct } from '../src/runtime/session.js';
import type { EventBody, SessionEvent, TaskBudget } from '../src/types.js';

/** Delegated-task evidence surfaces: report section, usage separation, reconstruct orphans. */

let seq = 0;
function evt(body: EventBody): SessionEvent {
  return { v: 1, seq: ++seq, ts: 't', ...body } as SessionEvent;
}

const BUDGET: TaskBudget = { maxSteps: 15, timeoutMs: 300_000, maxOutputTokens: 30_000 };

function baseEvents(): SessionEvent[] {
  seq = 0;
  return [
    evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'C:\\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
    evt({ type: 'user.message', text: 'survey' }),
    evt({
      type: 'assistant.message',
      text: 'delegating',
      toolCalls: [{ id: 'call_1', name: 'delegate_task', input: { role: 'explorer', task: 't' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
    evt({ type: 'tool.requested', callId: 'call_1', tool: 'delegate_task', input: { role: 'explorer', task: 't' } }),
    evt({ type: 'policy.decision', callId: 'call_1', classification: 'observe', decision: 'allow', rule: 'task.readonly-role', reason: 'r' }),
    evt({ type: 'task.started', callId: 'call_1', role: 'explorer', childSessionId: 'c-9', budget: BUDGET }),
  ];
}

describe('report: delegated tasks', () => {
  it('renders completed tasks with child pointer and keeps child usage OUT of session totals', () => {
    const events = [
      ...baseEvents(),
      evt({
        type: 'task.ended',
        callId: 'call_1',
        childSessionId: 'c-9',
        status: 'completed',
        steps: 3,
        usage: { inputTokens: 7777, outputTokens: 8888 },
        resultSha256: 'abc',
        durationMs: 5,
      }),
      evt({ type: 'tool.completed', callId: 'call_1', ok: true, outputPreview: 'report…', durationMs: 5, truncated: false }),
      evt({ type: 'session.ended', reason: 'user-quit' }),
    ];
    const { json, md } = buildReport({ events });

    expect(json.tasksDelegated).toHaveLength(1);
    expect(json.tasksDelegated[0]).toMatchObject({ role: 'explorer', childSessionId: 'c-9', status: 'completed', steps: 3 });
    // The parent's own usage comes ONLY from its assistant.message events — never the child's.
    expect(json.session.usage.inputTokens).toBe(100);
    expect(json.session.usage.outputTokens).toBe(20);

    expect(md).toContain('## Delegated tasks (subagents)');
    expect(md).toContain('agent report c-9');
    expect(md).toContain("NOT included in this session's token totals");
    // The labeled COMBINED roll-up (V0.7.1): parent 100/20 + child 7777/8888.
    expect(md).toContain('combined tokens (parent + children): 7877 in / 8908 out');
  });

  it('renders an orphaned task.started honestly and omits the section when no tasks exist', () => {
    const orphan = [...baseEvents(), evt({ type: 'session.ended', reason: 'error', error: 'crash' })];
    const { json, md } = buildReport({ events: orphan });
    expect(json.tasksDelegated[0]).toMatchObject({ status: null });
    expect(md).toContain('STARTED but never completed');

    seq = 0;
    const none = [
      evt({ type: 'session.started', sessionId: 'p', workspaceRoot: 'w', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'session.ended', reason: 'completed' }),
    ];
    const noneReport = buildReport({ events: none });
    expect(noneReport.json.tasksDelegated).toEqual([]);
    expect(noneReport.md).not.toContain('Delegated tasks');
  });
});

describe('report: task changes and integration (V0.7)', () => {
  it('renders captures, applies, refusals, and the never-applied case with honesty footer', () => {
    seq = 0;
    const events = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'w', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({
        type: 'task.changes',
        callId: 'call_1',
        childSessionId: 'c-1',
        baseOid: 'abcdef0123456789',
        files: [
          { relPath: 'a.txt', kind: 'modify', baseSha256: 'b1', blobSha256: 'a1', bytes: 10 },
          { relPath: 'big.bin', kind: 'create', baseSha256: null, blobSha256: null, bytes: 999, oversize: true },
        ],
        omittedCount: 3,
      }),
      evt({
        type: 'task.changes',
        callId: 'call_2',
        childSessionId: 'c-2',
        baseOid: 'abcdef0123456789',
        files: [{ relPath: 'x.txt', kind: 'create', baseSha256: null, blobSha256: 'x1', bytes: 5 }],
      }),
      evt({ type: 'task.applied', callId: 'call_3', childSessionId: 'c-1', applied: ['a.txt'], refused: [{ relPath: 'big.bin', reason: 'oversize' }] }),
      evt({ type: 'session.ended', reason: 'user-quit' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.taskChanges).toEqual([
      { childSessionId: 'c-1', baseOid: 'abcdef0123456789', files: 2, oversize: 1, omitted: 3 },
      { childSessionId: 'c-2', baseOid: 'abcdef0123456789', files: 1, oversize: 0, omitted: 0 },
    ]);
    expect(json.taskApplies).toEqual([{ childSessionId: 'c-1', applied: 1, refused: [{ relPath: 'big.bin', reason: 'oversize' }] }]);
    expect(md).toContain('## Task changes and integration');
    expect(md).toContain('captured from c-1: 2 file change(s)');
    expect(md).toContain('1 REFUSED');
    expect(md).toContain('NOT applied: the 1 captured change(s) from c-2');
    expect(md).toContain('WITHOUT gitignored files');
  });
});

describe('report: plan section (V0.7)', () => {
  it('derives writes, approval, and post-approval divergence purely from events', () => {
    seq = 0;
    const events = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'w', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'plan.updated', callId: 'call_1', planId: 'p-1', sha256: 'aaa1', bytes: 100, prevSha256: null, status: 'draft' }),
      evt({ type: 'plan.approved', planId: 'p-1', sha256: 'bbb2' }),
      evt({ type: 'plan.updated', callId: 'call_2', planId: 'p-1', sha256: 'ccc3', bytes: 120, prevSha256: 'bbb2', status: 'approved' }),
      evt({ type: 'session.ended', reason: 'user-quit' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.plan).toEqual({
      planId: 'p-1',
      updates: 2,
      lastSha256: 'ccc3',
      approvedSha256: 'bbb2',
      discarded: false,
      route: null,
      taskCount: null,
    });
    expect(md).toContain('## Plan');
    expect(md).toContain('APPROVED by the user');
    expect(md).toContain('changed AFTER approval');
  });

  it('routing and the structured graph summary render when the events carry them (Session 11)', () => {
    seq = 0;
    const events = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'w', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'plan.route', mode: 'plan', source: 'model' }),
      evt({
        type: 'plan.updated',
        callId: 'call_1',
        planId: 'p-1',
        sha256: 'aaa1',
        bytes: 100,
        prevSha256: null,
        status: 'draft',
        graph: [
          { id: 't1', role: 'executor', dependsOn: [] },
          { id: 't2', role: 'main', dependsOn: ['t1'] },
        ],
      }),
      evt({ type: 'session.ended', reason: 'user-quit' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.plan).toMatchObject({ route: { mode: 'plan', source: 'model' }, taskCount: 2 });
    expect(md).toContain("routing: plan path (the model's judgment)");
    expect(md).toContain('latest graph has 2 task(s)');
  });

  it('a discarded plan renders honestly; no plan events → no section', () => {
    seq = 0;
    const events = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'w', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'plan.updated', callId: 'call_1', planId: 'p-1', sha256: 'aaa1', bytes: 100, prevSha256: null, status: 'draft' }),
      evt({ type: 'plan.discarded', planId: 'p-1' }),
      evt({ type: 'session.ended', reason: 'user-quit' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.plan).toMatchObject({ discarded: true, approvedSha256: null });
    expect(md).toContain('DISCARDED by the user');
    expect(md).toContain('never approved');

    seq = 0;
    const none = buildReport({
      events: [
        evt({ type: 'session.started', sessionId: 'p', workspaceRoot: 'w', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
        evt({ type: 'session.ended', reason: 'completed' }),
      ],
    });
    expect(none.json.plan).toBeNull();
    expect(none.md).not.toContain('## Plan');
  });
});

describe('reconstruct: crash mid-delegate', () => {
  it('answers the dangling tool_use with the child log pointer and counts it orphaned', () => {
    const events = baseEvents(); // task.started but no task.ended / tool.completed and no crash repair
    const rebuilt = reconstruct(events, 'C:\\ws');
    expect(rebuilt.orphanedCallIds).toEqual(['call_1']);
    const toolResults = rebuilt.messages.at(-1)!;
    const text = JSON.stringify(toolResults.content);
    expect(text).toContain('child session c-9');
    expect(text).toContain('agent report c-9');
    expect(text).toContain('evidence log survives');
  });
});
