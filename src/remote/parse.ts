import { RemoteError } from './errors.js';
import type { IssueSummary, PullSummary, ReleaseResult, RemoteIdentity, RepositorySummary, RunSummary } from './types.js';

/**
 * Tolerant parsers for `gh --json` output.
 *
 * Everything here is defensive on purpose. gh's JSON shapes are a third party's contract, not
 * ours: a field can be renamed, a scalar can become an object (`author` is `{login}`, not a
 * string), and a future version can add keys. A parser that assumes the shape would turn a cosmetic
 * upstream change into a crash inside a publish flow.
 *
 * The rule is therefore: every field is read through a checked accessor, an unreadable field
 * degrades to a null or an empty string, and only a response that cannot be JSON at all is an
 * error. Values are LENGTH-capped here and SANITIZED at the render site — parsing must not silently
 * alter what a remote actually said.
 */

/** Cap for any single third-party string field. Long enough for a real title, short of a payload. */
const MAX_FIELD = 500;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(rec: Record<string, unknown> | null, key: string): string {
  const v = rec?.[key];
  return typeof v === 'string' ? v.slice(0, MAX_FIELD) : '';
}

function num(rec: Record<string, unknown> | null, key: string): number {
  const v = rec?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function bool(rec: Record<string, unknown> | null, key: string): boolean {
  return rec?.[key] === true;
}

/** gh renders a user as `{login: "..."}`; older shapes sometimes gave a bare string. */
function login(rec: Record<string, unknown> | null, key: string): string {
  const v = rec?.[key];
  if (typeof v === 'string') return v.slice(0, MAX_FIELD);
  return str(asRecord(v), 'login');
}

function parseJson(stdout: string, what: string): unknown {
  const text = stdout.trim();
  if (text === '') throw new RemoteError(`gh returned no output for ${what}`, 'malformed-output');
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteError(`gh returned output for ${what} that is not JSON`, 'malformed-output');
  }
}

/**
 * `gh auth status --json hosts` ->
 * `{"hosts":{"github.com":[{state,active,host,login,tokenSource,scopes,gitProtocol}]}}`
 *
 * `scopes` arrives as a comma-separated STRING, not an array. The absence of `workflow` in it is
 * load-bearing later, so it is split into real entries here rather than carried as prose.
 */
export function parseAuthStatus(stdout: string): RemoteIdentity[] {
  const root = asRecord(parseJson(stdout, 'auth status'));
  const hosts = asRecord(root?.['hosts']);
  if (hosts === null) return [];
  const collected: { identity: RemoteIdentity; active: boolean }[] = [];
  let total = 0;
  for (const host of Object.keys(hosts)) {
    const entries = hosts[host];
    if (!Array.isArray(entries)) continue;
    total += entries.length;
    for (const raw of entries) {
      const rec = asRecord(raw);
      if (rec === null) continue;
      // A host whose token failed validation is reported by gh with a non-success state. Admitting
      // it would let an expired credential read as "authenticated" right up to the first 401.
      if (str(rec, 'state') !== 'success') continue;
      collected.push({
        active: bool(rec, 'active'),
        identity: {
          host: str(rec, 'host') || host,
          account: str(rec, 'login'),
          protocol: str(rec, 'gitProtocol'),
          scopes: str(rec, 'scopes')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== ''),
          source: str(rec, 'tokenSource'),
          multipleAccounts: false,
        },
      });
    }
  }
  // `active` decides which credential gh actually uses for a host, so active entries sort first
  // (stably, preserving gh's own order otherwise). A caller that takes the first match for a host
  // therefore gets the identity that would really be used, never merely the first one listed.
  const ordered = [...collected].sort((a, b) => Number(b.active) - Number(a.active));
  return ordered.map((c) => ({ ...c.identity, multipleAccounts: total > 1 }));
}

export function parseRepository(stdout: string): RepositorySummary {
  const rec = asRecord(parseJson(stdout, 'repo view'));
  if (rec === null) throw new RemoteError('gh repo view did not return an object', 'malformed-output');
  const defaultBranch = str(asRecord(rec['defaultBranchRef']), 'name');
  const perm = rec['viewerPermission'];
  return {
    nameWithOwner: str(rec, 'nameWithOwner'),
    description: str(rec, 'description'),
    isPrivate: bool(rec, 'isPrivate'),
    isArchived: bool(rec, 'isArchived'),
    isFork: bool(rec, 'isFork'),
    defaultBranch: defaultBranch === '' ? null : defaultBranch,
    viewerPermission: typeof perm === 'string' && perm !== '' ? perm : null,
    url: str(rec, 'url'),
    pushedAt: str(rec, 'pushedAt') || null,
  };
}

function asArray(stdout: string, what: string): Record<string, unknown>[] {
  const v = parseJson(stdout, what);
  if (!Array.isArray(v)) throw new RemoteError(`gh ${what} did not return a list`, 'malformed-output');
  return v.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
}

export function parsePulls(stdout: string): PullSummary[] {
  return asArray(stdout, 'pr list').map((r) => ({
    number: num(r, 'number'),
    title: str(r, 'title'),
    state: str(r, 'state'),
    isDraft: bool(r, 'isDraft'),
    author: login(r, 'author'),
    headRefName: str(r, 'headRefName'),
    baseRefName: str(r, 'baseRefName'),
    url: str(r, 'url'),
    updatedAt: str(r, 'updatedAt'),
  }));
}

export function parseIssues(stdout: string): IssueSummary[] {
  return asArray(stdout, 'issue list').map((r) => {
    const labels = r['labels'];
    return {
      number: num(r, 'number'),
      title: str(r, 'title'),
      state: str(r, 'state'),
      author: login(r, 'author'),
      labels: Array.isArray(labels)
        ? labels.map((l) => (typeof l === 'string' ? l : str(asRecord(l), 'name'))).filter((s) => s !== '')
        : [],
      url: str(r, 'url'),
      updatedAt: str(r, 'updatedAt'),
    };
  });
}

function runOf(r: Record<string, unknown>): RunSummary {
  return {
    databaseId: num(r, 'databaseId'),
    workflowName: str(r, 'workflowName'),
    displayTitle: str(r, 'displayTitle'),
    status: str(r, 'status'),
    conclusion: str(r, 'conclusion'),
    headBranch: str(r, 'headBranch'),
    headSha: str(r, 'headSha'),
    event: str(r, 'event'),
    url: str(r, 'url'),
    createdAt: str(r, 'createdAt'),
  };
}

export function parseRuns(stdout: string): RunSummary[] {
  return asArray(stdout, 'run list').map(runOf);
}

export function parseRun(stdout: string): RunSummary {
  const rec = asRecord(parseJson(stdout, 'run view'));
  if (rec === null) throw new RemoteError('gh run view did not return an object', 'malformed-output');
  return runOf(rec);
}

export function parseRelease(stdout: string): ReleaseResult {
  const rec = asRecord(parseJson(stdout, 'release view'));
  if (rec === null) throw new RemoteError('gh release view did not return an object', 'malformed-output');
  return {
    url: str(rec, 'url'),
    tagName: str(rec, 'tagName'),
    isDraft: bool(rec, 'isDraft'),
    isPrerelease: bool(rec, 'isPrerelease'),
  };
}

/**
 * The URL `gh release create` prints on success (its stdout is the release URL, one line).
 * Returned as a fact rather than assumed: a future gh that prints something else yields null, and
 * the caller then verifies by reading the release back instead of asserting an address it invented.
 */
export function releaseUrlFromCreate(stdout: string): string | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^https?:\/\//.test(l));
  return line ?? null;
}
