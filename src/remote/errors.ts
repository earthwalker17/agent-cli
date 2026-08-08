/**
 * Typed failures for the remote-delivery pack. Module-local on purpose: the kernel's
 * `shared/errors.ts` stays reserved for failures the KERNEL can produce, and a workflow pack owns
 * its own vocabulary (constitution: workflow packs stay outside the kernel).
 *
 * The reasons exist to answer one question for the model: *will retrying help, and if not, what is
 * the exact cure?* A push rejected because the remote moved is worth one more look; a push rejected
 * because the token lacks the `workflow` scope will be rejected identically forever, and the only
 * useful reply is the command that fixes it.
 */

export type RemoteErrorReason =
  /** `gh` is not installed or not on PATH. Terminal; names the install. */
  | 'no-gh'
  /** `gh` is installed but has no usable credential for the host. Terminal; names `gh auth login`. */
  | 'unauthenticated'
  /** The target host is not GitHub, so no `gh`-backed operation can apply. Terminal. */
  | 'not-github'
  /** Repository, remote, account, branch or ref identity could not be resolved unambiguously. */
  | 'ambiguous'
  /** The account cannot perform this on this repository (permission, archived repo). Terminal. */
  | 'permission'
  /**
   * GitHub refused a push that touches `.github/workflows/**` because the credential lacks the
   * `workflow` scope. Terminal until the token is re-scoped; the cure is `gh auth refresh -s workflow`.
   */
  | 'workflow-scope'
  /** The remote rejected the ref update (non-fast-forward, stale lease, protected branch). */
  | 'rejected'
  /** The remote moved between the approval and the attempt; nothing was sent. */
  | 'moved'
  /** A precondition the harness checks itself did not hold (tag missing remotely, ref absent). */
  | 'precondition'
  /** Connection failure — DNS, TLS, proxy, refused. Retryable. */
  | 'network'
  /** Authentication needed interaction the harness cannot provide (helper prompt, ssh passphrase). */
  | 'credential-interactive'
  /** GitHub rate limit or secondary limit. Retryable later, not immediately. */
  | 'rate-limit'
  /** The call exceeded its own time bound. */
  | 'timeout'
  /** The caller's AbortSignal fired (turn cancellation, /cancel). */
  | 'aborted'
  /** The tool could not make sense of gh/git output it depends on. Terminal; a harness bug signal. */
  | 'malformed-output';

/** Reasons a bounded retry could plausibly help. Everything else is terminal by construction. */
const RETRYABLE: readonly RemoteErrorReason[] = ['network', 'rate-limit', 'moved'];

/**
 * A bounded remote failure with a typed reason and, where one exists, the exact command that cures
 * it. Messages are safe to show a model but are not harness-attributed display lines — a caller
 * printing one into chrome or an event still sanitizes at the print site (project discipline).
 *
 * A message must never carry a credential. Every string here is built from scrubbed gh/git output.
 */
export class RemoteError extends Error {
  override readonly name = 'RemoteError';
  constructor(
    message: string,
    readonly reason: RemoteErrorReason,
    readonly detail?: { exitCode?: number | null; cure?: string },
  ) {
    super(message);
  }

  get retryable(): boolean {
    return RETRYABLE.includes(this.reason);
  }
}

/**
 * Classify a failed git/gh invocation from its (already scrubbed) output.
 *
 * String matching over a third party's error text is inherently approximate, and it is used here
 * only to choose an EXPLANATION — never to grant, skip, or widen anything. An unrecognised failure
 * degrades to the caller's fallback reason with the output attached, rather than being asserted as
 * something it might not be.
 */
export function classifyRemoteFailure(text: string, fallback: RemoteErrorReason): { reason: RemoteErrorReason; cure?: string } {
  const t = text.toLowerCase();
  if (/refusing to allow (an oauth app|a github app|a personal access token|an? .*integration) to (create or update )?workflow/.test(t)) {
    return { reason: 'workflow-scope', cure: 'gh auth refresh -h github.com -s workflow  (then re-run the push)' };
  }
  if (/\bstale info\b|\bfetch first\b|non-fast-forward|failed to push some refs/.test(t)) {
    return { reason: 'rejected' };
  }
  if (/protected branch|refusing to update|required status check|pre-receive hook declined/.test(t)) {
    return { reason: 'rejected' };
  }
  if (/permission (to .* )?denied|403 forbidden|resource not accessible|must have admin rights|write access to repository not granted/.test(t)) {
    return { reason: 'permission' };
  }
  if (/could not read (username|password)|terminal prompts disabled|authentication failed|no credential|credential.*interactive|askpass/.test(t)) {
    return { reason: 'credential-interactive', cure: 'authenticate once yourself (`gh auth login`, or a single manual `git push`), then retry' };
  }
  if (/api rate limit exceeded|secondary rate limit|you have exceeded a secondary/.test(t)) {
    return { reason: 'rate-limit' };
  }
  if (/could not resolve host|network is unreachable|connection (refused|reset|timed out)|tls|ssl|proxy/.test(t)) {
    return { reason: 'network' };
  }
  if (/not found|does not exist|no such remote|repository not found/.test(t)) {
    return { reason: 'precondition' };
  }
  return { reason: fallback };
}

/** One honest sentence for the model, with the retry advice the reason implies. */
export function remoteFailureMessage(e: unknown): string {
  if (e instanceof RemoteError) {
    const cure = e.detail?.cure !== undefined ? ` Cure: ${e.detail.cure}.` : '';
    const advice = e.retryable
      ? ' A single retry may work; do not loop.'
      : ' This will not change by retrying — report it and stop.';
    return `remote operation failed (${e.reason}): ${e.message}.${cure}${advice}`;
  }
  return `remote operation failed: ${(e as Error).message}`;
}
