/**
 * Typed errors for the source-backed research workflow pack. Module-local on purpose: the
 * kernel's `shared/errors.ts` stays reserved for failures the KERNEL can produce; a workflow pack
 * owns its own failure vocabulary (constitution: workflow packs stay outside the kernel).
 *
 * The reason vocabulary is deliberately close to `provider/errors.ts` — a search provider fails
 * the same ways an LLM provider does — but it is NOT shared: `ProviderError` is read by the model
 * runtime's retry and switching logic, and a research failure must never be mistaken for one.
 */

export type ResearchErrorReason =
  /** No credential is configured (the env var is unset or empty). Terminal; names the cure. */
  | 'no-key'
  /** The provider rejected the credential (HTTP 401/403). Terminal. */
  | 'auth'
  /** Rate limited (HTTP 429). Retryable; `retryAfterMs` may be present. */
  | 'rate-limit'
  /**
   * The account's plan or pay-as-you-go ceiling is exhausted (Tavily's non-standard 432/433).
   * TERMINAL — a generic 4xx retry loop here just burns wall clock against a wall.
   */
  | 'plan-limit'
  /** The request was malformed or out of range (HTTP 400). Terminal; the message carries the detail. */
  | 'bad-request'
  /** The provider failed (HTTP 5xx). Retryable. */
  | 'server'
  /** The response was not the documented shape (schema mismatch / unparseable body). Terminal. */
  | 'malformed-response'
  /** Connection failure — DNS, TLS, refused, proxy. Retryable. */
  | 'network'
  /** The call exceeded its own time bound. */
  | 'timeout'
  /** The caller's AbortSignal fired (turn cancellation, task budget, /cancel). */
  | 'aborted';

/** Reasons a bounded retry could plausibly help. Everything else is terminal by construction. */
const RETRYABLE: readonly ResearchErrorReason[] = ['rate-limit', 'server', 'network'];

/**
 * A bounded research failure with a typed reason. Messages are safe to show a model but are NOT
 * harness-attributed display lines — callers that print them into chrome/report/events still own
 * sanitization at the print site (project discipline).
 *
 * A message must never carry the credential. The client builds these from status codes and the
 * provider's own `detail.error` string, never from the request headers.
 */
export class ResearchError extends Error {
  override readonly name = 'ResearchError';
  constructor(
    message: string,
    readonly reason: ResearchErrorReason,
    readonly detail?: { status?: number; retryAfterMs?: number },
  ) {
    super(message);
  }

  get retryable(): boolean {
    return RETRYABLE.includes(this.reason);
  }
}
