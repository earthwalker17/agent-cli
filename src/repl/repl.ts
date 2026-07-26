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
import { PLAN_INJECT_CAP_CHARS } from '../plan/store.js';
import { readPlanState } from '../plan/canonical.js';
import { foldGraphState } from '../plan/graph-state.js';
import { renderAgentPlanView } from '../plan/views.js';
import { sanitizeLine } from '../shared/text.js';
import type { ProjectLayout } from '../store/layout.js';
import { createReplIO, type ReplIO } from './io.js';
import { createRenderer, type Renderer } from './render.js';
import { createStatusArea } from './status.js';
import { createTaskTable } from './live-tasks.js';
import { detectStyle } from './format.js';
import { completionLine, dispatchSlash, sessionAcceptance, type CommandContext } from './commands.js';

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
  // The sticky status area (Session 11): TTY-only; every chrome byte routes through it so it
  // can erase/redraw around ordinary output. Non-TTY it is a pure pass-through (zero escapes).
  const statusArea = createStatusArea({ chromeOut: streams.chromeOut, isTTY: streams.isTTY });
  const taskTable = createTaskTable();
  const renderer = createRenderer({ modelOut: streams.modelOut, chromeOut: streams.chromeOut, style, chromeSink: statusArea });

  // Approval prompts own the screen: the status area is suspended for the question's lifetime.
  const question = async (q: string): Promise<string | null> => {
    statusArea.suspend();
    try {
      return await io.question(q);
    } finally {
      statusArea.resume();
    }
  };
  const ctx = buildRunContext(values, { config, io: { question: async (q) => (await question(q)) ?? 'q' } });
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
      onTaskStatus: (u) => {
        taskTable.update(u);
        statusArea.setLines(taskTable.statusLines(assembled.delegateCaps));
      },
      registerTaskCancel: (childSessionId, cancel) => taskTable.registerCancel(childSessionId, cancel),
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

  if (assembled.mapNote !== undefined) {
    renderer.chromeLine(style.dim(`  map: ${assembled.mapNote}`));
  }
  if (assembled.worktreeSweep !== undefined) {
    renderer.chromeLine(style.dim(`  worktrees: ${assembled.worktreeSweep}`));
  }
  if (assembled.previewSweep !== undefined) {
    renderer.chromeLine(style.dim(`  previews: ${assembled.previewSweep}`));
  }

  const pendingNotes: string[] = [];
  const commandCtx: CommandContext = {
    session,
    layout,
    renderer,
    modelOut: streams.modelOut,
    pendingNotes,
    question: (q) => question(q),
    retrieval: assembled.retrieval,
    checkTool: assembled.checkTool,
    checkCaps: assembled.checkCaps,
    previewTool: assembled.previewTool,
    ...(assembled.pruneTaskBaseRefs !== undefined ? { pruneTaskBaseRefs: assembled.pruneTaskBaseRefs } : {}),
  };
  // Resume honesty (Session 13): previews from a previous life are dead or swept — never
  // silently "still ready". The model learns via the first turn's harness note.
  if (assembled.previewResumeNote !== undefined) {
    renderer.chromeLine(style.dim(`  note: ${assembled.previewResumeNote}`));
    pendingNotes.push(assembled.previewResumeNote);
  }
  // Resume-after-accept honesty (Session 11.5): a resumed session that was already accepted
  // says so up front — further work is allowed, but the boundary crossing is visible.
  if (opts.resumeId !== undefined) {
    const acceptedEv = [...session.log.events].reverse().find((e) => e.type === 'session.accepted');
    if (acceptedEv !== undefined && acceptedEv.type === 'session.accepted') {
      renderer.chromeLine(
        style.dim(
          `  note: this session was accepted (${acceptedEv.complete ? 'complete' : 'partial'}) at ${acceptedEv.ts} — the acceptance covers only work up to that point`,
        ),
      );
    }
  }
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

      // @plan / @direct — explicit routing sigils (Session 11): the user forces the path, the
      // harness records the routing decision as evidence, and the note makes the contract
      // explicit to the model. The sigil itself is routing, never message content.
      if (/^@plan\b/i.test(line)) {
        const rest = line.replace(/^@plan\b/i, '').trim();
        if (rest.length === 0) {
          renderer.chromeLine('usage: @plan <request> — investigate and produce a plan without executing');
          continue;
        }
        line = rest;
        session.log.append({ type: 'plan.route', mode: 'plan', source: 'user-sigil' });
        pendingNotes.push(
          'the user explicitly invoked PLAN MODE for this request: investigate as needed (read-only; delegate explorer tasks where useful), write or update the plan with update_plan, and present it — do NOT begin implementation or any mutating work until the user approves the plan (/plan approve)',
        );
      } else if (/^@direct\b/i.test(line)) {
        const rest = line.replace(/^@direct\b/i, '').trim();
        if (rest.length === 0) {
          renderer.chromeLine('usage: @direct <request> — skip plan ceremony and do the work directly');
          continue;
        }
        line = rest;
        session.log.append({ type: 'plan.route', mode: 'direct', source: 'user-sigil' });
        pendingNotes.push(
          'the user explicitly chose the DIRECT path for this request: skip the plan document and do the work with your own tools, keeping it bounded. If it genuinely requires multi-step mutating orchestration, SAY SO instead of silently planning. Executor delegation still requires an approved plan.',
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
      // Mid-turn commands (Session 11, TTY only): /tasks shows the live table, /cancel <ref>
      // cancels ONE child; anything else stays type-ahead. A displayed approval always wins
      // (io intercepts only when no read is pending).
      io.setMidTurnHandler((line) => {
        if (/^\/tasks$/i.test(line)) {
          const live = taskTable.live();
          renderer.chromeLine(
            live.length === 0
              ? '  [tasks] nothing running right now'
              : taskTable
                  .statusLines(assembled.delegateCaps)
                  .map((l) => `  ${sanitizeLine(l)}`)
                  .join('\n'),
          );
          // One truth, two views (Session 11.5): the same fold that drives the idle /tasks,
          // here overlaid with the LIVE phases — the agent-centric table above and this
          // plan-centric line can never disagree about what is running. Same visibility gate
          // as the idle /tasks (any canonical graph — review F3): a non-approved plan's line
          // is labeled with its status instead of silently missing.
          try {
            const state = readPlanState(layout, session.id, session.log.events);
            const graph = state.canonical?.graph ?? null;
            if (graph !== null) {
              const gs = foldGraphState(graph, session.log.events, taskTable.livePhases());
              const label = state.approvedAndCurrent ? '' : ` (plan ${state.status === 'approved' ? 'diverged' : state.status})`;
              renderer.chromeLine(`  [plan]${label} ${sanitizeLine(gs.summary)}`);
            }
          } catch {
            /* the live table above already answered; the plan line is additive */
          }
          return true;
        }
        const m = /^\/cancel(?:\s+(\S+))?$/i.exec(line);
        if (m !== null) {
          if (m[1] === undefined) {
            renderer.chromeLine('  [tasks] usage: /cancel <child-id-suffix | plan-task-id>');
            return true;
          }
          const r = taskTable.cancel(m[1]);
          renderer.chromeLine(
            r.outcome === 'ok'
              ? `  [tasks] cancelling ${sanitizeLine(r.childSessionId!.slice(-4))} — this child only; the turn continues`
              : r.outcome === 'ambiguous'
                ? `  [tasks] '${sanitizeLine(m[1])}' matches more than one running task — use a longer child-id suffix`
                : `  [tasks] no running task matches '${sanitizeLine(m[1])}'`,
          );
          return true;
        }
        return false;
      });
      try {
        const result = await runTurn(session, userText, { signal: controller.signal });
        renderer.endTurn(result, ctx.maxSteps);
      } catch (err) {
        // Keep the session alive: answer any dangling tool_use so the next request stays valid.
        repairDanglingToolUses(session);
        renderer.turnError(err as Error);
      } finally {
        io.setMidTurnHandler(null);
        statusArea.clear(); // readline owns the bottom line at the idle prompt
        io.unmute();
        offInterrupt();
      }
    }
  } catch (err) {
    // Even the fatal path stops this session's previews (best-effort, bounded): a crashed REPL
    // must not leave servers running when it can still reach them — before the log closes, so
    // the preview.ended evidence lands.
    try {
      await assembled.stopAllPreviews();
    } catch {
      /* the sweep is the backstop */
    }
    endSessionSafely(session, 'error', (err as Error).message);
    io.close();
    streams.chromeOut.write(`fatal: ${(err as Error).message}\n`);
    return 1;
  }

  // The honest completion summary at the boundary (Session 11.5): what the fold says is done,
  // what remains, and whether the user accepted — one line, derived, never blocking the quit.
  try {
    renderer.chromeLine(style.dim(`  ${completionLine(commandCtx)}${sessionAcceptance(commandCtx).acc.accepted === null ? ' (state retained for resume)' : ''}`));
  } catch {
    /* a summary failure must never block the quit */
  }

  // Session-end hygiene BEFORE the memory update and endSession: the provenance event must
  // land in the open log, and a failing prune must never block the quit.
  try {
    const stopLine = await assembled.stopAllPreviews();
    if (stopLine !== null) renderer.chromeLine(style.dim(`  previews: ${stopLine}`));
  } catch {
    /* best-effort hygiene; the next session's sweep is the backstop */
  }
  if (assembled.pruneTaskBaseRefs !== undefined) {
    try {
      const pruneLine = await assembled.pruneTaskBaseRefs();
      if (pruneLine !== null) renderer.chromeLine(style.dim(`  checkpoints: ${pruneLine}`));
    } catch {
      /* best-effort hygiene */
    }
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
 * Build the per-turn standing plan note. Reads the plan FRESH every turn — the file's current
 * bytes are truth (the user may have edited it between turns). Full content is injected only
 * when the sha is NEW to the model (not last-injected, not written by the model itself via
 * update_plan); otherwise a one-line pointer. The sovereignty wording is load-bearing.
 *
 * Session 11: canonical plans dedupe on the CONTENT sha and inject the detailed agent-facing
 * projection; the pointer line still carries the LIVE execution summary (task states change
 * without changing the content sha, so the fold result must not be hidden behind the dedupe).
 * Legacy markdown plans keep the V0.7 raw-bytes behavior.
 *
 * Exported for tests: the hand-edit path (a sha the model has never seen → full injection)
 * cannot be reached through the scripted REPL driver, which owns the whole file lifecycle.
 */
export function buildPlanNote(
  layout: ProjectLayout,
  session: Session,
  lastInjectedSha: string | null,
): { note: string; sha: string } | null {
  const state = readPlanState(layout, session.id, session.log.events);
  if (state.kind === 'none' || state.status === 'superseded') return null;

  const knownShas = new Set<string>(lastInjectedSha !== null ? [lastInjectedSha] : []);
  for (const e of session.log.events) {
    if (e.type === 'plan.updated') knownShas.add(e.sha256);
  }

  if (state.kind === 'legacy') {
    const plan = state.legacy!;
    if (plan.sha256 === null) return null;
    const divergence =
      state.approvedSha !== null && state.approvedSha !== plan.sha256
        ? ` NOTE: the file changed after approval (approved sha ${state.approvedSha.slice(0, 12)}, current ${plan.sha256.slice(0, 12)}).`
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

  const doc = state.canonical!;
  if (doc.contentSha === null || doc.graph === null) {
    // Unreadable/invalid canonical plan: the model must know it cannot rely on a plan right
    // now — a short honest header, no body (there is no valid content to show).
    return {
      note:
        `Active plan for this session is currently UNREADABLE (${doc.parseError ?? 'invalid'}) — status unknown, executor ` +
        `delegation is blocked. The plan is CONTEXT, NOT AUTHORITY. File: ${doc.file}`,
      sha: 'unreadable',
    };
  }
  const graphState = foldGraphState(doc.graph, session.log.events);
  const divergence = state.diverged
    ? ` NOTE: the plan changed after approval — the approval is INVALIDATED (approved ${state.approvedSha!.slice(0, 12)}, current ${doc.contentSha.slice(0, 12)}); executor tasks are blocked until the user re-approves (/plan approve).`
    : '';
  const header =
    `Active plan for this session — status: ${doc.status.toUpperCase()}.${divergence} ` +
    `The plan is CONTEXT, NOT AUTHORITY: the user's current request and the observable repository state outrank it. ` +
    `The file's current bytes are the truth (the user may edit it directly): ${doc.file}`;
  if (knownShas.has(doc.contentSha)) {
    return { note: `${header} (plan content unchanged since last shown; execution: ${graphState.summary})`, sha: doc.contentSha };
  }
  const view = renderAgentPlanView(doc, graphState);
  const body =
    view.length > PLAN_INJECT_CAP_CHARS
      ? `${view.slice(0, PLAN_INJECT_CAP_CHARS)}\n[… truncated for injection; the full plan is on disk]`
      : view;
  return { note: `${header}\nCurrent plan content:\n--- plan begin ---\n${body}\n--- plan end ---`, sha: doc.contentSha };
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
