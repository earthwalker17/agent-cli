/**
 * Typed provider errors (Session 15). Adapters translate every wire failure into a
 * ProviderError so the harness can render something more useful than a raw message and tests
 * can branch on class, never on message text. Abort stays OUTSIDE this taxonomy at the loop
 * level — runTurn detects aborts via `signal.aborted` after a throw — but adapters still tag
 * aborts so the error is honest if it ever surfaces.
 */

export type ProviderErrorKind =
  | 'auth' // 401/403: key invalid, revoked, or lacking permission
  | 'rate-limit' // 429: request/token/concurrency limits
  | 'balance' // 402 / insufficient_quota: prepaid balance or quota exhausted
  | 'context-window' // input too large for the model
  | 'bad-request' // 400/404/422: malformed request, unknown model, policy rejection
  | 'server' // 5xx and provider-reported internal failures
  | 'network' // fetch/socket failures before or during the response
  | 'aborted'; // the caller's AbortSignal fired

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly status?: number;
  /** Provider-specific code/type string (e.g. glm "1113", kimi "exceeded_current_quota_error"). */
  readonly providerCode?: string;
  readonly retryable: boolean;

  constructor(opts: {
    kind: ProviderErrorKind;
    provider: string;
    message: string;
    status?: number;
    providerCode?: string;
    retryable?: boolean;
  }) {
    super(`${opts.provider}: ${opts.message}`);
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.provider = opts.provider;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.providerCode !== undefined) this.providerCode = opts.providerCode;
    this.retryable = opts.retryable ?? (opts.kind === 'rate-limit' || opts.kind === 'server' || opts.kind === 'network');
  }
}

/** The HTTP-status base map every profile refines. 402 is BALANCE (DeepSeek prepaid), not auth. */
export function classifyHttpStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'balance';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 404 || status === 422) return 'bad-request';
  if (status >= 500) return 'server';
  return 'bad-request';
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || (err instanceof ProviderError && err.kind === 'aborted'));
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds; undefined when absent. */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header === '') return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), 60_000));
  return undefined;
}

export interface RetryOptions {
  /** Max retries AFTER the first attempt. Parity with the Anthropic SDK's hidden default of 2. */
  retries?: number;
  signal?: AbortSignal;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded retry around the CONNECTION phase only. `attempt` must perform the fetch and throw a
 * ProviderError before any stream content is consumed; once a response streams, callers are past
 * this helper — a half-consumed stream is NEVER replayed (double-billing and duplicate onText
 * deltas are worse than one failed turn). Retries only retryable kinds; honors `retryAfterHint`
 * from the thrown error when the caller attached one; jittered exponential backoff otherwise.
 */
export async function withRetry<T>(attempt: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    if (opts.signal?.aborted) throw lastErr ?? abortError();
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;
      const pe = err instanceof ProviderError ? err : undefined;
      if (pe === undefined || !pe.retryable || i === retries) throw err;
      const hinted = (pe as ProviderError & { retryAfterHint?: number }).retryAfterHint;
      const backoff = hinted ?? Math.min(500 * 2 ** i + Math.floor(Math.random() * 250), 8_000);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function abortError(): Error {
  const e = new Error('request aborted');
  e.name = 'AbortError';
  return e;
}
