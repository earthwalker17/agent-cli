#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveLayout, resolveStateRoot, type ProjectLayout } from '../store/layout.js';
import { cmdTrust } from '../trust/commands.js';
import { checkTrust } from './trust-check.js';
import { loadConfig } from '../config/config.js';
import { runRepl } from '../repl/repl.js';
import { EventLog } from '../store/event-log.js';
import { SnapshotStore } from '../store/snapshots.js';
import { endReasonForTurn, endSession, runTurn, type Session } from '../runtime/session.js';
import { detectGitFacts } from '../git/facts.js';
import { applyUndo } from '../runtime/undo.js';
import { buildWorkspaceMap } from '../workspace/map.js';
import { readPlan } from '../plan/store.js';
import { buildReport } from '../report/report.js';
import { buildSessionDiff, renderSessionDiff } from '../report/diff.js';
import { runCommitFlow } from '../git/commit.js';
import { createCheckpoint, listCheckpoints, pruneCheckpoints, runRestoreFlow, type CheckpointContext } from '../git/checkpoint.js';
import { AnthropicProvider } from '../provider/anthropic.js';
import { sanitizeLine } from '../shared/text.js';
import { buildRunContext, latestSessionId, workspaceRoot, type CliValues } from './context.js';
import { assembleSession } from './assemble.js';
import { memoryDir, parseFrontmatter, readDocCapped } from '../memory/store.js';
import { runMemoryUpdate } from '../memory/update.js';

const USAGE = `Agent CLI — a bounded local agent harness (V0.7).

Usage:
  agent                          Start an interactive session (REPL) in the current directory
  agent "<task>"                 Run a one-shot task in the current directory
  agent --continue ["<task>"]    Resume the latest session (REPL without a task, one-shot with)
  agent resume <id> ["<task>"]   Resume a specific session (REPL without a task, one-shot with)
  agent undo [--all]             Undo the last file change (or all changes) of a session
  agent diff [<id>]              Show what a session changed (unified diff; default: latest)
  agent commit [-m "msg"] [--all] [--yes] [--no-trailer]
                                 Commit session-attributed changes (preview + confirmation;
                                 --all = every workspace change; requires workspace trust)
  agent checkpoint [label]       Capture the workspace to a hidden git ref (recovery point)
  agent checkpoint list|prune    List checkpoints, or delete this session's refs so git gc
                                 can collect them (prune takes --all / --yes)
  agent checkpoint restore <n>   Return the workspace to checkpoint <n> (snapshot-first,
                                 one undoable batch; deletes files the checkpoint predates)
  agent report [<id>] [--json]   Print the evidence report for a session (default: latest)
  agent plan [<id>]              Print a session's plan document (default: latest; read-only —
                                 approve/discard from inside the session with /plan)
  agent sessions                 List sessions for this workspace
  agent map [--budget <n>]       Print the workspace map the model would receive
  agent memory                   Show the project-memory documents (paths, status, provenance)
  agent trust [--revoke|--list]  Manage recorded workspace trust (consent, not a sandbox)

Options:
  -C <dir>                 Workspace root (default: current directory)
  --provider anthropic|mock   Model provider (default: anthropic)
  --script <file>          Scripted turns (required with --provider mock)
  --model <id>             Model id (default: claude-opus-4-8)
  --no-input               Non-interactive: every approval auto-denies (also auto-detected off a TTY)
  --interactive            Force interactive mode on piped stdio (expect-style test driving)
  --max-turns <n>          Maximum agent steps per task (default: 20)
  --dangerously-allow-all  Bypass approvals (loud; every auto-allow is logged). No isolation whatsoever.
  --session <id>           Target session for undo (default: latest)
  --trust-this-workspace   Proceed in an untrusted workspace for THIS invocation only (not recorded)
  -h, --help               Show this help

Exit codes: 0 ok · 1 error · 2 denials or stopped (one-shot only; the REPL reports denials
inline and exits 0 on a clean quit) · 3 workspace not trusted.

Security: command authorization is automatic. On Windows a demonstrably read-only command may
auto-run inside an OS sandbox at Low integrity (writes to the workspace/system/state are OS-denied
and the process tree is reaped on kill; reads and network are NOT confined). Every other command
asks; approved commands run UNSANDBOXED with full privilege and are not undoable. Where no enforced
sandbox is available, auto-run is disabled and every command asks (fail closed). Workspace trust is
recorded consent, not isolation. See README "Security model & honest limitations".`;

const KNOWN = new Set(['run', 'resume', 'undo', 'diff', 'commit', 'checkpoint', 'report', 'plan', 'sessions', 'map', 'memory', 'trust']);

interface Args {
  values: CliValues;
  positionals: string[];
}

function parse(argv: string[]): Args {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      C: { type: 'string', short: 'C' },
      provider: { type: 'string' },
      script: { type: 'string' },
      model: { type: 'string' },
      'no-input': { type: 'boolean' },
      interactive: { type: 'boolean' },
      'max-turns': { type: 'string' },
      'dangerously-allow-all': { type: 'boolean' },
      'trust-this-workspace': { type: 'boolean' },
      revoke: { type: 'boolean' },
      list: { type: 'boolean' },
      session: { type: 'string' },
      budget: { type: 'string' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      continue: { type: 'boolean' },
      m: { type: 'string', short: 'm' },
      yes: { type: 'boolean' },
      'no-trailer': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }) as Args;
}

/**
 * Wire Ctrl+C to a turn abort for the one-shot path. First press aborts the turn (the running
 * command is tree-killed and the session ends with evidence intact); a second press force-exits.
 * Returns the uninstaller. Exported for tests (drivable via process.emit('SIGINT')).
 */
export function installSigintAbort(
  controller: AbortController,
  out: NodeJS.WritableStream = process.stderr,
  exit: (code: number) => void = process.exit,
  onForceQuit?: () => void,
): () => void {
  let presses = 0;
  const onSigint = (): void => {
    presses++;
    if (presses === 1) {
      out.write('\ninterrupt: stopping the turn (press Ctrl+C again to force-quit)\n');
      controller.abort();
    } else {
      // The force-quit path is the LIKELIEST one to be taken while a preview server runs (the
      // user quits because the turn is stuck) — the hook issues its kills synchronously before
      // the exit call lands, so the servers do not survive as untracked orphans.
      try {
        onForceQuit?.();
      } catch {
        /* force-quit must force-quit */
      }
      exit(130);
    }
  };
  process.on('SIGINT', onSigint);
  return () => {
    process.off('SIGINT', onSigint);
  };
}

/** Shared run/resume tail: run one task turn, end the session, print a verdict. */
async function runTask(values: CliValues, task: string, opts: { resumeId?: string }): Promise<number> {
  // Order is load-bearing: trust gate BEFORE the workspace config file is read, before
  // per-project state is created, and before any workspace byte reaches a model.
  const ws = workspaceRoot(values);
  const trust = await checkTrust(values, ws);
  if (!trust.trusted) {
    process.stderr.write(`refusing to run: ${trust.reason}\n`);
    return 3;
  }
  const config = loadConfig(resolveStateRoot(), ws);
  // The abort controller exists BEFORE the approver so Ctrl+C can resolve a pending one-shot
  // approval prompt as deny-stop instead of leaving the readline question hanging (V0.7.1).
  const controller = new AbortController();
  const ctx = buildRunContext(values, { config, approvalSignal: controller.signal });
  const layout = resolveLayout(ctx.ws, { ensure: true });

  // The shared assembly path (sandbox probe → git probe → map → system prompt → session + records).
  const { session, sandboxFacts, gitFacts, memory, pruneTaskBaseRefs, stopAllPreviews, previewResumeNote } = await assembleSession({
    trust,
    config,
    ctx,
    layout,
    ...(opts.resumeId !== undefined ? { resumeId: opts.resumeId } : {}),
    argv: process.argv.slice(2),
    onText: (t: string): void => {
      process.stdout.write(t);
    },
    onTaskProgress: (line: string): void => {
      process.stderr.write(`[task] ${sanitizeLine(line)}\n`);
    },
  });

  if (values['dangerously-allow-all']) {
    process.stderr.write('⚠ --dangerously-allow-all: approvals are bypassed. No isolation whatsoever.\n');
  }
  if (ctx.provider instanceof AnthropicProvider) {
    process.stderr.write(`network: ${ctx.provider.transport}\n`);
  }
  process.stderr.write(`sandbox: ${sandboxFacts.summary}\n`);
  if (gitFacts.isRepo || gitFacts.probeFailed) process.stderr.write(`git: ${gitFacts.detail}\n`);
  process.stderr.write(`memory: ${memory.bannerLine}\n`);
  if (memory.crashNote !== null) process.stderr.write(`note: ${memory.crashNote}\n`);
  if (previewResumeNote !== undefined) process.stderr.write(`note: ${previewResumeNote}\n`);

  // Best-effort, bounded, closed-log-tolerant: previews are stopped on EVERY exit path — a
  // one-shot run has nobody left to manage a server after it returns (Session 13). Called
  // before endSession on the normal paths so the preview.ended events land in the open log;
  // the finally call is an idempotent backstop for paths that threw before reaching it.
  const stopPreviews = async (): Promise<void> => {
    try {
      const line = await stopAllPreviews();
      if (line !== null) process.stderr.write(`previews: ${line}\n`);
    } catch {
      /* the next session's sweep is the backstop */
    }
  };

  const offSigint = installSigintAbort(controller, undefined, undefined, () => {
    // Fire-and-forget: killTree issues its spawn/kill synchronously before the first await, so
    // even without awaiting, the kills land before process.exit. The events are lost (the exit
    // is immediate); the next session's sweep + this line are the honest record.
    process.stderr.write('force-quit: stopping preview server(s); the next session\'s sweep verifies\n');
    void stopAllPreviews();
  });
  try {
    const result = await runTurn(session, task, { signal: controller.signal });
    const reason = endReasonForTurn(result, ctx.maxSteps);
    if (reason !== 'aborted') {
      // Session-end hygiene before endSession (the event must land in the open log).
      if (pruneTaskBaseRefs !== undefined) {
        try {
          const pruneLine = await pruneTaskBaseRefs();
          if (pruneLine !== null) process.stderr.write(`${pruneLine}\n`);
        } catch {
          /* best-effort hygiene */
        }
      }
      await runMemoryUpdate(session, {
        layout,
        enabled: config.memoryUpdates !== false,
        endedReason: reason,
        announce: (l) => process.stderr.write(`${l}\n`),
      });
    }
    // Previews are stopped even on the 'aborted' path — the user asked everything to stop,
    // which argues FOR killing the server, not against (Session 13).
    await stopPreviews();
    endSession(session, reason);
    process.stdout.write('\n');
    printVerdict(layout, session.id);
    return result.denials > 0 || result.stopped ? 2 : 0;
  } catch (err) {
    await stopPreviews();
    endSession(session, 'error', (err as Error).message);
    process.stderr.write(`\nerror: ${(err as Error).message}\n`);
    return 1;
  } finally {
    offSigint();
    // Idempotent backstop: on any path that somehow skipped the in-log stop, the processes are
    // still stopped (their events are then swallowed by the closed-log tolerance — honest cost).
    void stopPreviews();
  }
}

function printVerdict(layout: ProjectLayout, id: string): void {
  const { events } = EventLog.readLenient(layout.sessionFile(id));
  const { json } = buildReport({ events });
  const checked = json.filesChanged.filter((f) => f.checked).length;
  process.stdout.write(
    `done: ${json.filesChanged.length} file(s) changed, ${json.commands.length} command(s) run, ` +
      `${checked} checked. session ${id}\n` +
      `report: agent report ${id}\n`,
  );
}

function cmdReport(values: CliValues, id?: string): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws);
  const sessionId = id ?? values.session ?? latestSessionId(layout);
  if (!sessionId) {
    process.stderr.write('no sessions found for this workspace\n');
    return 1;
  }
  const read = EventLog.readLenient(layout.sessionFile(sessionId));
  const report = buildReport(read.corruptAt ? { events: read.events, truncatedTail: read.truncatedTail, corruptAt: read.corruptAt } : { events: read.events, truncatedTail: read.truncatedTail });
  process.stdout.write((values.json ? JSON.stringify(report.json, null, 2) : report.md) + '\n');
  return 0;
}

function cmdDiff(values: CliValues, id?: string): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws);
  const sessionId = id ?? values.session ?? latestSessionId(layout);
  if (!sessionId) {
    process.stderr.write('no sessions found for this workspace\n');
    return 1;
  }
  const { events } = EventLog.readLenient(layout.sessionFile(sessionId));
  const files = buildSessionDiff(events, new SnapshotStore(layout.objectsDir), ws);
  // Diff lines are workspace bytes — untrusted content headed for a terminal; sanitize each line.
  process.stdout.write(renderSessionDiff(files).split('\n').map(sanitizeLine).join('\n') + '\n');
  return 0;
}

/**
 * `agent commit` — a deliberate delivery action. Trust-gated (it executes repo hooks and
 * mutates .git), attribution comes from a recorded session's evidence log, and the git.commit
 * event is appended to that session's log (which requires its lock — a session still running
 * elsewhere holds it; commit from inside that REPL instead).
 */
async function cmdCommit(values: CliValues): Promise<number> {
  const ws = workspaceRoot(values);
  const trust = await checkTrust(values, ws);
  if (!trust.trusted) {
    process.stderr.write(`refusing to commit: ${trust.reason}\n`);
    return 3;
  }
  const gitFacts = await detectGitFacts(ws);
  if (!gitFacts.isRepo || gitFacts.gitPath === null || gitFacts.repoRoot === null) {
    process.stderr.write(`agent commit needs a git repository: ${gitFacts.detail}\n`);
    return 1;
  }
  const layout = resolveLayout(ws);
  const sessionId = values.session ?? latestSessionId(layout);
  if (!sessionId) {
    process.stderr.write('no recorded session for this workspace — agent commit delivers a session\'s work. Use git directly for ordinary commits\n');
    return 1;
  }
  const log = EventLog.open({ file: layout.sessionFile(sessionId), lockFile: layout.lockFile(sessionId) });
  try {
    const isTty = process.stdin.isTTY === true && process.stderr.isTTY === true;
    const outcome = await runCommitFlow(
      { gitPath: gitFacts.gitPath, repoRoot: gitFacts.repoRoot, workspaceRoot: ws, messageDir: layout.projectDir },
      log.events,
      {
        scope: values.all ? 'all' : 'session',
        ...(values.m !== undefined ? { subject: values.m } : {}),
        trailer: values['no-trailer'] !== true,
        sessionId,
        io: {
          info: (line) => process.stderr.write(sanitizeLine(line) + '\n'),
          question: isTty ? askOnTty : null,
          assumeYes: values.yes === true,
        },
      },
    );
    if (outcome.committed && outcome.result?.oid) {
      log.append({
        type: 'git.commit',
        oid: outcome.result.oid,
        subject: outcome.subject ?? '',
        files: outcome.result.files,
        scope: values.all ? 'all' : 'session',
        trailer: values['no-trailer'] !== true,
      });
      process.stdout.write(`committed ${outcome.result.oid.slice(0, 12)} (${outcome.result.files.length} file(s)) — session ${sessionId}\n`);
      return 0;
    }
    return 2;
  } finally {
    log.close();
  }
}

/** `agent checkpoint [list|prune|restore <n>|<label>]` — trust-gated (it executes git against the repo). */
async function cmdCheckpoint(values: CliValues, sub?: string, subArg?: string): Promise<number> {
  const ws = workspaceRoot(values);
  const trust = await checkTrust(values, ws);
  if (!trust.trusted) {
    process.stderr.write(`refusing: ${trust.reason}\n`);
    return 3;
  }
  const gitFacts = await detectGitFacts(ws);
  if (!gitFacts.isRepo || gitFacts.gitPath === null || gitFacts.repoRoot === null) {
    process.stderr.write(`agent checkpoint needs a git repository: ${gitFacts.detail}\n`);
    return 1;
  }
  const layout = resolveLayout(ws);
  const cctx: CheckpointContext = { gitPath: gitFacts.gitPath, repoRoot: gitFacts.repoRoot, workspaceRoot: ws, stateDir: layout.projectDir };

  if (sub === 'list') {
    const list = await listCheckpoints(cctx);
    if (list.length === 0) process.stdout.write('no checkpoints in this repository\n');
    for (const c of list) process.stdout.write(`${c.oid.slice(0, 12)}  ${sanitizeLine(c.subject)}  (${c.createdAt})\n`);
    return 0;
  }

  const sessionId = values.session ?? latestSessionId(layout);
  if (sub === 'prune') {
    const target = values.all ? undefined : sessionId;
    if (!values.all && !target) {
      process.stderr.write('no session to prune checkpoints for (use --all for every session)\n');
      return 1;
    }
    const refs = await listCheckpoints(cctx, target);
    if (refs.length === 0) {
      process.stdout.write('no checkpoint refs to prune\n');
      return 0;
    }
    if (values.yes !== true) {
      const isTty = process.stdin.isTTY === true && process.stderr.isTTY === true;
      if (!isTty) {
        process.stderr.write('pruning deletes recovery points; non-interactive prune requires --yes\n');
        return 2;
      }
      const a = await askOnTty(`delete ${refs.length} checkpoint ref(s)${values.all ? ' across ALL sessions' : ''}? [y/N] `);
      if (a === null || !/^y(es)?$/i.test(a.trim())) {
        process.stderr.write('prune cancelled\n');
        return 2;
      }
    }
    const r = await pruneCheckpoints(cctx, target);
    process.stdout.write(`pruned ${r.deleted.length} checkpoint ref(s)${r.failed.length > 0 ? `; ${r.failed.length} failed` : ''}\n`);
    return r.failed.length > 0 ? 1 : 0;
  }

  if (sub === 'restore') {
    const n = Number(subArg);
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write('usage: agent checkpoint restore <n> [--session <id>] [--yes]\n');
      return 1;
    }
    if (!sessionId) {
      process.stderr.write('no session to restore a checkpoint for\n');
      return 1;
    }
    const mine = await listCheckpoints(cctx, sessionId);
    const ckpt = mine.find((c) => c.n === n);
    if (!ckpt) {
      process.stderr.write(`no checkpoint ${n} for session ${sessionId} (agent checkpoint list)\n`);
      return 1;
    }
    const log = EventLog.open({ file: layout.sessionFile(sessionId), lockFile: layout.lockFile(sessionId) });
    try {
      const isTty = process.stdin.isTTY === true && process.stderr.isTTY === true;
      const r = await runRestoreFlow(cctx, ckpt, {
        snapshots: new SnapshotStore(layout.objectsDir),
        appendEvent: (e) => void log.append(e),
        callId: `git-restore-${log.events.length}`,
        info: (l) => process.stderr.write(sanitizeLine(l) + '\n'),
        question: isTty ? askOnTty : null,
        assumeYes: values.yes === true,
      });
      if (!r.performed) return 2;
      process.stdout.write(`restored ${r.restored.length} file(s) to ${ckpt.ref}${r.refused.length > 0 ? `; ${r.refused.length} refused` : ''}\n`);
      process.stdout.write('undo this restore with: agent undo\n');
      return r.refused.length > 0 ? 1 : 0;
    } finally {
      log.close();
    }
  }

  // create (sub, when present and not a subcommand, is the label)
  if (!sessionId) {
    process.stderr.write('no recorded session for this workspace — a checkpoint is filed under a session\n');
    return 1;
  }
  const log = EventLog.open({ file: layout.sessionFile(sessionId), lockFile: layout.lockFile(sessionId) });
  try {
    const isTty = process.stdin.isTTY === true && process.stderr.isTTY === true;
    const r = await createCheckpoint(cctx, sessionId, {
      ...(sub !== undefined ? { label: sub } : {}),
      confirmLargeUntracked: async (count) => {
        if (values.yes === true) return true;
        if (!isTty) return false;
        const a = await askOnTty(`capture ${count} untracked files too? (is something big not gitignored?) [y/N] `);
        return a !== null && /^y(es)?$/i.test(a.trim());
      },
    });
    if (!r.ok || !r.ref || !r.oid) {
      process.stderr.write(`checkpoint not created: ${r.error}\n`);
      return r.declined ? 2 : 1;
    }
    log.append({ type: 'git.checkpoint', ref: r.ref, oid: r.oid, label: sub ?? null, filesChanged: r.filesChanged ?? 0 });
    process.stdout.write(`checkpoint ${r.ref} @ ${r.oid.slice(0, 12)} (${r.filesChanged} file(s) differ from HEAD)\n`);
    return 0;
  } finally {
    log.close();
  }
}

async function askOnTty(q: string): Promise<string | null> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(q);
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/**
 * Read-only view of a session's plan document (V0.7). Ungated (like report/sessions): reads
 * only harness state, creates nothing, sends nothing to a model. Approval and discard are
 * in-session acts (/plan approve|discard) — they are consent, and consent needs the session.
 */
function cmdPlan(values: CliValues, id?: string): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws);
  const sessionId = id ?? values.session ?? latestSessionId(layout);
  if (!sessionId) {
    process.stderr.write('no sessions found for this workspace\n');
    return 1;
  }
  const plan = readPlan(layout, sessionId);
  if (!plan.exists) {
    process.stderr.write(`no plan document for session ${sessionId}\n`);
    return 1;
  }
  process.stderr.write(
    `plan ${sanitizeLine(plan.planId)} — status: ${plan.status} · sha256 ${plan.sha256 ?? 'unreadable'} · ${plan.bytes} bytes\n` +
      `file (editable): ${sanitizeLine(plan.file)}\n\n`,
  );
  process.stdout.write(plan.text + (plan.text.endsWith('\n') ? '' : '\n'));
  if (plan.truncated) process.stderr.write('(display truncated; the full plan is in the file)\n');
  return 0;
}

/**
 * Read-only view of the three project-memory documents: where they live, whether they loaded,
 * and their provenance. Ungated (like report/sessions): reads only harness state + AGENT.md
 * presence, creates nothing, sends nothing to a model.
 */
function cmdMemory(values: CliValues): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws);
  const dir = memoryDir(layout.projectDir);
  const agentFile = path.join(ws, 'AGENT.md');
  const out = process.stdout;

  out.write(`memory home: ${dir}\n\n`);
  const agent = readDocCapped(agentFile, 'AGENT.md', 1024 * 1024);
  out.write(`AGENT.md (user-owned project constitution, loaded into every session)\n`);
  out.write(`  ${agentFile}\n  ${agent.status === 'missing' ? 'absent — create it to give every session durable instructions' : describeDoc(agent)}\n\n`);

  for (const name of ['JOURNAL.md', 'CODEBASE.md'] as const) {
    const doc = readDocCapped(path.join(dir, name), name, 1024 * 1024);
    const kind = name === 'JOURNAL.md' ? 'rolling session memory' : 'architecture summary';
    out.write(`${name} (harness-managed ${kind}; edits are welcome and preserved)\n`);
    out.write(`  ${path.join(dir, name)}\n`);
    if (doc.status === 'missing') {
      out.write('  absent — written automatically after the first productive session\n\n');
      continue;
    }
    const { fields } = parseFrontmatter(doc.text);
    const provenance =
      fields !== null
        ? ` · updated ${fields['updated'] ?? '?'} by session ${fields['last-session'] ?? fields['session'] ?? '?'}`
        : '';
    out.write(`  ${describeDoc(doc)}${provenance}\n\n`);
  }
  return 0;
}

function describeDoc(doc: { status: string; bytes: number }): string {
  const size = doc.bytes >= 1024 ? `${(doc.bytes / 1024).toFixed(1)} KiB` : `${doc.bytes} B`;
  return doc.status === 'unreadable' ? 'UNREADABLE (will be skipped at session start)' : `present (${size})`;
}

function cmdSessions(values: CliValues): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws);
  let files: string[];
  try {
    files = fs.readdirSync(layout.sessionsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    process.stdout.write('no sessions for this workspace\n');
    return 0;
  }
  for (const f of files.sort()) {
    const id = f.slice(0, -'.jsonl'.length);
    const { events } = EventLog.readLenient(layout.sessionFile(id));
    const started = events.find((e) => e.type === 'session.started');
    const ended = events.find((e) => e.type === 'session.ended');
    const task = events.find((e) => e.type === 'user.message');
    const status = ended?.type === 'session.ended' ? ended.reason : 'CRASHED/UNKNOWN';
    const first = task?.type === 'user.message' ? task.text.split('\n')[0]!.slice(0, 60) : '(no task)';
    const model = started?.type === 'session.started' ? started.model : '?';
    const lineage =
      started?.type === 'session.started' && started.lineage !== undefined
        ? `  [task:${started.lineage.role} of ${started.lineage.parentSessionId}]`
        : '';
    process.stdout.write(`${id}  [${status}]  ${model}  ${sanitizeLine(first)}${lineage}\n`);
  }
  return 0;
}

function cmdMap(values: CliValues): number {
  const ws = workspaceRoot(values);
  const map = buildWorkspaceMap(ws, values.budget ? { budget: Number(values.budget) } : {});
  // File names are untrusted folder content; escape terminal-spoofing characters for display.
  const safe = map.text.split('\n').map(sanitizeLine).join('\n');
  process.stdout.write(safe + `\n\n(${map.fileCount} files${map.truncated ? ', truncated' : ''})\n`);
  return 0;
}

function cmdUndo(values: CliValues): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws);
  const id = values.session ?? latestSessionId(layout);
  if (!id) {
    process.stderr.write('no sessions found for this workspace\n');
    return 1;
  }
  const log = EventLog.open({ file: layout.sessionFile(id), lockFile: layout.lockFile(id) });
  try {
    const outcome = applyUndo(log.events, new SnapshotStore(layout.objectsDir), values.all ? 'all' : 'last');
    log.append({ type: 'undo.applied', target: outcome.target, restored: outcome.restored, refused: outcome.refused });
    if (outcome.restored.length === 0 && outcome.refused.length === 0) {
      process.stdout.write('nothing to undo\n');
    } else {
      for (const r of outcome.restored) process.stdout.write(`restored ${r.path}\n`);
      for (const r of outcome.refused) process.stdout.write(`refused  ${r.path}: ${r.reason}\n`);
    }
    process.stdout.write(
      'note: undo covers only write_file/edit_file changes. run_command side effects are not captured.\n',
    );
    return outcome.refused.length > 0 && outcome.restored.length === 0 ? 1 : 0;
  } finally {
    log.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const { values, positionals } = args;
  if (values.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }

  try {
    const cmd = positionals[0];
    if (cmd === 'report') return cmdReport(values, positionals[1]);
    if (cmd === 'plan') return cmdPlan(values, positionals[1]);
    if (cmd === 'diff') return cmdDiff(values, positionals[1]);
    if (cmd === 'commit') return await cmdCommit(values);
    if (cmd === 'checkpoint') return await cmdCheckpoint(values, positionals[1], positionals[2]);
    if (cmd === 'sessions') return cmdSessions(values);
    if (cmd === 'map') return cmdMap(values);
    if (cmd === 'memory') return cmdMemory(values);
    if (cmd === 'undo') return await cmdUndo(values);
    if (cmd === 'trust') {
      return await cmdTrust({ ...(values.revoke !== undefined ? { revoke: values.revoke } : {}), ...(values.list !== undefined ? { list: values.list } : {}) }, resolveStateRoot(), workspaceRoot(values));
    }
    if (cmd === 'resume') {
      const id = positionals[1];
      const task = positionals[2];
      if (!id) {
        process.stderr.write('usage: agent resume <id> ["<task>"]\n');
        return 1;
      }
      if (!task) {
        if (!process.stdin.isTTY && !values.interactive) {
          process.stderr.write('agent resume <id> without a task starts the REPL; that needs a terminal (or --interactive)\n');
          return 1;
        }
        return await runRepl(values, { resumeId: id });
      }
      return await runTask(values, task, { resumeId: id });
    }
    if (cmd === 'run') {
      const task = positionals[1];
      if (!task) {
        process.stderr.write('usage: agent run "<task>"\n');
        return 1;
      }
      return await runTask(values, task, {});
    }
    // Bare task, --continue, or the bare-invocation REPL.
    if (values.continue) {
      const ws = workspaceRoot(values);
      const layout = resolveLayout(ws);
      const id = latestSessionId(layout);
      if (!id) {
        process.stderr.write('no session to continue\n');
        return 1;
      }
      if (!cmd) {
        if (!process.stdin.isTTY && !values.interactive) {
          process.stderr.write('agent --continue without a task starts the REPL; that needs a terminal (or --interactive)\n');
          return 1;
        }
        return await runRepl(values, { resumeId: id });
      }
      return await runTask(values, cmd, { resumeId: id });
    }
    if (cmd && !KNOWN.has(cmd)) return await runTask(values, cmd, {});
    if (!cmd && (process.stdin.isTTY || values.interactive)) {
      return await runRepl(values, {});
    }
    process.stdout.write(USAGE + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

// Auto-run only when invoked as the program entry (not when imported by tests).
// argv[1] must be realpath'd before comparing: Node resolves the main module's
// import.meta.url through symlinks, so a bin shim invoking the SYMLINKED path
// (npm link / linked global installs) would never match and the CLI would exit
// silently with code 0.
function isProgramEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync.native(entry)).href;
  } catch {
    return false;
  }
}
if (isProgramEntry()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
