import type { CommandTermination } from '../types.js';

/**
 * Contracts for the git capability layer. This is a HARNESS capability (user-commanded flows,
 * session context, evidence) — it is never registered as a model tool. Everything is scoped to
 * an explicit repo/workspace path so a future worktree or subagent can instantiate its own view.
 */

/** Outcome of one managed git invocation (see client.ts for the hardening applied). */
export interface GitResult {
  /** True iff the process genuinely exited with code 0 (a killed git is never ok). */
  ok: boolean;
  exitCode: number | null;
  termination: CommandTermination;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** One entry of `git status --porcelain=v2 -z` output. Paths are repo-relative POSIX. */
export interface GitStatusEntry {
  kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';
  path: string;
  /** Rename/copy source path (kind 'renamed' only). */
  origPath?: string;
  /** Staged (x) and unstaged (y) state codes; '.' means unmodified on that side. */
  x: string;
  y: string;
}

/** Parsed `git status --porcelain=v2 -b -z` (headers + entries). */
export interface GitStatusSummary {
  /** HEAD commit oid, or null on an unborn branch (porcelain reports `(initial)`). */
  branchOid: string | null;
  /** Branch name; null when detached (porcelain reports `(detached)`). */
  branchHead: string | null;
  detached: boolean;
  upstream: string | null;
  /** Commits ahead/behind upstream; null when there is no upstream. */
  ahead: number | null;
  behind: number | null;
  entries: GitStatusEntry[];
}

/**
 * The probed git context for a workspace. Honest degrade: `gitVersion === null` means git was
 * not found; `isRepo === false` with a version means the workspace is not inside a repository;
 * `probeFailed` marks a probe that errored or timed out (fields then stay null, never guessed).
 */
export interface GitFacts {
  isRepo: boolean;
  gitPath: string | null;
  gitVersion: string | null;
  repoRoot: string | null;
  /** False when the workspace is a subdirectory of the repository. */
  workspaceIsRepoRoot: boolean;
  branch: string | null;
  detached: boolean;
  /** True for a repository whose current branch has no commits yet. */
  unborn: boolean;
  /** Short (12-char) HEAD oid, or null when unborn/unknown. */
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Working-tree entries that differ from HEAD (changed+renamed+unmerged+untracked); null if unknown. */
  dirtyCount: number | null;
  untrackedCount: number | null;
  probeFailed: boolean;
  /** One-line honest summary ("branch main @ ab12cd34, 3 dirty" / "git not found" / …). */
  detail: string;
}
