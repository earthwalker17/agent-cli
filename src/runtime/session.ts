import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalRequest,
  ChatMessage,
  CommandEvidence,
  ContentBlock,
  PolicyDecision,
  PolicyRules,
  Provider,
  ProviderRequest,
  SessionEvent,
  SessionMode,
  StopReason,
  Tool,
  ToolContext,
  ToolResult,
} from '../types.js';
import { EventLog } from '../store/event-log.js';
import { SnapshotStore, type CapturedFile } from '../store/snapshots.js';
import { decide, Grants, escalateOnSnapshotFailure } from '../policy/engine.js';
import { TOOLS, toToolSchema } from '../tools/index.js';
import { sha256, redactSecret } from '../shared/hash.js';
import { isInside } from '../shared/pathutil.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { systemIdGen, type IdGen } from '../shared/ids.js';
import type { ProjectLayout } from '../store/layout.js';
import type { Approver, ExecSandbox } from '../types.js';
import type { SandboxBackend, EnforcementFacts } from '../sandbox/index.js';
import type { GitFacts } from '../git/types.js';
import type { ExecSpec } from '../exec/run.js';
import { elideHistory, type ElisionOptions } from './elision.js';

export interface Session {
  id: string;
  workspaceRoot: string;
  stateDir: string;
  model: string;
  mode: SessionMode;
  maxTokens: number;
  maxSteps: number;
  system: string;
  provider: Provider;
  approver: Approver;
  tools: Tool[];
  log: EventLog;
  snapshots: SnapshotStore;
  grants: Grants;
  saltHex: string;
  messages: ChatMessage[];
  onText?: (delta: string) => void;
  /** Live command output for rendering (callId-scoped). Render-only; evidence is the event log. */
  onCommandOutput?: (callId: string, chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Narrowing-only policy additions from config; passed to every tool/policy context. */
  rules?: PolicyRules;
  /** The session's execution sandbox backend + its probed enforcement facts (both or neither). */
  sandbox?: SandboxBackend;
  sandboxFacts?: EnforcementFacts;
  /** The probed git context (V0.5); absent when the interface did not run the probe. */
  gitFacts?: GitFacts;
  /** Wire-history elision thresholds (V0.5); tests narrow them, production uses defaults. */
  contextBudget?: ElisionOptions;
  /** callIds elided from the wire in this process (in-memory; drives context.compacted events). */
  elidedCallIds?: Set<string>;
  clock: Clock;
}

export interface TurnResult {
  finalText: string;
  stopReason: StopReason;
  denials: number;
  steps: number;
  /** True when the user chose "deny & stop", the turn was aborted, or the step budget was exhausted. */
  stopped: boolean;
  /** True when the turn ended because the caller's AbortSignal fired (e.g. Ctrl+C in the REPL). */
  aborted: boolean;
}

export interface StartOptions {
  workspaceRoot: string;
  layout: ProjectLayout;
  model: string;
  mode: SessionMode;
  provider: Provider;
  approver: Approver;
  system?: string;
  maxSteps?: number;
  maxTokens?: number;
  onText?: (delta: string) => void;
  onCommandOutput?: (callId: string, chunk: string, stream: 'stdout' | 'stderr') => void;
  argv?: string[];
  tools?: Tool[];
  rules?: PolicyRules;
  sandbox?: SandboxBackend;
  sandboxFacts?: EnforcementFacts;
  gitFacts?: GitFacts;
  contextBudget?: ElisionOptions;
  clock?: Clock;
  idGen?: IdGen;
  saltHex: string;
}

/** Open a fresh session: create the log, acquire the lock, and record `session.started`. */
export function startSession(opts: StartOptions): Session {
  const clock = opts.clock ?? systemClock;
  const idGen = opts.idGen ?? systemIdGen(clock);
  const id = idGen.sessionId();
  const log = EventLog.open({ file: opts.layout.sessionFile(id), lockFile: opts.layout.lockFile(id), clock });
  const session = buildSession(id, opts, log, clock);
  log.append({
    type: 'session.started',
    sessionId: id,
    workspaceRoot: opts.workspaceRoot,
    model: opts.model,
    mode: opts.mode,
    providerName: opts.provider.name,
    argv: opts.argv ?? [],
  });
  return session;
}

function buildSession(id: string, opts: StartOptions, log: EventLog, clock: Clock): Session {
  const base: Session = {
    id,
    workspaceRoot: opts.workspaceRoot,
    stateDir: opts.layout.projectDir,
    model: opts.model,
    mode: opts.mode,
    maxTokens: opts.maxTokens ?? 16_000,
    maxSteps: opts.maxSteps ?? 20,
    system: opts.system ?? '',
    provider: opts.provider,
    approver: opts.approver,
    tools: opts.tools ?? TOOLS,
    log,
    snapshots: new SnapshotStore(opts.layout.objectsDir),
    grants: new Grants(),
    saltHex: opts.saltHex,
    messages: [],
    clock,
  };
  if (opts.onText) base.onText = opts.onText;
  if (opts.onCommandOutput) base.onCommandOutput = opts.onCommandOutput;
  if (opts.rules) base.rules = opts.rules;
  if (opts.sandbox) base.sandbox = opts.sandbox;
  if (opts.sandboxFacts) base.sandboxFacts = opts.sandboxFacts;
  if (opts.gitFacts) base.gitFacts = opts.gitFacts;
  if (opts.contextBudget) base.contextBudget = opts.contextBudget;
  return base;
}

/** Record the probed git context for this session (explicit degrades, never guesses). */
export function recordGitContext(session: Session, facts: GitFacts): void {
  session.log.append({
    type: 'git.context',
    isRepo: facts.isRepo,
    gitVersion: facts.gitVersion,
    repoRoot: facts.repoRoot,
    workspaceIsRepoRoot: facts.workspaceIsRepoRoot,
    branch: facts.branch,
    detached: facts.detached,
    unborn: facts.unborn,
    head: facts.head,
    upstream: facts.upstream,
    ahead: facts.ahead,
    behind: facts.behind,
    dirtyCount: facts.dirtyCount,
    untrackedCount: facts.untrackedCount,
    probeFailed: facts.probeFailed,
    detail: facts.detail,
  });
}

/** Record the active execution sandbox for this session (consent-provenance style evidence). */
export function recordSandboxStatus(session: Session, facts: EnforcementFacts): void {
  session.log.append({
    type: 'sandbox.status',
    mode: facts.mode,
    enforced: facts.enforced,
    summary: facts.summary,
    confines: facts.confines,
    doesNotConfine: facts.doesNotConfine,
    detail: facts.detail,
  });
}

export type ResumeOptions = Omit<StartOptions, 'idGen' | 'argv'> & { sessionId: string };

export interface ReconstructResult {
  messages: ChatMessage[];
  orphanedCallIds: string[];
  unknownPostStateCallIds: string[];
}

/**
 * Rebuild the provider conversation from a committed event log. Faithful for every tool result
 * except redacted secret reads (which by design are not persisted and cannot be replayed).
 * Crash recovery reconciles against `file.mutated`/postHash so a completed edit whose
 * `tool.completed` was lost in a truncated tail is recognised as APPLIED, not "interrupted".
 */
export function reconstruct(events: readonly SessionEvent[], workspaceRoot: string): ReconstructResult {
  const completedBy = new Map<string, Extract<SessionEvent, { type: 'tool.completed' }>>();
  const mutatedBy = new Map<string, Extract<SessionEvent, { type: 'file.mutated' }>[]>();
  const snapBy = new Set<string>();
  const commandStartedBy = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool.completed') completedBy.set(e.callId, e);
    else if (e.type === 'file.mutated') (mutatedBy.get(e.callId) ?? mutatedBy.set(e.callId, []).get(e.callId)!).push(e);
    else if (e.type === 'snapshot.created') snapBy.add(e.callId);
    else if (e.type === 'command.started') commandStartedBy.add(e.callId);
  }

  const orphanedCallIds: string[] = [];
  const unknownPostStateCallIds: string[] = [];
  const diskMatches = (m: Extract<SessionEvent, { type: 'file.mutated' }>): boolean => {
    const cur = fs.existsSync(m.path) ? sha256(fs.readFileSync(m.path)) : null;
    return cur === m.afterSha256;
  };
  const resultFor = (id: string): ContentBlock => {
    const c = completedBy.get(id);
    if (c) return toolResultBlock(id, c.outputPreview, !c.ok);
    const muts = mutatedBy.get(id);
    if (muts && muts.length > 0) {
      if (muts.every(diskMatches)) return toolResultBlock(id, 'change applied (recovered after an interruption)', false);
      unknownPostStateCallIds.push(id);
      return toolResultBlock(id, 'interrupted after writing; disk state could not be verified', true);
    }
    if (snapBy.has(id)) {
      unknownPostStateCallIds.push(id);
      return toolResultBlock(id, 'interrupted after snapshot but before writing; disk state unverified', true);
    }
    orphanedCallIds.push(id);
    if (commandStartedBy.has(id)) {
      // The command had SPAWNED (command.started recorded) — its side effects are unknown and
      // the process may even have kept running past the crash.
      return toolResultBlock(id, 'interrupted: the command was executing when the session crashed; its effects are unknown', true);
    }
    return toolResultBlock(id, 'interrupted by session crash', true);
  };

  const messages: ChatMessage[] = [];
  for (const e of events) {
    if (e.type === 'user.message') {
      messages.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    } else if (e.type === 'assistant.message') {
      const content: ContentBlock[] = [];
      if (e.text) content.push({ type: 'text', text: e.text });
      for (const tc of e.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      messages.push({ role: 'assistant', content });
      if (e.toolCalls.length > 0) {
        messages.push({ role: 'user', content: e.toolCalls.map((tc) => resultFor(tc.id)) });
      }
    }
  }
  return { messages, orphanedCallIds, unknownPostStateCallIds };
}

/** Reopen an existing session: reconstruct the conversation and record `session.resumed`. */
export function resumeSession(opts: ResumeOptions): Session {
  const clock = opts.clock ?? systemClock;
  const log = EventLog.open({ file: opts.layout.sessionFile(opts.sessionId), lockFile: opts.layout.lockFile(opts.sessionId), clock });
  const rebuilt = reconstruct(log.events, opts.workspaceRoot);
  const priorSeq = log.events.length > 0 ? log.events[log.events.length - 1]!.seq : 0;
  const session = buildSession(opts.sessionId, { ...opts, argv: [] }, log, clock);
  session.messages = rebuilt.messages;
  log.append({
    type: 'session.resumed',
    priorSeq,
    orphanedCallIds: rebuilt.orphanedCallIds,
    unknownPostStateCallIds: rebuilt.unknownPostStateCallIds,
  });
  return session;
}

/** Record the workspace map the model was shown (evidence of exactly what it saw). */
export function recordWorkspaceMap(
  session: Session,
  map: { fileCount: number; truncated: boolean; text: string; sha256: string },
): void {
  session.log.append({
    type: 'workspace.mapped',
    fileCount: map.fileCount,
    truncated: map.truncated,
    chars: map.text.length,
    sha256: map.sha256,
  });
}

/** Record `session.ended` and release the lock. Safe to call once per session. */
export function endSession(session: Session, reason: 'completed' | 'user-quit' | 'error' | 'max-steps', error?: string): void {
  session.log.append(error !== undefined ? { type: 'session.ended', reason, error } : { type: 'session.ended', reason });
  session.log.close();
}

export interface TurnOptions {
  /** Abort the turn: the model stream is cancelled and pending tool calls are skipped. */
  signal?: AbortSignal;
}

/**
 * Run the agent loop for one user message until the model stops calling tools (or the step budget
 * is spent). Every tool call is gated through the single policy engine, mutations are snapshotted,
 * and structured evidence is appended to the log.
 */
export async function runTurn(session: Session, userText: string, opts: TurnOptions = {}): Promise<TurnResult> {
  const signal = opts.signal;
  session.log.append({ type: 'user.message', text: userText });
  session.messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });

  const ctx: ToolContext = {
    workspaceRoot: session.workspaceRoot,
    stateDir: session.stateDir,
    ...(session.rules ? { rules: session.rules } : {}),
    // Availability-only sandbox view for the policy decision (identity wrap, never active here):
    // the engine reads `enforced` to gate command auto-run. The per-call enforcing wrap is built
    // in runExecution once the boundary is known.
    ...(session.sandboxFacts ? { sandbox: availabilitySandbox(session.sandboxFacts) } : {}),
  };
  let denials = 0;
  let steps = 0;
  let finalText = '';
  let lastStop: StopReason = 'end_turn';

  const abortedResult = (phase: 'model' | 'tools', stepsRun: number): TurnResult => {
    session.log.append({ type: 'turn.aborted', phase });
    return { finalText, stopReason: lastStop, denials, steps: stepsRun, stopped: true, aborted: true };
  };

  for (; steps < session.maxSteps; steps++) {
    if (signal?.aborted) return abortedResult('model', steps);
    // Wire-side elision: pure and recomputed per request over the untouched session.messages.
    // The event records exactly which outputs the model can no longer see (only when the set grows).
    const elision = elideHistory(session.messages, session.contextBudget);
    const prevElided = session.elidedCallIds ?? new Set<string>();
    if (elision.elidedCallIds.length > prevElided.size) {
      const newly = elision.elidedCallIds.filter((id) => !prevElided.has(id));
      session.elidedCallIds = new Set(elision.elidedCallIds);
      session.log.append({
        type: 'context.compacted',
        elidedCount: elision.elidedCallIds.length,
        newlyElidedCallIds: newly,
        rawChars: elision.rawChars,
        sentChars: elision.sentChars,
        exhausted: elision.exhausted,
      });
    }
    const req: ProviderRequest = {
      model: session.model,
      system: session.system,
      messages: elision.messages,
      tools: session.tools.map(toToolSchema),
      maxTokens: session.maxTokens,
    };
    let turn;
    try {
      turn = await session.provider.complete(req, session.onText, signal);
    } catch (err) {
      // Abort is detected via the signal, never via provider-specific error classes. Nothing has
      // been appended for this step, so the log and message history end at the last complete
      // exchange (a trailing user message; the wire coalesces consecutive user messages).
      if (signal?.aborted) return abortedResult('model', steps);
      throw err;
    }
    lastStop = turn.stopReason;

    const text = turn.blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text) finalText = text;
    const toolUses = turn.blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');

    session.log.append({
      type: 'assistant.message',
      text,
      toolCalls: toolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })),
      stopReason: turn.stopReason,
      usage: turn.usage,
    });
    session.messages.push({ role: 'assistant', content: turn.blocks });

    if (turn.stopReason !== 'tool_use' || toolUses.length === 0) break;

    // Pre-gate: once the turn is aborted or the user chose deny-&-stop, NO further call may
    // execute — including auto-allowed in-workspace writes, which never reach an approver.
    const toolResults: ContentBlock[] = [];
    let stopRequested = false;
    let sawAbort = false;
    for (const tu of toolUses) {
      if (signal?.aborted || stopRequested) {
        sawAbort = sawAbort || (signal?.aborted ?? false);
        toolResults.push(
          recordSkippedCall(session, tu, signal?.aborted ? 'interrupted by user' : 'skipped: session stopped by user'),
        );
        continue;
      }
      const r = await executeCall(session, ctx, tu, signal);
      toolResults.push(r.toolResult);
      if (r.denied) denials++;
      if (r.stop) stopRequested = true;
    }
    session.messages.push({ role: 'user', content: toolResults });
    if (sawAbort || signal?.aborted) return abortedResult('tools', steps + 1);
    if (stopRequested) return { finalText, stopReason: lastStop, denials, steps: steps + 1, stopped: true, aborted: false };
  }

  const stopped = steps >= session.maxSteps;
  return { finalText, stopReason: lastStop, denials, steps, stopped, aborted: false };
}

/** Record a tool call that was never executed (turn aborted / session stopped) with a terminal result. */
function recordSkippedCall(
  session: Session,
  tu: Extract<ContentBlock, { type: 'tool_use' }>,
  message: string,
): ContentBlock {
  session.log.append({ type: 'tool.requested', callId: tu.id, tool: tu.name, input: tu.input });
  session.log.append({ type: 'tool.completed', callId: tu.id, ok: false, outputPreview: message, durationMs: 0, truncated: false });
  return toolResultBlock(tu.id, message, true);
}

/**
 * Repair the in-memory conversation after a turn threw mid-loop: if the last message is an
 * assistant message whose tool_use blocks were never answered, synthesize their tool_result
 * blocks so the next provider request stays API-valid (an unanswered tool_use is a 400 on every
 * later turn). Calls that DID complete before the throw are answered from their recorded
 * `tool.completed` (mirroring what a resume would replay); the rest get an error result.
 * Returns true when a repair was applied.
 */
export function repairDanglingToolUses(session: Session): boolean {
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  const uses = last.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
  if (uses.length === 0) return false;

  const completedBy = new Map<string, Extract<SessionEvent, { type: 'tool.completed' }>>();
  for (const e of session.log.events) {
    if (e.type === 'tool.completed') completedBy.set(e.callId, e);
  }

  const results = uses.map((u) => {
    const done = completedBy.get(u.id);
    if (done) return toolResultBlock(u.id, done.outputPreview, !done.ok);
    session.log.append({
      type: 'tool.completed',
      callId: u.id,
      ok: false,
      outputPreview: 'interrupted: the turn failed before this call ran',
      durationMs: 0,
      truncated: false,
    });
    return toolResultBlock(u.id, 'interrupted: the turn failed before this call ran', true);
  });
  session.messages.push({ role: 'user', content: results });
  return true;
}

interface CallOutcome {
  toolResult: ContentBlock;
  denied: boolean;
  stop: boolean;
}

function toolResultBlock(toolUseId: string, content: string, isError: boolean): ContentBlock {
  return isError
    ? { type: 'tool_result', toolUseId, content, isError: true }
    : { type: 'tool_result', toolUseId, content };
}

/** Gate, (snapshot,) execute, and record one tool call. */
async function executeCall(
  session: Session,
  ctx: ToolContext,
  tu: Extract<ContentBlock, { type: 'tool_use' }>,
  signal?: AbortSignal,
): Promise<CallOutcome> {
  const callId = tu.id;
  const tool = session.tools.find((t) => t.name === tu.name);
  session.log.append({ type: 'tool.requested', callId, tool: tu.name, input: tu.input });

  if (!tool) {
    session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: '', durationMs: 0, truncated: false });
    return { toolResult: toolResultBlock(callId, `unknown tool: ${tu.name}`, true), denied: false, stop: false };
  }

  const parsed = tool.schema.safeParse(tu.input);
  if (!parsed.success) {
    session.log.append({ type: 'policy.decision', callId, classification: 'observe', decision: 'deny', rule: 'input.invalid', reason: 'input failed schema validation' });
    const msg = `invalid input: ${parsed.error.message}`;
    session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: msg, durationMs: 0, truncated: false });
    return { toolResult: toolResultBlock(callId, msg, true), denied: false, stop: false };
  }
  const input = parsed.data;

  const decision = decide(tool, input, ctx, session.grants);
  session.log.append({
    type: 'policy.decision',
    callId,
    classification: decision.classification,
    decision: decision.decision,
    rule: decision.rule,
    reason: decision.reason,
  });

  if (decision.decision === 'deny') {
    const msg = `denied by policy (${decision.rule}): ${decision.reason}`;
    session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: msg, durationMs: 0, truncated: false });
    return { toolResult: toolResultBlock(callId, msg, true), denied: true, stop: false };
  }

  if (decision.decision === 'ask') {
    const req = buildApprovalRequest(tool, input, decision, callId);
    const outcome = await session.approver(req);
    session.log.append({ type: 'approval.resolved', callId, decision: outcome.decision, scope: outcome.scope, source: outcome.source });
    if (outcome.decision !== 'allow') {
      session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: 'denied by user', durationMs: 0, truncated: false });
      return { toolResult: toolResultBlock(callId, 'denied by user', true), denied: true, stop: outcome.decision === 'deny-stop' };
    }
    if (outcome.scope === 'session') session.grants.add(tool.name, decision.classification);
  }

  return await runExecution(session, ctx, tool, input, decision, callId, signal);
}

/** A sandbox handle that only reports availability — identity wrap, never active. Used by decide(). */
function availabilitySandbox(facts: EnforcementFacts): ExecSandbox {
  return { mode: facts.mode, enforced: facts.enforced, active: false, wrap: (s) => s };
}

/**
 * The per-call sandbox handed to a shell tool. When policy chose `execBoundary: 'sandbox'` (an
 * auto-run command) it is ACTIVE and wraps the spec through the enforcing backend; otherwise it is
 * an identity pass-through (an approved command the user accepted at full privilege).
 */
function callSandbox(session: Session, boundary: 'sandbox' | 'unsandboxed' | undefined): ExecSandbox | undefined {
  if (!session.sandboxFacts) return undefined;
  const active = boundary === 'sandbox';
  const backend = session.sandbox;
  return {
    mode: session.sandboxFacts.mode,
    enforced: session.sandboxFacts.enforced,
    active,
    wrap: active && backend ? (s: ExecSpec) => backend.wrapSpec(s) : (s: ExecSpec) => s,
  };
}

/** Persist a tool-reported command lifecycle fact under the runtime-bound callId. */
function recordCommandEvidence(session: Session, callId: string, e: CommandEvidence): void {
  if (e.kind === 'started') {
    session.log.append({ type: 'command.started', callId, pid: e.pid, shell: e.shell, cwd: e.cwd, timeoutMs: e.timeoutMs, sandbox: e.sandbox });
    return;
  }
  session.log.append({
    type: 'command.ended',
    callId,
    termination: e.termination,
    exitCode: e.exitCode,
    durationMs: e.durationMs,
    ...(e.killDetail !== undefined ? { killDetail: e.killDetail } : {}),
    ...(e.drainTimedOut !== undefined ? { drainTimedOut: e.drainTimedOut } : {}),
  });
}

function buildApprovalRequest<I>(tool: Tool<I>, input: I, decision: PolicyDecision, callId: string): ApprovalRequest {
  const { summary, detail } = describeCall(tool, input);
  const base: ApprovalRequest = {
    callId,
    tool: tool.name,
    classification: decision.classification,
    ...(tool.command !== undefined ? { kind: 'command' as const } : {}),
    summary,
    detail,
    reason: decision.reason,
  };
  return decision.noUndo ? { ...base, noUndoWarning: true } : base;
}

function describeCall<I>(tool: Tool<I>, input: I): { summary: string; detail: string } {
  const cmd = tool.command?.(input);
  if (cmd !== undefined) return { summary: `run: ${cmd.slice(0, 120)}`, detail: cmd };
  const i = input as Record<string, unknown>;
  if (typeof i['old_string'] === 'string' && typeof i['new_string'] === 'string') {
    return {
      summary: `${tool.name} ${String(i['path'])}`,
      detail: `- ${String(i['old_string']).slice(0, 200)}\n+ ${String(i['new_string']).slice(0, 200)}`,
    };
  }
  if (typeof i['content'] === 'string') {
    return { summary: `${tool.name} ${String(i['path'])}`, detail: String(i['content']).split('\n').slice(0, 10).join('\n') };
  }
  return { summary: `${tool.name} ${String(i['path'] ?? '')}`.trim(), detail: '' };
}

async function runExecution<I>(
  session: Session,
  ctx: ToolContext,
  tool: Tool<I>,
  input: I,
  decision: PolicyDecision,
  callId: string,
  signal?: AbortSignal,
): Promise<CallOutcome> {
  let snapshot: CapturedFile[] | null = null;
  let missingDirsBefore = new Set<string>();

  if (decision.requiresSnapshot) {
    const plan = tool.mutates(input, ctx);
    const paths = plan?.paths ?? [];
    try {
      snapshot = session.snapshots.capture(paths);
      session.log.append({
        type: 'snapshot.created',
        callId,
        files: snapshot.map((f) => ({ path: f.path, beforeSha256: f.beforeSha256, bytes: f.bytes })),
      });
    } catch (e) {
      // Snapshot failed: escalate to a no-undo ask; never proceed silently.
      session.log.append({ type: 'snapshot.failed', callId, path: (e as { path?: string }).path ?? paths[0] ?? '', error: (e as Error).message });
      const escalated = escalateOnSnapshotFailure();
      session.log.append({ type: 'policy.decision', callId, classification: escalated.classification, decision: escalated.decision, rule: escalated.rule, reason: escalated.reason });
      if (session.mode === 'non-interactive') {
        session.log.append({ type: 'approval.resolved', callId, decision: 'deny', scope: 'once', source: 'non-interactive' });
        session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: 'snapshot failed; auto-denied (non-interactive)', durationMs: 0, truncated: false });
        return { toolResult: toolResultBlock(callId, 'denied: snapshot failed and this change is not undoable', true), denied: true, stop: false };
      }
      const req: ApprovalRequest = { callId, tool: tool.name, classification: escalated.classification, ...describeCall(tool, input), reason: escalated.reason, noUndoWarning: true };
      const outcome = await session.approver(req);
      session.log.append({ type: 'approval.resolved', callId, decision: outcome.decision, scope: outcome.scope, source: outcome.source });
      if (outcome.decision !== 'allow') {
        session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: 'denied by user (no-undo)', durationMs: 0, truncated: false });
        return { toolResult: toolResultBlock(callId, 'denied by user', true), denied: true, stop: outcome.decision === 'deny-stop' };
      }
      snapshot = null; // proceeding without undo coverage
    }
    missingDirsBefore = new Set(paths.flatMap((p) => missingAncestors(p, session.workspaceRoot)));
  }

  // Per-call context: the cancellation signal plus callId-bound evidence/output channels
  // (the binding means a tool can only ever report facts about its own call), and the per-call
  // sandbox (active + enforcing wrap for an auto-run command; identity for an approved one).
  const sandbox = callSandbox(session, decision.execBoundary);
  const callCtx: ToolContext = {
    ...ctx,
    ...(signal ? { signal } : {}),
    ...(sandbox ? { sandbox } : {}),
    reportCommand: (e) => recordCommandEvidence(session, callId, e),
    ...(session.onCommandOutput
      ? { onOutput: (chunk: string, stream: 'stdout' | 'stderr') => session.onCommandOutput!(callId, chunk, stream) }
      : {}),
  };
  const result = await tool.execute(input, callCtx);

  if (snapshot) {
    for (const cf of snapshot) {
      const exists = fs.existsSync(cf.path);
      const afterSha256 = exists ? sha256(fs.readFileSync(cf.path)) : null;
      const kind = cf.beforeSha256 === null ? 'create' : afterSha256 === null ? 'delete' : 'modify';
      const createdDirs = [...missingDirsBefore].filter((d) => fs.existsSync(d));
      session.log.append({ type: 'file.mutated', callId, path: cf.path, kind, beforeSha256: cf.beforeSha256, afterSha256, createdDirs });
    }
  }

  const persisted = redactedForLog(session, tool, result, decision);
  session.log.append({
    type: 'tool.completed',
    callId,
    ok: result.ok,
    outputPreview: persisted.output,
    durationMs: result.durationMs,
    truncated: result.truncated,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.fullOutputSha256 ? { fullOutputSha256: result.fullOutputSha256 } : {}),
  });

  // The model sees the REAL output; only the persisted log is redacted.
  const content = result.ok ? result.output : `${result.error ?? 'error'}${result.output ? `\n${result.output}` : ''}`;
  return { toolResult: toolResultBlock(callId, content, !result.ok), denied: false, stop: false };
}

/** Redact secret content from the persisted result (the model still sees the real output). */
function redactedForLog<I>(session: Session, tool: Tool<I>, result: ToolResult, decision: PolicyDecision): ToolResult {
  if (tool.redactForLog) return tool.redactForLog(result, session.saltHex);
  if (decision.redactOutput && result.output) return { ...result, output: redactSecret(result.output, session.saltHex) };
  return result;
}

/** Ancestor directories of `target` (below `root`) that do not currently exist. */
function missingAncestors(target: string, root: string): string[] {
  const dirs: string[] = [];
  let d = path.dirname(target);
  while (isInside(root, d) && d !== path.resolve(root) && !fs.existsSync(d)) {
    dirs.push(d);
    d = path.dirname(d);
  }
  return dirs;
}
