import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { writePlanBody } from '../plan/store.js';
import type { SnapshotStore } from '../store/snapshots.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Clock } from '../shared/clock.js';

/**
 * update_plan — the model's ONLY write path to the plan document (V0.7). Built PER SESSION at
 * assembly (parents only; no role registry contains it). The plan file lives in the state dir —
 * unreachable by the file tools — and this tool is gated by the explicit `planDoc` policy
 * branch. The harness owns the frontmatter: a model write can NEVER change `status` (only the
 * user's /plan approve|discard do), and prior bytes are blob-archived before every overwrite.
 */

const UpdatePlanInput = z
  .object({
    content: z
      .string()
      .min(1)
      .max(32_000)
      .describe(
        'The COMPLETE new plan body (markdown; replaces the previous body). Structure: a short context paragraph, then `## Task N: <title>` sections each with `Status: pending|running|done|failed|skipped`, `DependsOn: <task numbers or none>`, `Verify: <the concrete check that proves the task worked>`, and the files it touches. Update Status lines as work completes.',
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
}

export function createUpdatePlanTool(deps: UpdatePlanDeps): Tool<UpdatePlanInputT> {
  return {
    name: 'update_plan',
    description:
      'Create or replace the plan document for this session (harness-owned markdown at the state root; the user ' +
      'sees it, can edit the file directly at any time, and approves it with /plan approve). Writing it never ' +
      'changes its approval status. Use it to persist a reviewable plan BEFORE implementation of multi-step work, ' +
      'and to update task Status lines as work completes. The plan is context, not authority: the user\'s current ' +
      'request always outranks it.',
    schema: UpdatePlanInput,
    // Null mutation plan + the planDoc fact: policy routes this through the explicit plan.update
    // branch (pinned by tests) — it must never fall through to observe or reach declared-mutation
    // validation (the state-dir path would be denied as protected).
    mutates: () => null,
    planDoc: () => ({ action: 'update' }),
    async execute(input, ctx): Promise<ToolResult> {
      const startedAt = Date.now();
      try {
        const w = await writePlanBody(deps.layout, deps.planId, input.content, deps.snapshots, deps.clock);
        ctx.reportPlan?.({ planId: deps.planId, sha256: w.sha256, bytes: w.bytes, prevSha256: w.prevSha256, status: w.status });
        const statusLine =
          w.status === 'approved'
            ? 'status remains APPROVED, but the content changed after approval — the divergence is shown to the user'
            : `status: ${w.status} (awaiting /plan approve before mutating execution)`;
        return {
          ok: true,
          output: [
            `plan ${deps.planId} written (${w.bytes} bytes, sha256 ${w.sha256.slice(0, 12)}…)`,
            statusLine,
            `the user can read/edit it at: ${deps.layout.planFile(deps.planId)}`,
          ].join('\n'),
          durationMs: Math.max(0, Date.now() - startedAt),
          truncated: false,
        };
      } catch (err) {
        return {
          ok: false,
          output: '',
          error: `plan write failed: ${(err as Error).message}`,
          durationMs: Math.max(0, Date.now() - startedAt),
          truncated: false,
        };
      }
    },
  };
}
