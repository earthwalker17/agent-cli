import * as fs from 'node:fs';
import * as path from 'node:path';
import { runManaged } from '../exec/run.js';
import { buildChildEnv } from '../exec/env.js';
import { scrubSecrets } from '../shared/secrets.js';
import { GH_AUTH_STATUS_FIXED_VERSION, REMOTE_CALL_TIMEOUT_MS, type GhFacts, type GhInvocation, type GhResult, type GhRunner } from './types.js';

/**
 * The managed `gh` client — a deliberate mirror of `git/client.ts`, and for the same reasons.
 *
 * Hardening contract:
 * - `gh` is resolved to an ABSOLUTE path by scanning PATH directories directly (never a spawn of a
 *   bare name): on Windows `CreateProcess` resolves bare names against the child cwd first, so a
 *   `gh.exe` planted in a workspace must never be the binary we execute. Relative PATH entries are
 *   skipped for the same reason, and only `gh.exe` is accepted on Windows — `.cmd`/`.bat` shims
 *   cannot be spawned without a shell and are a code-injection surface.
 * - `GH_REPO` is SCRUBBED from the child environment. It retargets every gh command at a different
 *   repository, which is precisely the `GIT_DIR` hazard one layer up: a stale exported variable
 *   must not be able to redirect a publish. Every call additionally passes `--repo=OWNER/NAME`
 *   explicitly, so the target is stated twice and inherited state can never supply it.
 * - `GH_DEBUG`/`DEBUG` are scrubbed: gh's debug mode prints request and response HEADERS, which is
 *   the Authorization header, which is the credential.
 * - `GH_PROMPT_DISABLED=1`, no stdin (`runManaged`), and a bounded timeout: gh can never block on a
 *   prompt, and a cold network degrades honestly rather than hanging a turn.
 * - `GH_HOST` and `GH_CONFIG_DIR` deliberately PASS THROUGH — an enterprise host or a relocated
 *   config is legitimate configuration, and removing it would break the user's actual setup. They
 *   are recorded in `remote.context` instead, so an override is auditable rather than invisible.
 * - stdout and stderr are scrubbed of credential shapes before they leave this module. gh below
 *   2.97.0 could print part of the token from `gh auth status` (GHSA-cg6r-mpgc-h9mm), and remote
 *   URLs echoed in error text can embed one.
 *
 * The harness never reads a token. Authentication is entirely gh's stored credential; because
 * `buildChildEnv` drops every `*token*` name, a `GH_TOKEN` in the user's shell is not forwarded and
 * cannot be forwarded — which is recorded as a fact rather than worked around.
 */

/** Inherited env that retargets gh, or makes it print secrets. Always scrubbed. */
const SCRUBBED_GH_ENV: readonly string[] = [
  'GH_REPO',
  'GH_DEBUG',
  'DEBUG',
  'GH_FORCE_TTY',
  'GH_PAGER',
  'PAGER',
  'GH_BROWSER',
  'BROWSER',
  'GH_EDITOR',
  'GIT_EDITOR',
  'VISUAL',
  'EDITOR',
];

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Find gh by scanning PATH directories (stat only — nothing is spawned to resolve it).
 * Pure over its inputs so tests can inject a synthetic PATH. Returns an absolute path or null.
 */
export function findGhOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const isWin = platform === 'win32';
  const raw = env['PATH'] ?? env['Path'] ?? '';
  for (let entry of raw.split(path.delimiter)) {
    entry = entry.trim().replace(/^"|"$/g, '');
    if (entry.length === 0) continue;
    if (!path.isAbsolute(entry)) continue; // a relative PATH entry resolves against cwd — never trust it
    const candidate = path.join(entry, isWin ? 'gh.exe' : 'gh');
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

let cachedGhPath: string | null | undefined;

/** Process-wide cached gh resolution (the PATH does not change mid-session). */
export function resolveGhPath(): string | null {
  if (cachedGhPath === undefined) cachedGhPath = findGhOnPath();
  return cachedGhPath;
}

/** Reset the memoized resolution. Tests only. */
export function resetGhPathCache(): void {
  cachedGhPath = undefined;
}

/** Build the hardened child environment for a gh invocation. Exported for tests. */
export function buildGhEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = buildChildEnv(parent);
  const scrub = new Set(SCRUBBED_GH_ENV.map((n) => n.toLowerCase()));
  for (const name of Object.keys(env)) {
    if (scrub.has(name.toLowerCase())) delete env[name];
  }
  env['GH_PROMPT_DISABLED'] = '1';
  env['GH_NO_UPDATE_NOTIFIER'] = '1';
  env['GH_NO_EXTENSION_UPDATE_NOTIFIER'] = '1';
  env['GH_SPINNER_DISABLED'] = '1';
  // Presence alone disables colour (no-color.org); a value is set anyway so the intent is readable.
  env['NO_COLOR'] = '1';
  env['CLICOLOR'] = '0';
  // An empty pager disables paging. gh does not page a non-TTY anyway; this is the second lock.
  env['GH_PAGER'] = '';
  // Publishing on someone's behalf should not also phone home on their behalf.
  env['DO_NOT_TRACK'] = '1';
  return env;
}

/**
 * Build the one `GhRunner` a session uses. The runner is the seam every tool depends on, so a test
 * injects a scripted one and never touches a socket (the research pack's `fetchImpl` precedent).
 */
export function createGhRunner(ghPath: string): GhRunner {
  return async (inv: GhInvocation): Promise<GhResult> => {
    const outcome = await runManaged({
      file: ghPath,
      args: [...inv.argv],
      cwd: inv.cwd,
      env: buildGhEnv(),
      timeoutMs: inv.timeoutMs ?? REMOTE_CALL_TIMEOUT_MS,
      ...(inv.signal ? { signal: inv.signal } : {}),
    });
    return {
      ok: outcome.termination === 'exited' && outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      termination: outcome.termination,
      stdout: scrubSecrets(outcome.stdout),
      stderr: scrubSecrets(outcome.stderr),
      durationMs: outcome.durationMs,
    };
  };
}

/** `gh version 2.96.0 (2026-07-02)` -> `2.96.0`. Null when the banner is not the documented shape. */
export function parseGhVersion(stdout: string): string | null {
  const m = /^gh version (\d+\.\d+\.\d+)/m.exec(stdout.trim());
  return m?.[1] ?? null;
}

/** Numeric dotted-version compare. Returns <0, 0, >0. Non-numeric components sort as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Probe what is knowable about gh WITHOUT contacting anything: is it installed, which version, and
 * which environment overrides are in force.
 *
 * Deliberately network-free. `gh auth status` would answer "who am I", but it validates the token
 * against the API — that is a remote read, and a remote read needs authority this probe does not
 * have. Session start therefore learns that a credential store exists, never who is in it.
 */
export async function probeGhFacts(opts: { runner?: GhRunner; ghPath?: string | null; cwd: string; env?: NodeJS.ProcessEnv } ): Promise<GhFacts> {
  const env = opts.env ?? process.env;
  const ghPath = opts.ghPath !== undefined ? opts.ghPath : findGhOnPath(env);
  const hostOverride = (env['GH_HOST'] ?? '').trim();
  const configDirOverride = (env['GH_CONFIG_DIR'] ?? '').trim();
  const tokenEnvPresent = ((env['GH_TOKEN'] ?? '').trim() !== '' || (env['GITHUB_TOKEN'] ?? '').trim() !== '');
  const base: GhFacts = {
    ghPath,
    version: null,
    authStatusLeakRisk: false,
    ...(hostOverride !== '' ? { hostOverride } : {}),
    ...(configDirOverride !== '' ? { configDirOverride } : {}),
    tokenEnvPresentButNotForwarded: tokenEnvPresent,
    probeFailed: false,
    detail: 'gh not found',
  };
  if (ghPath === null) return base;

  const runner = opts.runner ?? createGhRunner(ghPath);
  let result: GhResult;
  try {
    result = await runner({ argv: ['--version'], cwd: opts.cwd, timeoutMs: PROBE_TIMEOUT_MS });
  } catch (e) {
    return { ...base, probeFailed: true, detail: `gh probe failed: ${(e as Error).message}` };
  }
  if (!result.ok) {
    return { ...base, probeFailed: true, detail: `gh probe failed (exit ${String(result.exitCode)})` };
  }
  const version = parseGhVersion(result.stdout);
  const leak = version !== null && compareVersions(version, GH_AUTH_STATUS_FIXED_VERSION) < 0;
  const bits = [version !== null ? `gh ${version}` : 'gh (version unparsed)'];
  if (leak) bits.push(`below ${GH_AUTH_STATUS_FIXED_VERSION} — 'gh auth status' can print part of your token (GHSA-cg6r-mpgc-h9mm)`);
  if (hostOverride !== '') bits.push(`GH_HOST=${hostOverride}`);
  if (configDirOverride !== '') bits.push('GH_CONFIG_DIR override in force');
  if (tokenEnvPresent) bits.push('GH_TOKEN/GITHUB_TOKEN is set but is NOT forwarded to child processes');
  return { ...base, version, authStatusLeakRisk: leak, detail: bits.join('; ') };
}
