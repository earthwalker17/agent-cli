import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalRequest,
  ArtifactEvidence,
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
  RemoteEvidence,
  RemoteReadFact,
  RemoteWriteFact,
  RepairEvidence,
  ResearchEvidence,
  ResearchFact,
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
import { sanitizeLine } from '../shared/text.js';
import { scrubSecrets } from '../shared/secrets.js';
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
  /**
   * Present only for subagent child sessions: who spawned this session and as what role — the
   * same value recorded on `session.started`. Carried on the live session (Session 19) because
   * the policy engine reads it through `ToolContext.lineage` to admit a researcher child's
   * external reads. It is runtime state stamped at construction, never derived from model input.
   */
  lineage?: { parentSessionId: string; role: string };
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
  /**
   * Latch: the steady-state "history exceeds the target even fully elided" condition has been
   * recorded (S20.5). Resets when the pressure recedes, so a genuine re-crossing warns again.
   */
  exhaustedRecorded?: boolean;
  clock: Clock;
}

export interface TurnResult {
  finalText: string;
  stopReason: StopReason;
  denials: number;
  steps: number;
  /** True when the user chose "deny & stop", the turn was aborted, or the step budget was exhausted. */
  stopped: boolean;
  /**
   * True when the stop CAUSE was the user's deny-&-stop. Explicit because it can COINCIDE with
   * the step budget: a deny-stop on the final allowed step used to read as 'max-steps' (and a
   * child's as 'budget-steps' — a genuine failure spent against the R10 retry ceiling), turning
   * a human intervention into an accounting event (S20.5 review).
   */
  userStopped?: boolean;
  /** True when the turn ended because the caller's AbortSignal fired (e.g. Ctrl+C in the REPL). */
  aborted: boolean;
}

/**
 * Tool calls one turn may make before the loop stops and reports `max-steps` (S16: 20→40;
 * S20.5: 40→60).
 *
 * 20 was set when a task meant "edit a few files and run the tests". A dependency-bearing
 * full-stack turn is detect → install ×2 → write .env → migrate → seed → build → start two
 * previews → check each project → drive a browser flow — and with research, documents, and
 * remote delivery now real, one coherent instruction legitimately spans more steps than the
 * v1.2 shape did. Still a hard ceiling, still reported honestly, still overridable with
 * --max-steps (config ceiling 400).
 *
 * ONE exported constant: this default was written twice (here and in the CLI context builder),
 * which is how the library and the CLI quietly come to disagree about what a turn is.
 */
export const DEFAULT_MAX_STEPS = 60;

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
  // Session 19: the SAME value that goes onto session.started, so the live session and its
  // recorded provenance can never disagree about what role this child is.
  if (opts.lineage) base.lineage = opts.lineage;
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
  // Elision monotonicity must survive the resume: the sticky sets were process memory only, so a
  // resumed session could put outputs back on the wire that the log records as permanently
  // elided (e.g. after a /model switch raised the trigger, or because reconstruct rebuilds
  // smaller content) — every sibling counter is rebuilt from events; this one silently reset
  // (S20.5 review). Seeded from the same context.compacted events that recorded the elisions.
  const priorElided = new Set<string>();
  const priorImageElided = new Set<string>();
  for (const e of log.events) {
    if (e.type !== 'context.compacted') continue;
    for (const id of e.newlyElidedCallIds ?? []) priorElided.add(id);
    for (const id of e.newlyImageElidedCallIds ?? []) priorImageElided.add(id);
  }
  if (priorElided.size > 0) session.elidedCallIds = priorElided;
  if (priorImageElided.size > 0) session.imageElidedCallIds = priorImageElided;
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
  // The user's deny-&-stop wins over a coinciding step-budget exhaustion: the CAUSE is explicit
  // on the result, never inferred from step arithmetic (S20.5).
  if (result.stopped && result.userStopped === true) return 'user-quit';
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
    // Session 19: this is the context `decide()` reads, so the research branch's delegated-role
    // admission depends on lineage being HERE, not only on the execute-time context. Stamped by
    // startSession from the same value that lands on session.started; absent for a parent.
    ...(session.lineage !== undefined ? { lineage: session.lineage } : {}),
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
      if (elision.exhausted) session.exhaustedRecorded = true;
    } else if (elision.exhausted && session.exhaustedRecorded !== true) {
      // Steady-state exhaustion: once every candidate is elided, the set stops growing while
      // UN-ELIDABLE content (assistant text, reasoning payloads) keeps growing the history — the
      // old growth-gated condition then never fired again, and the session degraded silently
      // until the provider hard-failed with a context-window error (S20.5 review). Record it
      // ONCE per crossing; the latch resets below if the pressure genuinely recedes.
      session.exhaustedRecorded = true;
      session.log.append({
        type: 'context.compacted',
        elidedCount: elision.elidedCallIds.length,
        newlyElidedCallIds: [],
        rawChars: elision.rawChars,
        sentChars: elision.sentChars,
        exhausted: true,
      });
    }
    if (!elision.exhausted) session.exhaustedRecorded = false;
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
    if (stopRequested) return { finalText, stopReason: lastStop, denials, steps: steps + 1, stopped: true, userStopped: true, aborted: false };
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
  const mutatedBy = new Set<string>();
  const snapBy = new Set<string>();
  const spawnedBy = new Set<string>();
  for (const e of session.log.events) {
    if (e.type === 'tool.completed') completedBy.set(e.callId, e);
    else if (e.type === 'file.mutated') mutatedBy.add(e.callId);
    else if (e.type === 'snapshot.created') snapBy.add(e.callId);
    else if (e.type === 'command.started' || e.type === 'check.started' || e.type === 'setup.started') spawnedBy.add(e.callId);
  }
  // The appended completion SHADOWS reconstruct's own classification on every later resume
  // (resultFor consults completions first), so it must tell the same truth reconstruct would:
  // "never ran" was claimed for calls that had already snapshotted, written bytes, or spawned a
  // process (S20.5 review — the throwing-after-write class is real; artifact-render documents it).
  const messageFor = (id: string): string => {
    if (mutatedBy.has(id)) return 'interrupted mid-call AFTER file changes were recorded — the writes are on disk and covered by /undo; verify before retrying';
    if (snapBy.has(id)) return 'interrupted after a pre-write snapshot; the write may or may not have reached disk — verify before retrying';
    if (spawnedBy.has(id)) return 'interrupted after this call spawned a process; its effects are unknown — verify before retrying';
    return 'interrupted: the turn failed before this call ran';
  };

  const results = uses.map((u) => {
    const done = completedBy.get(u.id);
    if (done) return toolResultBlock(u.id, done.outputPreview, !done.ok);
    const message = messageFor(u.id);
    session.log.append({
      type: 'tool.completed',
      callId: u.id,
      ok: false,
      outputPreview: message,
      durationMs: 0,
      truncated: false,
    });
    return toolResultBlock(u.id, message, true);
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
    // `tool.remoteWrite === undefined` too (Session 20), and this one is the strongest case in the
    // list. A publish is classified `external` (grantable) when it is not overwriting, and the
    // remote-write branch deliberately never consults a grant — so without this exclusion a typed
    // `s` would store `(remote_push, external)` that nothing reads. Worse than a dead grant: the
    // user would believe they had authorized "publishing this session", which is exactly the
    // standing authority this capability is built to withhold. The prompt offers no [s] for a
    // remote write; the storage site is told the same thing, in the same place as its siblings.
    if (outcome.scope === 'session' && tool.command === undefined && tool.check === undefined && tool.remoteWrite === undefined) {
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

/** Persist a tool-reported task lifecycle fact under the runtime-bound callId (mirrors commands). Exported for tests. */
export function recordTaskEvidence(session: Session, callId: string, e: TaskEvidence): void {
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
        ...(e.role !== undefined ? { role: e.role } : {}),
        ...(e.approvalWaitMs !== undefined ? { approvalWaitMs: e.approvalWaitMs } : {}),
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
    case 'approval-resolved':
      session.log.append({ type: 'approval.resolved', callId, decision: e.decision, scope: e.scope, source: e.source });
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

/** Persist a tool-reported document-artifact fact under the runtime-bound callId (Session 17). */
function recordArtifactEvidence(session: Session, callId: string, e: ArtifactEvidence): void {
  if (e.kind === 'rendered') {
    // Findings are bounded AT THE EMIT SITE: they quote model-authored spec text and extracted
    // document text, and an unbounded list would put untrusted bytes into the log at volume.
    const findings = e.validation.findings.slice(0, 12).map((f) => (f.length > 300 ? `${f.slice(0, 300)}…` : f));
    session.log.append({
      type: 'artifact.rendered',
      callId,
      format: e.format,
      path: e.path,
      ...(e.absPath !== undefined ? { absPath: e.absPath } : {}),
      sha256: e.sha256,
      bytes: e.bytes,
      ...(e.pages !== undefined ? { pages: e.pages } : {}),
      specPath: e.specPath,
      specSha256: e.specSha256,
      validation: {
        status: e.validation.status,
        findings,
        // Carried whole, never derived from the SLICED list — the count is the honest number.
        failureCount: e.validation.failureCount,
        summary: e.validation.summary.slice(0, 400),
      },
      ...(e.embeddedWorkspaceImages === true ? { embeddedWorkspaceImages: true as const } : {}),
      durationMs: e.durationMs,
    });
    return;
  }
  if (e.kind === 'render-failed') {
    session.log.append({
      type: 'artifact.render-failed',
      callId,
      specPath: e.specPath,
      reasons: e.reasons.slice(0, 12).map((r) => (r.length > 300 ? `${r.slice(0, 300)}…` : r)),
      durationMs: e.durationMs,
    });
    return;
  }
  session.log.append({
    type: 'artifact.inspected',
    callId,
    path: e.path,
    sha256: e.sha256,
    source: e.source,
    pages: e.pages,
    warnings: e.warnings.slice(0, 12).map((w) => (w.length > 300 ? `${w.slice(0, 300)}…` : w)),
  });
}

/**
 * Persist a tool-reported external-read fact under the runtime-bound callId (Session 19).
 *
 * Every model-authored and provider-authored string is bounded AT THE EMIT SITE, for the reason
 * the artifact recorder states: this is untrusted text entering the durable log, and the log is
 * read back by `/report`, the journal, and a human. The query is kept whole up to a generous cap
 * because a truncated query would make the record unable to answer the one question it exists to
 * answer — what actually left this machine.
 */
function recordResearchEvidence(session: Session, callId: string, e: ResearchEvidence): void {
  const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  if (e.kind === 'searched') {
    session.log.append({
      type: 'research.searched',
      callId,
      provider: e.provider,
      // Sanitized like every other string here. The query is model-authored and is written
      // verbatim by /report and /research, neither of which escapes at the render site.
      query: cap(sanitizeLine(e.query), 1_000),
      resultCount: e.resultCount,
      hosts: [...new Set(e.hosts)].slice(0, 20).map((h) => cap(h, 260)),
      refused: e.refused.slice(0, 10).map((r) => ({ url: cap(r.url, 260), reason: cap(r.reason, 200) })),
      credits: e.credits,
      contentChars: e.contentChars,
      durationMs: e.durationMs,
      ...(e.requestId !== undefined ? { requestId: cap(e.requestId, 80) } : {}),
    });
    return;
  }
  if (e.kind === 'extracted') {
    session.log.append({
      type: 'research.extracted',
      callId,
      provider: e.provider,
      urls: e.urls.slice(0, 20).map((u) => cap(u, 260)),
      pageCount: e.pageCount,
      failed: e.failed.slice(0, 20).map((f) => ({ url: cap(f.url, 260), reason: cap(f.reason, 200) })),
      credits: e.credits,
      contentChars: e.contentChars,
      durationMs: e.durationMs,
      ...(e.requestId !== undefined ? { requestId: cap(e.requestId, 80) } : {}),
    });
    return;
  }
  if (e.kind === 'findings') {
    session.log.append({
      type: 'research.findings',
      callId,
      childSessionId: e.childSessionId,
      notes: e.notes,
    });
    return;
  }
  // 'usage': the cross-log accounting record. A researcher spends the session budget from inside
  // a CHILD session with its own event log, so without this capture in the PARENT log a resumed
  // session would rebuild a budget that had silently refilled.
  session.log.append({
    type: 'research.usage',
    callId,
    childSessionId: e.childSessionId,
    searches: e.searches,
    extracts: e.extracts,
    credits: e.credits,
    contentChars: e.contentChars,
  });
}

/**
 * Persist a tool-reported remote Git/GitHub fact under the runtime-bound callId (Session 20).
 *
 * Two rules apply here that apply nowhere else in this file:
 *
 *  - Every string is scrubbed of credential shapes as well as sanitized. The pack scrubs at its own
 *    boundary already; this is the second pass, at the emit site, because the event log is
 *    append-only and a credential written into it cannot be taken back out.
 *  - `verified` is recorded as a distinct field from `ok`. A command that succeeded and could not
 *    be confirmed is a real state, and it must stay distinguishable from a confirmed one forever —
 *    prose in a summary would round it up to "published".
 */
function recordRemoteEvidence(session: Session, callId: string, e: RemoteEvidence): void {
  const s = (v: string, n = 260): string => {
    const t = sanitizeLine(scrubSecrets(v));
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  if (e.kind === 'inspected') {
    session.log.append({
      type: 'remote.inspected',
      callId,
      operation: s(e.operation, 40),
      host: s(e.host, 253),
      target: s(e.target),
      ...(e.account !== undefined ? { account: s(e.account, 80) } : {}),
      ok: e.ok,
      ...(e.itemCount !== undefined ? { itemCount: e.itemCount } : {}),
      ...(e.observationId !== undefined ? { observationId: s(e.observationId, 40) } : {}),
      ...(e.detail !== undefined ? { detail: s(e.detail, 400) } : {}),
      durationMs: e.durationMs,
    });
    return;
  }
  session.log.append({
    type: 'remote.mutated',
    callId,
    operation: s(e.operation, 40),
    host: s(e.host, 253),
    target: s(e.target),
    exactTarget: s(e.exactTarget),
    ...(e.account !== undefined ? { account: s(e.account, 80) } : {}),
    ...(e.beforeOid !== undefined ? { beforeOid: e.beforeOid === null ? null : s(e.beforeOid, 64) } : {}),
    ...(e.afterOid !== undefined ? { afterOid: e.afterOid === null ? null : s(e.afterOid, 64) } : {}),
    ...(e.url !== undefined ? { url: s(e.url, 400) } : {}),
    overwrote: e.overwrote,
    ok: e.ok,
    verified: e.verified,
    ...(e.detail !== undefined ? { detail: s(e.detail, 400) } : {}),
    durationMs: e.durationMs,
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
        : // Session 19: a fourth distinct CONSEQUENCE the generic header cannot state. Checks and
          // setups run code here; this one sends text away from here, and the prompt has to say so
          // in its own words rather than borrowing "[external]" and hoping.
          //
          // The rule check is not redundant with the fact check: SPAWNING a researcher is decided
          // in the delegation branch, so `delegate_task` carries no research fact — and the live
          // S19 run showed that ask rendering as a bare "[external] delegate_task" offering "[s]
          // allow for the rest of this session", which is precisely the wording this kind exists
          // to replace. Both doors, one kind.
          tool.research !== undefined || decision.rule.startsWith('task.research-role')
          ? { kind: 'research' as const }
          : // Session 20: two more kinds, and they are two rather than one with a mode for the
            // same reason the policy facts are two — the prompts must not be able to look alike.
            // A read offers `[s]` bounded by the session read allowance; a write offers no `[s]`
            // at all and leads with the destination it is about to change.
            tool.remoteRead !== undefined
            ? { kind: 'remote-read' as const }
            : tool.remoteWrite !== undefined
              ? { kind: 'remote-write' as const }
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
  // Bounded external reads (Session 19): the same argument as typed checks, one step further out.
  // A check's prompt must show the command because consent binds that command; a research prompt
  // must show the QUERY OR THE URLS because they are the thing that leaves the machine. Without
  // this branch the call falls through to the bare `${tool.name}` form with an empty detail, and
  // "allow web_search?" is not a question anyone can answer.
  if (tool.research !== undefined) {
    let fact: ResearchFact | undefined;
    try {
      fact = tool.research(input);
    } catch {
      fact = undefined;
    }
    if (fact !== undefined) {
      const b = fact.bounds;
      const common = [
        // "the only host contacted" was false whenever a proxy is configured — the connection goes
        // to the proxy, which sees the request (S19 review). The honest claim is about the
        // DESTINATION, which is what a human is deciding about; the transport is a separate fact
        // the banner already prints.
        `provider: ${fact.providerHost} (the only research destination; a configured proxy still carries the connection)`,
        `bounds: ≤${String(b.maxContentChars)} retrieved chars · ${String(b.timeoutMs)} ms · ~${String(b.credits)} credit(s)`,
        ...(fact.budgetRemaining !== undefined ? [`session budget remaining: ${fact.budgetRemaining}`] : []),
      ];
      if (fact.kind === 'search') {
        const q = fact.query ?? '';
        return {
          summary: `${tool.name}: "${q.slice(0, 100)}" → ${fact.providerHost}`,
          detail: [
            `query (sent verbatim): ${q}`,
            ...(fact.domains !== undefined && fact.domains.length > 0 ? [`domains: ${fact.domains.join(', ')}`] : []),
            `max results: ${String(b.maxResults ?? 0)}`,
            ...common,
          ].join('\n'),
        };
      }
      const urls = (fact.targets ?? []).map((t) => t.url);
      return {
        summary: `${tool.name}: ${String(urls.length)} page(s) via ${fact.providerHost}`,
        detail: [...urls.map((u) => `fetch: ${u}`), ...common].join('\n'),
      };
    }
  }
  // Remote delivery (Session 20). Same argument as checks and research, at the highest stakes in
  // the harness: the prompt must show the exact DESTINATION and the machine-derived EFFECT,
  // because "allow remote_push?" is a question nobody can answer. Everything rendered here is
  // harness-composed — the argv, the effect lines, the observation age — so what the human reads
  // is what the tool will run, not a description of it.
  if (tool.remoteRead !== undefined) {
    let fact: RemoteReadFact | undefined;
    try {
      fact = tool.remoteRead(input);
    } catch {
      fact = undefined;
    }
    if (fact !== undefined) {
      return {
        summary: `${tool.name}: ${sanitizeLine(fact.operation)} ← ${sanitizeLine(fact.target.display)}`,
        detail: [
          `destination: ${sanitizeLine(fact.target.display)}`,
          `command: ${sanitizeLine(fact.argvPreview)}`,
          `bounds: ${fact.bounds.maxItems !== undefined ? `≤${String(fact.bounds.maxItems)} item(s) · ` : ''}${String(fact.bounds.timeoutMs)} ms`,
          ...(fact.budgetRemaining !== undefined ? [`session remote allowance remaining: ${fact.budgetRemaining}`] : []),
        ].join('\n'),
      };
    }
  }
  if (tool.remoteWrite !== undefined) {
    let fact: RemoteWriteFact | undefined;
    try {
      fact = tool.remoteWrite(input);
    } catch {
      fact = undefined;
    }
    if (fact !== undefined) {
      // Order is load-bearing (S20 review). The renderer caps detail lines and drops the TAIL, and
      // `effect` can be long, so the three lines a human cannot answer without — where, what, and
      // the exact command — go FIRST. Every value is sanitized here as well as at its source: a
      // model-authored title carrying a newline would otherwise inject lines that look
      // harness-authored and push the truthful ones off the end.
      const s = (v: string): string => sanitizeLine(v);
      const MAX_EFFECT_LINES = 6;
      const effects = fact.effect.slice(0, MAX_EFFECT_LINES).map((l) => `effect: ${s(l)}`);
      if (fact.effect.length > MAX_EFFECT_LINES) effects.push(`effect: …${String(fact.effect.length - MAX_EFFECT_LINES)} further effect line(s)`);
      return {
        summary: `${tool.name}: ${s(fact.operation)} → ${s(fact.exactTarget)} on ${s(fact.target.display)}`,
        detail: [
          `destination: ${s(fact.target.display)}`,
          `exact target: ${s(fact.exactTarget)}`,
          `command: ${s(fact.argvPreview)}`,
          ...effects,
          ...(fact.observation !== undefined
            ? [
                `observed ${String(Math.round(fact.observation.ageMs / 1000))}s ago (id ${s(fact.observation.id)}): remote held ${s(fact.observation.remoteOid ?? '(absent)')}`,
              ]
            : []),
          ...(fact.localEvidence !== undefined ? [`local verification: ${s(fact.localEvidence)}`] : []),
          ...(fact.budgetRemaining !== undefined ? [`session remote allowance remaining: ${s(fact.budgetRemaining)}`] : []),
        ].join('\n'),
      };
    }
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
    reportArtifact: (e) => recordArtifactEvidence(session, callId, e),
    reportResearch: (e) => recordResearchEvidence(session, callId, e),
    reportRemote: (e) => recordRemoteEvidence(session, callId, e),
    // Session 19: the child's own lineage, so the policy engine can tell a researcher subagent's
    // call from a parent's. Runtime state stamped at startSession — never tool state, never model
    // input, absent entirely for a parent session.
    ...(session.lineage !== undefined ? { lineage: session.lineage } : {}),
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
      // Absent before AND absent after (readback did not fail) = the tool declared a target it
      // then legitimately never wrote — e.g. a PDF output skipped on a browserless machine
      // (S17). A mutation event must describe a mutation; recording a phantom 'create' with a
      // null post-state gave /diff a created file that does not exist.
      if (cf.beforeSha256 === null && afterSha256 === null && readFailed === null) continue;
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
const SPILL_MAX_BYTES = 8 * 1024 * 1024;

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
