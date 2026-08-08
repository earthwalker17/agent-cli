/**
 * Credential scrubbing for text the harness did not author.
 *
 * Distinct from `shared/hash.ts`'s `redactSecret`, which replaces the WHOLE content of a file the
 * policy gate classified as secret-named. This one is a needle-in-haystack pass over output that is
 * mostly harmless: git and gh print URLs, remotes, and error text that can carry a credential in
 * the middle of an otherwise useful line, and dropping the whole line would destroy the diagnostic.
 *
 * Why it exists at all (three concrete reasons, not a precaution):
 *
 *  1. GHSA-cg6r-mpgc-h9mm — `gh auth status` WITHOUT `--show-token` printed a portion of the token
 *     in plaintext for formats whose prefix is followed by an underscore (`github_pat_*`, `ghs_*`,
 *     `ghu_*`). Fixed in gh 2.97.0. Every older gh is a live leak into whatever reads its stdout,
 *     and this harness's readers are a model context, a transcript, and an append-only event log —
 *     three places a credential must never reach.
 *  2. A remote URL may embed one: `https://x-access-token:ghs_…@github.com/o/r.git` is the standard
 *     CI form, and `git remote -v` prints it verbatim.
 *  3. git echoes the remote URL back inside failure messages, so an authentication error is exactly
 *     the case where the credential and the text most want to travel together.
 *
 * HONEST LIMIT: this is pattern matching over known credential shapes. It catches GitHub's
 * documented token formats and URL userinfo; it cannot catch an arbitrary secret a third party
 * chose to print. It is applied at the remote pack's boundaries (every gh/git-remote stdout and
 * stderr, before the model, the transcript, or an event sees it), not globally.
 */

/**
 * GitHub's documented token formats. All are `<prefix>_<base62 body>`:
 *   ghp_ personal access (classic) · gho_ OAuth · ghu_ user-to-server · ghs_ server-to-server
 *   ghr_ refresh · github_pat_ fine-grained (body may contain underscores)
 * The bodies are 36+ characters in practice; 20 is a deliberately loose floor so a truncated or
 * future-length token still matches.
 */
const GH_TOKEN = String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`;
const GH_FINE_GRAINED = String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`;

/**
 * URL userinfo: `scheme://user:password@host`. Both halves go, because the username half is the
 * credential in the `x-access-token:<token>@` form and `<token>:x-oauth-basic@` reverses them.
 * Anchored on a scheme so a bare `user@host` (an scp-style git remote, which carries no secret) is
 * left alone.
 */
const URL_USERINFO = String.raw`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`;

/** A generic `Authorization:` header value, in case one is ever echoed by a verbose transport. */
const AUTH_HEADER = String.raw`\b(authorization\s*:\s*)(bearer|basic|token)\s+\S+`;

/**
 * Sources, not compiled `RegExp` literals, because a `/g` regex carries `lastIndex` across calls —
 * a shared module-level global regex used with `.test()` answers differently on alternate calls for
 * the same input. Every use compiles a fresh one.
 */
const PATTERNS: readonly { src: string; flags: string; with: string }[] = [
  // Userinfo FIRST, and the order is load-bearing. Scrubbing the token pattern first turns
  // `https://x-access-token:ghs_…@host` into `https://x-access-token:[REDACTED gh-token]@host` —
  // the secret is gone, but the placeholder now contains a space, so the userinfo pattern no
  // longer matches and the username half survives. Running userinfo first removes the whole
  // credential in one replacement and leaves nothing for the token pattern to half-finish.
  { src: URL_USERINFO, flags: 'g', with: '$1[REDACTED credentials]@' },
  { src: GH_FINE_GRAINED, flags: 'g', with: '[REDACTED github-pat]' },
  { src: GH_TOKEN, flags: 'g', with: '[REDACTED gh-token]' },
  { src: AUTH_HEADER, flags: 'gi', with: '$1$2 [REDACTED]' },
];

/**
 * Replace every recognised credential shape with a labeled placeholder.
 *
 * The placeholders NAME what was removed. A bare `[REDACTED]` would leave a reader unable to tell a
 * scrubbed token from an unrelated failure, and the distinction is the whole point of keeping the
 * surrounding text.
 */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(new RegExp(p.src, p.flags), p.with);
  return out;
}

/**
 * True when the text still contains something that looks like a credential. Used by tests and by
 * the remote pack's own belt-and-braces assertion before an event is appended.
 */
export function hasResidualSecret(text: string): boolean {
  return PATTERNS.some((p) => new RegExp(p.src, p.flags.replace('g', '')).test(text));
}
