import type { CommandTermination, SessionEvent } from '../types.js';

/**
 * The deterministic evidence report: a PURE function from the event log to a structured object
 * and a Markdown rendering. No filesystem I/O, no model — identical events produce byte-identical
 * output (golden-testable). This is constitution principles 1 and 8 made executable: only recorded
 * tool events count as evidence, and "CHECKED" means a command exited zero AFTER a change, nothing
 * more.
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
  /** The execution boundary this command actually ran under (V0.4+ logs). */
  sandbox?: 'none' | 'windows-lowil';
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
    model: string;
    mode: string;
    providerName: string;
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
  integrity: { truncatedTail: boolean; corruptAt?: { line: number; kind: string } };
}

export interface ReportInput {
  events: readonly SessionEvent[];
  truncatedTail?: boolean;
  corruptAt?: { line: number; kind: string };
}

function short(h: string | null): string {
  return h === null ? '∅' : h.slice(0, 8);
}

export function buildReport(input: ReportInput): { json: ReportJson; md: string } {
  const { events } = input;

  const started = events.find((e) => e.type === 'session.started');
  const ended = events.find((e) => e.type === 'session.ended');
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

  // Command completions with their seq, for CHECKED correlation.
  const commandCompletions: { command: string; seq: number; exitCode?: number; ok: boolean; termination?: CommandTermination }[] = [];
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
    });
    commandCompletions.push({
      command: cmd,
      seq: e.seq,
      ok: e.ok,
      ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
      ...(term !== undefined ? { termination: term } : {}),
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
  const filesChanged: ReportFile[] = [...lastMutation.values()].map((m) => {
    // A check must have genuinely EXITED with 0. A killed command has no exit code by contract;
    // for V0.3+ logs the termination evidence enforces this even against a stray exitCode.
    const check = commandCompletions.find(
      (cc) => cc.seq > m.seq && cc.exitCode === 0 && (cc.termination === undefined || cc.termination === 'exited'),
    );
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

  const tasks = events
    .filter((e): e is Extract<SessionEvent, { type: 'user.message' }> => e.type === 'user.message')
    .map((e) => e.text);

  const json: ReportJson = {
    session: {
      id: started?.type === 'session.started' ? started.sessionId : 'unknown',
      workspaceRoot: started?.type === 'session.started' ? started.workspaceRoot : 'unknown',
      model: started?.type === 'session.started' ? started.model : 'unknown',
      mode: started?.type === 'session.started' ? started.mode : 'unknown',
      providerName: started?.type === 'session.started' ? started.providerName : 'unknown',
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
    }
  }
  L.push('');

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

  if (r.undos.length > 0) {
    L.push(`## Undo activity`);
    for (const u of r.undos) {
      L.push(`- undo ${u.target}: restored ${u.restored} file(s)${u.refused.length ? `, refused ${u.refused.length}` : ''}`);
      for (const ref of u.refused) L.push(`    refused ${ref.path}: ${ref.reason}`);
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
  return L.join('\n');
}
