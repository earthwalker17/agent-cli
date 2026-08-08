import { runGit } from '../git/client.js';
import { parsePorcelainV2 } from '../git/porcelain.js';
import type { GitResult } from '../git/types.js';
import { sha256 } from '../shared/hash.js';
import { scrubSecrets } from '../shared/secrets.js';
import { RemoteError, classifyRemoteFailure } from './errors.js';
import { shortRef } from './refs.js';
import {
  MAX_PREVIEW_COMMITS,
  MAX_PREVIEW_PATHS,
  REMOTE_CALL_TIMEOUT_MS,
  type PreviewCommit,
  type PushFlag,
  type PushPorcelain,
  type PushPorcelainLine,
  type RefRelation,
  type RemoteObservation,
} from './types.js';

/**
 * Observing a real remote ref, and everything derived from it that a human needs in order to
 * answer "may this be published".
 *
 * The only network verb used here is `git ls-remote`. That is a deliberate choice over `git fetch`:
 * `ls-remote` writes NOTHING locally — no remote-tracking refs, no objects, no FETCH_HEAD — so
 * looking at a remote can never change the state of the user's repository as a side effect of the
 * agent being curious. The cost is that a remote commit we have never seen is not in our object
 * database, so ancestry against it is genuinely unknowable; that case is reported as `unknown`
 * rather than guessed, and the honest cure (fetch it yourself) is named.
 *
 * Every git invocation here carries `-c credential.interactive=false` so a credential helper fails
 * fast instead of raising a GUI prompt no one is watching, and ssh remotes additionally get
 * `BatchMode=yes` so a passphrase prompt cannot hang the turn. Neither is a guarantee — a helper
 * that ignores both still exists — which is why every call is also time-bounded.
 */

export interface RemoteGitDeps {
  gitPath: string;
  /** Repository root — every invocation runs there, never in a subdirectory. */
  repoRoot: string;
  /** Workspace root, for the uncommitted-entry count that the preview reports. */
  workspaceRoot: string;
  /** True when the target remote uses ssh, so a passphrase prompt is disabled rather than awaited. */
  ssh?: boolean;
  signal?: AbortSignal;
}

/** Global `-c` flags every remote-bearing git invocation carries. */
const REMOTE_GIT_CONFIG: readonly string[] = [
  // Git Credential Manager and friends honour this; without it a headless push can raise a GUI
  // dialog and block until the timeout. Not a guarantee (a non-conforming helper ignores it).
  '-c',
  'credential.interactive=false',
  // Path output must be raw so a non-ASCII filename is not returned as an octal-escaped quoted
  // string that no consumer here un-escapes.
  '-c',
  'core.quotePath=false',
];

/**
 * Run one remote-bearing git command with the pack's hardening, and SCRUB its output.
 *
 * The scrub is not optional here: `git push --porcelain` prints `To <url>` as its first line, and
 * git echoes the remote URL back inside authentication failures — so the two places this output is
 * most useful are exactly the two where a credential-bearing remote URL travels with it.
 */
export async function runRemoteGit(deps: RemoteGitDeps, argv: readonly string[], timeoutMs = REMOTE_CALL_TIMEOUT_MS): Promise<GitResult> {
  const result = await runGit({
    gitPath: deps.gitPath,
    argv: [...REMOTE_GIT_CONFIG, ...argv],
    cwd: deps.repoRoot,
    timeoutMs,
    ...(deps.ssh === true ? { env: { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  return { ...result, stdout: scrubSecrets(result.stdout), stderr: scrubSecrets(result.stderr) };
}

/** Local-only git (no network): no credential flags needed, but still hardened by `runGit`. */
async function runLocalGit(deps: RemoteGitDeps, argv: readonly string[]): Promise<GitResult> {
  return runGit({
    gitPath: deps.gitPath,
    argv: ['-c', 'core.quotePath=false', ...argv],
    cwd: deps.repoRoot,
    timeoutMs: REMOTE_CALL_TIMEOUT_MS,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
}

/**
 * Parse `git ls-remote` output for ONE ref.
 *
 * Annotated tags appear twice — `refs/tags/v1` (the tag object) and `refs/tags/v1^{}` (the commit
 * it peels to). The peeled line is dropped: what a push updates, and what a lease is compared
 * against, is the ref's own value.
 */
export function parseLsRemote(stdout: string, refName: string): string | null {
  for (const line of stdout.split('\n')) {
    const m = /^([0-9a-f]{40,64})\s+(\S+)\s*$/.exec(line.trim());
    if (m === null) continue;
    if (m[2] === refName) return m[1] ?? null;
  }
  return null;
}

/** Whether the local object database actually contains this commit-ish. */
async function haveObject(deps: RemoteGitDeps, oid: string): Promise<boolean> {
  const r = await runLocalGit(deps, ['cat-file', '-e', `${oid}^{commit}`]);
  return r.ok;
}

/** Resolve a local rev to its raw oid, or null when it does not exist. */
export async function resolveRev(deps: RemoteGitDeps, rev: string): Promise<string | null> {
  const r = await runLocalGit(deps, ['rev-parse', '--verify', '--quiet', rev]);
  const oid = r.stdout.trim();
  return r.ok && /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
}

/** `git merge-base --is-ancestor a b` — true when `a` is reachable from `b`. */
async function isAncestor(deps: RemoteGitDeps, a: string, b: string): Promise<boolean> {
  const r = await runLocalGit(deps, ['merge-base', '--is-ancestor', a, b]);
  return r.ok;
}

/** Commit subjects in a rev range, newest first, bounded. */
async function commitsIn(deps: RemoteGitDeps, range: string): Promise<{ commits: PreviewCommit[]; omitted: number }> {
  const r = await runLocalGit(deps, ['log', `--max-count=${String(MAX_PREVIEW_COMMITS + 1)}`, '--no-color', '--format=%H %s', range]);
  if (!r.ok) return { commits: [], omitted: 0 };
  const lines = r.stdout.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
  const commits: PreviewCommit[] = [];
  for (const line of lines.slice(0, MAX_PREVIEW_COMMITS)) {
    const sp = line.indexOf(' ');
    const oid = sp === -1 ? line : line.slice(0, sp);
    const subject = sp === -1 ? '' : line.slice(sp + 1);
    if (/^[0-9a-f]{40,64}$/.test(oid)) commits.push({ oid, subject });
  }
  return { commits, omitted: Math.max(0, lines.length - MAX_PREVIEW_COMMITS) };
}

/** Count commits in a rev range. Returns 0 when git could not answer. */
async function countIn(deps: RemoteGitDeps, args: readonly string[]): Promise<number> {
  const r = await runLocalGit(deps, ['rev-list', '--count', ...args]);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return r.ok && Number.isFinite(n) ? n : 0;
}

/** Unique paths touched by a range (or by the tip's recent history when there is no base). */
async function changedPaths(deps: RemoteGitDeps, base: string | null, tip: string): Promise<{ paths: string[]; omitted: number }> {
  const r =
    base !== null
      ? await runLocalGit(deps, ['diff', '--name-only', base, tip])
      : await runLocalGit(deps, ['log', `--max-count=${String(MAX_PREVIEW_COMMITS)}`, '--pretty=format:', '--name-only', tip]);
  if (!r.ok) return { paths: [], omitted: 0 };
  const seen = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const p = line.trim();
    if (p !== '') seen.add(p);
  }
  const all = [...seen];
  return { paths: all.slice(0, MAX_PREVIEW_PATHS), omitted: Math.max(0, all.length - MAX_PREVIEW_PATHS) };
}

/** Uncommitted entries in the workspace right now, or null when git could not answer. */
async function dirtyCount(deps: RemoteGitDeps): Promise<number | null> {
  const r = await runGit({
    gitPath: deps.gitPath,
    argv: ['status', '--porcelain=v2', '-b', '-z', '--untracked-files=all'],
    cwd: deps.workspaceRoot,
    timeoutMs: REMOTE_CALL_TIMEOUT_MS,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!r.ok) return null;
  try {
    return parsePorcelainV2(r.stdout).entries.filter((e) => e.kind !== 'ignored').length;
  } catch {
    return null;
  }
}

/** Does this change set touch a GitHub Actions workflow definition? */
export function touchesWorkflowFiles(paths: readonly string[]): boolean {
  return paths.some((p) => /(^|\/)\.github\/workflows\/[^/]+\.(ya?ml)$/i.test(p.replace(/\\/g, '/')));
}

/**
 * Read ONE remote ref's current oid, or null when it does not exist there.
 *
 * Separate from `observeRemoteRef` because it is used at a different moment for a different
 * purpose: the observation is what a human reads, and this is what the harness re-checks
 * immediately before and immediately after a mutation. Throws `RemoteError` when the remote could
 * not be reached — a mutation must never proceed on "we could not tell".
 */
export async function lsRemoteOid(deps: RemoteGitDeps, remoteName: string, refName: string): Promise<string | null> {
  const ls = await runRemoteGit(deps, ['ls-remote', '--exit-code', remoteName, refName]);
  const absent = ls.termination === 'exited' && ls.exitCode === 2;
  if (!ls.ok && !absent) {
    const { reason, cure } = classifyRemoteFailure(`${ls.stdout}\n${ls.stderr}`, ls.termination === 'timeout' ? 'timeout' : 'network');
    throw new RemoteError(
      `could not read '${refName}' from '${remoteName}': ${firstLine(ls.stderr) || firstLine(ls.stdout) || `exit ${String(ls.exitCode)}`}`,
      reason,
      { exitCode: ls.exitCode, ...(cure !== undefined ? { cure } : {}) },
    );
  }
  return absent ? null : parseLsRemote(ls.stdout, refName);
}

export interface ObserveRequest {
  remoteName: string;
  host: string;
  slug: string | null;
  /** Fully qualified destination ref on the remote. */
  refName: string;
  /** Local rev that would be published (`HEAD`, `refs/heads/x`, `refs/tags/v1`). */
  localRev: string;
}

/**
 * Look at one remote ref and derive the complete publish preview.
 *
 * Throws `RemoteError` for anything that makes the observation itself impossible (the local rev
 * does not exist; the remote could not be reached). A ref that is simply ABSENT on the remote is
 * not a failure — it is the `new` relation, and the most common one for a delivery.
 */
export async function observeRemoteRef(deps: RemoteGitDeps, req: ObserveRequest, nowMs: number): Promise<RemoteObservation> {
  const localOid = await resolveRev(deps, req.localRev);
  if (localOid === null) {
    throw new RemoteError(
      `local ref '${req.localRev}' does not resolve to a commit — there is nothing to publish under that name`,
      'precondition',
      { cure: 'commit your work first (`/commit`), or name a ref that exists' },
    );
  }

  const ls = await runRemoteGit(deps, ['ls-remote', '--exit-code', req.remoteName, req.refName]);
  // `--exit-code` reports 2 for "no matching refs"; that is an answer, not a failure.
  const absent = ls.termination === 'exited' && ls.exitCode === 2;
  if (!ls.ok && !absent) {
    const { reason, cure } = classifyRemoteFailure(`${ls.stdout}\n${ls.stderr}`, ls.termination === 'timeout' ? 'timeout' : 'network');
    throw new RemoteError(
      `could not read '${req.refName}' from '${req.remoteName}': ${firstLine(ls.stderr) || firstLine(ls.stdout) || `exit ${String(ls.exitCode)}`}`,
      reason,
      { exitCode: ls.exitCode, ...(cure !== undefined ? { cure } : {}) },
    );
  }
  const remoteOid = absent ? null : parseLsRemote(ls.stdout, req.refName);

  // Peel both sides to commits for ancestry. A branch ref IS its commit; an annotated tag is not.
  const localCommit = (await resolveRev(deps, `${localOid}^{commit}`)) ?? localOid;

  let relation: RefRelation;
  let ahead = 0;
  let behind = 0;
  let base: string | null = null;

  if (remoteOid === null) {
    relation = 'new';
    ahead = await countIn(deps, [localCommit]);
  } else if (remoteOid === localOid) {
    relation = 'up-to-date';
  } else if (!(await haveObject(deps, remoteOid))) {
    // The remote holds a commit this repository has never seen. Ancestry is genuinely unknowable
    // without fetching, and this pack never fetches — so it says so.
    relation = 'unknown';
  } else {
    const remoteCommit = (await resolveRev(deps, `${remoteOid}^{commit}`)) ?? remoteOid;
    base = remoteCommit;
    const counts = await runLocalGit(deps, ['rev-list', '--left-right', '--count', `${remoteCommit}...${localCommit}`]);
    const [b, a] = counts.stdout.trim().split(/\s+/).map((x) => Number.parseInt(x, 10) || 0);
    behind = b ?? 0;
    ahead = a ?? 0;
    if (await isAncestor(deps, remoteCommit, localCommit)) relation = 'fast-forward';
    else if (await isAncestor(deps, localCommit, remoteCommit)) relation = 'behind';
    else relation = 'diverged';
  }

  const { commits, omitted } = await commitsIn(deps, base !== null ? `${base}..${localCommit}` : localCommit);
  const paths = await changedPaths(deps, base, localCommit);
  const dirty = await dirtyCount(deps);

  return {
    id: sha256(`${req.remoteName}\n${req.refName}\n${String(remoteOid)}\n${localOid}\n${String(nowMs)}`).slice(0, 12),
    remoteName: req.remoteName,
    host: req.host,
    slug: req.slug,
    refName: req.refName,
    remoteOid,
    localOid,
    localRef: req.localRev,
    relation,
    ahead,
    behind,
    commits,
    commitsOmitted: omitted,
    changedPaths: paths.paths,
    changedPathsOmitted: paths.omitted,
    touchesWorkflows: touchesWorkflowFiles(paths.paths),
    dirtyCount: dirty,
    observedAtMs: nowMs,
  };
}

/** First non-empty line of a captured stream, for a one-sentence failure message. */
export function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

const FLAGS: Record<string, PushFlag> = {
  ' ': 'fast-forward',
  '+': 'forced',
  '-': 'deleted',
  '*': 'new',
  '!': 'rejected',
  '=': 'up-to-date',
};

/**
 * Parse `git push --porcelain` output.
 *
 * Format (git-push(1)): `<flag>\t<from>:<to>\t<summary> (<reason>)`, preceded by a `To <repo>`
 * line and terminated by `Done`. The absence of `Done` means the output was cut short, which is
 * reported rather than treated as success.
 */
export function parsePushPorcelain(stdout: string): PushPorcelain {
  const lines: PushPorcelainLine[] = [];
  let done = false;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === 'Done') {
      done = true;
      continue;
    }
    if (line === '' || line.startsWith('To ')) continue;
    // Split on the tabs FIRST. Slicing the flag off and then splitting leaves the leading tab in
    // place, so the refspec lands in element 1 while element 0 is empty — which parsed every line
    // as unrecognisable and made the dry-run comparison see zero refs on every push.
    const parts = line.split('\t');
    const flag = FLAGS[parts[0] ?? ''];
    if (flag === undefined || parts.length < 2) continue;
    const refs = parts[1] ?? '';
    const summaryRaw = parts.slice(2).join('\t');
    const colon = refs.indexOf(':');
    if (colon === -1) continue;
    const reasonMatch = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(summaryRaw);
    lines.push({
      flag,
      from: refs.slice(0, colon),
      to: refs.slice(colon + 1),
      summary: (reasonMatch?.[1] ?? summaryRaw).trim(),
      ...(reasonMatch?.[2] !== undefined ? { reason: reasonMatch[2].trim() } : {}),
    });
  }
  return { lines, done };
}

/** The porcelain flags a push may legitimately produce for each observed relation. */
export function expectedPushFlags(relation: RefRelation, force: boolean): PushFlag[] {
  if (force) return ['forced', 'new', 'fast-forward', 'up-to-date'];
  switch (relation) {
    case 'new':
      return ['new'];
    case 'fast-forward':
      return ['fast-forward'];
    case 'up-to-date':
      return ['up-to-date'];
    default:
      // `behind`, `diverged` and `unknown` have no non-forced push that can succeed; the tool
      // refuses before reaching git, and this list exists so a surprise is caught rather than
      // accepted.
      return [];
  }
}

/** One human line describing what a push of this observation would do. */
export function describeRelation(o: RemoteObservation): string {
  const target = `${o.remoteName}:${o.refName}`;
  switch (o.relation) {
    case 'new':
      return `CREATE ${target} at ${o.localOid.slice(0, 12)} (${String(o.ahead)} commit(s) in the branch)`;
    case 'fast-forward':
      return `FAST-FORWARD ${target} ${o.remoteOid?.slice(0, 12) ?? '?'} -> ${o.localOid.slice(0, 12)} (+${String(o.ahead)} commit(s))`;
    case 'up-to-date':
      return `${target} already holds ${o.localOid.slice(0, 12)} — nothing would change`;
    case 'behind':
      return `${target} is AHEAD of the local ref by ${String(o.behind)} commit(s); a normal push cannot succeed`;
    case 'diverged':
      return `${target} has DIVERGED: ${String(o.ahead)} local commit(s) it lacks, ${String(o.behind)} remote commit(s) not present locally`;
    default:
      return `${target} holds ${o.remoteOid?.slice(0, 12) ?? '?'}, a commit this repository has never fetched — the relationship is unknown`;
  }
}

/** `refs/heads/x` on `origin` -> a compact human target string. */
export function describeTarget(o: { host: string; slug: string | null; remoteName: string; refName: string }): string {
  const where = o.slug !== null ? `${o.host}/${o.slug}` : o.host;
  return `${where} ${o.refName} (remote '${o.remoteName}', ${shortRef(o.refName)})`;
}
