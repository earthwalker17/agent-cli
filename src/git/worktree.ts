import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { runGit } from './client.js';

/**
 * git worktree plumbing for executor task isolation (V0.7). A task worktree is a DETACHED
 * checkout of a checkpoint commit at a harness-owned path outside both the workspace and the
 * state root (validatePath protects both — a worktree inside either would have every child
 * write policy-denied). Worktrees never outlive their task: the captured diff (blobs + the
 * task.changes event) is the durable record, and removal failures are honest evidence for the
 * registry-driven startup sweep — never silent leaks.
 */

/** `git worktree` is ancient (2.5), but the porcelain/lock behaviors this flow relies on are
 *  only dependable on the versions we can actually reason about. Refuse below 2.20, honestly. */
export function worktreeSupport(gitVersion: string | null): { ok: boolean; reason: string } {
  if (gitVersion === null) return { ok: false, reason: 'git version unknown (probe failed); executor tasks need a probed git' };
  const m = /(\d+)\.(\d+)/.exec(gitVersion);
  if (m === null) return { ok: false, reason: `unparseable git version '${gitVersion}'; refusing worktree use (fail closed)` };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > 2 || (major === 2 && minor >= 20)) return { ok: true, reason: '' };
  return { ok: false, reason: `git ${major}.${minor} is too old for dependable worktree operations (need >= 2.20)` };
}

export interface WorktreeAddResult {
  ok: boolean;
  error?: string;
}

/** Create a detached worktree of `commitOid` at `dir` (parent dirs created). */
export async function addWorktree(gitPath: string, repoRoot: string, dir: string, commitOid: string): Promise<WorktreeAddResult> {
  fs.mkdirSync(dir, { recursive: true });
  const r = await runGit({ gitPath, argv: ['worktree', 'add', '--detach', dir, commitOid], cwd: repoRoot, timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: firstLine(r.stderr) || `git worktree add failed (exit ${r.exitCode})` };
  return { ok: true };
}

export interface WorktreeRemoveResult {
  ok: boolean;
  detail?: string;
}

/**
 * Remove a worktree, best-effort but honest: `git worktree remove --force` with retries for
 * the Windows EBUSY class (a child-spawned process can briefly hold the directory), then an
 * rm -rf fallback + `git worktree prune` so the admin entry never dangles. A false return is
 * evidence for the sweep, not a swallowed failure.
 */
export async function removeWorktree(gitPath: string, repoRoot: string, dir: string): Promise<WorktreeRemoveResult> {
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(100 * attempt);
    const r = await runGit({ gitPath, argv: ['worktree', 'remove', '--force', dir], cwd: repoRoot, timeoutMs: 60_000 });
    if (r.ok) return { ok: true };
    lastErr = firstLine(r.stderr) || `exit ${r.exitCode}`;
    if (!fs.existsSync(dir)) break; // already gone — just prune the admin entry
  }
  // Fallback: take the directory down directly, then prune the dangling admin entry.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, detail: `git worktree remove failed (${lastErr}); rm fallback failed (${(e as Error).message})` };
  }
  const prune = await runGit({ gitPath, argv: ['worktree', 'prune'], cwd: repoRoot, timeoutMs: 30_000 });
  if (fs.existsSync(dir)) return { ok: false, detail: `directory survived removal (${lastErr})` };
  return prune.ok
    ? { ok: true, ...(lastErr ? { detail: `removed via rm fallback after: ${lastErr}` } : {}) }
    : { ok: true, detail: `removed via rm fallback; prune failed: ${firstLine(prune.stderr)}` };
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? '';
}
