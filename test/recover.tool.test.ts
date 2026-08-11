import { describe, it, expect } from 'vitest';
import { createRecoverTool } from '../src/tools/recover.js';
import { repairVerdictsFor } from '../src/cli/assemble.js';
import { checkDagRules, MAX_TASK_ATTEMPTS, type PlanGateInfo } from '../src/tools/delegate.js';
import { decide, Grants } from '../src/policy/engine.js';
import { foldGraphState } from '../src/plan/graph-state.js';
import { PlanGraphSchema, planTaskDefinitionSha, validatePlanGraph, type PlanGraph } from '../src/plan/schema.js';
import type { PlanState } from '../src/plan/canonical.js';
import type { CheckKind, RepairEvidence, SessionEvent, ToolContext } from '../src/types.js';

let seq = 0;
let clockMs = Date.parse('2026-07-25T00:00:00.000Z');
const ev = (body: Record<string, unknown>, advanceMs = 1000): SessionEvent => {
  clockMs += advanceMs;
  return { v: 1, seq: ++seq, ts: new Date(clockMs).toISOString(), ...body } as unknown as SessionEvent;
};
function reset(): void {
  seq = 0;
  clockMs = Date.parse('2026-07-25T00:00:00.000Z');
}

function graph(): PlanGraph {
  return validatePlanGraph(
    PlanGraphSchema.parse({
      objective: 'o',
      tasks: [
        { id: 'api', title: 'API', intent: 'i', role: 'executor', verify: 'typecheck passes', touches: ['src/api'], checks: ['typecheck'] },
      ],
    }),
  ).graph!;
}

function ctxWith(): { ctx: ToolContext; recorded: RepairEvidence[] } {
  const recorded: RepairEvidence[] = [];
  return { recorded, ctx: { workspaceRoot: 'C:/ws', stateDir: 'C:/state', reportRepair: (e) => recorded.push(e) } };
}

/** Bindings must carry the task's REAL definition sha, or R10/R11 correctly ignore them. */
const apiSha = (): string => planTaskDefinitionSha(graph().tasks[0]!);
const started = (child: string): SessionEvent =>
  ev({ type: 'task.started', callId: `c-${child}`, role: 'executor', childSessionId: child, budget: {}, planTaskId: 'api', planTaskSha: apiSha() });
const endedErr = (child: string, status = 'error'): SessionEvent =>
  ev({ type: 'task.ended', callId: `c-${child}`, childSessionId: child, status, steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 });
const typeFail = (): SessionEvent =>
  ev({
    type: 'check.completed',
    callId: 'k',
    check: 'typecheck',
    recipeId: 'node.script.typecheck',
    status: 'fail',
    exitCode: 2,
    termination: 'exited',
    durationMs: 10,
    summary: 'typecheck FAIL',
    signals: ['ts-error'],
    planTaskId: 'api',
  });

function tool(events: SessionEvent[]) {
  return createRecoverTool({ events: () => events, planGraph: () => graph() });
}

describe('recover: policy shape', () => {
  it('classifies as observe/allow — it writes evidence and confers no authority', () => {
    const t = tool([]);
    expect(t.command).toBeUndefined();
    expect(t.delegates).toBeUndefined();
    expect(t.planDoc).toBeUndefined();
    expect(t.check).toBeUndefined();
    const d = decide(t, { action: 'escalate', target: 'api', reason: 'x'.repeat(20) }, { workspaceRoot: 'C:/ws', stateDir: 'C:/s' }, new Grants());
    expect(d).toMatchObject({ decision: 'allow', classification: 'observe' });
  });
});

describe('recover: evidence is required before anything is recorded', () => {
  it('refuses when nothing has failed', async () => {
    reset();
    const { ctx, recorded } = ctxWith();
    const r = await tool([]).execute({ action: 'attempt', target: 'api', hypothesis: 'x'.repeat(30), regression_checks: ['typecheck'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Recovery works from EVIDENCE');
    expect(recorded).toEqual([]);
  });

  it('refuses an attempt with no hypothesis or no declared proof', async () => {
    reset();
    const events = [typeFail()];
    const { ctx, recorded } = ctxWith();
    const a = await tool(events).execute({ action: 'attempt', target: 'api', regression_checks: ['typecheck'] }, ctx);
    expect(a.ok).toBe(false);
    expect(a.output).toContain('definition of a loop');
    const b = await tool(events).execute({ action: 'attempt', target: 'api', hypothesis: 'x'.repeat(30) }, ctx);
    expect(b.ok).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('refuses an escalation with no reason', async () => {
    reset();
    const { ctx, recorded } = ctxWith();
    const r = await tool([typeFail()]).execute({ action: 'escalate', target: 'api' }, ctx);
    expect(r.ok).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe('recover: attempt', () => {
  it('classifies the failure itself and records the plan with its guidance', async () => {
    reset();
    const { ctx, recorded } = ctxWith();
    const r = await tool([typeFail()]).execute(
      { action: 'attempt', target: 'api', hypothesis: 'the declared return type is wrong at its source', scope_paths: ['src/api'], regression_checks: ['typecheck'] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain('repair attempt 1/');
    expect(r.output).toContain('classified: compile-type');
    expect(r.output).toContain('signals: ts-error');
    expect(r.output).toContain('prove it with: run_check typecheck');
    expect(r.output).toContain('recorded verbatim for review, not verified');
    expect(recorded[0]).toMatchObject({
      kind: 'attempted',
      target: 'api',
      failureClass: 'compile-type',
      scopePaths: ['src/api'],
      regressionChecks: ['typecheck'],
      attempt: 1,
    });
  });

  it('refuses a non-auto-eligible class with the catalogue guidance and the escape hatches', async () => {
    reset();
    const depFail = ev({
      type: 'check.completed',
      callId: 'k',
      check: 'test',
      recipeId: 'r',
      status: 'fail',
      exitCode: 1,
      termination: 'exited',
      durationMs: 1,
      summary: 'test FAIL',
      signals: ['module-not-found'],
      planTaskId: 'api',
    });
    const { ctx, recorded } = ctxWith();
    const r = await tool([depFail]).execute(
      { action: 'attempt', target: 'api', hypothesis: 'a dependency is missing from the manifest', regression_checks: ['test'] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('requires-user-decision');
    expect(r.output).toContain('failure class: dependency-setup');
    expect(r.output).toContain('Escape hatches');
    expect(recorded).toEqual([]);
  });

  it('refuses an UNCLASSIFIED failure — repairing a guess is the loop this prevents', async () => {
    reset();
    const events = [started('ch1'), endedErr('ch1')];
    const { ctx, recorded } = ctxWith();
    const r = await tool(events).execute(
      { action: 'attempt', target: 'api', hypothesis: 'something is probably broken somewhere', regression_checks: ['typecheck'] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unknown-classification');
    expect(recorded).toEqual([]);
  });

  it('requires the FAILING kind among the regression checks', async () => {
    // Review finding: nothing tied the declared proof to the failure, so a green unrelated check
    // could mark a repair "PROVEN" — and, worse, that bogus success cleared an escalation.
    reset();
    const { ctx, recorded } = ctxWith();
    const r = await tool([typeFail()]).execute(
      { action: 'attempt', target: 'api', hypothesis: 'the declared return type is wrong at its source', regression_checks: ['format'] },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("must include 'typecheck'");
    expect(recorded).toEqual([]);
  });

  it('states honestly that scope is measured, not prevented — and says so when none was declared', async () => {
    reset();
    const { ctx } = ctxWith();
    const withScope = await tool([typeFail()]).execute(
      { action: 'attempt', target: 'api', hypothesis: 'the declared return type is wrong at its source', scope_paths: ['src/api'], regression_checks: ['typecheck'] },
      ctx,
    );
    expect(withScope.output).toContain('MEASURED, not prevented');

    reset();
    const noScope = await tool([typeFail()]).execute(
      { action: 'attempt', target: 'api', hypothesis: 'the declared return type is wrong at its source', regression_checks: ['typecheck'] },
      ctx,
    );
    expect(noScope.output).toContain('CANNOT be detected');
  });

  it('refuses scope paths that escape the workspace but keeps the contained ones', async () => {
    reset();
    const { ctx, recorded } = ctxWith();
    const r = await tool([typeFail()]).execute(
      { action: 'attempt', target: 'api', hypothesis: 'the declared return type is wrong at its source', scope_paths: ['src/api', '../etc'], regression_checks: ['typecheck'] },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain('refused as not contained');
    expect((recorded[0] as Extract<RepairEvidence, { kind: 'attempted' }>).scopePaths).toEqual(['src/api']);
  });
});

describe('recover: escalate', () => {
  it('records an honest stop that blocks acceptance', async () => {
    reset();
    const { ctx, recorded } = ctxWith();
    const r = await tool([typeFail()]).execute({ action: 'escalate', target: 'api', reason: 'three hypotheses failed; the type model needs a decision' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('escalated: api');
    expect(r.output).toContain('prevents accepting the session as complete');
    expect(r.output).toContain('Do not keep retrying');
    expect(recorded[0]).toMatchObject({ kind: 'escalated', target: 'api', failureClass: 'compile-type' });
  });
});

describe('R11: classification before repair planning at the scheduler gate', () => {
  function gate(events: SessionEvent[]): PlanGateInfo {
    const g = graph();
    const state = {
      kind: 'canonical',
      status: 'approved',
      approvedAndCurrent: true,
      approvedSha: 's',
      diverged: false,
      canonical: { graph: g },
    } as unknown as PlanState;
    return { state, graphState: foldGraphState(g, events), repairVerdicts: repairVerdictsFor(g, events) };
  }
  const spawn = (): { role: string; plan_task?: string }[] => [{ role: 'executor', plan_task: 'api' }];

  it('a failure with no recorded plan blocks the re-spawn: classification comes first', () => {
    reset();
    const events = [started('ch1'), endedErr('ch1', 'stalled')];
    const r = checkDagRules(spawn(), gate(events));
    expect(r).toContain('no repair plan for THIS failure');
    expect(r).toContain('runtime-process');
  });

  it('ONE free re-spawn when the stop reason is one no model effort can clear', () => {
    // A transient provider error classifies as `unknown`, a wall-clock overrun as
    // `timeout-resource` — neither is auto-eligible, so refusing at the FIRST failure would make
    // a blip cost a plan amendment plus a human re-approval. R10 still bounds the retries.
    reset();
    expect(checkDagRules(spawn(), gate([started('ch1'), endedErr('ch1', 'timeout')]))).toBeNull();
    reset();
    expect(checkDagRules(spawn(), gate([started('ch1'), endedErr('ch1', 'error')]))).toBeNull();
  });

  it('the SECOND failure of a class that needs a human decision is refused, naming escalate', () => {
    reset();
    const events = [started('ch1'), endedErr('ch1', 'timeout'), started('ch2'), endedErr('ch2', 'timeout')];
    const r = checkDagRules(spawn(), gate(events));
    expect(r).toContain('automatic repair is REFUSED');
    expect(r).toContain('timeout-resource');
    expect(r).toContain('recover(action="escalate"');
  });

  it('read-only tasks are unaffected — re-running an explorer is not a repair', () => {
    reset();
    const events = [started('ch1'), endedErr('ch1', 'stalled')];
    expect(checkDagRules([{ role: 'explorer' }], gate(events))).toBeNull();
  });

  it('a SECOND failure without a repair plan is refused, naming the class and the guidance', () => {
    reset();
    const events = [started('ch1'), endedErr('ch1', 'stalled'), started('ch2'), endedErr('ch2', 'stalled')];
    const r = checkDagRules(spawn(), gate(events));
    expect(r).toContain('no repair plan for THIS failure');
    expect(r).toContain('runtime-process');
    expect(r).toContain('recover(action="attempt"');
    expect(r).toContain('required evidence:');
  });

  it('a recorded repair plan newer than the failure unblocks the retry', () => {
    reset();
    const events = [
      started('ch1'),
      endedErr('ch1', 'stalled'),
      started('ch2'),
      endedErr('ch2', 'stalled'),
      ev({
        type: 'repair.attempted',
        callId: 'c',
        target: 'api',
        failureClass: 'runtime-process',
        signature: repairVerdictsFor(graph(), [started('ch1'), endedErr('ch1', 'stalled')]).get('api')!.signature,
        hypothesis: 'the loop came from re-reading the same file',
        hypothesisSha: 'h1',
        scopePaths: ['src/api'],
        regressionChecks: ['typecheck'],
        attempt: 1,
      }),
    ];
    // The signature must match the CURRENT failure's signature for the plan to count.
    const g = gate(events);
    const sig = g.repairVerdicts!.get('api')!.signature;
    const fixed = [...events.slice(0, 4), ev({ type: 'repair.attempted', callId: 'c', target: 'api', failureClass: 'runtime-process', signature: sig, hypothesis: 'h', hypothesisSha: 'h1', scopePaths: [], regressionChecks: ['typecheck'], attempt: 1 })];
    expect(checkDagRules(spawn(), gate(fixed))).toBeNull();
  });

  it('a non-auto-eligible class is refused outright, with escalate named as the exit', () => {
    reset();
    const depFail = (): SessionEvent =>
      ev({
        type: 'check.completed',
        callId: 'k',
        check: 'typecheck',
        recipeId: 'r',
        status: 'fail',
        exitCode: 1,
        termination: 'exited',
        durationMs: 1,
        summary: 'fail',
        signals: ['module-not-found'],
        planTaskId: 'api',
      });
    const events = [started('ch1'), endedErr('ch1', 'stalled'), started('ch2'), endedErr('ch2', 'stalled'), depFail()];
    const r = checkDagRules(spawn(), gate(events));
    expect(r).toContain('automatic repair is REFUSED');
    expect(r).toContain('requires-user-decision');
    expect(r).toContain('recover(action="escalate"');
  });

  it('R10 still caps the attempts, and now says WHAT failed', () => {
    reset();
    const events: SessionEvent[] = [];
    for (let i = 0; i < MAX_TASK_ATTEMPTS; i++) {
      events.push(started(`ch${i}`), endedErr(`ch${i}`, 'stalled'));
    }
    const r = checkDagRules(spawn(), gate(events));
    expect(r).toContain(`already failed ${MAX_TASK_ATTEMPTS} attempt(s)`);
    expect(r).toContain('classified: runtime-process');
    expect(r).toContain('Required evidence:');
    expect(r).toContain('recover(action="escalate")');
  });

  it('absent repairVerdicts (old callers) leaves the Session-11.5 retry path untouched', () => {
    reset();
    const events = [started('ch1'), endedErr('ch1', 'stalled'), started('ch2'), endedErr('ch2', 'stalled')];
    const g = graph();
    const state = {
      kind: 'canonical',
      status: 'approved',
      approvedAndCurrent: true,
      approvedSha: 's',
      diverged: false,
      canonical: { graph: g },
    } as unknown as PlanState;
    expect(checkDagRules(spawn(), { state, graphState: foldGraphState(g, events) })).toBeNull();
  });
});

describe('acceptance is blocked by unresolved recovery', () => {
  it('an open escalation and an unproven repair both appear as blockers', async () => {
    const { computeAcceptance } = await import('../src/runtime/acceptance.js');
    reset();
    const g = graph();
    const state = {
      kind: 'canonical',
      status: 'approved',
      approvedAndCurrent: true,
      approvedSha: 's',
      diverged: false,
      canonical: { graph: g },
    } as unknown as PlanState;
    const events = [
      started('ch1'),
      ev({ type: 'task.ended', callId: 'c-ch1', childSessionId: 'ch1', status: 'completed', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 }),
      ev({ type: 'task.changes', callId: 'c-ch1', childSessionId: 'ch1', baseOid: 'o', files: [{ relPath: 'src/api/a.ts', kind: 'modify', blobSha256: 'b', baseSha256: null, bytes: 1 }] }),
      ev({ type: 'task.applied', callId: 'c-ch1', childSessionId: 'ch1', applied: ['src/api/a.ts'], refused: [] }),
      ev({ type: 'check.completed', callId: 'k', check: 'typecheck' as CheckKind, recipeId: 'r', status: 'pass', exitCode: 0, termination: 'exited', durationMs: 1, summary: 'ok' }),
      ev({ type: 'repair.escalated', callId: 'c', target: 'session', failureClass: 'unknown', signature: 'sigX', reason: 'needs a decision' }),
      ev({ type: 'repair.attempted', callId: 'c', target: 'api', failureClass: 'compile-type', signature: 'sigY', hypothesis: 'h', hypothesisSha: 'h', scopePaths: [], regressionChecks: ['test'], attempt: 1 }),
    ];
    const acc = computeAcceptance(state, foldGraphState(g, events), events);
    expect(acc.complete).toBe(false);
    expect(acc.unfinished.join(' ')).toContain('repair escalated and unresolved');
    expect(acc.unfinished.join(' ')).toContain('is unproven');
  });

  it('an escalation on a task that is now completed with a green gate is resolved BY EVIDENCE', async () => {
    const { computeAcceptance } = await import('../src/runtime/acceptance.js');
    // Without this, an escalation on a non-auto-eligible class was an unclosable trap: only a
    // successful repair attempt could close it, and the policy refuses to record an attempt for
    // exactly those classes.
    reset();
    const g = graph();
    const state = {
      kind: 'canonical',
      status: 'approved',
      approvedAndCurrent: true,
      approvedSha: 's',
      diverged: false,
      canonical: { graph: g },
    } as unknown as PlanState;
    const events = [
      started('ch1'),
      ev({ type: 'repair.escalated', callId: 'c', target: 'api', failureClass: 'dependency-setup', signature: 'sigZ', reason: 'a module is missing' }),
      ev({ type: 'task.ended', callId: 'c-ch1', childSessionId: 'ch1', status: 'completed', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 }),
      ev({ type: 'task.changes', callId: 'c-ch1', childSessionId: 'ch1', baseOid: 'o', files: [{ relPath: 'src/api/a.ts', kind: 'modify', blobSha256: 'b', baseSha256: null, bytes: 1 }] }),
      ev({ type: 'task.applied', callId: 'c-ch1', childSessionId: 'ch1', applied: ['src/api/a.ts'], refused: [] }),
      ev({ type: 'check.completed', callId: 'k', check: 'typecheck' as CheckKind, recipeId: 'r', status: 'pass', exitCode: 0, termination: 'exited', durationMs: 1, summary: 'ok' }),
      // Session 14: the executor plan also derives the review requirement — a qualifying
      // clean round keeps this test about the ESCALATION axis.
      ev({ type: 'task.started', callId: 'rv', role: 'reviewer', childSessionId: 'child-rv', budget: {} }),
      ev({ type: 'task.ended', callId: 'rv', childSessionId: 'child-rv', status: 'completed', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 }),
      ev({ type: 'review.findings', callId: 'rv', childSessionId: 'child-rv', findings: [] }),
    ];
    const acc = computeAcceptance(state, foldGraphState(g, events), events);
    expect(acc.unfinished.join(' ')).not.toContain('repair escalated');
    expect(acc.complete).toBe(true);
  });

  it('a USER-dismissed session escalation stops blocking and is ALWAYS a caveat (S21)', async () => {
    const { computeAcceptance, workSince } = await import('../src/runtime/acceptance.js');
    reset();
    const g = graph();
    const state = {
      kind: 'canonical',
      status: 'approved',
      approvedAndCurrent: true,
      approvedSha: 's',
      diverged: false,
      canonical: { graph: g },
    } as unknown as PlanState;
    const escalated = ev({ type: 'repair.escalated', callId: 'c', target: 'session', failureClass: 'timeout-resource', signature: 'sigX', reason: 'wall clock expired' });
    const escSeq = (escalated as { seq: number }).seq;
    const base = [
      started('ch1'),
      ev({ type: 'task.ended', callId: 'c-ch1', childSessionId: 'ch1', status: 'completed', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 }),
      ev({ type: 'task.changes', callId: 'c-ch1', childSessionId: 'ch1', baseOid: 'o', files: [{ relPath: 'src/api/a.ts', kind: 'modify', blobSha256: 'b', baseSha256: null, bytes: 1 }] }),
      ev({ type: 'task.applied', callId: 'c-ch1', childSessionId: 'ch1', applied: ['src/api/a.ts'], refused: [] }),
      ev({ type: 'check.completed', callId: 'k', check: 'typecheck' as CheckKind, recipeId: 'r', status: 'pass', exitCode: 0, termination: 'exited', durationMs: 1, summary: 'ok' }),
      ev({ type: 'task.started', callId: 'rv', role: 'reviewer', childSessionId: 'child-rv', budget: {} }),
      ev({ type: 'task.ended', callId: 'rv', childSessionId: 'child-rv', status: 'completed', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 }),
      ev({ type: 'review.findings', callId: 'rv', childSessionId: 'child-rv', findings: [] }),
      escalated,
    ];
    // Before the dismissal: the session-targeted escalation blocks (the S20.5 live deadlock).
    const before = computeAcceptance(state, foldGraphState(g, base), base);
    expect(before.complete).toBe(false);
    expect(before.unfinished.join(' ')).toContain('repair escalated and unresolved: session');

    const dismissal = ev({ type: 'repair.dismissed', escalationSeq: escSeq, target: 'session', failureClass: 'timeout-resource', signature: 'sigX', reason: 'verified by hand', source: 'user' });
    const after = [...base, dismissal];
    const acc = computeAcceptance(state, foldGraphState(g, after), after);
    expect(acc.complete).toBe(true);
    expect(acc.unfinished.join(' ')).not.toContain('repair escalated');
    expect(acc.caveats.join(' ')).toContain("repair escalation on 'session' (timeout-resource) dismissed by the user: verified by hand");
    // The dismissal is work-shaped: after a refused/PARTIAL accept it is exactly the event that
    // makes re-accepting meaningful (and it forces a fresh delivery checkpoint).
    expect(workSince(after, (escalated as { seq: number }).seq)).toBe(true);
  });
});
