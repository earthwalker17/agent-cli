import { describe, it, expect } from 'vitest';
import { PlanGraphSchema, canonicalJson, planContentSha, planTaskDefinitionSha, validatePlanGraph } from '../src/plan/schema.js';
import { foldGraphState, completionGateState, integrationGateState } from '../src/plan/graph-state.js';
import type { PlanGraph } from '../src/plan/schema.js';
import type { SessionEvent } from '../src/types.js';

/**
 * Per-project verification scoping (Session 16). Two additive optional fields, and the property
 * that matters most about both: an existing plan's content sha must not move by one byte, because
 * that sha IS the user's recorded approval.
 */

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-31T00:00:00.000Z', ...body }) as unknown as SessionEvent;
const reset = (): void => {
  seq = 0;
};

const graph = (over: Partial<PlanGraph> = {}): PlanGraph =>
  PlanGraphSchema.parse({
    objective: 'ship it',
    tasks: [{ id: 'a', title: 'A', intent: 'do a', role: 'executor', verify: 'tests pass' }],
    ...over,
  });

const check = (over: Record<string, unknown>): SessionEvent =>
  ev({ type: 'check.completed', callId: 'c', check: 'test', recipeId: 'r', status: 'pass', exitCode: 0, durationMs: 1, summary: 'ok', ...over });

describe('sha stability — the approval binding must not move', () => {
  it('a plan without the new fields hashes EXACTLY as it did before they existed', () => {
    // The pre-Session-16 canonical form, written out literally: if either new field acquired a
    // default, or normalization started emitting it, this string would change and every approved
    // plan on disk would silently read as diverged.
    const g = validatePlanGraph(graph()).graph!;
    expect(canonicalJson(g)).toBe(
      '{"objective":"ship it","tasks":[{"dependsOn":[],"id":"a","intent":"do a","risk":"low","role":"executor","serial":false,"title":"A","touches":[],"verify":"tests pass"}],"version":1}',
    );
    expect(g.tasks[0]!.project).toBeUndefined();
    expect(g.gates).toBeUndefined();
  });

  it('an empty gates.projects list normalizes to absent, exactly as empty checks do', () => {
    const withEmpty = validatePlanGraph(graph({ gates: { completion: ['test'], projects: [] } } as never)).graph!;
    const without = validatePlanGraph(graph({ gates: { completion: ['test'] } } as never)).graph!;
    expect(planContentSha(withEmpty)).toBe(planContentSha(without));
  });

  it('a projects list beside NO gate kinds scopes nothing, so it is dropped', () => {
    const g = validatePlanGraph(graph({ gates: { projects: ['api'] } } as never)).graph!;
    expect(g.gates).toBeUndefined();
    expect(planContentSha(g)).toBe(planContentSha(validatePlanGraph(graph()).graph!));
  });

  it('gates.projects is order-insensitive — the sha binds the meaning, not the typing order', () => {
    const a = validatePlanGraph(graph({ gates: { completion: ['test'], projects: ['web', 'api'] } } as never)).graph!;
    const b = validatePlanGraph(graph({ gates: { completion: ['test'], projects: ['api', 'web'] } } as never)).graph!;
    expect(planContentSha(a)).toBe(planContentSha(b));
  });

  it('adding a task project DOES change the task definition sha — it is a semantic change', () => {
    const plain = validatePlanGraph(graph()).graph!.tasks[0]!;
    const scoped = validatePlanGraph(
      graph({ tasks: [{ id: 'a', title: 'A', intent: 'do a', role: 'executor', verify: 'tests pass', project: 'api' }] } as never),
    ).graph!.tasks[0]!;
    expect(planTaskDefinitionSha(scoped)).not.toBe(planTaskDefinitionSha(plain));
  });

  it('refuses an escaping project id on a task and in gates.projects', () => {
    expect(
      validatePlanGraph(graph({ tasks: [{ id: 'a', title: 'A', intent: 'x', role: 'executor', verify: 'v', project: '../evil' }] } as never)).errors.join(' '),
    ).toContain('not a contained workspace-relative directory');
    expect(validatePlanGraph(graph({ gates: { completion: ['test'], projects: ['/abs'] } } as never)).errors.join(' ')).toContain('gates.projects');
  });

  it('accepts "." as the root project', () => {
    const g = validatePlanGraph(
      graph({ tasks: [{ id: 'a', title: 'A', intent: 'x', role: 'executor', verify: 'v', project: '.' }] } as never),
    );
    expect(g.errors).toEqual([]);
    expect(g.graph!.tasks[0]!.project).toBe('.');
  });
});

describe('a task gate scoped to a project', () => {
  const scoped = (): PlanGraph =>
    validatePlanGraph(
      graph({
        tasks: [{ id: 'a', title: 'A', intent: 'x', role: 'executor', verify: 'v', checks: ['test'], project: 'api', touches: ['api'] }],
      } as never),
    ).graph!;

  function fold(events: SessionEvent[]) {
    return foldGraphState(scoped(), events);
  }

  const ranTask = (): SessionEvent[] => [
    ev({ type: 'task.started', callId: 'c', role: 'executor', childSessionId: 'ch1', budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 }, planTaskId: 'a' }),
    ev({ type: 'task.ended', callId: 'c', childSessionId: 'ch1', role: 'executor', status: 'completed', steps: 1, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0 } }),
    ev({ type: 'task.changes', callId: 'c', childSessionId: 'ch1', files: [], omitted: 0 }),
    ev({ type: 'task.applied', callId: 'c', childSessionId: 'ch1', applied: [], refused: [] }),
  ];

  it('is NOT satisfied by a pass in another project', () => {
    reset();
    const s = fold([...ranTask(), check({ projectId: 'web' })]);
    expect(s.tasks.find((t) => t.id === 'a')!.verification.status).toBe('pending');
  });

  it('IS satisfied by a pass in its own project', () => {
    reset();
    const s = fold([...ranTask(), check({ projectId: 'api' })]);
    expect(s.tasks.find((t) => t.id === 'a')!.verification.status).toBe('green');
  });

  it('an unscoped task still accepts any project — the pre-Session-16 reading is preserved', () => {
    reset();
    const g = validatePlanGraph(
      graph({ tasks: [{ id: 'a', title: 'A', intent: 'x', role: 'executor', verify: 'v', checks: ['test'] }] } as never),
    ).graph!;
    const s = foldGraphState(g, [...ranTask(), check({ projectId: 'web' })]);
    expect(s.tasks.find((t) => t.id === 'a')!.verification.status).toBe('green');
  });

  it('treats a legacy event with no projectId as the root project', () => {
    reset();
    const g = validatePlanGraph(
      graph({ tasks: [{ id: 'a', title: 'A', intent: 'x', role: 'executor', verify: 'v', checks: ['test'], project: '.' }] } as never),
    ).graph!;
    const s = foldGraphState(g, [...ranTask(), check({})]); // no projectId at all
    expect(s.tasks.find((t) => t.id === 'a')!.verification.status).toBe('green');
  });

  it("S20.5: a plan spelled 'API' matches checks recorded under the canonical 'api' where the filesystem folds case", () => {
    // selectUnit folds case (its comment documents the 'API' unclearable-gate trap), so on a
    // case-insensitive filesystem a check requested for project 'API' RUNS in canonical 'api'
    // and records projectId 'api'. The gate fold compared exactly — the plan's gate could then
    // never satisfy and never waive.
    //
    // The fold is `caseFold`, which is deliberately platform-aware, so the correct answer differs
    // and both halves are pinned (S22.6). Where the filesystem is case-SENSITIVE, `api` and `API`
    // are two different directories: selectUnit refuses the mismatch up front rather than running
    // the check somewhere else, so nothing records under 'api' on the task's behalf and the gate
    // stays honestly pending. Silently folding there would be the real bug — a green in `api`
    // reported as evidence about `API`.
    reset();
    const g = validatePlanGraph(
      graph({
        tasks: [{ id: 'a', title: 'A', intent: 'x', role: 'executor', verify: 'v', checks: ['test'], project: 'API', touches: ['api'] }],
      } as never),
    ).graph!;
    const s = foldGraphState(g, [...ranTask(), check({ projectId: 'api' })]);
    expect(s.tasks.find((t) => t.id === 'a')!.verification.status).toBe(process.platform === 'win32' ? 'green' : 'pending');
  });
});

describe('graph-level gates scoped to projects', () => {
  const g = (): PlanGraph => validatePlanGraph(graph({ gates: { completion: ['test'], projects: ['api', 'web'] } } as never)).graph!;

  it('needs EVERY named project — half a full-stack app verified is not complete', () => {
    reset();
    const events = [
      ev({ type: 'file.mutated', callId: 'm', path: 'C:/ws/x', kind: 'edit', beforeSha256: null, afterSha256: 'a', createdDirs: [] }),
      check({ projectId: 'api' }),
    ];
    expect(completionGateState(g(), events).pending).toEqual(['test']);

    events.push(check({ projectId: 'web' }));
    expect(completionGateState(g(), events).pending).toEqual([]);
  });

  it("S20.5: boundary-gate scopes fold case exactly as the filesystem does — gates.projects ['API'] vs runs in 'api'", () => {
    // Same platform-aware contract as the task-gate case above: folded where the filesystem folds,
    // distinct where it does not. A case-sensitive host must leave the gate PENDING rather than
    // accept a run in a different directory as proof for the one the plan named.
    reset();
    const gg = validatePlanGraph(graph({ gates: { completion: ['test'], projects: ['API', 'web'] } } as never)).graph!;
    const events = [
      ev({ type: 'file.mutated', callId: 'm', path: 'C:/ws/x', kind: 'edit', beforeSha256: null, afterSha256: 'a', createdDirs: [] }),
      check({ projectId: 'api' }),
      check({ projectId: 'web' }),
    ];
    expect(completionGateState(gg, events).pending).toEqual(process.platform === 'win32' ? [] : ['test']);
  });

  it('an honestly unsupported project waives, a bad-request one never does', () => {
    reset();
    const base = [ev({ type: 'file.mutated', callId: 'm', path: 'C:/ws/x', kind: 'edit', beforeSha256: null, afterSha256: 'a', createdDirs: [] })];
    const waived = completionGateState(g(), [
      ...base,
      check({ projectId: 'api' }),
      check({ projectId: 'web', status: 'unsupported', exitCode: null, unsupportedReason: 'no-recipe' }),
    ]);
    expect(waived.pending).toEqual([]);
    expect(waived.waived).toEqual(['test']);

    const notWaived = completionGateState(g(), [
      ...base,
      check({ projectId: 'api' }),
      check({ projectId: 'web', status: 'unsupported', exitCode: null, unsupportedReason: 'bad-request' }),
    ]);
    expect(notWaived.pending).toEqual(['test']);
  });

  it('without gates.projects the any-project reading stands', () => {
    reset();
    const unscoped = validatePlanGraph(graph({ gates: { completion: ['test'] } } as never)).graph!;
    const events = [
      ev({ type: 'file.mutated', callId: 'm', path: 'C:/ws/x', kind: 'edit', beforeSha256: null, afterSha256: 'a', createdDirs: [] }),
      check({ projectId: 'api' }),
    ];
    expect(completionGateState(unscoped, events).pending).toEqual([]);
  });

  it('scopes the integration gate the same way', () => {
    reset();
    const ig = validatePlanGraph(graph({ gates: { integration: ['build'], projects: ['api', 'web'] } } as never)).graph!;
    const events = [
      ev({ type: 'task.applied', callId: 'c', childSessionId: 'ch1', applied: [], refused: [] }),
      check({ check: 'build', projectId: 'api' }),
    ];
    expect(integrationGateState(ig, events).pending).toEqual(['build']);
    events.push(check({ check: 'build', projectId: 'web' }));
    expect(integrationGateState(ig, events).pending).toEqual([]);
  });
});
