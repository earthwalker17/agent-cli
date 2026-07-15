/**
 * All shared plain-data contracts for Agent CLI. No logic lives here — this is the single
 * place the kernel's interfaces are defined so modules depend on shapes, not on each other.
 */
import type { ZodType } from 'zod';

// ── Action taxonomy ────────────────────────────────────────────────────────────────────────
// Consequence classes from the constitution's safety policy. This is the "approval" axis only;
// V0.1 has no OS "sandbox" axis (documented honestly).
export type ActionClass = 'observe' | 'reversible' | 'external' | 'destructive' | 'sensitive';

export type SessionMode = 'interactive' | 'non-interactive';

// ── Tools ──────────────────────────────────────────────────────────────────────────────────
/** Absolute paths a tool will change. Declarable ⇒ snapshottable ⇒ reversible. */
export interface MutationPlan {
  paths: string[];
}

export interface ToolContext {
  workspaceRoot: string;
  stateDir: string;
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
}

// ── Approval ───────────────────────────────────────────────────────────────────────────────
export interface ApprovalRequest {
  callId: string;
  tool: string;
  classification: ActionClass;
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
  | { type: 'session.ended'; reason: 'completed' | 'user-quit' | 'error' | 'max-steps'; error?: string };

export type SessionEvent = { v: number; seq: number; ts: string } & EventBody;
export type EventType = EventBody['type'];
