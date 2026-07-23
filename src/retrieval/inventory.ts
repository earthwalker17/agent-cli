import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../shared/hash.js';
import { runGit } from '../git/client.js';
import { parsePorcelainV2 } from '../git/porcelain.js';
import type { GitFacts } from '../git/types.js';

/**
 * Repository inventory (Session 10): the authoritative file listing behind both the workspace
 * map and the retrieval index. Pure data — no ranking, no rendering. The git listing logic
 * lived in workspace/map.ts through V0.7.1 and moved here so the map and the index share one
 * source of truth; `buildWorkspaceMapAuto` keeps byte-identical behavior through `listGitFiles`.
 */

/** Directories never listed, even when git would include them (defense in depth vs odd repos). */
export const BUILTIN_EXCLUDE_DIRS = new Set(['node_modules', '.git', '.agent-cli', 'dist', 'coverage']);

export function hasExcludedSegment(rel: string): boolean {
  return rel.split('/').some((seg) => BUILTIN_EXCLUDE_DIRS.has(seg));
}

/** Inventory caps: stat cost and index size must stay bounded on very large repos. */
export const MAX_INVENTORY_FILES = 20_000;
const MAX_DIRTY_PATHS = 200;
const STATUS_TIMEOUT_MS = 10_000;

export interface InventoryFile {
  /** Workspace-relative POSIX path. */
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface Inventory {
  /** Sorted by relPath. */
  files: InventoryFile[];
  /**
   * Workspace-relative paths with uncommitted changes (changed/renamed/unmerged/untracked),
   * sorted, capped at MAX_DIRTY_PATHS. Empty when the status probe failed — never guessed.
   */
  dirtyPaths: string[];
  /**
   * sha256 over the sorted relPaths joined by '\n' — a digest of the file SET, independent of
   * any rendering. This is what CODEBASE.md staleness compares (render-format changes must not
   * flap staleness; the map's own sha256 stays "exactly the text the model saw").
   */
  inventorySha256: string;
  /** True when MAX_INVENTORY_FILES cut the listing. */
  capped: boolean;
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

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Uncommitted paths from `git status --porcelain=v2 -z`. Porcelain paths are REPO-relative
 * regardless of cwd, so a subdirectory workspace filters by its prefix and re-relativizes.
 * A failed probe yields [] — dirtiness is a ranking signal, never worth blocking a session.
 */
async function listDirtyPaths(root: string, git: GitFacts): Promise<string[]> {
  if (git.gitPath === null) return [];
  // --untracked-files=all: without it, a fully-untracked directory collapses to one `dir/`
  // entry — useless as a per-file ranking signal (git/commit.ts uses the same flag).
  const res = await runGit({ gitPath: git.gitPath, argv: ['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd: root, timeoutMs: STATUS_TIMEOUT_MS });
  if (!res.ok) return [];
  const entries = parsePorcelainV2(res.stdout).entries.filter((e) => e.kind !== 'ignored');
  let prefix = '';
  if (!git.workspaceIsRepoRoot && git.repoRoot !== null) {
    const rel = toPosix(path.relative(git.repoRoot, root));
    if (rel.length > 0) prefix = rel + '/';
  }
  const out = new Set<string>();
  for (const e of entries) {
    let p = e.path;
    if (prefix.length > 0) {
      if (!p.startsWith(prefix)) continue;
      p = p.slice(prefix.length);
    }
    if (p.length > 0 && !hasExcludedSegment(p)) out.add(p);
  }
  return [...out].sort().slice(0, MAX_DIRTY_PATHS);
}

/**
 * Build the inventory for a TRUSTED git-backed workspace. Returns null when git cannot list
 * (caller falls back to the flat map — the pre-Session-10 behavior is always reachable).
 * Stats are read per file; a file that vanishes mid-walk is simply skipped (the inventory is
 * a snapshot, not a lock).
 */
export async function buildInventory(root: string, git: GitFacts): Promise<Inventory | null> {
  const listed = await listGitFiles(root, git);
  if (listed === null) return null;
  const sorted = [...listed].sort();
  const capped = sorted.length > MAX_INVENTORY_FILES;
  const kept = capped ? sorted.slice(0, MAX_INVENTORY_FILES) : sorted;

  const files: InventoryFile[] = [];
  for (const relPath of kept) {
    try {
      const st = fs.statSync(path.join(root, relPath));
      if (!st.isFile()) continue;
      files.push({ relPath, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished mid-walk */
    }
  }
  const dirtyPaths = await listDirtyPaths(root, git);
  return {
    files,
    dirtyPaths,
    inventorySha256: sha256(files.map((f) => f.relPath).join('\n')),
    capped,
  };
}
