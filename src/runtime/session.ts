import fs from 'node:fs';
import path from 'node:path';
import type {
  ApprovalRequest,
  ChatMessage,
  ContentBlock,
  PolicyDecision,
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
import type { Approver } from '../types.js';

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
  clock: Clock;
}

export interface TurnResult {
  finalText: string;
  stopReason: StopReason;
  denials: number;
  steps: number;
  /** True when the user chose "deny & stop" or the step budget was exhausted. */
  stopped: boolean;
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
  argv?: string[];
  tools?: Tool[];
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
  return base;
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
  for (const e of events) {
    if (e.type === 'tool.completed') completedBy.set(e.callId, e);
    else if (e.type === 'file.mutated') (mutatedBy.get(e.callId) ?? mutatedBy.set(e.callId, []).get(e.callId)!).push(e);
    else if (e.type === 'snapshot.created') snapBy.add(e.callId);
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

/**
 * Run the agent loop for one user message until the model stops calling tools (or the step budget
 * is spent). Every tool call is gated through the single policy engine, mutations are snapshotted,
 * and structured evidence is appended to the log.
 */
export async function runTurn(session: Session, userText: string): Promise<TurnResult> {
  session.log.append({ type: 'user.message', text: userText });
  session.messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });

  const ctx: ToolContext = { workspaceRoot: session.workspaceRoot, stateDir: session.stateDir };
  let denials = 0;
  let steps = 0;
  let finalText = '';
  let lastStop: StopReason = 'end_turn';

  for (; steps < session.maxSteps; steps++) {
    const req: ProviderRequest = {
      model: session.model,
      system: session.system,
      messages: session.messages,
      tools: session.tools.map(toToolSchema),
      maxTokens: session.maxTokens,
    };
    const turn = await session.provider.complete(req, session.onText);
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

    const toolResults: ContentBlock[] = [];
    let stopRequested = false;
    for (const tu of toolUses) {
      const r = await executeCall(session, ctx, tu, stopRequested);
      toolResults.push(r.toolResult);
      if (r.denied) denials++;
      if (r.stop) stopRequested = true;
    }
    session.messages.push({ role: 'user', content: toolResults });
    if (stopRequested) return { finalText, stopReason: lastStop, denials, steps: steps + 1, stopped: true };
  }

  const stopped = steps >= session.maxSteps;
  return { finalText, stopReason: lastStop, denials, steps, stopped };
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
  forceDeny: boolean,
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
    if (forceDeny) {
      session.log.append({ type: 'approval.resolved', callId, decision: 'deny', scope: 'once', source: 'user' });
      session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: 'skipped (session stopped)', durationMs: 0, truncated: false });
      return { toolResult: toolResultBlock(callId, 'denied: session stopped by user', true), denied: true, stop: false };
    }
    const req = buildApprovalRequest(tool, input, decision, callId);
    const outcome = await session.approver(req);
    session.log.append({ type: 'approval.resolved', callId, decision: outcome.decision, scope: outcome.scope, source: outcome.source });
    if (outcome.decision !== 'allow') {
      session.log.append({ type: 'tool.completed', callId, ok: false, outputPreview: 'denied by user', durationMs: 0, truncated: false });
      return { toolResult: toolResultBlock(callId, 'denied by user', true), denied: true, stop: outcome.decision === 'deny-stop' };
    }
    if (outcome.scope === 'session') session.grants.add(tool.name, decision.classification);
  }

  return await runExecution(session, ctx, tool, input, decision, callId);
}

function buildApprovalRequest<I>(tool: Tool<I>, input: I, decision: PolicyDecision, callId: string): ApprovalRequest {
  const { summary, detail } = describeCall(tool, input);
  const base: ApprovalRequest = {
    callId,
    tool: tool.name,
    classification: decision.classification,
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

  const result = await tool.execute(input, ctx);

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
