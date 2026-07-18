import { resolveLayout, resolveStateRoot } from '../store/layout.js';
import { startSession, resumeSession, endSession, runTurn, repairDanglingToolUses, recordWorkspaceMap, recordSandboxStatus, type Session } from '../runtime/session.js';
import { selectSandbox, type SandboxBackend } from '../sandbox/index.js';
import { buildWorkspaceMap } from '../workspace/map.js';
import { buildSystemPrompt } from '../workspace/system-prompt.js';
import { AnthropicProvider } from '../provider/anthropic.js';
import { randomSaltHex } from '../shared/hash.js';
import { loadConfig } from '../config/config.js';
import { buildRunContext, latestSessionId, workspaceRoot, type CliValues } from '../cli/context.js';
import { checkTrust } from '../cli/trust-check.js';
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
  const map = buildWorkspaceMap(ctx.ws);

  // Establish + probe the execution sandbox before the first turn, so the banner and system prompt
  // report the truth. Tests may inject a backend to stay deterministic and platform-independent.
  const sandbox = opts.sandbox ?? selectSandbox({ stateRoot: layout.stateRoot });
  const sandboxFacts = await sandbox.ensureAvailable();
  const system = buildSystemPrompt(ctx.ws, map, sandboxFacts);

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
    onText: (t: string) => renderer.onText(t),
    onCommandOutput: (_callId: string, chunk: string, stream: 'stdout' | 'stderr') => renderer.onCommandOutput(chunk, stream),
    rules: config.rules,
    sandbox,
    sandboxFacts,
  };

  let session: Session;
  try {
    session = opts.resumeId
      ? resumeSession({ ...common, sessionId: opts.resumeId })
      : startSession({ ...common, argv: process.argv.slice(2) });
  } catch (err) {
    io.close();
    streams.chromeOut.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  session.log.onAppend = (e) => renderer.onEvent(e);
  session.log.append({ type: 'trust.verified', source: trust.source });
  session.log.append({ type: 'config.loaded', sources: config.sources });
  recordSandboxStatus(session, sandboxFacts);
  recordWorkspaceMap(session, map);

  renderer.banner({
    sessionId: session.id,
    resumed: opts.resumeId !== undefined,
    model: ctx.model,
    workspaceRoot: ctx.ws,
    stateDir: layout.projectDir,
    ...(ctx.provider instanceof AnthropicProvider ? { network: ctx.provider.transport } : {}),
    sandbox: { summary: sandboxFacts.summary, enforced: sandboxFacts.enforced },
    dangerous: values['dangerously-allow-all'] === true,
  });

  const pendingNotes: string[] = [];
  const commandCtx: CommandContext = { session, renderer, modelOut: streams.modelOut, pendingNotes };
  let exitCode = 0;
  let consecutiveInterrupts = 0;

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
      const line = read.text.trim();
      if (line.length === 0) continue;
      if (line.startsWith('/')) {
        if ((await dispatchSlash(line, commandCtx)) === 'quit') break;
        continue;
      }

      const userText =
        pendingNotes.length > 0 ? `[[harness note: ${pendingNotes.join(' | ')}]]\n\n${line}` : line;
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

  endSessionSafely(session, 'user-quit');
  renderer.chromeLine(style.dim(`session ${session.id} ended — report: agent report ${session.id}`));
  io.close();
  return exitCode;
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
