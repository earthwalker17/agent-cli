import type { CommandTermination, SessionEvent } from '../types.js';
import type { PlanGraph } from '../plan/schema.js';
import { foldRepairs } from '../recovery/ledger.js';
import { foldReview } from '../review/ledger.js';

/**
 * The deterministic evidence report: a PURE function from the event log to a structured object
 * and a Markdown rendering. No filesystem I/O, no model — identical events produce byte-identical
 * output (golden-testable). This is constitution principles 1 and 8 made executable: only recorded
 * tool events count as evidence, and "CHECKED" means a command OR a typed check exited zero AFTER
 * a change, nothing more. (Session 12 widened the source, never the claim: a typed check's `pass`
 * is derived from the same `exited && exitCode === 0` rule, so the two are the same evidence.)
 */

export interface ReportAction {
  callId: string;
  tool: string;
  classification: string;
  decision: string;
  rule: string;
  ok: boolean | null;
  exitCode?: number;
  durationMs: number;
}
export interface ReportFile {
  path: string;
  kind: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  snapshotRecorded: boolean;
  checked: boolean;
  checkedBy?: string;
  /** Session churn on this path, summed across its mutations (V0.5 logs; absent for binary/huge). */
  linesAdded?: number;
  linesRemoved?: number;
}
export interface ReportCommand {
  command: string;
  ok: boolean;
  exitCode?: number;
  durationMs: number;
  /** How the command ended, when the log carries command.ended evidence (V0.3+ logs). */
  termination?: CommandTermination;
  /** True when command.started exists but the call never completed (session died while it ran). */
  neverCompleted?: boolean;
  /** The truncated-away captured output survives as objects/<sha> (Session 11.5 logs). */
  outputBlobSha256?: string;
  /** The execution boundary this command actually ran under (V0.4+ logs). */
  sandbox?: 'none' | 'windows-lowil';
}
export interface ReportPreview {
  previewId: string;
  recipeId: string;
  command: string;
  pid: number;
  ready: boolean;
  url?: string;
  probeDetail?: string;
  end?: { reason: string; exitCode: number | null };
  logFile?: string;
  /** Started, never ended, and the log holds no session end either — the crash-orphan shape. */
  neverEnded: boolean;
}
export interface ReportBrowserFlow {
  flowName: string;
  previewId: string;
  status: string;
  stepsOk: number;
  stepsTotal: number;
  failures: { n: number; kind: string; target?: string; failureClass: string; detail: string }[];
  artifacts: { kind: string; sha256: string; bytes: number; label: string }[];
  consoleErrors: number;
  pageErrors: number;
  failedRequests: number;
  offOriginRequests: number;
  finalUrl: string | null;
  traceOmittedBytes?: number;
}
export interface ReportCheck {
  check: string;
  recipeId: string;
  /** Empty for an unsupported kind — nothing was resolved and nothing ran. */
  command: string;
  status: string;
  exitCode: number | null;
  termination?: CommandTermination;
  durationMs: number;
  summary: string;
  signals?: string[];
  findings?: { file?: string; line?: number; message: string }[];
  /** The plan task this run was declared against — a label recorded with the evidence. */
  planTaskId?: string;
  scopePaths?: string[];
  /** check.started with no completion: the session died while the check ran; NO verdict exists. */
  neverCompleted?: boolean;
  /** Session 16: which project unit this verified. Absent = the root/only project. */
  projectId?: string;
}
/** A dependency install, migration or seed (Session 16, additive). Never verification. */
export interface ReportSetup {
  action: string;
  projectId: string;
  recipeId: string;
  command: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  termination?: CommandTermination;
  durationMs: number;
  summary: string;
  signals?: string[];
  lockfile?: string;
  /** setup.started with no completion: the session died mid-install; the state is UNKNOWN. */
  neverCompleted?: boolean;
}
export interface ReportRepair {
  kind: 'attempt' | 'escalation';
  target: string;
  failureClass: string;
  signature: string;
  /** attempts only. */
  attempt?: number;
  hypothesis?: string;
  scopePaths?: string[];
  regressionChecks?: string[];
  /** Derived, never recorded: proven by its regression checks, superseded, or still open. */
  outcome?: 'succeeded' | 'superseded' | 'open';
  pendingChecks?: string[];
  outOfScope?: string[];
  /** escalations only. */
  reason?: string;
  open?: boolean;
}
export interface ReportSandbox {
  mode: string;
  enforced: boolean;
  summary: string;
  confines: string[];
  doesNotConfine: string[];
}
export interface ReportGit {
  isRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  dirtyCount: number | null;
  probeFailed: boolean;
  /** The probed one-line summary — state AT SESSION START, not at report time. */
  detail: string;
}
export interface ReportJson {
  session: {
    id: string;
    workspaceRoot: string;
    /** The FINAL (newest-wins) identity; `modelsUsed` lists every identity when it changed. */
    model: string;
    mode: string;
    providerName: string;
    /** Present only when more than one provider/model identity served the session (Session 15). */
    modelsUsed?: { providerName: string; model: string }[];
    endedReason: string | null;
    resumes: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
    /** The active execution sandbox for the session (V0.4+ logs). */
    sandbox?: ReportSandbox;
    /** The probed git context at session start (V0.5+ logs). */
    git?: ReportGit;
  };
  tasks: string[];
  actions: ReportAction[];
  filesChanged: ReportFile[];
  commands: ReportCommand[];
  approvals: { callId: string; decision: string; scope: string; source: string }[];
  undos: { target: string; restored: number; refused: { path: string; reason: string }[] }[];
  /** Deliberate user-commanded commits recorded during the session (V0.5 logs). */
  gitCommits: { oid: string; subject: string; files: number; scope: string; trailer: boolean }[];
  /** User-commanded recovery checkpoints (hidden refs) captured during the session (V0.5 logs). */
  gitCheckpoints: { ref: string; oid: string; label: string | null; filesChanged: number }[];
  /** Harness-created executor-group base checkpoints (Session 11.5, additive) — plumbing, not
   *  user consent provenance; pruned at clean session end (a crash leaves them until the next
   *  resumed quit or `agent checkpoint prune`). */
  taskBaseCheckpoints: { ref: string; oid: string }[];
  /** User-commanded checkpoint restores (each an undoable batch; V0.5 logs). */
  gitRestores: { ref: string; oid: string; restored: number; refused: { path: string; reason: string }[] }[];
  /** The latest user /accept (Session 11.5, additive) — the explicit completion boundary. */
  accepted?: {
    complete: boolean;
    summary: string;
    unfinished?: string[];
    /** The delivery ref this acceptance CONSUMED (S14.5, additive) — the identity that actually
     *  survives session-end pruning. Consumers must prefer it over the newest creation event,
     *  which a phantom (event appended, update-ref failed) can hold. */
    deliveryRef?: string;
    deliveryOid?: string;
  };
  /** Typed check runs (Session 12, additive), in order. `neverCompleted` = spawned, no verdict. */
  checks?: ReportCheck[];
  /** Project setup (Session 16, additive): installs, migrations, seeds. Absent when none ran. */
  setups?: ReportSetup[];
  /** Bounded repair attempts and escalations (Session 12, additive); outcomes are DERIVED. */
  repairs?: ReportRepair[];
  /** Managed preview processes (Session 13, additive), in start order. */
  previews?: ReportPreview[];
  /** Browser verification flows (Session 13, additive), in run order. */
  browserFlows?: ReportBrowserFlow[];
  /** Harness workflow-transition checkpoints (Session 14, additive): pre-integration +
   *  delivery. The ref scan (`agent checkpoint list`) is live truth — a recorded creation
   *  whose ref is absent was pruned, superseded, or never landed (a phantom). */
  harnessCheckpoints?: { kind: 'pre-integration' | 'delivery'; ref: string; oid: string; pruned?: boolean }[];
  /** The structural review gate's recorded evidence (Session 14, additive): rounds, findings
   *  with DERIVED triage status, caveats. Statuses come from the same fold acceptance reads. */
  review?: ReportReview;
  /** Delegated subagent tasks (V0.6). Child usage lives here and in the child's own log — it is
   *  NOT included in this session's usage totals. status null = never completed (crash/abort). */
  tasksDelegated: {
    callId: string;
    role: string;
    childSessionId: string;
    status: string | null;
    /** The approved-plan task this child executed (Session 11, additive). */
    planTaskId?: string;
    steps?: number;
    usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
    resultSha256?: string;
  }[];
  /** Plan-document lifecycle (V0.7): every write plus the user's approval/discard consent records.
   *  Optional-additive: old readers and hand-built fixtures stay valid; buildReport always sets it. */
  plan?: ReportPlan | null;
  /** Executor change capture + integration outcomes (V0.7, optional-additive). */
  taskChanges?: { childSessionId: string; baseOid: string; files: number; oversize: number; omitted: number }[];
  taskApplies?: { childSessionId: string; applied: number; refused: { relPath: string; reason: string }[] }[];
  integrity: { truncatedTail: boolean; corruptAt?: { line: number; kind: string } };
}

export interface ReportReview {
  /** Present when the caller supplied the approved graph (S14.5): the gate's requirement. */
  requirement?: string;
  /** Open gate blockers at the end of the log (S14.5) — additive; old consumers unaffected. */
  blockers?: string[];
  rounds: { callId: string; lenses: number; captured: number; deadLenses: string[]; findings: number; qualifying: boolean; note?: string }[];
  findings: {
    findingId: string;
    severity: string;
    title: string;
    paths: string[];
    confidence: string;
    status: string;
    blocking: boolean;
    lens?: string;
    evidence: string;
    scenario: string;
    triage: { action: string; evidence: string; refs?: string[]; effective: boolean; note?: string }[];
  }[];
  caveats: string[];
}

export interface ReportPlan {
  planId: string;
  updates: number;
  lastSha256: string | null;
  approvedSha256: string | null;
  discarded: boolean;
  /** 'accepted' when the retirement came from /accept, not a user /plan discard (Session 11.5). */
  discardedReason?: 'accepted';
  /** How this session's complexity was routed (Session 11, additive): the first plan.route event. */
  route?: { mode: 'plan' | 'direct'; source: 'user-sigil' | 'model' } | null;
  /** Task count of the latest structured plan write (Session 11, additive; null for legacy plans). */
  taskCount?: number | null;
}

export interface ReportInput {
  events: readonly SessionEvent[];
  truncatedTail?: boolean;
  corruptAt?: { line: number; kind: string };
  /**
   * The APPROVED-AND-CURRENT plan graph, when the caller has one (S14.5). The report stays a
   * pure function — the graph is an input, never a file read — but without it the review
   * REQUIREMENT could not be derived, so an unaccepted session's report showed findings and
   * rounds while never saying the gate itself was unsatisfied (`## Completion` renders
   * acceptance blockers only for sessions that recorded an acceptance).
   */
  approvedGraph?: PlanGraph | null;
}

function short(h: string | null): string {
  return h === null ? '∅' : h.slice(0, 8);
}

export interface PassingEvidenceEntry {
  command: string;
  seq: number;
  exitCode?: number;
  ok: boolean;
  termination?: CommandTermination;
}

/**
 * S14.5 (F): THE CHECKED correlation's evidence set, extracted so the report and /diff share
 * ONE implementation — "CHECKED" must never mean two different things on two surfaces.
 * Commands that actually ran (denied/never-executed calls excluded), merged with passing typed
 * checks (whose `pass` is derived from the identical exited-0 rule), SORTED BY SEQ — `find`
 * takes the first entry after a mutation, so an unsorted concatenation would credit the wrong
 * evidence.
 */
export function collectPassingEvidence(events: readonly SessionEvent[]): PassingEvidenceEntry[] {
  const commandByCall = new Map<string, string>();
  const decisionByCall = new Set<string>();
  const neverRan = new Set<string>();
  const endedByCall = new Map<string, CommandTermination>();
  for (const e of events) {
    if (e.type === 'tool.requested' && e.tool === 'run_command') {
      const cmd = (e.input as { command?: unknown }).command;
      if (typeof cmd === 'string') commandByCall.set(e.callId, cmd);
    } else if (e.type === 'policy.decision') {
      decisionByCall.add(e.callId);
      if (e.decision === 'deny') neverRan.add(e.callId);
    } else if (e.type === 'approval.resolved') {
      if (e.decision !== 'allow') neverRan.add(e.callId);
    } else if (e.type === 'command.ended') {
      endedByCall.set(e.callId, e.termination);
    }
  }
  const out: PassingEvidenceEntry[] = [];
  for (const e of events) {
    if (e.type === 'tool.completed') {
      const cmd = commandByCall.get(e.callId);
      if (cmd === undefined || neverRan.has(e.callId) || !decisionByCall.has(e.callId)) continue;
      const term = endedByCall.get(e.callId);
      out.push({
        command: cmd,
        seq: e.seq,
        ok: e.ok,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(term !== undefined ? { termination: term } : {}),
      });
    } else if (e.type === 'check.completed' && e.status === 'pass') {
      out.push({
        command: `${e.check} check (${e.recipeId})`,
        seq: e.seq,
        ok: true,
        ...(e.exitCode !== null ? { exitCode: e.exitCode } : {}),
        ...(e.termination !== undefined ? { termination: e.termination } : {}),
      });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The exact CHECKED rule: the first evidence after `seq` that genuinely EXITED with code 0
 *  (a killed command has no exit code by contract; termination evidence enforces it). */
export function firstPassingEvidenceAfter(evidence: readonly PassingEvidenceEntry[], seq: number): PassingEvidenceEntry | undefined {
  return evidence.find((cc) => cc.seq > seq && cc.exitCode === 0 && (cc.termination === undefined || cc.termination === 'exited'));
}

/**
 * Newest-wins provider/model identity (Session 15): `session.started` seeds it and every
 * `provider.changed` overlays it — the same correction the endedReason fold got in S14.5.
 * `used` lists every distinct identity that served part of the session, in first-use order.
 */
export function effectiveIdentity(events: readonly SessionEvent[]): {
  current: { providerName: string; model: string } | null;
  used: { providerName: string; model: string }[];
} {
  let current: { providerName: string; model: string } | null = null;
  const used: { providerName: string; model: string }[] = [];
  // The TRANSITION SEQUENCE, not a set (S15 review finding): de-duplicating an A→B→A session to
  // [A, B] and rendering it with an arrow claimed the work ended on B while `current` said A.
  // Only a consecutive repeat is collapsed.
  const push = (id: { providerName: string; model: string }): void => {
    const last = used[used.length - 1];
    if (last !== undefined && last.providerName === id.providerName && last.model === id.model) return;
    used.push(id);
  };
  for (const e of events) {
    if (e.type === 'session.started') {
      current = { providerName: e.providerName, model: e.model };
      push(current);
    } else if (e.type === 'provider.changed') {
      current = { providerName: e.to.providerName, model: e.to.model };
      push(current);
    }
  }
  return { current, used };
}

export function buildReport(input: ReportInput): { json: ReportJson; md: string } {
  const { events } = input;

  const started = events.find((e) => e.type === 'session.started');
  const identity = effectiveIdentity(events);
  // The NEWEST lifecycle event decides how this log ended (S14.5 review finding): `find` took
  // the FIRST session.ended, so a session that quit cleanly, was resumed, and then CRASHED
  // reported "ended: user-quit" — and the preview section chose its benign wording — while the
  // current life died abnormally. Same predicate memory/load.ts uses for the crash note.
  const lifecycle = events.filter((e) => e.type === 'session.started' || e.type === 'session.resumed' || e.type === 'session.ended');
  const lastLifecycle = lifecycle[lifecycle.length - 1];
  const ended = lastLifecycle?.type === 'session.ended' ? lastLifecycle : undefined;
  const sandboxEvent = events.find((e) => e.type === 'sandbox.status');
  const gitEvent = events.find((e) => e.type === 'git.context');
  const commandByCall = new Map<string, string>();
  const toolByCall = new Map<string, string>();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let resumes = 0;

  for (const e of events) {
    if (e.type === 'tool.requested') {
      toolByCall.set(e.callId, e.tool);
      if (e.tool === 'run_command') {
        const cmd = (e.input as { command?: unknown }).command;
        if (typeof cmd === 'string') commandByCall.set(e.callId, cmd);
      }
    } else if (e.type === 'assistant.message') {
      usage.inputTokens += e.usage.inputTokens;
      usage.outputTokens += e.usage.outputTokens;
      usage.cacheReadInputTokens += e.usage.cacheReadInputTokens ?? 0;
      usage.cacheCreationInputTokens += e.usage.cacheCreationInputTokens ?? 0;
    } else if (e.type === 'session.resumed') {
      resumes++;
    }
  }

  const decisionByCall = new Map<string, Extract<SessionEvent, { type: 'policy.decision' }>>();
  const completedByCall = new Map<string, Extract<SessionEvent, { type: 'tool.completed' }>>();
  const startedByCall = new Map<string, Extract<SessionEvent, { type: 'command.started' }>>();
  const endedByCall = new Map<string, Extract<SessionEvent, { type: 'command.ended' }>>();
  const snapshotCalls = new Set<string>();
  const neverRan = new Set<string>(); // denied by policy or by the human — the call never executed
  for (const e of events) {
    if (e.type === 'policy.decision') {
      decisionByCall.set(e.callId, e);
      if (e.decision === 'deny') neverRan.add(e.callId);
    } else if (e.type === 'approval.resolved') {
      if (e.decision !== 'allow') neverRan.add(e.callId);
    } else if (e.type === 'tool.completed') completedByCall.set(e.callId, e);
    else if (e.type === 'command.started') startedByCall.set(e.callId, e);
    else if (e.type === 'command.ended') endedByCall.set(e.callId, e);
    else if (e.type === 'snapshot.created') snapshotCalls.add(e.callId);
  }

  // Actions in request order.
  const actions: ReportAction[] = [];
  for (const e of events) {
    if (e.type !== 'tool.requested') continue;
    const d = decisionByCall.get(e.callId);
    const c = completedByCall.get(e.callId);
    actions.push({
      callId: e.callId,
      tool: e.tool,
      classification: d?.classification ?? 'unknown',
      decision: d?.decision ?? 'unknown',
      rule: d?.rule ?? 'unknown',
      ok: c ? c.ok : null,
      ...(c?.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
      durationMs: c?.durationMs ?? 0,
    });
  }

  const commands: ReportCommand[] = [];
  for (const e of events) {
    if (e.type !== 'tool.completed') continue;
    const cmd = commandByCall.get(e.callId);
    if (cmd === undefined) continue;
    // "Commands run" means commands that EXECUTED. A denied call is visible under Actions and
    // Approvals; listing it here would read as if it ran. A call with NO policy.decision at all
    // never reached the gate (skipped by an abort/stop) and equally never ran.
    if (neverRan.has(e.callId) || !decisionByCall.has(e.callId)) continue;
    const term = endedByCall.get(e.callId)?.termination;
    const sbx = startedByCall.get(e.callId)?.sandbox;
    commands.push({
      command: cmd,
      ok: e.ok,
      durationMs: e.durationMs,
      ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
      ...(term !== undefined ? { termination: term } : {}),
      ...(sbx !== undefined ? { sandbox: sbx } : {}),
      ...(e.fullOutputSaved === true && e.fullOutputSha256 !== undefined ? { outputBlobSha256: e.fullOutputSha256 } : {}),
    });
  }
  // Commands that SPAWNED but never completed: the session died while they ran. Their side
  // effects are unknown — that must be visible, not silently absent.
  for (const callId of startedByCall.keys()) {
    if (completedByCall.has(callId)) continue;
    const cmd = commandByCall.get(callId);
    if (cmd === undefined) continue;
    commands.push({ command: cmd, ok: false, durationMs: 0, neverCompleted: true });
  }

  // Files changed: last mutation per path, then CHECKED if a command exited 0 after it.
  // The diffstat is the SUM across the session's mutations of that path (its churn), from the
  // per-mutation evidence recorded at write time (V0.5 logs; absent for binary/huge changes).
  const lastMutation = new Map<string, Extract<SessionEvent, { type: 'file.mutated' }>>();
  const churn = new Map<string, { added: number; removed: number; seen: boolean }>();
  for (const e of events) {
    if (e.type === 'file.mutated') {
      lastMutation.set(e.path, e);
      const c = churn.get(e.path) ?? { added: 0, removed: 0, seen: false };
      if (e.linesAdded !== undefined || e.linesRemoved !== undefined) {
        c.added += e.linesAdded ?? 0;
        c.removed += e.linesRemoved ?? 0;
        c.seen = true;
      }
      churn.set(e.path, c);
    }
  }
  // Typed checks (Session 12) are evidence of exactly the same KIND as a passing command —
  // `pass` derives from the identical exited-0 rule. Since S14.5 the whole correlation lives
  // in collectPassingEvidence/firstPassingEvidenceAfter, shared verbatim with /diff.
  const passingEvidence = collectPassingEvidence(events);

  const filesChanged: ReportFile[] = [...lastMutation.values()].map((m) => {
    const check = firstPassingEvidenceAfter(passingEvidence, m.seq);
    const file: ReportFile = {
      path: m.path,
      kind: m.kind,
      beforeSha256: m.beforeSha256,
      afterSha256: m.afterSha256,
      snapshotRecorded: snapshotCalls.has(m.callId),
      checked: check !== undefined,
    };
    if (check) file.checkedBy = check.command;
    const c = churn.get(m.path);
    if (c?.seen) {
      file.linesAdded = c.added;
      file.linesRemoved = c.removed;
    }
    return file;
  });

  const approvals = events
    .filter((e): e is Extract<SessionEvent, { type: 'approval.resolved' }> => e.type === 'approval.resolved')
    .map((e) => ({ callId: e.callId, decision: e.decision, scope: e.scope, source: e.source }));

  const undos = events
    .filter((e): e is Extract<SessionEvent, { type: 'undo.applied' }> => e.type === 'undo.applied')
    .map((e) => ({ target: e.target, restored: e.restored.length, refused: e.refused }));

  const gitCommits = events
    .filter((e): e is Extract<SessionEvent, { type: 'git.commit' }> => e.type === 'git.commit')
    .map((e) => ({ oid: e.oid, subject: e.subject, files: e.files.length, scope: e.scope, trailer: e.trailer }));

  const gitCheckpoints = events
    .filter((e): e is Extract<SessionEvent, { type: 'git.checkpoint' }> => e.type === 'git.checkpoint')
    .map((e) => ({ ref: e.ref, oid: e.oid, label: e.label, filesChanged: e.filesChanged }));

  const taskBaseCheckpoints = events
    .filter((e): e is Extract<SessionEvent, { type: 'task.base-checkpoint' }> => e.type === 'task.base-checkpoint')
    .map((e) => ({ ref: e.ref, oid: e.oid }));

  // S14.5 (I10): a delivery line must not assert liveness for a ref a LATER pruned event says
  // was deleted — annotate per ref from the log's own evidence (the footer still points at
  // `agent checkpoint list` as live truth for everything the log cannot know: phantoms, other
  // sessions' prunes).
  const prunedRefSeqs = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'git.checkpoint.pruned') for (const ref of e.refs) prunedRefSeqs.set(ref, Math.max(prunedRefSeqs.get(ref) ?? 0, e.seq));
  }
  const harnessCheckpoints = events
    .filter((e): e is Extract<SessionEvent, { type: 'harness.checkpoint' }> => e.type === 'harness.checkpoint')
    .map((e) => ({ kind: e.kind, ref: e.ref, oid: e.oid, ...((prunedRefSeqs.get(e.ref) ?? 0) > e.seq ? { pruned: true } : {}) }));

  // The structural review gate (Session 14): the same fold acceptance reads. The graph comes
  // from the CALLER when it has one (S14.5) — the report never reads the plan file itself —
  // so the requirement and open-blocker lines render for unaccepted sessions too; without a
  // supplied graph the fold still renders the recorded rounds/findings/triage evidence.
  const reviewFold = foldReview(input.approvedGraph ?? null, events);
  const requirementLine =
    reviewFold.requirement.kind === 'required'
      ? `required (${reviewFold.requirement.source === 'declared' ? 'declared by the plan' : 'derived: the plan has executor tasks'})`
      : reviewFold.requirement.kind === 'waived'
        ? `waived by the approved plan: ${reviewFold.requirement.reason}`
        : undefined;
  const review: ReportReview = {
    ...(requirementLine !== undefined ? { requirement: requirementLine } : {}),
    ...(input.approvedGraph !== undefined ? { blockers: reviewFold.openBlockers } : {}),
    rounds: reviewFold.rounds.map((r) => ({
      callId: r.callId,
      lenses: r.lenses,
      captured: r.captured,
      deadLenses: r.deadLenses,
      findings: r.findingsCount,
      qualifying: r.qualifying,
      ...(r.note !== undefined ? { note: r.note } : {}),
    })),
    findings: reviewFold.findings.map((f) => ({
      findingId: f.finding.findingId,
      severity: f.finding.severity,
      title: f.finding.title,
      paths: f.finding.paths,
      confidence: f.finding.confidence,
      status: f.status,
      blocking: f.blocking,
      ...(f.lens !== undefined ? { lens: f.lens } : {}),
      evidence: f.finding.evidence,
      scenario: f.finding.scenario,
      triage: f.triage.map((t) => ({
        action: t.action,
        evidence: t.evidence,
        ...(t.refs !== undefined ? { refs: t.refs } : {}),
        effective: t.effective,
        ...(t.note !== undefined ? { note: t.note } : {}),
      })),
    })),
    caveats: reviewFold.caveats,
  };

  const gitRestores = events
    .filter((e): e is Extract<SessionEvent, { type: 'git.restore' }> => e.type === 'git.restore')
    .map((e) => ({ ref: e.ref, oid: e.oid, restored: e.restored.length, refused: e.refused }));

  const tasks = events
    .filter((e): e is Extract<SessionEvent, { type: 'user.message' }> => e.type === 'user.message')
    .map((e) => e.text);

  // Delegated subagent tasks (V0.6): task.started/task.ended pairs joined by childSessionId —
  // one delegate call can start a parallel GROUP (V0.7), so several pairs share one callId. An
  // orphan task.started (no ended) means the session died while the task ran — rendered honestly.
  const taskEndedByChild = new Map<string, Extract<SessionEvent, { type: 'task.ended' }>>();
  for (const e of events) if (e.type === 'task.ended') taskEndedByChild.set(e.childSessionId, e);
  const tasksDelegated = events
    .filter((e): e is Extract<SessionEvent, { type: 'task.started' }> => e.type === 'task.started')
    .map((e) => {
      const end = taskEndedByChild.get(e.childSessionId);
      return {
        callId: e.callId,
        role: e.role,
        childSessionId: e.childSessionId,
        status: end !== undefined ? end.status : null,
        ...(e.planTaskId !== undefined ? { planTaskId: e.planTaskId } : {}),
        ...(end !== undefined ? { steps: end.steps, usage: end.usage, resultSha256: end.resultSha256 } : {}),
      };
    });

  // Plan-document lifecycle (V0.7): pure event derivation, like everything else here.
  let planId: string | null = null;
  let planUpdates = 0;
  let planLastSha: string | null = null;
  let planApprovedSha: string | null = null;
  let planDiscarded = false;
  let planDiscardedReason: 'accepted' | undefined;
  let planRoute: ReportPlan['route'] = null;
  let planTaskCount: number | null = null;
  for (const e of events) {
    if (e.type === 'plan.updated') {
      planId = e.planId;
      planUpdates++;
      planLastSha = e.sha256;
      if (e.graph !== undefined) planTaskCount = e.graph.length;
    } else if (e.type === 'plan.approved') {
      planId = e.planId;
      planLastSha = e.sha256; // approval rewrites the status line, so the approved bytes ARE the latest
      planApprovedSha = e.sha256;
      planDiscarded = false;
      planDiscardedReason = undefined;
    } else if (e.type === 'plan.discarded') {
      planId = e.planId;
      planDiscarded = true;
      planDiscardedReason = e.reason;
    } else if (e.type === 'plan.route' && planRoute === null) {
      planRoute = { mode: e.mode, source: e.source };
    }
  }
  const planState: ReportPlan | null =
    planId === null
      ? null
      : {
          planId,
          updates: planUpdates,
          lastSha256: planLastSha,
          approvedSha256: planApprovedSha,
          discarded: planDiscarded,
          ...(planDiscardedReason !== undefined ? { discardedReason: planDiscardedReason } : {}),
          route: planRoute,
          taskCount: planTaskCount,
        };

  // The acceptance boundary (Session 11.5): the LATEST recorded /accept governs.
  let accepted: ReportJson['accepted'];
  for (const e of events) {
    if (e.type === 'session.accepted') {
      accepted = {
        complete: e.complete,
        summary: e.summary,
        ...(e.unfinished !== undefined ? { unfinished: e.unfinished } : {}),
        ...(e.deliveryRef !== undefined ? { deliveryRef: e.deliveryRef } : {}),
        ...(e.deliveryOid !== undefined ? { deliveryOid: e.deliveryOid } : {}),
      };
    }
  }

  // Typed check runs (Session 12), in event order. A `check.started` with no matching completion
  // is rendered as a run with NO verdict rather than being silently absent — a build killed
  // mid-flight can have left partial artifacts, and it certainly did not pass.
  const checkRuns: ReportCheck[] = [];
  const startedChecks: Extract<SessionEvent, { type: 'check.started' }>[] = [];
  const completedKeys = new Set<string>();
  for (const e of events) {
    if (e.type === 'check.started') startedChecks.push(e);
    else if (e.type === 'check.completed') {
      completedKeys.add(`${e.callId}::${e.check}`);
      const started = startedChecks.find((s) => s.callId === e.callId && s.check === e.check);
      checkRuns.push({
        check: e.check,
        recipeId: e.recipeId,
        command: started?.command ?? '',
        status: e.status,
        exitCode: e.exitCode,
        ...(e.termination !== undefined ? { termination: e.termination } : {}),
        durationMs: e.durationMs,
        summary: e.summary,
        ...(e.signals !== undefined ? { signals: e.signals } : {}),
        ...(e.findings !== undefined ? { findings: e.findings } : {}),
        ...(e.planTaskId !== undefined ? { planTaskId: e.planTaskId } : {}),
        ...(e.scopePaths !== undefined ? { scopePaths: e.scopePaths } : {}),
        ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
      });
    }
  }
  for (const s of startedChecks) {
    if (completedKeys.has(`${s.callId}::${s.check}`)) continue;
    checkRuns.push({
      check: s.check,
      recipeId: s.recipeId,
      command: s.command,
      status: 'no-verdict',
      exitCode: null,
      durationMs: 0,
      summary: `${s.check} STARTED but never completed — no verdict; effects unknown`,
      ...(s.planTaskId !== undefined ? { planTaskId: s.planTaskId } : {}),
      ...(s.projectId !== undefined ? { projectId: s.projectId } : {}),
      neverCompleted: true,
    });
  }

  // Project setup (Session 16). Deliberately a SEPARATE fold from the checks above and never fed
  // into `collectPassingEvidence`: an install exiting 0 marks nothing CHECKED, because fetching
  // dependencies is not evidence that any file is correct.
  const setups: ReportSetup[] = [];
  const startedSetups: Extract<SessionEvent, { type: 'setup.started' }>[] = [];
  const completedSetupIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'setup.started') startedSetups.push(e);
    else if (e.type === 'setup.completed') {
      completedSetupIds.add(e.callId);
      const started = startedSetups.find((s) => s.callId === e.callId);
      setups.push({
        action: e.action,
        projectId: e.projectId,
        recipeId: e.recipeId,
        command: started?.command ?? '',
        cwd: started?.cwd ?? '',
        status: e.status,
        exitCode: e.exitCode,
        ...(e.termination !== undefined ? { termination: e.termination } : {}),
        durationMs: e.durationMs,
        summary: e.summary,
        ...(e.signals !== undefined ? { signals: e.signals } : {}),
        ...(started?.lockfile !== undefined ? { lockfile: started.lockfile } : {}),
      });
    }
  }
  for (const s of startedSetups) {
    if (completedSetupIds.has(s.callId)) continue;
    setups.push({
      action: s.action,
      projectId: s.projectId,
      recipeId: s.recipeId,
      command: s.command,
      cwd: s.cwd,
      status: 'no-verdict',
      exitCode: null,
      durationMs: 0,
      summary: `${s.action} STARTED but never completed — the dependency or local data state is UNKNOWN`,
      ...(s.lockfile !== undefined ? { lockfile: s.lockfile } : {}),
      neverCompleted: true,
    });
  }

  // The bounded repair ledger (Session 12). Outcomes come from the same pure fold the gate and
  // acceptance read, so the report can never disagree with them about whether a repair was proven.
  const ledger = foldRepairs(events);
  const repairs: ReportRepair[] = [
    ...ledger.attempts.map((a) => ({
      kind: 'attempt' as const,
      target: a.target,
      failureClass: a.failureClass,
      signature: a.signature.slice(0, 12),
      attempt: a.attempt,
      hypothesis: a.hypothesis,
      scopePaths: a.scopePaths,
      regressionChecks: a.regressionChecks,
      outcome: a.outcome,
      ...(a.pendingChecks.length > 0 ? { pendingChecks: a.pendingChecks } : {}),
      ...(a.outOfScope.length > 0 ? { outOfScope: a.outOfScope } : {}),
    })),
    ...ledger.escalations.map((e) => ({
      kind: 'escalation' as const,
      target: e.target,
      failureClass: e.failureClass,
      signature: e.signature.slice(0, 12),
      reason: e.reason,
      open: e.open,
    })),
  ];

  // Managed previews (Session 13): join started/ready/ended by previewId. A started with no
  // ended is the crash-orphan shape — rendered as such, never silently absent.
  const previews: ReportPreview[] = [];
  {
    const byId = new Map<string, ReportPreview>();
    for (const e of events) {
      if (e.type === 'preview.started') {
        const p: ReportPreview = {
          previewId: e.previewId,
          recipeId: e.recipeId,
          command: e.command,
          pid: e.pid,
          ready: false,
          neverEnded: true,
        };
        byId.set(e.previewId, p);
        previews.push(p);
      } else if (e.type === 'preview.ready') {
        const p = byId.get(e.previewId);
        if (p !== undefined) {
          p.ready = true;
          p.url = e.url;
          p.probeDetail = e.probeDetail;
        }
      } else if (e.type === 'preview.ended') {
        const p = byId.get(e.previewId);
        if (p !== undefined) {
          p.end = { reason: e.reason, exitCode: e.exitCode };
          p.logFile = e.logFile;
          p.neverEnded = false;
        }
      }
    }
  }

  // Browser flows (Session 13): the detail events; the paired check evidence is in `checks`.
  const browserFlows: ReportBrowserFlow[] = events
    .filter((e): e is Extract<SessionEvent, { type: 'browser.flow' }> => e.type === 'browser.flow')
    .map((e) => ({
      flowName: e.flowName,
      previewId: e.previewId,
      status: e.status,
      stepsOk: e.steps.filter((s) => s.ok).length,
      stepsTotal: e.steps.length,
      failures: e.steps
        .filter((s) => !s.ok)
        .map((s) => ({
          n: s.n,
          kind: s.kind,
          ...(s.target !== undefined ? { target: s.target } : {}),
          failureClass: s.failure?.class ?? '?',
          detail: s.failure?.detail ?? '',
        })),
      artifacts: e.artifacts.map((a) => ({ kind: a.kind, sha256: a.sha256, bytes: a.bytes, label: a.label })),
      consoleErrors: e.consoleErrors.length,
      pageErrors: e.pageErrors.length,
      failedRequests: e.failedRequests.length,
      offOriginRequests: e.offOriginRequests.length,
      finalUrl: e.finalUrl,
      ...(e.traceOmittedBytes !== undefined ? { traceOmittedBytes: e.traceOmittedBytes } : {}),
    }));

  const taskChanges = events
    .filter((e): e is Extract<SessionEvent, { type: 'task.changes' }> => e.type === 'task.changes')
    .map((e) => ({
      childSessionId: e.childSessionId,
      baseOid: e.baseOid,
      files: e.files.length,
      oversize: e.files.filter((f) => f.oversize === true).length,
      omitted: e.omittedCount ?? 0,
    }));
  const taskApplies = events
    .filter((e): e is Extract<SessionEvent, { type: 'task.applied' }> => e.type === 'task.applied')
    .map((e) => ({ childSessionId: e.childSessionId, applied: e.applied.length, refused: e.refused }));

  const json: ReportJson = {
    session: {
      id: started?.type === 'session.started' ? started.sessionId : 'unknown',
      workspaceRoot: started?.type === 'session.started' ? started.workspaceRoot : 'unknown',
      // Newest-wins (Session 15): a mid-session /provider or /model switch — or a resume under a
      // different identity — must not let the report assert the original model for later work.
      model: identity.current?.model ?? 'unknown',
      mode: started?.type === 'session.started' ? started.mode : 'unknown',
      providerName: identity.current?.providerName ?? 'unknown',
      ...(identity.used.length > 1 ? { modelsUsed: identity.used } : {}),
      endedReason: ended?.type === 'session.ended' ? ended.reason : null,
      resumes,
      usage,
      ...(sandboxEvent?.type === 'sandbox.status'
        ? {
            sandbox: {
              mode: sandboxEvent.mode,
              enforced: sandboxEvent.enforced,
              summary: sandboxEvent.summary,
              confines: sandboxEvent.confines,
              doesNotConfine: sandboxEvent.doesNotConfine,
            },
          }
        : {}),
      ...(gitEvent?.type === 'git.context'
        ? {
            git: {
              isRepo: gitEvent.isRepo,
              repoRoot: gitEvent.repoRoot,
              branch: gitEvent.branch,
              head: gitEvent.head,
              dirtyCount: gitEvent.dirtyCount,
              probeFailed: gitEvent.probeFailed,
              detail: gitEvent.detail,
            },
          }
        : {}),
    },
    tasks,
    actions,
    filesChanged,
    commands,
    approvals,
    undos,
    gitCommits,
    gitCheckpoints,
    taskBaseCheckpoints,
    gitRestores,
    tasksDelegated,
    plan: planState,
    ...(accepted !== undefined ? { accepted } : {}),
    ...(checkRuns.length > 0 ? { checks: checkRuns } : {}),
    ...(setups.length > 0 ? { setups } : {}),
    ...(repairs.length > 0 ? { repairs } : {}),
    ...(previews.length > 0 ? { previews } : {}),
    ...(browserFlows.length > 0 ? { browserFlows } : {}),
    ...(harnessCheckpoints.length > 0 ? { harnessCheckpoints } : {}),
    ...(review.rounds.length > 0 || review.findings.length > 0 ? { review } : {}),
    taskChanges,
    taskApplies,
    integrity: {
      truncatedTail: input.truncatedTail ?? false,
      ...(input.corruptAt ? { corruptAt: input.corruptAt } : {}),
    },
  };

  return { json, md: renderMarkdown(json) };
}

function renderMarkdown(r: ReportJson): string {
  const L: string[] = [];
  L.push(`# Agent CLI session report`);
  L.push('');
  if (r.integrity.corruptAt) {
    L.push(`> ⚠ CORRUPT LOG: parsing stopped at line ${r.integrity.corruptAt.line} (${r.integrity.corruptAt.kind}). This report covers only events before the corruption.`);
    L.push('');
  }
  if (r.integrity.truncatedTail) {
    L.push(`> ⚠ The log had a partial trailing line (a crash mid-write); it was ignored.`);
    L.push('');
  }
  L.push(`- session: ${r.session.id}`);
  L.push(`- workspace: ${r.session.workspaceRoot}`);
  L.push(`- model: ${r.session.model} (provider: ${r.session.providerName}, mode: ${r.session.mode})`);
  if (r.session.modelsUsed !== undefined) {
    L.push(`- models used (identity changed mid-session): ${r.session.modelsUsed.map((m) => `${m.providerName}·${m.model}`).join(' → ')}`);
  }
  L.push(`- ended: ${r.session.endedReason ?? 'IN PROGRESS or CRASHED/UNKNOWN (no session.ended recorded)'}`);
  if (r.session.resumes > 0) L.push(`- resumed ${r.session.resumes} time(s)`);
  {
    const u = r.session.usage;
    const cache = (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) > 0 ? ` (cache: ${u.cacheReadInputTokens} read / ${u.cacheCreationInputTokens} written)` : '';
    L.push(`- tokens: ${u.inputTokens} in / ${u.outputTokens} out${cache}`);
  }
  if (r.session.sandbox) {
    const s = r.session.sandbox;
    L.push(`- sandbox: ${s.mode} (${s.enforced ? 'ENFORCED' : 'not enforced'}) — ${s.summary}`);
    for (const c of s.confines) L.push(`    confines: ${c}`);
    for (const c of s.doesNotConfine) L.push(`    does NOT confine: ${c}`);
  }
  if (r.session.git) {
    const g = r.session.git;
    L.push(g.isRepo ? `- git (at session start): ${g.detail}` : `- git: ${g.detail}`);
  }
  L.push('');

  L.push(`## Task`);
  if (r.tasks.length === 0) L.push('(none)');
  for (const t of r.tasks) L.push(`- ${t.split('\n')[0]}`);
  L.push('');

  L.push(`## Files changed`);
  if (r.filesChanged.length === 0) {
    L.push('(none)');
  } else {
    for (const f of r.filesChanged) {
      const status = f.checked ? `CHECKED (check ran, exit 0: \`${f.checkedBy}\`)` : 'UNCHECKED (no passing check ran after the last change)';
      const stat = f.linesAdded !== undefined || f.linesRemoved !== undefined ? `  +${f.linesAdded ?? 0}/−${f.linesRemoved ?? 0}` : '';
      L.push(`- ${f.kind} ${f.path}  ${short(f.beforeSha256)} → ${short(f.afterSha256)}${stat}  [${f.snapshotRecorded ? 'undo-recorded' : 'NOT undoable'}]  ${status}`);
    }
  }
  L.push('');

  L.push(`## Commands run`);
  if (r.commands.length === 0) {
    L.push('(none)');
  } else {
    for (const c of r.commands) {
      const box = c.sandbox === 'windows-lowil' ? ' [sandboxed: windows-lowil]' : c.sandbox === 'none' ? ' [unsandboxed]' : '';
      if (c.neverCompleted) {
        L.push(`- \`${c.command}\`  → STARTED but never completed (the session ended while it ran); effects unknown${box}`);
      } else if (c.termination === 'timeout') {
        L.push(`- \`${c.command}\`  → killed: timed out (${c.durationMs} ms); no exit code${box}`);
      } else if (c.termination === 'aborted') {
        L.push(`- \`${c.command}\`  → killed: aborted by user (${c.durationMs} ms); no exit code${box}`);
      } else if (c.termination === 'spawn-error') {
        L.push(`- \`${c.command}\`  → failed to spawn${box}`);
      } else {
        L.push(`- \`${c.command}\`  → exit ${c.exitCode ?? '—'} (${c.durationMs} ms)${box}`);
      }
      if (c.outputBlobSha256 !== undefined) {
        // "Captured", never "full": for a command whose live capture was itself capped, the
        // blob holds the capped stream, not everything the process printed.
        L.push(`  (output was truncated for the model; captured output preserved: objects/${c.outputBlobSha256})`);
      }
    }
  }
  L.push('');

  if (r.previews !== undefined && r.previews.length > 0) {
    L.push(`## Preview processes (managed)`);
    for (const p of r.previews) {
      const readyBit = p.ready ? `ready at ${p.url ?? '?'} (${p.probeDetail ?? ''})` : 'readiness never observed';
      const endBit = p.neverEnded
        ? r.session.endedReason === null
          ? 'NEVER ENDED in this log — the session died with it running; the next session\'s identity-verified sweep handles it'
          : 'no ended event recorded (its stop may have raced the session end); the next session\'s sweep verifies'
        : `ended: ${p.end?.reason ?? '?'}${p.end?.exitCode !== null && p.end?.exitCode !== undefined ? ` (exit ${p.end.exitCode})` : ''}`;
      L.push(`- ${p.previewId} — \`${p.command}\` [${p.recipeId}; pid ${p.pid}]`);
      L.push(`    ${readyBit}; ${endBit}`);
      if (p.logFile !== undefined) L.push(`    log: ${p.logFile}`);
    }
    L.push('');
  }

  if (r.setups !== undefined && r.setups.length > 0) {
    L.push(`## Project setup (dependencies, migrations, seed)`);
    for (const s of r.setups) {
      const verdict = s.neverCompleted
        ? 'STARTED but never completed; the dependency or local data state is UNKNOWN'
        : s.status === 'ok'
          ? 'OK (exit 0)'
          : s.status === 'failed'
            ? `FAILED (exit ${s.exitCode ?? '—'})`
            : s.status === 'unsupported'
              ? 'UNSUPPORTED (never ran)'
              : `ERROR (${s.termination ?? 'no exit'}; no exit code)`;
      L.push(`- ${s.action} [project ${s.projectId}] → ${verdict} in ${s.durationMs} ms${s.command !== '' ? ` — \`${s.command}\`` : ''}`);
      if (s.cwd !== '') L.push(`    in: ${s.cwd}${s.lockfile !== undefined ? `; lockfile: ${s.lockfile}` : ''}`);
      if (s.status !== 'ok' && s.summary !== '') L.push(`    ${s.summary}`);
      if (s.signals !== undefined && s.signals.length > 0) L.push(`    signals: ${s.signals.join(', ')}`);
    }
    L.push('');
    L.push(
      'Setup is WORK, not verification: an install exiting 0 means dependencies were fetched, and it never marks a ' +
        'file CHECKED or satisfies a plan gate. Installs execute third-party package code; migrations and seeds change ' +
        'local data the harness does not snapshot and cannot undo. Every one of these was individually approved.',
    );
    L.push('');
  }
  if (r.checks !== undefined && r.checks.length > 0) {
    L.push(`## Verification (typed checks)`);
    for (const c of r.checks) {
      const where =
        (c.projectId !== undefined && c.projectId !== '.' ? ` [project ${c.projectId}]` : '') +
        (c.planTaskId !== undefined ? ` [plan task ${c.planTaskId}]` : '');
      const scope = c.scopePaths !== undefined && c.scopePaths.length > 0 ? ` [scope: ${c.scopePaths.join(', ')}]` : '';
      if (c.neverCompleted) {
        L.push(`- ${c.check} (${c.recipeId})${where} → STARTED but never completed; NO verdict, effects unknown`);
      } else if (c.status === 'unsupported') {
        L.push(`- ${c.check} → UNSUPPORTED (never ran): ${c.summary}${where}`);
      } else {
        const verdict =
          c.status === 'pass'
            ? `PASS (exit 0)`
            : c.status === 'fail'
              ? `FAIL (exit ${c.exitCode ?? '—'})`
              : `ERROR (${c.termination ?? 'no exit'}; no exit code)`;
        L.push(`- ${c.check} (${c.recipeId})${where}${scope} → ${verdict} in ${c.durationMs} ms — \`${c.command}\``);
      }
      for (const f of c.findings ?? []) {
        L.push(`  - ${f.file !== undefined ? `${f.file}${f.line !== undefined ? `:${String(f.line)}` : ''} — ` : ''}${f.message}`);
      }
      if (c.signals !== undefined && c.signals.length > 0) L.push(`  signals: ${c.signals.join(', ')}`);
    }
    L.push('');
    L.push('A typed check PASSES only when its process genuinely exited with code 0. UNSUPPORTED means the check never ran.');
    L.push('');
  }

  if (r.browserFlows !== undefined && r.browserFlows.length > 0) {
    L.push(`## Browser verification (flows against the managed preview)`);
    for (const f of r.browserFlows) {
      L.push(`- flow '${f.flowName}' vs ${f.previewId} → ${f.status.toUpperCase()} (${f.stepsOk}/${f.stepsTotal} steps)${f.finalUrl !== null ? ` — final url ${f.finalUrl}` : ''}`);
      for (const x of f.failures) {
        L.push(`    step ${x.n} (${x.kind}${x.target !== undefined ? ` ${x.target}` : ''}) FAILED [${x.failureClass}]: ${x.detail}`);
      }
      for (const a of f.artifacts) {
        L.push(`    ${a.kind} '${a.label}': objects/${a.sha256} (${Math.round(a.bytes / 1024)} KiB)`);
      }
      const counts = [
        f.consoleErrors > 0 ? `${f.consoleErrors} console error(s)` : '',
        f.pageErrors > 0 ? `${f.pageErrors} page error(s)` : '',
        f.failedRequests > 0 ? `${f.failedRequests} failed request(s)` : '',
        f.offOriginRequests > 0 ? `${f.offOriginRequests} off-origin request(s) (recorded, not confined)` : '',
      ].filter((s) => s !== '');
      if (counts.length > 0) L.push(`    ${counts.join('; ')}`);
      if (f.traceOmittedBytes !== undefined) L.push(`    trace NOT stored (${Math.round(f.traceOmittedBytes / 1024)} KiB over the artifact budget)`);
    }
    L.push(`  (screenshots prove the captured pixels at a declared-ready moment; the typed step outcomes above are the functional evidence)`);
    L.push('');
  }

  if (r.repairs !== undefined && r.repairs.length > 0) {
    L.push(`## Recovery (classified failures and bounded repairs)`);
    for (const p of r.repairs) {
      if (p.kind === 'escalation') {
        L.push(`- ESCALATED ${p.target} [${p.failureClass}] ${p.open === true ? '(UNRESOLVED)' : '(resolved by a later repair)'} — ${p.reason ?? ''}`);
        continue;
      }
      const outcome =
        p.outcome === 'succeeded'
          ? 'PROVEN (every declared regression check passed after it)'
          : p.outcome === 'superseded'
            ? 'superseded by a later attempt for the same failure'
            : `UNPROVEN (regression check(s) pending: ${(p.pendingChecks ?? []).join(', ') || 'none declared'})`;
      L.push(`- attempt ${p.attempt ?? '?'} on ${p.target} [${p.failureClass}, sig ${p.signature}] → ${outcome}`);
      if (p.hypothesis !== undefined) L.push(`  hypothesis (model-authored, recorded for review — not verified): ${p.hypothesis}`);
      if (p.scopePaths !== undefined && p.scopePaths.length > 0) L.push(`  declared scope: ${p.scopePaths.join(', ')}`);
      if (p.outOfScope !== undefined && p.outOfScope.length > 0) L.push(`  ⚠ changed OUTSIDE the declared scope: ${p.outOfScope.join(', ')}`);
    }
    L.push('');
    L.push('A repair outcome is DERIVED from evidence, never asserted: an attempt counts as proven only when every regression check it declared actually passed after it.');
    L.push('');
  }

  if (r.review !== undefined && (r.review.rounds.length > 0 || r.review.findings.length > 0 || r.review.requirement !== undefined)) {
    L.push(`## Adversarial review (recorded findings and triage)`);
    if (r.review.requirement !== undefined) L.push(`- requirement: ${r.review.requirement}`);
    for (const b of r.review.blockers ?? []) L.push(`- OPEN BLOCKER: ${b}`);
    for (let i = 0; i < r.review.rounds.length; i++) {
      const rd = r.review.rounds[i]!;
      L.push(
        `- round ${i + 1}: ${rd.captured}/${rd.lenses} lens(es) completed with capture, ${rd.findings} finding(s) recorded — ${rd.qualifying ? 'QUALIFYING' : `not qualifying (${rd.note ?? 'see /review'})`}${rd.deadLenses.length > 0 ? `; dead lens(es): ${rd.deadLenses.join(', ')}` : ''}`,
      );
    }
    for (const f of r.review.findings) {
      L.push(`- ${f.findingId} [${f.severity}, confidence ${f.confidence}] '${f.title}' → ${f.status.toUpperCase()}${f.blocking ? ' (BLOCKING)' : ''}`);
      L.push(`  paths: ${f.paths.join(', ')}${f.lens !== undefined ? ` · lens: ${f.lens}` : ''}`);
      L.push(`  scenario: ${f.scenario}`);
      L.push(`  reviewer evidence: ${f.evidence}`);
      for (const t of f.triage) {
        L.push(
          `  triage ${t.action}${t.effective ? '' : ' (INEFFECTIVE)'}: ${t.evidence}${t.refs !== undefined ? ` [refs: ${t.refs.join(', ')}]` : ''}${t.note !== undefined ? ` — ${t.note}` : ''}`,
        );
      }
    }
    for (const c of r.review.caveats) L.push(`- caveat: ${c}`);
    L.push('');
    L.push(
      'Recorded findings are the review gate\'s only input; reviewer prose is narration. Triage is model judgment: a refutation is an UNVERIFIED model claim, rendered here verbatim for audit — an address counts only when its cited refs exist in this log.',
    );
    L.push('');
  }

  L.push(`## Actions`);
  for (const a of r.actions) {
    const outcome = a.ok === null ? 'no-result' : a.ok ? 'ok' : 'error';
    L.push(`- ${a.tool} [${a.classification}] ${a.decision}/${a.rule} → ${outcome}${a.exitCode !== undefined ? ` (exit ${a.exitCode})` : ''}`);
  }
  L.push('');

  if (r.approvals.length > 0) {
    L.push(`## Approvals`);
    for (const a of r.approvals) L.push(`- ${a.callId}: ${a.decision} (${a.scope}, by ${a.source})`);
    L.push('');
  }

  if (r.gitCommits.length > 0) {
    L.push(`## Commits (user-commanded)`);
    for (const c of r.gitCommits) {
      L.push(`- ${c.oid.slice(0, 12)} "${c.subject}" — ${c.files} file(s), scope: ${c.scope}${c.trailer ? '' : ', no trailer'}`);
    }
    L.push('');
  }

  if (r.gitCheckpoints.length > 0) {
    L.push(`## Checkpoints (hidden refs, user-commanded)`);
    for (const c of r.gitCheckpoints) {
      L.push(`- ${c.oid.slice(0, 12)} ${c.ref}${c.label ? ` "${c.label}"` : ''} — ${c.filesChanged} file(s) differ from HEAD`);
    }
    L.push('');
  }

  if (r.taskBaseCheckpoints.length > 0) {
    L.push(`## Task-base checkpoints (hidden refs, harness-created)`);
    for (const c of r.taskBaseCheckpoints) {
      L.push(`- ${c.oid.slice(0, 12)} ${c.ref} — executor-group base; pruned at clean session end`);
    }
    L.push('');
  }

  if (r.harnessCheckpoints !== undefined && r.harnessCheckpoints.length > 0) {
    L.push(`## Git recovery and audit state (hidden refs, harness-created)`);
    for (const c of r.harnessCheckpoints) {
      const prunedSuffix = c.pruned === true ? ' [later pruned/superseded in this log]' : '';
      L.push(
        c.kind === 'delivery'
          ? `- ${c.oid.slice(0, 12)} ${c.ref} — DELIVERY (the accepted state; intended to survive the session)${prunedSuffix}`
          : `- ${c.oid.slice(0, 12)} ${c.ref} — pre-integration (whole-workspace point before an apply; pruned at clean session end)${prunedSuffix}`,
      );
    }
    L.push('');
    L.push(
      'Recorded creations, not live refs: `agent checkpoint list` is live truth — a recorded ref that is absent there was pruned, superseded, or never landed (creation is recorded BEFORE the ref is written, so a crash or a failed ref write leaves an honest phantom that prunes as already-deleted).',
    );
    L.push('');
  }

  if (r.gitRestores.length > 0) {
    L.push(`## Checkpoint restores (user-commanded)`);
    for (const c of r.gitRestores) {
      L.push(`- restored ${c.restored} file(s) to ${c.oid.slice(0, 12)} (${c.ref})${c.refused.length > 0 ? `, refused ${c.refused.length}` : ''}`);
      for (const ref of c.refused) L.push(`    refused ${ref.path}: ${ref.reason}`);
    }
    L.push('');
  }

  if (r.undos.length > 0) {
    L.push(`## Undo activity`);
    for (const u of r.undos) {
      L.push(`- undo ${u.target}: restored ${u.restored} file(s)${u.refused.length ? `, refused ${u.refused.length}` : ''}`);
      for (const ref of u.refused) L.push(`    refused ${ref.path}: ${ref.reason}`);
    }
    L.push('');
  }

  if (r.plan !== null && r.plan !== undefined) {
    L.push(`## Plan`);
    if (r.plan.route !== null && r.plan.route !== undefined) {
      L.push(`- routing: ${r.plan.route.mode} path (${r.plan.route.source === 'user-sigil' ? 'forced by the user' : "the model's judgment"})`);
    }
    L.push(
      `- plan ${r.plan.planId}: ${r.plan.updates} write(s) via update_plan${r.plan.taskCount !== null && r.plan.taskCount !== undefined ? `; latest graph has ${r.plan.taskCount} task(s)` : ''}; latest sha256 ${short(r.plan.lastSha256)}`,
    );
    if (r.plan.approvedSha256 !== null) {
      const divergence =
        r.plan.lastSha256 !== null && r.plan.lastSha256 !== r.plan.approvedSha256
          ? ` — the file changed AFTER approval (approved ${short(r.plan.approvedSha256)}, latest ${short(r.plan.lastSha256)})`
          : '';
      L.push(`- APPROVED by the user at sha256 ${short(r.plan.approvedSha256)}${divergence}`);
    } else {
      L.push(`- never approved by the user${r.plan.discarded ? '' : ' (draft)'}`);
    }
    if (r.plan.discarded) {
      L.push(
        r.plan.discardedReason === 'accepted'
          ? `- RETIRED at acceptance (/accept; status: superseded — the plan was fully executed)`
          : `- DISCARDED by the user (status: superseded)`,
      );
    }
    L.push('');
  }

  if (r.accepted !== undefined) {
    L.push(`## Completion`);
    L.push(`- ACCEPTED by the user (${r.accepted.complete ? 'complete' : 'partial'}): ${r.accepted.summary}`);
    for (const u of r.accepted.unfinished ?? []) L.push(`  - unfinished: ${u}`);
    L.push('');
  }

  if (r.tasksDelegated.length > 0) {
    L.push(`## Delegated tasks (subagents)`);
    for (const t of r.tasksDelegated) {
      const state =
        t.status !== null
          ? `${t.status} — ${t.steps} step(s), ${t.usage?.inputTokens ?? 0} in / ${t.usage?.outputTokens ?? 0} out tokens`
          : `STARTED but never completed — the session ended while it ran`;
      L.push(
        `- ${t.role}${t.planTaskId !== undefined ? ` [plan task ${t.planTaskId}]` : ''} → child session ${t.childSessionId}: ${state} (evidence: agent report ${t.childSessionId})`,
      );
    }
    // Cost roll-up (V0.7.1): one COMBINED line so the total spend is visible in one place.
    // The session usage totals elsewhere in this report stay PARENT-ONLY (stated in the footer);
    // this line is labeled as the sum, not a replacement.
    const childIn = r.tasksDelegated.reduce((s, t) => s + (t.usage?.inputTokens ?? 0), 0);
    const childOut = r.tasksDelegated.reduce((s, t) => s + (t.usage?.outputTokens ?? 0), 0);
    const u = r.session.usage;
    L.push(`- combined tokens (parent + children): ${u.inputTokens + childIn} in / ${u.outputTokens + childOut} out — session totals elsewhere remain parent-only`);
    L.push('');
  }

  if ((r.taskChanges?.length ?? 0) > 0 || (r.taskApplies?.length ?? 0) > 0) {
    L.push(`## Task changes and integration (executor worktrees)`);
    for (const c of r.taskChanges ?? []) {
      L.push(
        `- captured from ${c.childSessionId}: ${c.files} file change(s) vs base ${c.baseOid.slice(0, 12)}` +
          `${c.oversize > 0 ? `, ${c.oversize} oversize (recorded, not integrable)` : ''}${c.omitted > 0 ? `, ${c.omitted} omitted over the cap` : ''}`,
      );
    }
    const appliedByChild = new Set((r.taskApplies ?? []).map((a) => a.childSessionId));
    for (const a of r.taskApplies ?? []) {
      L.push(`- applied into the workspace from ${a.childSessionId}: ${a.applied} change(s)${a.refused.length > 0 ? `; ${a.refused.length} REFUSED` : ''}`);
      for (const ref of a.refused) L.push(`    refused ${ref.relPath}: ${ref.reason}`);
    }
    for (const c of r.taskChanges ?? []) {
      if (!appliedByChild.has(c.childSessionId) && c.files > 0) {
        L.push(`- NOT applied: the ${c.files} captured change(s) from ${c.childSessionId} never entered the workspace this session`);
      }
    }
    L.push('');
  }

  L.push(`---`);
  L.push(`Assistant narrative is not evidence; the sections above are compiled only from recorded tool events.`);
  const sbx = r.session.sandbox;
  if (sbx?.enforced && sbx.mode === 'windows-lowil') {
    L.push(
      `Undo covers only write_file/edit_file changes. Commands marked [sandboxed: windows-lowil] ran at LOW integrity — the OS denied their writes to the workspace, the profile, system dirs, and the harness state, and the process tree was reaped on kill; but reads and network were NOT confined. Commands marked [unsandboxed] were human-approved and ran with FULL user privilege — their side effects are not snapshotted or undoable.`,
    );
  } else {
    L.push(
      `Undo covers only write_file/edit_file changes. run_command side effects, out-of-workspace edits, and external modifications are NOT captured. There is no OS sandbox in this mode — an approved command ran with full user privilege.`,
    );
  }
  if (r.commands.some((c) => c.neverCompleted)) {
    L.push(`A command marked "STARTED but never completed" was executing when the session ended abnormally; its process may have kept running and its side effects are unknown.`);
  }
  if (r.commands.some((c) => c.termination === 'timeout' || c.termination === 'aborted')) {
    L.push(`Killed commands were force-terminated best-effort (process tree kill); a detached descendant may have survived, and a killed command has no exit code and never counts as a passing check.`);
  }
  if (r.tasksDelegated.length > 0) {
    L.push(
      `Delegated-task usage is recorded in each child session's own log and is NOT included in this session's token totals. Subagent reports quoted to the model are narration, not verified evidence — each child's own evidence log is the record of what it actually did.`,
    );
  }
  if ((r.taskChanges?.length ?? 0) > 0) {
    L.push(
      `Executor tasks ran in disposable git worktrees (visible to \`git worktree list\` while running; removed at task end, crash leftovers swept at the next session start). A worktree materializes WITHOUT gitignored files (no node_modules/.env), so an executor's verification claims cover only what actually ran there. Approvals forwarded from a task were answered by the user; an APPROVED forwarded command ran UNSANDBOXED with full privilege, and time spent waiting on an approval counted against the task's wall clock.`,
    );
  }
  return L.join('\n');
}
