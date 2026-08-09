import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { sha256 } from '../shared/hash.js';
import { BUILTIN_EXCLUDE_DIRS, listGitFiles } from '../git/ls.js';
import type { GitFacts } from '../git/types.js';

export interface WorkspaceMap {
  /** The exact text shown to the model (also hashed for evidence). */
  text: string;
  fileCount: number;
  truncated: boolean;
  /** sha256 of `text` — evidence of exactly what the model saw. NEVER an inventory digest. */
  sha256: string;
  /**
   * Session 10 (additive, ranked maps only): digest of the sorted file SET, independent of
   * rendering — the basis for CODEBASE.md staleness, which must not flap on format changes.
   */
  inventorySha256?: string;
  /** Session 10 (additive): files with extracted symbols, and the index build state. */
  indexedFiles?: number;
  indexState?: 'full' | 'partial';
}

const DEFAULT_BUDGET = 8000;
const MAX_FILES = 4000;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * A bounded, gitignore-aware map of the workspace: a sorted list of relative file paths. This
 * flat form remains the fallback everywhere the ranked map (Session 10, `buildRankedMap` in
 * retrieval/ranked-map.ts) does not apply: pre-trust `agent map`, non-repo workspaces, executor
 * worktrees, and any index failure. The returned text is what feeds the model, and its sha256
 * is recorded so the report can prove exactly what the model saw. Only the root .gitignore is
 * honored by this walker (git-backed listing honors nested ones natively).
 */
export function buildWorkspaceMap(root: string, opts: { budget?: number } = {}): WorkspaceMap {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const ig = ignore();
  try {
    ig.add(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    /* no .gitignore */
  }

  const files: string[] = [];
  let capped = false;
  const walk = (dir: string): void => {
    if (capped) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (capped) return;
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(root, abs));
      if (e.isDirectory()) {
        if (BUILTIN_EXCLUDE_DIRS.has(e.name)) continue;
        if (ig.ignores(rel + '/')) continue;
        walk(abs);
      } else {
        if (ig.ignores(rel)) continue;
        files.push(rel);
        if (files.length >= MAX_FILES) capped = true;
      }
    }
  };
  walk(root);
  files.sort();

  let text = files.join('\n');
  let truncated = capped;
  if (text.length > budget) {
    text = text.slice(0, budget) + '\n… (workspace map truncated to fit the budget)';
    truncated = true;
  } else if (capped) {
    text += `\n… (listing capped at ${MAX_FILES} files)`;
  }

  return { text, fileCount: files.length, truncated, sha256: sha256(text) };
}

/** Shared tail: sort, cap, budget-slice, hash — identical shape for both builders. */
function finalizeMap(files: string[], budget: number): WorkspaceMap {
  let capped = false;
  if (files.length > MAX_FILES) {
    files.length = MAX_FILES;
    capped = true;
  }
  files.sort();
  let text = files.join('\n');
  let truncated = capped;
  if (text.length > budget) {
    text = text.slice(0, budget) + '\n… (workspace map truncated to fit the budget)';
    truncated = true;
  } else if (capped) {
    text += `\n… (listing capped at ${MAX_FILES} files)`;
  }
  return { text, fileCount: files.length, truncated, sha256: sha256(text) };
}

/**
 * Map builder for a TRUSTED workspace (V0.5): inside a git repository, list files via
 * `git ls-files --cached --others --exclude-standard` (through retrieval/inventory.ts since
 * Session 10) — nested .gitignore files are honored natively, and the index is faster than a
 * directory walk on large repos. ANY git failure falls back to the walker. The pre-trust
 * `agent map` command deliberately keeps using the pure walker: running git against an
 * untrusted repo's .git is an attack surface the read-only exception must not take on.
 */
export async function buildWorkspaceMapAuto(root: string, opts: { budget?: number } = {}, git?: GitFacts): Promise<WorkspaceMap> {
  if (git !== undefined && git.isRepo && git.gitPath !== null && !git.probeFailed) {
    const files = await listGitFiles(root, git);
    if (files !== null) return finalizeMap(files, opts.budget ?? DEFAULT_BUDGET);
  }
  return buildWorkspaceMap(root, opts);
}
