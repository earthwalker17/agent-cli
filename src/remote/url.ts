import type { RemoteEndpoint, RemoteScheme } from './types.js';

/**
 * Parsing and redacting git remote URLs.
 *
 * Two jobs, both load-bearing:
 *
 *  1. **Identity.** A mutation must name an exact destination, and the destination is whatever the
 *     remote URL says — not what the branch is called, not what the directory is called. Host and
 *     `owner/repo` are extracted here and nowhere else.
 *  2. **Redaction.** A configured remote may embed a credential (`https://x-access-token:ghs_…@…`
 *     is the standard CI form). `git remote -v` prints it verbatim, so the raw string must never
 *     leave this module: callers receive `displayUrl`, which has the userinfo replaced, plus a
 *     `hadCredentials` flag so the fact can be reported instead of silently hidden.
 *
 * The scp-like form (`git@github.com:owner/repo.git`) has no scheme and cannot be handed to
 * `URL`, so it is matched separately — carefully, because `C:\repos\bare.git` has the same shape
 * to a naive `host:path` split and is a perfectly ordinary local remote (which is exactly how this
 * pack is tested without a network).
 */

/** Hosts we can recognise as GitHub from the URL alone. */
const GITHUB_HOST = /^(github\.com|.*\.github\.com|.*\.ghe\.com)$/;

/** `owner/repo`, each a conservative forge-name shape. */
const SLUG = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)$/;

export interface ParsedRemoteUrl {
  scheme: RemoteScheme;
  host: string | null;
  slug: string | null;
  /** The URL with any userinfo replaced. Safe to print, log, and show a model. */
  displayUrl: string;
  hadCredentials: boolean;
  /**
   * True when the URL is recognisably a GitHub host. A HINT, not an authorization: an enterprise
   * install has an arbitrary hostname, so a `gh`-backed operation checks the host against the
   * hosts `gh auth status` actually reported rather than trusting this flag.
   */
  isGitHubHost: boolean;
}

/** A Windows drive path (`C:\x`, `c:/x`) — never an scp-like remote, always a local path. */
function isWindowsPath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s);
}

function looksLikeLocalPath(s: string): boolean {
  return isWindowsPath(s) || s.startsWith('/') || s.startsWith('.') || s.startsWith('\\\\') || s.startsWith('~');
}

/** Strip a trailing `.git` and any leading/trailing slashes from a URL path. */
function pathToSlug(rawPath: string): string | null {
  const trimmed = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (trimmed === '') return null;
  return SLUG.test(trimmed) ? trimmed : null;
}

/**
 * Parse one remote URL. Never throws: an unrecognisable remote becomes `scheme: 'other'` with a
 * null host, which every caller treats as "cannot be a GitHub target" rather than as an error.
 */
export function parseRemoteUrl(raw: string): ParsedRemoteUrl {
  const url = raw.trim();
  const unknown: ParsedRemoteUrl = {
    scheme: 'other',
    host: null,
    slug: null,
    displayUrl: url,
    hadCredentials: false,
    isGitHubHost: false,
  };
  if (url === '') return unknown;

  if (looksLikeLocalPath(url)) {
    return { ...unknown, scheme: 'file' };
  }

  // scp-like: [user@]host:path, where the path does not begin with a slash and there is no scheme.
  // Excluded above: drive letters. Also require a dot or an '@' in the authority so a bare
  // `name:path` (which git would treat as a remote NAME, not a URL) does not masquerade as a host.
  const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (scp !== null && !url.includes('://')) {
    const user = scp[1];
    const host = (scp[2] ?? '').toLowerCase();
    const rest = scp[3] ?? '';
    if (host.includes('.') || user !== undefined) {
      // The scp-like form has no password component — `user@host:path` carries a username only,
      // which for git is always a role name (`git`), never a secret. It is preserved verbatim.
      return {
        scheme: 'scp',
        host,
        slug: pathToSlug(rest),
        displayUrl: url,
        hadCredentials: false,
        isGitHubHost: GITHUB_HOST.test(host),
      };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return unknown;
  }

  const proto = parsed.protocol.replace(/:$/, '').toLowerCase();
  const scheme: RemoteScheme =
    proto === 'https' || proto === 'http' ? 'https' : proto === 'ssh' ? 'ssh' : proto === 'file' ? 'file' : 'other';
  if (scheme === 'file') return { ...unknown, scheme: 'file' };

  const hadCredentials = parsed.username !== '' || parsed.password !== '';
  // Trailing-dot normalization matches `shared/domain.ts`: `github.com.` and `github.com` are the
  // same host to DNS, and two host comparisons in one codebase must not disagree about that.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const display = new URL(url);
  if (hadCredentials) {
    display.username = '';
    display.password = '';
  }
  return {
    scheme,
    host: host === '' ? null : host,
    slug: pathToSlug(parsed.pathname),
    displayUrl: hadCredentials ? display.toString().replace('://', '://[REDACTED credentials]@') : display.toString(),
    hadCredentials,
    isGitHubHost: GITHUB_HOST.test(host),
  };
}

/** Build a `RemoteEndpoint` from a configured remote's name and URL. */
export function endpointOf(name: string, rawUrl: string): RemoteEndpoint {
  const p = parseRemoteUrl(rawUrl);
  return {
    name,
    displayUrl: p.displayUrl,
    host: p.host,
    slug: p.slug,
    scheme: p.scheme,
    isGitHub: p.isGitHubHost,
    hadCredentials: p.hadCredentials,
  };
}

/**
 * Parse `git remote -v` output into endpoints, keyed by remote name.
 *
 * Only the FETCH line is read. A remote can be configured with different fetch and push URLs
 * (`remote.<name>.pushurl`), and where they differ the push destination is the one that matters —
 * so a divergence is reported rather than resolved here, and the caller stops.
 */
export function parseRemoteVerbose(stdout: string): { endpoints: RemoteEndpoint[]; pushUrlDiffers: string[] } {
  const fetchUrls = new Map<string, string>();
  const pushUrls = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\t(.+?)\s+\((fetch|push)\)\s*$/.exec(line.trimEnd());
    if (m === null) continue;
    const [, name, url, kind] = m;
    if (name === undefined || url === undefined) continue;
    (kind === 'push' ? pushUrls : fetchUrls).set(name, url);
  }
  const endpoints: RemoteEndpoint[] = [];
  const pushUrlDiffers: string[] = [];
  for (const [name, url] of fetchUrls) {
    endpoints.push(endpointOf(name, url));
    const push = pushUrls.get(name);
    if (push !== undefined && push !== url) pushUrlDiffers.push(name);
  }
  return { endpoints, pushUrlDiffers };
}
