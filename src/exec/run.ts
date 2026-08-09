import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { CommandTermination, ExecSpec } from '../types.js';
import { killTree } from './kill.js';

// ExecSpec moved to types.ts (S20.5 — it was the load-bearing half of a types↔exec cycle);
// re-exported so exec-side consumers keep one import site per concept.
export type { ExecSpec } from '../types.js';

/**
 * runManaged — the managed-subprocess substrate. Policy-free and log-free: it takes a fully
 * resolved spec (file, args, pre-built env), returns a structured outcome, and reports through
 * injected callbacks. run_command is its first consumer; future workflow-pack renderer processes
 * are the intended second.
 *
 * The load-bearing part is the kill/drain state machine:
 *
 *   running ─ child 'exit' ─────────────► draining
 *   running ─ timeout fires ────────────► killing(timeout)
 *   running ─ abort signal ─────────────► killing(aborted)
 *   running ─ 'error' before 'spawn' ───► settled(spawn-error)
 *   killing: await killTree (verified best-effort), then 'exit' with a bounded wait
 *   draining: race 'close' vs drainTimeoutMs, then destroy the streams
 *
 * Never await 'close' unconditionally: a grandchild that inherited the stdio pipes keeps 'close'
 * from firing (potentially forever) after the direct child is dead — the classic Windows hang
 * (nodejs/node#21960/#56537). Settling is driven by 'exit'; 'close' only ends the drain early.
 */

const isWin = process.platform === 'win32';

export interface ExecOutcome {
  termination: CommandTermination;
  /** Present only for 'exited' (and null there too if the OS reported a signal, POSIX only). */
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Chronological interleave of both streams — the model-facing base string. */
  combined: string;
  /** True when the rolling capture dropped bytes (head+tail kept). */
  captureTruncated: boolean;
  /** True when stdio did not drain within the bound after exit (output may be incomplete). */
  drainTimedOut: boolean;
  /** Honest kill mechanics when a kill was attempted, e.g. 'taskkill exit 0; probe: dead'. */
  killDetail?: string;
  spawnError?: string;
}

/**
 * S16: 512 KiB → 1 MiB; S20.5: → 4 MiB. Install and build logs are the noisiest output the
 * harness sees, and capture truncation is UNRECOVERABLE (head+tail kept, the middle gone before
 * any spill or model truncation runs) — the dropped middle of a failing build is exactly the
 * evidence a later classification needs. The model-facing size stays independently bounded by
 * truncateForModel; this cap widens EVIDENCE, not context.
 */
const DEFAULT_CAPTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT_MS = 1500;
const EXIT_AFTER_KILL_BOUND_MS = 5000;

/** Head+tail byte-capped capture. Stores raw Buffers; decodes once, so only the elision seam can split a rune. */
class CappedCapture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  truncated = false;
  constructor(private readonly capBytes: number) {}
  push(chunk: Buffer): void {
    const headLimit = Math.ceil(this.capBytes / 2);
    if (this.headBytes < headLimit) {
      this.head.push(chunk);
      this.headBytes += chunk.length;
      return;
    }
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    const tailLimit = this.capBytes - headLimit;
    while (this.tailBytes > tailLimit && this.tail.length > 1) {
      this.tailBytes -= this.tail.shift()!.length;
      this.truncated = true;
    }
  }
  text(): string {
    // When nothing was dropped, decode ONE contiguous buffer so a multibyte rune split across the
    // head/tail chunk seam is not corrupted to U+FFFD while we claim full fidelity. Only when
    // truncated (an unrecoverable middle gap already exists) do we decode the two sides separately.
    if (!this.truncated) return Buffer.concat([...this.head, ...this.tail]).toString('utf8');
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    return `${head}\n…[output capture truncated]…\n${tail}`;
  }
}

export function runManaged(spec: ExecSpec): Promise<ExecOutcome> {
  const started = Date.now();
  const maxBytes = spec.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
  const stdoutCap = new CappedCapture(Math.floor(maxBytes / 3));
  const stderrCap = new CappedCapture(maxBytes - Math.floor(maxBytes / 3));
  const combinedCap = new CappedCapture(maxBytes);

  const base = () => ({
    stdout: stdoutCap.text(),
    stderr: stderrCap.text(),
    combined: combinedCap.text(),
    captureTruncated: stdoutCap.truncated || stderrCap.truncated || combinedCap.truncated,
    durationMs: Date.now() - started,
  });

  if (spec.signal?.aborted) {
    return Promise.resolve({ termination: 'aborted', exitCode: null, drainTimedOut: false, ...base() });
  }

  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      // stdin is never connected: an interactive prompt in a child must fail fast, not hang the turn.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin, // POSIX process group for the group kill; breaks console children on Windows.
    });

    let settled = false;
    let spawned = false;
    let exitFired = false;
    let closeFired = false;
    let killedFor: Exclude<CommandTermination, 'exited' | 'spawn-error'> | null = null;
    let killDetail: string | undefined;
    let drainTimedOut = false;
    let spawnError: string | undefined;
    let exitCode: number | null = null;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let killWaitTimer: NodeJS.Timeout | undefined;
    let pendingKill: Promise<void> | null = null;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      const finish = (): void => {
        const termination: CommandTermination = spawnError !== undefined ? 'spawn-error' : (killedFor ?? 'exited');
        resolve({
          termination,
          exitCode: termination === 'exited' ? exitCode : null,
          drainTimedOut,
          ...(killDetail !== undefined ? { killDetail } : {}),
          ...(spawnError !== undefined ? { spawnError } : {}),
          ...base(),
        });
      };
      // The child's own exit can beat the killTree promise; the kill evidence must not be lost.
      // killTree is genuinely bounded — the taskkill wait itself carries HELPER_BOUND_MS since
      // S20.5 (it previously awaited the helper's exit with no bound, which made this sentence a
      // hope), plus the capped liveness probes — so this cannot reintroduce a hang.
      if (pendingKill) void pendingKill.then(finish);
      else finish();
    };

    const destroyStreams = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    // First cause wins: a timeout kill already in flight is not relabeled by a later Ctrl+C.
    // Once the child has exited on its own, a late timeout/abort must NOT relabel a genuinely
    // completed command as killed (that would destroy its real exit code and fabricate a kill in
    // the evidence log) — the drain window between 'exit' and 'close' can be up to drainTimeoutMs.
    const initiateKill = (reason: 'timeout' | 'aborted'): void => {
      if (settled || killedFor !== null || exitFired) return;
      killedFor = reason;
      const pid = child.pid;
      const afterKill = (): void => {
        if (settled || exitFired) return;
        // TerminateProcess exits are prompt; a miss here is abnormal and must not hang the turn.
        killWaitTimer = setTimeout(() => {
          if (settled || exitFired) return;
          killDetail = `${killDetail ?? ''}${killDetail ? '; ' : ''}exit event never fired within ${EXIT_AFTER_KILL_BOUND_MS}ms`;
          drainTimedOut = true;
          destroyStreams();
          settle();
        }, EXIT_AFTER_KILL_BOUND_MS);
      };
      if (pid === undefined || exitFired) {
        afterKill();
        return;
      }
      pendingKill = killTree(pid).then((r) => {
        killDetail = r.verified ? r.detail : `${r.detail} (kill unverified)`;
        afterKill();
      });
    };
    const onAbort = (): void => initiateKill('aborted');

    if (spec.timeoutMs > 0) timeoutTimer = setTimeout(() => initiateKill('timeout'), spec.timeoutMs);
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('spawn', () => {
      spawned = true;
      if (child.pid !== undefined) {
        try {
          spec.onSpawn?.(child.pid);
        } catch {
          // An observer (evidence append) that throws inside the 'spawn' listener would be an
          // unhandled exception crashing the process mid-command; the command itself still
          // completes and its outcome is recorded through the normal completion path.
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      if (!spawned) {
        spawnError = `failed to spawn: ${err.message}`;
        settle(); // no 'exit'/'close' will ever fire
      } else {
        killDetail = `${killDetail ?? ''}${killDetail ? '; ' : ''}process error: ${err.message}`;
      }
    });

    // Live-preview decode is STATEFUL per stream: a multi-byte rune split across chunks must not
    // render as replacement chars (the captured result decodes once from raw buffers regardless).
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (d: Buffer) => {
      stdoutCap.push(d);
      combinedCap.push(d);
      const text = stdoutDecoder.write(d);
      if (text.length > 0) spec.onOutput?.(text, 'stdout');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrCap.push(d);
      combinedCap.push(d);
      const text = stderrDecoder.write(d);
      if (text.length > 0) spec.onOutput?.(text, 'stderr');
    });

    child.on('exit', (code) => {
      exitFired = true;
      exitCode = code;
      if (killWaitTimer) clearTimeout(killWaitTimer);
      // The command reached its own exit: a later timeout/abort is no longer a kill of THIS
      // command, so disarm both so they cannot relabel it during the stdio drain window.
      if (timeoutTimer) clearTimeout(timeoutTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      if (closeFired) {
        settle();
        return;
      }
      drainTimer = setTimeout(() => {
        drainTimedOut = true;
        destroyStreams();
        settle();
      }, spec.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    });

    child.on('close', () => {
      closeFired = true;
      if (drainTimer) clearTimeout(drainTimer);
      if (exitFired && !settled) settle();
    });
  });
}
