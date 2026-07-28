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

/** Create a detached worktree of `commitOid` at `dir` (parent dirs created). `pinArgs` are
 *  `-c` config overrides prepended to the invocation (the S14.5 EOL pin — see probeEolPin). */
export async function addWorktree(gitPath: string, repoRoot: string, dir: string, commitOid: string, pinArgs: readonly string[] = []): Promise<WorktreeAddResult> {
  fs.mkdirSync(dir, { recursive: true });
  const r = await runGit({ gitPath, argv: [...pinArgs, 'worktree', 'add', '--detach', dir, commitOid], cwd: repoRoot, timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, error: firstLine(r.stderr) || `git worktree add failed (exit ${r.exitCode})` };
  return { ok: true };
}

export interface EolPinProbe {
  /** `-c` args to prepend to every worktree-materializing git call; empty = no pin. */
  pinArgs: string[];
  /** Honest one-line description when the pin is active ('' otherwise). */
  detail: string;
}

/**
 * The checkout-normalization pin probe (S14.5 — the top live-found S14 gap). With system
 * `core.autocrlf=true` over an LF working tree, `worktree add` and capture's `checkout-index`
 * re-apply the smudge filter and materialize CRLF while the parent's on-disk bytes are LF: the
 * parent genuinely does not hold the bytes the executor based its edits on, so EVERY captured
 * file refuses at apply as base drift — and had the base matched, the apply would have written
 * CRLF over LF, attributing a whole-file EOL flip to the task.
 *
 * The pin: when the effective config would convert (`core.autocrlf=true`) AND the parent's
 * tracked files under the workspace are uniformly LF in the worktree (`git ls-files --eol`,
 * the `w/` column), executor state is materialized with `-c core.autocrlf=false -c
 * core.eol=lf` so worktree bytes equal parent bytes. Deliberately the uniform-LF case ONLY:
 * mixed or CRLF parents keep today's behavior plus the apply-side diagnosis (the honest
 * fallback), and `.gitattributes`-governed paths are unaffected either way (attributes
 * outrank core.* in both trees, so base and after stay self-consistent). A failed probe
 * yields no pin — never a refusal.
 */
export async function probeEolPin(gitPath: string, repoRoot: string, wsRel: string): Promise<EolPinProbe> {
  const none: EolPinProbe = { pinArgs: [], detail: '' };
  const conf = await runGit({ gitPath, argv: ['config', '--get', 'core.autocrlf'], cwd: repoRoot, timeoutMs: 15_000 });
  if (!conf.ok || conf.stdout.trim().toLowerCase() !== 'true') return none; // 'input'/'false'/unset never smudge LF at checkout
  const ls = await runGit({
    gitPath,
    argv: ['ls-files', '--eol', '-z', '--', wsRel.length > 0 ? wsRel : '.'],
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
  if (!ls.ok) return none;
  let lf = 0;
  let other = 0;
  for (const rec of ls.stdout.split('\0')) {
    if (rec.length === 0) continue;
    const info = rec.split('\t')[0] ?? '';
    const m = /w\/(\S+)/.exec(info);
    if (m === null) continue;
    if (m[1] === 'lf') lf++;
    else if (m[1] === 'crlf' || m[1] === 'mixed') other++;
    // 'none' (no EOLs) and '-text' (binary) constrain nothing.
  }
  if (lf === 0 || other > 0) return none;
  return {
    pinArgs: ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'],
    detail: `EOL pin active: the parent working tree is uniformly LF under core.autocrlf=true, so executor worktrees and capture staging are materialized with -c core.autocrlf=false -c core.eol=lf (worktree bytes = parent bytes)`,
  };
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
