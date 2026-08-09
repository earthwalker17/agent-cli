import { runGit } from './client.js';
import type { GitFacts } from './types.js';

/**
 * The git-backed workspace FILE LISTING — moved here from retrieval/inventory.ts (S20.5).
 *
 * Both the flat workspace map and the retrieval inventory consume it, and having it live in
 * retrieval/ while retrieval's ranked map consumed workspace/map's fallback was a genuine module
 * cycle. A git listing is a git capability: both consumers already depend on git/, and the
 * dependency now points one way (workspace → git ← retrieval).
 */

/** Directories never listed, even when git would include them (defense in depth vs odd repos). */
// Session 18 adds `target` (cargo output) and `__pycache__`; `vendor` stays VISIBLE — vendored
// dependencies are real source and the map's recall backstop must not hide that they exist
// (ranking already penalizes the segment).
export const BUILTIN_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.agent-cli', 'dist', 'coverage', 'target', '__pycache__']);

export function hasExcludedSegment(rel: string): boolean {
  return rel.split('/').some((seg) => BUILTIN_EXCLUDE_DIRS.has(seg));
}

/**
 * The exact V0.5 git listing used by the workspace map: `ls-files --cached --others
 * --exclude-standard` (nested .gitignore honored natively) minus tracked-but-deleted files,
 * builtin exclude segments dropped, deduped. Returns null on ANY git failure — the caller
 * falls back to the pure walker. Paths are cwd-relative (= workspace-relative).
 */
export async function listGitFiles(root: string, git: GitFacts): Promise<string[] | null> {
  if (!git.isRepo || git.gitPath === null || git.probeFailed) return null;
  const listed = await runGit({ gitPath: git.gitPath, argv: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd: root });
  if (!listed.ok) return null;
  const deleted = await runGit({ gitPath: git.gitPath, argv: ['ls-files', '-z', '--deleted'], cwd: root });
  const gone = new Set(deleted.ok ? deleted.stdout.split('\0').filter((p) => p.length > 0) : []);
  return [...new Set(listed.stdout.split('\0').filter((p) => p.length > 0 && !gone.has(p) && !hasExcludedSegment(p)))];
}
