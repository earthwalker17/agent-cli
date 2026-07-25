import { normalizeRelPrefix } from '../shared/pathutil.js';
import {
  CHECK_KINDS,
  type CheckEffects,
  type CheckKind,
  type CheckRecipe,
  type CheckResolution,
  type DetectedProject,
  type ResolvedCheck,
  type UnsupportedCheck,
} from './types.js';

/**
 * The recipe table (Session 12): declarative rows mapping a verification KIND to a concrete
 * command for a detected project. The model never supplies a command string — it names kinds,
 * and this table names commands. That is the whole trust argument for the check tool's consent
 * model, so two rules are absolute:
 *
 * 1. Rows are ordered most-specific-first per kind and the FIRST applicable row wins, so
 *    resolution is deterministic and re-derivable (the same project always yields the same
 *    command, which is what replay consent is keyed on).
 * 2. Every dynamic fragment (script names from package.json, scope paths from the model) is
 *    charset-validated at ingestion and then quoted by `toCommand`. A fragment that cannot be
 *    represented safely is dropped or refuses — it is never escaped into the command by hand.
 *
 * Coverage is deliberately narrow and honest: Node/TS first-class, Python minimal, everything
 * else `unsupported` with the reason stated. `applies()` is the seam for later ecosystems.
 */

const isWin = process.platform === 'win32';

/** Characters that need no quoting in an argument position. */
const BARE_RE = /^[A-Za-z0-9_.\-\\/:=]+$/;
/** Anything carrying a control character can never be composed into a command line. */
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/**
 * Compose an argv into the single command string that is displayed, consented to, hashed for
 * replay consent, executed, and recorded. Single-quoting is the safe form in BOTH shells this
 * harness targets: PowerShell single-quoted strings are literal (only `'` needs doubling) and so
 * are POSIX ones, and the string is then handed to the same `shellInvocation` wrapper
 * `run_command` uses (`-EncodedCommand` on Windows), so there is no second parse to escape from.
 *
 * Throws on an element that cannot be represented. That is a harness invariant violation, not a
 * user-input case: everything reaching here has already passed a charset filter, and a throw
 * inside the policy `check()` fact fails CLOSED (deny) rather than composing something unknown.
 */
export function toCommand(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('check recipe produced an empty argv');
  return argv
    .map((a) => {
      if (a === '' || CONTROL_RE.test(a)) {
        throw new Error(`check recipe produced an unrepresentable argument: ${JSON.stringify(a.slice(0, 40))}`);
      }
      return BARE_RE.test(a) ? a : `'${a.replace(/'/g, "''")}'`;
    })
    .join(' ');
}

/** The Python interpreter name per platform (documented: `python` on Windows, `python3` elsewhere). */
const PY = isWin ? 'python' : 'python3';

const SCRIPT_EFFECTS: CheckEffects = { writesOutputs: true, network: true, workspaceAuthored: true };
const TOOL_READONLY: CheckEffects = { writesOutputs: false, network: false, workspaceAuthored: false };
const TOOL_WRITES: CheckEffects = { writesOutputs: true, network: false, workspaceAuthored: false };

const NEEDS_NODE_MODULES =
  'dependencies are not installed (node_modules is absent) — install them, then re-run this check';

/** `<pm> run <script>` — the portable form across npm, pnpm, and yarn. */
function runScript(p: DetectedProject, name: string, extra: readonly string[] = []): string[] | null {
  const pm = p.packageManager;
  if (pm === null || p.scripts[name] === undefined) return null;
  return [pm, 'run', name, ...extra];
}

/** Argument forwarding differs: npm/pnpm need `--`, yarn 1 forwards positionals directly. */
function forward(p: DetectedProject, scope: readonly string[]): string[] {
  if (scope.length === 0) return [];
  return p.packageManager === 'yarn' ? [...scope] : ['--', ...scope];
}

/** First script name present, from a preference list. */
function firstScript(p: DetectedProject, names: readonly string[]): string | null {
  for (const n of names) if (p.scripts[n] !== undefined) return n;
  return null;
}

function nodeScriptRecipe(
  id: string,
  kind: CheckKind,
  names: readonly string[],
  timeoutMs: number,
  opts: { scoped?: boolean } = {},
): CheckRecipe {
  return {
    id,
    kind,
    applies: (p) => firstScript(p, names) !== null,
    unmetPrecondition: (p) => (p.hasNodeModules ? null : NEEDS_NODE_MODULES),
    argv: (p, scope) => {
      const name = firstScript(p, names);
      if (name === null) return null;
      return runScript(p, name, opts.scoped === true ? forward(p, scope) : []);
    },
    timeoutMs,
    effects: SCRIPT_EFFECTS,
  };
}

/** A local Node tool invoked through `npx --no` (never installs; the dep must already be listed). */
function nodeToolRecipe(
  id: string,
  kind: CheckKind,
  tool: string,
  buildArgs: (p: DetectedProject, scope: readonly string[]) => string[],
  timeoutMs: number,
  effects: CheckEffects,
  extraApplies: (p: DetectedProject) => boolean = () => true,
): CheckRecipe {
  return {
    id,
    kind,
    applies: (p) => p.nodeTools.includes(tool) && extraApplies(p),
    unmetPrecondition: (p) => (p.hasNodeModules ? null : NEEDS_NODE_MODULES),
    argv: (p, scope) => ['npx', '--no', tool, ...buildArgs(p, scope)],
    timeoutMs,
    effects,
  };
}

function pythonToolRecipe(
  id: string,
  kind: CheckKind,
  tool: string,
  buildArgs: (p: DetectedProject, scope: readonly string[]) => string[],
  timeoutMs: number,
): CheckRecipe {
  return {
    id,
    kind,
    applies: (p) => p.kinds.includes('python') && p.pythonTools.includes(tool),
    // Python tools are commonly installed globally or in an active venv; the harness cannot
    // prove availability without running. A missing module surfaces as a real `error` result
    // whose command-not-found / module-not-found signal classifies as dependency-setup.
    unmetPrecondition: () => null,
    argv: (p, scope) => [PY, '-m', tool, ...buildArgs(p, scope)],
    timeoutMs,
    effects: TOOL_READONLY,
  };
}

/**
 * Ordered most-specific-first WITHIN each kind. A project's own script always wins over a guessed
 * tool invocation: the workspace author already declared how this project is checked.
 */
export const RECIPES: readonly CheckRecipe[] = [
  // ---- build ----
  nodeScriptRecipe('node.script.build', 'build', ['build', 'compile'], 600_000),

  // ---- test ----
  nodeScriptRecipe('node.script.test', 'test', ['test'], 900_000),
  nodeToolRecipe('node.vitest', 'test', 'vitest', () => ['run'], 900_000, TOOL_WRITES),
  nodeToolRecipe('node.jest', 'test', 'jest', () => ['--ci'], 900_000, TOOL_WRITES),
  pythonToolRecipe('py.pytest', 'test', 'pytest', () => ['-q'], 900_000),

  // ---- test-targeted ----
  nodeScriptRecipe('node.script.test.targeted', 'test-targeted', ['test'], 300_000, { scoped: true }),
  nodeToolRecipe('node.vitest.targeted', 'test-targeted', 'vitest', (_p, scope) => ['run', ...scope], 300_000, TOOL_WRITES),
  pythonToolRecipe('py.pytest.targeted', 'test-targeted', 'pytest', (_p, scope) => ['-q', ...scope], 300_000),

  // ---- typecheck ----
  nodeScriptRecipe('node.script.typecheck', 'typecheck', ['typecheck', 'type-check', 'tsc'], 300_000),
  nodeToolRecipe('node.tsc', 'typecheck', 'typescript', () => ['--noEmit'], 300_000, TOOL_READONLY, (p) => p.hasTsconfig),
  pythonToolRecipe('py.mypy', 'typecheck', 'mypy', () => ['.'], 300_000),

  // ---- lint ----
  nodeScriptRecipe('node.script.lint', 'lint', ['lint'], 300_000),
  nodeToolRecipe('node.eslint', 'lint', 'eslint', () => ['.'], 300_000, TOOL_READONLY, (p) => p.hasEslintConfig),
  pythonToolRecipe('py.ruff', 'lint', 'ruff', () => ['check', '.'], 300_000),

  // ---- format ----
  nodeScriptRecipe('node.script.format-check', 'format', ['format:check', 'fmt:check', 'format-check'], 180_000),
  nodeToolRecipe('node.prettier', 'format', 'prettier', () => ['--check', '.'], 180_000, TOOL_READONLY, (p) => p.hasPrettierConfig),
  pythonToolRecipe('py.ruff.format', 'format', 'ruff', () => ['format', '--check', '.'], 180_000),

  // ---- static-analysis ----
  nodeScriptRecipe('node.script.analyze', 'static-analysis', ['analyze', 'static-analysis', 'audit:code'], 600_000),
];

/** The `typescript` dependency provides the `tsc` binary; npx resolves the binary, not the package. */
const NPX_BINARY: Readonly<Record<string, string>> = { typescript: 'tsc' };

function argvWithBinary(recipe: CheckRecipe, p: DetectedProject, scope: readonly string[]): string[] | null {
  const argv = recipe.argv(p, scope);
  if (argv === null) return null;
  // `npx --no <tool>` — swap a package name for the binary it installs where they differ.
  if (argv[0] === 'npx' && argv[1] === '--no' && argv[2] !== undefined) {
    const bin = NPX_BINARY[argv[2]];
    if (bin !== undefined) return [argv[0], argv[1], bin, ...argv.slice(3)];
  }
  return argv;
}

/**
 * Validate model-supplied scope prefixes with the SAME structural containment rule plan `touches`
 * use (`normalizeRelPrefix`): `..`-escaping, absolute, and drive-qualified prefixes are refused
 * without ever touching the disk, so a scope can never become an existence oracle. Order and
 * duplicates are normalized so the resolved command — and therefore the replay-consent key — is
 * deterministic for a given set.
 */
export function normalizeScopePaths(scope: readonly string[]): { paths: string[]; rejected: string[] } {
  const paths: string[] = [];
  const rejected: string[] = [];
  for (const raw of scope) {
    const norm = normalizeRelPrefix(raw);
    if (norm === null || CONTROL_RE.test(norm)) rejected.push(raw.slice(0, 60));
    else if (!paths.includes(norm)) paths.push(norm);
  }
  paths.sort();
  return { paths, rejected };
}

/** Kinds that consume scope paths; for every other kind a supplied scope is ignored. */
export function kindTakesScope(kind: CheckKind): boolean {
  return kind === 'test-targeted';
}

/**
 * Resolve requested kinds against a detected project. Never throws for input reasons: an
 * unresolvable kind comes back in `unsupported` WITH the reason, because "we cannot check that
 * here" is an answer the model and the user both need to see, not an error to swallow.
 */
export function resolveChecks(
  project: DetectedProject,
  kinds: readonly CheckKind[],
  scope: readonly string[] = [],
): CheckResolution {
  const { paths, rejected } = normalizeScopePaths(scope);
  const resolved: ResolvedCheck[] = [];
  const unsupported: UnsupportedCheck[] = [];

  for (const kind of CHECK_KINDS) {
    if (!kinds.includes(kind)) continue;
    const rows = RECIPES.filter((r) => r.kind === kind);
    const applicable = rows.filter((r) => r.applies(project));
    if (applicable.length === 0) {
      unsupported.push({
        kind,
        reason:
          project.kinds.length === 0
            ? 'no supported project manifest was detected in this workspace (Node/TS and Python are supported)'
            : `no ${kind} recipe applies to this project (detected: ${project.kinds.join(', ')})`,
      });
      continue;
    }
    if (kind === 'test-targeted' && paths.length === 0) {
      unsupported.push({
        kind,
        reason:
          rejected.length > 0
            ? `test-targeted requires scope_paths naming what to test; every supplied path was refused: ${rejected.join(', ')}`
            : 'test-targeted requires scope_paths naming what to test',
      });
      continue;
    }
    const ready = applicable.find((r) => r.unmetPrecondition(project) === null);
    if (ready === undefined) {
      unsupported.push({ kind, reason: applicable[0]!.unmetPrecondition(project) ?? 'precondition not met' });
      continue;
    }
    const argv = argvWithBinary(ready, project, kindTakesScope(kind) ? paths : []);
    if (argv === null) {
      unsupported.push({ kind, reason: `recipe ${ready.id} could not produce a command for this project` });
      continue;
    }
    resolved.push({
      kind,
      recipeId: ready.id,
      command: toCommand(argv),
      timeoutMs: ready.timeoutMs,
      effects: ready.effects,
      scopePaths: kindTakesScope(kind) ? paths : [],
    });
  }

  return { resolved, unsupported };
}

/** Every kind this project could run right now — the /checks surface and the plan-time warning. */
export function availableKinds(project: DetectedProject): CheckKind[] {
  return CHECK_KINDS.filter((kind) =>
    RECIPES.some((r) => r.kind === kind && r.applies(project) && r.unmetPrecondition(project) === null),
  );
}
