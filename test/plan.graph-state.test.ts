import { describe, it, expect } from 'vitest';
import { foldGraphState, depSatisfied } from '../src/plan/graph-state.js';
import { PlanGraphSchema, planTaskDefinitionSha, type PlanGraph } from '../src/plan/schema.js';
import type { SessionEvent, TaskChangeFile } from '../src/types.js';

/**
 * The graph-state fold: execution status derived PURELY from (plan graph, events) — the house
 * pattern. Live phases come only from the overlay; resumed logs collapse running work to
 * 'interrupted'; integration requires the applied union to cover every applicable captured file.
 */

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-23T00:00:00.000Z', ...body }) as unknown as SessionEvent;

const started = (planTaskId: string, childSessionId: string, planTaskSha?: string): SessionEvent =>
  ev({
    type: 'task.started',
    callId: 'c1',
    role: 'executor',
    childSessionId,
    budget: { maxSteps: 30, timeoutMs: 1, maxOutputTokens: 1 },
    planTaskId,
    ...(planTaskSha !== undefined ? { planTaskSha } : {}),
  });
const endedWith = (childSessionId: string, status: string): SessionEvent =>
  ev({ type: 'task.ended', callId: 'c1', childSessionId, status, steps: 1, usage: { inputTokens: 0, outputTokens: 10 }, resultSha256: 'x', durationMs: 5 });
const changes = (childSessionId: string, files: TaskChangeFile[], omittedCount = 0): SessionEvent =>
  ev({ type: 'task.changes', callId: 'c1', childSessionId, baseOid: 'base', files, omittedCount });
const applied = (childSessionId: string, paths: string[]): SessionEvent =>
  ev({ type: 'task.applied', callId: 'c1', childSessionId, applied: paths, refused: [] });

const file = (relPath: string, over: Partial<TaskChangeFile> = {}): TaskChangeFile => ({
  relPath,
  kind: 'modify',
  baseSha256: 'b',
  blobSha256: 'a',
  bytes: 10,
  ...over,
});

const GRAPH: PlanGraph = PlanGraphSchema.parse({
  objective: 'demo',
  tasks: [
    { id: 't1', title: 'core', intent: 'build', role: 'executor', verify: 'tests' },
    { id: 't2', title: 'wire', intent: 'integrate', role: 'executor', verify: 'e2e', dependsOn: ['t1'] },
    { id: 't3', title: 'survey', intent: 'look', role: 'explorer' },
    { id: 'm1', title: 'docs', intent: 'parent writes docs', role: 'main', verify: 'read them' },
    { id: 't4', title: 'after docs', intent: 'x', role: 'executor', verify: 'y', dependsOn: ['m1'] },
  ],
});

describe('foldGraphState', () => {
  it('with no events: roots queued, dependents blocked, main parent-owned (satisfying deps)', () => {
    const gs = foldGraphState(GRAPH, []);
    expect(gs.byId.get('t1')!.state).toBe('queued');
    expect(gs.byId.get('t2')).toMatchObject({ state: 'blocked', blockedOn: ['t1'] });
    expect(gs.byId.get('t3')!.state).toBe('queued');
    expect(gs.byId.get('m1')!.state).toBe('parent-owned');
    expect(gs.byId.get('m1')!.note).toContain('not verified by the harness');
    expect(gs.byId.get('t4')!.state).toBe('queued'); // parent-owned dep auto-satisfies
    expect(gs.ready).toEqual(['t1', 't3', 't4']);
    expect(gs.summary).toContain('0/5 completed');
    expect(gs.summary).toContain('blocked: t2 (on t1)');
  });

  it('read-only completion needs no integration; executor completion requires the applied union', () => {
    const base = [started('t3', 'c-ex'), endedWith('c-ex', 'completed')];
    expect(foldGraphState(GRAPH, base).byId.get('t3')!.state).toBe('completed');

    const cap = [started('t1', 'c1a'), endedWith('c1a', 'completed'), changes('c1a', [file('src/a.ts'), file('src/b.ts')])];
    expect(foldGraphState(GRAPH, cap).byId.get('t1')!.state).toBe('integrating');
    expect(foldGraphState(GRAPH, cap).byId.get('t2')!.state).toBe('blocked'); // integrating ≠ satisfied

    // Partial apply keeps integrating; the union across MULTIPLE applies completes it.
    const partial = [...cap, applied('c1a', ['src/a.ts'])];
    const gsPartial = foldGraphState(GRAPH, partial);
    expect(gsPartial.byId.get('t1')!.state).toBe('integrating');
    expect(gsPartial.byId.get('t1')!.note).toContain('1 of 2');

    const full = [...partial, applied('c1a', ['src/b.ts'])];
    const gsFull = foldGraphState(GRAPH, full);
    expect(gsFull.byId.get('t1')!.state).toBe('completed');
    expect(gsFull.byId.get('t2')!.state).toBe('queued'); // dependent unblocks
    expect(depSatisfied(gsFull.byId.get('t1'))).toBe(true);
  });

  it('deletes integrate via their relPath; oversize files never block completion but are noted', () => {
    const events = [
      started('t1', 'c1'),
      endedWith('c1', 'completed'),
      changes('c1', [file('gone.ts', { kind: 'delete', blobSha256: null }), file('big.bin', { oversize: true, blobSha256: null })], 3),
      applied('c1', ['gone.ts']),
    ];
    const st = foldGraphState(GRAPH, events).byId.get('t1')!;
    expect(st.state).toBe('completed');
    expect(st.note).toContain('3 captured file(s) omitted');
    expect(st.note).toContain('1 oversize file(s)');
  });

  it('failure statuses → failed; cancellation statuses → cancelled; both re-derivable', () => {
    for (const s of ['error', 'timeout', 'budget-steps', 'budget-tokens', 'stalled']) {
      const gs = foldGraphState(GRAPH, [started('t1', 'cf'), endedWith('cf', s)]);
      expect(gs.byId.get('t1')).toMatchObject({ state: 'failed', note: `child ended: ${s}` });
    }
    for (const s of ['aborted', 'user-stopped', 'cancelled']) {
      const gs = foldGraphState(GRAPH, [started('t1', 'cc'), endedWith('cc', s)]);
      expect(gs.byId.get('t1')!.state).toBe('cancelled');
    }
  });

  it('a retry binding governs; attempts counts the history', () => {
    const events = [
      started('t1', 'c-fail'),
      endedWith('c-fail', 'error'),
      started('t1', 'c-retry'),
      endedWith('c-retry', 'completed'),
      changes('c-retry', []), // executor completion requires a recorded capture (may be empty)
    ];
    const st = foldGraphState(GRAPH, events).byId.get('t1')!;
    expect(st).toMatchObject({ state: 'completed', attempts: 2, childSessionId: 'c-retry' });
  });

  it('review F1: a completed EXECUTOR with no capture event folds to failed (re-runnable), never completed', () => {
    // Capture failure (or a crash between task.ended and task.changes) records no changes
    // event; a false 'completed' would let R5 block the retry and strand the lost work.
    const events = [started('t1', 'c-lost'), endedWith('c-lost', 'completed')];
    const st = foldGraphState(GRAPH, events).byId.get('t1')!;
    expect(st.state).toBe('failed');
    expect(st.note).toContain('no change capture was recorded');
    expect(foldGraphState(GRAPH, events).byId.get('t2')!.state).toBe('blocked'); // dep NOT satisfied

    // An executor that legitimately changed nothing still records an (empty) capture → completed.
    const clean = [started('t1', 'c-clean'), endedWith('c-clean', 'completed'), changes('c-clean', [])];
    expect(foldGraphState(GRAPH, clean).byId.get('t1')!.state).toBe('completed');
  });

  it('started-without-ended is live-phase with the overlay, interrupted without it (resume honesty)', () => {
    const events = [started('t1', 'c-live')];
    const live = new Map([['c-live', 'running' as const]]);
    expect(foldGraphState(GRAPH, events, live).byId.get('t1')!.state).toBe('running');
    // Session 11.5: overlay-fed folds surface live work in the SUMMARY too (the mid-turn
    // /tasks plan line) — running must never read as silently not-completed.
    expect(foldGraphState(GRAPH, events, live).summary).toContain('running: t1');
    const wait = new Map([['c-live', 'awaiting-approval' as const]]);
    expect(foldGraphState(GRAPH, events, wait).byId.get('t1')!.state).toBe('awaiting-approval');
    expect(foldGraphState(GRAPH, events, wait).summary).toContain('t1 (awaiting approval)');

    const resumed = foldGraphState(GRAPH, events).byId.get('t1')!;
    expect(resumed.state).toBe('interrupted');
    expect(resumed.note).toContain('c-live'); // the child evidence log pointer
    expect(resumed.state === 'interrupted' && foldGraphState(GRAPH, events).byId.get('t2')!.state).toBe('blocked');
  });

  it('unbound task.started events (no planTaskId) never join the fold', () => {
    const unbound = ev({ type: 'task.started', callId: 'c1', role: 'explorer', childSessionId: 'c-x', budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 } });
    const gs = foldGraphState(GRAPH, [unbound]);
    expect(gs.byId.get('t1')!.state).toBe('queued');
    expect(gs.byId.get('t3')!.state).toBe('queued');
  });
});

describe('definition identity + attempt history (Session 11.5)', () => {
  /** GRAPH with t1's intent changed — a semantic amendment to a single task. */
  const AMENDED: PlanGraph = PlanGraphSchema.parse({
    objective: 'demo',
    tasks: [
      { id: 't1', title: 'core', intent: 'build DIFFERENTLY', role: 'executor', verify: 'tests' },
      { id: 't2', title: 'wire', intent: 'integrate', role: 'executor', verify: 'e2e', dependsOn: ['t1'] },
      { id: 't3', title: 'survey', intent: 'look', role: 'explorer' },
      { id: 'm1', title: 'docs', intent: 'parent writes docs', role: 'main', verify: 'read them' },
      { id: 't4', title: 'after docs', intent: 'x', role: 'executor', verify: 'y', dependsOn: ['m1'] },
    ],
  });
  const t1Sha = planTaskDefinitionSha(GRAPH.tasks[0]!);
  const t1AmendedSha = planTaskDefinitionSha(AMENDED.tasks[0]!);

  const completedT1 = (sha?: string): SessionEvent[] => [
    started('t1', 'c-done', sha),
    endedWith('c-done', 'completed'),
    changes('c-done', []),
  ];

  it('definition shas: dependsOn order is neutral; any semantic field change flips the sha', () => {
    expect(t1Sha).not.toBe(t1AmendedSha);
    const a = PlanGraphSchema.parse({ objective: 'x', tasks: [{ id: 'z', title: 't', intent: 'i', role: 'explorer', dependsOn: [] }] }).tasks[0]!;
    const sorted = planTaskDefinitionSha({ ...a, dependsOn: ['p', 'q'] });
    const reversed = planTaskDefinitionSha({ ...a, dependsOn: ['q', 'p'] });
    expect(sorted).toBe(reversed);
  });

  it('a completed task whose definition changed re-opens (queued) with the honest note', () => {
    const gs = foldGraphState(AMENDED, completedT1(t1Sha));
    const st = gs.byId.get('t1')!;
    expect(st.state).toBe('queued');
    expect(st.note).toContain('definition changed after completion');
    expect(st.note).toContain(t1Sha.slice(0, 8));
    // The reopened task no longer satisfies its dependents (conservative direction).
    expect(gs.byId.get('t2')).toMatchObject({ state: 'blocked', blockedOn: ['t1'] });
  });

  it('an unchanged completed task stays completed across amendments (sha matches)', () => {
    const gs = foldGraphState(GRAPH, completedT1(t1Sha));
    expect(gs.byId.get('t1')!.state).toBe('completed');
    expect(gs.byId.get('t2')!.state).toBe('queued');
  });

  it('legacy sha-less bindings keep the id-sticky completed reading (pre-11.5 logs)', () => {
    const gs = foldGraphState(AMENDED, completedT1(undefined));
    expect(gs.byId.get('t1')!.state).toBe('completed');
  });

  it('A→B→A: completing under B then amending back to A re-opens (conservative, documented)', () => {
    // The latest binding recorded B's sha; the current definition is A again. Re-running too
    // much beats silently skipping — the note carries the sha the work actually ran as.
    const gs = foldGraphState(GRAPH, completedT1(t1AmendedSha));
    const st = gs.byId.get('t1')!;
    expect(st.state).toBe('queued');
    expect(st.note).toContain(t1AmendedSha.slice(0, 8));
  });

  it('integrating is NOT reopened by a definition change (captured work integrates first)', () => {
    const events = [
      started('t1', 'c-int', t1Sha),
      endedWith('c-int', 'completed'),
      changes('c-int', [file('src/a.ts')]),
    ];
    expect(foldGraphState(AMENDED, events).byId.get('t1')!.state).toBe('integrating');
  });

  it('attemptHistory records every binding with outcome and sha; attempts stays the count', () => {
    const events = [
      started('t1', 'c-1', t1Sha),
      endedWith('c-1', 'error'),
      started('t1', 'c-2', t1Sha),
      // c-2 never ended (crash) — outcome 'interrupted'
      started('t1', 'c-3', t1AmendedSha),
      endedWith('c-3', 'completed'),
      changes('c-3', []),
    ];
    const st = foldGraphState(AMENDED, events).byId.get('t1')!;
    expect(st.attempts).toBe(3);
    expect(st.attemptHistory).toEqual([
      { childSessionId: 'c-1', outcome: 'error', planTaskSha: t1Sha },
      { childSessionId: 'c-2', outcome: 'interrupted', planTaskSha: t1Sha },
      { childSessionId: 'c-3', outcome: 'completed', planTaskSha: t1AmendedSha },
    ]);
    expect(st.definitionSha).toBe(t1AmendedSha);
    expect(st.state).toBe('completed');
  });

  it('the interrupted note states re-run safety AND the shell-side-effect caveat', () => {
    const st = foldGraphState(GRAPH, [started('t1', 'c-live')]).byId.get('t1')!;
    expect(st.state).toBe('interrupted');
    expect(st.note).toContain('safe to re-run');
    expect(st.note).toContain('captured nothing');
    expect(st.note).toContain('external side effects');
    expect(st.note).toContain('c-live');
  });
});
