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

describe('report: Session 11.5 surfaces (completion, task-base checkpoints, spill pointers, retirement)', () => {
  it('## Completion renders the LATEST acceptance with its unfinished list', () => {
    seq = 0;
    const events: SessionEvent[] = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'C:\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'session.accepted', complete: false, summary: '2 unfinished — plan 1/3 completed', unfinished: ["plan task 't2' is failed", '1 captured file(s) from task c-99 not applied'] }),
      evt({ type: 'session.ended', reason: 'user-quit' }),
    ];
    const r = buildReport({ events });
    expect(r.json.accepted).toEqual({
      complete: false,
      summary: '2 unfinished — plan 1/3 completed',
      unfinished: ["plan task 't2' is failed", '1 captured file(s) from task c-99 not applied'],
    });
    expect(r.md).toContain('## Completion');
    expect(r.md).toContain('- ACCEPTED by the user (partial): 2 unfinished — plan 1/3 completed');
    expect(r.md).toContain("  - unfinished: plan task 't2' is failed");
    // No acceptance → no section.
    const none = buildReport({ events: events.filter((e) => e.type !== 'session.accepted') });
    expect(none.json.accepted).toBeUndefined();
    expect(none.md).not.toContain('## Completion');
  });

  it('task-base checkpoints render under their own harness-created heading, never as user checkpoints', () => {
    seq = 0;
    const events: SessionEvent[] = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'C:\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'task.base-checkpoint', callId: 'call_1', ref: 'refs/agent-cli/checkpoints/p-1/1', oid: 'a'.repeat(40) }),
    ];
    const r = buildReport({ events });
    expect(r.json.taskBaseCheckpoints).toEqual([{ ref: 'refs/agent-cli/checkpoints/p-1/1', oid: 'a'.repeat(40) }]);
    expect(r.json.gitCheckpoints).toEqual([]); // NEVER misattributed to the user
    expect(r.md).toContain('## Task-base checkpoints (hidden refs, harness-created)');
    expect(r.md).not.toContain('## Checkpoints (hidden refs, user-commanded)');
  });

  it('a saved spill blob renders the honest pointer — "captured", never "full"', () => {
    seq = 0;
    const sha = 'b'.repeat(64);
    const events: SessionEvent[] = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'C:\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'tool.requested', callId: 'c1', tool: 'run_command', input: { command: 'npm test' } }),
      evt({ type: 'policy.decision', callId: 'c1', classification: 'external', decision: 'ask', rule: 'command.default', reason: 'r' }),
      evt({ type: 'approval.resolved', callId: 'c1', decision: 'allow', scope: 'once', source: 'user' }),
      evt({ type: 'command.started', callId: 'c1', pid: 1, shell: 'powershell.exe', cwd: 'C:\ws', timeoutMs: 1000 }),
      evt({ type: 'command.ended', callId: 'c1', termination: 'exited', exitCode: 0, durationMs: 5 }),
      evt({ type: 'tool.completed', callId: 'c1', ok: true, outputPreview: 'x', durationMs: 5, exitCode: 0, truncated: true, fullOutputSha256: sha, fullOutputSaved: true }),
    ];
    const r = buildReport({ events });
    expect(r.json.commands[0]).toMatchObject({ command: 'npm test', outputBlobSha256: sha });
    expect(r.md).toContain(`captured output preserved: objects/${sha}`);
    expect(r.md).not.toContain('full output preserved');
    // Truncated WITHOUT the saved flag → no pointer (nothing was persisted).
    const unsaved = events.map((e) => (e.type === 'tool.completed' ? { ...e, fullOutputSaved: undefined } : e)) as SessionEvent[];
    expect(buildReport({ events: unsaved }).md).not.toContain('captured output preserved');
  });

  it('plan retirement provenance: RETIRED at acceptance vs DISCARDED by the user', () => {
    seq = 0;
    const base: SessionEvent[] = [
      evt({ type: 'session.started', sessionId: 'p-1', workspaceRoot: 'C:\ws', model: 'm', mode: 'interactive', providerName: 'mock', argv: [] }),
      evt({ type: 'plan.updated', callId: 'c1', planId: 'p-1', sha256: 'c'.repeat(64), bytes: 10, prevSha256: null, status: 'draft' }),
      evt({ type: 'plan.approved', planId: 'p-1', sha256: 'c'.repeat(64) }),
    ];
    const retired = buildReport({ events: [...base, evt({ type: 'plan.discarded', planId: 'p-1', reason: 'accepted' })] });
    expect(retired.json.plan?.discardedReason).toBe('accepted');
    expect(retired.md).toContain('RETIRED at acceptance');
    expect(retired.md).not.toContain('DISCARDED by the user');
    seq = 3;
    const discarded = buildReport({ events: [...base, evt({ type: 'plan.discarded', planId: 'p-1' })] });
    expect(discarded.md).toContain('DISCARDED by the user');
    expect(discarded.md).not.toContain('RETIRED at acceptance');
  });
});

describe('report: Session 14 surfaces (adversarial review, harness checkpoint lineage)', () => {
  const FINDING = {
    findingId: 'c-9#1',
    severity: 'critical' as const,
    title: 'XSS via innerHTML',
    paths: ['public/app.js'],
    evidence: 'read public/app.js:42 — unescaped interpolation',
    scenario: 'a crafted note executes script',
    confidence: 'high' as const,
  };

  it('renders rounds, findings with derived triage status, and the audit footer', () => {
    const events = [
      ...baseEvents(),
      evt({ type: 'file.mutated', callId: 'w', path: 'C:\ws\a.ts', kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] }),
      evt({ type: 'task.started', callId: 'rv', role: 'reviewer', childSessionId: 'c-9', budget: BUDGET }),
      evt({ type: 'task.ended', callId: 'rv', childSessionId: 'c-9', status: 'completed', steps: 1, usage: { inputTokens: 1, outputTokens: 1 }, resultSha256: 'x', durationMs: 1 }),
      evt({ type: 'review.findings', callId: 'rv', childSessionId: 'c-9', lens: 'correctness', findings: [FINDING] }),
      evt({ type: 'review.triage', callId: 'tr', findingId: 'c-9#1', action: 'refute', evidence: 'checked the sanitizer upstream: input is escaped at ingestion' }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.review?.findings).toHaveLength(1);
    expect(json.review?.findings[0]).toMatchObject({ findingId: 'c-9#1', status: 'refuted', blocking: false });
    expect(md).toContain('## Adversarial review (recorded findings and triage)');
    expect(md).toContain("c-9#1 [critical, confidence high] 'XSS via innerHTML' → REFUTED");
    expect(md).toContain('triage refute: checked the sanitizer upstream');
    expect(md).toContain('a refutation is an UNVERIFIED model claim');
  });

  it('an ineffective triage renders as INEFFECTIVE with its reason; blocking findings say BLOCKING', () => {
    const events = [
      ...baseEvents(),
      evt({ type: 'task.started', callId: 'rv', role: 'reviewer', childSessionId: 'c-9', budget: BUDGET }),
      evt({ type: 'task.ended', callId: 'rv', childSessionId: 'c-9', status: 'completed', steps: 1, usage: { inputTokens: 1, outputTokens: 1 }, resultSha256: 'x', durationMs: 1 }),
      evt({ type: 'review.findings', callId: 'rv', childSessionId: 'c-9', findings: [FINDING] }),
      evt({ type: 'review.triage', callId: 'tr', findingId: 'c-9#1', action: 'accept', evidence: 'we can live with this for now, truly' }),
    ];
    const { md } = buildReport({ events });
    expect(md).toContain('(BLOCKING)');
    expect(md).toContain('triage accept (INEFFECTIVE)');
    expect(md).toContain("'accept' is invalid for critical");
  });

  it('harness checkpoints render as the audit lineage with the phantom-honest footer', () => {
    const events = [
      ...baseEvents(),
      evt({ type: 'harness.checkpoint', kind: 'pre-integration', ref: 'refs/agent-cli/checkpoints/p-1/2', oid: 'a'.repeat(40), callId: 'ap' }),
      evt({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/agent-cli/checkpoints/p-1/3', oid: 'b'.repeat(40) }),
    ];
    const { json, md } = buildReport({ events });
    expect(json.harnessCheckpoints).toHaveLength(2);
    expect(md).toContain('## Git recovery and audit state (hidden refs, harness-created)');
    expect(md).toContain('pre-integration (whole-workspace point before an apply');
    expect(md).toContain('DELIVERY (the accepted state; intended to survive the session)');
    expect(md).toContain('`agent checkpoint list` is live truth');
    // Never misattributed to the user-commanded section.
    expect(json.gitCheckpoints).toHaveLength(0);
  });

  it('S14.5: a delivery ref a LATER pruned event names must not render as surviving', () => {
    // The old line asserted liveness ("survives the session until superseded or pruned") for
    // every delivery creation — including refs this very log records as pruned/superseded.
    const events = [
      ...baseEvents(),
      evt({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/agent-cli/checkpoints/p-1/3', oid: 'b'.repeat(40) }),
      evt({ type: 'git.checkpoint.pruned', kind: 'delivery', refs: ['refs/agent-cli/checkpoints/p-1/3'], failed: [] }),
      evt({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/agent-cli/checkpoints/p-1/4', oid: 'c'.repeat(40) }),
    ];
    const { json, md } = buildReport({ events });
    const lines = md.split('\n').filter((l) => l.includes('DELIVERY'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[later pruned/superseded in this log]');
    expect(lines[1]).not.toContain('[later pruned');
    expect(json.harnessCheckpoints![0]!.pruned).toBe(true);
    expect(json.harnessCheckpoints![1]!.pruned).toBeUndefined();
  });

  it('sessions without review or harness checkpoints omit both sections (additive-optional)', () => {
    const { json, md } = buildReport({ events: baseEvents() });
    expect(json.review).toBeUndefined();
    expect(json.harnessCheckpoints).toBeUndefined();
    expect(md).not.toContain('## Adversarial review');
    expect(md).not.toContain('## Git recovery and audit state');
  });
});
