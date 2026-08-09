/**
 * All shared plain-data contracts for Agent CLI. No logic lives here — this is the single
 * place the kernel's interfaces are defined so modules depend on shapes, not on each other.
 */
import type { ZodType } from 'zod';
// Type-only import (erased at runtime): lets ExecSandbox.wrap be concretely typed without a
// runtime cycle with the exec substrate (which type-only-imports CommandTermination from here).
import type { ExecSpec } from './exec/run.js';

// ── Action taxonomy ────────────────────────────────────────────────────────────────────────
// Consequence classes from the constitution's safety policy. This is the "approval" axis; the
// OS "sandbox" axis (V0.4, `ExecSandbox` below) is deliberately separate — constitution
// principle 4: technical access limits and human confirmation policy must not be conflated.
export type ActionClass = 'observe' | 'reversible' | 'external' | 'destructive' | 'sensitive';

export type SessionMode = 'interactive' | 'non-interactive';

/**
 * How a managed command actually ended. 'exited' is the only termination with a real exit code;
 * killed commands (timeout/aborted) have NO exit code and must never read as a completed check.
 */
export type CommandTermination = 'exited' | 'timeout' | 'aborted' | 'spawn-error';

/**
 * Why a managed preview process ended (Session 13). 'crashed' = the process died without any
 * stop request (the exit listener is the single writer; a requested stop's reason always wins
 * over 'crashed' — the runManaged first-cause rule). 'start-failed' = it died before readiness
 * was ever observed. 'log-overflow' = the harness stopped it because its log file exceeded the
 * cap (a typed reason, never a silent truncation).
 */
export type PreviewEndReason = 'stopped' | 'crashed' | 'ttl-timeout' | 'log-overflow' | 'session-end' | 'start-failed';

// ── Tools ──────────────────────────────────────────────────────────────────────────────────
/** Absolute paths a tool will change. Declarable ⇒ snapshottable ⇒ reversible. */
export interface MutationPlan {
  paths: string[];
}

/** Narrowing-only policy additions from configuration (union across layers; never widening). */
export interface PolicyRules {
  /** Extra write-deny roots, resolved against the workspace root. */
  protectedPaths: string[];
  /** Literal lowercase basename substrings marking files as secret-like. */
  secretPatterns: string[];
  /** Extra lowercase name substrings dropped from child-process environments (cannot drop the core floor). */
  envExcludePatterns: string[];
  /**
   * Domains web research may never reach (Session 19). Narrowing only, in both directions that
   * matter: there is deliberately no permit-list counterpart, and a model-supplied include list
   * can never override an entry here. Matching respects label boundaries, so `evil.com` covers
   * `www.evil.com` but never `notevil.com`.
   */
  researchBlockedDomains: string[];
  /**
   * Hosts remote Git/GitHub delivery may never reach (Session 20). Narrowing only, on the same
   * terms as `researchBlockedDomains` and for the same reason: there is no permit-list
   * counterpart, because a permit list is a widening knob and this schema must be structurally
   * incapable of expressing one. An entry here refuses BOTH reads and mutations — an operator who
   * forbids a host forbids looking at it too.
   */
  remoteBlockedHosts: string[];
}

/**
 * Structured facts about a command execution, reported by the executing tool through
 * `ToolContext.reportCommand`. The runtime binds the callId when persisting, so a tool can
 * only ever produce evidence for its own call.
 */
export type CommandEvidence =
  | { kind: 'started'; pid: number; shell: string; cwd: string; timeoutMs: number; sandbox: 'none' | 'windows-lowil' }
  | {
      kind: 'ended';
      termination: CommandTermination;
      /** null unless the process genuinely exited (killed commands have no exit code). */
      exitCode: number | null;
      durationMs: number;
      killDetail?: string;
      drainTimedOut?: boolean;
    };

/**
 * Typed verification kinds (Session 12) — the shared vocabulary the plan schema, the event log,
 * the report, and the recovery catalogue all key on, so it lives with the contracts rather than
 * inside the checks module. There is deliberately NO dependency-install kind: installing runs
 * third-party code with network access, which is not "verify what we just built"; a missing
 * toolchain is an honest `unsupported` precondition the user resolves.
 */
export type CheckKind = 'build' | 'test' | 'test-targeted' | 'typecheck' | 'lint' | 'format' | 'static-analysis' | 'browser';

/**
 * Project-setup intents (Session 16). Deliberately NOT members of `CheckKind`: a plan must not be
 * able to declare `checks: ['install']`, and an install must never reach a reader that treats a
 * zero exit as verification. Setup and verification are different words for different promises.
 */
export const SETUP_ACTIONS = ['install', 'migrate', 'seed'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

/**
 * Harness-owned checkpoint ref kinds (Session 14): the lifecycle each ref gets at prune time.
 * 'task-base' (executor-group base, Session 11.5) and 'pre-integration' (before an
 * apply_task_changes with un-snapshot-covered prior changes) are session-scoped recovery
 * points, pruned at clean end / accept; 'delivery' (the /accept COMPLETE boundary) survives
 * as the durable audit anchor and is pruned only when superseded by a newer delivery
 * checkpoint. All live under refs/agent-cli/checkpoints/<sessionId>/<n> — user-visible and
 * prunable via `agent checkpoint list|prune`, never the user's branch history.
 */
export type HarnessRefKind = 'task-base' | 'pre-integration' | 'delivery';

/**
 * Declaration order is the canonical order everywhere (schemas, views, reports, prompts) —
 * APPEND-ONLY: a mid-list insert would churn every ordered surface. 'browser' (Session 13) runs
 * through browser_flow, never run_check (its enum deliberately excludes it): a flow is an
 * in-process browser drive against a managed preview, not a shell command.
 */
export const CHECK_KINDS: readonly CheckKind[] = [
  'build',
  'test',
  'test-targeted',
  'typecheck',
  'lint',
  'format',
  'static-analysis',
  'browser',
] as const;

export function isCheckKind(v: string): v is CheckKind {
  return (CHECK_KINDS as readonly string[]).includes(v);
}

/**
 * `pass`/`fail` come from the EXIT CODE of a process that genuinely exited; `error` covers every
 * non-exit termination (timeout, abort, spawn failure) and can never read as a passing check;
 * `unsupported` never ran at all. Output parsing may only enrich the summary/findings/signals.
 */
export type CheckStatus = 'pass' | 'fail' | 'error' | 'unsupported';

export interface CheckFinding {
  file?: string;
  line?: number;
  message: string;
}

/**
 * Structured facts about a typed check, reported through `ToolContext.reportCheck`. Same contract
 * as `CommandEvidence`: the runtime binds the callId, so a tool can only ever produce evidence
 * for its own call. `started` is emitted ONLY for a real spawn — an `unsupported` kind reports an
 * `ended` alone, because nothing ran.
 */
export type CheckEvidence =
  | {
      kind: 'started';
      check: CheckKind;
      recipeId: string;
      command: string;
      cwd: string;
      timeoutMs: number;
      /** Session 16: which project UNIT this ran in. Absent = the root/only project (pre-S16 reading). */
      projectId?: string;
      planTaskId?: string;
      scopePaths?: string[];
    }
  | {
      kind: 'ended';
      check: CheckKind;
      recipeId: string;
      status: CheckStatus;
      /** Session 16: which project UNIT this verified — what a `project`-scoped plan gate matches on. */
      projectId?: string;
      /** Why an `unsupported` kind could not run — only a PROJECT-capability reason may waive a gate. */
      unsupportedReason?: 'no-recipe' | 'precondition' | 'precondition-curable' | 'bad-request' | 'toolchain-unavailable';
      /** null unless the process genuinely exited (killed checks have no exit code). */
      exitCode: number | null;
      termination?: CommandTermination;
      durationMs: number;
      summary: string;
      /** Named signal ids — what keeps failure classification derivable from the log alone. */
      signals?: string[];
      findings?: CheckFinding[];
      planTaskId?: string;
      scopePaths?: string[];
    };

/**
 * Structured facts about a project-setup run (Session 16), reported through
 * `ToolContext.reportSetup`. Same callId-binding contract as every other evidence channel, and
 * the same `started`-means-a-real-spawn rule as checks: a resolution that never ran reports an
 * `ended` alone.
 *
 * Deliberately its OWN channel rather than a widened `CheckEvidence`. An install that exits 0 is
 * not verification, and sharing the check channel would put it in front of every reader that
 * treats `check.completed` as a verdict — the report's CHECKED correlation, the plan gates, the
 * repair ledger's regression proof.
 */
export type SetupEvidence =
  | {
      kind: 'started';
      action: SetupAction;
      projectId: string;
      recipeId: string;
      command: string;
      cwd: string;
      timeoutMs: number;
      packageManager?: string;
      /** The lockfile an install is pinned by, and the sha consent bound (null = unhashable). */
      lockfile?: string;
      lockfileSha?: string;
    }
  | {
      kind: 'ended';
      action: SetupAction;
      projectId: string;
      recipeId: string;
      status: SetupStatus;
      /** Why an `unsupported` action could not run — the check taxonomy, same meanings. */
      unsupportedReason?: 'no-recipe' | 'precondition' | 'precondition-curable' | 'bad-request' | 'toolchain-unavailable';
      /** null unless the process genuinely exited (a killed setup has no exit code). */
      exitCode: number | null;
      termination?: CommandTermination;
      durationMs: number;
      summary: string;
      signals?: string[];
    };

/** The setup verdict vocabulary. `ok` deliberately is not `pass`: a setup verifies nothing. */
export type SetupStatus = 'ok' | 'failed' | 'error' | 'unsupported';

/**
 * Structured facts about a managed preview process, reported through `ToolContext.reportPreview`
 * (Session 13). Same callId-binding contract as the other evidence channels. `started` is
 * emitted only after a REAL spawn (and after the crash-registry entry is written — the ordering
 * that keeps the resume note honest); `ready` only when the server actually answered an HTTP
 * probe. There is deliberately NO 'ended' arm here: `preview.ended` has exactly one writer, the
 * exit listener, which appends through a session-bound closure because a process death can
 * arrive outside any tool call.
 */
export type PreviewEvidence =
  | {
      kind: 'started';
      previewId: string;
      recipeId: string;
      command: string;
      cwd: string;
      pid: number;
      expectedPort?: number;
      /** Session 16.5 (additive): the project UNIT this server belongs to — what scopes a repair
       *  proof, so a failed `api` boot cannot be closed by a green flow against `web`. */
      projectId?: string;
    }
  | {
      kind: 'ready';
      previewId: string;
      url: string;
      port: number;
      waitedMs: number;
      probeDetail: string;
    };

/** One executed (or refused) step of a browser flow, as recorded evidence (Session 13). */
export interface BrowserStepRecord {
  n: number;
  kind: string;
  /** The step's target in display form (path, selector, text, label) — sanitized at render. */
  target?: string;
  ok: boolean;
  /** Typed failure taxonomy — timeout | navigation | assertion | runtime | protocol. */
  failure?: { class: string; detail: string };
}

/** A stored browser artifact: the sha IS the blob key under objects/. */
export interface BrowserArtifact {
  kind: 'screenshot' | 'trace';
  sha256: string;
  bytes: number;
  label: string;
  mediaType: string;
}

/**
 * Structured facts about one browser flow, reported through `ToolContext.reportBrowser`
 * (Session 13). One event per flow — the detail the paired check.completed (kind 'browser')
 * deliberately does not carry. Same callId-binding contract as every evidence channel.
 */
export interface BrowserFlowEvidence {
  flowName: string;
  previewId: string;
  status: CheckStatus;
  steps: BrowserStepRecord[];
  artifacts: BrowserArtifact[];
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  /** Off-origin subresource requests the app made — RECORDED, not confined (documented). */
  offOriginRequests: string[];
  finalUrl: string | null;
  /** A trace too large for the artifact budget was dropped; its size is the honest record. */
  traceOmittedBytes?: number;
  /** Declared screenshots dropped (budget exhausted or storage failed) — never silent (S16.5b). */
  screenshotsOmitted?: number;
}

/** Verdict of the deterministic render validators (Session 17). */
export interface ArtifactValidation {
  /** 'skipped' = the validator could not run (stated why in summary), never that it passed. */
  status: 'pass' | 'fail' | 'skipped';
  /** Structural mismatches AND layout notes, bounded AT EMIT (count + length). */
  findings: string[];
  /**
   * How many of those are structural FAILURES. Carried separately because `findings` is both
   * bounded and mixed: counting its length told acceptance "4 finding(s)" for one failure plus
   * three layout notes, and under-reported past the cap — in the one line whose job is stating
   * the failure honestly (S17 review).
   */
  failureCount: number;
  summary: string;
}

/**
 * Structured facts about document-artifact operations (Session 17), reported through
 * `ToolContext.reportArtifact`. 'rendered' = one produced artifact file (one event per format;
 * a format that could not render — no browser — emits NO event: there is no artifact to
 * describe, and the tool output states the skip). 'inspected' = one rasterization pass whose
 * page images are content-addressed blobs. Same callId-binding contract as every channel.
 */
export type ArtifactEvidence =
  | {
      kind: 'rendered';
      format: 'docx' | 'pdf';
      /** Workspace-relative artifact path. */
      path: string;
      /**
       * Absolute artifact path (S20.5, additive) — the same resolution the tool's `mutates()`
       * declares, so acceptance can match this render against later `file.mutated`/`undo.applied`
       * events (whose paths are absolute) when deciding a failing-validation caveat retired.
       */
      absPath?: string;
      sha256: string;
      bytes: number;
      pages?: number;
      /** Workspace-relative spec path + the spec content identity this render consumed. */
      specPath: string;
      specSha256: string;
      validation: ArtifactValidation;
      /**
       * The spec embedded workspace image files this harness did not produce. It gates the
       * INSPECT side's inherited consent: rasterizing such an artifact shows the model pixels
       * of arbitrary workspace bytes — exactly what `artifact.inspect-approval-required` asks
       * about — so the render's own auto-allow must not launder them (S17 review).
       */
      embeddedWorkspaceImages?: true;
      durationMs: number;
    }
  | {
      /**
       * A charged render attempt that produced NO artifact in any requested format (S20.5,
       * additive). Exists for one reader: `renderCapsFromEvents` — without it, an
       * all-formats-hard-failed call was charged live but invisible to the rebuild, refunding
       * render budget across a resume. Validation REFUSALS (the designed spec-revision loop)
       * are never charged and never emit this.
       */
      kind: 'render-failed';
      specPath: string;
      reasons: string[];
      durationMs: number;
    }
  | {
      kind: 'inspected';
      path: string;
      /** sha256 of the DOCUMENT bytes rasterized (the execute-time identity re-check's answer). */
      sha256: string;
      source: 'pdf';
      pages: { page: number; imageSha256: string; bytes: number; mediaType: string }[];
      warnings: string[];
    };

/** One recorded research finding: a claim, the sources behind it, and how well they agree. */
export interface ResearchNote {
  /** Assigned at CAPTURE (`${childSessionId}#${ordinal}`) — the child id does not exist earlier. */
  noteId: string;
  /** What was learned, as one falsifiable statement. */
  claim: string;
  /** The URLs the claim rests on. At least one; a claim with no source is not a finding. */
  sources: string[];
  /**
   * Whether independent sources agree. `single-source` is not a failure — it is a disclosure, and
   * a reader deciding how much weight to put on a claim needs it more than a confidence word.
   */
  corroboration: 'corroborated' | 'single-source' | 'sources-disagree';
  confidence: 'high' | 'medium' | 'low';
  /** Why this matters to the delegated task — the filter that keeps notes from becoming a dump. */
  relevance: string;
  /** ISO date the sources were retrieved. Research is perishable and must say when it was picked. */
  retrievedAt: string;
}

/**
 * Structured facts about bounded external reads (Session 19), reported through
 * `ToolContext.reportResearch`. Same callId-binding contract as every other channel: a tool can
 * only produce evidence for its own call, because the runtime — not the tool — stamps the id.
 *
 * `usage` exists for one reason worth stating: a researcher's searches happen in a CHILD session
 * with its own log, so the parent's event stream would otherwise show a research budget that
 * silently refilled on every resume. The delegate captures one usage record per task into the
 * PARENT log so the budget can be rebuilt from events.
 */
export type ResearchEvidence =
  | {
      kind: 'searched';
      provider: string;
      /** The query verbatim — the text that actually left the machine. */
      query: string;
      resultCount: number;
      /** Hosts of the admitted results, de-duplicated: the origins that reached a context. */
      hosts: string[];
      /** Sources the harness refused after the provider returned them, with reasons. */
      refused: { url: string; reason: string }[];
      credits: number;
      contentChars: number;
      durationMs: number;
      requestId?: string;
    }
  | {
      kind: 'extracted';
      provider: string;
      urls: string[];
      pageCount: number;
      /** URLs the PROVIDER could not retrieve — distinct from a harness refusal. */
      failed: { url: string; reason: string }[];
      credits: number;
      contentChars: number;
      durationMs: number;
      requestId?: string;
    }
  | {
      kind: 'findings';
      childSessionId: string;
      notes: ResearchNote[];
    }
  | {
      kind: 'usage';
      childSessionId: string;
      searches: number;
      extracts: number;
      credits: number;
      contentChars: number;
    };

/**
 * Structured facts about remote Git/GitHub delivery, reported through `ToolContext.reportRemote`.
 * Same callId-binding contract as every other channel.
 *
 * The two kinds are the session's whole thesis in the evidence model: looking at a remote and
 * changing one are different events, so that "what did this session actually publish" is answerable
 * by a filter rather than by reading prose. Neither ever carries a credential — the harness does
 * not possess one, and every string here is built from output that passed `scrubSecrets`.
 */
export type RemoteEvidence =
  | {
      kind: 'inspected';
      /** `auth` | `repository` | `refs` | `pulls` | `issues` | `runs` | `run`. */
      operation: string;
      host: string;
      /** `owner/repo`, or the remote name when the destination has no forge path. */
      target: string;
      /** The gh account in force, once an `auth` read has established one. Never the token. */
      account?: string;
      ok: boolean;
      /** Items returned (refs, pulls, issues, runs) — 0 for a single-object read. */
      itemCount?: number;
      /** Observation id, when this read produced one a mutation can bind to. */
      observationId?: string;
      /** Honest one-line failure text when `ok` is false. */
      detail?: string;
      durationMs: number;
    }
  | {
      kind: 'mutated';
      /** `push.branch` | `push.tag` | `release.create`. */
      operation: string;
      host: string;
      target: string;
      /** The exact remote ref/release this call changed. */
      exactTarget: string;
      account?: string;
      /** The oid the remote held before, as observed. Null when the ref did not exist. */
      beforeOid?: string | null;
      /** The oid pushed / the release tag. */
      afterOid?: string | null;
      /** The resulting object's URL, when the remote reported one. */
      url?: string;
      /** True when the effect was overwriting (force push, tag move). */
      overwrote: boolean;
      ok: boolean;
      /**
       * The harness RE-READ the remote afterwards and it matches. `ok && !verified` is a real and
       * important state: the command succeeded and the outcome could not be confirmed, which is
       * reported as unverified rather than rounded up to done.
       */
      verified: boolean;
      detail?: string;
      durationMs: number;
    };

/**
 * Typed failure classes (Session 12) — the vocabulary the recovery catalogue, the repair ledger,
 * the DAG gate, and the report all key on. Classification happens BEFORE any repair is planned;
 * `unknown` is a first-class member and a stopping condition, never a shrug that lets a loop
 * continue.
 */
export type FailureClass =
  | 'dependency-setup'
  | 'compile-type'
  | 'test-assertion'
  | 'lint-format'
  | 'runtime-process'
  | 'integration-conflict'
  | 'policy-approval'
  | 'timeout-resource'
  | 'preview-startup'
  | 'browser-verification'
  | 'unknown';

export const FAILURE_CLASSES: readonly FailureClass[] = [
  'dependency-setup',
  'compile-type',
  'test-assertion',
  'lint-format',
  'runtime-process',
  'integration-conflict',
  'policy-approval',
  'timeout-resource',
  'preview-startup',
  'browser-verification',
  'unknown',
] as const;

/**
 * Structured facts about a bounded repair, reported through `ToolContext.reportRepair`. There is
 * deliberately no `repair.ended`: an attempt's outcome is DERIVED from what happened after it (a
 * passing regression check, or a newer attempt for the same failure), so a crash between the work
 * and its recording cannot leave the ledger claiming something that was never proven.
 */
export type RepairEvidence =
  | {
      kind: 'attempted';
      target: string;
      failureClass: FailureClass;
      signature: string;
      hypothesis: string;
      hypothesisSha: string;
      scopePaths: string[];
      regressionChecks: CheckKind[];
      attempt: number;
      /** The project the failure occurred in, when the evidence named one (Session 16). */
      projectId?: string;
    }
  | {
      kind: 'escalated';
      target: string;
      failureClass: FailureClass;
      signature: string;
      reason: string;
    };

/** Review finding severities and confidences (Session 14) — the shared vocabulary of the
 *  structural review gate. Ordering in these arrays is the canonical render order. */
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['critical', 'high', 'medium', 'low'] as const;
export type ReviewConfidence = 'high' | 'medium' | 'low';

/**
 * One recorded reviewer finding (Session 14). Findings are TYPED AT THE SOURCE: a reviewer
 * child records each through the report_finding tool (zod-validated, bounded), the delegate
 * captures the batch into a `review.findings` event, and the gate reads ONLY these records —
 * reviewer prose remains narration. `findingId` is `${childSessionId}#${ordinal}`:
 * collision-free (session ids are structurally fresh), replay-stable (events rebuild the same
 * ids), and deliberately NOT content-derived — two findings sharing a title are two findings,
 * and merging them would be judgment, not derivation.
 */
export interface ReviewFinding {
  findingId: string;
  severity: ReviewSeverity;
  title: string;
  /** Workspace-relative path prefixes the finding claims to affect (validated at recording). */
  paths: string[];
  /** What was actually inspected — file:line references, the code read, the state observed. */
  evidence: string;
  /** The concrete failure scenario: inputs/state → wrong outcome. */
  scenario: string;
  confidence: ReviewConfidence;
  reproduction?: string;
}

/**
 * Structured triage facts reported through `ToolContext.reportReview` (Session 14; the
 * reportRepair pattern). Triage ANNOTATES findings — it never deletes one, and the fold
 * derives what an annotation is worth: an 'address' whose cited refs do not exist in the log
 * clears nothing, and 'accept' is valid only for medium/low severities (re-checked in the
 * fold, not just the tool schema). A refutation's evidence is recorded verbatim and rendered
 * as an UNVERIFIED MODEL CLAIM everywhere it surfaces.
 */
export type ReviewEvidence = {
  kind: 'triage';
  findingId: string;
  action: 'verify' | 'refute' | 'accept' | 'address';
  evidence: string;
  /** For 'address': the callIds and/or check recipeIds that contain the fix (existence-checked by the fold). */
  refs?: string[];
};

/**
 * Subagent role names and their access class — the POLICY fact table (V0.7). Data only: the
 * runtime builds full role contracts (tool registry, prompt, budget, approval mode) on top of
 * this in `runtime/roles.ts`. `decide()` consults THIS table and fails closed on any role that
 * is not in it; 'mutating-worktree' roles additionally require worktree isolation to exist.
 */
export type SubagentRoleName = 'explorer' | 'planner' | 'reviewer' | 'executor' | 'researcher';
/**
 * What a role may REACH. 'read-only' and 'mutating-worktree' are the workspace axis;
 * 'read-only-external' (Session 19) adds the network axis to a role that is still read-only in
 * the workspace. It is a third value rather than a boolean flag because the engine's ordering is
 * a total order over strictness — mutating beats external beats read-only — and a flag would let
 * a future role be both without anyone deciding which ask wins.
 */
export type SubagentRoleAccess = 'read-only' | 'read-only-external' | 'mutating-worktree';
export const SUBAGENT_ROLES: Record<SubagentRoleName, { access: SubagentRoleAccess }> = {
  explorer: { access: 'read-only' },
  planner: { access: 'read-only' },
  reviewer: { access: 'read-only' },
  executor: { access: 'mutating-worktree' },
  researcher: { access: 'read-only-external' },
};
/** Access class for a role name, or undefined when the role is unknown (⇒ deny, fail closed). */
export function subagentRoleAccess(role: string): SubagentRoleAccess | undefined {
  return Object.prototype.hasOwnProperty.call(SUBAGENT_ROLES, role)
    ? SUBAGENT_ROLES[role as SubagentRoleName].access
    : undefined;
}

/**
 * How a delegated subagent task ended (V0.6; 'user-stopped' added in V0.7 — the user answered
 * a forwarded approval with deny-&-stop, ending THAT child only, not the parent turn).
 * Session 11 (additive): 'cancelled' = task-scoped user cancellation (/cancel — this child only,
 * not the turn); 'stalled' = the harness supervisor cancelled a child stuck repeating the same
 * tool call (the bounded loop intervention).
 */
export type TaskStatus =
  | 'completed'
  | 'error'
  | 'budget-steps'
  | 'budget-tokens'
  | 'timeout'
  | 'aborted'
  | 'user-stopped'
  | 'cancelled'
  | 'stalled';

/** The harness-fixed budget a delegated task runs under (never model-controlled). */
export interface TaskBudget {
  maxSteps: number;
  timeoutMs: number;
  maxOutputTokens: number;
}

/**
 * Structured facts about a delegated task's lifecycle, reported by the delegating tool through
 * `ToolContext.reportTask`. Like CommandEvidence, the runtime binds the callId when persisting —
 * the runtime-bound callId + the unique childSessionId are the unforgeable parent↔child join.
 */
/** One file change captured from an executor task's worktree (V0.7). Paths are WORKSPACE-relative. */
export interface TaskChangeFile {
  relPath: string;
  kind: 'create' | 'modify' | 'delete';
  /** sha256 of the file's BASE bytes (worktree form, filters applied); null for creates. */
  baseSha256: string | null;
  /** sha256 of the AFTER bytes, stored as a content-addressed blob; null for deletes and oversize skips. */
  blobSha256: string | null;
  bytes: number;
  /** Content exceeded the per-file cap: recorded, never applied. */
  oversize?: boolean;
}

export type TaskEvidence =
  | {
      kind: 'started';
      role: string;
      childSessionId: string;
      budget: TaskBudget;
      /** The approved-plan task this child is bound to (Session 11, additive) — the DAG join key. */
      planTaskId?: string;
      /** The bound task's definition sha at spawn (Session 11.5, additive) — completed-state identity. */
      planTaskSha?: string;
    }
  | {
      /**
       * A harness supervision observation about a running child (Session 11): stall, repeated
       * identical calls, budget pressure, or a task-scoped cancellation. Bounded (≤6 per task);
       * bookkeeping only — it annotates evidence and never replaces the task's own status.
       */
      kind: 'supervision';
      childSessionId: string;
      what: 'stall' | 'loop' | 'budget-pressure' | 'cancelled';
      detail?: string;
    }
  | {
      kind: 'ended';
      childSessionId: string;
      status: TaskStatus;
      steps: number;
      usage: Usage;
      /** sha256 of the child's full (untruncated) final report text. */
      resultSha256: string;
      durationMs: number;
      /**
       * The task's role (S20.5, additive). Load-bearing for exactly one reader: a task whose
       * child NEVER EXISTED (executor setup failure, a startSession throw) has an empty
       * childSessionId and no task.started, so the caps fold reads the role from here to keep
       * charged attempts — including reviewer ROUNDS — from refunding across a resume.
       */
      role?: string;
    }
  | {
      /** An executor task's captured changes vs its base (V0.7) — the diff OUTLIVES the worktree. */
      kind: 'changes';
      childSessionId: string;
      baseOid: string;
      files: TaskChangeFile[];
      omittedCount?: number;
    }
  | { kind: 'worktree-created'; childSessionId: string; path: string; baseOid: string }
  | { kind: 'worktree-removed'; childSessionId: string; ok: boolean; detail?: string }
  | {
      /** apply_task_changes outcome (V0.7): which captured changes reached the parent workspace. */
      kind: 'applied';
      childSessionId: string;
      applied: string[];
      refused: { relPath: string; reason: string }[];
    }
  | {
      /**
       * The executor group's task-base checkpoint was created (Session 11.5) — creation
       * evidence for the resume-rebuilt prune list. Group-scoped (one per delegate call
       * with executors), so no childSessionId.
       */
      kind: 'base-checkpoint';
      ref: string;
      oid: string;
    }
  | {
      /**
       * A human answer to the delegate's own mid-execute ask (today only the task-base
       * large-untracked guard, S14.5 I7). Recorded through this channel because that ask goes
       * straight to the forwarded approver and bypasses executeCall — the one place
       * `approval.resolved` is otherwise appended — so the only human consent in the harness
       * with NO durable record was this one (S20.5 review). The runtime binds the delegate
       * call's id, so the record joins the group it authorized.
       */
      kind: 'approval-resolved';
      decision: 'allow' | 'deny' | 'deny-stop';
      scope: 'once' | 'session';
      source: 'user' | 'non-interactive' | 'dangerous-mode' | 'task-aborted';
    }
  | {
      /**
       * A harness workflow-transition checkpoint created by this call (Session 14), reported
       * through the onRefReady seam BEFORE update-ref (the event-before-ref contract). Today
       * only apply_task_changes creates one ('pre-integration', and only when un-snapshot-
       * covered change events exist since the last harness checkpoint); the /accept delivery
       * checkpoint appends its harness.checkpoint event directly (no tool call, no callId).
       */
      kind: 'harness-checkpoint';
      checkpointKind: 'pre-integration';
      ref: string;
      oid: string;
    }
  | {
      /**
       * A reviewer child's recorded findings, captured at task end (Session 14; the
       * task.changes capture precedent). ALWAYS emitted for a COMPLETED reviewer child —
       * `findings: []` is a recorded clean lens, and a completed reviewer with NO capture
       * event means the capture was lost (the round never happened; honest re-run). Findings
       * from a failed/timed-out lens are still captured as evidence, but that lens does not
       * qualify a round.
       */
      kind: 'review-findings';
      childSessionId: string;
      planTaskId?: string;
      /** A short sanitized label of the lens (from the task text) for report/render surfaces. */
      lens?: string;
      findings: ReviewFinding[];
    };

/**
 * Structured plan-document facts reported by the update_plan tool; the runtime binds the callId.
 * For canonical (Session 11) writes, `sha256` carries the plan CONTENT sha — the approval-binding
 * identity — while `prevSha256` stays the raw-bytes blob pointer of the replaced file.
 */
export interface PlanEvidence {
  planId: string;
  sha256: string;
  bytes: number;
  prevSha256: string | null;
  status: 'draft' | 'approved' | 'superseded' | 'unknown';
  /** Structural summary of the written task graph (Session 11, additive) — lets the report and
   *  resume render the DAG purely from events, without reading the plan file. Session 12 adds the
   *  declared check gate per task, for the same reason: the report must not read the plan file. */
  graph?: { id: string; role: string; dependsOn: string[]; checks?: CheckKind[] }[];
}

export interface ToolContext {
  workspaceRoot: string;
  stateDir: string;
  /** Present when configuration narrowed policy; read by the engine and the search tool. */
  rules?: PolicyRules;
  /** Turn cancellation. A long-running tool must observe it and terminate its own work. */
  signal?: AbortSignal;
  /** Live output chunks for RENDERING only — never persisted per-chunk; evidence is the completed result. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Evidence channel for command lifecycle facts (spawn/termination); persisted by the runtime. */
  reportCommand?: (e: CommandEvidence) => void;
  /** Evidence channel for delegated-task lifecycle facts; persisted by the runtime under this call's id. */
  reportTask?: (e: TaskEvidence) => void;
  /** Evidence channel for plan-document writes; persisted by the runtime under this call's id (V0.7). */
  reportPlan?: (e: PlanEvidence) => void;
  /** Evidence channel for typed-check lifecycle facts (Session 12); persisted under this call's id. */
  reportCheck?: (e: CheckEvidence) => void;
  reportSetup?: (e: SetupEvidence) => void;
  /** Evidence channel for bounded-repair ledger facts (Session 12); persisted under this call's id. */
  reportRepair?: (e: RepairEvidence) => void;
  /** Evidence channel for review-triage facts (Session 14); persisted under this call's id. */
  reportReview?: (e: ReviewEvidence) => void;
  /** Evidence channel for managed-preview lifecycle facts (Session 13); persisted under this call's id. */
  reportPreview?: (e: PreviewEvidence) => void;
  /** Evidence channel for browser-flow detail (Session 13); persisted under this call's id. */
  reportBrowser?: (e: BrowserFlowEvidence) => void;
  /** Evidence channel for document-artifact facts (Session 17); persisted under this call's id. */
  reportArtifact?: (e: ArtifactEvidence) => void;
  reportResearch?: (e: ResearchEvidence) => void;
  /** Evidence channel for remote Git/GitHub facts (Session 20); persisted under this call's id. */
  reportRemote?: (e: RemoteEvidence) => void;
  /**
   * Present only for SUBAGENT child sessions (Session 19): the runtime's own record of who spawned
   * this session and as what role. Set by `startSession` from `StartOptions.lineage`, the same
   * value that lands on `session.started` — so it is runtime state, not tool state and not model
   * input, and a child cannot claim a role it was not started as.
   *
   * The policy engine reads it to answer one question: is this call happening inside a subagent
   * whose SPAWN the engine already gated? That is what lets a researcher child search without an
   * approver attached — read-only roles auto-deny, so an ask inside one is a refusal, not a
   * prompt. The honest phrasing of the resulting rule is "the spawn was allowed", never "the
   * human approved": under --dangerously-allow-all no human approved anything.
   */
  lineage?: { parentSessionId: string; role: string };
  /**
   * The execution sandbox for this call. `enforced` tells the policy engine whether a genuine OS
   * boundary is active (a precondition for auto-running a command); a shell tool applies `wrap` to
   * its ExecSpec at spawn time. The runtime supplies an identity `wrap` for unsandboxed (approved)
   * calls, so tool code never branches on policy. Absent ⇒ no sandbox concept (e.g. file tools).
   */
  sandbox?: ExecSandbox;
}

/**
 * Per-call sandbox handle on ToolContext. Structurally minimal so `types.ts` stays logic-free;
 * the concrete backend lives in `src/sandbox/`. `ExecSpec` is intentionally referenced by shape
 * (Record) here to avoid a type cycle with the exec substrate.
 */
export interface ExecSandbox {
  mode: 'none' | 'windows-lowil';
  /** True only when a runtime probe confirmed the OS CAN confine sandboxed children (availability). */
  enforced: boolean;
  /** True when THIS call is actually running confined (an auto-run command inside the boundary). */
  active: boolean;
  /** Transform a managed-exec spec to run under the boundary; identity when this call is unsandboxed. */
  wrap(spec: ExecSpec): ExecSpec;
}

export interface ToolResult {
  ok: boolean;
  /** The exact string shown to the model (already truncated via the single truncation contract). */
  output: string;
  error?: string;
  exitCode?: number;
  durationMs: number;
  truncated: boolean;
  /** sha256 of the full untruncated output, present only when truncated. */
  fullOutputSha256?: string;
  /**
   * TRANSIENT (Session 11.5): the full pre-truncation output, attached ONLY by tools whose
   * output is otherwise unrecoverable (run_command's bounded capture, delegate group results
   * — never file reads, whose content lives on disk). The runtime spills it to a
   * content-addressed blob at the tool.completed choke point (skipped under any redaction)
   * and it is never persisted verbatim, never sent to the model.
   */
  fullOutput?: string;
  /**
   * TRANSIENT (Session 13): images the model should SEE in this result, already stored as
   * content-addressed blobs by the tool (the sha256 is the blob key). The runtime builds
   * image-bearing wire content from these and records METADATA on tool.completed — pixel bytes
   * never enter the log, and `output` must include a text pointer per image so a resumed
   * conversation (rebuilt from outputPreview alone) still references the evidence.
   */
  images?: { mediaType: string; dataBase64: string; sha256: string; label: string }[];
  /** How a command actually ended (run_command only). Absent exitCode + 'timeout'/'aborted' = killed. */
  termination?: CommandTermination;
  /** Honest kill mechanics when a kill was attempted (best-effort tree kill + verification probe). */
  killDetail?: string;
}

/**
 * The policy-visible shape of one resolved typed check (Session 12). Structural on purpose: this
 * contracts file stays dependency-free, and the gate only needs what it must SHOW to the human
 * and BIND consent to. The richer `ResolvedCheck` in `checks/types.ts` is assignable to it.
 */
export interface ResolvedCheckFact {
  recipeId: string;
  kind: string;
  /** The exact command string that will be executed — and that the approval prompt displays. */
  command: string;
  /** sha of the workspace-authored script body this command invokes; consent binds it too. */
  bodySha?: string;
  /**
   * Session 16: the project UNIT this runs in, and the ABSOLUTE directory it runs in. Both are
   * part of what a human consents to — `npm run test` means two different things in `web/` and
   * `api/` — so `projectId` is folded into the replay-consent identity and `cwd` is displayed
   * verbatim in the prompt. Absent = the workspace root, the pre-Session-16 meaning.
   */
  projectId?: string;
  cwd?: string;
  /**
   * The resolver's own sentence about what THIS resolution does (Session 16), folded verbatim
   * into the approval detail. The engine's reason is generic per rule; only the resolver knows
   * that this particular install has no lockfile and will therefore resolve versions fresh.
   */
  consequence?: string;
  timeoutMs: number;
  /**
   * Whether a `session`-scope answer may store replay consent for this row (Session 16). Absent =
   * true, the pre-existing behaviour for checks and previews. `false` makes the engine issue no
   * replay keys at all, which is also what hides `[s]` — a migration is not idempotent, so
   * "you approved this once" must never come to mean "you approved it again".
   */
  replayable?: boolean;
  effects: { writesOutputs: boolean; network: boolean; workspaceAuthored: boolean };
}

/**
 * The policy-visible shape of one document-artifact operation (Session 17). See `Tool.artifact`
 * for the two kinds and why each needs its own branch.
 */
export interface ArtifactFact {
  kind: 'render' | 'inspect';
  /**
   * 'render' only: the workspace paths this call will write. The engine validates them with the
   * same containment rule as declared mutations AND cross-checks them against `mutates()` —
   * the runtime snapshots from `mutates()`, so a divergence between the two would let outputs
   * escape snapshot coverage; it denies instead.
   */
  outputs?: readonly string[];
  /** 'render' only: whether this call will launch the headless browser (a PDF is requested). */
  usesBrowser?: boolean;
  /** 'inspect' only: the document path being rasterized. */
  path?: string;
  /**
   * 'inspect' only: whether `path` names an artifact THIS SESSION rendered from a spec that
   * embedded no workspace images (a pure scan of `artifact.rendered` events by
   * workspace-relative path). Such artifacts inherit the render's consent and auto-allow;
   * anything else asks. Execute re-verifies by CONTENT sha, so a file swapped after the render
   * refuses rather than riding the path claim.
   */
  sessionRendered?: boolean;
  /**
   * 'inspect' only: this session DID render `path`, but its spec embedded workspace images, so
   * consent is not inherited. Carried so the ask can state the true reason — a prompt saying
   * "a document the harness did not produce" about an artifact it just produced is the kind of
   * false record this project treats as a defect (found live, S17).
   */
  renderedWithEmbeddedImages?: boolean;
}

/**
 * The policy-visible shape of one bounded external-read call (Session 19). See `Tool.research`
 * for why this needs its own branch rather than riding any existing one.
 *
 * Everything here is HARNESS-COMPOSED, exactly like `ResolvedCheckFact.command`: the tool
 * classifies the model's raw input into targets and bounds, and the engine then decides over that
 * declaration. The model never authors a field of this object.
 */
export interface ResearchFact {
  kind: 'search' | 'extract';
  /** The single host this call contacts. Named in the decision reason and the approval prompt. */
  providerHost: string;
  /**
   * 'search' only: the query VERBATIM. This is the text that leaves the machine, so the approval
   * prompt must show it — a human consenting to "web_search" without seeing the query is
   * consenting to nothing (`describeCall`'s existing lesson, session.ts).
   */
  query?: string;
  /**
   * 'search' only: domains the call narrows to or excludes. Checked against the operator's
   * research denylist, which no model-chosen include list may override.
   */
  domains?: readonly string[];
  /** 'extract' only: one entry per requested URL, already classified by the tool. */
  targets?: readonly ResearchTarget[];
  /** The hard per-call bounds this call will obey; rendered verbatim into the approval detail. */
  bounds: ResearchBounds;
  /**
   * Why the SESSION research budget cannot admit this call, when it cannot. Pure over the shared
   * in-memory counter (the `browser.readyPreviews` pattern — memory flags, never I/O). The engine
   * denies rather than letting a tool decide to overspend.
   */
  budgetExhausted?: string;
  /** Remaining session allowance, so an approval prompt states what `[s]` is actually bounded by. */
  budgetRemaining?: string;
}

export interface ResearchTarget {
  /** The URL as the model supplied it, already sanitized for display. */
  url: string;
  /** The hostname, present only when the URL resolved to a usable public host. */
  host?: string;
  /**
   * Why this URL is not a citable source. Any refusal denies the WHOLE call: silently dropping
   * one URL from a batch would let a model learn nothing from naming an internal host, and a
   * partial success is harder to read than an explicit failure naming the offender.
   */
  refusedReason?: string;
}

export interface ResearchBounds {
  /** 'search' only: how many sources may come back. */
  maxResults?: number;
  /** Ceiling on retrieved characters admitted into any context by this call. */
  maxContentChars: number;
  timeoutMs: number;
  /** Estimated provider credits, ceiling-rounded — a budget must never under-charge itself. */
  credits: number;
}

/**
 * Why a remote call cannot be admitted. The tool computes it; the ENGINE turns it into a deny with
 * the matching rule id. Kept as a closed union so a new refusal cannot be introduced without a
 * matching rule — an unnamed refusal is indistinguishable from a bug.
 */
export type RemoteBlockKind =
  /** `gh` is missing, or the workspace has no remote at all. */
  | 'unavailable'
  /** `gh` has no usable credential for the host this call needs. */
  | 'unauthenticated'
  /** The destination host is not a GitHub host `gh` reported, so a gh-backed operation cannot apply. */
  | 'not-github'
  /** Remote, branch, account or repository identity could not be resolved to exactly one thing. */
  | 'ambiguous'
  /** The session's remote read/write allowance is spent. */
  | 'budget'
  /** A mutation named a target no observation covers. */
  | 'unobserved'
  /** The covering observation is older than the freshness bound. */
  | 'stale-observation'
  /** A harness-checked precondition does not hold (ref absent, relation unpushable, archived repo). */
  | 'precondition';

/**
 * How long a look at a remote stays admissible as the basis for a mutation (Session 20).
 *
 * Kernel-owned rather than pack-owned on purpose: the engine enforces it directly, and the engine
 * must not depend on a workflow pack (the `shared/domain.ts` argument). It is not a security
 * boundary — the remote can move a millisecond after we look — it bounds how stale the number a
 * human READ in the prompt is allowed to be. The real guarantees are downstream: execute re-reads
 * the ref before sending, and a force push carries the observed oid as a server-enforced lease.
 */
export const REMOTE_OBSERVATION_MAX_AGE_MS = 5 * 60_000;

/**
 * The destination a remote call names — resolved by the harness from the configured remote, never
 * a default the tool guessed. Rendered verbatim into the approval prompt and the event, because
 * "which repository did this publish to" is the question evidence has to be able to answer.
 */
export interface RemoteTargetFact {
  /** The git remote's configured name, e.g. 'origin'. */
  remoteName: string;
  host: string;
  /** `owner/repo` when the destination is a recognisable forge path; null otherwise. */
  slug: string | null;
  /** One fully-qualified line for a human: `github.com/owner/repo via remote 'origin'`. */
  display: string;
}

/**
 * The policy-visible shape of one remote READ (Session 20).
 *
 * Separate from `RemoteWriteFact` on purpose, and enforced as separate `FactKind`s: read and write
 * are not two modes of one capability, they are two capabilities, and the engine's existing
 * conflicting-contract rule then makes a tool that declares both an automatic deny. A read tool is
 * structurally incapable of publishing; a write tool is structurally incapable of being classified
 * as "just looking".
 *
 * MUST be pure: target and argv come from input plus the session's in-memory remote context; the
 * budget fields come from an in-memory counter (never the filesystem, never a probe).
 */
export interface RemoteReadFact {
  /** `auth` | `repository` | `refs` | `pulls` | `issues` | `runs` | `run`. */
  operation: string;
  target: RemoteTargetFact;
  /** The exact command that will run, harness-composed. What the prompt shows is what executes. */
  argvPreview: string;
  bounds: { maxItems?: number; timeoutMs: number };
  /** Why this call cannot be admitted, with the kind the engine maps to a rule id. */
  blocked?: string;
  blockedKind?: RemoteBlockKind;
  /** Remaining session allowance, so `[s]` states what it is actually bounded by. */
  budgetRemaining?: string;
}

/**
 * The policy-visible shape of one remote MUTATION (Session 20).
 *
 * Three things make this different from every other fact in this file, and all three are the
 * point of the session:
 *
 *  1. **It is bound to an observation.** `observation` carries the id, age and oids of the live
 *     look at the remote that the `effect` was computed from. Absent or stale ⇒ the engine DENIES
 *     (the `browser.no-preview` precedent). A publish may not be reasoned about from memory.
 *  2. **It is never granted.** The engine does not pass this branch through `applyGrant`, the
 *     prompt offers no `[s]`, and the runtime stores nothing on a session answer. Each publish
 *     names a different target and a different effect, so a class-scoped grant could only ever
 *     mean "publish whatever you like this session" — the exact inversion this capability exists
 *     to prevent.
 *  3. **It states the local evidence without depending on it.** `localEvidence` puts the local
 *     verification state in front of the human. It is deliberately NOT a precondition: making a
 *     green gate a requirement would make a green gate an authorization, and local completion must
 *     never imply permission to publish.
 */
export interface RemoteWriteFact {
  /** `push.branch` | `push.tag` | `release.create`. */
  operation: string;
  target: RemoteTargetFact;
  /** The exact thing being changed on the remote: `refs/heads/x`, `refs/tags/v1`, `release v1`. */
  exactTarget: string;
  /** True when the effect overwrites or discards remote state (a force push, a tag move). */
  overwrites: boolean;
  /** Machine-derived effect lines, computed from the bound observation. Rendered verbatim. */
  effect: readonly string[];
  /** The exact command that will run, harness-composed. */
  argvPreview: string;
  observation?: { id: string; ageMs: number; remoteOid: string | null; localOid: string };
  /** One line of local verification state, folded in memory from the session's own events. */
  localEvidence?: string;
  blocked?: string;
  blockedKind?: RemoteBlockKind;
  /** Remaining session write allowance — a runaway bound, never a consent ceiling. */
  budgetRemaining?: string;
  timeoutMs: number;
}

export interface Tool<I = unknown> {
  name: string;
  /** Sent to the model. */
  description: string;
  /** Single source of truth for input validation; the JSON Schema sent to the model is derived from it. */
  schema: ZodType<I>;
  /**
   * Absolute paths this call will mutate, or null when side effects are undeclarable
   * (run_command) — a null plan can never be auto-classified `reversible`. Receives the same
   * context the policy gate uses so both resolve paths through one deterministic validator.
   */
  mutates(input: I, ctx: ToolContext): MutationPlan | null;
  /** Paths this call reads, so the policy gate can classify out-of-workspace / secret reads. */
  readsPaths?(input: I): string[];
  /** For a shell tool: the raw command string, so the policy gate labels and always-asks it. */
  command?(input: I): string;
  /**
   * Declares that this tool delegates work to bounded child sessions (V0.6; batched in V0.7 —
   * one call may spawn a PARALLEL GROUP, so the fact names every role in the group). A policy
   * FACT: decide() gates it in an explicit fail-closed branch BEFORE every other classification
   * (a command-less, mutation-less tool would otherwise auto-allow as observe — the S6 trap),
   * a tool may never declare both `delegates` and `command`, and the strictest member governs
   * the whole group. A throwing `delegates` is a deny, never an escape.
   */
  delegates?(input: I): { roles: readonly string[] };
  /**
   * Declares that this tool writes the harness-owned PLAN DOCUMENT (V0.7) — state-dir bytes the
   * file tools cannot reach. A policy FACT with its own explicit fail-closed branch: without it
   * a mutation-less, command-less tool writing persistent harness state would auto-classify as
   * observe (the S6 trap again). Never combinable with `command` or `delegates`.
   */
  planDoc?(input: I): { action: 'update' };
  /**
   * Declares that this tool runs HARNESS-RESOLVED project checks (Session 12). A policy FACT with
   * its own explicit fail-closed branch, for the same S6-trap reason as `delegates`/`planDoc`, and
   * for one more: a check spawns a real process, so it must never reach the observe fall-through.
   *
   * The distinction from `command` is the whole trust argument: a `command` string comes from
   * untrusted model text, while every `resolved.command` here was composed by the harness's recipe
   * table from the detected project. That is what makes per-command replay consent honest — the
   * consent binds a byte-identical string the harness will regenerate, not a label over model
   * output. Never combinable with `command`, `delegates`, or `planDoc`; a throw is a deny.
   *
   * MUST be pure: `decide()` is pure over (tool, input, ctx, grants), so the fact reads a project
   * snapshot captured earlier — never the filesystem.
   *
   * `manage` (Session 13): an empty resolution that is a MANAGE action on a session-owned
   * resource (a preview stop/status), not a "nothing could run" outcome — the decision record
   * must not classify killing a process as observe.
   */
  check?(input: I): { resolved: readonly ResolvedCheckFact[]; manage?: boolean };
  /**
   * Declares that this tool DRIVES A BROWSER against a harness-managed preview (Session 13). A
   * policy FACT with its own fail-closed branch: a flow executes application JavaScript and
   * clicks real UI, so it must never reach the observe fall-through (the S6 trap). MUST be pure
   * over tool-held state (the live preview handles — memory flags, never I/O). `previewBound`
   * is the whole decision: a flow bound to a RUNNING consented preview inherits that consent
   * (the approval prompt said browser verification was included); anything else is denied —
   * there is deliberately no ask path for arbitrary-origin browsing this session.
   */
  browser?(input: I): {
    flowName: string;
    stepCount: number;
    previewBound: boolean;
    /** The id the call asked for, when it named one — so a denial can distinguish "you named a
     *  preview that is not ready" from "you named none and several are". */
    requestedPreviewId?: string;
    /**
     * Every READY preview at decision time. A denial that cannot name what is running told a model
     * with two live servers to "start one first", whose most plausible response is to start a
     * third. Pure over tool-held state, like the rest of this fact.
     */
    readyPreviews?: readonly { previewId: string; projectId: string }[];
  };
  /**
   * Declares that this tool re-reads EVIDENCE THIS SESSION RECORDED (Session 13: view_image).
   * A policy FACT so the decision log stays honest — the observe fall-through's "read-only
   * workspace access" reason would be false for state-dir evidence bytes. `admitted` is the
   * fact-level answer to "did this session's browser artifacts record that sha" (pure over the
   * session's in-memory events): the engine DENIES an un-admitted sha, so the decision record
   * never claims an allowed re-read of evidence that was refused. The tool re-checks at
   * execute as defense in depth.
   */
  evidenceRead?(input: I): { sha256: string; admitted?: boolean };
  /**
   * Declares a DOCUMENT-ARTIFACT operation (Session 17) — the documents workflow pack's two
   * consequence shapes, each of which would otherwise misclassify:
   *
   * - kind 'render': produces DOCX/PDF artifacts in the workspace from a session-authored spec.
   *   Writing files alone would auto-allow through the mutation branch — but that branch's
   *   recorded reason ("in-workspace file change") is FALSE for a call that also launches a
   *   headless browser to print the PDF, and the engine structurally never evaluates
   *   `readsPaths` on a tool with a non-empty mutation plan, so the spec's image reads MUST be
   *   (and are) enforced at execute. The fact's own rule says both truths out loud.
   * - kind 'inspect': rasterizes document pages to pixels in a headless browser. Command-less
   *   and mutation-less, it would auto-allow as observe — the S6 trap with a browser behind it.
   *
   * MUST be pure: `outputs`/`path` come from input, `sessionRendered` from an in-memory event
   * scan (whether a path-matching `artifact.rendered` exists) — never the filesystem. The tool
   * re-verifies content identity at execute (the preview-drift pattern): decide-time admission
   * is a PATH claim, execute compares the file's sha against the recorded artifact.
   */
  artifact?(input: I): ArtifactFact;
  /**
   * Declares a BOUNDED EXTERNAL READ (Session 19) — the only capability in this harness that
   * sends anything to a third party at the model's request.
   *
   * It needs its own fail-closed branch for the S6-trap reason every fact above it documents: a
   * command-less, mutation-less tool auto-allows as `observe` with the recorded reason
   * "read-only workspace access", which for a call that ships a model-authored query to a remote
   * service is not merely imprecise — it is false in the one direction that matters. Reading is
   * not the consequence here; SENDING is. Query text can carry whatever the conversation
   * contained, and the network is the one boundary the sandbox explicitly does not confine.
   *
   * The consent model is the budget. A human approving research approves a bounded mission, not
   * an open line: `bounds` states the per-call ceilings and `budgetRemaining` states the session
   * ceilings, and both are rendered into the prompt. `budgetExhausted` is a DENY, not advice —
   * spending is the engine's decision, never the tool's.
   *
   * MUST be pure: targets and bounds come from input, budget fields from an in-memory counter
   * (never the filesystem, never a probe). Never combinable with any other fact; a throw is a
   * deny. The tool re-enforces every bound at execute, because a decision is a claim about what
   * WILL happen and only execute knows what did.
   */
  research?(input: I): ResearchFact;
  /**
   * Declares a REMOTE READ (Session 20) — a call that contacts a git remote or the GitHub API
   * under the user's existing credential.
   *
   * Its own branch for the S6-trap reason every fact above it documents, plus one specific to this
   * capability: a remote read authenticates. It tells a third party which account is looking at
   * which repository, and it spends that account's rate limit. `observe`/"read-only workspace
   * access" is false about all of it.
   *
   * Consent is the S19 shape: the first read asks, `external` and grantable, and `[s]` means "the
   * bounded remote-read capability is authorized this session", bounded by a real counter rather
   * than by good intentions.
   *
   * MUST be pure, and never combinable with any other fact — `remoteWrite` least of all: the whole
   * point of two facts is that the engine's conflicting-contract rule makes a tool that could do
   * both a deny rather than a judgement call.
   */
  remoteRead?(input: I): RemoteReadFact;
  /**
   * Declares a REMOTE MUTATION (Session 20) — publishing a ref or a release to a third party.
   *
   * See `RemoteWriteFact` for the three properties that make this branch different from every
   * other: it is bound to a live observation, it is never session-granted, and it shows the local
   * verification state without ever treating it as authority.
   *
   * MUST be pure: the effect is derived from the bound observation held in memory, never from a
   * probe. The tool re-verifies against the live remote at execute — a decision is a claim about
   * what WILL happen, and between the claim and the act a human was reading a prompt.
   */
  remoteWrite?(input: I): RemoteWriteFact;
  /**
   * Optional DISPLAY-ONLY context lines for the approval prompt (V0.7.1) — e.g. plan-approval
   * state at an executor spawn. Folded into the request's `detail`, so the lines inherit the
   * prompt renderer's sanitization and line cap; NEVER consulted by policy (the decision is
   * already made when this runs), and a throw yields no lines rather than blocking the ask.
   */
  approvalContext?(input: I): string[];
  /** Optional hook to strip secret content from the result before it is persisted to the log. */
  redactForLog?(result: ToolResult, saltHex: string): ToolResult;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

// ── Policy ─────────────────────────────────────────────────────────────────────────────────
export interface PolicyDecision {
  classification: ActionClass;
  decision: 'allow' | 'ask' | 'deny';
  /** Matched rule id, e.g. 'path.outside-workspace', 'cmd.always-ask', 'mutation.snapshot-ok'. */
  rule: string;
  /** One human sentence, shown in the approval prompt and logged. */
  reason: string;
  /** Whether a pre-mutation snapshot must be captured before execution. */
  requiresSnapshot: boolean;
  /** True when the action will not be undoable (e.g. snapshot failed / file too large). */
  noUndo?: boolean;
  /** True when the model's read result must be redacted before persistence. */
  redactOutput?: boolean;
  /**
   * For a shell command: where it must run. 'sandbox' = an auto-run command that MUST be OS-confined
   * (the enforcement backing an auto-allow — never run unconfined). 'unsandboxed' = a human-approved
   * command that runs with full privilege (the user accepted the risk). Absent for non-command tools.
   */
  execBoundary?: 'sandbox' | 'unsandboxed';
  /**
   * For a typed check (Session 12): the replay-consent key of every resolved command in the call
   * — `sha256(recipeId + '\n' + command)`. A `session`-scope approval stores exactly these keys,
   * and a later call whose keys are ALL already consented allows without asking. Deliberately not
   * an `ActionClass` grant: consent binds the byte-identical harness-resolved command, so an
   * edited manifest that changes the command produces a new key and asks again.
   */
  checkReplayKeys?: string[];
}

// ── Approval ───────────────────────────────────────────────────────────────────────────────
export interface ApprovalRequest {
  callId: string;
  tool: string;
  classification: ActionClass;
  /**
   * 'command' = a shell command: the classification is only a best-effort LABEL, and the prompt
   * must say so. 'check' = a harness-resolved typed check (Session 12): the prompt shows every
   * resolved command verbatim and offers replay consent for those exact commands, NOT a
   * class-scoped session grant. 'preview' = a harness-resolved preview server (Session 13):
   * same replay-consent shape as 'check', but the prompt must state the different CONSEQUENCE —
   * the process keeps running and binds a local port.
   * 'setup' = a harness-resolved dependency install / migration / seed (Session 16): the prompt
   * must state the third distinct consequence — third-party code and network for an install,
   * un-undoable local data change for a migration — and offers `[s]` only for the install.
   * 'research' = a bounded external read (Session 19): the fourth distinct consequence, and the
   * only one that is not about running something HERE. Nothing executes and nothing changes on
   * this machine; text goes OUT, to one named host, and what comes back is untrusted. The prompt
   * must show what is being sent, name the host, and state that a session answer is bounded by
   * the session research budget rather than open-ended.
   * 'remote-read' / 'remote-write' = remote Git/GitHub delivery (Session 20), and they are TWO
   * kinds rather than one with a mode for the same reason the policy facts are two: the prompts
   * must not be able to look alike. A read offers `[s]` bounded by the session read allowance; a
   * write offers NO `[s]` at all, shows the exact destination and the machine-derived effect, and
   * says plainly that nothing here can undo it.
   */
  kind?: 'command' | 'check' | 'preview' | 'setup' | 'research' | 'remote-read' | 'remote-write';
  /** kind 'check'/'preview'/'setup': how many distinct commands a session-scope answer would consent to re-run. */
  checkCount?: number;
  /** One-line summary (command string or "edit src/x.ts"). */
  summary: string;
  /** Multi-line detail (edit preview, full command). */
  detail: string;
  reason: string;
  noUndoWarning?: boolean;
  /**
   * Present when this request was FORWARDED from a delegated child task (V0.7): the prompt
   * must attribute it to the task so the human knows which agent is asking and where it runs.
   */
  taskContext?: { childSessionId: string; role: string };
}
export interface ApprovalOutcome {
  decision: 'allow' | 'deny' | 'deny-stop';
  /** 'session' grants apply to future (tool, class) matches; run_command is never granted. */
  scope: 'once' | 'session';
  /** 'task-aborted' = a forwarded ask auto-denied because its task died first (V0.7). */
  source: 'user' | 'non-interactive' | 'dangerous-mode' | 'task-aborted';
}
export type Approver = (req: ApprovalRequest) => Promise<ApprovalOutcome>;

// ── Provider wire types (mirror the Anthropic shape; MockProvider needs no SDK) ─────────────
/**
 * Parts of a structured tool_result (Session 13). `sha256`/`label` on an image part are
 * HARNESS-INTERNAL enrichment — elision uses them to build an honest replacement marker
 * (`objects/<sha>`); the provider mapping sends only mediaType + data to the wire. A text part
 * with `elisionMarker` is a harness-authored image replacement, never original tool output —
 * the whole-result marker must not digest or size it as if the tool had said it.
 */
export type ToolResultPart =
  | { type: 'text'; text: string; elisionMarker?: true }
  | { type: 'image'; mediaType: string; dataBase64: string; sha256?: string; label?: string };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string | ToolResultPart[]; isError?: boolean }
  /**
   * Opaque provider reasoning (Session 15). `payload` is the provider-NATIVE artifact, verbatim:
   * an Anthropic thinking/redacted_thinking block, an OpenAI Responses reasoning item (incl.
   * encrypted_content), or a reasoning_content string (deepseek/kimi/glm). Opaque BY CONTRACT —
   * only the adapter that emitted it may interpret it. An adapter replays a block only when
   * `providerName`+`model` match its own request (and within that provider's documented replay
   * scope); otherwise the block is dropped — a deterministic, documented degrade. `text` is an
   * optional display copy and is never re-sent as assistant text.
   */
  | { type: 'reasoning'; providerName: string; model: string; payload: unknown; text?: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface Usage {
  /** Uncached input tokens billed for the request (the API excludes cache reads from this). */
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache accounting (V0.5, additive): absent on providers/logs without caching. */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Reasoning-token breakdown (Session 15, additive): absent on providers without one.
   *  Reasoning tokens are INCLUDED in outputTokens everywhere they are billed as output. */
  reasoningTokens?: number;
}

export interface ProviderTurn {
  blocks: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

export interface Provider {
  readonly name: string;
  /**
   * `onText` receives assistant text deltas for live rendering; optional.
   * `signal` aborts an in-flight request (the caller detects an abort via `signal.aborted`
   * after a throw — never via provider-specific error classes).
   */
  complete(req: ProviderRequest, onText?: (delta: string) => void, signal?: AbortSignal): Promise<ProviderTurn>;
  /**
   * Credential-redacted description of the network path (e.g. "proxy …@host (via https_proxy)").
   * Session 15: replaces the former `instanceof AnthropicProvider` banner checks. Optional —
   * the mock provider has no network path.
   */
  describeTransport?(): string;
}

// ── Event log ──────────────────────────────────────────────────────────────────────────────
export const EVENT_SCHEMA_VERSION = 1;

export type MutationKind = 'create' | 'modify' | 'delete';

export interface RecordedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type EventBody =
  | {
      type: 'session.started';
      sessionId: string;
      workspaceRoot: string;
      model: string;
      mode: SessionMode;
      providerName: string;
      argv: string[];
      /** Present only on subagent child sessions (V0.6): who spawned this session, and as what. */
      lineage?: { parentSessionId: string; role: string };
    }
  | {
      type: 'session.resumed';
      priorSeq: number;
      orphanedCallIds: string[];
      unknownPostStateCallIds: string[];
    }
  | {
      /**
       * The session's provider/model identity changed mid-lifecycle (Session 15, additive).
       * Fresh-session identity stays on `session.started`; readers fold newest-wins. NEVER
       * carries a credential: `keyEnv` is the env var NAME whose presence enabled the switch,
       * `baseUrlHost` is the effective API host (visible so a *_BASE_URL override is auditable).
       */
      type: 'provider.changed';
      from: { providerName: string; model: string };
      to: { providerName: string; model: string };
      source: 'user-command' | 'resume';
      keyEnv?: string;
      baseUrlHost?: string;
      /** How the key was checked: a live models-list probe, key presence alone (no list
       *  endpoint), or a probe that failed non-definitively (network) and proceeded. */
      verification: 'models-list' | 'presence-only' | 'unverified-network';
    }
  // Session 10 (additive): inventorySha256 digests the sorted file SET independent of the
  // rendered text (the CODEBASE staleness basis); sha256 stays "exactly the text the model saw".
  | {
      type: 'workspace.mapped';
      fileCount: number;
      truncated: boolean;
      chars: number;
      sha256: string;
      inventorySha256?: string;
      indexedFiles?: number;
      indexState?: 'full' | 'partial';
    }
  | { type: 'user.message'; text: string }
  | {
      type: 'assistant.message';
      text: string;
      toolCalls: RecordedToolCall[];
      stopReason: StopReason;
      usage: Usage;
      /** Opaque provider reasoning blocks in stream order (Session 15, additive). Persisted
       *  VERBATIM: resume must be able to replay them byte-faithfully (kimi/deepseek 400 on a
       *  tool-looping assistant message whose reasoning was altered or dropped mid-loop). */
      reasoning?: { providerName: string; model: string; payload: unknown; text?: string }[];
    }
  | { type: 'tool.requested'; callId: string; tool: string; input: unknown }
  | {
      type: 'policy.decision';
      callId: string;
      classification: ActionClass;
      decision: 'allow' | 'ask' | 'deny';
      rule: string;
      reason: string;
    }
  | {
      type: 'approval.resolved';
      callId: string;
      decision: 'allow' | 'deny' | 'deny-stop';
      scope: 'once' | 'session';
      /** 'task-aborted' (V0.7, additive): a forwarded child ask auto-denied because its task died first. */
      source: 'user' | 'non-interactive' | 'dangerous-mode' | 'task-aborted';
    }
  | {
      type: 'snapshot.created';
      callId: string;
      files: { path: string; beforeSha256: string | null; bytes: number }[];
    }
  | { type: 'snapshot.failed'; callId: string; path: string; error: string }
  | {
      type: 'file.mutated';
      callId: string;
      path: string;
      kind: MutationKind;
      beforeSha256: string | null;
      afterSha256: string | null;
      createdDirs: string[];
      /** Line diffstat for this mutation (V0.5, additive; absent for binary/huge/no-op changes). */
      linesAdded?: number;
      linesRemoved?: number;
      /**
       * S14.5 (additive): the write happened but reading the resulting bytes back FAILED, so
       * `afterSha256` is null for an unknown reason rather than a deletion. The mutation is
       * recorded regardless — undo restores from the recorded pre-image — and surfaces carry
       * the honest wording instead of silently reading as "deleted" or, worse, as never having
       * run (the pre-fix behavior lost the event entirely when the readback threw).
       */
      postStateUnverified?: true;
      postStateError?: string;
    }
  | {
      type: 'tool.completed';
      callId: string;
      ok: boolean;
      outputPreview: string;
      exitCode?: number;
      durationMs: number;
      truncated: boolean;
      fullOutputSha256?: string;
      /**
       * The truncated-away bytes were preserved as the content-addressed blob
       * objects/<fullOutputSha256> (Session 11.5, additive). "Captured" output, honestly:
       * for a command whose live capture was itself capped, the blob holds the capped
       * stream, not everything the process printed.
       */
      fullOutputSaved?: true;
      /**
       * Image parts CAPTURED in this result (Session 13, additive) — METADATA ONLY. The pixel
       * bytes live as content-addressed blobs (objects/<sha256>); a session log line never
       * contains base64, and resume rebuilds from outputPreview, so a resumed model gets the text
       * pointer instead of the pixels (it saw them live; replaying them would resend what the
       * original turn already consumed).
       *
       * Whether the model actually SAW them is `imagesWithheld` (Session 15) — do not read this
       * field alone as "the model looked at these".
       */
      images?: { sha256: string; mediaType: string; bytes: number; label: string }[];
      /**
       * The captured images were deliberately NOT sent to the model because the selected model has
       * no image input (Session 15, additive). The blobs and metadata above are unchanged — only
       * the wire view degraded, and this is the durable record of that honest degradation.
       */
      imagesWithheld?: true;
    }
  | {
      /** A shell command actually spawned (post-approval). Distinct from tool.requested: this is execution. */
      type: 'command.started';
      callId: string;
      pid: number;
      shell: string;
      cwd: string;
      timeoutMs: number;
      /** The execution boundary this command actually ran under (evidence of enforcement per command). */
      sandbox?: 'none' | 'windows-lowil';
    }
  | {
      /** How the spawned command ended. Killed commands (timeout/aborted) have exitCode null. */
      type: 'command.ended';
      callId: string;
      termination: CommandTermination;
      exitCode: number | null;
      durationMs: number;
      killDetail?: string;
      drainTimedOut?: boolean;
    }
  /**
   * Typed check lifecycle (Session 12, additive). `check.started` marks a REAL spawn — the same
   * meaning `command.started` carries, so crash replay and the acceptance work-boundary treat
   * them alike. A kind that could not run records only `check.completed` with status
   * 'unsupported': nothing was spawned, so claiming a start would be false evidence.
   */
  | {
      type: 'check.started';
      callId: string;
      check: CheckKind;
      recipeId: string;
      /** The exact harness-resolved command string — what the human approved and what ran. */
      command: string;
      cwd: string;
      timeoutMs: number;
      /**
       * Session 16 (additive): the project UNIT this ran in. Absent in every pre-S16 log and in
       * every single-project workspace, where it means exactly what it always meant — the one
       * project at the workspace root.
       */
      projectId?: string;
      /** The plan task this run was declared against; a reporting LABEL, never the gate itself. */
      planTaskId?: string;
      scopePaths?: string[];
    }
  | {
      type: 'check.completed';
      callId: string;
      check: CheckKind;
      recipeId: string;
      status: CheckStatus;
      /** Session 16 (additive): the project UNIT verified — a `project`-scoped gate matches on it. */
      projectId?: string;
      /** Why an `unsupported` kind could not run — only a PROJECT-capability reason may waive a gate. */
      unsupportedReason?: 'no-recipe' | 'precondition' | 'precondition-curable' | 'bad-request' | 'toolchain-unavailable';
      exitCode: number | null;
      termination?: CommandTermination;
      durationMs: number;
      summary: string;
      /** Named signals — classification stays derivable from the log after the output is gone. */
      signals?: string[];
      findings?: CheckFinding[];
      planTaskId?: string;
      scopePaths?: string[];
    }
  /**
   * Project setup (Session 16, additive): dependency installation, migrations and seeding.
   *
   * A NEW event type on purpose. Reusing `check.*` would have been one line shorter and would
   * have taught every existing reader a falsehood: `collectPassingEvidence` marks a file CHECKED
   * when a check exited 0, the plan gates count a passing kind as verification, and the repair
   * ledger accepts one as proof a defect is fixed. An install exiting 0 means dependencies were
   * fetched. It is work, and it is recorded as work — it is not evidence that anything is correct.
   *
   * `setup.started` is emitted from `onSpawn` ONLY, so it means exactly what `command.started`
   * and `check.started` mean: a process really started.
   */
  | {
      type: 'setup.started';
      callId: string;
      action: SetupAction;
      projectId: string;
      recipeId: string;
      /** The exact harness-resolved command — what the human approved and what ran. */
      command: string;
      cwd: string;
      timeoutMs: number;
      packageManager?: string;
      /** The lockfile name and the sha consent bound; absent when the project has no lockfile. */
      lockfile?: string;
      lockfileSha?: string;
    }
  | {
      type: 'setup.completed';
      callId: string;
      action: SetupAction;
      projectId: string;
      recipeId: string;
      status: SetupStatus;
      unsupportedReason?: 'no-recipe' | 'precondition' | 'precondition-curable' | 'bad-request' | 'toolchain-unavailable';
      exitCode: number | null;
      termination?: CommandTermination;
      durationMs: number;
      summary: string;
      signals?: string[];
    }
  /**
   * The bounded-repair ledger (Session 12, additive). `repair.attempted` records a CLASSIFIED
   * failure, the hypothesis being tried, and the scope it is allowed to touch — the evidence a
   * later reader needs to judge whether the repair was disciplined. Its outcome is derived, not
   * recorded: a passing regression check closes it, a newer attempt for the same signature
   * supersedes it. `repair.escalated` is the honest stop.
   */
  | {
      type: 'repair.attempted';
      callId: string;
      /** The plan task id being repaired, or 'session' for work outside the graph. */
      target: string;
      failureClass: FailureClass;
      /** Stable identity of THIS failure (class + subject + signals) — "the same failure again". */
      signature: string;
      hypothesis: string;
      hypothesisSha: string;
      scopePaths: string[];
      regressionChecks: CheckKind[];
      attempt: number;
      /**
       * Session 16 (additive): the project the FAILURE occurred in, when the evidence named one.
       * The regression proof must come from that project — a green `build` in `web/` is not
       * evidence that a failed install in `api/` is fixed. Absent = the root/only project, which
       * is what every pre-Session-16 attempt means.
       */
      projectId?: string;
    }
  | {
      type: 'repair.escalated';
      callId: string;
      target: string;
      failureClass: FailureClass;
      signature: string;
      reason: string;
    }
  /**
   * The structural review gate (Session 14, additive). `review.findings` is the delegate's
   * capture of ONE reviewer child's typed findings (possibly empty — a recorded clean lens);
   * the gate reads only these records, never reviewer prose. `review.triage` is the parent's
   * recorded judgment on one finding; like repairs, what a triage is WORTH is derived (an
   * 'address' whose cited refs do not exist clears nothing) and a triage never deletes a
   * finding. There is deliberately no `review.completed`: a round is derived from the
   * capture events of the delegate call that ran it.
   */
  | {
      type: 'review.findings';
      callId: string;
      childSessionId: string;
      planTaskId?: string;
      lens?: string;
      findings: ReviewFinding[];
    }
  | {
      type: 'review.triage';
      callId: string;
      findingId: string;
      action: 'verify' | 'refute' | 'accept' | 'address';
      evidence: string;
      refs?: string[];
    }
  /**
   * Managed preview processes (Session 13, additive). A preview is a SESSION resource that
   * deliberately keeps running between turns — the first process class whose lifetime is not
   * bounded by a tool call. `preview.started` marks a REAL spawn (the `command.started`
   * meaning); `preview.ready` is separate evidence that the server actually answered;
   * `preview.ended` is appended by exactly ONE writer (the exit listener, stop-reason
   * first-cause) and tolerates a closed log, because a process death is the one event that can
   * legitimately arrive after the session ends.
   */
  | {
      type: 'preview.started';
      callId: string;
      previewId: string;
      recipeId: string;
      /** The exact harness-resolved command string — what the human approved and what ran. */
      command: string;
      cwd: string;
      pid: number;
      expectedPort?: number;
      /** Session 16.5 (additive): the project UNIT this server belongs to. */
      projectId?: string;
    }
  | {
      type: 'preview.ready';
      callId: string;
      previewId: string;
      url: string;
      port: number;
      waitedMs: number;
      /** How readiness was established (declared port vs parsed, HTTP status observed). */
      probeDetail: string;
    }
  | {
      type: 'preview.ended';
      previewId: string;
      reason: PreviewEndReason;
      exitCode: number | null;
      signal?: string;
      logFile: string;
      logTail?: string;
    }
  | {
      /** Assembly-time orphan sweep evidence (identity-verified kills; unverified are skipped). */
      type: 'preview.swept';
      killed: { previewId: string; pid: number }[];
      killFailed: { previewId: string; pid: number; detail: string }[];
      skippedUnverified: { previewId: string; pid: number; detail: string }[];
      droppedDead: string[];
      /** Unverifiable entries old enough that deregistration (never a kill) is the honest exit. */
      retiredStale?: string[];
      /** Preview log files with no registry record and no ended marker — a start may have been
       *  lost in the spawn→register window; reported, never touched. */
      unaccountedLogs?: string[];
    }
  /**
   * One browser flow's detailed evidence (Session 13, additive). Pairs with check.started /
   * check.completed {check:'browser'} under the same callId: the check events feed gates and
   * classification; this event carries what they deliberately do not — per-step outcomes,
   * artifact pointers, console/page/network records, and the final URL.
   */
  | ({ type: 'browser.flow'; callId: string } & {
      flowName: string;
      previewId: string;
      status: CheckStatus;
      steps: BrowserStepRecord[];
      artifacts: BrowserArtifact[];
      consoleErrors: string[];
      pageErrors: string[];
      failedRequests: string[];
      offOriginRequests: string[];
      finalUrl: string | null;
      traceOmittedBytes?: number;
      screenshotsOmitted?: number;
    })
  /**
   * One produced document artifact (Session 17, additive). Deliberately NOT a check event and
   * NOT a WORK_EVENT_TYPES member: gates and CHECKED correlation never read it (the S16 setup
   * asymmetry), and every render already emits snapshot-covered file.mutated events, which are
   * what acceptance staleness counts — adding this too would double-count one unit of work.
   */
  | {
      type: 'artifact.rendered';
      callId: string;
      format: 'docx' | 'pdf';
      path: string;
      /** Absolute artifact path (S20.5, additive) — joins file.mutated/undo.applied paths. */
      absPath?: string;
      sha256: string;
      bytes: number;
      pages?: number;
      specPath: string;
      specSha256: string;
      validation: ArtifactValidation;
      /** The spec embedded workspace images; the inspect side must not inherit consent. */
      embeddedWorkspaceImages?: true;
      durationMs: number;
    }
  /** A charged render attempt that produced NO artifact (S20.5, additive) — budget-fold evidence only. */
  | {
      type: 'artifact.render-failed';
      callId: string;
      specPath: string;
      reasons: string[];
      durationMs: number;
    }
  /** One rasterization pass (Session 17, additive): page images stored as evidence blobs. */
  | {
      type: 'artifact.inspected';
      callId: string;
      path: string;
      sha256: string;
      source: 'pdf';
      pages: { page: number; imageSha256: string; bytes: number; mediaType: string }[];
      warnings: string[];
    }
  /**
   * Bounded external reads (Session 19). Additive, so `EVENT_SCHEMA_VERSION` stays 1 — the log
   * reader rejects only a HIGHER version, and an older reader that meets one of these arms
   * renders it as an unknown type rather than failing.
   *
   * The query is recorded verbatim on purpose. This is the only durable answer to "what did this
   * session send to a third party", and a summarized query cannot answer it.
   */
  | {
      type: 'research.searched';
      callId: string;
      provider: string;
      query: string;
      resultCount: number;
      /** Hosts of the admitted results — the origins whose text actually reached a context. */
      hosts: string[];
      /** Results the harness refused after the provider returned them. Never silent. */
      refused: { url: string; reason: string }[];
      credits: number;
      contentChars: number;
      durationMs: number;
      requestId?: string;
    }
  | {
      type: 'research.extracted';
      callId: string;
      provider: string;
      urls: string[];
      pageCount: number;
      /** URLs the PROVIDER could not retrieve — distinct from a harness refusal. */
      failed: { url: string; reason: string }[];
      credits: number;
      contentChars: number;
      durationMs: number;
      requestId?: string;
    }
  | {
      type: 'research.findings';
      callId: string;
      childSessionId: string;
      notes: ResearchNote[];
    }
  /**
   * One researcher task's spend, captured into the PARENT log at task end. Without it a resumed
   * session rebuilds its research budget from parent events alone and sees zero — because every
   * search the child ran was recorded in the child's own log.
   */
  | {
      type: 'research.usage';
      callId: string;
      childSessionId: string;
      searches: number;
      extracts: number;
      credits: number;
      contentChars: number;
    }
  /**
   * Remote Git/GitHub delivery (Session 20). Additive, so `EVENT_SCHEMA_VERSION` stays 1.
   *
   * `remote.context` is the LOCAL inventory, recorded once at assembly: which remotes exist, where
   * they point, whether gh is installed. No network, no credential, no approval — recorded anyway,
   * because "the session knew there was a remote called origin pointing at X" is the premise every
   * later decision rests on, and a premise that is not written down is not evidence.
   */
  | {
      type: 'remote.context';
      /** Present and parsed, or null when gh is absent. Never a path outside the version. */
      ghVersion: string | null;
      /** Installed gh predates the `gh auth status` token-leak fix (GHSA-cg6r-mpgc-h9mm). */
      ghAuthStatusLeakRisk: boolean;
      /** Remotes with credential-redacted URLs. The raw URL is never recorded. */
      remotes: { name: string; url: string; host: string | null; slug: string | null; isGitHub: boolean; hadCredentials: boolean }[];
      defaultRemote: string | null;
      ambiguity?: string;
      /** `GH_HOST` / `GH_CONFIG_DIR` in force — an override must be auditable, never invisible. */
      ghHostOverride?: string;
      ghConfigDirOverride?: string;
      /** A GH_TOKEN/GITHUB_TOKEN exists in the parent shell and is deliberately NOT forwarded. */
      tokenEnvNotForwarded: boolean;
      detail: string;
    }
  /** One authorized remote READ. The account is the identity in force, never the credential. */
  | {
      type: 'remote.inspected';
      callId: string;
      operation: string;
      host: string;
      target: string;
      account?: string;
      ok: boolean;
      itemCount?: number;
      observationId?: string;
      detail?: string;
      durationMs: number;
    }
  /**
   * One remote MUTATION. Separate from `remote.inspected` deliberately: a reader answering "what
   * did this session change on a third party" must be able to do it by event type, not by parsing
   * an operation string out of a shared arm. `verified` is the post-hoc re-read, so a successful
   * command whose outcome could not be confirmed is durably distinguishable from a confirmed one.
   */
  | {
      type: 'remote.mutated';
      callId: string;
      operation: string;
      host: string;
      target: string;
      exactTarget: string;
      account?: string;
      beforeOid?: string | null;
      afterOid?: string | null;
      url?: string;
      overwrote: boolean;
      ok: boolean;
      verified: boolean;
      detail?: string;
      durationMs: number;
    }
  | {
      type: 'undo.applied';
      target: 'last' | 'all';
      restored: { path: string; toSha256: string | null }[];
      refused: { path: string; reason: string }[];
    }
  | {
      /** The user aborted the turn: during the model call ('model') or the tool phase ('tools'). */
      type: 'turn.aborted';
      phase: 'model' | 'tools';
    }
  | {
      /** How the workspace-trust gate was satisfied for this run (consent provenance). */
      type: 'trust.verified';
      source: 'store' | 'prompt-remember' | 'prompt-once' | 'flag';
    }
  | {
      /** Which config files were loaded (post-trust) and their content hashes. */
      type: 'config.loaded';
      sources: { path: string; sha256: string }[];
    }
  | {
      /**
       * The active execution sandbox for this session, established by a real runtime probe.
       * `enforced` is true only when the OS is actually confining sandboxed children — never
       * assumed from the platform. `confines`/`doesNotConfine` are the honesty surface.
       */
      type: 'sandbox.status';
      mode: 'none' | 'windows-lowil';
      enforced: boolean;
      summary: string;
      confines: string[];
      doesNotConfine: string[];
      detail: string;
    }
  | {
      /**
       * Older tool outputs were elided from the WIRE history to stay inside the context budget
       * (V0.5). The event log and the persisted history are untouched — this records exactly
       * which outputs the model can no longer see verbatim. Additive v1 event.
       */
      type: 'context.compacted';
      elidedCount: number;
      newlyElidedCallIds: string[];
      rawChars: number;
      sentChars: number;
      exhausted: boolean;
      /**
       * Results whose IMAGE parts were replaced with text markers this step (Session 13,
       * additive) — a distinct partial state from full elision: the text stays verbatim while
       * the pixels age out of the window. Recorded for the same honesty reason as
       * newlyElidedCallIds: exactly what the model can no longer see.
       */
      newlyImageElidedCallIds?: string[];
    }
  | {
      /**
       * The probed git context for this session (read-only probe at session start; V0.5).
       * Every degrade path is explicit — git absent, not a repository, probe failed/timed out —
       * with nulls, never guesses. Additive v1 event.
       */
      type: 'git.context';
      isRepo: boolean;
      gitVersion: string | null;
      repoRoot: string | null;
      workspaceIsRepoRoot: boolean;
      branch: string | null;
      detached: boolean;
      unborn: boolean;
      head: string | null;
      upstream: string | null;
      ahead: number | null;
      behind: number | null;
      dirtyCount: number | null;
      untrackedCount: number | null;
      probeFailed: boolean;
      detail: string;
    }
  | {
      /**
       * A user-commanded recovery checkpoint was captured to a hidden ref (V0.5). The user's
       * index/HEAD/worktree are untouched; the ref keeps the objects alive until pruned.
       */
      type: 'git.checkpoint';
      ref: string;
      oid: string;
      label: string | null;
      /** Files differing between HEAD (or the empty tree when unborn) and the checkpoint. */
      filesChanged: number;
    }
  | {
      /**
       * A user-commanded checkpoint restore ran (V0.5). The batch shares one synthetic callId
       * with its snapshot.created + file.mutated events, so /undo reverts it as a unit.
       */
      type: 'git.restore';
      ref: string;
      oid: string;
      restored: string[];
      refused: { path: string; reason: string }[];
    }
  | {
      /**
       * A deliberate user-commanded commit (/commit, `agent commit`) succeeded (V0.5).
       * Consent provenance: this event exists only for flows the user explicitly invoked.
       */
      type: 'git.commit';
      oid: string;
      subject: string;
      /** Repo-relative files actually in the commit (git diff-tree truth). */
      files: string[];
      scope: 'session' | 'all';
      trailer: boolean;
    }
  | {
      /**
       * This session's harness-created checkpoint refs were deleted at session end (V0.7.1;
       * kinds widened Session 14). The base oids stay recorded in task.changes/worktree/
       * harness.checkpoint events and the captured blobs are the durable integration record —
       * the ref was only a live recovery point while the session ran ('delivery' refs are the
       * exception: they survive and are pruned here only when SUPERSEDED by a newer delivery
       * checkpoint). One event per kind; old readers filtering kind === 'task-base' are
       * unaffected by the widening.
       */
      type: 'git.checkpoint.pruned';
      kind: HarnessRefKind;
      refs: string[];
      failed: string[];
    }
  | {
      /**
       * Which project-memory documents this session loaded at assembly, with identity facts
       * (V0.6). Provenance for exactly what durable context reached the system prompt; memory
       * failures degrade to a status here instead of blocking the session.
       */
      type: 'memory.loaded';
      files: {
        name: string;
        sha256: string | null;
        bytes: number;
        truncated: boolean;
        status: 'ok' | 'missing' | 'oversize' | 'unreadable';
      }[];
    }
  | {
      /**
       * A delegated subagent task began executing (V0.6). callId is bound by the runtime (the
       * delegate tool cannot forge another call's evidence); childSessionId names the child's
       * own event log — the complete parent↔child lineage join.
       */
      type: 'task.started';
      callId: string;
      role: string;
      childSessionId: string;
      budget: TaskBudget;
      /** The approved-plan task this child executes (Session 11, additive) — the DAG join key. */
      planTaskId?: string;
      /**
       * The bound plan task's DEFINITION sha at spawn time (Session 11.5, additive):
       * sha256(canonicalJson(task, dependsOn sorted)). Lets the fold attach 'completed' to
       * the definition that actually ran — an amendment changing a completed task's
       * definition re-opens it. Absent on pre-11.5 logs: completed then stays sticky to the
       * id (the conservative legacy reading).
       */
      planTaskSha?: string;
    }
  | {
      /**
       * A harness supervision observation about a running child (Session 11, additive): stall,
       * repeated identical tool calls, budget pressure, or task-scoped cancellation. Bounded
       * per task; evidence of the supervisor's bounded interventions, never a status of record
       * (task.ended carries the status).
       */
      type: 'task.supervision';
      callId: string;
      childSessionId: string;
      kind: 'stall' | 'loop' | 'budget-pressure' | 'cancelled';
      detail?: string;
    }
  | {
      /**
       * The task-base checkpoint captured for an executor group (Session 11.5, additive).
       * The ref is a live recovery point only while the session runs; recording CREATION lets
       * a resumed session rebuild its prune list, so a crash no longer leaks the refs forever.
       * Since Session 14 the append happens BEFORE update-ref (the onRefReady seam): a kill
       * between the two leaves an owed ref that does not exist, which the prune fold counts
       * as already deleted — the creation-instant leak is structurally closed. A recorded
       * creation whose update-ref then failed is a phantom; the fold reads
       * latest-creation-per-ref-wins and `agent checkpoint list` is live truth. Deliberately
       * NOT a `git.checkpoint` event — that type is user-commanded consent provenance, and an
       * old reader misattributing harness plumbing to the user would be worse than skipping
       * an unknown type.
       */
      type: 'task.base-checkpoint';
      callId: string;
      ref: string;
      oid: string;
    }
  | {
      /**
       * A harness-created recovery checkpoint at a workflow transition (Session 14, additive):
       * 'pre-integration' before apply_task_changes writes when un-snapshot-covered changes
       * could exist since the last harness checkpoint, 'delivery' at the /accept COMPLETE
       * boundary (created before session.accepted so the acceptance can reference it; the
       * delivery ref SURVIVES the session as the durable audit anchor — user-prunable via
       * `agent checkpoint prune` — and is owed-pruned only when superseded by a newer
       * delivery checkpoint). Appended BEFORE update-ref, same contract as
       * task.base-checkpoint: a phantom (update-ref failed after the append) converges at
       * prune because a missing ref counts as deleted. Deliberately a NEW type: widening
       * task.base-checkpoint would make an old reader's owed-prune fold delete the durable
       * delivery anchor at quit.
       */
      type: 'harness.checkpoint';
      kind: 'pre-integration' | 'delivery';
      ref: string;
      oid: string;
      /** Bound by the runtime when a tool call created it (pre-integration); absent for the /accept delivery path. */
      callId?: string;
    }
  | {
      /** A delegated subagent task finished (V0.6). Usage is the CHILD's spend, recorded once
       *  here for the parent's view — it is NOT included in this session's own usage totals. */
      type: 'task.ended';
      callId: string;
      childSessionId: string;
      status: TaskStatus;
      steps: number;
      usage: Usage;
      resultSha256: string;
      durationMs: number;
      /** The task's role (S20.5, additive) — set on never-started attempts (childSessionId '') so caps folds can count them. */
      role?: string;
    }
  | {
      /**
       * An executor task's captured file changes vs its checkpoint base (V0.7). The after-bytes
       * live as content-addressed blobs, so this evidence — not the removed worktree — is the
       * durable record; apply_task_changes replays from exactly this.
       */
      type: 'task.changes';
      callId: string;
      childSessionId: string;
      baseOid: string;
      files: TaskChangeFile[];
      omittedCount?: number;
    }
  | {
      /** apply_task_changes outcome (V0.7): per-file applied/refused, alongside the ordinary
       *  snapshot/file.mutated evidence the write path records. */
      type: 'task.applied';
      callId: string;
      childSessionId: string;
      applied: string[];
      refused: { relPath: string; reason: string }[];
    }
  | {
      /** A task worktree came into existence (V0.7): ownership evidence for the sweep story. */
      type: 'worktree.created';
      callId: string;
      childSessionId: string;
      path: string;
      baseOid: string;
    }
  | {
      /** A task worktree was removed — or could not be (ok:false ⇒ the startup sweep owns it). */
      type: 'worktree.removed';
      callId: string;
      childSessionId: string;
      ok: boolean;
      detail?: string;
    }
  | {
      /**
       * The plan document was rewritten (V0.7). Model writes flow through the policy-gated
       * update_plan tool (callId bound by the runtime); prior bytes are archived as the
       * `prevSha256` blob, so plan history is fully reviewable.
       */
      type: 'plan.updated';
      callId: string;
      planId: string;
      sha256: string;
      bytes: number;
      prevSha256: string | null;
      status: 'draft' | 'approved' | 'superseded' | 'unknown';
      /** Structural task-graph summary for canonical writes (Session 11, additive; Session 12
       *  adds each task's declared check gate so the report never has to read the plan file). */
      graph?: { id: string; role: string; dependsOn: string[]; checks?: CheckKind[] }[];
    }
  | {
      /**
       * How this turn's complexity was routed (Session 11, additive): into plan mode or the
       * direct path, by the model's judgment or a user sigil (@plan / @direct). Observability
       * for proportionate routing — absence of any plan events IS the evidence of a direct
       * turn, so this is recorded when planning begins or a sigil forces a path.
       */
      type: 'plan.route';
      mode: 'plan' | 'direct';
      source: 'user-sigil' | 'model';
      reason?: string;
    }
  /**
   * The user routed a turn to the web (Session 19, `@research` / `@search`). Recorded for the
   * same reason `plan.route` is: a routing decision the USER made is evidence about how the turn
   * was framed, and it must be distinguishable from the model deciding to search on its own.
   * It grants nothing — the policy gate still asks.
   */
  | {
      type: 'research.route';
      mode: 'research' | 'search';
      source: 'user-sigil';
    }
  | {
      /**
       * The USER approved the plan (/plan approve) — the execution consent record (V0.7).
       * Binds the exact approved bytes: divergence of the file's later sha from this one is
       * surfaced on every injection and executor-spawn prompt, never hidden.
       */
      type: 'plan.approved';
      planId: string;
      sha256: string;
    }
  | {
      /**
       * The USER discarded the plan (/plan discard): status → superseded (V0.7).
       * reason 'accepted' (Session 11.5, additive) marks the /accept retirement of a fully
       * executed plan — same mechanics, different provenance.
       */
      type: 'plan.discarded';
      planId: string;
      reason?: 'accepted';
    }
  | {
      /**
       * The USER accepted the session result (/accept, Session 11.5) — the explicit completion
       * boundary. `complete` records whether the acceptance was clean (all plan tasks
       * completed/parent-owned, every applicable capture integrated) or a confirmed partial
       * acceptance; `unfinished` preserves the honest blocker list for the handoff. Cleanup
       * (task-base ref pruning, plan retirement) keys off this consent — never off mere
       * session end.
       */
      type: 'session.accepted';
      complete: boolean;
      summary: string;
      unfinished?: string[];
      /**
       * The delivery checkpoint capturing the exact accepted state (Session 14, additive;
       * COMPLETE acceptances in a git repo only). The ref survives the session as the durable
       * audit anchor; a failed/declined/skipped capture simply leaves these absent — the
       * acceptance itself never depends on git.
       */
      deliveryRef?: string;
      deliveryOid?: string;
    }
  | {
      /**
       * The end-of-session narrative provider call (V0.6). This call bypasses runTurn (its
       * instruction must never replay into a resumed conversation), so its usage is recorded
       * HERE — evidence that the call happened, what it cost, and whether it succeeded.
       */
      type: 'memory.narrative';
      status: 'ok' | 'failed' | 'skipped';
      durationMs: number;
      usage?: Usage;
      detail?: string;
    }
  | {
      /** A project-memory document write outcome at session end (V0.6). Failures are honest, never silent. */
      type: 'memory.updated';
      doc: 'journal' | 'codebase';
      status: 'written' | 'skipped' | 'failed';
      sha256?: string;
      bytes?: number;
      detail?: string;
    }
  | {
      type: 'session.ended';
      /** 'aborted' (Ctrl+C) and 'budget' (subagent caps) are additive V0.6 values. */
      reason: 'completed' | 'user-quit' | 'error' | 'max-steps' | 'aborted' | 'budget';
      error?: string;
    };

export type SessionEvent = { v: number; seq: number; ts: string } & EventBody;
export type EventType = EventBody['type'];
