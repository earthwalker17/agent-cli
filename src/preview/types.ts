import type { PreviewEndReason } from '../types.js';

/**
 * Contracts for the supervised long-running process substrate (Session 13).
 *
 * A supervised process is the deliberate inverse of `runManaged`: it STAYS RUNNING after the
 * starting call returns, so the caller holds a handle instead of awaiting an outcome. Everything
 * that made runManaged safe is preserved in a form that survives detachment:
 *  - output goes to a LOG FILE via an inherited fd, never a pipe — an orphan that outlives the
 *    harness can never block on a full pipe buffer half-serving requests;
 *  - lifetime is bounded by a TTL and a log-size cap, each producing a TYPED stop reason;
 *  - death is observable exactly once (the exit listener), with the stop-reason first-cause rule
 *    runManaged uses for kills.
 */
export interface SupervisedSpec {
  /** Executable + args (already shell-wrapped by the caller via shellInvocation). */
  file: string;
  args: string[];
  cwd: string;
  /** Pre-built child environment (exec/env.ts) — never raw process.env. */
  env: Record<string, string>;
  /** Output sink; created (append) by the runner. The durable evidence of what the server said. */
  logFile: string;
  /** Log-size cap; exceeding it stops the process with typed reason 'log-overflow'. */
  maxLogBytes?: number;
  /** Max lifetime; 0 disables (tests only — a session resource must not outlive the user's day). */
  ttlMs?: number;
  /** Log-size poll cadence (injectable for tests; the cap is a bound, not an exact limit). */
  logPollMs?: number;
}

/**
 * The subset of end reasons a caller (or the harness's own bounds) can REQUEST. 'start-failed'
 * is requestable by the START call only — a readiness timeout stops the process with the honest
 * reason (it never became a preview) rather than the user-shaped 'stopped'.
 */
export type PreviewStopReason = Extract<PreviewEndReason, 'stopped' | 'ttl-timeout' | 'log-overflow' | 'session-end' | 'start-failed'>;

export interface SupervisedExit {
  /** The first stop reason requested before death, or null when the process died on its own. */
  requestedStop: PreviewStopReason | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
}

export interface StopResult {
  /** True when the process is verifiably gone within the bounded wait. */
  ok: boolean;
  detail: string;
}

export interface SupervisedHandle {
  pid: number;
  logFile: string;
  /** Resolves exactly once, on process death. Never rejects. */
  exited: Promise<SupervisedExit>;
  isAlive(): boolean;
  /** First-cause: only the first stop's reason is recorded; later calls return the same result. */
  stop(reason: PreviewStopReason): Promise<StopResult>;
  /** Last bytes of the log file (lossy UTF-8 decode) — readiness scanning and display. */
  tail(maxBytes?: number): string;
}

/** One managed preview as the session tracks it (the tool layer builds on the handle). */
export interface PreviewRegistryEntry {
  previewId: string;
  pid: number;
  /** The harness-resolved command (consent identity; also the sweep's kill-verification token). */
  command: string;
  cwd: string;
  port?: number;
  ownerSessionId: string;
  /** The harness process that owns the handle — the sweep's liveness key (worktree precedent). */
  ownerPid: number;
  createdAt: string;
  logFile: string;
}
