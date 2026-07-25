/**
 * All shared plain-data contracts for Agent CLI. No logic lives here — this is the single
 * place the kernel's interfaces are defined so modules depend on shapes, not on each other.
 */
import type { ZodType } from 'zod';
// Type-only import (erased at runtime): lets ExecSandbox.wrap be concretely typed without a
// runtime cycle with the exec substrate (which type-only-imports CommandTermination from here).
import type { ExecSpec } from './exec/run.js';

// ── Action taxonomy ────────────────────────────────────────────────────────────────────────
// Consequence classes from the constitution's safety policy. This is the "approval" axis only;
// V0.1 has no OS "sandbox" axis (documented honestly).
export type ActionClass = 'observe' | 'reversible' | 'external' | 'destructive' | 'sensitive';

export type SessionMode = 'interactive' | 'non-interactive';

/**
 * How a managed command actually ended. 'exited' is the only termination with a real exit code;
 * killed commands (timeout/aborted) have NO exit code and must never read as a completed check.
 */
export type CommandTermination = 'exited' | 'timeout' | 'aborted' | 'spawn-error';

// ── Tools ──────────────────────────────────────────────────────────────────────────────────
/** Absolute paths a tool will change. Declarable ⇒ snapshottable ⇒ reversible. */
export interface MutationPlan {
  paths: string[];
}

/** Narrowing-only policy additions from configuration (union across layers; never widening). */
export interface PolicyRules {
  /** Extra write-deny roots, resolved against the workspace root. */
  protectedPaths: string[];
  /** Literal lowercase basename substrings marking files as secret-like. */
  secretPatterns: string[];
  /** Extra lowercase name substrings dropped from child-process environments (cannot drop the core floor). */
  envExcludePatterns: string[];
}

/**
 * Structured facts about a command execution, reported by the executing tool through
 * `ToolContext.reportCommand`. The runtime binds the callId when persisting, so a tool can
 * only ever produce evidence for its own call.
 */
export type CommandEvidence =
  | { kind: 'started'; pid: number; shell: string; cwd: string; timeoutMs: number; sandbox: 'none' | 'windows-lowil' }
  | {
      kind: 'ended';
      termination: CommandTermination;
      /** null unless the process genuinely exited (killed commands have no exit code). */
      exitCode: number | null;
      durationMs: number;
      killDetail?: string;
      drainTimedOut?: boolean;
    };

/**
 * Typed verification kinds (Session 12) — the shared vocabulary the plan schema, the event log,
 * the report, and the recovery catalogue all key on, so it lives with the contracts rather than
 * inside the checks module. There is deliberately NO dependency-install kind: installing runs
 * third-party code with network access, which is not "verify what we just built"; a missing
 * toolchain is an honest `unsupported` precondition the user resolves.
 */
export type CheckKind = 'build' | 'test' | 'test-targeted' | 'typecheck' | 'lint' | 'format' | 'static-analysis';

/** Declaration order is the canonical order everywhere (schemas, views, reports, prompts). */
export const CHECK_KINDS: readonly CheckKind[] = [
  'build',
  'test',
  'test-targeted',
  'typecheck',
  'lint',
  'format',
  'static-analysis',
] as const;

export function isCheckKind(v: string): v is CheckKind {
  return (CHECK_KINDS as readonly string[]).includes(v);
}

/**
 * `pass`/`fail` come from the EXIT CODE of a process that genuinely exited; `error` covers every
 * non-exit termination (timeout, abort, spawn failure) and can never read as a passing check;
 * `unsupported` never ran at all. Output parsing may only enrich the summary/findings/signals.
 */
export type CheckStatus = 'pass' | 'fail' | 'error' | 'unsupported';

export interface CheckFinding {
  file?: string;
  line?: number;
  message: string;
}

/**
 * Structured facts about a typed check, reported through `ToolContext.reportCheck`. Same contract
 * as `CommandEvidence`: the runtime binds the callId, so a tool can only ever produce evidence
 * for its own call. `started` is emitted ONLY for a real spawn — an `unsupported` kind reports an
 * `ended` alone, because nothing ran.
 */
export type CheckEvidence =
  | {
      kind: 'started';
      check: CheckKind;
      recipeId: string;
      command: string;
      cwd: string;
      timeoutMs: number;
      planTaskId?: string;
      scopePaths?: string[];
    }
  | {
      kind: 'ended';
      check: CheckKind;
      recipeId: string;
      status: CheckStatus;
      /** null unless the process genuinely exited (killed checks have no exit code). */
      exitCode: number | null;
      termination?: CommandTermination;
      durationMs: number;
      summary: string;
      /** Named signal ids — what keeps failure classification derivable from the log alone. */
      signals?: string[];
      findings?: CheckFinding[];
      planTaskId?: string;
      scopePaths?: string[];
    };

/**
 * Subagent role names and their access class — the POLICY fact table (V0.7). Data only: the
 * runtime builds full role contracts (tool registry, prompt, budget, approval mode) on top of
 * this in `runtime/roles.ts`. `decide()` consults THIS table and fails closed on any role that
 * is not in it; 'mutating-worktree' roles additionally require worktree isolation to exist.
 */
export type SubagentRoleName = 'explorer' | 'planner' | 'reviewer' | 'executor';
export type SubagentRoleAccess = 'read-only' | 'mutating-worktree';
export const SUBAGENT_ROLES: Record<SubagentRoleName, { access: SubagentRoleAccess }> = {
  explorer: { access: 'read-only' },
  planner: { access: 'read-only' },
  reviewer: { access: 'read-only' },
  executor: { access: 'mutating-worktree' },
};
/** Access class for a role name, or undefined when the role is unknown (⇒ deny, fail closed). */
export function subagentRoleAccess(role: string): SubagentRoleAccess | undefined {
  return Object.prototype.hasOwnProperty.call(SUBAGENT_ROLES, role)
    ? SUBAGENT_ROLES[role as SubagentRoleName].access
    : undefined;
}

/**
 * How a delegated subagent task ended (V0.6; 'user-stopped' added in V0.7 — the user answered
 * a forwarded approval with deny-&-stop, ending THAT child only, not the parent turn).
 * Session 11 (additive): 'cancelled' = task-scoped user cancellation (/cancel — this child only,
 * not the turn); 'stalled' = the harness supervisor cancelled a child stuck repeating the same
 * tool call (the bounded loop intervention).
 */
export type TaskStatus =
  | 'completed'
  | 'error'
  | 'budget-steps'
  | 'budget-tokens'
  | 'timeout'
  | 'aborted'
  | 'user-stopped'
  | 'cancelled'
  | 'stalled';

/** The harness-fixed budget a delegated task runs under (never model-controlled). */
export interface TaskBudget {
  maxSteps: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

/**
 * Structured facts about a delegated task's lifecycle, reported by the delegating tool through
 * `ToolContext.reportTask`. Like CommandEvidence, the runtime binds the callId when persisting —
 * the runtime-bound callId + the unique childSessionId are the unforgeable parent↔child join.
 */
/** One file change captured from an executor task's worktree (V0.7). Paths are WORKSPACE-relative. */
export interface TaskChangeFile {
  relPath: string;
  kind: 'create' | 'modify' | 'delete';
  /** sha256 of the file's BASE bytes (worktree form, filters applied); null for creates. */
  baseSha256: string | null;
  /** sha256 of the AFTER bytes, stored as a content-addressed blob; null for deletes and oversize skips. */
  blobSha256: string | null;
  bytes: number;
  /** Content exceeded the per-file cap: recorded, never applied. */
  oversize?: boolean;
}

export type TaskEvidence =
  | {
      kind: 'started';
      role: string;
      childSessionId: string;
      budget: TaskBudget;
      /** The approved-plan task this child is bound to (Session 11, additive) — the DAG join key. */
      planTaskId?: string;
      /** The bound task's definition sha at spawn (Session 11.5, additive) — completed-state identity. */
      planTaskSha?: string;
    }
  | {
      /**
       * A harness supervision observation about a running child (Session 11): stall, repeated
       * identical calls, budget pressure, or a task-scoped cancellation. Bounded (≤6 per task);
       * bookkeeping only — it annotates evidence and never replaces the task's own status.
       */
      kind: 'supervision';
      childSessionId: string;
      what: 'stall' | 'loop' | 'budget-pressure' | 'cancelled';
      detail?: string;
    }
  | {
      kind: 'ended';
      childSessionId: string;
      status: TaskStatus;
      steps: number;
      usage: Usage;
      /** sha256 of the child's full (untruncated) final report text. */
      resultSha256: string;
      durationMs: number;
    }
  | {
      /** An executor task's captured changes vs its base (V0.7) — the diff OUTLIVES the worktree. */
      kind: 'changes';
      childSessionId: string;
      baseOid: string;
      files: TaskChangeFile[];
      omittedCount?: number;
    }
  | { kind: 'worktree-created'; childSessionId: string; path: string; baseOid: string }
  | { kind: 'worktree-removed'; childSessionId: string; ok: boolean; detail?: string }
  | {
      /** apply_task_changes outcome (V0.7): which captured changes reached the parent workspace. */
      kind: 'applied';
      childSessionId: string;
      applied: string[];
      refused: { relPath: string; reason: string }[];
    }
  | {
      /**
       * The executor group's task-base checkpoint was created (Session 11.5) — creation
       * evidence for the resume-rebuilt prune list. Group-scoped (one per delegate call
       * with executors), so no childSessionId.
       */
      kind: 'base-checkpoint';
      ref: string;
      oid: string;
    };

/**
 * Structured plan-document facts reported by the update_plan tool; the runtime binds the callId.
 * For canonical (Session 11) writes, `sha256` carries the plan CONTENT sha — the approval-binding
 * identity — while `prevSha256` stays the raw-bytes blob pointer of the replaced file.
 */
export interface PlanEvidence {
  planId: string;
  sha256: string;
  bytes: number;
  prevSha256: string | null;
  status: 'draft' | 'approved' | 'superseded' | 'unknown';
  /** Structural summary of the written task graph (Session 11, additive) — lets the report and
   *  resume render the DAG purely from events, without reading the plan file. */
  graph?: { id: string; role: string; dependsOn: string[] }[];
}

export interface ToolContext {
  workspaceRoot: string;
  stateDir: string;
  /** Present when configuration narrowed policy; read by the engine and the search tool. */
  rules?: PolicyRules;
  /** Turn cancellation. A long-running tool must observe it and terminate its own work. */
  signal?: AbortSignal;
  /** Live output chunks for RENDERING only — never persisted per-chunk; evidence is the completed result. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Evidence channel for command lifecycle facts (spawn/termination); persisted by the runtime. */
  reportCommand?: (e: CommandEvidence) => void;
  /** Evidence channel for delegated-task lifecycle facts; persisted by the runtime under this call's id. */
  reportTask?: (e: TaskEvidence) => void;
  /** Evidence channel for plan-document writes; persisted by the runtime under this call's id (V0.7). */
  reportPlan?: (e: PlanEvidence) => void;
  /** Evidence channel for typed-check lifecycle facts (Session 12); persisted under this call's id. */
  reportCheck?: (e: CheckEvidence) => void;
  /**
   * The execution sandbox for this call. `enforced` tells the policy engine whether a genuine OS
   * boundary is active (a precondition for auto-running a command); a shell tool applies `wrap` to
   * its ExecSpec at spawn time. The runtime supplies an identity `wrap` for unsandboxed (approved)
   * calls, so tool code never branches on policy. Absent ⇒ no sandbox concept (e.g. file tools).
   */
  sandbox?: ExecSandbox;
}

/**
 * Per-call sandbox handle on ToolContext. Structurally minimal so `types.ts` stays logic-free;
 * the concrete backend lives in `src/sandbox/`. `ExecSpec` is intentionally referenced by shape
 * (Record) here to avoid a type cycle with the exec substrate.
 */
export interface ExecSandbox {
  mode: 'none' | 'windows-lowil';
  /** True only when a runtime probe confirmed the OS CAN confine sandboxed children (availability). */
  enforced: boolean;
  /** True when THIS call is actually running confined (an auto-run command inside the boundary). */
  active: boolean;
  /** Transform a managed-exec spec to run under the boundary; identity when this call is unsandboxed. */
  wrap(spec: ExecSpec): ExecSpec;
}

export interface ToolResult {
  ok: boolean;
  /** The exact string shown to the model (already truncated via the single truncation contract). */
  output: string;
  error?: string;
  exitCode?: number;
  durationMs: number;
  truncated: boolean;
  /** sha256 of the full untruncated output, present only when truncated. */
  fullOutputSha256?: string;
  /**
   * TRANSIENT (Session 11.5): the full pre-truncation output, attached ONLY by tools whose
   * output is otherwise unrecoverable (run_command's bounded capture, delegate group results
   * — never file reads, whose content lives on disk). The runtime spills it to a
   * content-addressed blob at the tool.completed choke point (skipped under any redaction)
   * and it is never persisted verbatim, never sent to the model.
   */
  fullOutput?: string;
  /** How a command actually ended (run_command only). Absent exitCode + 'timeout'/'aborted' = killed. */
  termination?: CommandTermination;
  /** Honest kill mechanics when a kill was attempted (best-effort tree kill + verification probe). */
  killDetail?: string;
}

/**
 * The policy-visible shape of one resolved typed check (Session 12). Structural on purpose: this
 * contracts file stays dependency-free, and the gate only needs what it must SHOW to the human
 * and BIND consent to. The richer `ResolvedCheck` in `checks/types.ts` is assignable to it.
 */
export interface ResolvedCheckFact {
  recipeId: string;
  kind: string;
  /** The exact command string that will be executed — and that the approval prompt displays. */
  command: string;
  timeoutMs: number;
  effects: { writesOutputs: boolean; network: boolean; workspaceAuthored: boolean };
}

export interface Tool<I = unknown> {
  name: string;
  /** Sent to the model. */
  description: string;
  /** Single source of truth for input validation; the JSON Schema sent to the model is derived from it. */
  schema: ZodType<I>;
  /**
   * Absolute paths this call will mutate, or null when side effects are undeclarable
   * (run_command) — a null plan can never be auto-classified `reversible`. Receives the same
   * context the policy gate uses so both resolve paths through one deterministic validator.
   */
  mutates(input: I, ctx: ToolContext): MutationPlan | null;
  /** Paths this call reads, so the policy gate can classify out-of-workspace / secret reads. */
  readsPaths?(input: I): string[];
  /** For a shell tool: the raw command string, so the policy gate labels and always-asks it. */
  command?(input: I): string;
  /**
   * Declares that this tool delegates work to bounded child sessions (V0.6; batched in V0.7 —
   * one call may spawn a PARALLEL GROUP, so the fact names every role in the group). A policy
   * FACT: decide() gates it in an explicit fail-closed branch BEFORE every other classification
   * (a command-less, mutation-less tool would otherwise auto-allow as observe — the S6 trap),
   * a tool may never declare both `delegates` and `command`, and the strictest member governs
   * the whole group. A throwing `delegates` is a deny, never an escape.
   */
  delegates?(input: I): { roles: readonly string[] };
  /**
   * Declares that this tool writes the harness-owned PLAN DOCUMENT (V0.7) — state-dir bytes the
   * file tools cannot reach. A policy FACT with its own explicit fail-closed branch: without it
   * a mutation-less, command-less tool writing persistent harness state would auto-classify as
   * observe (the S6 trap again). Never combinable with `command` or `delegates`.
   */
  planDoc?(input: I): { action: 'update' };
  /**
   * Declares that this tool runs HARNESS-RESOLVED project checks (Session 12). A policy FACT with
   * its own explicit fail-closed branch, for the same S6-trap reason as `delegates`/`planDoc`, and
   * for one more: a check spawns a real process, so it must never reach the observe fall-through.
   *
   * The distinction from `command` is the whole trust argument: a `command` string comes from
   * untrusted model text, while every `resolved.command` here was composed by the harness's recipe
   * table from the detected project. That is what makes per-command replay consent honest — the
   * consent binds a byte-identical string the harness will regenerate, not a label over model
   * output. Never combinable with `command`, `delegates`, or `planDoc`; a throw is a deny.
   *
   * MUST be pure: `decide()` is pure over (tool, input, ctx, grants), so the fact reads a project
   * snapshot captured earlier — never the filesystem.
   */
  check?(input: I): { resolved: readonly ResolvedCheckFact[] };
  /**
   * Optional DISPLAY-ONLY context lines for the approval prompt (V0.7.1) — e.g. plan-approval
   * state at an executor spawn. Folded into the request's `detail`, so the lines inherit the
   * prompt renderer's sanitization and line cap; NEVER consulted by policy (the decision is
   * already made when this runs), and a throw yields no lines rather than blocking the ask.
   */
  approvalContext?(input: I): string[];
  /** Optional hook to strip secret content from the result before it is persisted to the log. */
  redactForLog?(result: ToolResult, saltHex: string): ToolResult;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

// ── Policy ─────────────────────────────────────────────────────────────────────────────────
export interface PolicyDecision {
  classification: ActionClass;
  decision: 'allow' | 'ask' | 'deny';
  /** Matched rule id, e.g. 'path.outside-workspace', 'cmd.always-ask', 'mutation.snapshot-ok'. */
  rule: string;
  /** One human sentence, shown in the approval prompt and logged. */
  reason: string;
  /** Whether a pre-mutation snapshot must be captured before execution. */
  requiresSnapshot: boolean;
  /** True when the action will not be undoable (e.g. snapshot failed / file too large). */
  noUndo?: boolean;
  /** True when the model's read result must be redacted before persistence. */
  redactOutput?: boolean;
  /**
   * For a shell command: where it must run. 'sandbox' = an auto-run command that MUST be OS-confined
   * (the enforcement backing an auto-allow — never run unconfined). 'unsandboxed' = a human-approved
   * command that runs with full privilege (the user accepted the risk). Absent for non-command tools.
   */
  execBoundary?: 'sandbox' | 'unsandboxed';
  /**
   * For a typed check (Session 12): the replay-consent key of every resolved command in the call
   * — `sha256(recipeId + '\n' + command)`. A `session`-scope approval stores exactly these keys,
   * and a later call whose keys are ALL already consented allows without asking. Deliberately not
   * an `ActionClass` grant: consent binds the byte-identical harness-resolved command, so an
   * edited manifest that changes the command produces a new key and asks again.
   */
  checkReplayKeys?: string[];
}

// ── Approval ───────────────────────────────────────────────────────────────────────────────
export interface ApprovalRequest {
  callId: string;
  tool: string;
  classification: ActionClass;
  /**
   * 'command' = a shell command: the classification is only a best-effort LABEL, and the prompt
   * must say so. 'check' = a harness-resolved typed check (Session 12): the prompt shows every
   * resolved command verbatim and offers replay consent for those exact commands, NOT a
   * class-scoped session grant.
   */
  kind?: 'command' | 'check';
  /** One-line summary (command string or "edit src/x.ts"). */
  summary: string;
  /** Multi-line detail (edit preview, full command). */
  detail: string;
  reason: string;
  noUndoWarning?: boolean;
  /**
   * Present when this request was FORWARDED from a delegated child task (V0.7): the prompt
   * must attribute it to the task so the human knows which agent is asking and where it runs.
   */
  taskContext?: { childSessionId: string; role: string };
}
export interface ApprovalOutcome {
  decision: 'allow' | 'deny' | 'deny-stop';
  /** 'session' grants apply to future (tool, class) matches; run_command is never granted. */
  scope: 'once' | 'session';
  /** 'task-aborted' = a forwarded ask auto-denied because its task died first (V0.7). */
  source: 'user' | 'non-interactive' | 'dangerous-mode' | 'task-aborted';
}
export type Approver = (req: ApprovalRequest) => Promise<ApprovalOutcome>;

// ── Provider wire types (mirror the Anthropic shape; MockProvider needs no SDK) ─────────────
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface Usage {
  /** Uncached input tokens billed for the request (the API excludes cache reads from this). */
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache accounting (V0.5, additive): absent on providers/logs without caching. */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ProviderTurn {
  blocks: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

export interface Provider {
  readonly name: string;
  /**
   * `onText` receives assistant text deltas for live rendering; optional.
   * `signal` aborts an in-flight request (the caller detects an abort via `signal.aborted`
   * after a throw — never via provider-specific error classes).
   */
  complete(req: ProviderRequest, onText?: (delta: string) => void, signal?: AbortSignal): Promise<ProviderTurn>;
}

// ── Event log ──────────────────────────────────────────────────────────────────────────────
export const EVENT_SCHEMA_VERSION = 1;

export type MutationKind = 'create' | 'modify' | 'delete';

export interface RecordedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type EventBody =
  | {
      type: 'session.started';
      sessionId: string;
      workspaceRoot: string;
      model: string;
      mode: SessionMode;
      providerName: string;
      argv: string[];
      /** Present only on subagent child sessions (V0.6): who spawned this session, and as what. */
      lineage?: { parentSessionId: string; role: string };
    }
  | {
      type: 'session.resumed';
      priorSeq: number;
      orphanedCallIds: string[];
      unknownPostStateCallIds: string[];
    }
  // Session 10 (additive): inventorySha256 digests the sorted file SET independent of the
  // rendered text (the CODEBASE staleness basis); sha256 stays "exactly the text the model saw".
  | {
      type: 'workspace.mapped';
      fileCount: number;
      truncated: boolean;
      chars: number;
      sha256: string;
      inventorySha256?: string;
      indexedFiles?: number;
      indexState?: 'full' | 'partial';
    }
  | { type: 'user.message'; text: string }
  | {
      type: 'assistant.message';
      text: string;
      toolCalls: RecordedToolCall[];
      stopReason: StopReason;
      usage: Usage;
    }
  | { type: 'tool.requested'; callId: string; tool: string; input: unknown }
  | {
      type: 'policy.decision';
      callId: string;
      classification: ActionClass;
      decision: 'allow' | 'ask' | 'deny';
      rule: string;
      reason: string;
    }
  | {
      type: 'approval.resolved';
      callId: string;
      decision: 'allow' | 'deny' | 'deny-stop';
      scope: 'once' | 'session';
      /** 'task-aborted' (V0.7, additive): a forwarded child ask auto-denied because its task died first. */
      source: 'user' | 'non-interactive' | 'dangerous-mode' | 'task-aborted';
    }
  | {
      type: 'snapshot.created';
      callId: string;
      files: { path: string; beforeSha256: string | null; bytes: number }[];
    }
  | { type: 'snapshot.failed'; callId: string; path: string; error: string }
  | {
      type: 'file.mutated';
      callId: string;
      path: string;
      kind: MutationKind;
      beforeSha256: string | null;
      afterSha256: string | null;
      createdDirs: string[];
      /** Line diffstat for this mutation (V0.5, additive; absent for binary/huge/no-op changes). */
      linesAdded?: number;
      linesRemoved?: number;
    }
  | {
      type: 'tool.completed';
      callId: string;
      ok: boolean;
      outputPreview: string;
      exitCode?: number;
      durationMs: number;
      truncated: boolean;
      fullOutputSha256?: string;
      /**
       * The truncated-away bytes were preserved as the content-addressed blob
       * objects/<fullOutputSha256> (Session 11.5, additive). "Captured" output, honestly:
       * for a command whose live capture was itself capped, the blob holds the capped
       * stream, not everything the process printed.
       */
      fullOutputSaved?: true;
    }
  | {
      /** A shell command actually spawned (post-approval). Distinct from tool.requested: this is execution. */
      type: 'command.started';
      callId: string;
      pid: number;
      shell: string;
      cwd: string;
      timeoutMs: number;
      /** The execution boundary this command actually ran under (evidence of enforcement per command). */
      sandbox?: 'none' | 'windows-lowil';
    }
  | {
      /** How the spawned command ended. Killed commands (timeout/aborted) have exitCode null. */
      type: 'command.ended';
      callId: string;
      termination: CommandTermination;
      exitCode: number | null;
      durationMs: number;
      killDetail?: string;
      drainTimedOut?: boolean;
    }
  /**
   * Typed check lifecycle (Session 12, additive). `check.started` marks a REAL spawn — the same
   * meaning `command.started` carries, so crash replay and the acceptance work-boundary treat
   * them alike. A kind that could not run records only `check.completed` with status
   * 'unsupported': nothing was spawned, so claiming a start would be false evidence.
   */
  | {
      type: 'check.started';
      callId: string;
      check: CheckKind;
      recipeId: string;
      /** The exact harness-resolved command string — what the human approved and what ran. */
      command: string;
      cwd: string;
      timeoutMs: number;
      /** The plan task this run was declared against; a reporting LABEL, never the gate itself. */
      planTaskId?: string;
      scopePaths?: string[];
    }
  | {
      type: 'check.completed';
      callId: string;
      check: CheckKind;
      recipeId: string;
      status: CheckStatus;
      exitCode: number | null;
      termination?: CommandTermination;
      durationMs: number;
      summary: string;
      /** Named signals — classification stays derivable from the log after the output is gone. */
      signals?: string[];
      findings?: CheckFinding[];
      planTaskId?: string;
      scopePaths?: string[];
    }
  | {
      type: 'undo.applied';
      target: 'last' | 'all';
      restored: { path: string; toSha256: string | null }[];
      refused: { path: string; reason: string }[];
    }
  | {
      /** The user aborted the turn: during the model call ('model') or the tool phase ('tools'). */
      type: 'turn.aborted';
      phase: 'model' | 'tools';
    }
  | {
      /** How the workspace-trust gate was satisfied for this run (consent provenance). */
      type: 'trust.verified';
      source: 'store' | 'prompt-remember' | 'prompt-once' | 'flag';
    }
  | {
      /** Which config files were loaded (post-trust) and their content hashes. */
      type: 'config.loaded';
      sources: { path: string; sha256: string }[];
    }
  | {
      /**
       * The active execution sandbox for this session, established by a real runtime probe.
       * `enforced` is true only when the OS is actually confining sandboxed children — never
       * assumed from the platform. `confines`/`doesNotConfine` are the honesty surface.
       */
      type: 'sandbox.status';
      mode: 'none' | 'windows-lowil';
      enforced: boolean;
      summary: string;
      confines: string[];
      doesNotConfine: string[];
      detail: string;
    }
  | {
      /**
       * Older tool outputs were elided from the WIRE history to stay inside the context budget
       * (V0.5). The event log and the persisted history are untouched — this records exactly
       * which outputs the model can no longer see verbatim. Additive v1 event.
       */
      type: 'context.compacted';
      elidedCount: number;
      newlyElidedCallIds: string[];
      rawChars: number;
      sentChars: number;
      exhausted: boolean;
    }
  | {
      /**
       * The probed git context for this session (read-only probe at session start; V0.5).
       * Every degrade path is explicit — git absent, not a repository, probe failed/timed out —
       * with nulls, never guesses. Additive v1 event.
       */
      type: 'git.context';
      isRepo: boolean;
      gitVersion: string | null;
      repoRoot: string | null;
      workspaceIsRepoRoot: boolean;
      branch: string | null;
      detached: boolean;
      unborn: boolean;
      head: string | null;
      upstream: string | null;
      ahead: number | null;
      behind: number | null;
      dirtyCount: number | null;
      untrackedCount: number | null;
      probeFailed: boolean;
      detail: string;
    }
  | {
      /**
       * A user-commanded recovery checkpoint was captured to a hidden ref (V0.5). The user's
       * index/HEAD/worktree are untouched; the ref keeps the objects alive until pruned.
       */
      type: 'git.checkpoint';
      ref: string;
      oid: string;
      label: string | null;
      /** Files differing between HEAD (or the empty tree when unborn) and the checkpoint. */
      filesChanged: number;
    }
  | {
      /**
       * A user-commanded checkpoint restore ran (V0.5). The batch shares one synthetic callId
       * with its snapshot.created + file.mutated events, so /undo reverts it as a unit.
       */
      type: 'git.restore';
      ref: string;
      oid: string;
      restored: string[];
      refused: { path: string; reason: string }[];
    }
  | {
      /**
       * A deliberate user-commanded commit (/commit, `agent commit`) succeeded (V0.5).
       * Consent provenance: this event exists only for flows the user explicitly invoked.
       */
      type: 'git.commit';
      oid: string;
      subject: string;
      /** Repo-relative files actually in the commit (git diff-tree truth). */
      files: string[];
      scope: 'session' | 'all';
      trailer: boolean;
    }
  | {
      /**
       * This session's task-base checkpoint refs were deleted at session end (V0.7.1). The
       * base oids stay recorded in task.changes/worktree events and the captured blobs are the
       * durable integration record — the ref was only a live recovery point while the session
       * ran. A crash before this event leaks the refs to manual `agent checkpoint prune`.
       */
      type: 'git.checkpoint.pruned';
      kind: 'task-base';
      refs: string[];
      failed: string[];
    }
  | {
      /**
       * Which project-memory documents this session loaded at assembly, with identity facts
       * (V0.6). Provenance for exactly what durable context reached the system prompt; memory
       * failures degrade to a status here instead of blocking the session.
       */
      type: 'memory.loaded';
      files: {
        name: string;
        sha256: string | null;
        bytes: number;
        truncated: boolean;
        status: 'ok' | 'missing' | 'oversize' | 'unreadable';
      }[];
    }
  | {
      /**
       * A delegated subagent task began executing (V0.6). callId is bound by the runtime (the
       * delegate tool cannot forge another call's evidence); childSessionId names the child's
       * own event log — the complete parent↔child lineage join.
       */
      type: 'task.started';
      callId: string;
      role: string;
      childSessionId: string;
      budget: TaskBudget;
      /** The approved-plan task this child executes (Session 11, additive) — the DAG join key. */
      planTaskId?: string;
      /**
       * The bound plan task's DEFINITION sha at spawn time (Session 11.5, additive):
       * sha256(canonicalJson(task, dependsOn sorted)). Lets the fold attach 'completed' to
       * the definition that actually ran — an amendment changing a completed task's
       * definition re-opens it. Absent on pre-11.5 logs: completed then stays sticky to the
       * id (the conservative legacy reading).
       */
      planTaskSha?: string;
    }
  | {
      /**
       * A harness supervision observation about a running child (Session 11, additive): stall,
       * repeated identical tool calls, budget pressure, or task-scoped cancellation. Bounded
       * per task; evidence of the supervisor's bounded interventions, never a status of record
       * (task.ended carries the status).
       */
      type: 'task.supervision';
      callId: string;
      childSessionId: string;
      kind: 'stall' | 'loop' | 'budget-pressure' | 'cancelled';
      detail?: string;
    }
  | {
      /**
       * The task-base checkpoint captured for an executor group (Session 11.5, additive).
       * The ref is a live recovery point only while the session runs; recording CREATION lets
       * a resumed session rebuild its prune list, so a crash no longer leaks the refs forever.
       * Crash-covered except the creation instant: a kill between update-ref and this append
       * still leaks one ref to the `agent checkpoint prune` backstop. Deliberately NOT a
       * `git.checkpoint` event — that type is user-commanded consent provenance, and an old
       * reader misattributing harness plumbing to the user would be worse than skipping an
       * unknown type.
       */
      type: 'task.base-checkpoint';
      callId: string;
      ref: string;
      oid: string;
    }
  | {
      /** A delegated subagent task finished (V0.6). Usage is the CHILD's spend, recorded once
       *  here for the parent's view — it is NOT included in this session's own usage totals. */
      type: 'task.ended';
      callId: string;
      childSessionId: string;
      status: TaskStatus;
      steps: number;
      usage: Usage;
      resultSha256: string;
      durationMs: number;
    }
  | {
      /**
       * An executor task's captured file changes vs its checkpoint base (V0.7). The after-bytes
       * live as content-addressed blobs, so this evidence — not the removed worktree — is the
       * durable record; apply_task_changes replays from exactly this.
       */
      type: 'task.changes';
      callId: string;
      childSessionId: string;
      baseOid: string;
      files: TaskChangeFile[];
      omittedCount?: number;
    }
  | {
      /** apply_task_changes outcome (V0.7): per-file applied/refused, alongside the ordinary
       *  snapshot/file.mutated evidence the write path records. */
      type: 'task.applied';
      callId: string;
      childSessionId: string;
      applied: string[];
      refused: { relPath: string; reason: string }[];
    }
  | {
      /** A task worktree came into existence (V0.7): ownership evidence for the sweep story. */
      type: 'worktree.created';
      callId: string;
      childSessionId: string;
      path: string;
      baseOid: string;
    }
  | {
      /** A task worktree was removed — or could not be (ok:false ⇒ the startup sweep owns it). */
      type: 'worktree.removed';
      callId: string;
      childSessionId: string;
      ok: boolean;
      detail?: string;
    }
  | {
      /**
       * The plan document was rewritten (V0.7). Model writes flow through the policy-gated
       * update_plan tool (callId bound by the runtime); prior bytes are archived as the
       * `prevSha256` blob, so plan history is fully reviewable.
       */
      type: 'plan.updated';
      callId: string;
      planId: string;
      sha256: string;
      bytes: number;
      prevSha256: string | null;
      status: 'draft' | 'approved' | 'superseded' | 'unknown';
      /** Structural task-graph summary for canonical writes (Session 11, additive). */
      graph?: { id: string; role: string; dependsOn: string[] }[];
    }
  | {
      /**
       * How this turn's complexity was routed (Session 11, additive): into plan mode or the
       * direct path, by the model's judgment or a user sigil (@plan / @direct). Observability
       * for proportionate routing — absence of any plan events IS the evidence of a direct
       * turn, so this is recorded when planning begins or a sigil forces a path.
       */
      type: 'plan.route';
      mode: 'plan' | 'direct';
      source: 'user-sigil' | 'model';
      reason?: string;
    }
  | {
      /**
       * The USER approved the plan (/plan approve) — the execution consent record (V0.7).
       * Binds the exact approved bytes: divergence of the file's later sha from this one is
       * surfaced on every injection and executor-spawn prompt, never hidden.
       */
      type: 'plan.approved';
      planId: string;
      sha256: string;
    }
  | {
      /**
       * The USER discarded the plan (/plan discard): status → superseded (V0.7).
       * reason 'accepted' (Session 11.5, additive) marks the /accept retirement of a fully
       * executed plan — same mechanics, different provenance.
       */
      type: 'plan.discarded';
      planId: string;
      reason?: 'accepted';
    }
  | {
      /**
       * The USER accepted the session result (/accept, Session 11.5) — the explicit completion
       * boundary. `complete` records whether the acceptance was clean (all plan tasks
       * completed/parent-owned, every applicable capture integrated) or a confirmed partial
       * acceptance; `unfinished` preserves the honest blocker list for the handoff. Cleanup
       * (task-base ref pruning, plan retirement) keys off this consent — never off mere
       * session end.
       */
      type: 'session.accepted';
      complete: boolean;
      summary: string;
      unfinished?: string[];
    }
  | {
      /**
       * The end-of-session narrative provider call (V0.6). This call bypasses runTurn (its
       * instruction must never replay into a resumed conversation), so its usage is recorded
       * HERE — evidence that the call happened, what it cost, and whether it succeeded.
       */
      type: 'memory.narrative';
      status: 'ok' | 'failed' | 'skipped';
      durationMs: number;
      usage?: Usage;
      detail?: string;
    }
  | {
      /** A project-memory document write outcome at session end (V0.6). Failures are honest, never silent. */
      type: 'memory.updated';
      doc: 'journal' | 'codebase';
      status: 'written' | 'skipped' | 'failed';
      sha256?: string;
      bytes?: number;
      detail?: string;
    }
  | {
      type: 'session.ended';
      /** 'aborted' (Ctrl+C) and 'budget' (subagent caps) are additive V0.6 values. */
      reason: 'completed' | 'user-quit' | 'error' | 'max-steps' | 'aborted' | 'budget';
      error?: string;
    };

export type SessionEvent = { v: number; seq: number; ts: string } & EventBody;
export type EventType = EventBody['type'];
