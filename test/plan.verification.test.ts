import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  planContentSha,
  planTaskDefinitionSha,
  validatePlanGraph,
  PlanGraphSchema,
  type PlanGraph,
} from '../src/plan/schema.js';
import { completionGateState, depSatisfied, foldGraphState, integrationGateState } from '../src/plan/graph-state.js';
import { computeAcceptance } from '../src/runtime/acceptance.js';
import { checkDagRules, type PlanGateInfo } from '../src/tools/delegate.js';
import { renderAgentPlanView, renderUserPlanView } from '../src/plan/views.js';
import type { CheckKind, SessionEvent } from '../src/types.js';
import type { PlanState } from '../src/plan/canonical.js';

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-25T00:00:00.000Z', ...body }) as unknown as SessionEvent;
function reset(): void {
  seq = 0;
}

const started = (planTaskId: string, child: string): SessionEvent =>
  ev({ type: 'task.started', callId: `c-${child}`, role: 'executor', childSessionId: child, budget: {}, planTaskId });
const endedOk = (child: string): SessionEvent =>
  ev({ type: 'task.ended', callId: `c-${child}`, childSessionId: child, status: 'completed', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 });
const changed = (child: string, relPath: string): SessionEvent =>
  ev({ type: 'task.changes', callId: `c-${child}`, childSessionId: child, baseOid: 'o', files: [{ relPath, kind: 'modify', blobSha256: 'b', baseSha256: null, bytes: 1 }] });
const appliedAll = (child: string, paths: string[]): SessionEvent =>
  ev({ type: 'task.applied', callId: `c-${child}`, childSessionId: child, applied: paths, refused: [] });
const checkDone = (check: CheckKind, status: string): SessionEvent =>
  ev({ type: 'check.completed', callId: 'k', check, recipeId: 'r', status, exitCode: status === 'pass' ? 0 : 1, durationMs: 1, summary: `${check} ${status}` });
const mutated = (): SessionEvent =>
  ev({ type: 'file.mutated', callId: 'm', path: 'src/a.ts', kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] });

function graphOf(over: Partial<PlanGraph> = {}, tasks?: unknown[]): PlanGraph {
  const parsed = PlanGraphSchema.parse({
    objective: 'ship it',
    tasks: tasks ?? [
      { id: 'api', title: 'API', intent: 'i', role: 'executor', verify: 'tests pass', touches: ['src/api'], checks: ['test'] },
      { id: 'ui', title: 'UI', intent: 'i', role: 'executor', verify: 'tests pass', touches: ['src/ui'], dependsOn: ['api'] },
    ],
    ...over,
  });
  return validatePlanGraph(parsed).graph!;
}

describe('schema: the new fields are sha-neutral when absent', () => {
  it('a plan without checks/gates serializes with no trace of them', () => {
    const g = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const json = canonicalJson(g);
    expect(json).not.toContain('checks');
    expect(json).not.toContain('gates');
    // The definition sha is a function of the canonical form — no key, no contribution.
    expect(planTaskDefinitionSha(g.tasks[0]!)).toBe(planTaskDefinitionSha({ ...g.tasks[0]! }));
  });

  it('an EMPTY checks list normalizes to absent so it cannot change the approval sha', () => {
    const bare = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const empty = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v', checks: [] }]);
    expect(planContentSha(empty)).toBe(planContentSha(bare));
  });

  it('empty gates normalize away too', () => {
    const bare = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const empty = graphOf({ gates: { integration: [], completion: [] } }, [
      { id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' },
    ]);
    expect(planContentSha(empty)).toBe(planContentSha(bare));
  });

  it('declaring a real gate DOES change the sha (it is a semantic change)', () => {
    const bare = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const gated = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v', checks: ['test'] }]);
    expect(planContentSha(gated)).not.toBe(planContentSha(bare));
    expect(planTaskDefinitionSha(gated.tasks[0]!)).not.toBe(planTaskDefinitionSha(bare.tasks[0]!));
  });
});

describe('schema: validation of declared gates', () => {
  const parse = (tasks: unknown[], over: Record<string, unknown> = {}): ReturnType<typeof validatePlanGraph> =>
    validatePlanGraph(PlanGraphSchema.parse({ objective: 'o', tasks, ...over }));

  it('refuses checks on a parent-owned (role main) task and says why', () => {
    const v = parse([{ id: 'a', title: 'A', intent: 'i', role: 'main', verify: 'v', checks: ['test'] }]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain("cannot declare 'checks'");
    expect(v.errors.join(' ')).toContain('gates.completion');
  });

  it('refuses a duplicate check kind', () => {
    const v = parse([{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v', checks: ['test', 'test'] }]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('duplicate check kind');
  });

  it('warns (never blocks) when a declared kind cannot run in this project', () => {
    const graph = PlanGraphSchema.parse({
      objective: 'o',
      gates: { completion: ['lint'] },
      tasks: [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v', checks: ['test'] }],
    });
    const v = validatePlanGraph(graph, { availableChecks: ['test'] as CheckKind[] });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toContain('lint');
    expect(v.warnings.join(' ')).toContain('UNSUPPORTED');
    expect(validatePlanGraph(graph, { availableChecks: ['test', 'lint'] as CheckKind[] }).warnings.join(' ')).not.toContain('cannot run');
  });

  it('warns when a targeted-test gate has no touches to scope it', () => {
    const v = parse([{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v', checks: ['test-targeted'] }]);
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toContain('test-targeted');
  });
});

describe('schema: the review declaration (Session 14)', () => {
  const parse = (tasks: unknown[], over: Record<string, unknown> = {}): ReturnType<typeof validatePlanGraph> =>
    validatePlanGraph(PlanGraphSchema.parse({ objective: 'o', tasks, ...over }));
  const EXEC = { id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' };
  const MAIN = { id: 'a', title: 'A', intent: 'i', role: 'main', verify: 'v' };

  it('absent review is sha-neutral; declaring one changes the sha (semantic change)', () => {
    const bare = graphOf({}, [EXEC]);
    expect(canonicalJson(bare)).not.toContain('review');
    const declared = graphOf({ review: { mode: 'required' } }, [EXEC]);
    expect(planContentSha(declared)).not.toBe(planContentSha(bare));
  });

  it("waived requires a substantive reason — the waiver IS what the user approves", () => {
    const noReason = parse([EXEC], { review: { mode: 'waived' } });
    expect(noReason.ok).toBe(false);
    expect(noReason.errors.join(' ')).toContain("'waived' requires a substantive 'reason'");
    const thin = parse([EXEC], { review: { mode: 'waived', reason: 'meh' } });
    expect(thin.ok).toBe(false);
    const real = parse([EXEC], { review: { mode: 'waived', reason: 'single-file config change, no logic touched' } });
    expect(real.ok).toBe(true);
    expect(real.graph?.review).toEqual({ mode: 'waived', reason: 'single-file config change, no logic touched' });
  });

  it('waiving a plan with no executor tasks warns that it waives nothing', () => {
    const v = parse([MAIN], { review: { mode: 'waived', reason: 'nothing here mutates through executors' } });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toContain('waives nothing');
  });

  it('declaring required on an executor plan warns it is the derived default (harmless)', () => {
    const v = parse([EXEC], { review: { mode: 'required' } });
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toContain('derived default');
  });

  it('both projections render the declaration — a waiver is impossible to miss, the default is stated', () => {
    const doc = (graph: PlanGraph) =>
      ({ planId: 'p', status: 'draft', updated: 't', graph, contentSha: 'c'.repeat(64) }) as never;
    const waived = graphOf({ review: { mode: 'waived', reason: 'demo scope only, reviewed by hand' } }, [EXEC]);
    expect(renderUserPlanView(doc(waived))).toContain('WAIVED');
    expect(renderUserPlanView(doc(waived))).toContain('demo scope only, reviewed by hand');
    expect(renderAgentPlanView(doc(waived))).toContain('Review: WAIVED');
    const derived = graphOf({}, [EXEC]);
    expect(renderUserPlanView(doc(derived))).toContain('default for executor plans');
    expect(renderAgentPlanView(doc(derived))).toContain('derived: executor plan');
    // A parent-only plan with no declaration derives nothing — and says nothing.
    const silent = graphOf({}, [MAIN]);
    expect(renderUserPlanView(doc(silent))).not.toContain('Adversarial review');
    expect(renderAgentPlanView(doc(silent))).not.toContain('Review:');
  });
});

describe('fold: the per-task gate blocks dependents', () => {
  it('an integrated task with an unsatisfied gate stays completed but does NOT satisfy dependents', () => {
    reset();
    const g = graphOf();
    const events = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    const gs = foldGraphState(g, events);
    const api = gs.byId.get('api')!;
    expect(api.state).toBe('completed');
    expect(api.verification).toMatchObject({ status: 'pending', missing: ['test'] });
    expect(depSatisfied(api)).toBe(false);
    expect(gs.byId.get('ui')!.state).toBe('blocked');
    expect(gs.ready).not.toContain('ui');
    expect(gs.summary).toContain('awaiting checks: api (test)');
    expect(gs.summary).toContain('0/2 completed');
  });

  it('a passing check AFTER integration unblocks the dependent', () => {
    reset();
    const g = graphOf();
    const events = [
      started('api', 'ch1'),
      endedOk('ch1'),
      changed('ch1', 'src/api/a.ts'),
      appliedAll('ch1', ['src/api/a.ts']),
      checkDone('test', 'pass'),
    ];
    const gs = foldGraphState(g, events);
    expect(gs.byId.get('api')!.verification).toMatchObject({ status: 'green', satisfied: ['test'] });
    expect(depSatisfied(gs.byId.get('api')!)).toBe(true);
    expect(gs.byId.get('ui')!.state).toBe('queued');
    expect(gs.ready).toContain('ui');
    expect(gs.summary).toContain('1/2 completed');
  });

  it('a check that ran BEFORE the work was integrated does not satisfy the gate', () => {
    reset();
    const g = graphOf();
    const events = [
      checkDone('test', 'pass'),
      started('api', 'ch1'),
      endedOk('ch1'),
      changed('ch1', 'src/api/a.ts'),
      appliedAll('ch1', ['src/api/a.ts']),
    ];
    expect(foldGraphState(g, events).byId.get('api')!.verification.status).toBe('pending');
  });

  it('a FAILING check does not satisfy the gate', () => {
    reset();
    const g = graphOf();
    const events = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts']), checkDone('test', 'fail')];
    expect(foldGraphState(g, events).byId.get('api')!.verification.status).toBe('pending');
  });

  it('an UNSUPPORTED check waives the gate with a recorded caveat — never a silent pass', () => {
    reset();
    const g = graphOf();
    const events = [
      started('api', 'ch1'),
      endedOk('ch1'),
      changed('ch1', 'src/api/a.ts'),
      appliedAll('ch1', ['src/api/a.ts']),
      checkDone('test', 'unsupported'),
    ];
    const gs = foldGraphState(g, events);
    const api = gs.byId.get('api')!;
    expect(api.verification).toMatchObject({ status: 'waived', waived: ['test'] });
    expect(depSatisfied(api)).toBe(true);
    expect(api.note).toContain('WAIVED');
    expect(api.note).toContain('not proof');
  });

  it('a BAD-REQUEST unsupported never waives a gate — only a project-capability one does', () => {
    // Review finding: `unsupported` was treated as a project fact, but resolveChecks also returns
    // it for caller mistakes. A routine malformed call could retire verification the user asked
    // for, with no approval and a note falsely blaming the project.
    reset();
    const g = graphOf();
    const done = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    const bad = [...done, ev({ type: 'check.completed', callId: 'k', check: 'test', recipeId: '(none)', status: 'unsupported', unsupportedReason: 'bad-request', exitCode: null, durationMs: 0, summary: 'bad' })];
    expect(foldGraphState(g, bad).byId.get('api')!.verification.status).toBe('pending');

    reset();
    const done2 = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    const capability = [...done2, ev({ type: 'check.completed', callId: 'k', check: 'test', recipeId: '(none)', status: 'unsupported', unsupportedReason: 'no-recipe', exitCode: null, durationMs: 0, summary: 'none' })];
    expect(foldGraphState(g, capability).byId.get('api')!.verification.status).toBe('waived');
  });

  it('anchors on ALL of a task’s bindings, so integrating an earlier attempt re-opens the gate', () => {
    // Review finding: anchoring on the LAST binding alone left a stale-green gate when an earlier
    // failed attempt's capture was applied afterwards — work landing after the passing check.
    reset();
    const g = graphOf();
    const events = [
      started('api', 'chA'),
      ev({ type: 'task.ended', callId: 'c-chA', childSessionId: 'chA', status: 'error', steps: 1, usage: { inputTokens: 0, outputTokens: 0 }, resultSha256: 'x', durationMs: 1 }),
      changed('chA', 'src/api/old.ts'),
      started('api', 'chB'),
      endedOk('chB'),
      changed('chB', 'src/api/new.ts'),
      appliedAll('chB', ['src/api/new.ts']),
      checkDone('test', 'pass'),
    ];
    expect(foldGraphState(g, events).byId.get('api')!.verification.status).toBe('green');

    // Now the earlier attempt's captured file is integrated — that is this task's work landing
    // AFTER the passing check, so the gate must re-open.
    const later = [...events, appliedAll('chA', ['src/api/old.ts'])];
    expect(foldGraphState(g, later).byId.get('api')!.verification.status).toBe('pending');
  });

  it('a targeted-test gate is not satisfied by a run over unrelated files', () => {
    // Review finding: for test-targeted the SCOPE is the check; matching on kind alone let a
    // green run of somebody else's tests discharge this task's gate.
    reset();
    const g = graphOf({}, [
      { id: 'api', title: 'API', intent: 'i', role: 'executor', verify: 'v', touches: ['src/api'], checks: ['test-targeted'] },
    ]);
    const done = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    const elsewhere = [...done, ev({ type: 'check.completed', callId: 'k', check: 'test-targeted', recipeId: 'r', status: 'pass', exitCode: 0, termination: 'exited', durationMs: 1, summary: 'ok', scopePaths: ['test/smoke.test.ts'] })];
    expect(foldGraphState(g, elsewhere).byId.get('api')!.verification.status).toBe('pending');

    reset();
    const done2 = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    const onScope = [...done2, ev({ type: 'check.completed', callId: 'k', check: 'test-targeted', recipeId: 'r', status: 'pass', exitCode: 0, termination: 'exited', durationMs: 1, summary: 'ok', scopePaths: ['src/api/a.ts'] })];
    expect(foldGraphState(g, onScope).byId.get('api')!.verification.status).toBe('green');
  });

  it('a task with no declared checks is completely unaffected', () => {
    reset();
    const g = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const events = [started('a', 'ch1'), endedOk('ch1'), changed('ch1', 'x'), appliedAll('ch1', ['x'])];
    const st = foldGraphState(g, events).byId.get('a')!;
    expect(st.state).toBe('completed');
    expect(st.verification.status).toBe('none');
    expect(depSatisfied(st)).toBe(true);
  });
});

describe('the DAG gate reads the check gate', () => {
  function gate(g: PlanGraph, events: SessionEvent[], integration = true): PlanGateInfo {
    const state = {
      kind: 'canonical',
      status: 'approved',
      approvedAndCurrent: true,
      approvedSha: 'sha',
      diverged: false,
      canonical: { graph: g },
    } as unknown as PlanState;
    return {
      state,
      graphState: foldGraphState(g, events),
      ...(integration ? { integrationGate: integrationGateState(g, events) } : {}),
    };
  }

  it('R4 names the dependency’s missing checks, not just "blocked"', () => {
    reset();
    const g = graphOf();
    const events = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    const refusal = checkDagRules([{ role: 'executor', plan_task: 'ui' }], gate(g, events));
    expect(refusal).toContain("'api' is completed");
    expect(refusal).toContain('required check(s) have not passed: test');
  });

  it('R12 refuses a new executor wave while the integration gate is pending', () => {
    reset();
    const g = graphOf({ gates: { integration: ['typecheck'] } });
    const events = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts']), checkDone('test', 'pass')];
    const refusal = checkDagRules([{ role: 'executor', plan_task: 'ui' }], gate(g, events));
    expect(refusal).toContain('integration gate has not passed');
    expect(refusal).toContain('typecheck');
  });

  it('R12 does not fire before any integration, nor for read-only groups, nor once green', () => {
    reset();
    const g = graphOf({ gates: { integration: ['typecheck'] } });
    expect(checkDagRules([{ role: 'executor', plan_task: 'api' }], gate(g, []))).toBeNull();

    reset();
    const afterApply = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    expect(checkDagRules([{ role: 'explorer' }], gate(g, afterApply))).toBeNull();

    reset();
    const green = [...[started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])], checkDone('typecheck', 'pass'), checkDone('test', 'pass')];
    expect(checkDagRules([{ role: 'executor', plan_task: 'ui' }], gate(g, green))).toBeNull();
  });

  it('an absent integrationGate (old callers) never fires the rule', () => {
    reset();
    const g = graphOf({ gates: { integration: ['typecheck'] } });
    const events = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts']), checkDone('test', 'pass')];
    expect(checkDagRules([{ role: 'executor', plan_task: 'ui' }], gate(g, events, false))).toBeNull();
  });
});

describe('acceptance: gates are completion blockers', () => {
  const planState = (g: PlanGraph): PlanState =>
    ({ kind: 'canonical', status: 'approved', approvedAndCurrent: true, approvedSha: 's', diverged: false, canonical: { graph: g } }) as unknown as PlanState;

  it('a completed task with a pending gate is UNFINISHED', () => {
    reset();
    const g = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v', checks: ['test'] }]);
    const events = [started('a', 'ch1'), endedOk('ch1'), changed('ch1', 'x'), appliedAll('ch1', ['x'])];
    const acc = computeAcceptance(planState(g), foldGraphState(g, events), events);
    expect(acc.complete).toBe(false);
    expect(acc.unfinished.join(' ')).toContain("plan task 'a' is completed but its required check(s) have not passed");
  });

  it('a passing check completes it', () => {
    reset();
    const g = graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v', checks: ['test'] }]);
    const events = [started('a', 'ch1'), endedOk('ch1'), changed('ch1', 'x'), appliedAll('ch1', ['x']), checkDone('test', 'pass')];
    const acc = computeAcceptance(planState(g), foldGraphState(g, events), events);
    expect(acc.complete).toBe(true);
  });

  it('an unsatisfied completion gate blocks acceptance, and a later change re-opens it', () => {
    reset();
    const g = graphOf({ gates: { completion: ['build'] } }, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const done = [started('a', 'ch1'), endedOk('ch1'), changed('ch1', 'x'), appliedAll('ch1', ['x'])];
    expect(computeAcceptance(planState(g), foldGraphState(g, done), done).unfinished.join(' ')).toContain("completion gate 'build'");

    const green = [...done, checkDone('build', 'pass')];
    expect(computeAcceptance(planState(g), foldGraphState(g, green), green).complete).toBe(true);

    // Any later change invalidates it — the strict staleness rule.
    const changedAgain = [...green, mutated()];
    const acc = computeAcceptance(planState(g), foldGraphState(g, changedAgain), changedAgain);
    expect(acc.complete).toBe(false);
    expect(acc.unfinished.join(' ')).toContain('has not passed since the last change');
  });

  it('an /undo after a green completion gate re-opens it — the gate measures the CURRENT tree', () => {
    // Review finding: applyUndo writes files back to disk but records only `undo.applied`, so a
    // gate anchored on file.mutated alone stayed green over a workspace that no longer existed.
    reset();
    const g = graphOf({ gates: { completion: ['build'] } }, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const green = [started('a', 'ch1'), endedOk('ch1'), changed('ch1', 'x'), appliedAll('ch1', ['x']), mutated(), checkDone('build', 'pass')];
    expect(completionGateState(g, green).pending).toEqual([]);

    const undone = [...green, ev({ type: 'undo.applied', target: 'last', restored: [{ path: 'src/a.ts', toSha256: 'a' }], refused: [] })];
    expect(completionGateState(g, undone).pending).toEqual(['build']);

    const restored = [...green, ev({ type: 'git.restore', ref: 'r', oid: 'o', restored: ['src/a.ts'], refused: [] })];
    expect(completionGateState(g, restored).pending).toEqual(['build']);
  });

  it('a WAIVED gate is surfaced as a caveat on the acceptance summary, never silently dropped', () => {
    // Review finding: "complete" could be recorded while a gate the user approved never ran.
    reset();
    const g = graphOf({ gates: { completion: ['lint'] } }, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const events = [
      started('a', 'ch1'),
      endedOk('ch1'),
      changed('ch1', 'x'),
      appliedAll('ch1', ['x']),
      mutated(),
      ev({ type: 'check.completed', callId: 'k', check: 'lint', recipeId: '(none)', status: 'unsupported', unsupportedReason: 'no-recipe', exitCode: null, durationMs: 0, summary: 'no lint recipe' }),
    ];
    const acc = computeAcceptance(planState(g), foldGraphState(g, events), events);
    expect(acc.complete).toBe(true);
    expect(acc.caveats.join(' ')).toContain("completion gate 'lint' NEVER RAN");
    expect(acc.summary).toContain('CAVEATS');
  });

  it('completionGateState waives an unsupported kind rather than stranding the session', () => {
    reset();
    const g = graphOf({ gates: { completion: ['lint'] } }, [{ id: 'a', title: 'A', intent: 'i', role: 'executor', verify: 'v' }]);
    const events = [mutated(), checkDone('lint', 'unsupported')];
    const gate = completionGateState(g, events);
    expect(gate.pending).toEqual([]);
    expect(gate.waived).toEqual(['lint']);
  });
});

describe('views render the gate the user approves', () => {
  it('the user view has a checks column and a Gates section', () => {
    const g = graphOf({ gates: { integration: ['typecheck'], completion: ['build', 'test'] } });
    const md = renderUserPlanView({ planId: 'p', status: 'draft', contentSha: 'sha', graph: g } as never);
    expect(md).toContain('| checks |');
    expect(md).toContain('| test |');
    expect(md).toContain('## Gates');
    expect(md).toContain('**integration**');
    expect(md).toContain('**completion** (after the last change, before the session can be accepted): build, test');
  });

  it('the agent view shows declared checks with their LIVE gate state', () => {
    reset();
    const g = graphOf();
    const events = [started('api', 'ch1'), endedOk('ch1'), changed('ch1', 'src/api/a.ts'), appliedAll('ch1', ['src/api/a.ts'])];
    const view = renderAgentPlanView({ planId: 'p', status: 'approved', contentSha: 'sha', graph: g } as never, foldGraphState(g, events));
    expect(view).toContain('checks (gate dependents): test — PENDING: test');
  });
});
