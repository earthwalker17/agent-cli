import * as fs from 'node:fs';
import * as path from 'node:path';
import { runManaged } from '../exec/run.js';
import { buildChildEnv } from '../exec/env.js';
import type { GitResult } from './types.js';

/**
 * The managed git client — every harness-initiated git invocation goes through `runGit`.
 *
 * Hardening contract (ARCHITECTURE "GitOps"):
 * - git is resolved to an ABSOLUTE path by scanning PATH directories directly (never a spawn
 *   of a bare name): Windows CreateProcess resolves bare names against the child cwd first, so
 *   a `git.exe` planted in a workspace must never be the binary we execute. Relative PATH
 *   entries are skipped for the same reason. On Windows only `git.exe` is accepted — `.cmd`/
 *   `.bat` shims cannot be spawned without a shell and are a code-injection surface.
 * - `-c core.fsmonitor=false` on every call: a repo's own config must not start a filesystem
 *   monitor daemon (the classic malicious-repo code-execution vector for status/diff).
 * - `GIT_OPTIONAL_LOCKS=0`: a read-only probe must not opportunistically rewrite the user's
 *   index (plain `git status` otherwise does) or race user-run git commands.
 * - `GIT_TERMINAL_PROMPT=0` and no stdin (runManaged): git can never interactively prompt.
 * - Repo-targeting env inherited from the parent shell is scrubbed (GIT_DIR & friends) so a
 *   stale exported variable cannot silently point our invocation at a different repository.
 *   Config-selection vars (GIT_CONFIG_GLOBAL/SYSTEM) pass through: identity and user config
 *   should behave exactly as they would for the user's own git.
 * - Bounded timeout: a probe on a huge or cold repo degrades honestly, it never hangs a session.
 */

/** Inherited env vars that re-target git at a different repo/index/objects; always scrubbed. */
const SCRUBBED_GIT_ENV: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
];

const DEFAULT_GIT_TIMEOUT_MS = 15_000;

/**
 * Find git by scanning PATH directories (stat only — nothing is spawned to resolve it).
 * Pure over its inputs so tests can inject a synthetic PATH. Returns an absolute path or null.
 */
export function findGitOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const isWin = platform === 'win32';
  const raw = env['PATH'] ?? env['Path'] ?? '';
  for (let entry of raw.split(path.delimiter)) {
    entry = entry.trim().replace(/^"|"$/g, '');
    if (entry.length === 0) continue;
    if (!path.isAbsolute(entry)) continue; // a relative PATH entry resolves against cwd — never trust it
    const candidate = path.join(entry, isWin ? 'git.exe' : 'git');
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

let cachedGitPath: string | null | undefined;

/** Process-wide cached git resolution (the PATH does not change mid-session). */
export function resolveGitPath(): string | null {
  if (cachedGitPath === undefined) cachedGitPath = findGitOnPath();
  return cachedGitPath;
}

/** Test seam: reset the process-wide cache. */
export function resetGitPathCacheForTests(): void {
  cachedGitPath = undefined;
}

export interface GitInvocation {
  /** Absolute path to the git binary (from resolveGitPath / findGitOnPath). */
  gitPath: string;
  /** Arguments AFTER the hardening flags; use `--` before every pathspec. */
  argv: readonly string[];
  cwd: string;
  timeoutMs?: number;
  /** Extra child-env overrides (GIT_INDEX_FILE for checkpoints, explicit identity, …). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** Build the hardened child environment for a git invocation. Exported for tests. */
export function buildGitEnv(extra?: Record<string, string>): Record<string, string> {
  const env = buildChildEnv(process.env);
  const scrub = new Set(SCRUBBED_GIT_ENV.map((n) => n.toLowerCase()));
  for (const name of Object.keys(env)) {
    if (scrub.has(name.toLowerCase())) delete env[name];
  }
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  return { ...env, ...extra };
}

/** The config flags prepended to every invocation. Exported for tests. */
export function gitHardeningArgs(platform: NodeJS.Platform = process.platform): string[] {
  const args = ['-c', 'core.fsmonitor=false'];
  // >260-char worktree paths otherwise fail on Windows; affects only git's own path handling.
  if (platform === 'win32') args.push('-c', 'core.longpaths=true');
  return args;
}

/** Run one hardened git invocation through the managed exec substrate. */
export async function runGit(inv: GitInvocation): Promise<GitResult> {
  const outcome = await runManaged({
    file: inv.gitPath,
    args: [...gitHardeningArgs(), ...inv.argv],
    cwd: inv.cwd,
    env: buildGitEnv(inv.env),
    timeoutMs: inv.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    ...(inv.signal ? { signal: inv.signal } : {}),
  });
  return {
    ok: outcome.termination === 'exited' && outcome.exitCode === 0,
    exitCode: outcome.exitCode,
    termination: outcome.termination,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    durationMs: outcome.durationMs,
  };
}
