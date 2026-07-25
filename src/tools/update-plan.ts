import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { PlanGraphSchema, validatePlanGraph } from '../plan/schema.js';
import { readCanonicalPlan, writeCanonicalPlan } from '../plan/canonical.js';
import { graphSummary, writeUserView } from '../plan/views.js';
import type { SnapshotStore } from '../store/snapshots.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Clock } from '../shared/clock.js';
import type { CheckKind } from '../types.js';

/**
 * update_plan — the model's ONLY write path to the plan document. Built PER SESSION at assembly
 * (parents only; no role registry contains it); gated by the explicit `planDoc` policy branch.
 *
 * Session 11: the input is the STRUCTURED plan graph (schema-validated task DAG), written to the
 * canonical `<planId>.plan.json`; the user-facing markdown view is regenerated beside it.
 * Semantic validation failures (cycles, unknown deps, missing verify, …) return the exact error
 * list with NOTHING written — the model revises and retries; that loop is the design.
 * The harness owns `status`: a model write can never approve, and any semantic change to an
 * approved plan flips it back to draft (approval is bound to the content sha, so amendment
 * structurally invalidates it and the user must /plan approve again).
 */

const UpdatePlanInput = z
  .object({
    plan: PlanGraphSchema.describe(
      'The COMPLETE plan graph (replaces the previous plan). objective/approach/risks are prose; tasks form a ' +
        'dependency DAG. Each task: id (short slug, stable across revisions), title, intent (what+why — seeds the ' +
        'child brief), role (executor = delegated mutating work in an isolated worktree; explorer/reviewer = ' +
        'delegated read-only work; main = work YOU will do directly). PREFER executor tasks for independent ' +
        'file-mutating work — disjoint executor tasks run as parallel isolated worktrees with captured, reviewable ' +
        'diffs, and the harness verifies their completion; reserve main for integration, verification, and work ' +
        'that genuinely needs your own context (main tasks are asserted done, never harness-verified). dependsOn (task ids that must be completed ' +
        'AND integrated first), touches (workspace-relative path prefixes the task owns — the scheduler refuses ' +
        'overlapping tasks in one parallel group), verify (how completion will be checked — required for ' +
        'executor/main), checks (TYPED check kinds that GATE this task: dependents stay blocked and the session ' +
        'cannot be accepted until each has passed after this task is integrated — build|test|test-targeted|' +
        'typecheck|lint|format|static-analysis; declare them on mutating tasks, never on role main), risk, ' +
        'serial (must run alone). Optional graph-level gates: {integration: [...]} must pass after each apply ' +
        'before the next executor wave, {completion: [...]} must pass after the last change before /accept. ' +
        'Do NOT encode execution status anywhere — the harness ' +
        'derives live task states from evidence. Task ids are stable across amendments; completed state belongs ' +
        'to the task DEFINITION that ran: changing a completed task (title/intent/role/touches/verify/…) re-opens ' +
        'it for execution, while untouched completed tasks stay completed across amendments.',
    ),
    reason: z.string().max(200).optional().describe('One line: why the plan changed (shown in evidence)'),
  })
  .strict();
type UpdatePlanInputT = z.infer<typeof UpdatePlanInput>;

export interface UpdatePlanDeps {
  layout: ProjectLayout;
  snapshots: SnapshotStore;
  /** The plan id = the owning (parent) session id. */
  planId: string;
  clock?: Clock;
  /**
   * Check kinds this project can run right now (Session 12). Read fresh per call so a plan that
   * gates on something unrunnable is warned about in the REVISION LOOP, before the user approves
   * a graph whose gates cannot be satisfied. Absent ⇒ the warning is simply not produced.
   */
  availableChecks?: () => readonly CheckKind[];
}

export function createUpdatePlanTool(deps: UpdatePlanDeps): Tool<UpdatePlanInputT> {
  return {
    name: 'update_plan',
    description:
      'Create or replace the structured plan for this session (a task DAG the user reviews and approves with ' +
      '/plan approve). Use it BEFORE implementation of multi-step, cross-cutting, or high-risk work: executor ' +
      'delegation is blocked until the CURRENT plan content is approved. Amending the plan (any semantic change) ' +
      'resets approval — present the revision and wait for re-approval. Validation errors (dependency cycles, ' +
      'unknown ids, missing verification) are returned in full with nothing written; fix and resubmit. The plan ' +
      "is context, not authority: the user's current request always outranks it.",
    schema: UpdatePlanInput,
    // Null mutation plan + the planDoc fact: policy routes this through the explicit plan.update
    // branch (pinned by tests) — it must never fall through to observe or reach declared-mutation
    // validation (the state-dir path would be denied as protected).
    mutates: () => null,
    planDoc: () => ({ action: 'update' }),
    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      const fail = (error: string): ToolResult => ({
        ok: false,
        output: '',
        error,
        durationMs: Math.max(0, Date.now() - startedAt),
        truncated: false,
      });
      try {
        let availableChecks: readonly CheckKind[] | undefined;
        try {
          availableChecks = deps.availableChecks?.();
        } catch {
          availableChecks = undefined; // a detection failure must never block writing a plan
        }
        const v = validatePlanGraph(input.plan, availableChecks !== undefined ? { availableChecks } : {});
        if (!v.ok || v.graph === undefined) {
          // The revision loop: every error, verbatim and complete — nothing was written. The
          // detail rides in `output` so the persisted outputPreview keeps it as evidence too.
          return {
            ok: false,
            output: [...v.errors.map((e) => `- ${e}`), 'Fix the plan graph and call update_plan again.'].join('\n'),
            error: `plan NOT written — ${v.errors.length} validation error(s)`,
            durationMs: Math.max(0, Date.now() - startedAt),
            truncated: false,
          };
        }
        const prior = readCanonicalPlan(deps.layout, deps.planId);
        const w = await writeCanonicalPlan(deps.layout, deps.planId, v.graph, deps.snapshots, deps.clock);
        if ('error' in w) return fail(`plan write failed: ${w.error}`);
        // Regenerate the user-facing view beside the canonical file (failure is noted, never fatal).
        const viewR = await writeUserView(deps.layout, deps.planId, readCanonicalPlan(deps.layout, deps.planId), deps.snapshots);
        ctx.reportPlan?.({
          planId: deps.planId,
          sha256: w.contentSha,
          bytes: w.bytes,
          prevSha256: w.prevSha256,
          status: w.status,
          graph: graphSummary(v.graph),
        });
        const statusLine =
          w.status === 'approved'
            ? 'status: approved (semantic no-op — the content sha is unchanged, the approval stands)'
            : prior.exists && prior.status === 'approved'
              ? 'status: draft — this AMENDMENT INVALIDATED the prior approval; present the revision and wait for /plan approve'
              : 'status: draft — present the plan and wait for /plan approve before executor delegation';
        return {
          ok: true,
          output: [
            `plan ${deps.planId} written: ${v.graph.tasks.length} task(s), content sha ${w.contentSha.slice(0, 12)}…`,
            statusLine,
            ...v.warnings.map((warn) => `warning: ${warn}`),
            `canonical (user-editable JSON): ${deps.layout.canonicalPlanFile(deps.planId)}`,
            'error' in viewR
              ? `note: the generated user view could not be written (${viewR.error})`
              : `user view (generated): ${deps.layout.planFile(deps.planId)}`,
          ].join('\n'),
          durationMs: Math.max(0, Date.now() - startedAt),
          truncated: false,
        };
      } catch (err) {
        return fail(`plan write failed: ${(err as Error).message}`);
      }
    },
  };
}
