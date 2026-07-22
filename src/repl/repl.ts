import { resolveLayout, resolveStateRoot } from '../store/layout.js';
import { endSession, runTurn, repairDanglingToolUses, type Session } from '../runtime/session.js';
import type { SandboxBackend } from '../sandbox/index.js';
import type { GitFacts } from '../git/types.js';
import { AnthropicProvider } from '../provider/anthropic.js';
import { loadConfig } from '../config/config.js';
import { buildRunContext, latestSessionId, workspaceRoot, type CliValues } from '../cli/context.js';
import { checkTrust } from '../cli/trust-check.js';
import { assembleSession, type Assembled } from '../cli/assemble.js';
import { runMemoryUpdate } from '../memory/update.js';
import { readPlan, PLAN_INJECT_CAP_CHARS } from '../plan/store.js';
import { sanitizeLine } from '../shared/text.js';
import type { ProjectLayout } from '../store/layout.js';
import { createReplIO, type ReplIO } from './io.js';
import { createRenderer, type Renderer } from './render.js';
import { detectStyle } from './format.js';
import { dispatchSlash, type CommandContext } from './commands.js';

/**
 * The interactive REPL: a loop of `prompt → runTurn` over ONE session and ONE event log, sharing
 * the exact runtime the one-shot path uses (startSession/runTurn/endSession — no parallel
 * execution path). The renderer is fed by EventLog.onAppend, so the screen is a live view of the
 * persisted evidence.
 */

export interface ReplStreams {
  input: NodeJS.ReadableStream;
  /** Model text + requested artifacts only. */
  modelOut: NodeJS.WritableStream;
  /** All chrome: prompts, tool activity, summaries. */
  chromeOut: NodeJS.WritableStream;
  isTTY: boolean;
}

export interface ReplOptions {
  resumeId?: string;
  /** Injectable for tests; defaults to process stdio. */
  streams?: ReplStreams;
  /** Injectable sandbox backend for deterministic, platform-independent tests; defaults to selectSandbox. */
  sandbox?: SandboxBackend;
  /** Injectable git facts for deterministic tests; defaults to a real detectGitFacts probe. */
  gitFacts?: GitFacts;
}

export async function runRepl(values: CliValues, opts: ReplOptions = {}): Promise<number> {
  const streams: ReplStreams = opts.streams ?? {
    input: process.stdin,
    modelOut: process.stdout,
    chromeOut: process.stderr,
    // Full-terminal mode needs BOTH ends: raw-mode stdin disables kernel echo, and readline's
    // own echo goes to the chrome stream — with stderr redirected, typing would be invisible.
    isTTY: process.stdin.isTTY === true && process.stderr.isTTY === true,
  };

  // Order is load-bearing: trust gate before the workspace config file is read, before
  // per-project state is created, and before any workspace byte reaches a model.
  const ws = workspaceRoot(values);
  const trust = await checkTrust(values, ws);
  if (!trust.trusted) {
    streams.chromeOut.write(`refusing to start: ${trust.reason}\n`);
    return 3;
  }
  const config = loadConfig(resolveStateRoot(), ws);

  const io = createReplIO({ input: streams.input, output: streams.chromeOut, isTTY: streams.isTTY });
  const style = detectStyle({ isTTY: streams.isTTY });
  const renderer = createRenderer({ modelOut: streams.modelOut, chromeOut: streams.chromeOut, style });

  const ctx = buildRunContext(values, { config, io: { question: async (q) => (await io.question(q)) ?? 'q' } });
  const layout = resolveLayout(ctx.ws, { ensure: true });

  // The shared assembly path (sandbox probe → git probe → map → system prompt → session + records).
  // Tests may inject a sandbox backend / git facts to stay deterministic and platform-independent.
  let assembled: Assembled;
  try {
    assembled = await assembleSession({
      trust,
      config,
      ctx,
      layout,
      ...(opts.resumeId !== undefined ? { resumeId: opts.resumeId } : {}),
      argv: process.argv.slice(2),
      onText: (t: string) => renderer.onText(t),
      onCommandOutput: (_callId: string, chunk: string, stream: 'stdout' | 'stderr') => renderer.onCommandOutput(chunk, stream),
      onLogEvent: (e) => renderer.onEvent(e),
      onTaskProgress: (line: string) => renderer.chromeLine(`  [task] ${sanitizeLine(line)}`),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(opts.gitFacts !== undefined ? { gitFacts: opts.gitFacts } : {}),
    });
  } catch (err) {
    io.close();
    streams.chromeOut.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const { session, sandboxFacts, gitFacts, memory } = assembled;

  renderer.banner({
    sessionId: session.id,
    resumed: opts.resumeId !== undefined,
    model: ctx.model,
    workspaceRoot: ctx.ws,
    stateDir: layout.projectDir,
    ...(ctx.provider instanceof AnthropicProvider ? { network: ctx.provider.transport } : {}),
    sandbox: { summary: sandboxFacts.summary, enforced: sandboxFacts.enforced },
    ...(gitFacts.isRepo || gitFacts.probeFailed ? { git: { summary: gitFacts.detail } } : {}),
    memory: {
      summary: memory.bannerLine,
      ...(memory.crashNote !== null ? { crashNote: memory.crashNote } : {}),
    },
    dangerous: values['dangerously-allow-all'] === true,
  });

  if (assembled.worktreeSweep !== undefined) {
    renderer.chromeLine(style.dim(`  worktrees: ${assembled.worktreeSweep}`));
  }

  const pendingNotes: string[] = [];
  const commandCtx: CommandContext = { session, layout, renderer, modelOut: streams.modelOut, pendingNotes, question: (q) => io.question(q) };
  let exitCode = 0;
  let consecutiveInterrupts = 0;
  // Plan injection dedupe: content already shown to the model (by injection or its own
  // update_plan writes) collapses to a one-line pointer instead of re-feeding the full text.
  let lastInjectedPlanSha: string | null = null;

  try {
    for (;;) {
      renderer.flush();
      const read = await io.prompt(style.glyph.prompt);
      if (read.kind === 'eof') break;
      if (read.kind === 'interrupt') {
        consecutiveInterrupts++;
        if (consecutiveInterrupts >= 2) break;
        renderer.chromeLine(style.dim('(press Ctrl+C again to quit, or /quit)'));
        continue;
      }
      consecutiveInterrupts = 0;
      let line = read.text.trim();
      if (line.length === 0) continue;
      if (line.startsWith('/')) {
        if ((await dispatchSlash(line, commandCtx)) === 'quit') break;
        continue;
      }

      // @plan — explicit plan-mode invocation: the request routes into planning, and the
      // harness note makes the no-execution-before-approval contract explicit to the model.
      if (/^@plan\b/i.test(line)) {
        const rest = line.replace(/^@plan\b/i, '').trim();
        if (rest.length === 0) {
          renderer.chromeLine('usage: @plan <request> — investigate and produce a plan without executing');
          continue;
        }
        line = rest;
        pendingNotes.push(
          'the user explicitly invoked PLAN MODE for this request: investigate as needed (read-only; delegate explorer tasks where useful), write or update the plan with update_plan, and present it — do NOT begin implementation or any mutating work until the user approves the plan (/plan approve)',
        );
      }

      // Standing plan note: while a plan document exists (and is not discarded), every turn
      // carries its status — and its full content whenever the file's bytes changed.
      const planNote = buildPlanNote(layout, session, lastInjectedPlanSha);
      if (planNote !== null) lastInjectedPlanSha = planNote.sha;
      const notes = [...(planNote !== null ? [planNote.note] : []), ...pendingNotes];
      const userText = notes.length > 0 ? `[[harness note: ${notes.join(' | ')}]]\n\n${line}` : line;
      pendingNotes.length = 0;

      const controller = new AbortController();
      const offInterrupt = io.onInterrupt(() => controller.abort());
      io.mute();
      renderer.beginTurn();
      try {
        const result = await runTurn(session, userText, { signal: controller.signal });
        renderer.endTurn(result, ctx.maxSteps);
      } catch (err) {
        // Keep the session alive: answer any dangling tool_use so the next request stays valid.
        repairDanglingToolUses(session);
        renderer.turnError(err as Error);
      } finally {
        io.unmute();
        offInterrupt();
      }
    }
  } catch (err) {
    endSessionSafely(session, 'error', (err as Error).message);
    io.close();
    streams.chromeOut.write(`fatal: ${(err as Error).message}\n`);
    return 1;
  }

  await runMemoryUpdate(session, {
    layout,
    enabled: config.memoryUpdates !== false,
    endedReason: 'user-quit',
    announce: (l) => renderer.chromeLine(style.dim(l)),
  });
  endSessionSafely(session, 'user-quit');
  renderer.chromeLine(style.dim(`session ${session.id} ended — report: agent report ${session.id}`));
  io.close();
  return exitCode;
}

/**
 * Build the per-turn standing plan note (V0.7). Reads the plan file FRESH every turn — the
 * file's current bytes are truth (the user may have edited it between turns). Full content is
 * injected only when the sha is NEW to the model (not last-injected, not written by the model
 * itself via update_plan); otherwise a one-line pointer. The sovereignty wording is load-bearing.
 */
function buildPlanNote(
  layout: ProjectLayout,
  session: Session,
  lastInjectedSha: string | null,
): { note: string; sha: string } | null {
  const plan = readPlan(layout, session.id);
  if (!plan.exists || plan.sha256 === null || plan.status === 'superseded') return null;

  let approvedSha: string | null = null;
  const knownShas = new Set<string>(lastInjectedSha !== null ? [lastInjectedSha] : []);
  for (const e of session.log.events) {
    if (e.type === 'plan.approved') approvedSha = e.sha256;
    else if (e.type === 'plan.discarded') approvedSha = null;
    else if (e.type === 'plan.updated') knownShas.add(e.sha256);
  }
  const divergence =
    approvedSha !== null && approvedSha !== plan.sha256
      ? ` NOTE: the file changed after approval (approved sha ${approvedSha.slice(0, 12)}, current ${plan.sha256.slice(0, 12)}).`
      : '';
  const header =
    `Active plan for this session — status: ${plan.status.toUpperCase()}.${divergence} ` +
    `The plan is CONTEXT, NOT AUTHORITY: the user's current request and the observable repository state outrank it. ` +
    `The file's current bytes are the truth (the user may edit it directly): ${plan.file}`;
  if (knownShas.has(plan.sha256)) {
    return { note: `${header} (content unchanged since last shown)`, sha: plan.sha256 };
  }
  const body =
    plan.text.length > PLAN_INJECT_CAP_CHARS
      ? `${plan.text.slice(0, PLAN_INJECT_CAP_CHARS)}\n[… truncated for injection; the full plan is on disk]`
      : plan.text;
  return { note: `${header}\nCurrent plan content:\n--- plan begin ---\n${body}\n--- plan end ---`, sha: plan.sha256 };
}

/** endSession appends to the log; if THAT is what is failing, still release and stay honest. */
function endSessionSafely(session: Session, reason: 'user-quit' | 'error', error?: string): void {
  try {
    endSession(session, reason, error);
  } catch {
    try {
      session.log.close();
    } catch {
      /* lock release is best-effort; stale-lock reclaim handles the rest */
    }
  }
}
