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
  /** How a command actually ended (run_command only). Absent exitCode + 'timeout'/'aborted' = killed. */
  termination?: CommandTermination;
  /** Honest kill mechanics when a kill was attempted (best-effort tree kill + verification probe). */
  killDetail?: string;
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
}

// ── Approval ───────────────────────────────────────────────────────────────────────────────
export interface ApprovalRequest {
  callId: string;
  tool: string;
  classification: ActionClass;
  /** 'command' = a shell command: the classification is only a best-effort LABEL, and the prompt must say so. */
  kind?: 'command';
  /** One-line summary (command string or "edit src/x.ts"). */
  summary: string;
  /** Multi-line detail (edit preview, full command). */
  detail: string;
  reason: string;
  noUndoWarning?: boolean;
}
export interface ApprovalOutcome {
  decision: 'allow' | 'deny' | 'deny-stop';
  /** 'session' grants apply to future (tool, class) matches; run_command is never granted. */
  scope: 'once' | 'session';
  source: 'user' | 'non-interactive' | 'dangerous-mode';
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
  inputTokens: number;
  outputTokens: number;
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
    }
  | {
      type: 'session.resumed';
      priorSeq: number;
      orphanedCallIds: string[];
      unknownPostStateCallIds: string[];
    }
  | { type: 'workspace.mapped'; fileCount: number; truncated: boolean; chars: number; sha256: string }
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
      source: 'user' | 'non-interactive' | 'dangerous-mode';
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
  | { type: 'session.ended'; reason: 'completed' | 'user-quit' | 'error' | 'max-steps'; error?: string };

export type SessionEvent = { v: number; seq: number; ts: string } & EventBody;
export type EventType = EventBody['type'];
