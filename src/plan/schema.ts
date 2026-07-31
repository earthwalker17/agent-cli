import { z } from 'zod';
import { sha256 } from '../shared/hash.js';
import { normalizeRelPrefix, relPrefixesOverlap } from '../shared/pathutil.js';
import type { CheckKind } from '../types.js';

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

/** The wire enum for check kinds; a compile-time guard keeps it equal to the shared vocabulary. */
const CHECK_KIND_VALUES = ['build', 'test', 'test-targeted', 'typecheck', 'lint', 'format', 'static-analysis', 'browser'] as const;
const _checkKindsMatch: readonly CheckKind[] = CHECK_KIND_VALUES;
void _checkKindsMatch;

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
    /**
     * The MACHINE gate (Session 12): typed check kinds that must pass before dependents unblock.
     * Optional with NO default on purpose — `canonicalJson` drops undefined keys, so plans written
     * before this field keep their exact `planContentSha`/`planTaskDefinitionSha` and a resumed
     * approved plan stays approved-and-current. `verify` remains the human criterion beside it.
     */
    checks: z
      .array(z.enum(CHECK_KIND_VALUES))
      .max(4)
      .optional()
      .describe('Typed checks that gate this task: dependents stay blocked until each has passed.'),
    /**
     * Session 16: which detected PROJECT this task's declared checks must pass in. Same
     * sha-neutrality contract as `checks` — optional with NO default, so plans written before
     * this field keep their exact content sha. Absent keeps the pre-Session-16 reading: a pass
     * in ANY project satisfies the gate, which is right for a single-project workspace and is
     * an honestly weaker guarantee everywhere else.
     */
    project: z
      .string()
      .min(1)
      .max(260)
      .optional()
      .describe("Which detected project this task's checks must pass in (e.g. \"api\"). Omit in a single-project workspace."),
    risk: z.enum(['low', 'medium', 'high']).default('low'),
    serial: z.boolean().default(false).describe('Must run alone, never grouped with other tasks.'),
  })
  .strict();

export const PlanGatesSchema = z
  .object({
    integration: z
      .array(z.enum(CHECK_KIND_VALUES))
      .max(4)
      .optional()
      .describe('Checks that must pass after each integration before a new executor wave may start.'),
    completion: z
      .array(z.enum(CHECK_KIND_VALUES))
      .max(4)
      .optional()
      .describe('Checks that must pass after the last change before the session can be accepted as complete.'),
    /**
     * Session 16: the projects these gates must pass in — EACH of them. Without it a
     * `completion: ['test']` gate over a full-stack workspace is satisfied by a green test in
     * whichever project happened to run one, which would let a session be accepted as complete
     * having verified half of itself. Optional with no default; absent = the any-project reading.
     */
    projects: z
      .array(z.string().min(1).max(260))
      .max(12)
      .optional()
      .describe('Projects these gates must each pass in (e.g. ["web","api"]). Omit in a single-project workspace.'),
  })
  .strict();

/**
 * The adversarial-review declaration (Session 14). Optional with NO default — same sha-neutrality
 * contract as `checks`/`gates`: plans written before this field keep their exact content sha.
 * The REQUIREMENT itself is derived, not stored: a plan with ≥1 executor task requires a review
 * round by default; 'waived' opts such a plan out VISIBLY (reason required — it renders in both
 * projections and the user approves it with the plan sha, then it surfaces as an acceptance
 * caveat); 'required' forces the gate for parent-only plans that would otherwise derive none.
 */
export const PlanReviewSchema = z
  .object({
    mode: z.enum(['required', 'waived']),
    reason: z
      .string()
      .max(300)
      .optional()
      .describe('Why the review is waived (required when mode is "waived"; recorded as an acceptance caveat).'),
  })
  .strict();

export const PlanGraphSchema = z
  .object({
    version: z.literal(PLAN_GRAPH_VERSION).default(PLAN_GRAPH_VERSION),
    objective: z.string().min(1).max(2000),
    approach: z.string().max(4000).optional(),
    risks: z.array(z.string().max(300)).max(12).optional(),
    notes: z.string().max(4000).optional(),
    /** Broader gates at the integration and completion boundaries (Session 12; sha-neutral when absent). */
    gates: PlanGatesSchema.optional(),
    /** The adversarial-review declaration (Session 14; sha-neutral when absent — see PlanReviewSchema). */
    review: PlanReviewSchema.optional(),
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

/**
 * The per-task DEFINITION identity (Session 11.5): sha256 of the task's canonical form with
 * dependsOn sorted (reordering one task's dependency list is semantically neutral FOR THAT
 * TASK, unlike the graph-level content sha where order is preserved as written). Recorded on
 * task.started bindings so 'completed' attaches to the definition that actually ran: an
 * amendment that changes a completed task's definition re-opens it, while untouched completed
 * tasks stay completed across amendments.
 */
export function planTaskDefinitionSha(task: PlanTask): string {
  return sha256(canonicalJson({ ...task, dependsOn: [...task.dependsOn].sort() }));
}

export interface PlanValidationOptions {
  /** Check kinds this project can actually run right now (Session 12); enables the gate warning. */
  availableChecks?: readonly CheckKind[];
  /**
   * Project ids detection currently sees (Session 16); enables the unknown-project warning.
   *
   * Load-bearing for the same reason `availableChecks` is: a task scoped to a project that does
   * not exist can NEVER be satisfied and can never be waived either, because the only way to
   * record an `unsupported` for a project is to name it, and naming an unknown project refuses
   * without recording. Its dependents stay blocked and `/accept` stays unfinished with no
   * command that clears it. Caught here it is a warning in the revision loop instead.
   */
  knownProjects?: readonly string[];
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
 * Touch-prefix normalization/overlap live in `shared/pathutil` (Session 12): typed-check scopes
 * need the identical containment rule, and one implementation is the only way both stay identical.
 * Re-exported under the original names so every existing caller and pin is untouched.
 */
export { normalizeRelPrefix as normalizeTouchPrefix, relPrefixesOverlap as touchPrefixesOverlap };

/**
 * Semantic validation on top of the zod shape: unique ids, resolvable acyclic dependencies,
 * contained touch prefixes, verification criteria where mutation happens, bounded size.
 * Blocking errors are returned verbatim and completely — update_plan feeds them straight back
 * to the model so the revision loop converges on precision, not summaries.
 */
export function validatePlanGraph(input: PlanGraph, opts: PlanValidationOptions = {}): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // A gate this project cannot run would strand the plan mid-execution. Catch it at the CONSENT
  // boundary instead: a warning here reaches the model through update_plan's revision loop, long
  // before the user approves a graph whose gates are unsatisfiable. Deliberately non-blocking —
  // detection is a heuristic, and a check may become runnable later (an install, a new config).
  const known = opts.knownProjects;
  if (known !== undefined && known.length > 0) {
    const named = new Set<string>();
    for (const t of input.tasks) if (t.project !== undefined && (t.checks?.length ?? 0) > 0) named.add(t.project);
    for (const p of input.gates?.projects ?? []) named.add(p);
    for (const p of named) {
      if (!known.includes(p)) {
        warnings.push(
          `plan scopes a gate to project '${p}', which detection does not currently see (detected: ${known.join(', ')}) — ` +
            'a gate scoped to a project that does not exist can never pass AND can never be waived, so its dependents would stay blocked with no exit',
        );
      }
    }
  }

  const available = opts.availableChecks;
  if (available !== undefined) {
    const declared = new Set<CheckKind>();
    for (const t of input.tasks) for (const k of t.checks ?? []) declared.add(k);
    for (const k of input.gates?.integration ?? []) declared.add(k);
    for (const k of input.gates?.completion ?? []) declared.add(k);
    const missing = [...declared].filter((k) => !available.includes(k));
    if (missing.length > 0) {
      warnings.push(
        `declared check kind(s) ${missing.join(', ')} cannot run in this project right now (runnable: ${available.length > 0 ? available.join(', ') : 'none'}) — they will record as UNSUPPORTED and be waived with a caveat rather than proving anything`,
      );
    }
  }

  // Review declaration rules (Session 14). A waiver without a reason is invisible consent —
  // the reason is what the user actually approves and what the acceptance caveat later shows.
  const hasExecutorTask = input.tasks.some((t) => t.role === 'executor');
  if (input.review?.mode === 'waived') {
    if ((input.review.reason ?? '').trim().length < 10) {
      errors.push(
        `review.mode 'waived' requires a substantive 'reason' (≥10 chars): the waiver is part of what the user approves, and it becomes an acceptance caveat`,
      );
    }
    if (!hasExecutorTask) {
      warnings.push(
        `review.mode 'waived' on a plan with no executor tasks waives nothing — the review requirement only derives for executor plans`,
      );
    }
  }
  if (input.review?.mode === 'required' && input.review.reason === undefined && hasExecutorTask) {
    warnings.push(
      `review.mode 'required' is already the derived default for a plan with executor tasks — declaring it is harmless but redundant`,
    );
  }

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
    // A per-task gate is anchored on that task's own integration evidence, which a parent-owned
    // (role 'main') task never produces — the fold resolves it to 'parent-owned' before any
    // verification logic runs. Silently ignoring a declared gate would be the dishonest option.
    if (t.role === 'main' && t.checks !== undefined && t.checks.length > 0) {
      errors.push(
        `task '${t.id}' (role main) cannot declare 'checks': the harness gates a task on ITS OWN integration evidence, which parent-owned work does not produce — use the graph-level gates.completion instead, or make it an executor task`,
      );
    }
    if (t.checks !== undefined && new Set(t.checks).size !== t.checks.length) {
      errors.push(`task '${t.id}' lists a duplicate check kind`);
    }
    if (t.checks?.includes('test-targeted') === true && t.touches.length === 0) {
      warnings.push(
        `task '${t.id}' gates on 'test-targeted' but declares no touches — a targeted run needs scope_paths, so name what it owns`,
      );
    }
  }

  // Normalize touches; reject escapes.
  const tasks: PlanTask[] = input.tasks.map((t) => {
    const touches: string[] = [];
    for (const raw of t.touches) {
      const norm = normalizeRelPrefix(raw);
      if (norm === null) {
        errors.push(`task '${t.id}' touch prefix '${raw}' is not a contained workspace-relative prefix`);
      } else if (!touches.includes(norm)) {
        touches.push(norm);
      }
    }
    // Drop an EMPTY checks array rather than storing it: `[]` and absent are semantically the
    // same gate (none), but canonicalJson would hash them differently — and the content sha is
    // the approval binding. Normalizing here keeps "no gate" one canonical form.
    const { checks: rawChecks, project: rawProject, ...rest } = t;
    // Same rule for `project` (Session 16): a blank string and an absent field are the same
    // "no project scoping", and canonicalJson would hash them differently.
    const project = rawProject !== undefined ? normalizeRelPrefix(rawProject) ?? (rawProject.trim() === '.' ? '.' : null) : null;
    if (rawProject !== undefined && project === null) {
      errors.push(`task '${t.id}' project '${rawProject}' is not a contained workspace-relative directory`);
    }
    return {
      ...rest,
      touches,
      ...(rawChecks !== undefined && rawChecks.length > 0 ? { checks: rawChecks } : {}),
      ...(project !== null ? { project } : {}),
    };
  });

  // Gate project scoping (Session 16): normalized, deduped and SORTED, so the same declaration
  // always yields the same content sha regardless of how the model happened to order it.
  const gateProjects: string[] = [];
  for (const raw of input.gates?.projects ?? []) {
    const norm = raw.trim() === '.' ? '.' : normalizeRelPrefix(raw);
    if (norm === null) errors.push(`gates.projects entry '${raw}' is not a contained workspace-relative directory`);
    else if (!gateProjects.includes(norm)) gateProjects.push(norm);
  }
  gateProjects.sort();

  // Same normalization for the graph-level gates: empty lists are absent lists.
  const gates =
    input.gates === undefined
      ? undefined
      : {
          ...((input.gates.integration?.length ?? 0) > 0 ? { integration: input.gates.integration } : {}),
          ...((input.gates.completion?.length ?? 0) > 0 ? { completion: input.gates.completion } : {}),
          // `projects` normalizes the same way (Session 16), and is dropped when there is no gate
          // for it to scope — a projects list beside no kinds scopes nothing and would only
          // perturb the content sha.
          ...(gateProjects.length > 0 && ((input.gates.integration?.length ?? 0) > 0 || (input.gates.completion?.length ?? 0) > 0)
            ? { projects: gateProjects }
            : {}),
        };
  const normalizedGates = gates !== undefined && Object.keys(gates).length > 0 ? gates : undefined;

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
        const hits = a.touches.filter((ta) => b.touches.some((tb) => relPrefixesOverlap(ta, tb)));
        if (hits.length > 0) {
          warnings.push(
            `tasks '${a.id}' and '${b.id}' declare overlapping touches (${hits.join(', ')}) but are not dependency-ordered — they can never run in the same parallel group`,
          );
        }
      }
    }
  }

  const { gates: _dropped, ...withoutGates } = input;
  const graph: PlanGraph = { ...withoutGates, tasks, ...(normalizedGates !== undefined ? { gates: normalizedGates } : {}) };
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
