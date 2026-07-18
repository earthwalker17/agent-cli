import * as path from 'node:path';
import { caseFold } from '../shared/pathutil.js';
import { resolveGitPath, runGit } from './client.js';
import { parsePorcelainV2 } from './porcelain.js';
import type { GitFacts } from './types.js';

/**
 * detectGitFacts — the session-start git probe. Read-only (GIT_OPTIONAL_LOCKS=0 keeps even
 * `status` from touching the user's index), bounded, and honest: every failure mode degrades
 * to explicit nulls with a stated reason — a probe never guesses and never hangs a session.
 */

const PROBE_TIMEOUT_MS = 10_000;

export interface DetectOptions {
  /** Injectable for tests; `null` simulates "git not found". Defaults to resolveGitPath(). */
  gitPath?: string | null;
  timeoutMs?: number;
}

const NO_GIT: Omit<GitFacts, 'detail'> = {
  isRepo: false,
  gitPath: null,
  gitVersion: null,
  repoRoot: null,
  workspaceIsRepoRoot: false,
  branch: null,
  detached: false,
  unborn: false,
  head: null,
  upstream: null,
  ahead: null,
  behind: null,
  dirtyCount: null,
  untrackedCount: null,
  probeFailed: false,
};

export async function detectGitFacts(workspaceRoot: string, opts: DetectOptions = {}): Promise<GitFacts> {
  const gitPath = opts.gitPath !== undefined ? opts.gitPath : resolveGitPath();
  if (gitPath === null) return { ...NO_GIT, detail: 'git not found on PATH' };
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  const version = await runGit({ gitPath, argv: ['--version'], cwd: workspaceRoot, timeoutMs });
  if (!version.ok) {
    return { ...NO_GIT, gitPath, probeFailed: true, detail: `git probe failed: ${probeError(version.termination, version.stderr)}` };
  }
  const gitVersion = version.stdout.trim().replace(/^git version /, '');

  const top = await runGit({ gitPath, argv: ['rev-parse', '--show-toplevel'], cwd: workspaceRoot, timeoutMs });
  if (!top.ok) {
    if (top.termination === 'exited' && /not a git repository/i.test(top.stderr)) {
      return { ...NO_GIT, gitPath, gitVersion, detail: 'not a git repository' };
    }
    return { ...NO_GIT, gitPath, gitVersion, probeFailed: true, detail: `git probe failed: ${probeError(top.termination, top.stderr)}` };
  }
  const repoRoot = path.normalize(top.stdout.trim());
  const workspaceIsRepoRoot = caseFold(repoRoot) === caseFold(path.resolve(workspaceRoot));

  const status = await runGit({ gitPath, argv: ['status', '--porcelain=v2', '-b', '-z'], cwd: workspaceRoot, timeoutMs });
  if (!status.ok) {
    return {
      ...NO_GIT,
      isRepo: true,
      gitPath,
      gitVersion,
      repoRoot,
      workspaceIsRepoRoot,
      probeFailed: true,
      detail: `git status probe failed: ${probeError(status.termination, status.stderr)}`,
    };
  }
  const parsed = parsePorcelainV2(status.stdout);
  const dirty = parsed.entries.filter((e) => e.kind !== 'ignored');
  const untracked = dirty.filter((e) => e.kind === 'untracked');
  const facts: GitFacts = {
    isRepo: true,
    gitPath,
    gitVersion,
    repoRoot,
    workspaceIsRepoRoot,
    branch: parsed.branchHead,
    detached: parsed.detached,
    unborn: parsed.branchOid === null,
    head: parsed.branchOid === null ? null : parsed.branchOid.slice(0, 12),
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    dirtyCount: dirty.length,
    untrackedCount: untracked.length,
    probeFailed: false,
    detail: '',
  };
  facts.detail = describe(facts);
  return facts;
}

function describe(f: GitFacts): string {
  const where = f.detached ? `detached HEAD @ ${f.head}` : f.unborn ? `unborn branch ${f.branch ?? '?'} (no commits yet)` : `branch ${f.branch ?? '?'} @ ${f.head}`;
  const dirty =
    f.dirtyCount === 0
      ? 'clean'
      : `${f.dirtyCount} uncommitted (${f.untrackedCount} untracked)`;
  const scope = f.workspaceIsRepoRoot ? '' : ' (workspace is a subdirectory of the repository)';
  const ab = f.ahead !== null && f.behind !== null && (f.ahead > 0 || f.behind > 0) ? `, ${f.ahead} ahead / ${f.behind} behind ${f.upstream ?? 'upstream'}` : '';
  return `${where}, ${dirty}${ab}${scope}`;
}

function probeError(termination: string, stderr: string): string {
  if (termination === 'timeout') return 'timed out';
  const line = stderr.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line?.trim() ?? termination;
}
