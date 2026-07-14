#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveLayout, type ProjectLayout } from './store/layout.js';
import { EventLog } from './store/event-log.js';
import { SnapshotStore } from './store/snapshots.js';
import { startSession, resumeSession, endSession, runTurn, recordWorkspaceMap, type Session } from './runtime/session.js';
import { autoDenyApprover, dangerousApprover, createInteractiveApprover } from './runtime/approvals.js';
import { applyUndo } from './runtime/undo.js';
import { buildWorkspaceMap } from './workspace/map.js';
import { buildSystemPrompt } from './workspace/system-prompt.js';
import { buildReport } from './report/report.js';
import { MockProvider, parseScript } from './provider/mock.js';
import { AnthropicProvider } from './provider/anthropic.js';
import { randomSaltHex } from './shared/hash.js';
import { ConfigError } from './shared/errors.js';
import type { Approver, Provider, SessionMode } from './types.js';

const USAGE = `Agent CLI — a bounded local agent harness (V0.1).

Usage:
  agent "<task>"                 Run a one-shot task in the current directory
  agent --continue "<task>"      Resume the latest session with a follow-up task
  agent resume <id> "<task>"     Resume a specific session with a follow-up task
  agent undo [--all]             Undo the last file change (or all changes) of a session
  agent report [<id>] [--json]   Print the evidence report for a session (default: latest)
  agent sessions                 List sessions for this workspace
  agent map [--budget <n>]       Print the workspace map the model would receive

Options:
  -C <dir>                 Workspace root (default: current directory)
  --provider anthropic|mock   Model provider (default: anthropic)
  --script <file>          Scripted turns (required with --provider mock)
  --model <id>             Model id (default: claude-opus-4-8)
  --no-input               Non-interactive: every approval auto-denies (also auto-detected off a TTY)
  --max-turns <n>          Maximum agent steps per task (default: 20)
  --dangerously-allow-all  Bypass approvals (loud; every auto-allow is logged). No isolation whatsoever.
  --session <id>           Target session for undo (default: latest)
  -h, --help               Show this help

Security: V0.1 has NO OS sandbox. The only control is the approval prompt. An approved command
runs with your full privileges and is not undoable. See README "Security model & honest limitations".`;

const DEFAULT_MODEL = 'claude-opus-4-8';
const KNOWN = new Set(['run', 'resume', 'undo', 'report', 'sessions', 'map']);

interface Args {
  values: {
    C?: string;
    provider?: string;
    script?: string;
    model?: string;
    'no-input'?: boolean;
    'max-turns'?: string;
    'dangerously-allow-all'?: boolean;
    session?: string;
    budget?: string;
    json?: boolean;
    all?: boolean;
    continue?: boolean;
    help?: boolean;
  };
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
      'max-turns': { type: 'string' },
      'dangerously-allow-all': { type: 'boolean' },
      session: { type: 'string' },
      budget: { type: 'string' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      continue: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }) as Args;
}

function workspaceRoot(values: Args['values']): string {
  const dir = values.C ? path.resolve(values.C) : process.cwd();
  if (!fs.existsSync(dir)) throw new ConfigError(`workspace directory does not exist: ${dir}`);
  return fs.realpathSync.native(dir);
}

function makeProvider(values: Args['values']): Provider {
  const kind = values.provider ?? 'anthropic';
  if (kind === 'mock') {
    if (!values.script) throw new ConfigError('--provider mock requires --script <file>');
    return new MockProvider(parseScript(fs.readFileSync(values.script, 'utf8')));
  }
  if (kind === 'anthropic') return new AnthropicProvider();
  throw new ConfigError(`unknown provider: ${kind}`);
}

function makeApprover(values: Args['values'], mode: SessionMode): Approver {
  if (values['dangerously-allow-all']) return dangerousApprover;
  if (mode === 'non-interactive') return autoDenyApprover;
  return createInteractiveApprover();
}

function resolveMode(values: Args['values']): SessionMode {
  return values['no-input'] || !process.stdin.isTTY ? 'non-interactive' : 'interactive';
}

function latestSessionId(layout: ProjectLayout): string | undefined {
  try {
    return fs
      .readdirSync(layout.sessionsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort()
      .pop();
  } catch {
    return undefined;
  }
}

/** Shared run/resume tail: run one task turn, end the session, print a verdict. */
async function runTask(values: Args['values'], task: string, opts: { resumeId?: string }): Promise<number> {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws, { ensure: true });
  const mode = resolveMode(values);
  const provider = makeProvider(values);
  const approver = makeApprover(values, mode);
  const model = values.model ?? DEFAULT_MODEL;
  const maxSteps = values['max-turns'] ? Number(values['max-turns']) : 20;
  const maxTokens = provider.name === 'anthropic' ? 64_000 : 16_000;
  const map = buildWorkspaceMap(ws);
  const system = buildSystemPrompt(ws, map);
  const onText = (t: string): void => {
    process.stdout.write(t);
  };

  if (values['dangerously-allow-all']) {
    process.stderr.write('⚠ --dangerously-allow-all: approvals are bypassed. No isolation whatsoever.\n');
  }

  let session: Session;
  if (opts.resumeId) {
    session = resumeSession({ workspaceRoot: ws, layout, model, mode, provider, approver, system, maxSteps, maxTokens, saltHex: randomSaltHex(), sessionId: opts.resumeId, onText });
  } else {
    session = startSession({ workspaceRoot: ws, layout, model, mode, provider, approver, system, maxSteps, maxTokens, saltHex: randomSaltHex(), argv: process.argv.slice(2), onText });
  }
  recordWorkspaceMap(session, map);

  try {
    const result = await runTurn(session, task);
    endSession(session, result.stopped && result.steps >= maxSteps ? 'max-steps' : result.stopped ? 'user-quit' : 'completed');
    process.stdout.write('\n');
    printVerdict(layout, session.id);
    return result.denials > 0 || result.stopped ? 2 : 0;
  } catch (err) {
    endSession(session, 'error', (err as Error).message);
    process.stderr.write(`\nerror: ${(err as Error).message}\n`);
    return 1;
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

function cmdReport(values: Args['values'], id?: string): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws, { ensure: true });
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

function cmdSessions(values: Args['values']): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws, { ensure: true });
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

function cmdMap(values: Args['values']): number {
  const ws = workspaceRoot(values);
  const map = buildWorkspaceMap(ws, values.budget ? { budget: Number(values.budget) } : {});
  process.stdout.write(map.text + `\n\n(${map.fileCount} files${map.truncated ? ', truncated' : ''})\n`);
  return 0;
}

function cmdUndo(values: Args['values']): number {
  const ws = workspaceRoot(values);
  const layout = resolveLayout(ws, { ensure: true });
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
    if (cmd === 'resume') {
      const id = positionals[1];
      const task = positionals[2];
      if (!id || !task) {
        process.stderr.write('usage: agent resume <id> "<task>"\n');
        return 1;
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
    // Bare task, or --continue.
    if (values.continue) {
      const ws = workspaceRoot(values);
      const layout = resolveLayout(ws, { ensure: true });
      const id = latestSessionId(layout);
      if (!id) {
        process.stderr.write('no session to continue\n');
        return 1;
      }
      if (!cmd) {
        process.stderr.write('usage: agent --continue "<task>"\n');
        return 1;
      }
      return await runTask(values, cmd, { resumeId: id });
    }
    if (cmd && !KNOWN.has(cmd)) return await runTask(values, cmd, {});
    process.stdout.write(USAGE + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

// Auto-run only when invoked as the program entry (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    },
  );
}
