import type { CommandTermination } from '../types.js';

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

export type CheckKind =
  | 'build'
  | 'test'
  | 'test-targeted'
  | 'typecheck'
  | 'lint'
  | 'format'
  | 'static-analysis';

/** Declaration order is the canonical order everywhere (schemas, views, reports, prompts). */
export const CHECK_KINDS: readonly CheckKind[] = [
  'build',
  'test',
  'test-targeted',
  'typecheck',
  'lint',
  'format',
  'static-analysis',
] as const;

export function isCheckKind(v: string): v is CheckKind {
  return (CHECK_KINDS as readonly string[]).includes(v);
}

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
  /** package.json scripts: name → command text (both bounded). */
  scripts: Record<string, string>;
  /** Interesting dependency names found in package.json deps/devDeps. */
  nodeTools: string[];
  /** Interesting tool names found in pyproject.toml / setup.cfg text. */
  pythonTools: string[];
  hasNodeModules: boolean;
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
  timeoutMs: number;
  effects: CheckEffects;
}

export interface ResolvedCheck {
  kind: CheckKind;
  recipeId: string;
  /** The exact command string that will be executed (and that the approval prompt shows). */
  command: string;
  timeoutMs: number;
  effects: CheckEffects;
  /** Workspace-relative scope prefixes folded into the command, when the kind takes them. */
  scopePaths: string[];
}

/** A kind that cannot run here, with the honest reason (no applicable row / precondition unmet). */
export interface UnsupportedCheck {
  kind: CheckKind;
  reason: string;
}

export interface CheckResolution {
  resolved: ResolvedCheck[];
  unsupported: UnsupportedCheck[];
}

/**
 * `pass`/`fail` come from the EXIT CODE of a process that genuinely exited; `error` covers every
 * non-exit termination (timeout, abort, spawn failure) and can never read as a passing check;
 * `unsupported` never ran at all. Output parsing may only enrich `summary`/`findings`/`signals` —
 * it must never move the verdict, or a check would become a narration.
 */
export type CheckStatus = 'pass' | 'fail' | 'error' | 'unsupported';

export interface CheckFinding {
  file?: string;
  line?: number;
  message: string;
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
