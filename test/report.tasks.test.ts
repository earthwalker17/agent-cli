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
