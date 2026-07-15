import type { SessionEvent } from '../types.js';

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
}
export interface ReportCommand {
  command: string;
  ok: boolean;
  exitCode?: number;
  durationMs: number;
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
    usage: { inputTokens: number; outputTokens: number };
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
  const commandByCall = new Map<string, string>();
  const toolByCall = new Map<string, string>();
  const usage = { inputTokens: 0, outputTokens: 0 };
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
    } else if (e.type === 'session.resumed') {
      resumes++;
    }
  }

  const decisionByCall = new Map<string, Extract<SessionEvent, { type: 'policy.decision' }>>();
  const completedByCall = new Map<string, Extract<SessionEvent, { type: 'tool.completed' }>>();
  const snapshotCalls = new Set<string>();
  const neverRan = new Set<string>(); // denied by policy or by the human — the call never executed
  for (const e of events) {
    if (e.type === 'policy.decision') {
      decisionByCall.set(e.callId, e);
      if (e.decision === 'deny') neverRan.add(e.callId);
    } else if (e.type === 'approval.resolved') {
      if (e.decision !== 'allow') neverRan.add(e.callId);
    } else if (e.type === 'tool.completed') completedByCall.set(e.callId, e);
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
  const commandCompletions: { command: string; seq: number; exitCode?: number; ok: boolean }[] = [];
  const commands: ReportCommand[] = [];
  for (const e of events) {
    if (e.type !== 'tool.completed') continue;
    const cmd = commandByCall.get(e.callId);
    if (cmd === undefined) continue;
    // "Commands run" means commands that EXECUTED. A denied call is visible under Actions and
    // Approvals; listing it here would read as if it ran.
    if (neverRan.has(e.callId)) continue;
    commands.push({ command: cmd, ok: e.ok, durationMs: e.durationMs, ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}) });
    commandCompletions.push({ command: cmd, seq: e.seq, ok: e.ok, ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}) });
  }

  // Files changed: last mutation per path, then CHECKED if a command exited 0 after it.
  const lastMutation = new Map<string, Extract<SessionEvent, { type: 'file.mutated' }>>();
  for (const e of events) {
    if (e.type === 'file.mutated') lastMutation.set(e.path, e);
  }
  const filesChanged: ReportFile[] = [...lastMutation.values()].map((m) => {
    const check = commandCompletions.find((cc) => cc.seq > m.seq && cc.exitCode === 0);
    const file: ReportFile = {
      path: m.path,
      kind: m.kind,
      beforeSha256: m.beforeSha256,
      afterSha256: m.afterSha256,
      snapshotRecorded: snapshotCalls.has(m.callId),
      checked: check !== undefined,
    };
    if (check) file.checkedBy = check.command;
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
  L.push(`- tokens: ${r.session.usage.inputTokens} in / ${r.session.usage.outputTokens} out`);
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
      L.push(`- ${f.kind} ${f.path}  ${short(f.beforeSha256)} → ${short(f.afterSha256)}  [${f.snapshotRecorded ? 'undo-recorded' : 'NOT undoable'}]  ${status}`);
    }
  }
  L.push('');

  L.push(`## Commands run`);
  if (r.commands.length === 0) {
    L.push('(none)');
  } else {
    for (const c of r.commands) L.push(`- \`${c.command}\`  → exit ${c.exitCode ?? '—'} (${c.durationMs} ms)`);
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
  L.push(`Undo covers only write_file/edit_file changes. run_command side effects, out-of-workspace edits, and external modifications are NOT captured. There is no OS sandbox — an approved command ran with full user privilege.`);
  return L.join('\n');
}
