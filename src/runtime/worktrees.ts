import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isInside } from '../shared/pathutil.js';
import { removeWorktree } from '../git/worktree.js';

/**
 * Task-worktree placement and lifecycle bookkeeping (V0.7).
 *
 * PLACEMENT IS POLICY-DICTATED: validatePath denies writes inside the state dir and any path
 * carrying a `.agent-cli` segment, and the workspace must not contain derived checkouts — so
 * worktrees live under the OS temp dir: `<tmp>/agent-cli-worktrees/<projectSlug>/<childId>`.
 * Ephemeral by design; the captured diff (blobs + task.changes events) is the durable record.
 *
 * The registry (`<projectDir>/worktrees.json`) exists for exactly one reason: a crash between
 * `worktree add` and the removal `finally` must leave a trail the next session can sweep. The
 * sweep is REGISTRY-DRIVEN and refuses to touch any path outside the worktrees root it derives
 * — it can never remove something it did not create.
 */

export interface WorktreeRegistryEntry {
  dir: string;
  repoRoot: string;
  childSessionId: string;
  createdAt: string;
}

/** The per-project worktree home under the OS temp dir. */
export function worktreesRoot(projectDir: string): string {
  return path.join(os.tmpdir(), 'agent-cli-worktrees', path.basename(projectDir));
}

/** A fresh worktree dir for a child (random tail: child ids are unique, but never assume). */
export function newWorktreeDir(root: string, childSessionId: string): string {
  return path.join(root, `${childSessionId}-${randomBytes(2).toString('hex')}`);
}

export function registryFile(projectDir: string): string {
  return path.join(projectDir, 'worktrees.json');
}

export function loadRegistry(file: string): WorktreeRegistryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is WorktreeRegistryEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as WorktreeRegistryEntry).dir === 'string' &&
        typeof (e as WorktreeRegistryEntry).repoRoot === 'string' &&
        typeof (e as WorktreeRegistryEntry).childSessionId === 'string',
    );
  } catch {
    return [];
  }
}

function saveRegistry(file: string, entries: WorktreeRegistryEntry[]): void {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

export function registerWorktree(file: string, entry: WorktreeRegistryEntry): void {
  saveRegistry(file, [...loadRegistry(file), entry]);
}

export function unregisterWorktree(file: string, dir: string): void {
  saveRegistry(file, loadRegistry(file).filter((e) => e.dir !== dir));
}

export interface SweepResult {
  removed: string[];
  failed: { dir: string; detail: string }[];
}

/**
 * Remove crash-orphaned task worktrees recorded in the registry. Path-guarded: entries outside
 * this project's worktrees root are dropped from the registry but NEVER touched on disk.
 */
export async function sweepOrphanedWorktrees(projectDir: string, gitPath: string): Promise<SweepResult> {
  const file = registryFile(projectDir);
  const entries = loadRegistry(file);
  if (entries.length === 0) return { removed: [], failed: [] };
  const root = worktreesRoot(projectDir);
  const removed: string[] = [];
  const failed: { dir: string; detail: string }[] = [];
  const keep: WorktreeRegistryEntry[] = [];
  for (const e of entries) {
    if (!isInside(root, e.dir)) continue; // not ours to touch; drop the entry
    if (!fs.existsSync(e.dir)) continue; // already gone; drop the entry
    const r = await removeWorktree(gitPath, e.repoRoot, e.dir);
    if (r.ok) removed.push(e.dir);
    else {
      failed.push({ dir: e.dir, detail: r.detail ?? 'removal failed' });
      keep.push(e); // stays registered so a later sweep retries
    }
  }
  saveRegistry(file, keep);
  return { removed, failed };
}
