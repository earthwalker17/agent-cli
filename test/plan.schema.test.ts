import { describe, it, expect } from 'vitest';
import {
  PlanGraphSchema,
  canonicalJson,
  planContentSha,
  validatePlanGraph,
  normalizeTouchPrefix,
  touchPrefixesOverlap,
  topoOrder,
  PLAN_GRAPH_MAX_CHARS,
  type PlanGraph,
} from '../src/plan/schema.js';

/**
 * The canonical plan schema: zod shape + semantic validation (unique ids, acyclic deps,
 * contained touches, verify-where-mutating) and the deterministic content identity that
 * approval binds. Validation errors must be exact — the model's revision loop depends on it.
 */

function graph(partial: Record<string, unknown>): PlanGraph {
  return PlanGraphSchema.parse({ objective: 'test objective', ...partial });
}

const T = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `task ${id}`,
  intent: `do ${id}`,
  role: 'executor',
  verify: 'run the checks',
  ...over,
});

describe('plan schema shape', () => {
  it('parses a minimal graph and fills defaults', () => {
    const g = graph({ tasks: [T('t1')] });
    expect(g.version).toBe(1);
    expect(g.tasks[0]).toMatchObject({ dependsOn: [], touches: [], risk: 'low', serial: false });
  });

  it('rejects unknown keys (strict) and malformed ids', () => {
    expect(PlanGraphSchema.safeParse({ objective: 'x', tasks: [T('t1')], extra: 1 }).success).toBe(false);
    expect(PlanGraphSchema.safeParse({ objective: 'x', tasks: [T('Bad_ID')] }).success).toBe(false);
    expect(PlanGraphSchema.safeParse({ objective: 'x', tasks: [T('-lead')] }).success).toBe(false);
  });
});

describe('canonicalJson / planContentSha determinism', () => {
  it('is independent of key order and formatting, sensitive to content', () => {
    const a = { b: 1, a: [{ y: 2, x: 1 }], s: 'é' };
    const b = { s: 'é', a: [{ x: 1, y: 2 }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    // Array ORDER is content (dependsOn order, task order) — never sorted away.
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    // undefined-valued keys are dropped, matching JSON.stringify semantics.
    expect(canonicalJson({ a: 1, gone: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('planContentSha equal for semantically equal graphs', () => {
    const g1 = graph({ tasks: [T('t1'), T('t2', { dependsOn: ['t1'] })] });
    const g2 = graph({ tasks: [T('t1'), T('t2', { dependsOn: ['t1'] })] });
    expect(planContentSha(g1)).toBe(planContentSha(g2));
    const g3 = graph({ tasks: [T('t1'), T('t2', { dependsOn: ['t1'], title: 'changed' })] });
    expect(planContentSha(g3)).not.toBe(planContentSha(g1));
  });
});

describe('touch prefix normalization and containment', () => {
  it('normalizes separators and dots; rejects escapes and absolutes', () => {
    expect(normalizeTouchPrefix('src\\x\\')).toBe('src/x');
    expect(normalizeTouchPrefix('./src/y/')).toBe('src/y');
    expect(normalizeTouchPrefix('..')).toBeNull();
    expect(normalizeTouchPrefix('src/../..')).toBeNull();
    expect(normalizeTouchPrefix('/abs')).toBeNull();
    expect(normalizeTouchPrefix('C:/win')).toBeNull();
    expect(normalizeTouchPrefix('.')).toBeNull();
  });

  it('overlap = equality or path-nesting, not string prefixing', () => {
    expect(touchPrefixesOverlap('src/a', 'src/a')).toBe(true);
    expect(touchPrefixesOverlap('src/a', 'src/a/deep')).toBe(true);
    expect(touchPrefixesOverlap('src/a', 'src/ab')).toBe(false);
  });
});

describe('validatePlanGraph', () => {
  it('accepts a well-formed graph and normalizes touches', () => {
    const v = validatePlanGraph(graph({ tasks: [T('t1', { touches: ['src\\x\\', './src/x/'] })] }));
    expect(v.ok).toBe(true);
    expect(v.graph!.tasks[0]!.touches).toEqual(['src/x']); // normalized + deduped
  });

  it('reports duplicates, unknown/self/duplicate deps — completely, not first-error-only', () => {
    const v = validatePlanGraph(
      graph({
        tasks: [T('t1'), T('t1'), T('t2', { dependsOn: ['ghost', 't2', 't1', 't1'] })],
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain("duplicate task id 't1'");
    expect(v.errors.join('\n')).toContain("depends on unknown task 'ghost'");
    expect(v.errors.join('\n')).toContain("depends on itself");
    expect(v.errors.join('\n')).toContain('duplicate dependency');
  });

  it('requires verify for executor and main, not for read-only roles', () => {
    const v = validatePlanGraph(
      graph({
        tasks: [
          T('t1', { verify: '  ' }),
          T('t2', { role: 'main', verify: '' }),
          T('t3', { role: 'explorer', verify: '' }),
          T('t4', { role: 'reviewer', verify: '' }),
        ],
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors.filter((e) => e.includes("requires non-empty 'verify'"))).toHaveLength(2);
  });

  it('rejects escaping touch prefixes with the offending value named', () => {
    const v = validatePlanGraph(graph({ tasks: [T('t1', { touches: ['../outside'] })] }));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("'../outside'");
  });

  it('reports a concrete cycle path', () => {
    const v = validatePlanGraph(
      graph({
        tasks: [T('t1', { dependsOn: ['t3'] }), T('t2', { dependsOn: ['t1'] }), T('t3', { dependsOn: ['t2'] })],
      }),
    );
    expect(v.ok).toBe(false);
    const cyc = v.errors.find((e) => e.startsWith('dependency cycle:'));
    expect(cyc).toBeDefined();
    // The path walks the cycle and returns to its start.
    const ids = cyc!.replace('dependency cycle: ', '').split(' -> ');
    expect(ids[0]).toBe(ids[ids.length - 1]);
    expect(ids.length).toBeGreaterThanOrEqual(4);
  });

  it('warns (never blocks) on overlapping touches between dependency-UNORDERED tasks only', () => {
    const ordered = validatePlanGraph(
      graph({ tasks: [T('t1', { touches: ['src/x'] }), T('t2', { dependsOn: ['t1'], touches: ['src/x'] })] }),
    );
    expect(ordered.ok).toBe(true);
    expect(ordered.warnings).toEqual([]);

    const unordered = validatePlanGraph(
      graph({ tasks: [T('t1', { touches: ['src/x'] }), T('t2', { touches: ['src/x/deep'] })] }),
    );
    expect(unordered.ok).toBe(true);
    expect(unordered.warnings.join('\n')).toContain("'t1' and 't2'");
    expect(unordered.warnings.join('\n')).toContain('never run in the same parallel group');
  });

  it('caps the canonical serialization size', () => {
    const v = validatePlanGraph(
      graph({
        objective: 'big',
        tasks: Array.from({ length: 20 }, (_, i) => T(`t${i}`, { intent: 'x'.repeat(1900) })),
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toContain(`max ${PLAN_GRAPH_MAX_CHARS}`);
  });
});

describe('topoOrder', () => {
  it('orders dependencies first, stable among ready tasks; null on a cycle', () => {
    const g = graph({
      tasks: [T('t3', { dependsOn: ['t1', 't2'] }), T('t1'), T('t2', { dependsOn: ['t1'] })],
    });
    expect(topoOrder(g.tasks)).toEqual(['t1', 't2', 't3']);

    const cyc = PlanGraphSchema.parse({
      objective: 'x',
      tasks: [T('a', { dependsOn: ['b'] }), T('b', { dependsOn: ['a'] })],
    });
    expect(topoOrder(cyc.tasks)).toBeNull();
  });
});
