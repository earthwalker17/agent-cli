import { autoDenyApprover } from './approvals.js';
import { startSession, runTurn, endSession, recordSandboxStatus, recordGitContext, recordWorkspaceMap, type Session } from './session.js';
import type { ElisionOptions } from './elision.js';
import { ROLE_CONTRACTS } from './roles.js';
import { TOOLS } from '../tools/index.js';
import { FACT_KINDS, type FactKind } from '../policy/engine.js';
import type { NoteAccumulator } from '../tools/record-source.js';
import type { ResearchBudget, ResearchSpend } from '../tools/research-budget.js';
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
  Tool,
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
/** Session 16: 12 → 16 tasks, 150k → 200k child output tokens. Multi-project work legitimately
 *  needs more units of delegated work; the per-task budgets and the group cap of 3 are unchanged,
 *  so this buys breadth, not longer or less bounded children. */
export const TASKS_PER_SESSION = 16;
export const SESSION_CHILD_OUTPUT_TOKEN_CAP = 200_000;

/**
 * Which policy FACTS a named per-session instance may carry into a child registry.
 *
 * `satisfies Record<FactKind, boolean>` is the point of this table (Session 19). The predicate it
 * replaces was a hand-written DENY-list of the facts that existed when it was written, which is
 * fail-OPEN by construction: every fact invented afterwards passed silently, which is exactly how
 * `artifact` came to be missing from it. Now the next fact added to the engine's `FACT_KINDS`
 * breaks THIS file's typecheck until someone decides whether a child may hold it.
 *
 * Only `research` is admissible, and only because it is genuinely gated elsewhere: the engine's
 * research branch re-decides every call inside the child, the delegated-role admission is keyed on
 * runtime lineage rather than on the instance, and the session budget is shared with the parent.
 * Everything else would hand a child authority the depth-1 contract exists to deny.
 */
const CHILD_ADMISSIBLE_FACTS = {
  command: false,
  delegates: false,
  planDoc: false,
  check: false,
  browser: false,
  evidenceRead: false,
  artifact: false,
  research: true,
} satisfies Record<FactKind, boolean>;

/** The three per-task research instances a researcher child receives. */
export interface ResearchToolBundle {
  webSearch: Tool;
  webExtract: Tool;
  recordSource: Tool;
  /**
   * THIS task's running spend, accumulated by the two instances above and read by the delegate
   * for the parent-log usage record. It exists because a diff of the SHARED budget around a task
   * is wrong under Promise.all: siblings interleave, so every task's delta would include theirs.
   */
  taskSpend: ResearchSpend;
}

/**
 * The NAMED per-session instances a child may be given. Deliberately a fixed record rather than a
 * generic extra-tools list: depth-1 stays a property of construction, and every entry here is one
 * a role contract must also name by string before it is admitted.
 */
export interface NamedChildTools {
  /** Session 10: the parent's ranked-index lookup. */
  retrieve?: Tool;
  /** Session 14: the reviewer's only findings channel. */
  reportFinding?: Tool;
  /** Session 19: the researcher's three instances, built per task by the research factory. */
  webSearch?: Tool;
  webExtract?: Tool;
  recordSource?: Tool;
}

/**
 * A child's tool registry (Session 10): the static TOOLS filtered by the role contract, plus —
 * for roles that NAME them — per-session instances admitted only when their declared facts are
 * child-admissible. Fail closed by dropping: a wrongly-shaped instance simply never reaches a
 * child, and the role prompt is told which instances actually landed so it never promises one
 * that did not.
 */
export function childTools(toolNames: readonly string[], named: NamedChildTools = {}): Tool[] {
  const tools: Tool[] = TOOLS.filter((t) => toolNames.includes(t.name));
  const admissible = (t: Tool | undefined): t is Tool =>
    t !== undefined && toolNames.includes(t.name) && FACT_KINDS.every((k) => CHILD_ADMISSIBLE_FACTS[k] || t[k] === undefined);
  for (const t of [named.retrieve, named.reportFinding, named.webSearch, named.webExtract, named.recordSource]) {
    if (admissible(t)) tools.push(t);
  }
  return tools;
}

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
  /** Render-only STRUCTURED status updates (Session 11) — feeds the live task table. */
  onStatus?: (u: ChildStatusUpdate) => void;
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
  /**
   * Live parent runtime identity (Session 15): read once per delegate CALL, so a /provider or
   * /model switch reaches later children — whose own session.started then records the truth.
   * Absent (tests / older wiring) = the assembly-time snapshot fields above. providerForTask
   * still wins for per-child test scripting.
   */
  currentRuntime?: () => { model: string; maxTokens: number; provider: Provider; contextBudget?: ElisionOptions };
  /**
   * Session 10: the parent session's read-only retrieve tool instance, admitted into a child
   * ONLY when the role contract names it AND the instance is structurally free of
   * command/delegates/planDoc facts — a NAMED single-tool seam, deliberately not a generic
   * extra-tools list, so the depth-1 guarantee (children never see delegate/apply/update_plan)
   * stays a property of construction rather than a convention.
   */
  retrieveTool?: Tool;
  /**
   * Session 14: the PER-TASK report_finding instance for a reviewer child (the delegate
   * constructs one accumulator+tool per reviewer inside the fan-out, so parallel lenses can
   * never interleave findings). Admitted only when the role contract names it AND the
   * instance passes the same structural fact check as retrieve.
   */
  reportFindingTool?: Tool;
  /**
   * Session 19: the PER-TASK research instances for a researcher child. A FACTORY, not finished
   * instances, because these three cannot be built where `createReportFindingTool(acc)` can:
   * they need the credential, the proxy transport, the operator denylist and — crucially — the
   * ONE shared session budget, all of which live in assembly. The factory closes over those and
   * takes only the per-task accumulator, so each researcher's findings stay its own while every
   * researcher spends the same allowance.
   *
   * Absent means research is unavailable this session (no credential); the delegate refuses a
   * researcher spawn outright rather than starting a child that would find its own tools missing.
   */
  researchToolsFor?: (acc: NoteAccumulator) => ResearchToolBundle;
  /**
   * The instances for THIS task, produced by the delegate from `researchToolsFor` and a per-task
   * accumulator — the `reportFindingTool` shape exactly. The runner only ever reads this one;
   * the factory above is what the delegate calls.
   */
  researchTools?: ResearchToolBundle;
  /**
   * The ONE shared session budget. The delegate reads it before and after each researcher task to
   * derive that task's spend for the parent-log `research.usage` capture — the child's own
   * `research.*` events are in a log the parent's fold never reads.
   */
  researchBudget?: ResearchBudget;
  /**
   * Session 11: task-scoped cancellation seam. Called once the child session exists with a
   * handle that cancels THIS child only (cause 'user-cancelled' → status 'cancelled'); the
   * returned unregister runs when the task ends. The registry lives REPL-side (/cancel); the
   * runner only exposes the handle — never a way to widen authority.
   */
  registerCancel?: (childSessionId: string, cancel: () => void) => (() => void) | void;
}

/** A supervision observation attached to a task's result (also persisted as task.supervision). */
export interface SupervisionNote {
  what: 'stall' | 'loop' | 'budget-pressure' | 'cancelled';
  detail?: string;
}

/**
 * A structured RENDER-ONLY child status update (Session 11) — the live-surface counterpart of
 * the onProgress chrome lines. Produced by the runner, consumed by the REPL's task table;
 * never persisted (the event log stays the truth of record).
 */
export interface ChildStatusUpdate {
  childSessionId: string;
  role?: string;
  planTaskId?: string;
  /** Omitted = no phase change (e.g. a supervision flag riding an existing phase). */
  phase?: 'running' | 'tool' | 'approval-wait' | 'ended';
  tool?: string;
  steps?: number;
  outTokens?: number;
  status?: TaskStatus;
  supervision?: string;
}

export interface SubagentSpec {
  role: SubagentRoleName;
  task: string;
  /** Verbatim supporting material from the parent (findings, a scoped diff); joins the delegation prompt. */
  context?: string;
  expectedOutput?: string;
  /**
   * Session 10: harness-composed brief lines (focus/avoid scope, sibling coverage) rendered
   * between the task and the context. Composed by the delegate tool from the group's structured
   * fields — never model-authored free text.
   */
  briefLines?: readonly string[];
  parentSessionId: string;
  /** The approved-plan task this child executes (Session 11) — recorded on task.started. */
  planTaskId?: string;
  /**
   * The bound plan task's DEFINITION sha at spawn time (Session 11.5) — recorded on
   * task.started so 'completed' attaches to the definition that ran, not the id alone.
   */
  planTaskSha?: string;
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
  /** Harness supervision observations (Session 11) — surfaced in the delegate group digest. */
  supervision: SupervisionNote[];
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
    supervision: [],
  });

  // Cause-tracked cancellation machinery is created BEFORE the session so the forwarding
  // approver can be signal-linked from birth (a forwarded ask must die with its task).
  // Session 11 causes: 'user-cancelled' (task-scoped /cancel — this child only) and
  // 'stalled-loop' (the supervisor's bounded loop intervention).
  const controller = new AbortController();
  let cause: 'parent-abort' | 'timeout' | 'budget-tokens' | 'user-cancelled' | 'stalled-loop' | null = null;
  const cancel = (c: NonNullable<typeof cause>): void => {
    if (cause === null) {
      cause = c;
      controller.abort();
    }
  };

  // Supervision recorder (Session 11): bounded (≤6/task), never throws, dual-surfaced — the
  // persisted task.supervision event (parent evidence) and the result notes (the group digest).
  const SUPERVISION_CAP = 6;
  const supervisionNotes: SupervisionNote[] = [];
  const childIdRef = { id: '' };
  const pushStatus = (u: Omit<ChildStatusUpdate, 'childSessionId'>): void => {
    try {
      deps.onStatus?.({ childSessionId: childIdRef.id, ...u });
    } catch {
      /* render-only */
    }
  };
  const supervise = (what: SupervisionNote['what'], detail?: string): void => {
    if (supervisionNotes.length >= SUPERVISION_CAP) return;
    const note: SupervisionNote = { what, ...(detail !== undefined ? { detail } : {}) };
    supervisionNotes.push(note);
    try {
      deps.reportTask?.({ kind: 'supervision', childSessionId: childIdRef.id, what, ...(detail !== undefined ? { detail } : {}) });
      deps.onProgress?.(`${spec.role}·${childIdRef.id.slice(-4)} supervision: ${what}${detail !== undefined ? ` — ${detail}` : ''}`);
    } catch {
      /* supervision bookkeeping must never break the child */
    }
    pushStatus({ supervision: what });
  };

  // A 'forward' role routes asks through the serialized parent-side forwarder, each request
  // stamped with this task's identity (the box fills right after startSession — no tool call
  // can run before that). No forwarder wired ⇒ fail closed. Read-only roles ALWAYS auto-deny.
  const taskIdBox = { childSessionId: '' };
  const approver: Approver =
    contract.approvals === 'forward' && deps.forwardAsk !== undefined
      ? async (req) => {
          pushStatus({ phase: 'approval-wait' }); // the live surface shows WHO is waiting on the human
          try {
            return await deps.forwardAsk!(
              { ...req, taskContext: { childSessionId: taskIdBox.childSessionId, role: spec.role } },
              controller.signal,
            );
          } finally {
            pushStatus({ phase: 'running' });
          }
        }
      : autoDenyApprover;
  // Tools first, prompt second: the prompt states exactly the registry this child actually has
  // (retrieve is admitted per-session; the wording must not promise an absent tool).
  const researchTools = deps.researchTools;
  const tools = childTools(contract.toolNames, {
    ...(deps.retrieveTool !== undefined ? { retrieve: deps.retrieveTool } : {}),
    ...(deps.reportFindingTool !== undefined ? { reportFinding: deps.reportFindingTool } : {}),
    ...(researchTools !== undefined
      ? { webSearch: researchTools.webSearch, webExtract: researchTools.webExtract, recordSource: researchTools.recordSource }
      : {}),
  });
  let system: string;
  try {
    system = contract.buildPrompt({
      workspaceRoot: deps.workspaceRoot,
      map: deps.map,
      sandbox: deps.sandboxFacts,
      git: deps.gitFacts,
      agentMd: deps.agentMd,
      retrieve: tools.some((t) => t.name === 'retrieve'),
      webSearch: tools.some((t) => t.name === 'web_search'),
      webExtract: tools.some((t) => t.name === 'web_extract'),
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
      tools,
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
  childIdRef.id = child.id;
  // Child evidence completeness: the probed facts still hold (same process, same workspace),
  // so `agent report <childId>` renders the same header sections as any session.
  if (deps.sandboxFacts !== undefined) recordSandboxStatus(child, deps.sandboxFacts);
  if (deps.gitFacts !== undefined) recordGitContext(child, deps.gitFacts);
  recordWorkspaceMap(child, deps.map);
  deps.reportTask?.({
    kind: 'started',
    role: spec.role,
    childSessionId: child.id,
    budget,
    ...(spec.planTaskId !== undefined ? { planTaskId: spec.planTaskId } : {}),
    ...(spec.planTaskSha !== undefined ? { planTaskSha: spec.planTaskSha } : {}),
  });
  pushStatus({ phase: 'running', role: spec.role, ...(spec.planTaskId !== undefined ? { planTaskId: spec.planTaskId } : {}) });

  // Task-scoped cancellation (Session 11): expose ONE narrow handle — cancel THIS child as
  // 'user-cancelled'. Registered only after the child exists; unregistered in finally. The
  // handle is idempotent: a rapid double-/cancel must not record duplicate supervision evidence.
  let userCancelFired = false;
  const unregisterCancel = deps.registerCancel?.(child.id, () => {
    if (userCancelFired) return;
    userCancelFired = true;
    supervise('cancelled', 'task-scoped user cancellation (/cancel)');
    cancel('user-cancelled');
  });

  // Cancellation inputs: parent abort, wall clock, token cap. The cause decides the status
  // (and the child's session.ended reason) — the child itself only ever sees "aborted".
  const onParentAbort = (): void => cancel('parent-abort');
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => cancel('timeout'), budget.timeoutMs);
  // Stall + budget-pressure ticker. Thresholds scale down with narrowed test budgets but are
  // the production constants (60s stall, 30s cadence) at the real role budgets. A silent child
  // is probably mid-provider-call or waiting on a forwarded approval — both legitimate — so
  // stall only narrates + records ONE supervision observation; the wall clock enforces.
  const stallAfterMs = Math.min(60_000, Math.max(50, Math.floor(budget.timeoutMs / 2)));
  // timeout/8 so a tick reliably lands between the 80% wall-pressure threshold and the timeout
  // itself; capped at the production 30s cadence for the real role budgets.
  const tickMs = Math.min(30_000, Math.max(25, Math.floor(budget.timeoutMs / 8)));
  let lastActivity = clock.now();
  let stallNoted = false;
  let wallPressureNoted = false;
  // Session 16: a child with a command IN FLIGHT is not idle, it is working. The chain only fires
  // on appended events, so a legitimate five-minute install inside an executor looked exactly
  // like a hung child and recorded a `stall` observation the reader had to learn to ignore —
  // which is how a signal stops meaning anything.
  //
  // Tracked by callId rather than a counter: an `unsupported` check reports a completion with no
  // start, and a counter would go negative-then-clamped and desynchronise. Honest bound: if a
  // completion is LOST (a crash mid-spawn), this child's stall NOTE stays suppressed — but the
  // task wall clock and the command's own timeout still enforce, unchanged, so the suppression
  // costs an observation, never an unbounded child.
  const spawnsInFlight = new Set<string>();
  const stallTimer = setInterval(() => {
    const idleMs = clock.now() - lastActivity;
    if (idleMs >= stallAfterMs && spawnsInFlight.size === 0) {
      deps.onProgress?.(`${spec.role}·${child.id.slice(-4)} no activity for ${Math.round(idleMs / 1000)}s (hard timeout at ${Math.round(budget.timeoutMs / 1000)}s)`);
      if (!stallNoted) {
        stallNoted = true;
        supervise('stall', `no activity for ${Math.round(idleMs / 1000)}s`);
      }
    }
    const elapsed = clock.now() - startedAt;
    if (!wallPressureNoted && elapsed >= budget.timeoutMs * 0.8) {
      wallPressureNoted = true;
      supervise('budget-pressure', `wall clock at ${Math.round((100 * elapsed) / budget.timeoutMs)}% of ${Math.round(budget.timeoutMs / 1000)}s`);
    }
  }, tickMs);

  // Loop detection (Session 11): consecutive IDENTICAL tool calls (same tool, same input hash,
  // nothing between). 3 → annotate; 5 → the bounded hard intervention (cancel as 'stalled').
  const LOOP_ANNOTATE_AT = 3;
  const LOOP_CANCEL_AT = 5;
  let lastCallSig = '';
  let identicalCalls = 0;
  let outputTokens = 0;
  let stepsSeen = 0;
  let tokenPressureNoted = false;
  child.log.onAppend = (e): void => {
    try {
      lastActivity = clock.now();
      if (e.type === 'command.started' || e.type === 'check.started' || e.type === 'setup.started') spawnsInFlight.add(e.callId);
      else if (e.type === 'command.ended' || e.type === 'check.completed' || e.type === 'setup.completed') spawnsInFlight.delete(e.callId);
      if (e.type === 'assistant.message') {
        stepsSeen++;
        outputTokens += e.usage.outputTokens;
        pushStatus({ phase: 'running', steps: stepsSeen, outTokens: outputTokens });
        if (outputTokens > budget.maxOutputTokens) cancel('budget-tokens');
        else if (!tokenPressureNoted && outputTokens >= budget.maxOutputTokens * 0.8) {
          tokenPressureNoted = true;
          supervise('budget-pressure', `output tokens at ${Math.round((100 * outputTokens) / budget.maxOutputTokens)}% of ${budget.maxOutputTokens}`);
        }
      } else if (e.type === 'tool.requested') {
        pushStatus({ phase: 'tool', tool: e.tool, steps: stepsSeen, outTokens: outputTokens });
        const sig = sha256(`${e.tool}\u0000${JSON.stringify(e.input)}`);
        identicalCalls = sig === lastCallSig ? identicalCalls + 1 : 1;
        lastCallSig = sig;
        if (identicalCalls === LOOP_ANNOTATE_AT) {
          supervise('loop', `${identicalCalls} identical consecutive ${e.tool} calls`);
        } else if (identicalCalls >= LOOP_CANCEL_AT) {
          supervise('loop', `auto-cancelled at ${identicalCalls} identical consecutive ${e.tool} calls`);
          cancel('stalled-loop');
        }
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
    try {
      unregisterCancel?.();
    } catch {
      /* unregister is best-effort */
    }
  }

  const status: TaskStatus =
    error !== null
      ? 'error'
      : result!.aborted
        ? cause === 'timeout'
          ? 'timeout'
          : cause === 'budget-tokens'
            ? 'budget-tokens'
            : cause === 'user-cancelled'
              ? 'cancelled' // task-scoped /cancel: this child only, the parent turn continues
              : cause === 'stalled-loop'
                ? 'stalled' // the supervisor's bounded loop intervention
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
        : status === 'aborted' || status === 'user-stopped' || status === 'cancelled' || status === 'stalled'
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
    supervision: supervisionNotes,
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
  pushStatus({ phase: 'ended', status, steps: out.steps, outTokens: usage.outputTokens });
  return out;
}

/**
 * Session 10 hardening, generalized in S14.5 and moved to shared/text.ts (the memory injection
 * needed the same guard and workspace/ must not import runtime/). Re-exported here because the
 * delegate tool and several tests import it from this module.
 */
import { neutralizeHarnessDelimiters } from '../shared/text.js';
export { neutralizeHarnessDelimiters };

function delegationPrompt(spec: SubagentSpec): string {
  return [
    `Delegated task from the main agent:`,
    spec.task,
    ...(spec.briefLines !== undefined && spec.briefLines.length > 0 ? ['', 'Brief (scope discipline for this task):', ...spec.briefLines] : []),
    ...(spec.context !== undefined && spec.context.length > 0
      ? [
          '',
          'Supporting context from the main agent (verbatim; verify anything load-bearing against the repository):',
          '--- context begin ---',
          neutralizeHarnessDelimiters(spec.context),
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
