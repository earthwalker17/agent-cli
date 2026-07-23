import { z } from 'zod';
import { sha256 } from '../shared/hash.js';

/**
 * The canonical structured plan (Session 11): one schema-validated task graph per session,
 * the single source of truth that the user-facing and agent-facing plan views are PROJECTED
 * from. Execution status deliberately does NOT live here — it is derived from the event log
 * (`plan/graph-state.ts`), so there is exactly one writable plan truth and one derived
 * execution truth (two writable status sources would be the double-truth trap).
 *
 * Approval binds `planContentSha` — the sha256 of the deterministic serialization of the
 * `plan` sub-object ONLY. Wrapper fields (status, updated timestamp) are sha-neutral by
 * construction, so /plan approve never invalidates what it approves, and whitespace-only
 * hand-edits are approval-neutral while any semantic edit invalidates.
 */

/** Task ids are short slugs: stable across amendments, cheap to type in /cancel and plan_task. */
const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const PLAN_GRAPH_VERSION = 1 as const;

/** Serialized canonical form must stay well under the plan injection/read caps. */
export const PLAN_GRAPH_MAX_CHARS = 32_000;

export type PlanTaskRole = 'executor' | 'explorer' | 'reviewer' | 'main';

export const PlanTaskSchema = z
  .object({
    id: z.string().regex(TASK_ID_RE, 'task id must be a slug: [a-z0-9][a-z0-9-]{0,40}'),
    title: z.string().min(1).max(120),
    intent: z.string().min(1).max(2000).describe('What this task does and why — seeds the child brief.'),
    role: z.enum(['executor', 'explorer', 'reviewer', 'main']),
    dependsOn: z.array(z.string().regex(TASK_ID_RE)).max(8).default([]),
    touches: z
      .array(z.string().min(1).max(260))
      .max(16)
      .default([])
      .describe('Workspace-relative path prefixes this task expects to change or own.'),
    verify: z
      .string()
      .max(500)
      .default('')
      .describe('How the parent will check this task succeeded. Required for executor/main tasks.'),
    risk: z.enum(['low', 'medium', 'high']).default('low'),
    serial: z.boolean().default(false).describe('Must run alone, never grouped with other tasks.'),
  })
  .strict();

export const PlanGraphSchema = z
  .object({
    version: z.literal(PLAN_GRAPH_VERSION).default(PLAN_GRAPH_VERSION),
    objective: z.string().min(1).max(2000),
    approach: z.string().max(4000).optional(),
    risks: z.array(z.string().max(300)).max(12).optional(),
    notes: z.string().max(4000).optional(),
    tasks: z.array(PlanTaskSchema).min(1).max(20),
  })
  .strict();

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type PlanGraph = z.infer<typeof PlanGraphSchema>;

/**
 * Deterministic JSON serialization: recursively sorted object keys, no whitespace. Two
 * semantically equal graphs — regardless of key order or formatting — serialize identically,
 * which is what makes `planContentSha` a CONTENT identity rather than a byte identity.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(',')}}`;
}

/** The approval-binding identity of a plan graph. */
export function planContentSha(graph: PlanGraph): string {
  return sha256(canonicalJson(graph));
}

export interface PlanValidation {
  ok: boolean;
  /** Blocking problems, exact and complete — the model's revision loop depends on precision. */
  errors: string[];
  /** Non-blocking observations (surfaced, never gating). */
  warnings: string[];
  /** The graph with normalized touch prefixes; present only when ok. */
  graph?: PlanGraph;
}

/**
 * Normalize a declared touch prefix: forward slashes, no leading `./`, no trailing `/`.
 * Returns null for prefixes that must be rejected (absolute, drive-letter, or `..`-escaping —
 * these are never disk-probed, mirroring the focus-prefix containment rule).
 */
export function normalizeTouchPrefix(prefix: string): string | null {
  let p = prefix.replace(/\\/g, '/').trim();
  while (p.startsWith('./')) p = p.slice(2);
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '' || p === '.') return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  return p;
}

/** Two prefixes overlap when equal or one path-nests the other (the focus-brief rule). */
export function touchPrefixesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Semantic validation on top of the zod shape: unique ids, resolvable acyclic dependencies,
 * contained touch prefixes, verification criteria where mutation happens, bounded size.
 * Blocking errors are returned verbatim and completely — update_plan feeds them straight back
 * to the model so the revision loop converges on precision, not summaries.
 */
export function validatePlanGraph(input: PlanGraph): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const ids = new Set<string>();
  for (const t of input.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id '${t.id}'`);
    ids.add(t.id);
  }

  for (const t of input.tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) errors.push(`task '${t.id}' depends on itself`);
      else if (!ids.has(dep)) errors.push(`task '${t.id}' depends on unknown task '${dep}'`);
    }
    if (new Set(t.dependsOn).size !== t.dependsOn.length) {
      errors.push(`task '${t.id}' lists a duplicate dependency`);
    }
    if ((t.role === 'executor' || t.role === 'main') && t.verify.trim() === '') {
      errors.push(`task '${t.id}' (role ${t.role}) requires non-empty 'verify' criteria`);
    }
  }

  // Normalize touches; reject escapes.
  const tasks: PlanTask[] = input.tasks.map((t) => {
    const touches: string[] = [];
    for (const raw of t.touches) {
      const norm = normalizeTouchPrefix(raw);
      if (norm === null) {
        errors.push(`task '${t.id}' touch prefix '${raw}' is not a contained workspace-relative prefix`);
      } else if (!touches.includes(norm)) {
        touches.push(norm);
      }
    }
    return { ...t, touches };
  });

  // Cycle detection (Kahn). Report one concrete cycle path so the model can fix it directly.
  const cycle = findCycle(tasks);
  if (cycle !== null) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  // Warnings: overlapping touches between tasks that are not dependency-ordered (they could be
  // scheduled concurrently, where overlap means integration conflicts).
  if (cycle === null && errors.length === 0) {
    const ordered = dependencyClosure(tasks);
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const a = tasks[i]!;
        const b = tasks[j]!;
        if (ordered.get(a.id)?.has(b.id) === true || ordered.get(b.id)?.has(a.id) === true) continue;
        const hits = a.touches.filter((ta) => b.touches.some((tb) => touchPrefixesOverlap(ta, tb)));
        if (hits.length > 0) {
          warnings.push(
            `tasks '${a.id}' and '${b.id}' declare overlapping touches (${hits.join(', ')}) but are not dependency-ordered — they can never run in the same parallel group`,
          );
        }
      }
    }
  }

  const graph: PlanGraph = { ...input, tasks };
  const serialized = canonicalJson(graph);
  if (serialized.length > PLAN_GRAPH_MAX_CHARS) {
    errors.push(`plan graph too large: ${serialized.length} chars canonical (max ${PLAN_GRAPH_MAX_CHARS})`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, errors: [], warnings, graph };
}

/**
 * Topological order of task ids (dependencies first; stable by declaration order among ready
 * tasks). Returns null when the graph has a cycle — validation reports the cycle itself.
 */
export function topoOrder(tasks: readonly PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const indegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (byId.has(dep)) indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
    }
  }
  const order: string[] = [];
  const ready = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const t of tasks) {
      if (!t.dependsOn.includes(id)) continue;
      const left = (indegree.get(t.id) ?? 0) - 1;
      indegree.set(t.id, left);
      if (left === 0) ready.push(t.id);
    }
  }
  return order.length === tasks.length ? order : null;
}

/** One concrete cycle path (`[a, b, a]`), or null when acyclic. DFS with a path stack. */
function findCycle(tasks: readonly PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    const t = byId.get(id);
    if (t !== undefined) {
      for (const dep of t.dependsOn) {
        if (!byId.has(dep)) continue;
        const found = visit(dep);
        if (found !== null) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const t of tasks) {
    const found = visit(t.id);
    if (found !== null) return found;
  }
  return null;
}

/** For each task id, the set of ids it transitively depends on. */
function dependencyClosure(tasks: readonly PlanTask[]): Map<string, Set<string>> {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const closure = new Map<string, Set<string>>();
  const compute = (id: string, seen: Set<string>): Set<string> => {
    const cached = closure.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return new Set(); // cycle — validation reports it separately
    seen.add(id);
    const out = new Set<string>();
    const t = byId.get(id);
    if (t !== undefined) {
      for (const dep of t.dependsOn) {
        if (!byId.has(dep)) continue;
        out.add(dep);
        for (const d of compute(dep, seen)) out.add(d);
      }
    }
    closure.set(id, out);
    return out;
  };
  for (const t of tasks) compute(t.id, new Set());
  return closure;
}
