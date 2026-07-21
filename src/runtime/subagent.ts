import { autoDenyApprover } from './approvals.js';
import { startSession, runTurn, endSession, recordSandboxStatus, recordGitContext, recordWorkspaceMap, type Session } from './session.js';
import type { ElisionOptions } from './elision.js';
import { TOOLS } from '../tools/index.js';
import { buildExplorerSystemPrompt } from '../workspace/system-prompt.js';
import type { WorkspaceMap } from '../workspace/map.js';
import type { ProjectLayout } from '../store/layout.js';
import type { SandboxBackend, EnforcementFacts } from '../sandbox/index.js';
import type { GitFacts } from '../git/types.js';
import { randomSaltHex, sha256 } from '../shared/hash.js';
import { systemClock, type Clock } from '../shared/clock.js';
import type { IdGen } from '../shared/ids.js';
import type { PolicyRules, Provider, TaskBudget, TaskEvidence, TaskStatus, Usage } from '../types.js';

/**
 * The subagent task runner: ONE bounded child session driving the SAME runTurn the main agent
 * uses (no second execution loop). A delegated task is exactly one turn — multi-step inside, but
 * with no user to converse with — so turn-level cancellation IS session-level cancellation.
 *
 * Authority is inherited-or-narrower by construction: a read-only tool registry (no write tools,
 * no delegate tool ⇒ depth 1), autoDenyApprover (asks fail closed — only provably-safe commands
 * inside the parent's PROBED sandbox instance can auto-run), the parent's narrowing rules, and a
 * fixed harness budget the model never controls. The child gets its own event log (fresh session
 * id ⇒ own lock), so its evidence is attributable and its work independently inspectable.
 */

export const TASK_MAX_STEPS = 15;
export const TASK_TIMEOUT_MS = 300_000;
export const TASK_MAX_OUTPUT_TOKENS = 30_000;
export const TASKS_PER_SESSION = 8;

const CHILD_TOOL_NAMES = new Set(['read_file', 'list_files', 'search', 'run_command']);

export interface SubagentDeps {
  layout: ProjectLayout;
  workspaceRoot: string;
  model: string;
  maxTokens: number;
  /** The child's provider (production: the parent's instance; tests: a separately scripted mock). */
  provider: Provider;
  rules?: PolicyRules;
  /** The parent's PROBED backend + facts — shared, never re-probed. */
  sandbox?: SandboxBackend;
  sandboxFacts?: EnforcementFacts;
  gitFacts?: GitFacts;
  map: WorkspaceMap;
  /** The user constitution, injected into the child prompt too (user rules bind subagents). */
  agentMd?: { text: string; truncated: boolean };
  contextBudget?: ElisionOptions;
  clock?: Clock;
  idGen?: IdGen;
  /** Render-only progress lines (chrome). Never evidence; consumers sanitize. */
  onProgress?: (line: string) => void;
  /**
   * The parent call's runtime-bound evidence channel. The runner reports task.started the moment
   * the child exists (a parent crash mid-task must leave an orphaned task.started) and task.ended
   * after the child log closes.
   */
  reportTask?: (e: TaskEvidence) => void;
  /** Harness-internal budget narrowing (tests). NEVER derived from model input. */
  budget?: Partial<TaskBudget>;
}

export interface SubagentSpec {
  role: 'explorer';
  task: string;
  expectedOutput?: string;
  parentSessionId: string;
}

export interface SubagentResult {
  status: TaskStatus;
  /** The child's final report text (untruncated; the delegate tool truncates for the model). */
  finalText: string;
  steps: number;
  usage: Usage;
  childSessionId: string;
  childLogPath: string;
  durationMs: number;
  budget: TaskBudget;
}

/** Never throws. Exactly one child runTurn; the child log/lock is always released. */
export async function runSubagentTask(deps: SubagentDeps, spec: SubagentSpec, parentSignal?: AbortSignal): Promise<SubagentResult> {
  const budget: TaskBudget = {
    maxSteps: deps.budget?.maxSteps ?? TASK_MAX_STEPS,
    timeoutMs: deps.budget?.timeoutMs ?? TASK_TIMEOUT_MS,
    maxOutputTokens: deps.budget?.maxOutputTokens ?? TASK_MAX_OUTPUT_TOKENS,
  };
  const clock = deps.clock ?? systemClock;
  const startedAt = clock.now();
  const fail = (detail: string): SubagentResult => ({
    status: 'error',
    finalText: detail,
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    childSessionId: '',
    childLogPath: '',
    durationMs: Math.max(0, clock.now() - startedAt),
    budget,
  });

  let child: Session;
  try {
    child = startSession({
      workspaceRoot: deps.workspaceRoot,
      layout: deps.layout,
      model: deps.model,
      mode: 'non-interactive',
      provider: deps.provider,
      approver: autoDenyApprover,
      system: buildExplorerSystemPrompt(deps.workspaceRoot, deps.map, deps.sandboxFacts, deps.gitFacts, deps.agentMd),
      maxSteps: budget.maxSteps,
      maxTokens: deps.maxTokens,
      tools: TOOLS.filter((t) => CHILD_TOOL_NAMES.has(t.name)),
      saltHex: randomSaltHex(),
      lineage: { parentSessionId: spec.parentSessionId, role: spec.role },
      ...(deps.rules !== undefined ? { rules: deps.rules } : {}),
      ...(deps.sandbox !== undefined ? { sandbox: deps.sandbox } : {}),
      ...(deps.sandboxFacts !== undefined ? { sandboxFacts: deps.sandboxFacts } : {}),
      ...(deps.gitFacts !== undefined ? { gitFacts: deps.gitFacts } : {}),
      ...(deps.contextBudget !== undefined ? { contextBudget: deps.contextBudget } : {}),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.idGen !== undefined ? { idGen: deps.idGen } : {}),
    });
  } catch (err) {
    return fail(`subagent failed to start: ${(err as Error).message}`);
  }

  // Child evidence completeness: the probed facts still hold (same process, same workspace),
  // so `agent report <childId>` renders the same header sections as any session.
  if (deps.sandboxFacts !== undefined) recordSandboxStatus(child, deps.sandboxFacts);
  if (deps.gitFacts !== undefined) recordGitContext(child, deps.gitFacts);
  recordWorkspaceMap(child, deps.map);
  deps.reportTask?.({ kind: 'started', role: spec.role, childSessionId: child.id, budget });

  // Cause-tracked cancellation: one child controller, three inputs. The cause decides the status
  // (and the child's session.ended reason) — the child itself only ever sees "aborted".
  const controller = new AbortController();
  let cause: 'parent-abort' | 'timeout' | 'budget-tokens' | null = null;
  const cancel = (c: NonNullable<typeof cause>): void => {
    if (cause === null) {
      cause = c;
      controller.abort();
    }
  };
  const onParentAbort = (): void => cancel('parent-abort');
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => cancel('timeout'), budget.timeoutMs);

  let outputTokens = 0;
  child.log.onAppend = (e): void => {
    try {
      if (e.type === 'assistant.message') {
        outputTokens += e.usage.outputTokens;
        if (outputTokens > budget.maxOutputTokens) cancel('budget-tokens');
      } else if (e.type === 'tool.requested') {
        const i = e.input as Record<string, unknown> | null;
        const target = typeof i?.['path'] === 'string' ? i['path'] : typeof i?.['pattern'] === 'string' ? i['pattern'] : typeof i?.['command'] === 'string' ? i['command'] : '';
        deps.onProgress?.(`${e.tool} ${String(target)}`.trim());
      }
    } catch {
      /* progress/budget bookkeeping must never break the child */
    }
  };

  let result: { finalText: string; steps: number; stopped: boolean; aborted: boolean } | null = null;
  let error: Error | null = null;
  try {
    result = await runTurn(child, delegationPrompt(spec), { signal: controller.signal });
  } catch (err) {
    error = err as Error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
    child.log.onAppend = undefined;
  }

  const status: TaskStatus =
    error !== null
      ? 'error'
      : result!.aborted
        ? cause === 'timeout'
          ? 'timeout'
          : cause === 'budget-tokens'
            ? 'budget-tokens'
            : 'aborted'
        : result!.stopped && result!.steps >= budget.maxSteps
          ? 'budget-steps'
          : result!.stopped
            ? 'error' // deny-&-stop is unreachable under autoDeny; recorded honestly if it ever happens
            : 'completed';
  const childReason =
    status === 'completed' ? 'completed' : status === 'budget-steps' ? 'max-steps' : status === 'aborted' ? 'aborted' : status === 'error' ? 'error' : 'budget';
  try {
    endSession(child, childReason, error?.message);
  } catch {
    try {
      child.log.close();
    } catch {
      /* lock release is best-effort */
    }
  }

  const usage = sumUsage(child);
  const finalText =
    result !== null && result.finalText.length > 0
      ? result.finalText
      : error !== null
        ? `subagent turn failed: ${error.message}`
        : `(no report — task ${status})`;
  const out: SubagentResult = {
    status,
    finalText,
    steps: result?.steps ?? 0,
    usage,
    childSessionId: child.id,
    childLogPath: deps.layout.sessionFile(child.id),
    durationMs: Math.max(0, clock.now() - startedAt),
    budget,
  };
  deps.reportTask?.({
    kind: 'ended',
    childSessionId: child.id,
    status,
    steps: out.steps,
    usage,
    resultSha256: sha256(Buffer.from(finalText, 'utf8')),
    durationMs: out.durationMs,
  });
  return out;
}

function delegationPrompt(spec: SubagentSpec): string {
  return [
    `Delegated task from the main agent:`,
    spec.task,
    ...(spec.expectedOutput !== undefined ? ['', `Expected report shape: ${spec.expectedOutput}`] : []),
  ].join('\n');
}

function sumUsage(child: Session): Usage {
  const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const e of child.log.events) {
    if (e.type !== 'assistant.message') continue;
    total.inputTokens += e.usage.inputTokens;
    total.outputTokens += e.usage.outputTokens;
    total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + (e.usage.cacheReadInputTokens ?? 0);
    total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + (e.usage.cacheCreationInputTokens ?? 0);
  }
  return total;
}
