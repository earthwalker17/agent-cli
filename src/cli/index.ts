#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveLayout, resolveStateRoot, type ProjectLayout } from '../store/layout.js';
import { cmdTrust } from '../trust/commands.js';
import { checkTrust } from './trust-check.js';
import { loadConfig } from '../config/config.js';
import { runRepl } from '../repl/repl.js';
import { EventLog } from '../store/event-log.js';
import { SnapshotStore } from '../store/snapshots.js';
import { startSession, resumeSession, endSession, runTurn, recordWorkspaceMap, type Session } from '../runtime/session.js';
import { applyUndo } from '../runtime/undo.js';
import { buildWorkspaceMap } from '../workspace/map.js';
import { buildSystemPrompt } from '../workspace/system-prompt.js';
import { buildReport } from '../report/report.js';
import { AnthropicProvider } from '../provider/anthropic.js';
import { randomSaltHex } from '../shared/hash.js';
import { sanitizeLine } from '../shared/text.js';
import { buildRunContext, latestSessionId, workspaceRoot, type CliValues } from './context.js';

const USAGE = `Agent CLI — a bounded local agent harness (V0.2).

Usage:
  agent                          Start an interactive session (REPL) in the current directory
  agent "<task>"                 Run a one-shot task in the current directory
  agent --continue ["<task>"]    Resume the latest session (REPL without a task, one-shot with)
  agent resume <id> ["<task>"]   Resume a specific session (REPL without a task, one-shot with)
  agent undo [--all]             Undo the last file change (or all changes) of a session
  agent report [<id>] [--json]   Print the evidence report for a session (default: latest)
  agent sessions                 List sessions for this workspace
  agent map [--budget <n>]       Print the workspace map the model would receive
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

Security: V0.2 has NO OS sandbox. The only control is the approval prompt. An approved command
runs with your full privileges and is not undoable. Workspace trust is recorded consent, not
isolation. See README "Security model & honest limitations".`;

const KNOWN = new Set(['run', 'resume', 'undo', 'report', 'sessions', 'map', 'trust']);

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
): () => void {
  let presses = 0;
  const onSigint = (): void => {
    presses++;
    if (presses === 1) {
      out.write('\ninterrupt: stopping the turn (press Ctrl+C again to force-quit)\n');
      controller.abort();
    } else {
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
  const ctx = buildRunContext(values, { config });
  const layout = resolveLayout(ctx.ws, { ensure: true });
  const map = buildWorkspaceMap(ctx.ws);
  const system = buildSystemPrompt(ctx.ws, map);
  const onText = (t: string): void => {
    process.stdout.write(t);
  };

  if (values['dangerously-allow-all']) {
    process.stderr.write('⚠ --dangerously-allow-all: approvals are bypassed. No isolation whatsoever.\n');
  }
  if (ctx.provider instanceof AnthropicProvider) {
    process.stderr.write(`network: ${ctx.provider.transport}\n`);
  }

  const common = {
    workspaceRoot: ctx.ws,
    layout,
    model: ctx.model,
    mode: ctx.mode,
    provider: ctx.provider,
    approver: ctx.approver,
    system,
    maxSteps: ctx.maxSteps,
    maxTokens: ctx.maxTokens,
    saltHex: randomSaltHex(),
    onText,
    rules: config.rules,
  };
  let session: Session;
  if (opts.resumeId) {
    session = resumeSession({ ...common, sessionId: opts.resumeId });
  } else {
    session = startSession({ ...common, argv: process.argv.slice(2) });
  }
  session.log.append({ type: 'trust.verified', source: trust.source });
  session.log.append({ type: 'config.loaded', sources: config.sources });
  recordWorkspaceMap(session, map);

  const controller = new AbortController();
  const offSigint = installSigintAbort(controller);
  try {
    const result = await runTurn(session, task, { signal: controller.signal });
    endSession(session, result.stopped && result.steps >= ctx.maxSteps ? 'max-steps' : result.stopped ? 'user-quit' : 'completed');
    process.stdout.write('\n');
    printVerdict(layout, session.id);
    return result.denials > 0 || result.stopped ? 2 : 0;
  } catch (err) {
    endSession(session, 'error', (err as Error).message);
    process.stderr.write(`\nerror: ${(err as Error).message}\n`);
    return 1;
  } finally {
    offSigint();
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
    process.stdout.write(`${id}  [${status}]  ${model}  ${first}\n`);
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
    if (cmd === 'sessions') return cmdSessions(values);
    if (cmd === 'map') return cmdMap(values);
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
