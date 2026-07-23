import { describe, it, expect } from 'vitest';
import { foldGraphState, depSatisfied } from '../src/plan/graph-state.js';
import { PlanGraphSchema, type PlanGraph } from '../src/plan/schema.js';
import type { SessionEvent, TaskChangeFile } from '../src/types.js';

/**
 * The graph-state fold: execution status derived PURELY from (plan graph, events) — the house
 * pattern. Live phases come only from the overlay; resumed logs collapse running work to
 * 'interrupted'; integration requires the applied union to cover every applicable captured file.
 */

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-23T00:00:00.000Z', ...body }) as unknown as SessionEvent;

const started = (planTaskId: string, childSessionId: string): SessionEvent =>
  ev({ type: 'task.started', callId: 'c1', role: 'executor', childSessionId, budget: { maxSteps: 30, timeoutMs: 1, maxOutputTokens: 1 }, planTaskId });
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
    const wait = new Map([['c-live', 'awaiting-approval' as const]]);
    expect(foldGraphState(GRAPH, events, wait).byId.get('t1')!.state).toBe('awaiting-approval');

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
