import type { CheckFinding, CheckKind, CheckStatus, CommandTermination } from '../types.js';

export { CHECK_KINDS, isCheckKind } from '../types.js';
export type { CheckFinding, CheckKind, CheckStatus } from '../types.js';

/**
 * Typed project checks (Session 12) — the contracts. A check is NOT "a command the model chose":
 * it is a harness-resolved RECIPE for a declared verification KIND, with declared applicability,
 * preconditions, effects, a timeout, and a normalized result. The model names kinds; the harness
 * names commands. That split is what makes a check gate mean something in the task graph.
 *
 * Deliberate omission: there is no dependency-install CHECK KIND. Installing dependencies executes
 * third-party code with network access and is the one operation whose blast radius does not fit
 * "verify what we just built". Session 16 gives installation its own typed tool (`project_setup`,
 * `src/setup/`) with its own consent, its own events, and no ability to satisfy a verification
 * gate — so the split survives: a check still means "we verified", never "we fetched".
 */

/**
 * Ecosystems the harness can NAME. Everything else detects as no kinds and refuses honestly.
 * Naming is not capability: `rust` and `go` carry recipe rows (Session 18); `cmake` is detected
 * so refusals say "a CMake project whose checks are unsupported" instead of the falsehood "no
 * supported project manifest was detected" — retrieval indexes its files either way.
 */
export type ProjectKind = 'node' | 'python' | 'rust' | 'go' | 'cmake';

/** Rust/Cargo unit facts (Session 18). Bounded extraction, never TOML-parsed by a dependency. */
export interface RustFacts {
  /** Cargo.toml declares a `[workspace]` section (this unit is a cargo workspace root). */
  workspaceRoot: boolean;
  hasCargoLock: boolean;
  /** `[package] edition`, display evidence only. */
  edition: string | null;
  /**
   * `[build] target` from `.cargo/config.toml` / `.cargo/config`, charset-filtered. When set,
   * every compile targets that triple: build/check/clippy need the rustup target installed, and
   * `cargo test` builds binaries this HOST cannot execute — the embedded honesty split.
   */
  crossTarget: string | null;
  /** `rust-toolchain.toml` / `rust-toolchain` file present (name only; the harness never overrides it). */
  toolchainFile: string | null;
}

/** Go module unit facts (Session 18). */
export interface GoFacts {
  /** The `module` directive path, charset-filtered — display and evidence only. */
  module: string | null;
  /** The `go` version directive, display only. */
  goDirective: string | null;
  hasGoSum: boolean;
  /** A `vendor/` directory exists (affects nothing the harness runs; a fact worth naming). */
  hasVendorDir: boolean;
}

/** CMake unit facts (Session 18) — detection names the ecosystem; checks stay unsupported. */
export interface CmakeFacts {
  projectName: string | null;
}

/** A toolchain binary found on PATH: the name probed and the absolute path that answered. */
export interface ToolProbe {
  name: string;
  path: string;
}

/**
 * Machine toolchain availability (Session 18) — stat-only facts probed by `toolchain.ts`, shared
 * by every unit of one detection. Presence, not health: a findable binary that is broken still
 * fails at run time with a real signal. `clippy`/`rustfmt`/`rustupTargets` are probed under the
 * rustup TOOLCHAIN directories (never `~/.cargo/bin`, whose proxy shims exist for every component
 * name whether or not the component does), unioned across installed toolchains — an approximation
 * the module doc states.
 */
export interface ToolchainFacts {
  cargo: ToolProbe | null;
  rustc: ToolProbe | null;
  go: ToolProbe | null;
  clippy: boolean;
  rustfmt: boolean;
  /** Installed rust target triples (charset-filtered, capped, sorted). */
  rustupTargets: string[];
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

/**
 * The lockfile a unit's installs are pinned by. `sha256` is the CONSENT identity for an install:
 * `npm ci` is a stable string whose meaning lives entirely in this file, exactly as `npm run test`
 * lives in package.json (the S14.5 body-binding lesson, applied to dependencies). A lockfile past
 * `MAX_LOCKFILE_BYTES` hashes to null, which costs replay consent rather than inventing an
 * identity — that call is approved once, for that call.
 */
export interface DetectedLockfile {
  name: string;
  sha256: string | null;
  size: number;
}

/**
 * A stat-only fingerprint of one manifest candidate. The recipe resolution the human APPROVES is
 * a function of the detected project, so the runner must be able to tell — cheaply, without
 * re-reading anything — whether the project changed between the approval and the execution.
 * Mirrors the retrieval index's size+mtime stat-diff; same known limit (a same-size same-mtime
 * edit is invisible), which is why the runner also compares the resolved command itself.
 */
export interface ManifestStamp {
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface DetectedProject {
  /** The absolute directory this unit is rooted at (the workspace root for the root unit). */
  root: string;
  /**
   * Session 16: this unit's identity — its workspace-relative POSIX directory, or `'.'` for the
   * workspace root itself. It is what the model names in `project`, what recipe ids are qualified
   * with, and what `check.completed.projectId` records, so it must be derived structurally
   * (`normalizeRelPrefix`) and never from a display string.
   */
  id: string;
  /** Ecosystems with usable evidence; empty ⇒ every check kind is unsupported. */
  kinds: ProjectKind[];
  packageManager: PackageManager | null;
  /**
   * The verbatim `packageManager` field from package.json (e.g. `yarn@4.5.0`), charset-filtered
   * and capped. Yarn's own install flag differs between v1 (`--frozen-lockfile`) and Berry
   * (`--immutable`), and this declaration is the only authoritative way to tell them apart —
   * without it the setup resolver refuses rather than guessing which one the project meant.
   */
  packageManagerSpec: string | null;
  /** package.json scripts: name → command text (both bounded) — DISPLAY/precondition use only. */
  scripts: Record<string, string>;
  /**
   * name → sha256 of the UNTRUNCATED script value. Consent identity must bind the whole body:
   * `scripts` is capped at 200 chars, so binding its sha let an agent append anything past
   * character 200 and re-run under the earlier `[s]` with no prompt (S14.5 review finding).
   */
  scriptShas: Record<string, string>;
  /** Interesting dependency names found in package.json deps/devDeps. */
  nodeTools: string[];
  /** Interesting tool names found in pyproject.toml / setup.cfg text. */
  pythonTools: string[];
  hasNodeModules: boolean;
  /** package.json declares at least one dependency — only then does an absent node_modules matter. */
  hasDependencies: boolean;
  hasTsconfig: boolean;
  hasEslintConfig: boolean;
  hasPrettierConfig: boolean;
  /** The lockfile installs are pinned by, when this unit has one. */
  lockfile: DetectedLockfile | null;
  /**
   * sha256 of the raw package.json bytes, and of `.npmrc` when present.
   *
   * These are part of an INSTALL's consent identity, not decoration. `npm ci` looks like a
   * command whose whole meaning is the lockfile, and it is not: package.json's `preinstall` /
   * `install` / `postinstall` / `prepare` entries are executed by every package manager during
   * an install, and `.npmrc` decides which registry the code comes from and what shell runs
   * those scripts. Binding the lockfile alone would let one `[s]` become standing consent to
   * execute whatever those files are later changed to say — the S14.5 body-binding lesson,
   * which for an install has several files in the "body", not one.
   */
  manifestSha256: string | null;
  /** Kept for display and provenance; the consent identity uses `installConfigSha256`. */
  npmrcSha256: string | null;
  /**
   * One digest over EVERY install-affecting config file present (`.npmrc`, `.yarnrc.yml`,
   * `.pnpmfile.cjs`), names included so adding one differs from editing one. `.npmrc` alone was
   * the original binding and it was not enough: `.yarnrc.yml` can point `yarnPath` at an
   * arbitrary script and `.pnpmfile.cjs` runs a hook in-process during resolution — both ordinary
   * workspace files an auto-allowed write can create under a standing `[s]`.
   */
  installConfigSha256: string | null;
  /**
   * Environment-configuration FILE NAMES only — never contents. `.env` is secret-classified, so
   * reading one is an ask-with-redaction; but "this project ships `.env.example` and has no
   * `.env`" is a fact worth surfacing, because otherwise a missing config shows up only as a dev
   * server that dies during startup for no visible reason.
   */
  envFiles: { examples: string[]; present: string[] };
  /** Rust/Cargo facts when `kinds` includes 'rust' (Session 18). */
  rust?: RustFacts;
  /** Go module facts when `kinds` includes 'go' (Session 18). */
  go?: GoFacts;
  /** CMake facts when `kinds` includes 'cmake' (Session 18). */
  cmake?: CmakeFacts;
  /** Human-readable provenance for /checks, prompts, and refusals. */
  evidence: string[];
  stamps: ManifestStamp[];
  /**
   * Machine toolchain facts, when the detection that produced this unit probed them (Session 18).
   * One probe per `detectWorkspace`, the same reference on every unit. Optional so every existing
   * caller and test literal keeps compiling — recipes treat absence as "not gated by a probe" and
   * degrade to the pythonToolRecipe pattern (fail at run, classify via signals).
   */
  toolchains?: ToolchainFacts;
}

/**
 * Session 16: the workspace as it actually is — one or more project UNITS, not one project rooted
 * at the workspace root. Discovery is bounded and never-throwing (the `detect.ts` discipline); a
 * unit exists only where a manifest exists, and `notes` records everything that was deliberately
 * NOT interpreted, so an ignored workspace glob is visible rather than silently absent.
 */
export interface DetectedWorkspace {
  root: string;
  /**
   * The workspace root, detected whether or not it qualifies as a unit. Kept because "there is no
   * project here" must stay an ANSWER rather than a refusal: resolving a kind against an empty
   * root yields the honest `no-recipe` unsupported that legitimately waives a declared gate, which
   * a call-level refusal would silently take away.
   */
  rootUnit: DetectedProject;
  /** Root unit first (when it has a manifest), then lexicographic by id. Deterministic — consent binds to it. */
  units: DetectedProject[];
  /** The UNION of every unit's stamps: the TOCTOU guard must notice a manifest appearing in ANY unit. */
  stamps: ManifestStamp[];
  notes: string[];
}

export interface CheckEffects {
  /** May write build output, caches, or coverage into the workspace. */
  writesOutputs: boolean;
  /** May reach the network. */
  network: boolean;
  /**
   * The command runs a script DEFINED BY THE WORKSPACE (a package.json script), so its real
   * effects are whatever that script does. Declaring this honestly is better than guessing
   * `network: false` for a line of text the workspace author controls — the approval prompt
   * says so verbatim.
   */
  workspaceAuthored: boolean;
}

/**
 * One recipe row. `argv` is the CANONICAL structured form: it is what gets quoted into the single
 * command string that is displayed, consented to, hashed for replay consent, executed, and
 * recorded — one string, one meaning, no divergence between what the human read and what ran.
 */
export interface CheckRecipe {
  id: string;
  kind: CheckKind;
  /** Ecosystem evidence says this row could run here. */
  applies(p: DetectedProject): boolean;
  /** A precondition that is NOT satisfied right now, stated for the human; null when ready. */
  unmetPrecondition(p: DetectedProject): string | null;
  argv(p: DetectedProject, scope: readonly string[]): string[] | null;
  /**
   * The workspace-authored script this recipe invokes, when it invokes one: the NAME, so the
   * resolver can bind consent to the UNTRUNCATED body sha (`scriptShas`) while `scripts` keeps
   * the bounded text for display.
   */
  bodyScript?(p: DetectedProject): string | null;
  timeoutMs: number;
  effects: CheckEffects;
}

export interface ResolvedCheck {
  kind: CheckKind;
  recipeId: string;
  /** The exact command string that will be executed (and that the approval prompt shows). */
  command: string;
  /**
   * For a workspace-authored script recipe: sha256 of the SCRIPT BODY the command invokes.
   * `npm run test` is a stable string whose behavior lives in package.json — consent bound to the
   * command alone would survive a rewrite of what that command actually does, which is precisely
   * the standing shell authority `run_command` is denied. Absent for harness-composed commands,
   * where the command string IS the behavior.
   */
  bodySha?: string;
  /** The project unit this resolves for, and the absolute directory the command runs in. */
  projectId: string;
  cwd: string;
  timeoutMs: number;
  effects: CheckEffects;
  /** Workspace-relative scope prefixes folded into the command, when the kind takes them. */
  scopePaths: string[];
}

/**
 * Why a kind cannot run. The REASON is load-bearing, not decoration: a gate the user approved may
 * only be waived when the PROJECT genuinely cannot run the kind ('no-recipe'/'precondition'). A
 * 'bad-request' — the caller asked for something malformed — must never retire a declared gate,
 * or a routine mistake would silently discharge verification the user asked for.
 *
 * `'precondition-curable'` (Session 16.5) is the third answer, and it exists because Session 16
 * changed the facts. "Dependencies are not installed" used to be a genuine project-capability
 * statement — the harness had no way to install anything, so the only honest reading was "this
 * project cannot be checked here". Now `project_setup install` exists, which makes it a TRANSIENT
 * state with a named cure. Left as a plain 'precondition' it waived the gate, so a session that
 * installed one half of a full-stack workspace and forgot the other could be accepted as COMPLETE
 * with its own evidence claiming the second project cannot be built or tested. A curable
 * precondition therefore keeps the gate PENDING and names the call that clears it.
 *
 * Old events carry no reason at all and keep the permissive reading; events written before this
 * distinction existed carry 'precondition' and also keep it. The narrowing applies going forward.
 */
export type UnsupportedReason = 'no-recipe' | 'precondition' | 'precondition-curable' | 'bad-request';

export interface UnsupportedCheck {
  kind: CheckKind;
  reason: string;
  why: UnsupportedReason;
}

export interface CheckResolution {
  resolved: ResolvedCheck[];
  unsupported: UnsupportedCheck[];
}

export interface CheckResult {
  kind: CheckKind;
  recipeId: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  /** Null only for `unsupported` — nothing was ever spawned. */
  termination: CommandTermination | null;
  durationMs: number;
  /** One bounded human line. */
  summary: string;
  /** Bounded, deterministic extraction; evidence, never a verdict. */
  findings: CheckFinding[];
  /**
   * Named signal ids that fired over the captured output. Persisted on the event so failure
   * classification stays derivable from the log alone after the full output is gone.
   */
  signals: string[];
}
