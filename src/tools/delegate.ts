import { z } from 'zod';
import type { SubagentRoleName, Tool, ToolResult } from '../types.js';
import {
  runSubagentTask,
  SESSION_CHILD_OUTPUT_TOKEN_CAP,
  TASKS_PER_SESSION,
  type SubagentDeps,
  type SubagentResult,
} from '../runtime/subagent.js';
import { truncateForModel } from '../shared/hash.js';

/**
 * delegate_task — the model-facing surface of the subagent runner. Built PER SESSION at assembly
 * (never a member of the static TOOLS array): parents get an instance, children never do, so
 * recursion is impossible by construction. V0.7: one call takes 1–3 tasks that run as a PARALLEL
 * GROUP — one call = one attributable evidence unit, and (for mutating roles) one approval for
 * the whole group. Budgets and caps are harness-fixed — the model chooses what to delegate,
 * never how much authority or budget a child gets. Policy gates every call through the explicit
 * `delegates` branch in decide() (the strictest role in the group governs; unknown roles deny).
 */

const TaskSpec = z
  .object({
    role: z
      .enum(['explorer', 'planner', 'reviewer', 'executor'])
      .describe('explorer: read-only survey/search. planner: read-only plan drafting. reviewer: read-only adversarial diff review. executor: not yet available.'),
    task: z.string().min(1).max(4000).describe('What to do, with the concrete questions the report must answer'),
    context: z
      .string()
      .max(20000)
      .optional()
      .describe('Verbatim supporting material for the child (findings, a scoped diff). It has its OWN context window — include what it needs, nothing more.'),
    expected_output: z.string().max(1000).optional().describe('Optional: the shape of the report you want back'),
  })
  .strict();

const DelegateInput = z
  .object({
    tasks: z
      .array(TaskSpec)
      .min(1)
      .max(3)
      .describe('1–3 tasks. Tasks in ONE call run IN PARALLEL — batch only independent work; sequence dependent work across separate calls.'),
  })
  .strict();
type DelegateInputT = z.infer<typeof DelegateInput>;

export function createDelegateTool(deps: SubagentDeps, parentSessionId: string): Tool<DelegateInputT> {
  let tasksStarted = 0;
  let childOutputTokens = 0;
  return {
    name: 'delegate_task',
    description:
      'Delegate 1–3 bounded subagent tasks, each with its own isolated context; tasks in one call run IN PARALLEL. ' +
      'Read-only roles: explorer (survey/search/analysis that would flood this conversation), planner (draft a plan ' +
      'document from findings), reviewer (adversarial review of a diff, findings classified by severity). Subagents ' +
      'cannot write anything; each returns a report. Reports are NARRATION, not verified evidence — verify ' +
      'load-bearing claims before relying on them.',
    schema: DelegateInput,
    // Null = undeclarable side effects; irrelevant to policy here because the `delegates` branch
    // decides FIRST (and a delegates+command combination is denied outright).
    mutates: () => null,
    delegates: (i) => ({ roles: i.tasks.map((t) => t.role) }),
    async execute(input, ctx): Promise<ToolResult> {
      const refuse = (error: string): ToolResult => ({ ok: false, output: '', error, durationMs: 0, truncated: false });
      // Group-atomic caps: a group either fully fits the remaining budget or is refused whole —
      // silently starting a partial group would misreport what the model asked for.
      if (tasksStarted + input.tasks.length > TASKS_PER_SESSION) {
        return refuse(
          `task budget exhausted: this session already delegated ${tasksStarted} of ${TASKS_PER_SESSION} tasks and the group of ${input.tasks.length} does not fit; finish the work directly with your own tools`,
        );
      }
      if (childOutputTokens >= SESSION_CHILD_OUTPUT_TOKEN_CAP) {
        return refuse(
          `delegation output-token budget exhausted (${childOutputTokens} of ${SESSION_CHILD_OUTPUT_TOKEN_CAP} output tokens across child tasks); finish the work directly with your own tools`,
        );
      }
      tasksStarted += input.tasks.length;

      // Fan out. Group size is schema-capped at 3, so Promise.all IS the concurrency limit.
      // Each child gets its own session/log; evidence events interleave at event granularity
      // through the shared callId-bound reportTask channel (join key: childSessionId).
      const results: SubagentResult[] = await Promise.all(
        input.tasks.map((t, index) => {
          const spec = {
            role: t.role as SubagentRoleName,
            task: t.task,
            parentSessionId,
            ...(t.context !== undefined ? { context: t.context } : {}),
            ...(t.expected_output !== undefined ? { expectedOutput: t.expected_output } : {}),
          };
          const provider = deps.providerForTask?.(index, spec.role) ?? deps.provider;
          return runSubagentTask(
            { ...deps, provider, ...(ctx.reportTask !== undefined ? { reportTask: ctx.reportTask } : {}) },
            spec,
            ctx.signal,
          );
        }),
      );
      for (const r of results) childOutputTokens += r.usage.outputTokens;

      const allCompleted = results.every((r) => r.status === 'completed');
      const groupHeader =
        results.length === 1
          ? []
          : [
              `subagent group: ${results.length} tasks ran in parallel — ${results.map((r, i) => `task ${i + 1} ${r.status.toUpperCase()}`).join(' · ')}`,
              '',
            ];
      const sections = results.map((r, i) => {
        const t = input.tasks[i]!;
        return [
          `${results.length > 1 ? `=== task ${i + 1} — ` : ''}subagent ${r.status.toUpperCase()} — role ${t.role} · ${r.steps} step(s) · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens`,
          `child session: ${r.childSessionId || '(never started)'}${r.childSessionId !== '' ? ` — evidence: agent report ${r.childSessionId}` : ''}`,
          '--- subagent report begin (narration by the subagent — NOT verified evidence; verify load-bearing claims against the repository) ---',
          r.finalText,
          '--- subagent report end ---',
        ].join('\n');
      });
      const raw = [...groupHeader, ...sections].join('\n');
      const tr = truncateForModel(raw);
      const failed = results.filter((r) => r.status !== 'completed');
      return {
        ok: allCompleted,
        output: tr.text,
        truncated: tr.truncated,
        // Group wall time = slowest member (children ran concurrently; deterministic under the injected clock).
        durationMs: Math.max(0, ...results.map((r) => r.durationMs)),
        ...(tr.fullSha256 !== undefined ? { fullOutputSha256: tr.fullSha256 } : {}),
        ...(allCompleted ? {} : { error: `task(s) not completed: ${failed.map((r) => r.status).join(', ')}` }),
      };
    },
  };
}
