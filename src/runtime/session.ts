import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalRequest,
  BrowserFlowEvidence,
  ChatMessage,
  CheckEvidence,
  CommandEvidence,
  ContentBlock,
  PlanEvidence,
  PolicyDecision,
  PolicyRules,
  PreviewEvidence,
  Provider,
  ProviderRequest,
  RepairEvidence,
  ReviewEvidence,
  SessionEvent,
  SessionMode,
  StopReason,
  TaskEvidence,
  Tool,
  ToolContext,
  ToolResult,
  ToolResultPart,
} from '../types.js';
import { EventLog } from '../store/event-log.js';
import { FreshLogCollisionError } from '../shared/errors.js';
import { SnapshotStore, type CapturedFile } from '../store/snapshots.js';
import { decide, Grants, escalateOnSnapshotFailure } from '../policy/engine.js';
import { TOOLS, toToolSchema } from '../tools/index.js';
import { sha256, redactSecret } from '../shared/hash.js';
import { isInside } from '../shared/pathutil.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { systemIdGen, type IdGen } from '../shared/ids.js';
import type { ProjectLayout } from '../store/layout.js';
import { SETUP_ACTIONS } from '../types.js';
import type { Approver, ExecSandbox, ResolvedCheckFact, SetupEvidence } from '../types.js';
import type { SandboxBackend, EnforcementFacts } from '../sandbox/index.js';
import type { GitFacts } from '../git/types.js';
import type { ExecSpec } from '../exec/run.js';
import { coerceStringifiedInput } from './input-coerce.js';
import { elideHistory, type ElisionOptions } from './elision.js';
import { capsFor, type ProviderName } from '../provider/catalog.js';
import { DIFF_MAX_BYTES, isProbablyBinary, lineDiffStat } from '../shared/diff.js';

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
  /**
   * Render-only model-request lifecycle (S16.5b): `true` immediately before each provider call,
   * `false` when it settles (success, error, or abort alike). The REPL's "working" heartbeat
   * hangs off this — an always-thinking model otherwise looks frozen between tool steps. Never
   * an event; the evidence stream is untouched.
   */
  onModelRequest?: (inFlight: boolean) => void;
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
  /** callIds whose IMAGE parts were replaced with markers (Session 13; same lifecycle as above). */
  imageElidedCallIds?: Set<string>;
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

/**
 * Tool calls one turn may make before the loop stops and reports `max-steps` (Session 16: 20→40).
 *
 * 20 was set when a task meant "edit a few files and run the tests". A dependency-bearing
 * full-stack turn is detect → install ×2 → write .env → migrate → seed → build → start two
 * previews → check each project → drive a browser flow, and it ran out of steps mid-work with an
 * honest but useless "step budget reached". Doubling it buys legitimate depth; it is still a hard
 * ceiling, still reported honestly, and still overridable with --max-steps.
 *
 * ONE exported constant: this default was written twice (here and in the CLI context builder),
 * which is how the library and the CLI quietly come to disagree about what a turn is.
 */
export const DEFAULT_MAX_STEPS = 40;

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
  onModelRequest?: (inFlight: boolean) => void;
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
  /** Present only for subagent child sessions: recorded on session.started for lineage. */
  lineage?: { parentSessionId: string; role: string };
}

/** Open a fresh session: create the log, acquire the lock, and record `session.started`. */
export function startSession(opts: StartOptions): Session {
  const clock = opts.clock ?? systemClock;
  const idGen = opts.idGen ?? systemIdGen(clock);
  // Fresh must mean fresh: a same-second id collision (routine once child sessions exist —
  // several can start inside one parent second) must never append into an EXISTING log, which
  // would merge two sessions' evidence and steal the same-pid lock. The GUARANTEE is the
  // atomic exclusive create inside EventLog.open (expectFresh) — the existsSync check is only
  // a cheap fast-path; a cross-process race loses at the exclusive open, never silently.
  let id = idGen.sessionId();
  let log: EventLog | undefined;
  for (let attempt = 0; ; attempt++) {
    if (!fs.existsSync(opts.layout.sessionFile(id))) {
      try {
        log = EventLog.open({ file: opts.layout.sessionFile(id), lockFile: opts.layout.lockFile(id), clock, expectFresh: true });
        break;
      } catch (err) {
        if (!(err instanceof FreshLogCollisionError)) throw err;
      }
    }
    if (attempt >= 4) throw new Error(`could not allocate a fresh session id (last tried: ${id})`);
    id = idGen.sessionId();
  }
  const session = buildSession(id, opts, log, clock);
  log.append({
    type: 'session.started',
    sessionId: id,
    workspaceRoot: opts.workspaceRoot,
    model: opts.model,
    mode: opts.mode,
    providerName: opts.provider.name,
    argv: opts.argv ?? [],
    ...(opts.lineage !== undefined ? { lineage: opts.lineage } : {}),
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
    maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
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
  if (opts.onModelRequest) base.onModelRequest = opts.onModelRequest;
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
  const checkStartedBy = new Map<string, string[]>();
  const setupStartedBy = new Map<string, { action: string; projectId: string }>();
  // One delegate call may start a PARALLEL GROUP (V0.7) — keep every task.started per callId,
  // or a crash replay would name only the last child and orphan the other survivors' evidence.
  const taskStartedBy = new Map<string, Extract<SessionEvent, { type: 'task.started' }>[]>();
  const taskChangesBy = new Set<string>();
  for (const e of events) {
    if (e.type === 'tool.completed') completedBy.set(e.callId, e);
    else if (e.type === 'file.mutated') (mutatedBy.get(e.callId) ?? mutatedBy.set(e.callId, []).get(e.callId)!).push(e);
    else if (e.type === 'snapshot.created') snapBy.add(e.callId);
    else if (e.type === 'command.started') commandStartedBy.add(e.callId);
    else if (e.type === 'check.started') (checkStartedBy.get(e.callId) ?? checkStartedBy.set(e.callId, []).get(e.callId)!).push(e.check);
    else if (e.type === 'setup.started') setupStartedBy.set(e.callId, { action: e.action, projectId: e.projectId });
    else if (e.type === 'task.started') (taskStartedBy.get(e.callId) ?? taskStartedBy.set(e.callId, []).get(e.callId)!).push(e);
    else if (e.type === 'task.changes') taskChangesBy.add(e.callId);
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
    const tasks = taskStartedBy.get(id);
    if (tasks !== undefined && tasks.length > 0) {
      // The delegated task(s) were running at the crash. Each child's OWN evidence log
      // survives — point at every one of them instead of guessing what the children did.
      const planRef = (t: Extract<SessionEvent, { type: 'task.started' }>): string =>
        t.planTaskId !== undefined ? `, plan task '${t.planTaskId}'` : '';
      const pointers = tasks.map((t) => `child session ${t.childSessionId} (${t.role}${planRef(t)}) — inspect: agent report ${t.childSessionId}`);
      const changesNote = taskChangesBy.has(id)
        ? ' Captured task changes survived the crash and can still be integrated with apply_task_changes.'
        : '';
      return toolResultBlock(
        id,
        (tasks.length === 1
          ? `interrupted: a delegated task (child session ${tasks[0]!.childSessionId}${planRef(tasks[0]!)}) was running when the session crashed; its own evidence log survives — inspect: agent report ${tasks[0]!.childSessionId}`
          : `interrupted: ${tasks.length} delegated tasks were running when the session crashed; each child's own evidence log survives — ${pointers.join('; ')}`) + changesNote,
        true,
      );
    }
    if (commandStartedBy.has(id)) {
      // The command had SPAWNED (command.started recorded) — its side effects are unknown and
      // the process may even have kept running past the crash.
      return toolResultBlock(id, 'interrupted: the command was executing when the session crashed; its effects are unknown', true);
    }
    const setup = setupStartedBy.get(id);
    if (setup !== undefined) {
      // A setup had SPAWNED (Session 16). An interrupted `npm ci` leaves a half-written
      // node_modules and an interrupted migration leaves a database in an unknown shape — so the
      // honest replay is the same one a killed check gets: no verdict, unknown effects, re-run.
      return toolResultBlock(
        id,
        `interrupted: a project ${setup.action} for project ${setup.projectId} was executing when the session crashed; ` +
          'it produced no result and the project\'s dependency or local data state is UNKNOWN — re-run it',
        true,
      );
    }
    const checks = checkStartedBy.get(id);
    if (checks !== undefined && checks.length > 0) {
      // A typed check had SPAWNED (Session 12). Same honesty as a command: a build killed
      // mid-flight can leave partial artifacts, and the check produced NO verdict — it must never
      // read as having passed. Re-run it.
      return toolResultBlock(
        id,
        `interrupted: typed check(s) (${checks.join(', ')}) were executing when the session crashed; they produced no verdict and their effects are unknown — re-run them`,
        true,
      );
    }
    return toolResultBlock(id, 'interrupted by session crash', true);
  };

  const messages: ChatMessage[] = [];
  for (const e of events) {
    if (e.type === 'user.message') {
      messages.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
    } else if (e.type === 'assistant.message') {
      const content: ContentBlock[] = [];
      // Reasoning blocks rebuild at the HEAD (Session 15): Anthropic thinking blocks always
      // precede visible output in a response, chat-compat providers carry reasoning as an
      // order-free message field, and the OpenAI adapter re-derives item order itself. Old
      // logs have no `reasoning` field and rebuild exactly as before.
      if (e.reasoning !== undefined) {
        for (const r of e.reasoning) {
          content.push({
            type: 'reasoning',
            providerName: r.providerName,
            model: r.model,
            payload: r.payload,
            ...(r.text !== undefined ? { text: r.text } : {}),
          });
        }
      }
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
  map: {
    fileCount: number;
    truncated: boolean;
    text: string;
    sha256: string;
    inventorySha256?: string;
    indexedFiles?: number;
    indexState?: 'full' | 'partial';
  },
): void {
  session.log.append({
    type: 'workspace.mapped',
    fileCount: map.fileCount,
    truncated: map.truncated,
    chars: map.text.length,
    sha256: map.sha256,
    ...(map.inventorySha256 !== undefined ? { inventorySha256: map.inventorySha256 } : {}),
    ...(map.indexedFiles !== undefined ? { indexedFiles: map.indexedFiles } : {}),
    ...(map.indexState !== undefined ? { indexState: map.indexState } : {}),
  });
}

/**
 * Map a turn outcome onto the session-end reason. 'aborted' is distinct from 'user-quit' on
 * purpose: an aborted session must never trigger post-session work (e.g. the memory narrative
 * call) — the user just asked everything to stop.
 */
export function endReasonForTurn(result: TurnResult, maxSteps: number): 'completed' | 'user-quit' | 'max-steps' | 'aborted' {
  if (result.aborted) return 'aborted';
  if (result.stopped && result.steps >= maxSteps) return 'max-steps';
  if (result.stopped) return 'user-quit';
  return 'completed';
}

/** Record `session.ended` and release the lock. Safe to call once per session. */
export function endSession(session: Session, reason: 'completed' | 'user-quit' | 'error' | 'max-steps' | 'aborted' | 'budget', error?: string): void {
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
    const prevElided = session.elidedCallIds ?? new Set<string>();
    // Carry the already-elided set so the boundary is genuinely monotone (S14.5): without it an
    // aging screenshot could free budget and restore older outputs the log already recorded as
    // elided — a cache-invalidating, evidence-contradicting oscillation.
    const elision = elideHistory(session.messages, { ...session.contextBudget, alreadyElided: [...prevElided] });
    const prevImageElided = session.imageElidedCallIds ?? new Set<string>();
    const newlyImages = elision.imageElidedCallIds.filter((id) => !prevImageElided.has(id));
    if (elision.elidedCallIds.length > prevElided.size || newlyImages.length > 0) {
      const newly = elision.elidedCallIds.filter((id) => !prevElided.has(id));
      session.elidedCallIds = new Set(elision.elidedCallIds);
      session.imageElidedCallIds = new Set(elision.imageElidedCallIds);
      session.log.append({
        type: 'context.compacted',
        elidedCount: elision.elidedCallIds.length,
        newlyElidedCallIds: newly,
        rawChars: elision.rawChars,
        sentChars: elision.sentChars,
        exhausted: elision.exhausted,
        ...(newlyImages.length > 0 ? { newlyImageElidedCallIds: newlyImages } : {}),
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
    session.onModelRequest?.(true);
    try {
      turn = await session.provider.complete(req, session.onText, signal);
    } catch (err) {
      // Abort is detected via the signal, never via provider-specific error classes. Nothing has
      // been appended for this step, so the log and message history end at the last complete
      // exchange (a trailing user message; the Anthropic and chat-compat adapters coalesce
      // consecutive user messages at the wire, and the Responses API accepts them as items).
      if (signal?.aborted) return abortedResult('model', steps);
      throw err;
    } finally {
      // Success, error and abort alike: the request is no longer in flight (render-only).
      session.onModelRequest?.(false);
    }
    lastStop = turn.stopReason;

    const text = turn.blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text) finalText = text;
    const toolUses = turn.blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    // Opaque reasoning blocks (Session 15) are persisted VERBATIM and in stream order: resume
    // must replay them byte-faithfully (kimi/deepseek reject a tool-looping assistant message
    // whose reasoning was altered or dropped mid-loop; Anthropic requires thinking blocks
    // passed back unchanged). They ride into session.messages untouched via turn.blocks below.
    const reasoningBlocks = turn.blocks.filter((b): b is Extract<ContentBlock, { type: 'reasoning' }> => b.type === 'reasoning');

    session.log.append({
      type: 'assistant.message',
      text,
      toolCalls: toolUses.map((t) => ({ id: t.id, name: t.name, input: t.input })),
      stopReason: turn.stopReason,
      usage: turn.usage,
      ...(reasoningBlocks.length > 0
        ? {
            reasoning: reasoningBlocks.map((b) => ({
              providerName: b.providerName,
              model: b.model,
              payload: b.payload,
              ...(b.text !== undefined ? { text: b.text } : {}),
            })),
          }
        : {}),
    });
    session.messages.push({ role: 'assistant', content: turn.blocks });

    if (toolUses.length === 0) break;
    if (turn.stopReason !== 'tool_use') {
      // Blocks and stopReason CAN diverge: a max_tokens cut mid-tool-call yields tool_use
      // blocks with stopReason 'max_tokens' (the SDK partial-parses the truncated input). The
      // old condition broke here without answering them, leaving an unanswered tool_use in the
      // live history — every later request 400s, and repairDanglingToolUses cannot help once
      // the next user message is appended. Answer them as not-run and end the turn honestly.
      const skipped = toolUses.map((tu) =>
        recordSkippedCall(session, tu, `not run: the model's turn ended with stop reason '${turn.stopReason}' before this call could be executed`),
      );
      session.messages.push({ role: 'user', content: skipped });
      break;
    }

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
  // The API rejects an EMPTY error tool_result ("content cannot be empty if is_error is true").
  // A failing command with no output (e.g. findstr with zero matches, exit 1) records
  // outputPreview '' — replayed verbatim on resume, that empty error block 400s every later
  // request of the resumed conversation. Found live in the Session-13 E2E.
  const c = isError && content === '' ? '(no output recorded)' : content;
  return isError
    ? { type: 'tool_result', toolUseId, content: c, isError: true }
    : { type: 'tool_result', toolUseId, content: c };
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
    // outputPreview is contractually "the exact string the model saw", so a resumed
    // conversation replays byte-identically — persisting '' lost WHICH tool was rejected and
    // made the replay differ from the original turn (S14.5 review finding).
    const message = `unknown tool: ${tu.name}`;
    session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: message, durationMs: 0, truncated: false });
    return { toolResult: toolResultBlock(callId, message, true), denied: false, stop: false };
  }

  let parsed = tool.schema.safeParse(tu.input);
  let coerceHint: string | undefined;
  if (!parsed.success) {
    // One-level tolerant decode for double-encoded arguments (S16.5b, found live: kimi-k3
    // serialized the nested `plan` object and then cycled formats against the schema error for
    // twelve minutes). The decode is narrow and deterministic (see input-coerce.ts); the
    // recorded tool.requested and the wire history keep the model's ORIGINAL bytes, and the
    // normalized input is what both policy and execution see — the same thing the human is
    // shown at an approval prompt.
    const c = coerceStringifiedInput(tu.input, parsed.error);
    coerceHint = c.hint;
    if (c.data !== undefined) {
      const second = tool.schema.safeParse(c.data);
      if (second.success) parsed = second;
    }
  }
  if (!parsed.success) {
    session.log.append({ type: 'policy.decision', callId, classification: 'observe', decision: 'deny', rule: 'input.invalid', reason: 'input failed schema validation' });
    const msg = `invalid input: ${parsed.error.message}${coerceHint !== undefined ? `\n${coerceHint}` : ''}`;
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
    // A grant is stored only for tools WITHOUT shell authority: a command's classification is
    // a best-effort label over untrusted model text, never a stable fact to key standing
    // permission on (Grants.add also refuses 'run_command' by name — defense in depth; this
    // fact-based gate covers any future command-bearing tool, and the prompt hides [s] to match).
    // `tool.check === undefined` too (Session 16): a check-branch tool's consent lives in the
    // replay store below, and its class is never consulted by `decide`. An install is classified
    // `external`, which IS grantable — so without this a session answer stored
    // `(project_setup, external)` that nothing ever reads. The prompt already hid `[s]` for these
    // kinds; the STORAGE site had not been told, so a typed `s` still recorded a session grant
    // the user was never offered and never received. Consent that does nothing is worse than none.
    if (outcome.scope === 'session' && tool.command === undefined && tool.check === undefined) {
      session.grants.add(tool.name, decision.classification);
    }
    // Typed-check replay consent (Session 12): a session-scope approval on a check stores the
    // per-command keys the decision computed — consent to re-run those EXACT harness-resolved
    // commands. Deliberately not a class grant (Grants.add refuses `reversible` anyway): a
    // manifest edit that changes what a recipe resolves to produces a new key and asks again.
    if (outcome.scope === 'session' && decision.checkReplayKeys !== undefined) {
      for (const key of decision.checkReplayKeys) session.grants.addCheckReplay(key);
    }
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
  const backend = session.sandbox;
  // `active` is what the LOG asserts about confinement, so it must require a backend that can
  // actually confine: with facts but no backend (independent optionals — "both or neither" was
  // only a comment) an auto-run command ran unwrapped while command.started recorded the
  // enforcing mode. Fail honest: no backend means not active, so the record says 'none'.
  const active = boundary === 'sandbox' && backend !== undefined;
  return {
    mode: session.sandboxFacts.mode,
    enforced: session.sandboxFacts.enforced,
    active,
    wrap: active && backend ? (s: ExecSpec) => backend.wrapSpec(s) : (s: ExecSpec) => s,
  };
}

/** Persist a tool-reported task lifecycle fact under the runtime-bound callId (mirrors commands). */
function recordTaskEvidence(session: Session, callId: string, e: TaskEvidence): void {
  switch (e.kind) {
    case 'started':
      session.log.append({
        type: 'task.started',
        callId,
        role: e.role,
        childSessionId: e.childSessionId,
        budget: e.budget,
        ...(e.planTaskId !== undefined ? { planTaskId: e.planTaskId } : {}),
        ...(e.planTaskSha !== undefined ? { planTaskSha: e.planTaskSha } : {}),
      });
      return;
    case 'supervision':
      session.log.append({
        type: 'task.supervision',
        callId,
        childSessionId: e.childSessionId,
        kind: e.what,
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
      });
      return;
    case 'ended':
      session.log.append({
        type: 'task.ended',
        callId,
        childSessionId: e.childSessionId,
        status: e.status,
        steps: e.steps,
        usage: e.usage,
        resultSha256: e.resultSha256,
        durationMs: e.durationMs,
      });
      return;
    case 'changes':
      session.log.append({
        type: 'task.changes',
        callId,
        childSessionId: e.childSessionId,
        baseOid: e.baseOid,
        files: e.files,
        ...(e.omittedCount !== undefined ? { omittedCount: e.omittedCount } : {}),
      });
      return;
    case 'worktree-created':
      session.log.append({ type: 'worktree.created', callId, childSessionId: e.childSessionId, path: e.path, baseOid: e.baseOid });
      return;
    case 'worktree-removed':
      session.log.append({
        type: 'worktree.removed',
        callId,
        childSessionId: e.childSessionId,
        ok: e.ok,
        ...(e.detail !== undefined ? { detail: e.detail } : {}),
      });
      return;
    case 'applied':
      session.log.append({ type: 'task.applied', callId, childSessionId: e.childSessionId, applied: e.applied, refused: e.refused });
      return;
    case 'base-checkpoint':
      session.log.append({ type: 'task.base-checkpoint', callId, ref: e.ref, oid: e.oid });
      return;
    case 'harness-checkpoint':
      session.log.append({ type: 'harness.checkpoint', kind: e.checkpointKind, ref: e.ref, oid: e.oid, callId });
      return;
    case 'review-findings':
      session.log.append({
        type: 'review.findings',
        callId,
        childSessionId: e.childSessionId,
        ...(e.planTaskId !== undefined ? { planTaskId: e.planTaskId } : {}),
        ...(e.lens !== undefined ? { lens: e.lens } : {}),
        findings: e.findings,
      });
      return;
  }
}

/** Persist a tool-reported review-triage fact under the runtime-bound callId (Session 14). */
function recordReviewEvidence(session: Session, callId: string, e: ReviewEvidence): void {
  session.log.append({
    type: 'review.triage',
    callId,
    findingId: e.findingId,
    action: e.action,
    evidence: e.evidence,
    ...(e.refs !== undefined && e.refs.length > 0 ? { refs: e.refs } : {}),
  });
}

/** Persist a tool-reported plan-document write under the runtime-bound callId (V0.7). */
function recordPlanEvidence(session: Session, callId: string, e: PlanEvidence): void {
  // Routing observability (Session 11): the model calling update_plan IS the plan-path routing
  // decision — record it once, before the session's first plan.updated, unless a sigil already
  // routed. Absence of any plan events remains the honest evidence of a direct turn.
  const hasRoute = session.log.events.some((ev) => ev.type === 'plan.route');
  const hasUpdate = session.log.events.some((ev) => ev.type === 'plan.updated');
  if (!hasRoute && !hasUpdate) {
    session.log.append({ type: 'plan.route', mode: 'plan', source: 'model' });
  }
  session.log.append({
    type: 'plan.updated',
    callId,
    planId: e.planId,
    sha256: e.sha256,
    bytes: e.bytes,
    prevSha256: e.prevSha256,
    status: e.status,
    ...(e.graph !== undefined ? { graph: e.graph } : {}),
  });
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

/** Persist a tool-reported typed-check lifecycle fact under the runtime-bound callId (Session 12). */
function recordCheckEvidence(session: Session, callId: string, e: CheckEvidence): void {
  if (e.kind === 'started') {
    session.log.append({
      type: 'check.started',
      callId,
      check: e.check,
      recipeId: e.recipeId,
      command: e.command,
      cwd: e.cwd,
      timeoutMs: e.timeoutMs,
      ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
      ...(e.planTaskId !== undefined ? { planTaskId: e.planTaskId } : {}),
      ...(e.scopePaths !== undefined ? { scopePaths: e.scopePaths } : {}),
    });
    return;
  }
  session.log.append({
    type: 'check.completed',
    callId,
    check: e.check,
    recipeId: e.recipeId,
    status: e.status,
    ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
    ...(e.unsupportedReason !== undefined ? { unsupportedReason: e.unsupportedReason } : {}),
    exitCode: e.exitCode,
    ...(e.termination !== undefined ? { termination: e.termination } : {}),
    durationMs: e.durationMs,
    summary: e.summary,
    ...(e.signals !== undefined ? { signals: e.signals } : {}),
    ...(e.findings !== undefined ? { findings: e.findings } : {}),
    ...(e.planTaskId !== undefined ? { planTaskId: e.planTaskId } : {}),
    ...(e.scopePaths !== undefined ? { scopePaths: e.scopePaths } : {}),
  });
}

/** Persist a tool-reported project-setup fact under the runtime-bound callId (Session 16). */
function recordSetupEvidence(session: Session, callId: string, e: SetupEvidence): void {
  if (e.kind === 'started') {
    session.log.append({
      type: 'setup.started',
      callId,
      action: e.action,
      projectId: e.projectId,
      recipeId: e.recipeId,
      command: e.command,
      cwd: e.cwd,
      timeoutMs: e.timeoutMs,
      ...(e.packageManager !== undefined ? { packageManager: e.packageManager } : {}),
      ...(e.lockfile !== undefined ? { lockfile: e.lockfile } : {}),
      ...(e.lockfileSha !== undefined ? { lockfileSha: e.lockfileSha } : {}),
    });
    return;
  }
  session.log.append({
    type: 'setup.completed',
    callId,
    action: e.action,
    projectId: e.projectId,
    recipeId: e.recipeId,
    status: e.status,
    ...(e.unsupportedReason !== undefined ? { unsupportedReason: e.unsupportedReason } : {}),
    exitCode: e.exitCode,
    ...(e.termination !== undefined ? { termination: e.termination } : {}),
    durationMs: e.durationMs,
    summary: e.summary,
    ...(e.signals !== undefined ? { signals: e.signals } : {}),
  });
}

/** Persist a tool-reported preview lifecycle fact under the runtime-bound callId (Session 13). */
function recordPreviewEvidence(session: Session, callId: string, e: PreviewEvidence): void {
  if (e.kind === 'started') {
    session.log.append({
      type: 'preview.started',
      callId,
      previewId: e.previewId,
      recipeId: e.recipeId,
      command: e.command,
      cwd: e.cwd,
      pid: e.pid,
      ...(e.expectedPort !== undefined ? { expectedPort: e.expectedPort } : {}),
      ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
    });
    return;
  }
  session.log.append({
    type: 'preview.ready',
    callId,
    previewId: e.previewId,
    url: e.url,
    port: e.port,
    waitedMs: e.waitedMs,
    probeDetail: e.probeDetail,
  });
}

/** Persist a browser flow's detail evidence under the runtime-bound callId (Session 13). */
function recordBrowserEvidence(session: Session, callId: string, e: BrowserFlowEvidence): void {
  session.log.append({
    type: 'browser.flow',
    callId,
    flowName: e.flowName,
    previewId: e.previewId,
    status: e.status,
    steps: e.steps,
    artifacts: e.artifacts,
    consoleErrors: e.consoleErrors,
    pageErrors: e.pageErrors,
    failedRequests: e.failedRequests,
    offOriginRequests: e.offOriginRequests,
    finalUrl: e.finalUrl,
    ...(e.traceOmittedBytes !== undefined ? { traceOmittedBytes: e.traceOmittedBytes } : {}),
  });
}

/** Persist a tool-reported repair-ledger fact under the runtime-bound callId (Session 12). */
function recordRepairEvidence(session: Session, callId: string, e: RepairEvidence): void {
  if (e.kind === 'attempted') {
    session.log.append({
      type: 'repair.attempted',
      callId,
      target: e.target,
      failureClass: e.failureClass,
      signature: e.signature,
      hypothesis: e.hypothesis,
      hypothesisSha: e.hypothesisSha,
      scopePaths: e.scopePaths,
      regressionChecks: e.regressionChecks,
      attempt: e.attempt,
      ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
    });
    return;
  }
  session.log.append({
    type: 'repair.escalated',
    callId,
    target: e.target,
    failureClass: e.failureClass,
    signature: e.signature,
    reason: e.reason,
  });
}

function buildApprovalRequest<I>(tool: Tool<I>, input: I, decision: PolicyDecision, callId: string): ApprovalRequest {
  const { summary, detail } = describeCall(tool, input);
  // Display-only tool context (V0.7.1, e.g. plan state at an executor spawn) folds into detail
  // so it inherits the prompt renderer's sanitize + line cap. The decision is already made —
  // this changes what the human SEES, never what was decided — and a throw must not block the ask.
  let contextLines: string[] = [];
  try {
    contextLines = tool.approvalContext?.(input) ?? [];
  } catch {
    contextLines = [];
  }
  const fullDetail = contextLines.length > 0 ? [detail, ...contextLines].filter((s) => s !== '').join('\n') : detail;
  const base: ApprovalRequest = {
    callId,
    tool: tool.name,
    classification: decision.classification,
    ...(tool.command !== undefined
      ? { kind: 'command' as const }
      : tool.check !== undefined
        ? // The KIND derives from the policy VERDICT, not by re-deriving the fact: the engine
          // already decided whether these resolved rows are a preview (Session 13), a project
          // setup (Session 16) or a check.
          {
            kind: decision.rule.startsWith('preview.')
              ? ('preview' as const)
              : decision.rule.startsWith('setup.')
                ? ('setup' as const)
                : ('check' as const),
            // Only count what a session answer would ACTUALLY store. A migration issues no replay
            // keys, so it must not advertise an [s] that would silently do nothing.
            ...(decision.checkReplayKeys !== undefined ? { checkCount: decision.checkReplayKeys.length } : {}),
          }
        : {}),
    summary,
    detail: fullDetail,
    reason: decision.reason,
  };
  return decision.noUndo ? { ...base, noUndoWarning: true } : base;
}

function describeCall<I>(tool: Tool<I>, input: I): { summary: string; detail: string } {
  const cmd = tool.command?.(input);
  if (cmd !== undefined) return { summary: `run: ${cmd.slice(0, 120)}`, detail: cmd };
  // Typed checks (Session 12): the human MUST see every harness-resolved command verbatim —
  // that display is the entire basis on which replay consent is honest. Without this branch the
  // call would fall through to the bare `${tool.name}` form with an empty detail, and the user
  // would be consenting to re-run a command they never saw.
  if (tool.check !== undefined) {
    let resolved: readonly ResolvedCheckFact[] = [];
    try {
      resolved = tool.check(input).resolved;
    } catch {
      resolved = [];
    }
    // Setup rows (Session 16): the human must see the command, the DIRECTORY it runs in, and —
    // for an install — the lockfile whose sha the consent is bound to. Without the directory this
    // prompt would be identical for `npm ci` in `web/` and in `api/`.
    const setupRow = resolved.find((r) => (SETUP_ACTIONS as readonly string[]).includes(r.kind));
    if (setupRow !== undefined) {
      return {
        summary: `${tool.name}: ${setupRow.kind} ${setupRow.projectId !== undefined ? `[project ${setupRow.projectId}]` : ''}`.trimEnd(),
        detail:
          `${setupRow.command}   [${setupRow.recipeId}]\n  in: ${setupRow.cwd ?? '(workspace root)'}` +
          // The resolver's own sentence about THIS resolution — "NO LOCKFILE is present … versions
          // are NOT pinned" is a materially different authority from `npm ci`, and the generic
          // engine reason cannot say it. It was computed and then never shown to anyone.
          (setupRow.consequence !== undefined ? `\n  ${setupRow.consequence}` : ''),
      };
    }
    // Preview rows (Session 13): the consequence line is different in kind, not just degree —
    // the human is consenting to a process that KEEPS RUNNING and binds a port.
    if (resolved.some((r) => r.kind === 'preview')) {
      return {
        summary: `${tool.name}: start ${resolved.map((r) => r.recipeId).join(', ')}`,
        detail: resolved
          .map(
            (r) =>
              `${r.command}   [${r.recipeId}; KEEPS RUNNING up to ${String(Math.round(r.timeoutMs / 60_000))}min ` +
              `(or until stopped / session end); binds a local port; runs a script defined by this workspace]`,
          )
          .join('\n'),
      };
    }
    return {
      summary: `${tool.name}: ${resolved.length > 0 ? resolved.map((r) => r.kind).join(', ') : '(nothing to run)'}`,
      detail: resolved
        .map(
          (r) =>
            `${r.kind} → ${r.command}` +
            `   [${r.recipeId}; timeout ${Math.round(r.timeoutMs / 1000)}s` +
            `${r.effects.workspaceAuthored ? '; runs a script defined by this workspace' : ''}]`,
        )
        .join('\n'),
    };
  }
  const i = input as Record<string, unknown>;
  // Delegation groups: the human must see WHO would be spawned to do WHAT — a bare tool name
  // is not an answerable approval prompt (the ask path arrives with mutating roles, V0.7).
  if (tool.delegates !== undefined && Array.isArray(i['tasks'])) {
    const tasks = i['tasks'] as { role?: unknown; task?: unknown }[];
    return {
      summary: `${tool.name}: ${tasks.length} task(s) — ${tasks.map((t) => String(t.role ?? '?')).join(', ')}`,
      detail: tasks
        .map((t, n) => `${n + 1}. [${String(t.role ?? '?')}] ${String(t.task ?? '').split('\n')[0]!.slice(0, 160)}`)
        .join('\n'),
    };
  }
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

/**
 * Line diffstat for one mutation, computed while both sides are at hand (the report stays a
 * pure function of events). Skipped — fields absent — for no-ops, binary content, and files
 * over the diff size cap; evidence enrichment must never fail or stall a mutation.
 */
function mutationDiffStat(
  session: Session,
  beforeSha256: string | null,
  afterSha256: string | null,
  afterBytes: Buffer | null,
): { linesAdded?: number; linesRemoved?: number } {
  if (beforeSha256 === afterSha256) return {};
  try {
    const before = beforeSha256 !== null ? session.snapshots.getBlob(beforeSha256) : Buffer.alloc(0);
    const after = afterBytes ?? Buffer.alloc(0);
    if (before.length > DIFF_MAX_BYTES || after.length > DIFF_MAX_BYTES) return {};
    if (isProbablyBinary(before) || isProbablyBinary(after)) return {};
    const stat = lineDiffStat(before.toString('utf8'), after.toString('utf8'));
    return { linesAdded: stat.added, linesRemoved: stat.removed };
  } catch {
    return {};
  }
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
    reportTask: (e) => recordTaskEvidence(session, callId, e),
    reportPlan: (e) => recordPlanEvidence(session, callId, e),
    reportCheck: (e) => recordCheckEvidence(session, callId, e),
    reportSetup: (e) => recordSetupEvidence(session, callId, e),
    reportRepair: (e) => recordRepairEvidence(session, callId, e),
    reportReview: (e) => recordReviewEvidence(session, callId, e),
    reportPreview: (e) => recordPreviewEvidence(session, callId, e),
    reportBrowser: (e) => recordBrowserEvidence(session, callId, e),
    ...(session.onCommandOutput
      ? { onOutput: (chunk: string, stream: 'stdout' | 'stderr') => session.onCommandOutput!(callId, chunk, stream) }
      : {}),
  };
  const result = await tool.execute(input, callCtx);

  if (snapshot) {
    for (const cf of snapshot) {
      // The readback must never throw past this point: the bytes are ALREADY on disk, and an
      // escaping error meant zero file.mutated events — so `/undo` could not restore a file
      // whose pre-image was sitting in the snapshot store, while the repair path recorded the
      // call as "failed before it ran". A transient EPERM/EBUSY (AV/indexer holding a
      // just-written file) or an EISDIR is enough to trigger it. Record the mutation either
      // way; an unreadable post-state is honest as afterSha256 null.
      let afterBytes: Buffer | null = null;
      let readFailed: string | null = null;
      try {
        afterBytes = fs.existsSync(cf.path) ? fs.readFileSync(cf.path) : null;
      } catch (e) {
        readFailed = (e as Error).message;
      }
      const afterSha256 = afterBytes !== null ? sha256(afterBytes) : null;
      const kind = cf.beforeSha256 === null ? 'create' : afterSha256 === null ? 'delete' : 'modify';
      let createdDirs: string[] = [];
      try {
        createdDirs = [...missingDirsBefore].filter((d) => fs.existsSync(d));
      } catch {
        /* directory probing is enrichment, never the reason a mutation goes unrecorded */
      }
      const stat = mutationDiffStat(session, cf.beforeSha256, afterSha256, afterBytes);
      session.log.append({
        type: 'file.mutated',
        callId,
        path: cf.path,
        // An unreadable post-state is NOT a delete: say the mutation happened and that its
        // resulting bytes could not be read, rather than recording a deletion that never was.
        kind: readFailed !== null ? (cf.beforeSha256 === null ? 'create' : 'modify') : kind,
        beforeSha256: cf.beforeSha256,
        afterSha256,
        createdDirs,
        ...stat,
        ...(readFailed !== null ? { postStateUnverified: true as const, postStateError: readFailed } : {}),
      });
    }
  }

  const persisted = redactedForLog(session, tool, result, decision);
  const hasImages = result.images !== undefined && result.images.length > 0;
  // Session 15: whether the pixels actually reached the model is decided by the CATALOG, and the
  // answer has to be durable — the wire-side pointer text is ephemeral, so a log without this
  // could not distinguish a visually-judged flow from one the model never saw.
  const imagesWithheld = hasImages && !capsFor(session.provider.name as ProviderName, session.model).visionInput;
  session.log.append({
    type: 'tool.completed',
    callId,
    ok: result.ok,
    outputPreview: persisted.output,
    durationMs: result.durationMs,
    truncated: result.truncated,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.fullOutputSha256 ? { fullOutputSha256: result.fullOutputSha256 } : {}),
    ...(spillFullOutput(session, tool, result, decision) ? { fullOutputSaved: true as const } : {}),
    // Image METADATA only (Session 13): the pixels are content-addressed blobs the tool already
    // stored; a log line must never carry base64. Resume rebuilds from outputPreview, whose text
    // carries the objects/<sha> pointer per image (the ToolResult.images contract).
    ...(hasImages
      ? { images: result.images!.map((im) => ({ sha256: im.sha256, mediaType: im.mediaType, bytes: Buffer.byteLength(im.dataBase64, 'base64'), label: im.label })) }
      : {}),
    ...(imagesWithheld ? { imagesWithheld: true as const } : {}),
  });

  // The model sees the REAL output; only the persisted log is redacted. With images attached,
  // the wire block becomes structured content: the text part first, then the pixels the model
  // is being asked to actually look at (Session 13).
  const content = result.ok ? result.output : `${result.error ?? 'error'}${result.output ? `\n${result.output}` : ''}`;
  if (result.images !== undefined && result.images.length > 0) {
    // Session 15 vision choke: a model without image input gets honest POINTERS, never pixels.
    // The evidence is unchanged (blobs stored, image metadata on tool.completed) — only the
    // wire view degrades, and the text says so. Nothing else (DOM assertions, gates, checks)
    // is affected.
    if (imagesWithheld) {
      const pointers = result.images
        .map(
          (im) =>
            `[screenshot${im.label !== undefined ? ` ${im.label}` : ''}: stored as evidence at objects/${im.sha256} — model '${session.model}' has no image input, pixels not sent]`,
        )
        .join('\n');
      return {
        toolResult: {
          type: 'tool_result',
          toolUseId: callId,
          content: `${content}${content.length > 0 ? '\n' : ''}${pointers}`,
          ...(result.ok ? {} : { isError: true }),
        },
        denied: false,
        stop: false,
      };
    }
    const parts: ToolResultPart[] = [
      { type: 'text', text: content },
      ...result.images.map(
        (im): ToolResultPart => ({ type: 'image', mediaType: im.mediaType, dataBase64: im.dataBase64, sha256: im.sha256, label: im.label }),
      ),
    ];
    return {
      toolResult: { type: 'tool_result', toolUseId: callId, content: parts, ...(result.ok ? {} : { isError: true }) },
      denied: false,
      stop: false,
    };
  }
  return { toolResult: toolResultBlock(callId, content, !result.ok), denied: false, stop: false };
}

/** Redact secret content from the persisted result (the model still sees the real output). */
function redactedForLog<I>(session: Session, tool: Tool<I>, result: ToolResult, decision: PolicyDecision): ToolResult {
  if (tool.redactForLog) return tool.redactForLog(result, session.saltHex);
  if (decision.redactOutput && result.output) return { ...result, output: redactSecret(result.output, session.saltHex) };
  return result;
}

/** Defensive spill ceiling — the exec capture cap already bounds real inputs well below this. */
const SPILL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Preserve truncated-away tool output as a content-addressed blob (Session 11.5). Opt-in per
 * tool via the transient ToolResult.fullOutput (run_command + delegate only — file reads are
 * recoverable from the files themselves); skipped whenever ANY redaction applies (redacted
 * outputs are deliberately non-replayable and must never persist un-redacted); never fails
 * the turn. Returns true only when the blob verifiably landed under the recorded sha.
 */
function spillFullOutput<I>(session: Session, tool: Tool<I>, result: ToolResult, decision: PolicyDecision): boolean {
  if (result.fullOutput === undefined || result.fullOutputSha256 === undefined || !result.truncated) return false;
  if (tool.redactForLog !== undefined || decision.redactOutput === true) return false;
  try {
    const bytes = Buffer.from(result.fullOutput, 'utf8');
    if (bytes.byteLength > SPILL_MAX_BYTES) return false;
    // putBlob hashes the bytes itself; equality with the tool-reported sha is the honesty check
    // (both sides digest the same utf8 string — pinned by test).
    return session.snapshots.putBlob(bytes) === result.fullOutputSha256;
  } catch {
    return false;
  }
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
