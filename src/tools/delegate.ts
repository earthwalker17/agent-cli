import path from 'node:path';
import { z } from 'zod';
import type { SessionEvent, SubagentRoleName, TaskChangeFile, Tool, ToolContext, ToolResult } from '../types.js';
import type { PlanState } from '../plan/canonical.js';
import type { GraphState } from '../plan/graph-state.js';
import type { CheckKind } from '../types.js';
import { proveWith, renderRecoveryGuidance } from '../recovery/catalogue.js';
import type { RepairVerdict } from '../recovery/policy.js';
import { planTaskDefinitionSha, type PlanGraph, type PlanTask } from '../plan/schema.js';
import {
  neutralizeHarnessDelimiters,
  runSubagentTask,
  SESSION_CHILD_OUTPUT_TOKEN_CAP,
  TASKS_PER_SESSION,
  type SubagentDeps,
  type SubagentResult,
  type SubagentSpec,
} from '../runtime/subagent.js';
import fs from 'node:fs';
import { isInside } from '../shared/pathutil.js';
import { captureTaskChanges, type CaptureResult } from '../runtime/task-changes.js';
import { newWorktreeDir, registerWorktree, unregisterWorktree } from '../runtime/worktrees.js';
import { addWorktree, removeWorktree, worktreeSupport } from '../git/worktree.js';
import { createCheckpoint } from '../git/checkpoint.js';
import { detectGitFacts } from '../git/facts.js';
import { buildWorkspaceMapAuto } from '../workspace/map.js';
import { truncateForModel } from '../shared/hash.js';
import type { SnapshotStore } from '../store/snapshots.js';

/**
 * delegate_task — the model-facing surface of the subagent runner. Built PER SESSION at assembly
 * (never a member of the static TOOLS array): parents get an instance, children never do, so
 * recursion is impossible by construction. V0.7: one call takes 1–3 tasks that run as a PARALLEL
 * GROUP — one call = one attributable evidence unit, and for a group containing the mutating
 * executor role, ONE human approval (policy: ask, every time). Budgets and caps are
 * harness-fixed — the model chooses what to delegate, never how much authority or budget a
 * child gets.
 *
 * Executor orchestration lives HERE (the runner stays role-agnostic): one base checkpoint per
 * group (captures the parent's CURRENT working tree, dirty state included) → a detached git
 * worktree per executor task at a policy-safe temp home → the child runs scoped to the worktree
 * → changes are captured as content-addressed blobs + a task.changes event → the worktree is
 * ALWAYS removed (the diff outlives it; removal failure is honest evidence for the sweep).
 */

const TaskSpec = z
  .object({
    role: z
      .enum(['explorer', 'planner', 'reviewer', 'executor'])
      .describe('explorer: read-only survey/search. planner: read-only plan drafting. reviewer: read-only adversarial diff review. executor: implements changes in an ISOLATED git worktree (requires your approval to spawn; its approvals forward to the user).'),
    task: z.string().min(1).max(4000).describe('What to do, with the concrete questions the report must answer'),
    context: z
      .string()
      .max(20000)
      .optional()
      .describe('Verbatim supporting material for the child (findings, a scoped diff, the relevant plan tasks). It has its OWN context window — include what it needs, nothing more.'),
    expected_output: z.string().max(1000).optional().describe('Optional: the shape of the report you want back'),
    focus: z
      .array(z.string().min(1).max(260))
      .max(16)
      .optional()
      .describe('Workspace-relative path prefixes this task OWNS (e.g. ["src/runtime"]). Parallel tasks should have non-overlapping focus sets; each task sees its siblings\' focus as territory to avoid.'),
    avoid: z
      .array(z.string().min(1).max(260))
      .max(16)
      .optional()
      .describe('Workspace-relative path prefixes this task must NOT spend budget on (covered elsewhere or out of scope).'),
    plan_task: z
      .string()
      .max(41)
      .optional()
      .describe(
        'The approved-plan task id this child executes (Session 11). REQUIRED for executor tasks while an approved ' +
          'plan is active — the scheduler gates dependencies, conflicts, and re-runs by this binding; unknown ids, ' +
          'role mismatches, unmet dependencies, and completed re-runs are refused.',
      ),
  })
  .strict();

const DelegateInput = z
  .object({
    tasks: z
      .array(TaskSpec)
      .min(1)
      .max(3)
      .describe('1–3 tasks. Tasks in ONE call run IN PARALLEL — batch only independent work (for executors: disjoint file ownership); sequence dependent work across separate calls.'),
  })
  .strict();
type DelegateInputT = z.infer<typeof DelegateInput>;

/**
 * Plan gate + consent-display state (Session 11), read FRESH from the file and events per use
 * (bytes are truth): the unified PlanState plus — for a valid canonical graph — the execution
 * fold. Lives on its own options seam (not ExecutorDeps): DAG bindings gate read-only tasks
 * too, and a non-repo session with a canonical plan must still enforce them.
 */
export interface PlanGateInfo {
  state: PlanState;
  /** The execution fold of the canonical graph; null when no valid canonical graph exists. */
  graphState: GraphState | null;
  /**
   * The plan's integration-boundary check gate (Session 12), computed where the events are.
   * Optional so every existing caller and pin stays valid; absent ⇒ the rule does not fire.
   */
  integrationGate?: { required: CheckKind[]; pending: CheckKind[]; waived: CheckKind[] } | null;
  /**
   * Per-plan-task bounded-repair verdicts (Session 12), computed where the events are. Optional
   * so every existing caller and pin stays valid; absent ⇒ R11 does not fire and the retry path
   * behaves exactly as it did in Session 11.5.
   */
  repairVerdicts?: ReadonlyMap<string, RepairVerdict> | null;
}

/**
 * Cumulative per-session delegation caps (Session 11): REBUILT FROM EVENTS at assembly (the
 * changes-registry pattern), so a resumed session keeps counting where it left off instead of
 * silently resetting its budgets.
 */
export interface DelegateCaps {
  tasksStarted: number;
  childOutputTokens: number;
}

/**
 * R10 (Session 11.5): the per-task retry ceiling — genuine failure outcomes (error, timeout,
 * budget exhaustion, stalled) under the current task definition before the gate refuses
 * identical retries. Crash-interrupted and user-terminated (cancelled/user-stopped/aborted)
 * attempts never count — the ceiling guards MODEL retry loops, not user intervention; a
 * definition change resets the count.
 */
export const MAX_TASK_ATTEMPTS = 3;

export function delegateCapsFromEvents(events: readonly SessionEvent[]): DelegateCaps {
  const caps: DelegateCaps = { tasksStarted: 0, childOutputTokens: 0 };
  for (const e of events) {
    if (e.type === 'task.started') caps.tasksStarted++;
    else if (e.type === 'task.ended') caps.childOutputTokens += e.usage.outputTokens;
  }
  return caps;
}

/** Per-session wiring for the plan gate and caps (Session 11). */
export interface DelegateOptions {
  /** Fresh plan gate state per use (gate at execute; display at the ask). Absent ⇒ gate off. */
  planContext?: () => PlanGateInfo;
  /** Session-cumulative counters; assembly passes the events-rebuilt object. */
  caps?: DelegateCaps;
}

/** Everything executor orchestration needs from assembly; absent ⇒ executors honestly unavailable. */
export interface ExecutorDeps {
  gitPath: string;
  gitVersion: string | null;
  repoRoot: string;
  /** Harness scratch (the project state dir): checkpoint temp index + capture staging. */
  stateDir: string;
  worktreesRoot: string;
  registryFile: string;
  snapshots: SnapshotStore;
  /**
   * Called with each group's base-checkpoint ref so assembly can prune them at session end
   * (V0.7.1): the ref is a live recovery point only while the session runs — the captured
   * blobs + task.changes events are the durable record, and silently accumulating one hidden
   * ref per executor group pollutes the user's repo.
   */
  noteBaseRef: (ref: string) => void;
  /** Feed the in-session apply registry the moment changes are captured. */
  registerChanges: (childSessionId: string, baseOid: string, files: TaskChangeFile[], omittedCount?: number) => void;
  clockIso: () => string;
}

interface TaskOutcome {
  result: SubagentResult;
  /** Extra harness lines for this task's report section (capture summary, worktree warnings). */
  notes: string[];
  capturedPaths: string[];
}

/**
 * Session 10: the required section headers of a completed explorer report. Prompt-enforced;
 * the harness CHECK below is informational only (a budget-cut report is legitimately partial —
 * flagging it must inform the parent, never manufacture failure).
 */
export const EXPLORER_REPORT_SECTIONS = [
  '## Scope inspected',
  '## Scope skipped',
  '## Findings',
  '## Change sites and risks',
  '## Tests',
  '## Open questions',
] as const;

/** Explorer-only: which required report sections a report lacks. */
export function missingExplorerSections(finalText: string): string[] {
  return EXPLORER_REPORT_SECTIONS.filter((s) => !finalText.includes(s));
}

function normalizePrefix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function prefixesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * Session 10: per-task brief lines (focus/avoid + sibling coverage) and group-level overlap
 * warnings, composed deterministically from the structured fields. Guidance and measurement,
 * deliberately NOT enforcement: read-only exploration crossing a path boundary is a cost
 * problem, not a safety problem, and pretending otherwise would be enforcement theater.
 */
export function composeBriefs(
  tasks: ReadonlyArray<{ role: string; focus?: string[] | undefined; avoid?: string[] | undefined }>,
  workspaceRoot: string,
): { briefs: string[][]; groupNotes: string[] } {
  const focusSets = tasks.map((t) => (t.focus ?? []).map(normalizePrefix).filter((p) => p.length > 0));
  const briefs = tasks.map((t, i) => {
    const lines: string[] = [];
    const focus = focusSets[i]!;
    if (focus.length > 0) {
      lines.push(`- Focus — paths this task owns: ${focus.join(', ')}`);
      const missing = focus.filter((p) => {
        try {
          const abs = path.resolve(workspaceRoot, p);
          // Never probe outside the workspace: a `..`-escaping focus prefix must not become
          // an existence oracle that bypasses the out-of-workspace read approval.
          if (!isInside(workspaceRoot, abs)) return true;
          return !fs.existsSync(abs);
        } catch {
          return true;
        }
      });
      if (missing.length > 0) {
        lines.push(`- note: focus path(s) not found in the workspace right now: ${missing.join(', ')} — treat as a hint, not truth`);
      }
    }
    const avoid = (t.avoid ?? []).map(normalizePrefix).filter((p) => p.length > 0);
    if (avoid.length > 0) lines.push(`- Avoid — out of this task's scope: ${avoid.join(', ')}`);
    for (let j = 0; j < tasks.length; j++) {
      if (j === i || focusSets[j]!.length === 0) continue;
      lines.push(`- Sibling task ${j + 1} (${tasks[j]!.role}) owns: ${focusSets[j]!.join(', ')} — do not spend budget there.`);
    }
    return lines;
  });
  const groupNotes: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const shared = focusSets[i]!.filter((a) => focusSets[j]!.some((b) => prefixesOverlap(a, b)));
      if (shared.length > 0) {
        groupNotes.push(
          `WARNING — overlapping focus between task ${i + 1} and task ${j + 1} (${shared.join(', ')}): expect duplicated exploration; prefer disjoint focus sets.`,
        );
      }
    }
  }
  return { briefs, groupNotes };
}

/**
 * The DAG gate (Session 11): rules R1–R9 from the approved plan graph, evaluated BEFORE the base
 * checkpoint so a refusal spawns nothing. Bindings are enforced against the approved-and-current
 * canonical plan only — binding a draft/diverged/legacy plan is refused honestly rather than
 * silently recorded against content the user never consented to. Returns the refusal, or null.
 */
export function checkDagRules(
  tasks: readonly { role: string; plan_task?: string | undefined }[],
  gate: PlanGateInfo,
): string | null {
  const st = gate.state;
  // Review F3 (Session 11): an approval event with NO plan document means an approved plan
  // VANISHED (hand-deleted, crash). Waving executors through as "no plan" would silently drop
  // the DAG's protections for content the user consented to — refuse until a plan exists again.
  if (st.kind === 'none' && st.approvedSha !== null && tasks.some((t) => t.role === 'executor')) {
    return 'a plan was approved this session but its document is now missing — write a new plan with update_plan and get it approved (or proceed without executor delegation)';
  }
  const activeGraph: PlanGraph | null = st.approvedAndCurrent ? (st.canonical?.graph ?? null) : null;
  const gs = gate.graphState;
  if (activeGraph === null || gs === null) {
    const bound = tasks.findIndex((t) => t.plan_task !== undefined);
    if (bound !== -1) {
      return st.kind === 'none'
        ? `task ${bound + 1} names plan task '${tasks[bound]!.plan_task}' but no plan document exists for this session — drop the binding or write a plan with update_plan`
        : `task ${bound + 1} names plan task '${tasks[bound]!.plan_task}' but the current plan content is not approved — plan bindings are enforced only against the user-approved plan (/plan approve first)`;
    }
    return null;
  }
  const byId = new Map(activeGraph.tasks.map((t) => [t.id, t] as const));

  // Pass 1 — binding shape: every binding must name a real plan task with the matching role.
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    if (t.plan_task === undefined) {
      // R1: while the approved DAG is active, an unbound EXECUTOR would escape re-spawn
      // refusal, /tasks placement, and traceability — refuse with the honest escape hatches.
      if (t.role === 'executor') {
        const readyExec = gs.ready.filter((id) => byId.get(id)?.role === 'executor');
        return (
          `an approved plan is active: executor task ${i + 1} must name its plan task via "plan_task"` +
          (readyExec.length > 0 ? ` (ready executor tasks: ${readyExec.join(', ')})` : ' (no executor tasks are ready)') +
          ' — or amend the plan with update_plan (this resets approval and requires re-approval), or make the change directly with your own tools'
        );
      }
      continue; // read-only tasks never need a binding
    }
    const pt = byId.get(t.plan_task);
    if (pt === undefined) {
      // R2
      return `task ${i + 1} names unknown plan task '${t.plan_task}' — the approved plan defines: ${activeGraph.tasks.map((x) => x.id).join(', ')}`;
    }
    if (pt.role !== t.role) {
      // R3
      return `task ${i + 1} binds plan task '${t.plan_task}' (plan role: ${pt.role}) but was requested as ${t.role} — roles must match the approved plan`;
    }
  }

  // R12 (Session 12) — the INTEGRATION boundary. When the plan declares gates.integration, the
  // combined state after the last apply must be verified before another mutating wave starts.
  // Group-level and pre-checkpoint like every other rule here, so a refusal spawns nothing.
  // Read-only groups are unaffected: exploring while a gate is red costs nothing and risks nothing.
  if (gate.integrationGate !== undefined && gate.integrationGate !== null && gate.integrationGate.pending.length > 0) {
    if (tasks.some((t) => t.role === 'executor')) {
      return (
        `the plan's integration gate has not passed since the last apply: ${gate.integrationGate.pending.join(', ')} — ` +
        `prove with ${proveWith(gate.integrationGate.pending)} before starting another executor wave (broader verification at the integration boundary is what the gate is for), ` +
        `or amend the plan's gates with update_plan (this resets approval)`
      );
    }
  }

  // Pass 2 — group composition, BEFORE per-task state: grouping a dependent with its dependency
  // gets the actionable "sequence them across calls" message rather than R4's "blocked" (which
  // would otherwise always shadow it — the dep can never be completed while spawning alongside).
  const bound = tasks.map((t) => t.plan_task).filter((p): p is string => p !== undefined);
  const dup = bound.find((p, i) => bound.indexOf(p) !== i);
  // R6: duplicate binding inside one group (sequential calls make a live double-spawn otherwise
  // impossible — the parent awaits each group before the next call).
  if (dup !== undefined) return `plan task '${dup}' is bound by more than one task in this group — one live execution per plan task`;
  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i]!.plan_task;
    if (a === undefined) continue;
    const pa = byId.get(a)!;
    if (tasks.length > 1 && (pa.serial || pa.risk === 'high')) {
      // R8
      return `plan task '${a}' is marked ${pa.serial ? 'serial' : 'high risk'} and must run alone — spawn it as a single-task group`;
    }
    for (let j = 0; j < tasks.length; j++) {
      if (i === j) continue;
      const b = tasks[j]!.plan_task;
      if (b === undefined) continue;
      if (pa.dependsOn.includes(b)) {
        // R9
        return `task ${i + 1} (plan task '${a}') depends on task ${j + 1} (plan task '${b}') in the same group — dependent tasks cannot run in parallel; sequence them across calls`;
      }
      if (j > i && tasks[i]!.role === 'executor' && tasks[j]!.role === 'executor') {
        const pb = byId.get(b)!;
        const hits = pa.touches.filter((ta) => pb.touches.some((tb) => prefixesOverlap(normalizePrefix(ta), normalizePrefix(tb))));
        if (hits.length > 0) {
          // R7 (the capture-time write-set warning stays the declared-vs-actual backstop)
          return `plan tasks '${a}' and '${b}' declare overlapping touch prefixes (${hits.join(', ')}) — parallel executors must own disjoint paths; run them in separate calls`;
        }
      }
    }
  }

  // Pass 3 — per-task execution state from the fold.
  for (const t of tasks) {
    if (t.plan_task === undefined) continue;
    const ts = gs.byId.get(t.plan_task);
    if (ts === undefined) continue;
    if (ts.state === 'completed') {
      // R5 (failed/cancelled/interrupted stay re-spawnable — the bounded retry path)
      return `plan task '${t.plan_task}' is already completed and integrated — re-running it risks duplicated mutations; amend the plan if more work is needed`;
    }
    if (ts.state === 'integrating') {
      return `plan task '${t.plan_task}' has captured changes not yet fully applied — integrate them with apply_task_changes (or resolve the refusals) before re-running it`;
    }
    // R10 (Session 11.5) — the bounded-retry ceiling: genuine FAILURE outcomes under the
    // CURRENT definition. The ceiling guards model-driven retry loops, so only the model's
    // own terminal failures count: 'interrupted' (crash), 'cancelled'/'user-stopped' (the
    // user intervened), and 'aborted' (the user aborted the turn) never do — none of those
    // is the model retrying (review F3: counting user cancellations mislabeled them as
    // "failed attempts" and could lock a task the user merely paused). Legacy sha-less
    // bindings count conservatively; a definition change resets the ceiling (the attempts
    // belong to the old sha).
    const NON_FAILURE = new Set(['completed', 'interrupted', 'running', 'awaiting-approval', 'cancelled', 'user-stopped', 'aborted']);
    const spent = ts.attemptHistory.filter(
      (a) => !NON_FAILURE.has(a.outcome) && (a.planTaskSha === undefined || a.planTaskSha === ts.definitionSha),
    );
    const verdict = gate.repairVerdicts?.get(t.plan_task);
    if (spent.length >= MAX_TASK_ATTEMPTS) {
      // Session 12: the ceiling now says WHAT failed, not just how often — the catalogue's
      // required evidence and diagnostics are the actionable part of a refusal.
      const classBit =
        verdict !== undefined
          ? `\nclassified: ${verdict.failureClass} — ${verdict.guidance.label}. Required evidence: ${verdict.guidance.requiredEvidence.join('; ')}. Diagnose first: ${verdict.guidance.diagnostics.join('; ')}.`
          : '';
      return (
        `plan task '${t.plan_task}' has already failed ${spent.length} attempt(s) under its current definition ` +
        `(${spent.map((a) => a.outcome).join(', ')}) — do not retry identically: revise the task with update_plan `
        + `(a materially different definition resets the ceiling; approval will be required again), do the work ` +
        `directly as the parent, record an honest stop with recover(action="escalate"), or ask the user how to proceed` +
        classBit
      );
    }
    // R11 (Session 12) — CLASSIFICATION BEFORE REPAIR PLANNING. Once a mutating task has failed
    // under its current definition, re-spawning it is a repair, and a repair needs a plan: the
    // failure must classify, the class must be automatically repairable, the budgets must hold,
    // and a hypothesis for THIS failure must be on the record (newer than the failure itself, so
    // every new failure demands a fresh one). Otherwise the gate refuses and names the hatches.
    //
    // Scoped to executors on purpose: re-running a read-only explorer costs a budget and changes
    // nothing, so requiring a repair ledger entry there would be ceremony. Mutating retries are
    // where a blind "try again" actually costs something.
    if (t.role === 'executor' && spent.length >= 1 && verdict !== undefined) {
      // One free re-spawn when the verdict STOPS for a reason that no amount of model effort can
      // clear: a task-sourced 'error' classifies as `unknown` and a 'timeout' as
      // `timeout-resource` (neither auto-eligible), so refusing at the first failure would have
      // made a transient provider error cost a full plan amendment and a human re-approval —
      // strictly worse than Session 11.5, and for a failure that is often not a loop at all.
      // R10's ceiling still bounds it; from the SECOND failure the stop is real.
      const stopIsUnclearable = verdict.stop?.reason === 'unknown-classification' || verdict.stop?.reason === 'requires-user-decision';
      if (verdict.stop !== undefined && !(spent.length === 1 && stopIsUnclearable)) {
        return (
          `plan task '${t.plan_task}' failed again (${verdict.failureClass}) and automatic repair is REFUSED ` +
          `(${verdict.stop.reason}): ${verdict.stop.detail}\n` +
          `${renderRecoveryGuidance(verdict.failureClass, { includeStops: true })}\n` +
          `Record the honest stop with recover(action="escalate", target="${t.plan_task}", reason=…), revise the task with ` +
          `update_plan (re-approval required), do it directly as the parent, or ask the user.`
        );
      }
      if (verdict.needsNewPlan && verdict.stop === undefined) {
        return (
          `plan task '${t.plan_task}' failed again and has no repair plan for THIS failure — classification comes before repair. ` +
          `Call recover(action="attempt", target="${t.plan_task}", hypothesis=…, scope_paths=…, regression_checks=…) first; ` +
          `it is ${verdict.failureClass} (attempt ${verdict.attemptsUsed + 1} of ${MAX_TASK_ATTEMPTS} for this failure).\n` +
          renderRecoveryGuidance(verdict.failureClass)
        );
      }
    }
    if (ts.state === 'blocked') {
      // R4 (parent-owned deps auto-satisfy in the fold and surface as a warning, never here).
      // Session 12: a dependency can also be blocking because its own check gate is still
      // pending — name the missing kinds, or the message points at nothing actionable.
      const depsLine = ts.blockedOn
        .map((d) => {
          const dep = gs.byId.get(d);
          const gateBit =
            dep?.state === 'completed' && dep.verification.status === 'pending'
              ? ` (integrated, but its required check(s) have not passed: ${dep.verification.missing.join(', ')})`
              : '';
          return `'${d}' is ${dep?.state ?? 'unknown'}${gateBit}`;
        })
        .join('; ');
      return `plan task '${t.plan_task}' is blocked: dependency ${depsLine} — dependencies must be completed, integrated (apply_task_changes with no refusals), and past their declared check gate before dependents run`;
    }
  }
  return null;
}

/** Group-note warnings for bound tasks whose dependencies are parent-owned (asserted, unverifiable). */
function parentOwnedDepWarnings(
  tasks: readonly { plan_task?: string | undefined }[],
  planTaskById: ReadonlyMap<string, PlanTask>,
  gs: GraphState,
): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    if (t.plan_task === undefined) continue;
    const pt = planTaskById.get(t.plan_task);
    if (pt === undefined) continue;
    for (const dep of pt.dependsOn) {
      if (gs.byId.get(dep)?.state === 'parent-owned') {
        out.push(
          `NOTE — plan task '${t.plan_task}' depends on parent-owned task '${dep}': the harness cannot verify parent work; spawning '${t.plan_task}' asserts '${dep}' is done.`,
        );
      }
    }
  }
  return out;
}

export function createDelegateTool(
  deps: SubagentDeps,
  parentSessionId: string,
  executor?: ExecutorDeps,
  opts?: DelegateOptions,
): Tool<DelegateInputT> {
  const caps: DelegateCaps = opts?.caps ?? { tasksStarted: 0, childOutputTokens: 0 };
  return {
    name: 'delegate_task',
    description:
      'Delegate 1–3 bounded subagent tasks, each with its own isolated context; tasks in one call run IN PARALLEL. ' +
      'Read-only roles: explorer (survey/search/analysis that would flood this conversation), planner (draft a plan ' +
      'document from findings), reviewer (adversarial review of a diff, findings classified by severity). Mutating ' +
      'role: executor — implements a task inside an ISOLATED git worktree (never the real workspace); spawning asks ' +
      'the user every time, the executor\'s own risky calls forward to the user, and its changes only reach the ' +
      'workspace via apply_task_changes after your review. Reports are NARRATION, not verified evidence — verify ' +
      'load-bearing claims before relying on them.',
    schema: DelegateInput,
    // Null = undeclarable side effects; irrelevant to policy here because the `delegates` branch
    // decides FIRST (and a delegates+command combination is denied outright).
    mutates: () => null,
    delegates: (i) => ({ roles: i.tasks.map((t) => t.role) }),
    // Display-only plan state for the executor-spawn ask (V0.7.1): the human approving a spawn
    // must SEE whether the plan they approved is still the plan on disk. Read fresh at ask time;
    // the gate below re-reads at execute time (fresher — the safe direction). Never policy.
    approvalContext: (i) => {
      if (!i.tasks.some((t) => t.role === 'executor') || opts?.planContext === undefined) return [];
      const p = opts.planContext().state;
      const short = (sha: string | null): string => (sha !== null ? sha.slice(0, 12) : '(unknown)');
      const bindings = i.tasks
        .filter((t) => t.plan_task !== undefined)
        .map((t) => `task ${i.tasks.indexOf(t) + 1} → plan task '${t.plan_task}'`);
      const bindingLines = bindings.length > 0 ? [`plan bindings: ${bindings.join(', ')}`] : [];
      if (p.status === 'none') return ['plan: none — no plan document exists for this session'];
      if (p.status === 'approved') {
        if (p.approvedSha === null) {
          return ['plan: file says APPROVED but no /plan approve is recorded this session (status possibly hand-edited) — executor tasks will refuse until /plan approve'];
        }
        return p.diverged
          ? [`plan: APPROVED but DIVERGED after approval (approved ${short(p.approvedSha)}, current ${short(p.currentSha)}) — executor tasks will refuse until re-approval`]
          : [`plan: APPROVED (sha ${short(p.currentSha)}, matches the user-approved content)`, ...bindingLines];
      }
      if (p.status === 'superseded') return ['plan: SUPERSEDED (discarded) — executor tasks will refuse until a new plan is approved'];
      return [`plan: ${String(p.status).toUpperCase()} — executor tasks will refuse until /plan approve`];
    },
    async execute(input, ctx): Promise<ToolResult> {
      const refuse = (error: string): ToolResult => ({ ok: false, output: '', error, durationMs: 0, truncated: false });
      // Group-atomic caps: a group either fully fits the remaining budget or is refused whole —
      // silently starting a partial group would misreport what the model asked for.
      if (caps.tasksStarted + input.tasks.length > TASKS_PER_SESSION) {
        return refuse(
          `task budget exhausted: this session already delegated ${caps.tasksStarted} of ${TASKS_PER_SESSION} tasks and the group of ${input.tasks.length} does not fit; finish the work directly with your own tools`,
        );
      }
      if (caps.childOutputTokens >= SESSION_CHILD_OUTPUT_TOKEN_CAP) {
        return refuse(
          `delegation output-token budget exhausted (${caps.childOutputTokens} of ${SESSION_CHILD_OUTPUT_TOKEN_CAP} output tokens across child tasks); finish the work directly with your own tools`,
        );
      }

      // Executor preconditions — all checked BEFORE anything spawns, so a refusal spawns nothing.
      const executorCount = input.tasks.filter((t) => t.role === 'executor').length;
      let gate: PlanGateInfo | null = null;
      try {
        gate = opts?.planContext?.() ?? null;
      } catch (err) {
        // Fail closed where the gate matters: an unreadable plan state must not wave executors
        // or bindings through; unbound read-only groups are unaffected (nothing to gate).
        if (executorCount > 0 || input.tasks.some((t) => t.plan_task !== undefined)) {
          return refuse(`plan state unavailable (${(err as Error).message}) — executor tasks and plan bindings are blocked until it can be read`);
        }
      }
      if (executorCount > 0) {
        if (executor === undefined) {
          return refuse('executor tasks need a git repository with a probed git binary; none is available in this session');
        }
        const support = worktreeSupport(executor.gitVersion);
        if (!support.ok) return refuse(`executor tasks unavailable: ${support.reason}`);
        // The plan STATUS gate (Session 11 — strict): while any plan document exists, executor
        // groups run only against the approved CURRENT content. Draft/unknown keep the V0.7
        // wording; superseded, diverged, and approved-without-recorded-consent now BLOCK
        // (previously display-only). No plan at all does not block — the per-spawn human ask
        // remains the consent floor for unplanned executor work.
        if (gate !== null && gate.state.kind !== 'none') {
          const st = gate.state;
          if (st.status === 'draft' || st.status === 'unknown') {
            return refuse(
              `a plan document exists but is not approved (status: ${st.status}) — executor tasks are blocked until the user runs /plan approve (or /plan discard)`,
            );
          }
          if (st.status === 'superseded') {
            return refuse(
              'the plan was discarded (status: superseded) — write a new plan with update_plan and get it approved before executor delegation',
            );
          }
          if (st.status === 'approved' && !st.approvedAndCurrent) {
            return refuse(
              st.approvedSha === null
                ? 'the plan file says APPROVED but no /plan approve is recorded this session — executor tasks are blocked until the user runs /plan approve'
                : `the plan on disk has DIVERGED from the approved plan (approved ${st.approvedSha.slice(0, 12)}, current ${st.currentSha?.slice(0, 12) ?? 'unreadable'}) — executor tasks are blocked until the user re-approves (/plan approve) or discards (/plan discard)`,
            );
          }
        }
      }

      // The DAG gate (Session 11): while an approved-and-current canonical plan is active, plan
      // bindings are enforced for EVERY role — dependencies, conflicts, duplicate and completed
      // re-runs are refused before anything spawns (group-atomic, like every refusal above).
      const dagRefusal = gate !== null ? checkDagRules(input.tasks, gate) : null;
      if (dagRefusal !== null) return refuse(dagRefusal);

      let baseOid: string | null = null;
      if (executorCount > 0) {
        // ONE base checkpoint per group, created sequentially before any fan-out: every member
        // starts from the same attributable oid, dirty parent state included.
        const base = await createCheckpoint(
          { gitPath: executor!.gitPath, repoRoot: executor!.repoRoot, workspaceRoot: deps.workspaceRoot, stateDir: executor!.stateDir },
          parentSessionId,
          {
            label: 'task base',
            // Creation evidence (Session 11.5): lets a RESUMED session rebuild the prune list.
            // Appended BEFORE update-ref (Session 14, onRefReady): a crash between the append
            // and the ref write leaves an owed ref that does not exist — the prune counts a
            // missing ref as deleted, so the old creation-instant leak is structurally closed.
            onRefReady: (ref, oid) => {
              executor!.noteBaseRef(ref);
              ctx.reportTask?.({ kind: 'base-checkpoint', ref, oid });
            },
          },
        );
        if (!base.ok || base.oid === undefined) {
          return refuse(`cannot capture the task-base checkpoint: ${base.error ?? 'unknown error'}`);
        }
        baseOid = base.oid;
      }
      caps.tasksStarted += input.tasks.length;

      // Plan-informed effective tasks: a bound task with no explicit focus inherits its plan
      // task's declared touches as the focus brief (sibling coverage then sees it too).
      const activeGraph = gate !== null && gate.state.approvedAndCurrent ? (gate.state.canonical?.graph ?? null) : null;
      const planTaskById = new Map((activeGraph?.tasks ?? []).map((t) => [t.id, t] as const));
      const effectiveTasks = input.tasks.map((t) => {
        const pt = t.plan_task !== undefined ? planTaskById.get(t.plan_task) : undefined;
        return pt !== undefined && t.focus === undefined && pt.touches.length > 0 ? { ...t, focus: [...pt.touches] } : t;
      });

      // Brief composition (Session 10): focus/avoid + sibling coverage per task, overlap
      // warnings for the group — deterministic, before any child exists. Session 11 adds the
      // plan-task identity + verification criteria to each bound task's brief.
      const composed = composeBriefs(effectiveTasks, deps.workspaceRoot);
      for (let i = 0; i < input.tasks.length; i++) {
        const pid = input.tasks[i]!.plan_task;
        const pt = pid !== undefined ? planTaskById.get(pid) : undefined;
        if (pt !== undefined) {
          composed.briefs[i]!.unshift(
            `- Plan task: ${pt.id} — ${pt.title}`,
            ...(pt.verify.trim() !== '' ? [`- Verification criteria (the parent will check): ${pt.verify}`] : []),
          );
        }
      }
      if (gate?.graphState !== null && gate?.graphState !== undefined && activeGraph !== null) {
        composed.groupNotes.push(`plan execution state: ${gate.graphState.summary}`);
        for (const note of parentOwnedDepWarnings(input.tasks, planTaskById, gate.graphState)) {
          composed.groupNotes.push(note);
        }
      }

      // Fan out. Group size is schema-capped at 3, so Promise.all IS the concurrency limit.
      // Each child gets its own session/log; evidence events interleave at event granularity
      // through the shared callId-bound reportTask channel (join key: childSessionId).
      const outcomes: TaskOutcome[] = await Promise.all(
        input.tasks.map(async (t, index): Promise<TaskOutcome> => {
          const spec = {
            role: t.role as SubagentRoleName,
            task: t.task,
            parentSessionId,
            ...(t.context !== undefined ? { context: t.context } : {}),
            ...(t.expected_output !== undefined ? { expectedOutput: t.expected_output } : {}),
            ...(composed.briefs[index]!.length > 0 ? { briefLines: composed.briefs[index]! } : {}),
            ...(t.plan_task !== undefined ? { planTaskId: t.plan_task } : {}),
            // Definition identity at spawn (Session 11.5): completed-state binds to WHAT ran.
            ...(t.plan_task !== undefined && planTaskById.has(t.plan_task)
              ? { planTaskSha: planTaskDefinitionSha(planTaskById.get(t.plan_task)!) }
              : {}),
          };
          const provider = deps.providerForTask?.(index, spec.role) ?? deps.provider;
          const taskDeps: SubagentDeps = {
            ...deps,
            provider,
            ...(ctx.reportTask !== undefined ? { reportTask: ctx.reportTask } : {}),
          };
          if (spec.role !== 'executor') {
            return { result: await runSubagentTask(taskDeps, spec, ctx.signal), notes: [], capturedPaths: [] };
          }
          return runExecutorTask(taskDeps, spec, executor!, baseOid!, ctx);
        }),
      );
      for (const o of outcomes) caps.childOutputTokens += o.result.usage.outputTokens;

      // Overlap detection across the group's captured write-sets (apply order defines the
      // winner; the warning makes the collision visible BEFORE anything integrates).
      const groupNotes: string[] = [...composed.groupNotes];
      if (executorCount > 1) {
        const seen = new Map<string, number>();
        for (const o of outcomes) for (const p of o.capturedPaths) seen.set(p, (seen.get(p) ?? 0) + 1);
        const overlap = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
        if (overlap.length > 0) {
          groupNotes.push(
            `WARNING — overlapping edits between executor tasks (apply order decides, per-file drift rules refuse the loser): ${overlap.join(', ')}`,
          );
        }
      }

      const results = outcomes.map((o) => o.result);
      const allCompleted = results.every((r) => r.status === 'completed');

      // Group digest (Session 11) — at the HEAD of the result, so head-biased truncation can
      // never hide a failed status or a supervision intervention behind a long child report.
      const digest: string[] = [
        'group digest: ' +
          outcomes
            .map((o, i) => {
              const t = input.tasks[i]!;
              const r = o.result;
              const id4 = r.childSessionId === '' ? '----' : r.childSessionId.slice(-4);
              const cap = o.capturedPaths.length > 0 ? `, ${o.capturedPaths.length} file(s) captured` : '';
              const sup = r.supervision.length > 0 ? ` [supervision: ${r.supervision.map((s) => s.what).join(', ')}]` : '';
              return `task ${i + 1}${t.plan_task !== undefined ? ` (${t.plan_task})` : ''} ${t.role}·${id4} ${r.status.toUpperCase()} — ${r.steps} step(s), ${r.usage.outputTokens} out tok${cap}${sup}`;
            })
            .join(' · '),
        ...outcomes.flatMap((o, i) =>
          o.result.supervision.map((s) => `supervision task ${i + 1}: ${s.what}${s.detail !== undefined ? ` — ${s.detail}` : ''}`),
        ),
        // Declared-vs-actual honesty: an executor that wrote outside its plan-declared touches.
        ...outcomes.flatMap((o, i) => {
          const pid = input.tasks[i]!.plan_task;
          const declared = pid !== undefined ? (planTaskById.get(pid)?.touches ?? []) : [];
          if (declared.length === 0 || o.capturedPaths.length === 0) return [];
          const outside = o.capturedPaths.filter((p) => !declared.some((d) => p === d || p.startsWith(`${d}/`)));
          return outside.length > 0
            ? [`NOTE — plan task '${pid}' wrote outside its declared touches: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` (+${outside.length - 5})` : ''}`]
            : [];
        }),
        '',
      ];
      const groupHeader =
        results.length === 1
          ? [...groupNotes, ...(groupNotes.length > 0 ? [''] : [])]
          : [
              `subagent group: ${results.length} tasks ran in parallel — ${results.map((r, i) => `task ${i + 1} ${r.status.toUpperCase()}`).join(' · ')}`,
              ...groupNotes,
              '',
            ];
      const sections = outcomes.map((o, i) => {
        const t = input.tasks[i]!;
        const r = o.result;
        // Explorer report contract (Session 10): informational section check — a missing
        // section marks coverage incomplete for the parent; it never converts to failure.
        const sectionNote =
          t.role === 'explorer' && r.status === 'completed'
            ? ((): string[] => {
                const missing = missingExplorerSections(r.finalText);
                return missing.length > 0
                  ? [`[harness] explorer report missing section(s): ${missing.join(', ')} — treat those areas as UNEXAMINED`]
                  : [];
              })()
            : [];
        return [
          `${results.length > 1 ? `=== task ${i + 1} — ` : ''}subagent ${r.status.toUpperCase()} — role ${t.role} · ${r.steps} step(s) · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens`,
          `child session: ${r.childSessionId || '(never started)'}${r.childSessionId !== '' ? ` — evidence: agent report ${r.childSessionId}` : ''}`,
          ...o.notes,
          ...sectionNote,
          '--- subagent report begin (narration by the subagent — NOT verified evidence; verify load-bearing claims against the repository) ---',
          neutralizeHarnessDelimiters(r.finalText),
          '--- subagent report end ---',
        ].join('\n');
      });
      const raw = [...digest, ...groupHeader, ...sections].join('\n');
      const tr = truncateForModel(raw);
      const failed = results.filter((r) => r.status !== 'completed');
      return {
        ok: allCompleted,
        output: tr.text,
        truncated: tr.truncated,
        // Group wall time = slowest member (children ran concurrently; deterministic under the injected clock).
        durationMs: Math.max(0, ...results.map((r) => r.durationMs)),
        ...(tr.fullSha256 !== undefined ? { fullOutputSha256: tr.fullSha256 } : {}),
        // Spill seam (Session 11.5): a long group result loses child-report bytes to the 70/30
        // truncation; the runtime preserves the full text as a blob so audits and resumed
        // sessions can still read what the children actually reported.
        ...(tr.fullSha256 !== undefined ? { fullOutput: raw } : {}),
        ...(allCompleted ? {} : { error: `task(s) not completed: ${failed.map((r) => r.status).join(', ')}` }),
      };
    },
  };
}

/**
 * One executor task: worktree add (registered FIRST — a crash right after must be sweepable) →
 * child session scoped to the worktree with fresh git facts + map → capture → removal, always.
 */
async function runExecutorTask(
  taskDeps: SubagentDeps,
  spec: SubagentSpec,
  ex: ExecutorDeps,
  baseOid: string,
  ctx: ToolContext,
): Promise<TaskOutcome> {
  const failResult = (detail: string): TaskOutcome => ({
    result: {
      status: 'error',
      finalText: detail,
      steps: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      childSessionId: '',
      childLogPath: '',
      durationMs: 0,
      budget: { maxSteps: 0, timeoutMs: 0, maxOutputTokens: 0 },
      supervision: [],
    },
    notes: [],
    capturedPaths: [],
  });

  const dir = newWorktreeDir(ex.worktreesRoot, spec.parentSessionId);
  try {
    // Owner-stamped (V0.7.1): the sweep skips entries whose pid is alive, so a concurrent
    // session's startup can never remove this worktree while we are using it.
    await registerWorktree(ex.registryFile, {
      dir,
      repoRoot: ex.repoRoot,
      childSessionId: '',
      createdAt: ex.clockIso(),
      ownerSessionId: spec.parentSessionId,
      pid: process.pid,
    });
  } catch (err) {
    return failResult(`executor setup failed: cannot record the worktree registry entry (${(err as Error).message})`);
  }
  const add = await addWorktree(ex.gitPath, ex.repoRoot, dir, baseOid);
  if (!add.ok) {
    try {
      await unregisterWorktree(ex.registryFile, dir);
    } catch {
      /* registry cleanup is best-effort; the sweep is path-guarded anyway */
    }
    return failResult(`executor setup failed: git worktree add: ${add.error ?? 'unknown error'}`);
  }
  // childSessionId is '' here by necessity: the worktree exists BEFORE its child session; the
  // shared callId joins this event to the task.started that follows.
  ctx.reportTask?.({ kind: 'worktree-created', childSessionId: '', path: dir, baseOid });

  const notes: string[] = [];
  let capturedPaths: string[] = [];
  let result: SubagentResult = failResult('executor task did not run').result;
  try {
    // Subdir workspaces: the checkpoint tree spans the whole repo; the child must live at the
    // same relative subtree inside the worktree, and capture filters to it.
    const wsRelOs = path.relative(ex.repoRoot, taskDeps.workspaceRoot);
    const wsRel = wsRelOs.split(path.sep).join('/');
    const childWs = wsRelOs.length > 0 ? path.join(dir, wsRelOs) : dir;
    try {
      const childGitFacts = await detectGitFacts(childWs);
      const childMap = await buildWorkspaceMapAuto(childWs, {}, childGitFacts);
      result = await runSubagentTask(
        { ...taskDeps, workspaceRoot: childWs, gitFacts: childGitFacts, map: childMap },
        spec,
        ctx.signal,
      );
    } catch (err) {
      // runSubagentTask never throws; a probe/map throw must still flow into honest capture +
      // guaranteed removal rather than escaping past the finally with half a task recorded.
      result = failResult(`executor task failed before the child ran: ${(err as Error).message}`).result;
    }

    // Capture even for aborted/timeout/user-stopped children: partial work is still evidence;
    // whether it integrates stays a decision for the main agent and the user.
    const cap: CaptureResult = await captureTaskChanges({
      gitPath: ex.gitPath,
      worktreeDir: dir,
      wsRel,
      baseOid,
      snapshots: ex.snapshots,
      scratchDir: ex.stateDir,
    });
    if (cap.error !== undefined) {
      notes.push(`[harness] change capture FAILED: ${cap.error} — nothing from this task can be integrated`);
    } else {
      ctx.reportTask?.({
        kind: 'changes',
        childSessionId: result.childSessionId,
        baseOid,
        files: cap.files,
        ...(cap.omittedCount > 0 ? { omittedCount: cap.omittedCount } : {}),
      });
      ex.registerChanges(result.childSessionId, baseOid, cap.files, cap.omittedCount);
      capturedPaths = cap.files.map((f) => f.relPath);
      const oversize = cap.files.filter((f) => f.oversize === true).length;
      notes.push(
        `[harness] captured ${cap.files.length} changed file(s)${cap.omittedCount > 0 ? ` (+${cap.omittedCount} omitted over the cap)` : ''}${oversize > 0 ? `, ${oversize} oversize (recorded, not integrable)` : ''} vs base ${baseOid.slice(0, 12)} — review, then integrate with apply_task_changes {"child_session_id": "${result.childSessionId}"}`,
      );
    }
  } finally {
    const rem = await removeWorktree(ex.gitPath, ex.repoRoot, dir);
    if (rem.ok) {
      try {
        await unregisterWorktree(ex.registryFile, dir);
      } catch {
        /* stale entry is harmless: the sweep skips missing dirs */
      }
    } else {
      notes.push(`[harness] worktree removal FAILED (${rem.detail ?? 'unknown'}); it stays registered for the startup sweep`);
    }
    ctx.reportTask?.({
      kind: 'worktree-removed',
      childSessionId: result.childSessionId,
      ok: rem.ok,
      ...(rem.detail !== undefined ? { detail: rem.detail } : {}),
    });
  }
  return { result, notes, capturedPaths };
}
