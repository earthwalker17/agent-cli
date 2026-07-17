/**
 * Child-process environment hygiene. The agent's own process holds credentials (API key, proxy
 * URLs); an approved shell command should not silently inherit every one of them. This module
 * builds the environment a managed child receives: the parent env minus variables whose NAMES
 * look secret-like, with a non-excludable floor of variables children need to function at all.
 *
 * HONEST LIMITS (documented in README/ARCHITECTURE): this is name-based hygiene, not a security
 * boundary — a command can still read files, and proxy variables (which children need for any
 * network access on proxied machines) pass through even if their URLs embed credentials.
 */

/** Variable NAMES (case-insensitive) a child needs to function; never dropped, not even by config. */
const CORE_WINDOWS_ENV: readonly string[] = [
  // Never strip SystemRoot/windir: Winsock/CryptoAPI init fails with WinError 10106 without them.
  'SystemRoot',
  'windir',
  'SystemDrive',
  'ComSpec',
  'PATH',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ProgramData',
  'PSModulePath',
  'USERNAME',
  'USERDOMAIN',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

const CORE_POSIX_ENV: readonly string[] = ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'LOGNAME'];

/**
 * Proxy configuration passes through: on proxied machines children need it for any network access
 * (and policy already gates every command through a human). Embedded proxy credentials therefore
 * remain visible to approved commands — an honest, documented limitation.
 */
const PROXY_ENV: readonly string[] = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

/** Name substrings (case-insensitive) whose variables are dropped from child environments. */
export const DEFAULT_ENV_EXCLUDE_SUBSTRINGS: readonly string[] = ['key', 'secret', 'token', 'password', 'credential'];

const KEEP_ALWAYS = new Set([...CORE_WINDOWS_ENV, ...CORE_POSIX_ENV, ...PROXY_ENV].map((n) => n.toLowerCase()));

export interface ChildEnvPolicy {
  /** Extra case-insensitive name substrings to drop (config narrowing; cannot drop the core floor). */
  extraExcludeSubstrings?: readonly string[];
}

/**
 * Build the environment for a managed child process.
 *
 * Pipeline: (1) dedupe names case-insensitively — Windows env names are case-insensitive but JS
 * keys are not; Node passes only the lexicographically-first case-insensitive match to the child,
 * so we apply that rule ourselves to make the result deterministic and single-keyed. (2) Drop
 * variables whose name contains a default or config-supplied secret-like substring, unless the
 * name is on the non-excludable floor. (3) Inject AGENT_CLI=1 so children (and tests) can detect
 * they were spawned by the harness through the filtered path.
 */
export function buildChildEnv(parent: NodeJS.ProcessEnv, policy: ChildEnvPolicy = {}): Record<string, string> {
  const excludes = [...DEFAULT_ENV_EXCLUDE_SUBSTRINGS, ...(policy.extraExcludeSubstrings ?? [])]
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);

  // Case-insensitive dedupe applies ONLY on Windows, where env names are case-insensitive and
  // Node passes the child only the lexicographically-first case-insensitive match. On POSIX,
  // names are case-sensitive and `http_proxy` / `HTTP_PROXY` are genuinely distinct — folding
  // there would silently drop one, so POSIX keys pass through unfolded.
  const foldNames = process.platform === 'win32';
  const byFold = new Map<string, { name: string; value: string }>();
  for (const name of Object.keys(parent).sort()) {
    const value = parent[name];
    if (value === undefined) continue;
    const fold = foldNames ? name.toLowerCase() : name;
    if (!byFold.has(fold)) byFold.set(fold, { name, value });
  }

  // The floor and secret-name matching are always case-insensitive (keys may be unfolded on POSIX).
  const env: Record<string, string> = {};
  for (const entry of byFold.values()) {
    const lower = entry.name.toLowerCase();
    if (!KEEP_ALWAYS.has(lower) && excludes.some((sub) => lower.includes(sub))) continue;
    env[entry.name] = entry.value;
  }
  env['AGENT_CLI'] = '1';
  return env;
}
