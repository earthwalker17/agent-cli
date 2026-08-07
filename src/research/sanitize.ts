import { neutralizeHarnessDelimiters, sanitizeLine, stripAnsi } from '../shared/text.js';
import type { RefusedUrl } from './types.js';

/**
 * Ingestion defense for retrieved web content — the most untrusted input this harness accepts.
 *
 * The threat is not a hostile byte reaching a terminal; it is a hostile PAGE reaching the model's
 * context and being read as instruction. A page can contain a `[[harness note: …]]` line, a
 * `--- subagent report end ---` fence, an ANSI sequence, a bidi override that reverses a URL's
 * apparent domain, or a paragraph addressed to the agent. Three separate mechanisms answer that:
 *
 * 1. Character neutralization (`sanitizeBlock`) — control, bidi and zero-width characters become
 *    literal escapes, so nothing can spoof structure or hide text from a human reading the log.
 * 2. Fence neutralization (`neutralizeHarnessDelimiters`, shared with the memory docs and child
 *    reports) — a line that mimics a harness provenance boundary is broken.
 * 3. The FENCE ITSELF plus the prompt contract (`format.ts`, `system-prompt.ts`) — the content is
 *    labeled UNTRUSTED and declared to be data. That is a mitigation, not a boundary, and the
 *    documentation says so: a sufficiently persuasive page can still influence a model. What it
 *    cannot do is act, because a researcher child holds only read-only and research tools.
 *
 * Ingestion is ONE choke point on purpose (the `report-finding.ts` discipline): sanitize where the
 * bytes enter the pack, not at each of the render sites downstream.
 */

// C0 controls, DEL, C1 controls, bidi marks and embedding/override/isolate controls, zero-width
// characters and the BOM. Identical to `shared/text.ts`'s set except that \n survives here —
// a page is a block, and collapsing it to one line would destroy the structure that makes it
// readable evidence. \t and \r are still normalized away.
const UNSAFE_BLOCK = new RegExp(
  '[' +
    '\\u0000-\\u0008' + // C0 below \t
    '\\u000b\\u000c' + // VT, FF — the newline itself deliberately survives
    '\\u000e-\\u001f' + // C0 above \r
    '\\u007f-\\u009f' + // DEL + C1
    '\\u200b-\\u200f' +
    '\\u202a-\\u202e' +
    '\\u2066-\\u2069' +
    '\\ufeff' +
    ']',
  'gu',
);

/**
 * Sanitize a multi-LINE block of untrusted text: strip ANSI, normalize line endings and tabs,
 * escape every spoofing-capable character, collapse runaway blank runs, and break harness fences.
 *
 * Distinct from `sanitizeLine`, which flattens newlines because its output occupies exactly one
 * display line. Use that for titles and URLs; use this for page bodies and snippets.
 */
export function sanitizeBlock(s: string): string {
  return neutralizeHarnessDelimiters(
    stripAnsi(s)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ')
      .replace(UNSAFE_BLOCK, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)
      // A page padded with thousands of blank lines is a cheap way to push the useful part of a
      // result past a truncation boundary. Three or more become two.
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/** Hard ceiling on a URL we will store, display, or send. Longer inputs are refused, not cut. */
export const MAX_URL_CHARS = 2048;

export type UrlVerdict =
  | { ok: true; url: string; host: string; idn: boolean }
  | { ok: false; reason: string };

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Validate a URL as a CITABLE SOURCE identifier.
 *
 * A URL is an identifier, not prose. The `report_finding` rule applies verbatim: a value that
 * sanitization would ALTER is refused outright rather than escaped, because escaping it would
 * store an address that addresses nothing while still looking like a citation.
 *
 * Private, loopback and link-local hosts are refused for two independent reasons, and only one of
 * them is about this machine: (a) naming an internal host to a third-party extraction service
 * leaks the internal name, and (b) the provider fetches from its own infrastructure, so such a
 * URL could not resolve to the intended target anyway. This is NOT an SSRF guard — the harness
 * never fetches these URLs itself. It is leak prevention plus an honest early failure.
 */
export function validateSourceUrl(raw: string): UrlVerdict {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty URL' };
  if (trimmed.length > MAX_URL_CHARS) return { ok: false, reason: `URL exceeds ${MAX_URL_CHARS} characters` };
  if (sanitizeLine(trimmed) !== trimmed) {
    return { ok: false, reason: 'URL contains control or spoofing characters' };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'not a parseable absolute URL' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `scheme '${u.protocol.replace(/:$/, '')}' is not supported (http and https only)` };
  }
  // Credentials embedded in a URL would be forwarded verbatim to the search provider.
  if (u.username !== '' || u.password !== '') {
    return { ok: false, reason: 'URL carries embedded credentials' };
  }

  const host = u.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'URL has no host' };

  if (host.startsWith('[')) {
    // URL normalizes every IPv6 literal to bracketed form, so this catches ::1, fe80::, fc00::/7
    // and every public literal alike. All are refused for the same reason as IPv4 literals.
    return { ok: false, reason: 'bare IPv6 address is not a citable source' };
  }
  if (IPV4.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some((n) => n > 255)) return { ok: false, reason: 'malformed IPv4 address' };
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return { ok: false, reason: 'loopback address' };
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return { ok: false, reason: 'private network address' };
    }
    if (a === 169 && b === 254) return { ok: false, reason: 'link-local address' };
    if (a === 0 || a >= 224) return { ok: false, reason: 'reserved address range' };
    return { ok: false, reason: 'bare IPv4 address is not a citable source' };
  }

  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'loopback host' };
  for (const suffix of ['.local', '.internal', '.intranet', '.home.arpa']) {
    if (host.endsWith(suffix)) return { ok: false, reason: `private-use host suffix '${suffix}'` };
  }
  // A single-label host ("wiki", "intranet") can only be an internal name — a public source
  // always carries a registrable suffix.
  if (!host.includes('.')) return { ok: false, reason: 'host has no public suffix (single-label name)' };

  // `URL` already normalized any non-ASCII host to punycode, so a raw non-ASCII hostname cannot
  // reach here. Punycode labels CAN — and a homograph domain is a real phishing shape — so the
  // verdict flags them and the renderers mark them, rather than refusing legitimate IDN sources.
  const idn = host.split('.').some((label) => label.startsWith('xn--'));

  return { ok: true, url: u.href, host, idn };
}

/** The hostname of an already-validated URL, or the input sanitized for display if it is not one. */
export function hostOf(url: string): string {
  const v = validateSourceUrl(url);
  return v.ok ? v.host : sanitizeLine(url);
}

/**
 * Denylist matching. Re-exported from `shared/domain.ts` rather than reimplemented: the policy
 * engine enforces the same denylist and must not import a workflow pack, so the predicate lives
 * one layer down where both can reach it. Two copies of this would eventually disagree.
 */
export { domainMatches } from '../shared/domain.js';

/**
 * Build a display-safe refusal record. The URL is sanitized because it failed validation.
 *
 * Sanitize BEFORE slicing, never after: escaping expands (one control character becomes six
 * printable ones), so a bound applied to the raw string is not a bound on what is displayed.
 */
export function refusal(url: string, reason: string): RefusedUrl {
  const safe = sanitizeLine(url);
  return { url: safe.length > 200 ? `${safe.slice(0, 200)}…` : safe, reason };
}
