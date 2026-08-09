import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isAlive, killTree } from '../exec/kill.js';
import type { PreviewStopReason, StopResult, SupervisedExit, SupervisedHandle, SupervisedSpec } from './types.js';

/** A session resource must not outlive the user's attention span by much; restart is cheap. */
/**
 * Session 16: 30min → 60min. A dependency-bearing full-stack session routinely outlives half an
 * hour — install, migrate, seed, build, review — and having the servers reaped mid-session turned
 * a bound meant to stop leaks into an interruption of legitimate work. Still a hard TTL, still a
 * typed stop reason, still recorded.
 */
export const DEFAULT_PREVIEW_TTL_MS = 120 * 60 * 1000;
export const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TAIL_BYTES = 8 * 1024;
/** How often the log-size cap is checked (a cap, not an exact limit — stated honestly). */
const LOG_POLL_MS = 2000;
/** After a kill, how long death may take before stop() reports the process still alive. */
const EXIT_AFTER_KILL_BOUND_MS = 5000;
/** The kill HELPER itself is bounded too: a wedged taskkill must never hang session end. */
const KILL_HELPER_BOUND_MS = 10_000;

/**
 * Spawn a supervised long-running process. Resolves once the OS has actually spawned it (pid
 * known) and rejects on spawn failure — the caller decides what a failed start means.
 *
 * Lifecycle invariants:
 *  - stdio is `['ignore', fd, fd]` on the caller-named log file: no pipes, so the harness dying
 *    never wedges the child mid-write, and the parent's fd copy is closed immediately after
 *    spawn (the child holds its own descriptor);
 *  - the child is `unref()`ed: a live preview must never hold the harness's event loop open
 *    (session end stops previews explicitly; a crash leaves the orphan for the sweep);
 *  - all timers are unref'd and cleared on exit;
 *  - `stop()` follows the first-cause rule: the first requested reason is THE reason, a
 *    concurrent natural death wins if it already happened (requestedStop stays null).
 */
export async function startSupervised(spec: SupervisedSpec): Promise<SupervisedHandle> {
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
  const fd = fs.openSync(spec.logFile, 'a');

  let child;
  try {
    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      // POSIX: own process group so killTree can signal the group AND a terminal SIGINT never
      // reaches the preview. Windows: detaching is NOT viable (DETACHED_PROCESS makes the
      // PowerShell wrapper exit immediately with no output — verified empirically), so the
      // preview shares the console group; the REPL is safe (raw-mode consumes Ctrl+C as a
      // keypress), but a ONE-SHOT console Ctrl+C also reaches the preview, whose death is then
      // honestly recorded as 'crashed' moments before session-end stop-all would have stopped
      // it. A documented Windows limitation, not a silent one.
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (err) => reject(err));
  }).finally(() => {
    // The child owns its own copy of the descriptor from here (spawn dups it); on spawn
    // failure there is no child and the fd must not leak either way.
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn reported success but assigned no pid');
  child.unref();

  let exitedFlag = false;
  let requestedStop: PreviewStopReason | null = null;
  let stopResult: Promise<StopResult> | null = null;

  let resolveExited!: (info: SupervisedExit) => void;
  const exited = new Promise<SupervisedExit>((r) => {
    resolveExited = r;
  });

  const ttlMs = spec.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
  const maxLogBytes = spec.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;

  let ttlTimer: NodeJS.Timeout | null = null;
  let logTimer: NodeJS.Timeout | null = null;
  const clearTimers = (): void => {
    if (ttlTimer !== null) clearTimeout(ttlTimer);
    if (logTimer !== null) clearInterval(logTimer);
    ttlTimer = null;
    logTimer = null;
  };

  child.once('exit', (code, signal) => {
    exitedFlag = true;
    clearTimers();
    resolveExited({
      requestedStop,
      exitCode: code,
      signal: signal ?? null,
      durationMs: Date.now() - startedAt,
    });
  });

  const stop = (reason: PreviewStopReason): Promise<StopResult> => {
    if (exitedFlag && stopResult === null) {
      // Died on its own before any stop was requested: the exit already carries the truth.
      return Promise.resolve({ ok: true, detail: 'already exited' });
    }
    if (stopResult !== null) return stopResult; // first cause wins; later stops observe it
    // The death→'exit'-event window: if the OS already reaped the process, this stop did not
    // cause anything — recording its reason would relabel a genuine crash as a lifecycle end
    // (and downgrade its recovery classification). Leave requestedStop null; the imminent exit
    // event reports the truth.
    if (!isAlive(pid)) {
      return Promise.resolve({ ok: true, detail: 'already exited (exit event pending)' });
    }
    requestedStop = reason;
    stopResult = (async (): Promise<StopResult> => {
      // BOTH bounds matter: the kill helper itself (a wedged taskkill must never hang the quit
      // path) and the wait for the exit event afterwards.
      const kill = await Promise.race([
        killTree(pid),
        new Promise<{ verified: boolean; detail: string }>((r) =>
          setTimeout(r, KILL_HELPER_BOUND_MS, { verified: false, detail: `kill helper did not return within ${String(KILL_HELPER_BOUND_MS)}ms` }).unref(),
        ),
      ]);
      const dead = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(r, EXIT_AFTER_KILL_BOUND_MS, false).unref()),
      ]);
      return dead
        ? { ok: true, detail: kill.detail }
        : { ok: false, detail: `${kill.detail}; process still alive after ${EXIT_AFTER_KILL_BOUND_MS}ms` };
    })();
    return stopResult;
  };

  if (ttlMs > 0) {
    ttlTimer = setTimeout(() => void stop('ttl-timeout'), ttlMs);
    ttlTimer.unref();
  }
  logTimer = setInterval(() => {
    try {
      if (fs.statSync(spec.logFile).size > maxLogBytes) void stop('log-overflow');
    } catch {
      /* the log file vanishing is not this timer's problem */
    }
  }, spec.logPollMs ?? LOG_POLL_MS);
  logTimer.unref();

  return {
    pid,
    logFile: spec.logFile,
    exited,
    isAlive: () => !exitedFlag,
    stop,
    tail: (maxBytes = DEFAULT_TAIL_BYTES) => readTail(spec.logFile, maxBytes),
  };
}

/** Last `maxBytes` of a file, lossily decoded — display and readiness scanning only. */
export function readTail(file: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
