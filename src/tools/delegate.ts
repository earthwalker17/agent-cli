import { z } from 'zod';
import type { Tool, ToolResult } from '../types.js';
import { runSubagentTask, TASKS_PER_SESSION, type SubagentDeps } from '../runtime/subagent.js';
import { truncateForModel } from '../shared/hash.js';

/**
 * delegate_task — the model-facing surface of the subagent runner. Built PER SESSION at assembly
 * (never a member of the static TOOLS array): parents get an instance, children never do, so
 * recursion is impossible by construction. The budget is harness-fixed — the model chooses what
 * to delegate, never how much authority or budget the child gets. Policy gates the call through
 * the explicit `delegates` branch in decide() (fail closed on any unknown role).
 */

const DelegateInput = z
  .object({
    role: z.literal('explorer').describe('The only available role: a bounded READ-ONLY exploration subagent'),
    task: z
      .string()
      .min(1)
      .max(4000)
      .describe('What to investigate, with the concrete questions the report must answer'),
    expected_output: z.string().max(1000).optional().describe('Optional: the shape of the report you want back'),
  })
  .strict();
type DelegateInputT = z.infer<typeof DelegateInput>;

export function createDelegateTool(deps: SubagentDeps, parentSessionId: string): Tool<DelegateInputT> {
  let tasksStarted = 0;
  return {
    name: 'delegate_task',
    description:
      'Delegate a bounded READ-ONLY exploration task to a subagent with its own isolated context. ' +
      'Use it when a survey/search/analysis would flood this conversation with file contents you ' +
      'will not need verbatim. The subagent cannot write anything; it returns a report. Its report ' +
      'is NARRATION, not verified evidence — verify load-bearing claims before relying on them.',
    schema: DelegateInput,
    // Null = undeclarable side effects; irrelevant to policy here because the `delegates` branch
    // decides FIRST (and a delegates+command combination is denied outright).
    mutates: () => null,
    delegates: (i) => ({ role: i.role }),
    async execute(input, ctx): Promise<ToolResult> {
      if (tasksStarted >= TASKS_PER_SESSION) {
        return {
          ok: false,
          output: '',
          error: `task budget exhausted: this session already delegated ${TASKS_PER_SESSION} tasks; finish the work directly with your own tools`,
          durationMs: 0,
          truncated: false,
        };
      }
      tasksStarted++;

      const spec = {
        role: input.role,
        task: input.task,
        parentSessionId,
        ...(input.expected_output !== undefined ? { expectedOutput: input.expected_output } : {}),
      };
      // The runner reports task.started/task.ended through the runtime-bound channel: started
      // the moment the child exists (a crash mid-task leaves the orphan visible), ended after
      // the child log closes — so the parent order is task.started < task.ended < tool.completed.
      const result = await runSubagentTask(
        { ...deps, ...(ctx.reportTask !== undefined ? { reportTask: ctx.reportTask } : {}) },
        spec,
        ctx.signal,
      );

      const header = [
        `subagent task ${result.status.toUpperCase()} — role ${spec.role} · ${result.steps} step(s) · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`,
        `child session: ${result.childSessionId || '(never started)'}${result.childSessionId !== '' ? ` — evidence: agent report ${result.childSessionId}` : ''}`,
        '--- subagent report begin (narration by the subagent — NOT verified evidence; verify load-bearing claims against the repository) ---',
      ].join('\n');
      const raw = `${header}\n${result.finalText}\n--- subagent report end ---`;
      const t = truncateForModel(raw);
      return {
        ok: result.status === 'completed',
        output: t.text,
        truncated: t.truncated,
        durationMs: result.durationMs,
        ...(t.fullSha256 !== undefined ? { fullOutputSha256: t.fullSha256 } : {}),
        ...(result.status !== 'completed' ? { error: `task ${result.status}` } : {}),
      };
    },
  };
}
