#!/usr/bin/env node
// FIRST, and deliberately above every other import: ESM evaluates imports in source order, so a
// dependency-free module here is the only thing that can run before the rest of the graph loads.
// See src/cli/node-floor.ts for why a check in this file's own body would not be first at all.
import './node-floor.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveLayout, resolveStateRoot, type ProjectLayout } from '../store/layout.js';
import { grantsFile, grantsLogFile, readGrants, revokeGrant } from '../store/grants.js';
import { cmdTrust } from '../trust/commands.js';
import { checkTrust } from './trust-check.js';
import { loadConfig } from '../config/config.js';
import { runRepl } from '../repl/repl.js';
import { EventLog } from '../store/event-log.js';
import { SnapshotStore } from '../store/snapshots.js';
import { DEFAULT_MAX_STEPS, endReasonForTurn, endSession, runTurn, type Session } from '../runtime/session.js';
import { detectGitFacts } from '../git/facts.js';
import { applyUndo } from '../runtime/undo.js';
import { buildWorkspaceMap } from '../workspace/map.js';
import { approvedCurrentGraph, readPlanState } from '../plan/canonical.js';
import { renderUserPlanView } from '../plan/views.js';
import { buildReport, effectiveIdentity } from '../report/report.js';
import { buildSessionDiff, renderSessionDiff } from '../report/diff.js';
import { runCommitFlow } from '../git/commit.js';
import { createCheckpoint, deleteCheckpointRefs, isDeliverySubject, listCheckpoints, runRestoreFlow, type CheckpointContext } from '../git/checkpoint.js';
import { sanitizeLine } from '../shared/text.js';
import { DEFAULT_MODEL, buildRunContext, latestSessionId, workspaceRoot, type CliValues } from './context.js';
import { CATALOG_VERIFIED, modelsFor } from '../provider/catalog.js';
import { createProviderRegistry } from '../provider/registry.js';
import { assembleSession } from './assemble.js';
import { memoryDir, parseFrontmatter, readDocCapped } from '../memory/store.js';
import { runMemoryUpdate } from '../memory/update.js';

// The single version source is package.json; the CLI reads its own copy so the banner can
// never drift from the published version again (the usage header sat at "V0.7" for seven
// sessions). Read once at module load; any failure degrades to 'unknown', never a throw.
function cliVersion(): string {
  try {
    const v = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}
export const VERSION = cliVersion();

const USAGE = `Agent CLI v${VERSION} — a bounded local agent harness.

Usage:
  agent                          Start an interactive session (REPL) in the current directory
  agent "<task>"                 Run a one-shot task in the current directory
  agent run "<task>"             The same, said explicitly (use it when the task is one word,
                                 or looks like a subcommand)
  agent --continue ["<task>"]    Resume the latest session (REPL without a task, one-shot with)
  agent resume <id> ["<task>"]   Resume a specific session (REPL without a task, one-shot with)
  agent undo [--all]             Undo the last file change (or all changes) of a session
  agent diff [<id>]              Show what a session changed (unified diff; default: latest)
  agent commit [-m "msg"] [--all] [--yes] [--no-trailer]
                                 Commit session-attributed changes (preview + confirmation;
                                 --all = every workspace change; requires workspace trust)
  agent checkpoint [label]       Capture the workspace to a hidden git ref (recovery point)
  agent checkpoint list|prune    List checkpoints, or delete this session's refs so git gc
                                 can collect them (prune takes --all / --yes;
                                 delivery anchors are KEPT unless --include-delivery)
  agent checkpoint restore <n>   Return the workspace to checkpoint <n> (snapshot-first,
                                 one undoable batch; deletes files the checkpoint predates)
  agent report [<id>] [--json]   Print the evidence report for a session (default: latest)
  agent plan [<id>]              Print a session's plan document (default: latest; read-only —
                                 approve/discard from inside the session with /plan)
  agent sessions                 List sessions for this workspace
  agent map [--budget <n>]       Print the workspace map the model would receive
  agent memory                   Show the project-memory documents (paths, status, provenance)
  agent init                     Points at /init (the interactive onboarding lives in the REPL)
  agent grants [revoke <id>]     List or revoke durable machine grants ("always allow" records)
  agent trust [--revoke|--list]  Manage recorded workspace trust (consent, not a sandbox)
  agent providers [--json]       List providers, models, key env vars (presence only — never
                                 values), base URLs, and where to obtain keys. No network.
  agent version | help           Print the version / this help (never starts a session)

Options:
  -C <dir>                 Workspace root (default: current directory)
  --provider <name>        anthropic|openai|deepseek|kimi|glm|mock (default: anthropic;
                           credentials are env-only — see \`agent providers\`)
  --script <file>          Scripted turns (required with --provider mock)
  --model <id>             Model id (default: the provider's catalog default;
                           anthropic: ${DEFAULT_MODEL})
  --no-input               Non-interactive: every approval auto-denies (also auto-detected off a TTY)
  --interactive            Force interactive mode on piped stdio (expect-style test driving)
  --max-steps <n>          Maximum agent steps per turn (default: ${String(DEFAULT_MAX_STEPS)}; --max-turns is the
                           legacy alias for the same limit)
  --dangerously-allow-all  Bypass approvals (loud; every auto-allow is logged). No isolation whatsoever.
  --session <id>           Target session for undo/diff/commit/checkpoint/report/plan (default: latest)
  --trust-this-workspace   Proceed in an untrusted workspace for THIS invocation only (not recorded)
  --version                Print the version and exit
  -h, --help               Show this help

Exit codes: 0 ok · 1 error · 2 a one-shot that hit denials or the step budget, and also commit when
nothing was committed, checkpoint prune when cancelled or non-interactive without --yes, and
checkpoint restore when not performed (the REPL reports denials inline and exits 0 on a clean
quit) · 3 workspace not trusted · 130 a second Ctrl+C during a one-shot turn (force-quit).

Security: command authorization is automatic. On Windows a demonstrably read-only command may
auto-run inside an OS sandbox at Low integrity (writes to the workspace/system/state are OS-denied
and the process tree is reaped on kill; reads and network are NOT confined). Every other command
asks; approved commands run UNSANDBOXED with full privilege and are not undoable. Where no enforced
sandbox is available, auto-run is disabled and every command asks (fail closed). Workspace trust is
recorded consent, not isolation. See README "Security model & honest limitations".`;

// 'version' and 'help' MUST be members: an unknown first positional falls through to a REAL
// one-shot model session, so before they were named here, `agent version` silently started a
// paid agent run with the literal task string "version".
const KNOWN = new Set(['run', 'resume', 'undo', 'diff', 'commit', 'checkpoint', 'report', 'plan', 'sessions', 'map', 'memory', 'trust', 'providers', 'grants', 'init', 'version', 'help']);

/**
 * In-session slash commands that are NOT process-level subcommands. Typed at the shell they used
 * to fall through to a real, BILLED model session with the word itself as the task (S21.5 audit:
 * `agent status` started a paid run). They are refused by name and pointed at the REPL.
 */
const REPL_ONLY = new Set([
  'status', 'accept', 'tasks', 'cancel', 'checks', 'review', 'repair', 'preview', 'research', 'remote', 'provider', 'model', 'quit', 'exit',
]);

/** Ordinary Levenshtein, bounded by the short words involved. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Why a bare positional must NOT become a one-shot session.
 *
 * The fall-through at the bottom of `main` sends any unrecognized first positional to `runTask`,
 * which starts a real model session and bills for it. `KNOWN` exists because `agent version` once
 * did exactly that — the class of bug was patched one word at a time, never removed. This closes
 * it for the whole shape: a SINGLE bare word that is nearly a subcommand, or is a slash command
 * from the REPL, is a mistake far more often than it is a task. Multi-word strings are untouched,
 * so `agent "fix the parser"` still works, and `agent run "<task>"` forces any string through.
 */
export function misdispatchGuard(cmd: string): string | null {
  if (/\s/.test(cmd)) return null; // a sentence is a task, never a mistyped verb
  const word = cmd.toLowerCase();
  const force = `if you really meant it as a task, say so explicitly: agent run "${cmd}"`;
  const spell = (name: string): string => (REPL_ONLY.has(name) ? `/${name} (in the session)` : `agent ${name}`);

  if (REPL_ONLY.has(word)) {
    return `'${cmd}' is an in-session command, not a subcommand — start the agent with \`agent\` and type /${word} there.\n${force}`;
  }
  // Near-misses are checked against BOTH vocabularies: a typo of a slash command (`agent stauts`)
  // is exactly as much a mistake as a typo of a subcommand, and used to be exactly as expensive.
  const near = [...KNOWN, ...REPL_ONLY]
    .filter((k) => k !== 'run' && editDistance(word, k) <= (k.length <= 4 ? 1 : 2))
    .sort();
  if (near.length > 0) {
    return `unknown command '${cmd}' — did you mean ${near.map((n) => `\`${spell(n)}\``).join(' or ')}?\n${force}`;
  }
  return null;
}

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
      'max-steps': { type: 'string' },
      'max-turns': { type: 'string' },
      'dangerously-allow-all': { type: 'boolean' },
      'trust-this-workspace': { type: 'boolean' },
      'include-delivery': { type: 'boolean' },
      version: { type: 'boolean' },
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
  const { session, sandboxFacts, gitFacts, memory, pruneHarnessRefs, stopAllPreviews, previewResumeNote, providerResumeNote } = await assembleSession({
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
  for (const note of ctx.notes) process.stderr.write(`note: ${sanitizeLine(note)}\n`);
  process.stderr.write(`provider: ${ctx.provider.name} · model: ${ctx.model}\n`);
  const transport = ctx.provider.describeTransport?.();
  if (transport !== undefined) process.stderr.write(`network: ${transport}\n`);
  process.stderr.write(`sandbox: ${sandboxFacts.summary}\n`);
  if (gitFacts.isRepo || gitFacts.probeFailed) process.stderr.write(`git: ${gitFacts.detail}\n`);
  process.stderr.write(`memory: ${memory.bannerLine}\n`);
  if (memory.crashNote !== null) process.stderr.write(`note: ${memory.crashNote}\n`);
  if (previewResumeNote !== undefined) process.stderr.write(`note: ${previewResumeNote}\n`);
  if (providerResumeNote !== undefined) process.stderr.write(`note: ${providerResumeNote}\n`);

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
    if (result.stopReason === 'refusal' && !result.aborted) {
      // Session 15: a classifier decline is an HTTP-200 turn — surface it, never end silently.
      process.stderr.write('note: the model declined this request (stop reason: refusal) — rephrase or narrow the task\n');
    }
    const reason = endReasonForTurn(result, ctx.maxSteps);
    if (reason === 'max-steps') {
      // A silent mid-work stop is the worst way for a one-shot run to end (S20.5): say what
      // happened and hand the user the exact resume command — the work is NOT lost.
      process.stderr.write(
        `note: the step budget (${String(ctx.maxSteps)}) ended this turn MID-WORK — nothing failed. ` +
          `Continue with: agent resume ${session.id} (raise with --max-steps <n>)\n`,
      );
    }
    if (result.denials > 0) {
      // Exit 2 already says "denials or step budget" in aggregate; this line says WHICH, how
      // many, and where the specifics live — the difference between "it failed" and "it was
      // not allowed to do N things".
      process.stderr.write(
        `note: ${String(result.denials)} approval(s) were denied (non-interactive runs auto-deny) — the result is partial; see agent report ${session.id}\n`,
      );
    }
    if (reason !== 'aborted') {
      // Session-end hygiene before endSession (the event must land in the open log).
      if (pruneHarnessRefs !== undefined) {
        try {
          const pruneLine = await pruneHarnessRefs();
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

/**
 * `agent providers` (Session 15): a read-only listing of the provider/model catalog and key
 * discovery state. NO network, no session, no state creation; env var NAMES and presence only —
 * never a value. `--json` emits the same data machine-readably.
 */
function cmdProviders(values: CliValues): number {
  const registry = createProviderRegistry();
  const rows = registry.names().map((name) => {
    const a = registry.availability(name);
    return {
      name,
      display: a.info.display,
      protocol: a.info.protocol,
      keyEnvs: a.info.keyEnvs,
      keyPresent: a.present,
      ...(a.keyEnv !== undefined ? { keyEnv: a.keyEnv } : {}),
      baseUrl: a.baseUrl,
      baseUrlOverridden: a.baseUrlOverridden,
      ...(a.info.baseUrlEnv !== undefined ? { baseUrlEnv: a.info.baseUrlEnv } : {}),
      defaultModel: a.info.defaultModel,
      ...(a.info.keyUrl !== undefined ? { keyUrl: a.info.keyUrl } : {}),
      models: modelsFor(name).map((m) => ({
        id: m.id,
        lifecycle: m.lifecycle,
        contextTokens: m.contextTokens,
        maxOutputTokens: m.maxOutputTokens,
        vision: m.visionInput,
        reasoning: m.reasoning.mode,
      })),
    };
  });
  if (values.json) {
    process.stdout.write(JSON.stringify({ catalogVerified: CATALOG_VERIFIED, default: 'anthropic', providers: rows }, null, 2) + '\n');
    return 0;
  }
  const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(n / 1024)}K`);
  const L: string[] = [`providers (catalog verified ${CATALOG_VERIFIED}; default: anthropic · ${DEFAULT_MODEL}):`, ''];
  for (const r of rows) {
    L.push(`${r.name}  —  ${r.display} [${r.protocol}]`);
    L.push(`  key: ${r.keyEnvs.join(' or ')} ${r.keyPresent ? `[${r.keyEnv} set]` : '[NOT SET]'}`);
    if (r.keyUrl !== undefined) L.push(`  get a key: ${r.keyUrl}`);
    L.push(`  base: ${r.baseUrl}${r.baseUrlOverridden ? ` (overridden via ${r.baseUrlEnv})` : r.baseUrlEnv !== undefined ? ` (override: ${r.baseUrlEnv})` : ''}`);
    L.push(`  default model: ${r.defaultModel}`);
    for (const m of r.models) {
      L.push(
        `    ${m.id.padEnd(26)} ${fmt(m.contextTokens)} ctx / ${fmt(m.maxOutputTokens)} out · ${m.vision ? 'vision' : 'no images'} · reasoning ${m.reasoning}${m.lifecycle !== 'ga' ? ` · ${m.lifecycle.toUpperCase()}` : ''}`,
      );
    }
    L.push('');
  }
  L.push('credentials are env-only; keys never appear in logs, reports, or events.');
  process.stdout.write(L.join('\n') + '\n');
  return 0;
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
  // The approved graph is an INPUT (S14.5): without it the review section could not state the
  // gate's requirement or its open blockers for an unaccepted session.
  const approvedGraph = approvedCurrentGraph(readPlanState(layout, sessionId, read.events));
  const report = buildReport({
    events: read.events,
    truncatedTail: read.truncatedTail,
    ...(read.corruptAt ? { corruptAt: read.corruptAt } : {}),
    approvedGraph,
  });
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
  // S21.5: the secret-name patterns are loaded here too. `/diff` has always passed
  // `session.rules.secretPatterns` and withheld matching file BODIES (printing only the +n/-m
  // shape); `agent diff` passed nothing, so the same file in the same session printed in full
  // through the CLI. Two spellings of one surface must not disagree about what is redacted.
  // A config that cannot be parsed must not silently degrade to "no redaction" — the failure is
  // reported and the command refuses, matching loadConfig's hard-error contract everywhere else.
  let secretPatterns: string[] | undefined;
  try {
    secretPatterns = loadConfig(resolveStateRoot(), ws).rules.secretPatterns;
  } catch (e) {
    process.stderr.write(`config rejected, refusing to print a diff that may not be redacted: ${(e as Error).message}\n`);
    return 1;
  }
  const files = buildSessionDiff(events, new SnapshotStore(layout.objectsDir), ws, secretPatterns);
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
    const all = await listCheckpoints(cctx, target);
    // Delivery anchors are the DURABLE audit record of an accepted session — the one harness
    // ref kind session-end cleanup deliberately preserves. This command is recommended as the
    // cleanup backstop, so pruning them by default silently destroyed the anchor every durable
    // surface (report, journal, owed-ref fold) still points at (S14.5 review finding).
    // S21.6: anchored, not a substring test. A model can choose a checkpoint LABEL, and the label
    // lands inside this same subject — so `includes()` let a label forge an anchor prune would
    // then refuse to reclaim.
    const refs = values['include-delivery'] === true ? all : all.filter((c) => !isDeliverySubject(c.subject));
    const keptDelivery = all.length - refs.length;
    if (refs.length === 0) {
      process.stdout.write(
        keptDelivery > 0
          ? `no checkpoint refs to prune (${keptDelivery} delivery anchor(s) kept — pass --include-delivery to remove them too)\n`
          : 'no checkpoint refs to prune\n',
      );
      return 0;
    }
    if (keptDelivery > 0) {
      process.stderr.write(`keeping ${keptDelivery} delivery anchor(s) (the accepted state); pass --include-delivery to remove them too\n`);
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
    const r = await deleteCheckpointRefs(cctx.gitPath, cctx.repoRoot, refs.map((c) => c.ref));
    process.stdout.write(
      `pruned ${r.deleted.length} checkpoint ref(s)${r.failed.length > 0 ? `; ${r.failed.length} failed` : ''}` +
        (keptDelivery > 0 ? ` (${keptDelivery} delivery anchor(s) kept)` : '') +
        '\n',
    );
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
        const a = await askOnTty(`the checkpoint would capture ${count} untracked files (is something big not gitignored?) — proceed? (n skips the WHOLE checkpoint) [y/N] `);
        return a !== null && /^y(es)?$/i.test(a.trim());
      },
    });
    for (const note of r.notes ?? []) process.stderr.write(`note: ${sanitizeLine(note)}\n`);
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
  // readPlanState is THE plan reader (canonical JSON preferred, legacy markdown fallback).
  // This command read only the legacy store for three sessions after the canonical format
  // shipped, so every modern plan printed "status: unknown" with a raw-file sha instead of
  // its real approval state — the un-migrated surface, now on the one reader like everyone.
  const events = EventLog.readLenient(layout.sessionFile(sessionId)).events;
  const state = readPlanState(layout, sessionId, events);
  if (state.kind === 'none') {
    process.stderr.write(`no plan document for session ${sessionId}\n`);
    return 1;
  }
  if (state.kind === 'legacy') {
    const plan = state.legacy!;
    process.stderr.write(
      `plan ${sanitizeLine(plan.planId)} — legacy markdown · status: ${plan.status} · sha256 ${plan.sha256 ?? 'unreadable'} · ${plan.bytes} bytes\n` +
        `approval: ${state.approvedSha === null ? 'none recorded' : state.approvedAndCurrent ? `approved and current (sha ${state.approvedSha.slice(0, 12)}…)` : `recorded for sha ${state.approvedSha.slice(0, 12)}… — ${state.diverged ? 'content has DIVERGED' : `status is '${plan.status}'`}`}\n` +
        `file (editable): ${sanitizeLine(plan.file)}\n\n`,
    );
    process.stdout.write(plan.text + (plan.text.endsWith('\n') ? '' : '\n'));
    if (plan.truncated) process.stderr.write('(display truncated; the full plan is in the file)\n');
    return 0;
  }
  const doc = state.canonical!;
  process.stderr.write(
    `plan ${sanitizeLine(doc.planId)} — canonical task graph · status: ${doc.status}${state.diverged ? ' · DIVERGED from approval' : ''} · ${doc.bytes} bytes\n` +
      `content sha: ${state.currentSha ?? 'unusable'}\n` +
      `approved sha: ${state.approvedSha ?? 'none recorded'} · executor gate: ${state.approvedAndCurrent ? 'open (approved and current)' : 'closed'}\n` +
      `file (canonical): ${sanitizeLine(doc.file)}\n\n`,
  );
  if (doc.graph !== null) {
    const view = renderUserPlanView(doc);
    process.stdout.write(view.split('\n').map(sanitizeLine).join('\n') + (view.endsWith('\n') ? '' : '\n'));
  } else {
    process.stderr.write(`the canonical document does not parse/validate: ${sanitizeLine(doc.parseError ?? 'unknown error')}\n`);
    return 1;
  }
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
  const userFile = path.join(layout.stateRoot, 'AGENT.md');
  const user = readDocCapped(userFile, 'AGENT.md', 1024 * 1024);
  out.write(`global AGENT.md (user-owned, machine-wide — loaded into every session in every workspace; the project AGENT.md overrides it on conflict)\n`);
  out.write(`  ${userFile}\n  ${user.status === 'missing' ? 'absent — create it with /init inside the REPL, or by hand' : describeDoc(user)}\n\n`);
  const agent = readDocCapped(agentFile, 'AGENT.md', 1024 * 1024);
  out.write(`AGENT.md (user-owned project constitution, loaded into every session)\n`);
  out.write(`  ${agentFile}\n  ${agent.status === 'missing' ? 'absent — create it to give every session durable instructions' : describeDoc(agent)}\n\n`);

  for (const name of ['JOURNAL.md', 'CODEBASE.md', 'LESSONS.md', 'RESEARCH.md'] as const) {
    const doc = readDocCapped(path.join(dir, name), name, 1024 * 1024);
    const kind =
      name === 'JOURNAL.md'
        ? 'rolling session memory'
        : name === 'CODEBASE.md'
          ? 'architecture summary'
          : name === 'LESSONS.md'
            ? 'durable project lessons'
            : 'research findings with sources (perishable; entries age out)';
    out.write(`${name} (harness-managed ${kind}; edits are welcome and preserved)\n`);
    out.write(`  ${path.join(dir, name)}\n`);
    if (doc.status === 'missing') {
      out.write(
        name === 'LESSONS.md'
          ? '  absent — written when a session ends having recorded a durable lesson\n\n'
          : name === 'RESEARCH.md'
            ? '  absent — written when a session ends having recorded research findings\n\n'
            : '  absent — written automatically after the first productive session\n\n',
      );
      continue;
    }
    const { fields } = parseFrontmatter(doc.text);
    const bySession = fields !== null ? (fields['last-session'] ?? fields['session']) : undefined;
    const provenance =
      fields !== null ? ` · updated ${fields['updated'] ?? '?'}${bySession !== undefined ? ` by session ${bySession}` : ''}` : '';
    out.write(`  ${describeDoc(doc)}${provenance}\n\n`);
  }
  return 0;
}

/**
 * `agent grants` (S21): list or revoke durable machine grants. Ungated and read-only except
 * `revoke`, which edits ONLY harness state at the state root (like `agent trust --revoke`).
 * A corrupt store propagates as the hard ConfigError it is — never rewritten from here.
 */
async function cmdGrants(positionals: string[]): Promise<number> {
  const stateRoot = resolveStateRoot();
  const out = process.stdout;
  if (positionals[1] === 'revoke') {
    const id = positionals[2];
    if (id === undefined || id.length === 0) {
      process.stderr.write('usage: agent grants revoke <id>   (agent grants lists the ids)\n');
      return 1;
    }
    const removed = await revokeGrant(stateRoot, id, new Date().toISOString());
    if (removed === null) {
      process.stderr.write(`no durable grant with id ${id} — agent grants lists what exists\n`);
      return 1;
    }
    out.write(`revoked ${removed.id} — ${removed.label}\n`);
    out.write('takes effect at the NEXT session assembly; a session already running keeps its in-memory copy until it ends.\n');
    return 0;
  }
  const entries = readGrants(stateRoot);
  out.write(`durable machine grants — ${grantsFile(stateRoot)}\n`);
  out.write('("always allow" records created by the [a] option at eligible approval prompts;\n each is loaded VISIBLY into matching sessions as a grants.loaded event)\n\n');
  if (entries.length === 0) {
    out.write('  none recorded\n');
    return 0;
  }
  for (const g of entries) {
    // The store is hand-editable and treated as untrusted bytes everywhere else — the one
    // listing a user consults to AUDIT standing authority must not render raw escapes (S21
    // review; the REPL /grants surface already sanitized).
    out.write(`  ${g.id}  [${g.kind}]  ${g.workspaceKey === null ? 'machine-wide (every trusted workspace)' : `workspace: ${sanitizeLine(g.workspaceKey)}`}\n`);
    out.write(`    ${sanitizeLine(g.label)}\n    created ${sanitizeLine(g.createdAt)}\n`);
  }
  out.write(`\nrevoke one: agent grants revoke <id> · audit trail: ${grantsLogFile(stateRoot)}\n`);
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
    // NEWEST lifecycle event decides the status, and identity FOLDS newest-wins — the two
    // corrections report.ts already carries. A `find` here reported the first clean end of a
    // resumed-then-crashed log, and the starting model of a session that switched providers
    // (S14.5 + S15 review findings); effectiveIdentity is the shared derivation.
    const lifecycle = events.filter((e) => e.type === 'session.started' || e.type === 'session.resumed' || e.type === 'session.ended');
    const lastLifecycle = lifecycle[lifecycle.length - 1];
    const ended = lastLifecycle?.type === 'session.ended' ? lastLifecycle : undefined;
    const task = events.find((e) => e.type === 'user.message');
    const status = ended !== undefined ? ended.reason : 'CRASHED/UNKNOWN';
    const first = task?.type === 'user.message' ? task.text.split('\n')[0]!.slice(0, 60) : '(no task)';
    const identity = effectiveIdentity(events);
    const model =
      identity.current === null
        ? '?'
        : identity.used.length > 1
          ? `${identity.current.model} (switched ${identity.used.length - 1}x)`
          : identity.current.model;
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
  if (values.budget !== undefined && (!/^[0-9]+$/.test(values.budget.trim()) || Number(values.budget) < 1)) {
    process.stderr.write(`--budget requires a positive integer (got '${values.budget}')\n`);
    return 1;
  }
  const map = buildWorkspaceMap(ws, values.budget ? { budget: Number(values.budget) } : {});
  // File names are untrusted folder content; escape terminal-spoofing characters for display.
  const safe = map.text.split('\n').map(sanitizeLine).join('\n');
  process.stdout.write(safe + `\n\n(${map.fileCount} files${map.truncated ? ', truncated' : ''})\n`);
  return 0;
}

/**
 * `agent undo` — trust-gated since S21.5. It was grouped with the read-only commands and was not,
 * in fact, read-only: it restores file contents INTO the workspace and appends an `undo.applied`
 * event. README promised "before the harness reads a single byte of a folder … the folder must be
 * trusted", and this one wrote to it ungated. Reverting a change is exactly as consequential as
 * making it.
 */
async function cmdUndo(values: CliValues): Promise<number> {
  const ws = workspaceRoot(values);
  const trust = await checkTrust(values, ws);
  if (!trust.trusted) {
    process.stderr.write(`not trusted: ${trust.reason}\n`);
    return 3;
  }
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
  if (values.version) {
    process.stdout.write(`agent-cli ${VERSION}\n`);
    return 0;
  }

  try {
    const cmd = positionals[0];
    if (cmd === 'version') {
      process.stdout.write(`agent-cli ${VERSION}\n`);
      return 0;
    }
    if (cmd === 'help') {
      process.stdout.write(USAGE + '\n');
      return 0;
    }
    if (cmd === 'report') return cmdReport(values, positionals[1]);
    if (cmd === 'plan') return cmdPlan(values, positionals[1]);
    if (cmd === 'diff') return cmdDiff(values, positionals[1]);
    if (cmd === 'commit') return await cmdCommit(values);
    if (cmd === 'checkpoint') return await cmdCheckpoint(values, positionals[1], positionals[2]);
    if (cmd === 'sessions') return cmdSessions(values);
    if (cmd === 'providers') return cmdProviders(values);
    if (cmd === 'map') return cmdMap(values);
    if (cmd === 'memory') return cmdMemory(values);
    if (cmd === 'init') {
      // In KNOWN so the bare word cannot start a PAID one-shot session (the `agent version`
      // lesson); the interactive flow itself lives in the REPL where the question seam exists.
      process.stdout.write(
        'agent init is interactive: start the REPL (`agent`) and type /init.\n' +
          'It creates your global AGENT.md (machine-wide user instructions) and, when this project\n' +
          'has none, offers a starter project AGENT.md. It never rewrites an existing file.\n',
      );
      return 0;
    }
    if (cmd === 'grants') return await cmdGrants(positionals);
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
    if (cmd && !KNOWN.has(cmd)) {
      // A typo must never cost money. Refused BEFORE any session, state directory or provider call.
      const misdispatch = misdispatchGuard(cmd);
      if (misdispatch !== null) {
        process.stderr.write(`${misdispatch}\n`);
        return 1;
      }
      return await runTask(values, cmd, {});
    }
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
