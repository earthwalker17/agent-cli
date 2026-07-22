import { autoDenyApprover } from './approvals.js';
import { startSession, runTurn, endSession, recordSandboxStatus, recordGitContext, recordWorkspaceMap, type Session } from './session.js';
import type { ElisionOptions } from './elision.js';
import { ROLE_CONTRACTS } from './roles.js';
import { TOOLS } from '../tools/index.js';
import type { WorkspaceMap } from '../workspace/map.js';
import type { ProjectLayout } from '../store/layout.js';
import type { SandboxBackend, EnforcementFacts } from '../sandbox/index.js';
import type { GitFacts } from '../git/types.js';
import { randomSaltHex, sha256 } from '../shared/hash.js';
import { systemClock, type Clock } from '../shared/clock.js';
import type { IdGen } from '../shared/ids.js';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  Approver,
  PolicyRules,
  Provider,
  SubagentRoleName,
  TaskBudget,
  TaskEvidence,
  TaskStatus,
  Usage,
} from '../types.js';

/**
 * The subagent task runner: ONE bounded child session driving the SAME runTurn the main agent
 * uses (no second execution loop). A delegated task is exactly one turn — multi-step inside, but
 * with no user to converse with — so turn-level cancellation IS session-level cancellation.
 *
 * Authority is inherited-or-narrower by construction: the role contract's tool registry (a
 * subset of TOOLS; never the delegate/apply tools ⇒ depth 1), auto-denied approvals for
 * read-only roles (asks fail closed — only provably-safe commands inside the parent's PROBED
 * sandbox instance can auto-run; the executor role forwards asks to the parent's approver
 * instead), the parent's narrowing rules, and a fixed harness budget the model never controls.
 * The child gets its own event log (fresh session id ⇒ own lock), so its evidence is
 * attributable and its work independently inspectable.
 */

/** Cumulative delegation caps per parent session (enforced by the delegate tool's closure). */
export const TASKS_PER_SESSION = 12;
export const SESSION_CHILD_OUTPUT_TOKEN_CAP = 150_000;

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
  /**
   * The serialized parent-side approval forwarder for 'forward'-mode roles (the queue wraps the
   * parent SESSION approver, so non-interactive parents fail closed structurally). Each request
   * is stamped with the asking task's identity and linked to its abort signal. Absent — and for
   * every auto-deny role — the child fails closed on autoDenyApprover.
   */
  forwardAsk?: (req: ApprovalRequest, signal: AbortSignal | undefined) => Promise<ApprovalOutcome>;
  /**
   * Per-task provider override for a PARALLEL group (tests: one scripted MockProvider per child
   * — a shared script cursor interleaves nondeterministically under Promise.all). Production
   * leaves this unset: the shared streaming provider is stateless per request.
   */
  providerForTask?: (index: number, role: SubagentRoleName) => Provider;
}

export interface SubagentSpec {
  role: SubagentRoleName;
  task: string;
  /** Verbatim supporting material from the parent (findings, a scoped diff); joins the delegation prompt. */
  context?: string;
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
  const contract = ROLE_CONTRACTS[spec.role];
  const budget: TaskBudget = {
    maxSteps: deps.budget?.maxSteps ?? contract.budget.maxSteps,
    timeoutMs: deps.budget?.timeoutMs ?? contract.budget.timeoutMs,
    maxOutputTokens: deps.budget?.maxOutputTokens ?? contract.budget.maxOutputTokens,
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

  // Cause-tracked cancellation machinery is created BEFORE the session so the forwarding
  // approver can be signal-linked from birth (a forwarded ask must die with its task).
  const controller = new AbortController();
  let cause: 'parent-abort' | 'timeout' | 'budget-tokens' | null = null;
  const cancel = (c: NonNullable<typeof cause>): void => {
    if (cause === null) {
      cause = c;
      controller.abort();
    }
  };

  // A 'forward' role routes asks through the serialized parent-side forwarder, each request
  // stamped with this task's identity (the box fills right after startSession — no tool call
  // can run before that). No forwarder wired ⇒ fail closed. Read-only roles ALWAYS auto-deny.
  const taskIdBox = { childSessionId: '' };
  const approver: Approver =
    contract.approvals === 'forward' && deps.forwardAsk !== undefined
      ? (req) =>
          deps.forwardAsk!(
            { ...req, taskContext: { childSessionId: taskIdBox.childSessionId, role: spec.role } },
            controller.signal,
          )
      : autoDenyApprover;
  let system: string;
  try {
    system = contract.buildPrompt({
      workspaceRoot: deps.workspaceRoot,
      map: deps.map,
      sandbox: deps.sandboxFacts,
      git: deps.gitFacts,
      agentMd: deps.agentMd,
    });
  } catch (err) {
    return fail(`subagent failed to start: ${(err as Error).message}`);
  }
  let child: Session;
  try {
    child = startSession({
      workspaceRoot: deps.workspaceRoot,
      layout: deps.layout,
      model: deps.model,
      mode: 'non-interactive',
      provider: deps.provider,
      approver,
      system,
      maxSteps: budget.maxSteps,
      maxTokens: deps.maxTokens,
      tools: TOOLS.filter((t) => contract.toolNames.includes(t.name)),
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

  taskIdBox.childSessionId = child.id;
  // Child evidence completeness: the probed facts still hold (same process, same workspace),
  // so `agent report <childId>` renders the same header sections as any session.
  if (deps.sandboxFacts !== undefined) recordSandboxStatus(child, deps.sandboxFacts);
  if (deps.gitFacts !== undefined) recordGitContext(child, deps.gitFacts);
  recordWorkspaceMap(child, deps.map);
  deps.reportTask?.({ kind: 'started', role: spec.role, childSessionId: child.id, budget });

  // Cancellation inputs: parent abort, wall clock, token cap. The cause decides the status
  // (and the child's session.ended reason) — the child itself only ever sees "aborted".
  const onParentAbort = (): void => cancel('parent-abort');
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => cancel('timeout'), budget.timeoutMs);
  // Stall VISIBILITY (render-only): a silent child is probably mid-provider-call or waiting on
  // a forwarded approval — both legitimate — so this only narrates; the wall clock enforces.
  let lastActivity = clock.now();
  const stallTimer = setInterval(() => {
    const idleMs = clock.now() - lastActivity;
    if (idleMs >= 60_000) {
      deps.onProgress?.(`${spec.role}·${child.id.slice(-4)} no activity for ${Math.round(idleMs / 1000)}s (hard timeout at ${Math.round(budget.timeoutMs / 1000)}s)`);
    }
  }, 30_000);

  let outputTokens = 0;
  child.log.onAppend = (e): void => {
    try {
      lastActivity = clock.now();
      if (e.type === 'assistant.message') {
        outputTokens += e.usage.outputTokens;
        if (outputTokens > budget.maxOutputTokens) cancel('budget-tokens');
      } else if (e.type === 'tool.requested') {
        const i = e.input as Record<string, unknown> | null;
        const target = typeof i?.['path'] === 'string' ? i['path'] : typeof i?.['pattern'] === 'string' ? i['pattern'] : typeof i?.['command'] === 'string' ? i['command'] : '';
        // Task identity in every line: parallel group members interleave on one chrome stream.
        deps.onProgress?.(`${spec.role}·${child.id.slice(-4)} ${e.tool} ${String(target)}`.trim());
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
    clearInterval(stallTimer);
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
            ? 'user-stopped' // deny-&-stop at a forwarded approval: the user ended THIS child only
            : 'completed';
  const childReason =
    status === 'completed'
      ? 'completed'
      : status === 'budget-steps'
        ? 'max-steps'
        : status === 'aborted' || status === 'user-stopped'
          ? 'aborted'
          : status === 'error'
            ? 'error'
            : 'budget';
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
    ...(spec.context !== undefined && spec.context.length > 0
      ? [
          '',
          'Supporting context from the main agent (verbatim; verify anything load-bearing against the repository):',
          '--- context begin ---',
          spec.context,
          '--- context end ---',
        ]
      : []),
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
