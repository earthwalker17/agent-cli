import path from 'node:path';

/**
 * Deterministic automatic command review — the model-independent gate that decides whether a shell
 * command may run automatically (inside the enforced sandbox), must ask a human, or is hard-denied.
 *
 * DESIGN (from Codex's exec policy, adapted to a stock-Node Windows-first CLI): auto-allow is a
 * POSITIVE PROOF of safety, never "failed to match a dangerous pattern". Research is unambiguous
 * that any string/regex reviewer is defeated by encoding and obfuscation (base64 -EncodedCommand,
 * %VAR:~a,b% substring reconstruction, caret/backtick delimiters, wildcard-glob invocation,
 * char-code / iex runtime construction, pipe-into-interpreter). So this analyzer AUTO-ALLOWS only
 * when it can prove the command is:
 *   1. a SINGLE simple command — it contains NO shell metacharacters or control characters at all
 *      (; & | < > ( ) { } $ % backtick @ " ' ^, plus newline/CR/tab and the --% stop-parse token);
 *   2. whose executable (basename, .exe/.cmd/.bat/.com/.ps1 stripped, casefolded, NFKC-normalized)
 *      is on a small curated READ-ONLY allowlist;
 *   3. whose arguments pass the per-executable check and contain no path that escapes the workspace.
 * ANYTHING else -> ask. Obfuscation, alternate interpreters, chaining, redirection, and unknown
 * executables all fail step 1 or 2 and therefore land in `ask` (fail closed). The circuit-breaker
 * (catastrophic patterns) is an independent HARD DENY and is never a substitute for the positive
 * proof — it exists only to refuse a few forms even to a human.
 *
 * This analyzer is NOT the security boundary. The boundary is the enforced sandbox that an auto-run
 * command executes inside; this decides only whether a human prompt can be skipped. When no enforced
 * sandbox is available, the runtime disables auto-run entirely (see the policy engine).
 */

export interface CommandAnalysis {
  /** True only when positively proven safe (all three steps). */
  autoAllowable: boolean;
  /** The normalized executable basename, when a single simple command was parsed. */
  executable?: string;
  /** Human-readable, audit-friendly explanation of the verdict (recorded in policy.decision). */
  reason: string;
  /** Structured risk signals detected (metacharacters, interpreters, path escapes …). */
  riskFactors: string[];
}

// Shell metacharacters / grouping / substitution sigils / quotes / cmd-escape whose presence
// disqualifies a command from auto-run. Built from an explicit char list (backtick via \x60) so no
// literal backtick sits inside the source. Deliberately EXCLUDES the space (token separator) and
// '-' (flags). Control chars and the --% stop-parse token are checked separately.
const META_CHARS = ';&|<>(){}$%\x60@"\'^';

function hasMetacharacters(command: string): boolean {
  return [...command].some((ch) => META_CHARS.includes(ch));
}

function hasControlChars(command: string): boolean {
  return [...command].some((ch) => ch.charCodeAt(0) < 0x20);
}

/** Read-only executables whose OUTPUT is not inherently sensitive. Value = per-arg validator. */
type ArgCheck = (args: string[]) => { ok: boolean; reason?: string };

/** Only version/help flags — nothing that reads arbitrary files or reaches the network. */
const VERSION_ONLY: ArgCheck = (args) => {
  const ok = args.every((a) => /^(--version|-v|-V|--help|-h|version|help)$/i.test(a));
  return ok ? { ok } : { ok: false, reason: 'only --version/--help style flags may auto-run for this tool' };
};

/** git: only read-only subcommands, and no config-injection / path-changing global flags. */
const READ_ONLY_GIT_SUBCMDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'tag', 'shortlog',
  'ls-files', 'ls-tree', 'symbolic-ref', 'reflog', 'whatchanged', 'name-rev', 'var', 'version',
]);
const gitCheck: ArgCheck = (args) => {
  const first = args[0];
  if (first === undefined) return { ok: false, reason: 'bare git is not auto-runnable' };
  // Reject leading global flags that can inject config or relocate git (-c, -C, --exec-path, etc.).
  if (first.startsWith('-')) return { ok: false, reason: `git global flag ${first} disqualifies auto-run` };
  if (!READ_ONLY_GIT_SUBCMDS.has(first.toLowerCase())) {
    return { ok: false, reason: `git ${first} is not a known read-only subcommand` };
  }
  // Reject any pager/exec/config escape hiding in later args.
  for (const a of args.slice(1)) {
    if (/^(-c|--exec-path|--upload-pack|--receive-pack|-o|--output|--open-files-in-pager)/i.test(a)) {
      return { ok: false, reason: `git argument ${a} disqualifies auto-run` };
    }
  }
  return { ok: true };
};

/** npm-family: only read-only sub-verbs. */
const npmCheck: ArgCheck = (args) => {
  const first = (args[0] ?? '').toLowerCase();
  if (/^(--version|-v|version)$/.test(first)) return { ok: true };
  if (['ls', 'list', 'outdated', 'why', 'root', 'prefix', 'view', 'ping'].includes(first)) return { ok: true };
  return { ok: false, reason: `npm ${args[0] ?? '(none)'} is not a known read-only sub-command` };
};

/** Listing / trivial info commands: the shared path-escape guard is the only per-arg constraint. */
const listCheck: ArgCheck = () => ({ ok: true });

const ALLOWLIST: Record<string, ArgCheck> = {
  git: gitCheck,
  npm: npmCheck,
  pnpm: npmCheck,
  yarn: npmCheck,
  node: VERSION_ONLY,
  deno: VERSION_ONLY,
  bun: VERSION_ONLY,
  tsc: VERSION_ONLY,
  python: VERSION_ONLY,
  python3: VERSION_ONLY,
  pip: VERSION_ONLY,
  pip3: VERSION_ONLY,
  cargo: VERSION_ONLY,
  rustc: VERSION_ONLY,
  go: VERSION_ONLY,
  dotnet: VERSION_ONLY,
  java: VERSION_ONLY,
  ruby: VERSION_ONLY,
  php: VERSION_ONLY,
  ls: listCheck,
  dir: listCheck,
  pwd: listCheck,
  echo: () => ({ ok: true }),
  whoami: () => ({ ok: true }),
  hostname: () => ({ ok: true }),
  date: () => ({ ok: true }),
  where: listCheck,
  which: listCheck,
};

/** Normalize an executable token to its comparison key: NFKC, basename, strip exec extensions, casefold. */
export function normalizeExecutable(token: string): string {
  const nfkc = token.normalize('NFKC');
  const base = path.basename(nfkc.replace(/\\/g, '/'));
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

/**
 * True when an argument denotes a path that leaves the workspace or reaches a sensitive absolute
 * location — a conservative guard so an auto-run read command cannot be pointed at, say, ..\.env.
 * Flags (leading '-') are never treated as paths. Anything ambiguous counts as an escape (fail closed).
 */
function isEscapingPathArg(arg: string): boolean {
  if (arg.startsWith('-')) return false;
  if (arg.length === 0) return false;
  return (
    arg.includes('..') ||
    arg.includes('~') ||
    arg.startsWith('/') ||
    arg.startsWith('\\') ||
    /^[a-z]:/i.test(arg) || // drive-qualified (C:\...)
    arg.includes(':') // ADS / drive / URL-ish — reject conservatively
  );
}

/** Split a metacharacter-free command line into whitespace-separated tokens. */
function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Analyze a raw command string for auto-run eligibility. Pure and deterministic over the string
 * alone — the model's opinion is never consulted.
 */
export function analyzeCommand(command: string): CommandAnalysis {
  const risk: string[] = [];
  const trimmed = command.trim();
  if (trimmed.length === 0) return { autoAllowable: false, reason: 'empty command', riskFactors: ['empty'] };

  // Step 1: positive structural proof — a single simple command with NO shell metacharacters.
  if (command.includes('--%')) risk.push('stop-parse-token');
  if (hasControlChars(command)) risk.push('control-characters');
  if (hasMetacharacters(command)) risk.push('shell-metacharacters');
  if (risk.length > 0) {
    return {
      autoAllowable: false,
      reason: 'contains shell metacharacters/encoding — not a single simple command; requires approval',
      riskFactors: risk,
    };
  }

  const tokens = tokenize(command);
  const exeToken = tokens[0]!;
  const executable = normalizeExecutable(exeToken);
  const args = tokens.slice(1);

  // Step 2: the executable must be on the curated read-only allowlist.
  const check = ALLOWLIST[executable];
  if (!check) {
    return {
      autoAllowable: false,
      executable,
      reason: `'${executable}' is not on the auto-run read-only allowlist; requires approval`,
      riskFactors: ['non-allowlisted-executable'],
    };
  }

  // Step 3a: any argument that escapes the workspace disqualifies (protects reads of out-of-tree files).
  const escaping = args.find(isEscapingPathArg);
  if (escaping !== undefined) {
    return {
      autoAllowable: false,
      executable,
      reason: `argument '${escaping}' references a path outside the workspace; requires approval`,
      riskFactors: ['path-escape'],
    };
  }

  // Step 3b: the per-executable argument check.
  const argResult = check(args);
  if (!argResult.ok) {
    return {
      autoAllowable: false,
      executable,
      reason: argResult.reason ?? `${executable} arguments disqualify auto-run`,
      riskFactors: ['argument-check'],
    };
  }

  return {
    autoAllowable: true,
    executable,
    reason: `single read-only command '${executable}' with safe arguments — auto-run inside the sandbox`,
    riskFactors: [],
  };
}
