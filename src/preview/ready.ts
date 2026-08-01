import { stripAnsi } from '../shared/text.js';
import type { SupervisedHandle } from './types.js';

/**
 * Process-level readiness (Session 13): "the server answered an HTTP request" — nothing more.
 * ANY HTTP status counts as process-level ready (a 500 is a running server with a bug; the
 * browser flows are what judge application state). What readiness NEVER means here: a load
 * event, a spinner, or the mere absence of a crash. Application-level readiness is declared
 * per browser flow (the FlowSpec's `ready_when`), not inferred by the harness.
 */

export interface ReadyOutcome {
  ready: boolean;
  cause: 'ready' | 'timeout' | 'died' | 'aborted';
  port?: number;
  url?: string;
  httpStatus?: number;
  waitedMs: number;
  probeDetail: string;
}

export interface ReadyOptions {
  /** The declared port, tried exclusively when present (recorded as 'declared'). */
  expectedPort?: number;
  waitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Injectable HTTP probe (tests); returns the status or null when nothing answered. */
  probeHttp?: (url: string) => Promise<number | null>;
}

/** Session 16: 30s → 60s. A first-run Vite/Next/tsx dev server compiles before it listens. */
export const DEFAULT_READY_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 300;
const PROBE_REQUEST_TIMEOUT_MS = 2_000;

/**
 * Ports mentioned in server output, LAST occurrence first (servers print their final port last).
 *
 * The tail is ANSI-stripped first. Vite prints its URL as
 * `cyan(url.replace(/:(\d+)\//, ':' + bold(port) + '/'))`, and picocolors forces colour on win32
 * even when stdout is a log file — so the raw bytes read `http://localhost:<ESC>[1m5173<ESC>[22m/`
 * and a parser anchored on `localhost:` finds nothing. Measured, not theorised: without the strip
 * this function returns `[]` for a real Vite banner on this platform, which made the frontend half
 * of a full-stack session unstartable while its log visibly said the server was up.
 */
export function parsePortCandidates(tail: string): number[] {
  const re = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{2,5})/g;
  const seen: number[] = [];
  for (const m of stripAnsi(tail).matchAll(re)) {
    const port = Number(m[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) seen.push(port);
  }
  const uniqueLastFirst: number[] = [];
  for (let i = seen.length - 1; i >= 0; i--) {
    if (!uniqueLastFirst.includes(seen[i]!)) uniqueLastFirst.push(seen[i]!);
  }
  return uniqueLastFirst;
}

async function defaultProbeHttp(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS), redirect: 'manual' });
    // The body is irrelevant; cancel it so sockets do not accumulate across polls.
    try {
      await res.body?.cancel();
    } catch {
      /* already consumed or closed */
    }
    return res.status;
  } catch {
    return null;
  }
}

/** At most this many parsed candidates are probed per cycle (a chatty proxy table must not
 *  turn one iteration into minutes of serial 2s probes). */
const MAX_PORT_CANDIDATES = 4;

/**
 * Loopback addresses probed per candidate port, in order. BOTH families are required, not one.
 *
 * A server told to listen on the string `localhost` binds whatever the resolver returns first, and
 * Node 22's default result order is `verbatim` — which on this platform means `::1`. A dev server
 * bound to `[::1]:5173` refuses every connection to `127.0.0.1:5173`, so an IPv4-only probe waits
 * out its entire deadline and then stops a healthy server as "failed to start". Measured on the
 * development machine: `listen(0,'localhost')` bound `::1`, `http://127.0.0.1:<p>/` was
 * ECONNREFUSED, `http://[::1]:<p>/` answered 200.
 *
 * Literals, never the name: `localhost` would put DNS ordering and Happy-Eyeballs behaviour
 * between the harness and its own evidence, and the URL recorded here becomes the origin a browser
 * flow is locked to. The address that actually answered is the address that gets recorded.
 */
const PROBE_HOSTS = ['127.0.0.1', '[::1]'] as const;

export async function waitForReady(handle: SupervisedHandle, opts: ReadyOptions = {}): Promise<ReadyOutcome> {
  const waitMs = opts.waitMs ?? DEFAULT_READY_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const probeHttp = opts.probeHttp ?? defaultProbeHttp;
  const startedAt = Date.now();

  const aborted = (): ReadyOutcome => ({
    ready: false,
    cause: 'aborted',
    waitedMs: Date.now() - startedAt,
    probeDetail: 'readiness wait aborted by the user; the process was not stopped',
  });
  const timedOut = (candidates: readonly number[]): ReadyOutcome => ({
    ready: false,
    cause: 'timeout',
    waitedMs: Date.now() - startedAt,
    probeDetail:
      candidates.length > 0
        ? `no HTTP answer on candidate port(s) ${candidates.join(', ')} at ${PROBE_HOSTS.join(' or ')} within ${String(waitMs)}ms`
        : `no listening port appeared in the server output within ${String(waitMs)}ms`,
  });

  for (;;) {
    if (opts.signal?.aborted) return aborted();
    if (!handle.isAlive()) {
      return { ready: false, cause: 'died', waitedMs: Date.now() - startedAt, probeDetail: 'the process exited before answering any HTTP probe' };
    }
    // A DECLARED port is probed only once the server's own output mentions it: an HTTP answer
    // alone proves only that SOMETHING answers on 127.0.0.1:<port> — without the announcement,
    // a foreign local service could be adopted as the consented, browser-drivable preview.
    const announced = parsePortCandidates(handle.tail());
    const candidates =
      opts.expectedPort !== undefined ? (announced.includes(opts.expectedPort) ? [opts.expectedPort] : []) : announced.slice(0, MAX_PORT_CANDIDATES);
    for (const port of candidates) {
      for (const host of PROBE_HOSTS) {
        // The deadline and the abort are honored INSIDE the candidate walk: each probe can cost
        // up to its request timeout, and a long candidate list must not outlive either bound.
        if (opts.signal?.aborted) return aborted();
        if (Date.now() - startedAt >= waitMs) return timedOut(candidates);
        const url = `http://${host}:${String(port)}/`;
        const status = await probeHttp(url);
        if (status === null) continue;
        // A probe answer from a process that has DIED is somebody else's socket, never readiness.
        if (!handle.isAlive()) {
          return { ready: false, cause: 'died', waitedMs: Date.now() - startedAt, probeDetail: 'the process exited while the port was being probed' };
        }
        const source = opts.expectedPort !== undefined ? 'declared port' : 'port parsed from server output';
        return {
          ready: true,
          cause: 'ready',
          port,
          url,
          httpStatus: status,
          waitedMs: Date.now() - startedAt,
          probeDetail: `HTTP ${String(status)} on ${source} ${String(port)} at ${host}, announced in server output (socket ownership not verified)`,
        };
      }
    }
    if (Date.now() - startedAt >= waitMs) {
      return opts.expectedPort !== undefined && !announced.includes(opts.expectedPort)
        ? {
            ready: false,
            cause: 'timeout',
            waitedMs: Date.now() - startedAt,
            probeDetail: `the server output never announced the declared port ${String(opts.expectedPort)} within ${String(waitMs)}ms (announcement is required before the harness will probe it)`,
          }
        : timedOut(candidates);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
