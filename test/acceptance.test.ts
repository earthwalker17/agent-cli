import { describe, it, expect } from 'vitest';
import { computeAcceptance, workSince } from '../src/runtime/acceptance.js';
import { foldGraphState } from '../src/plan/graph-state.js';
import { PlanGraphSchema, planContentSha, type PlanGraph } from '../src/plan/schema.js';
import type { PlanState } from '../src/plan/canonical.js';
import type { SessionEvent, TaskChangeFile } from '../src/types.js';

/**
 * The acceptance fold (Session 11.5): one pure derivation of "is this session's work complete,
 * and what exactly remains" — the ground truth for /accept, /status, the quit summary, and the
 * journal handoff.
 */

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-24T00:00:00.000Z', ...body }) as unknown as SessionEvent;

const started = (planTaskId: string, child: string): SessionEvent =>
  ev({ type: 'task.started', callId: 'c', role: 'executor', childSessionId: child, budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 }, planTaskId });
const endedAs = (child: string, status: string): SessionEvent =>
  ev({ type: 'task.ended', callId: 'c', childSessionId: child, status, steps: 1, usage: { inputTokens: 0, outputTokens: 1 }, resultSha256: 'x', durationMs: 1 });
const changes = (child: string, files: TaskChangeFile[]): SessionEvent =>
  ev({ type: 'task.changes', callId: 'c', childSessionId: child, baseOid: 'b', files });
const applies = (child: string, paths: string[]): SessionEvent =>
  ev({ type: 'task.applied', callId: 'c', childSessionId: child, applied: paths, refused: [] });
const file = (relPath: string, over: Partial<TaskChangeFile> = {}): TaskChangeFile => ({
  relPath,
  kind: 'modify',
  baseSha256: 'b',
  blobSha256: 'a',
  bytes: 1,
  ...over,
});

const GRAPH: PlanGraph = PlanGraphSchema.parse({
  objective: 'demo',
  tasks: [
    { id: 't1', title: 'core', intent: 'build', role: 'executor', verify: 'tests' },
    { id: 'm1', title: 'docs', intent: 'parent', role: 'main', verify: 'read' },
  ],
});

const NO_PLAN: PlanState = {
  kind: 'none',
  status: 'none',
  currentSha: null,
  approvedSha: null,
  diverged: false,
  approvedAndCurrent: false,
  canonical: null,
  legacy: null,
};

function canonicalState(status: 'draft' | 'approved' | 'superseded' | 'unknown', over: Partial<PlanState> = {}): PlanState {
  const sha = planContentSha(GRAPH);
  return {
    kind: 'canonical',
    status,
    currentSha: sha,
    approvedSha: status === 'approved' ? sha : null,
    diverged: false,
    approvedAndCurrent: status === 'approved',
    canonical: { planId: 'p', file: 'p.plan.json', exists: true, status, contentSha: sha, graph: GRAPH, updated: null, bytes: 1 },
    legacy: null,
    ...over,
  };
}

describe('computeAcceptance', () => {
  it('no plan, no captures → complete', () => {
    const acc = computeAcceptance(NO_PLAN, null, []);
    expect(acc.complete).toBe(true);
    expect(acc.summary).toContain('complete — no plan');
    expect(acc.unfinished).toEqual([]);
  });

  it('a draft plan is NOT silently complete (consent mismatch → the confirm path)', () => {
    const acc = computeAcceptance(canonicalState('draft'), foldGraphState(GRAPH, []), []);
    expect(acc.complete).toBe(false);
    expect(acc.unfinished.some((u) => u.includes('plan draft pending approval'))).toBe(true);
  });

  it('an approved plan lists every task not completed/parent-owned; parent-owned never blocks', () => {
    const st = canonicalState('approved');
    const incomplete = computeAcceptance(st, foldGraphState(GRAPH, []), []);
    expect(incomplete.complete).toBe(false);
    expect(incomplete.unfinished).toEqual([`plan task 't1' is queued`]);

    const done = [started('t1', 'c1'), endedAs('c1', 'completed'), changes('c1', [])];
    const acc = computeAcceptance(st, foldGraphState(GRAPH, done), done);
    expect(acc.complete).toBe(true);
    expect(acc.summary).toContain('plan 1/1 completed'); // m1 counted apart as parent-owned
  });

  it('a diverged approval and an unreadable plan both land on the unfinished list', () => {
    const diverged = canonicalState('approved', { approvedAndCurrent: false, diverged: true });
    expect(computeAcceptance(diverged, null, []).unfinished.some((u) => u.includes('DIVERGED'))).toBe(true);
    const unknown = canonicalState('unknown', { approvedAndCurrent: false, approvedSha: null });
    expect(computeAcceptance(unknown, null, []).unfinished.some((u) => u.includes('unreadable'))).toBe(true);
  });

  it('a superseded (discarded/retired) plan never blocks acceptance', () => {
    const acc = computeAcceptance(canonicalState('superseded', { approvedAndCurrent: false, approvedSha: null }), null, []);
    expect(acc.complete).toBe(true);
  });

  it('unapplied captures block — registry-wide, including plan-unbound executor work', () => {
    const events = [
      ev({ type: 'task.started', callId: 'c', role: 'executor', childSessionId: 'c-unbound', budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 } }),
      endedAs('c-unbound', 'completed'),
      changes('c-unbound', [file('a.ts'), file('b.ts')]),
      applies('c-unbound', ['a.ts']),
    ];
    const acc = computeAcceptance(NO_PLAN, null, events);
    expect(acc.complete).toBe(false);
    expect(acc.unfinished[0]).toContain('1 captured file(s)');
    expect(acc.unfinished[0]).toContain('c-unbound');

    // Oversize and blob-less entries can never apply and never block; deletes apply by relPath.
    const edge = [
      endedAs('c-edge', 'completed'),
      changes('c-edge', [file('gone.ts', { kind: 'delete', blobSha256: null }), file('big.bin', { oversize: true })]),
      applies('c-edge', ['gone.ts']),
    ];
    expect(computeAcceptance(NO_PLAN, null, edge).complete).toBe(true);
  });

  it('a legacy plan cannot be completion-checked and says so (superseded legacy is fine)', () => {
    const legacy: PlanState = { ...NO_PLAN, kind: 'legacy', status: 'approved' };
    expect(computeAcceptance(legacy, null, []).unfinished[0]).toContain('legacy');
    const superseded: PlanState = { ...NO_PLAN, kind: 'legacy', status: 'superseded' };
    expect(computeAcceptance(superseded, null, []).complete).toBe(true);
  });

  it('records the LATEST acceptance; workSince detects work-shaped events after it', () => {
    const accepted = ev({ type: 'session.accepted', complete: true, summary: 's' });
    const acc = computeAcceptance(NO_PLAN, null, [accepted]);
    expect(acc.accepted).toMatchObject({ complete: true, seq: accepted.seq });
    expect(acc.acceptedStale).toBe(false);

    expect(workSince([accepted], accepted.seq)).toBe(false);
    const chatter = ev({ type: 'user.message', text: 'hi' });
    expect(workSince([accepted, chatter], accepted.seq)).toBe(false); // conversation is not work
    const work = ev({ type: 'file.mutated', callId: 'c', path: 'x', kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] });
    expect(workSince([accepted, work], accepted.seq)).toBe(true);
    expect(computeAcceptance(NO_PLAN, null, [accepted, work]).acceptedStale).toBe(true);
  });

  it("the accept's OWN retirement never reads as work-since (review F1: no duplicate consent)", () => {
    const accepted = ev({ type: 'session.accepted', complete: true, summary: 's' });
    const retirement = ev({ type: 'plan.discarded', planId: 'p', reason: 'accepted' });
    expect(workSince([accepted, retirement], accepted.seq)).toBe(false);
    // A plain user /plan discard after an acceptance IS work (a real state change).
    const userDiscard = ev({ type: 'plan.discarded', planId: 'p' });
    expect(workSince([accepted, userDiscard], accepted.seq)).toBe(true);
  });

  it('the retired-by-accept summary names the provenance', () => {
    const events = [ev({ type: 'plan.discarded', planId: 'p', reason: 'accepted' })];
    const acc = computeAcceptance(canonicalState('superseded', { approvedAndCurrent: false, approvedSha: null }), null, events);
    expect(acc.summary).toContain('plan retired (accepted)');
  });
});
