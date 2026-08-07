import { normalizeRelPrefix } from '../shared/pathutil.js';
import { sha256 } from '../shared/hash.js';
import {
  CHECK_KINDS,
  type CheckEffects,
  type CheckKind,
  type CheckRecipe,
  type CheckResolution,
  type DetectedProject,
  type ProjectKind,
  type ResolvedCheck,
  type UnmetPrecondition,
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
 * Coverage is deliberately narrow and honest: Node/TS first-class, Python minimal, Rust/Cargo
 * and Go modules first-class (Session 18), CMake detected-but-unsupported, everything else
 * `unsupported` with the reason stated. `applies()` is the seam for later ecosystems.
 *
 * Session 18 also moves the precondition WHY into the rows (`UnmetPrecondition`): only a row
 * knows whether its blocker is an uninstalled project (curable by `project_setup install`), a
 * missing machine toolchain (`toolchain-unavailable`, waives loudly), or a genuine host
 * incapability (`precondition`, waives quietly). The old central rule — curable iff
 * `hasDependencies && !hasNodeModules` — was a Node fact sitting in generic control flow.
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
/**
 * Cargo compile rows: write `target/`, may fetch crates on first run, and — decisive for the
 * approval prompt — EXECUTE workspace-authored code at build time (`build.rs`, proc-macros).
 */
const CARGO_COMPILE: CheckEffects = { writesOutputs: true, network: true, workspaceAuthored: true };
/**
 * Go rows: the build/module caches live OUTSIDE the workspace (GOCACHE/GOMODCACHE); modules may
 * be fetched on first run. `go test` executing workspace test code follows the vitest precedent
 * (`workspaceAuthored: false` — the flag means "a script DEFINED by the workspace names this
 * command's behavior", which `go test ./...` is not). BUILD rows declare `writesOutputs: true`
 * (S18 review): `go build ./...` matching a single main package writes the executable into the
 * unit's cwd — the declaration must not lie for the most common single-package CLI layout.
 */
const GO_TOOL_NET: CheckEffects = { writesOutputs: false, network: true, workspaceAuthored: false };
const GO_BUILD_NET: CheckEffects = { writesOutputs: true, network: true, workspaceAuthored: false };

const NEEDS_NODE_MODULES =
  'dependencies are not installed (node_modules is absent) — run `project_setup` with action "install" for this ' +
  'project, then re-run this check. This does NOT waive a declared gate: the project can be checked, it just has ' +
  'not been installed yet.';

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
    // A workspace-authored script is only blocked by a missing node_modules when the project
    // actually DECLARES dependencies. A script that shells out to Node built-ins (`node --test`,
    // a local build script) needs nothing installed, and refusing it would have made typed
    // verification unavailable to exactly the smallest, cheapest projects. When deps ARE declared
    // and absent, the honest refusal still fires before anything spawns — and it is CURABLE by
    // construction: this branch is reachable only when dependencies are declared.
    unmetPrecondition: (p) =>
      !p.hasDependencies || p.hasNodeModules ? null : { reason: NEEDS_NODE_MODULES, why: 'precondition-curable' },
    argv: (p, scope) => {
      const name = firstScript(p, names);
      if (name === null) return null;
      return runScript(p, name, opts.scoped === true ? forward(p, scope) : []);
    },
    // `<pm> run <name>` is a stable command whose BEHAVIOR lives in package.json. Consent and the
    // execute-time re-resolve both bind that body's sha, so rewriting the script re-asks the
    // human — binding the NAME here lets the resolver use the untruncated sha.
    bodyScript: (p) => firstScript(p, names),
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
    // Curable exactly when the old central rule said so: `nodeTools` is parsed from declared
    // dependencies, so `hasDependencies` is true whenever this row applies — the branch keeps
    // the rule spelled out so the equivalence is checkable, not assumed.
    unmetPrecondition: (p) =>
      p.hasNodeModules ? null : { reason: NEEDS_NODE_MODULES, why: p.hasDependencies ? 'precondition-curable' : 'precondition' },
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
 * Rust/Cargo toolchain gating (Session 18). The probe is a stat-only PATH/rustup fact carried on
 * the project; `undefined` means no probe ran (tests, direct `detectProject` callers) and the row
 * degrades to the documented pythonToolRecipe pattern — fail at run, classify via the
 * command-not-found signal. Every refusal names the exact user cure: a missing toolchain is a
 * machine fact the harness will never install on its own.
 */
function cargoUnmet(
  p: DetectedProject,
  opts: { component?: 'clippy' | 'rustfmt'; compilesForTarget?: boolean; executesTargetBinaries?: boolean },
): UnmetPrecondition | null {
  const tc = p.toolchains;
  // The PERMANENT host incapability outranks the transient install gaps: cross-compiled test
  // binaries cannot execute here whether or not anything else is installed.
  if (opts.executesTargetBinaries === true) {
    const triple = p.rust?.crossTarget ?? null;
    if (triple !== null) {
      return {
        why: 'precondition',
        reason:
          `.cargo config sets [build].target = ${triple}: cross-compiled test binaries cannot execute on this host, ` +
          'and the harness does not manage target hardware or emulators. Host-verifiable checks (cargo fmt --check, ' +
          'and cargo build/check/clippy once the rustup target is installed) still run.',
      };
    }
  }
  if (tc === undefined) return null;
  if (tc.cargo === null) {
    return {
      why: 'toolchain-unavailable',
      reason:
        'the Rust toolchain is not installed on this machine (cargo was not found on PATH) — install it via rustup ' +
        '(https://rustup.rs), then re-run this check. A missing toolchain is a machine fact, not a project defect.',
    };
  }
  if (opts.component === 'clippy' && !tc.clippy) {
    return { why: 'toolchain-unavailable', reason: 'the clippy component is not installed — run: rustup component add clippy' };
  }
  if (opts.component === 'rustfmt' && !tc.rustfmt) {
    return { why: 'toolchain-unavailable', reason: 'the rustfmt component is not installed — run: rustup component add rustfmt' };
  }
  // Every compile row (build/check/test/clippy — NOT fmt) targets the cross triple when one is
  // declared, so each needs the rustup target installed.
  const triple = p.rust?.crossTarget ?? null;
  if (opts.compilesForTarget === true && triple !== null && !tc.rustupTargets.includes(triple)) {
    return {
      why: 'toolchain-unavailable',
      reason: `.cargo config targets ${triple} and that rustup target is not installed — run: rustup target add ${triple}, then re-run this check`,
    };
  }
  return null;
}

function cargoRecipe(
  id: string,
  kind: CheckKind,
  args: readonly string[],
  timeoutMs: number,
  effects: CheckEffects,
  opts: { component?: 'clippy' | 'rustfmt'; compilesForTarget?: boolean; executesTargetBinaries?: boolean } = {},
): CheckRecipe {
  return {
    id,
    kind,
    applies: (p) => p.kinds.includes('rust'),
    unmetPrecondition: (p) => cargoUnmet(p, opts),
    argv: () => ['cargo', ...args],
    // `cargo build` is a stable string whose fetch-and-execute behavior lives in the steering
    // files (Cargo.toml/lock, .cargo/config*, rust-toolchain*) — and for cargo/go the check IS
    // the ecosystem's install step, the consequence class the Node install binds files for
    // (S18 review). Binding their digest as the consent body makes both the replay key and the
    // execute-time drift refusal change when any of them does.
    bodyShaOf: (p) => p.rust?.consentSha ?? null,
    timeoutMs,
    effects,
  };
}

function goUnmet(p: DetectedProject): UnmetPrecondition | null {
  const tc = p.toolchains;
  if (tc === undefined || tc.go !== null) return null;
  return {
    why: 'toolchain-unavailable',
    reason:
      'the Go toolchain is not installed on this machine (go was not found on PATH) — install it from ' +
      'https://go.dev/dl (winget: GoLang.Go), then re-run this check. A missing toolchain is a machine fact, not a project defect.',
  };
}

function goRecipe(
  id: string,
  kind: CheckKind,
  buildArgs: (p: DetectedProject, scope: readonly string[]) => string[] | null,
  timeoutMs: number,
  effects: CheckEffects = GO_TOOL_NET,
): CheckRecipe {
  return {
    id,
    kind,
    applies: (p) => p.kinds.includes('go'),
    unmetPrecondition: goUnmet,
    argv: (p, scope) => {
      const args = buildArgs(p, scope);
      return args === null ? null : ['go', ...args];
    },
    // go.mod + go.sum are the steering files a granted `go …` fetches and trusts by (see the
    // cargo rows' note — the same S18-review consent-body rule).
    bodyShaOf: (p) => p.go?.consentSha ?? null,
    timeoutMs,
    effects,
  };
}

/**
 * Map workspace-relative scope prefixes onto Go package patterns for `go test`. Go's test
 * selection IS path-shaped, which is why this mapping exists here and has no cargo counterpart:
 * strip this unit's prefix (a path outside the unit is dropped), fold a `.go` file to its
 * package directory, and render `./dir/...`. All inputs already passed `normalizeRelPrefix`;
 * the output charset is `./x/...`, which `toCommand` passes bare. Deterministic: inputs arrive
 * sorted and deduped, and the package set is re-sorted after folding.
 */
function goTargetedArgs(p: DetectedProject, scope: readonly string[]): string[] | null {
  const pkgs = new Set<string>();
  for (const s of scope) {
    let rel: string;
    if (p.id === '.') rel = s;
    else if (s === p.id) rel = '';
    else if (s.startsWith(`${p.id}/`)) rel = s.slice(p.id.length + 1);
    else continue; // outside this unit — a green run over it would prove nothing here anyway
    if (rel.endsWith('.go')) rel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    pkgs.add(rel === '' ? './...' : `./${rel}/...`);
  }
  if (pkgs.size === 0) return null;
  return ['test', ...[...pkgs].sort()];
}

/**
 * Ordered most-specific-first WITHIN each kind. A project's own script always wins over a guessed
 * tool invocation: the workspace author already declared how this project is checked.
 */
export const RECIPES: readonly CheckRecipe[] = [
  // ---- build ----
  nodeScriptRecipe('node.script.build', 'build', ['build', 'compile'], 600_000),
  cargoRecipe('cargo.build', 'build', ['build'], 600_000, CARGO_COMPILE, { compilesForTarget: true }),
  goRecipe('go.build', 'build', () => ['build', './...'], 600_000, GO_BUILD_NET),

  // ---- test ----
  nodeScriptRecipe('node.script.test', 'test', ['test'], 900_000),
  nodeToolRecipe('node.vitest', 'test', 'vitest', () => ['run'], 900_000, TOOL_WRITES),
  nodeToolRecipe('node.jest', 'test', 'jest', () => ['--ci'], 900_000, TOOL_WRITES),
  pythonToolRecipe('py.pytest', 'test', 'pytest', () => ['-q'], 900_000),
  cargoRecipe('cargo.test', 'test', ['test'], 900_000, CARGO_COMPILE, { compilesForTarget: true, executesTargetBinaries: true }),
  goRecipe('go.test', 'test', () => ['test', './...'], 900_000),

  // ---- test-targeted ---- (no cargo row: cargo selects tests by NAME, not path — see notes)
  nodeScriptRecipe('node.script.test.targeted', 'test-targeted', ['test'], 300_000, { scoped: true }),
  nodeToolRecipe('node.vitest.targeted', 'test-targeted', 'vitest', (_p, scope) => ['run', ...scope], 300_000, TOOL_WRITES),
  pythonToolRecipe('py.pytest.targeted', 'test-targeted', 'pytest', (_p, scope) => ['-q', ...scope], 300_000),
  goRecipe('go.test.targeted', 'test-targeted', goTargetedArgs, 300_000),

  // ---- typecheck ----
  nodeScriptRecipe('node.script.typecheck', 'typecheck', ['typecheck', 'type-check', 'tsc'], 300_000),
  nodeToolRecipe('node.tsc', 'typecheck', 'typescript', () => ['--noEmit'], 300_000, TOOL_READONLY, (p) => p.hasTsconfig),
  pythonToolRecipe('py.mypy', 'typecheck', 'mypy', () => ['.'], 300_000),
  cargoRecipe('cargo.check', 'typecheck', ['check'], 600_000, CARGO_COMPILE, { compilesForTarget: true }),
  // Go's compiler IS its typechecker; the deliberate duplication with `go.build` keeps the KIND
  // honest (a typecheck gate on a Go project means "it compiles") instead of `no-recipe`-waiving.
  goRecipe('go.typecheck.build', 'typecheck', () => ['build', './...'], 300_000, GO_BUILD_NET),

  // ---- lint ----
  nodeScriptRecipe('node.script.lint', 'lint', ['lint'], 300_000),
  nodeToolRecipe('node.eslint', 'lint', 'eslint', () => ['.'], 300_000, TOOL_READONLY, (p) => p.hasEslintConfig),
  pythonToolRecipe('py.ruff', 'lint', 'ruff', () => ['check', '.'], 300_000),
  // Clippy's plain exit status ignores lint findings; `-D warnings` is the CI-conventional strict
  // form and the exit code stays the verdict. Displayed verbatim for consent like every command.
  cargoRecipe('cargo.clippy', 'lint', ['clippy', '--', '-D', 'warnings'], 600_000, CARGO_COMPILE, {
    component: 'clippy',
    compilesForTarget: true,
  }),

  // ---- format ---- (no go row: gofmt exits 0 on unformatted files — see notes)
  nodeScriptRecipe('node.script.format-check', 'format', ['format:check', 'fmt:check', 'format-check'], 180_000),
  nodeToolRecipe('node.prettier', 'format', 'prettier', () => ['--check', '.'], 180_000, TOOL_READONLY, (p) => p.hasPrettierConfig),
  pythonToolRecipe('py.ruff.format', 'format', 'ruff', () => ['format', '--check', '.'], 180_000),
  // Deliberately NOT target-gated: rustfmt parses, it never compiles — the host-verifiable half
  // of a cross-target project.
  cargoRecipe('cargo.fmt', 'format', ['fmt', '--check'], 180_000, TOOL_READONLY, { component: 'rustfmt' }),

  // ---- static-analysis ----
  nodeScriptRecipe('node.script.analyze', 'static-analysis', ['analyze', 'static-analysis', 'audit:code'], 600_000),
  goRecipe('go.vet', 'static-analysis', () => ['vet', './...'], 300_000),
];

/**
 * Honest reasons for kind+ecosystem holes that are DECISIONS, not gaps. Consulted by
 * `resolveChecks`' no-recipe branch so the refusal explains itself instead of reading like a
 * missing feature. One entry fires per (kind, first matching project kind).
 */
const ECOSYSTEM_KIND_NOTES: readonly { kind: CheckKind; when: ProjectKind; note: string }[] = [
  {
    kind: 'format',
    when: 'go',
    note:
      'gofmt lists unformatted files but exits 0 either way; a verdict parsed from output would violate ' +
      '"the exit code is the verdict", so Go has no format recipe. Gate formatting via a project script if you need it.',
  },
  {
    kind: 'test-targeted',
    when: 'rust',
    note: 'cargo selects tests by NAME, not by path; mapping path scopes onto a name filter would be a guess. Run the full `cargo test` (kind "test") instead.',
  },
  {
    kind: 'lint',
    when: 'go',
    note: 'Go ships no linter in the standard distribution; `go vet` is available as the static-analysis kind.',
  },
  {
    kind: 'static-analysis',
    when: 'rust',
    note: '`cargo clippy` is the lint kind for Rust; there is no separate static-analysis recipe.',
  },
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
 * Qualify a recipe id with its project unit (Session 16). A recipe id is a CONSENT identity —
 * `node.script.test` in `web/` and in `api/` are different authorities — so a multi-unit
 * workspace must never collapse them.
 *
 * The root unit is deliberately NOT qualified. A single-project workspace keeps byte-identical
 * recipe ids, which means every pre-existing event log, report, replay grant and test keeps its
 * exact meaning; the qualification appears only where the ambiguity it resolves actually exists.
 */
export function qualifyRecipeId(recipeId: string, projectId: string): string {
  return projectId === '.' ? recipeId : `${recipeId}@${projectId}`;
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
      const note = ECOSYSTEM_KIND_NOTES.find((n) => n.kind === kind && project.kinds.includes(n.when));
      const cmakeOnly = project.kinds.includes('cmake') && !project.kinds.some((k) => k === 'node' || k === 'python' || k === 'rust' || k === 'go');
      unsupported.push({
        kind,
        why: 'no-recipe',
        reason:
          project.kinds.length === 0
            ? 'no supported project manifest was detected in this workspace (Node/TS, Python, Rust/Cargo and Go are supported; CMake is detected but its checks are unsupported)'
            : note !== undefined
              ? `no ${kind} recipe applies to this project (detected: ${project.kinds.join(', ')}). ${note.note}`
              : cmakeOnly
                ? `no ${kind} recipe applies: this is a CMake/C-C++ project, which this version detects and indexes but cannot check`
                : `no ${kind} recipe applies to this project (detected: ${project.kinds.join(', ')})`,
      });
      continue;
    }
    if (kind === 'test-targeted' && paths.length === 0) {
      // A CALLER mistake, not a project fact — tagged so it can never waive a declared gate.
      unsupported.push({
        kind,
        why: 'bad-request',
        reason:
          rejected.length > 0
            ? `test-targeted requires scope_paths naming what to test; every supplied path was refused: ${rejected.join(', ')}`
            : 'test-targeted requires scope_paths naming what to test',
      });
      continue;
    }
    const ready = applicable.find((r) => r.unmetPrecondition(project) === null);
    if (ready === undefined) {
      // The WHY comes from the most specific applicable ROW (Session 18): whether a blocker is
      // an uninstalled project (curable by `project_setup install`, keeps the gate pending), a
      // missing machine toolchain (waives the gate LOUDLY, cure named), or a genuine host
      // incapability (waives quietly) is a fact only the row can state. The old central rule —
      // curable iff `hasDependencies && !hasNodeModules` — was Node's answer hard-coded into
      // everyone's control flow; the node rows still give exactly that answer.
      const unmet = applicable[0]!.unmetPrecondition(project);
      unsupported.push({
        kind,
        why: unmet?.why ?? 'precondition',
        reason: unmet?.reason ?? 'precondition not met',
      });
      continue;
    }
    const argv = argvWithBinary(ready, project, kindTakesScope(kind) ? paths : []);
    if (argv === null) {
      // For a scope-taking kind with a NON-EMPTY scope, a null argv means every supplied path
      // fell outside this unit — a CALLER mistake exactly like the empty-scope case above, and
      // it must carry the same 'bad-request' tag (S18 review: three lenses independently found
      // that the old 'no-recipe' answer let a mis-scoped go test-targeted call WAIVE a declared
      // gate). A scope-less null argv remains a genuine capability answer.
      const scopedMiss = kindTakesScope(kind) && paths.length > 0;
      unsupported.push({
        kind,
        why: scopedMiss ? 'bad-request' : 'no-recipe',
        reason: scopedMiss
          ? `every supplied scope path lies outside project '${project.id}' (${paths.join(', ')}) — name paths inside the project this check should verify`
          : `recipe ${ready.id} could not produce a command for this project`,
      });
      continue;
    }
    // Consent binds the UNTRUNCATED body: project.scripts is display-capped at 200 chars, so
    // hashing it would let an append past that cap ride the earlier approval (S14.5 finding).
    // Rows without a named script may bind a direct consent-body digest instead (S18: the
    // cargo/go steering files).
    const bodyName = ready.bodyScript?.(project) ?? null;
    const bodySha = bodyName !== null ? (project.scriptShas[bodyName] ?? null) : (ready.bodyShaOf?.(project) ?? null);
    resolved.push({
      kind,
      recipeId: qualifyRecipeId(ready.id, project.id),
      command: toCommand(argv),
      ...(bodySha !== null ? { bodySha } : {}),
      projectId: project.id,
      cwd: project.root,
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
