import type { CheckFinding, CheckKind, CheckStatus, CommandTermination } from '../types.js';

export { CHECK_KINDS, isCheckKind } from '../types.js';
export type { CheckFinding, CheckKind, CheckStatus } from '../types.js';

/**
 * Typed project checks (Session 12) — the contracts. A check is NOT "a command the model chose":
 * it is a harness-resolved RECIPE for a declared verification KIND, with declared applicability,
 * preconditions, effects, a timeout, and a normalized result. The model names kinds; the harness
 * names commands. That split is what makes a check gate mean something in the task graph.
 *
 * Deliberate omission: there is no dependency-install kind. Installing dependencies executes
 * third-party code with network access and is the one operation whose blast radius does not fit
 * "verify what we just built" — a missing toolchain is an honest `unsupported` precondition the
 * user resolves, never something the agent quietly performs.
 */

/** Ecosystems with recipe rows. Everything else detects as no kinds and refuses honestly. */
export type ProjectKind = 'node' | 'python';

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

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
  root: string;
  /** Ecosystems with usable evidence; empty ⇒ every check kind is unsupported. */
  kinds: ProjectKind[];
  packageManager: PackageManager | null;
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
  /** Human-readable provenance for /checks, prompts, and refusals. */
  evidence: string[];
  stamps: ManifestStamp[];
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
 */
export type UnsupportedReason = 'no-recipe' | 'precondition' | 'bad-request';

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
