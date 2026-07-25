import { recoveryEntry, type RecoveryEntry } from './catalogue.js';
import type { FailureClassification } from './classify.js';
import type { RepairLedger } from './ledger.js';
import type { FailureClass } from '../types.js';

/**
 * The bounded repair policy (Session 12). Recovery is a POLICY, not "try again": every automatic
 * repair needs a supported classification, sufficient evidence, a recovery point, a materially
 * different hypothesis, and a budget it has not yet spent.
 *
 * What the harness ENFORCES (and what it does not) is stated plainly, because the difference
 * matters: attempts, wall time, session budget, token budget, scope containment, and
 * non-identical hypothesis TEXT are enforced here. Whether a hypothesis is genuinely a different
 * idea is the model's responsibility — it is recorded verbatim for review, never claimed as
 * verified. Overstating that would be exactly the "narration as evidence" failure this system
 * exists to prevent.
 *
 * The recovery POINT is not built here because it already exists: parent edits are snapshot-backed
 * by construction (a capture failure escalates to a no-undo ask), and an executor re-run creates a
 * fresh group base checkpoint with the Session-11.5 crash-covered prune lifecycle.
 */

/** Automatic repair attempts per failure signature before the gate stops and escalates. */
export const MAX_REPAIR_ATTEMPTS = 3;
/** Wall time one failure signature may absorb before it must be escalated. */
export const REPAIR_WALL_MS = 20 * 60 * 1000;
/** Session-wide repair attempts — no unbounded repair, ever. */
export const REPAIRS_PER_SESSION = 8;
/** Delegated child output tokens spendable on repairs after the first attempt. */
export const REPAIR_CHILD_TOKEN_BUDGET = 60_000;

export type RepairStopReason =
  | 'unknown-classification'
  | 'requires-user-decision'
  | 'attempts-exhausted'
  | 'wall-time-exhausted'
  | 'session-budget-exhausted'
  | 'token-budget-exhausted'
  | 'scope-expanded'
  | 'repeated-identical-hypothesis';

export interface RepairVerdict {
  eligible: boolean;
  failureClass: FailureClass;
  signature: string;
  attemptsUsed: number;
  attemptsRemaining: number;
  wallMsUsed: number;
  /** True when the latest failure post-dates every recorded attempt: a fresh plan is required. */
  needsNewPlan: boolean;
  /** Preconditions the caller must satisfy for an attempt to be accepted. */
  requires: string[];
  stop?: { reason: RepairStopReason; detail: string };
  guidance: RecoveryEntry;
}

export interface RepairEvaluationInput {
  classification: FailureClassification;
  /** Seq of the failure being repaired — an attempt must be newer to count for it. */
  failureSeq: number;
  ledger: RepairLedger;
  /** A proposed hypothesis, when one is being offered right now. */
  hypothesisSha?: string;
}

export function evaluateRepair(input: RepairEvaluationInput): RepairVerdict {
  const { classification: c, ledger } = input;
  const guidance = recoveryEntry(c.class);
  const prior = ledger.bySignature.get(c.signature) ?? [];
  const attemptsUsed = prior.length;
  const wallMsUsed = prior.length > 0 ? Math.max(...prior.map((a) => a.ageMs)) : 0;
  const needsNewPlan = !prior.some((a) => a.seq > input.failureSeq);
  const base = {
    failureClass: c.class,
    signature: c.signature,
    attemptsUsed,
    attemptsRemaining: Math.max(0, MAX_REPAIR_ATTEMPTS - attemptsUsed),
    wallMsUsed,
    needsNewPlan,
    guidance,
  };
  const stop = (reason: RepairStopReason, detail: string): RepairVerdict => ({
    ...base,
    eligible: false,
    requires: [],
    stop: { reason, detail },
  });

  // 1. Classification first. An unknown failure is not a repair candidate — it is a request for
  //    evidence, and looping on it is the exact behavior the class exists to stop.
  if (c.class === 'unknown') {
    return stop(
      'unknown-classification',
      `the failure did not classify (${c.detail}) — gather evidence until it does, or escalate to the user; automatic repair on an unclassified failure is guessing`,
    );
  }
  // 2. Classes where a bounded loop is the wrong instrument, regardless of budget.
  if (!guidance.autoEligible) {
    return stop(
      'requires-user-decision',
      `${c.class} failures are not eligible for automatic repair: ${guidance.stopConditions[0] ?? 'they need a human decision'}`,
    );
  }
  // 3. Budgets — all events-rebuilt, so a resumed session keeps counting.
  if (attemptsUsed >= MAX_REPAIR_ATTEMPTS) {
    return stop(
      'attempts-exhausted',
      `this failure has already absorbed ${attemptsUsed} repair attempt(s) (max ${MAX_REPAIR_ATTEMPTS}) with the same signature — the hypothesis space is not converging`,
    );
  }
  if (wallMsUsed > REPAIR_WALL_MS) {
    return stop(
      'wall-time-exhausted',
      `this failure has been under repair for ${Math.round(wallMsUsed / 60000)} minute(s) (max ${Math.round(REPAIR_WALL_MS / 60000)})`,
    );
  }
  if (ledger.total >= REPAIRS_PER_SESSION) {
    return stop('session-budget-exhausted', `this session has already recorded ${ledger.total} repair attempt(s) (max ${REPAIRS_PER_SESSION})`);
  }
  if (ledger.childOutputTokensSinceFirstAttempt >= REPAIR_CHILD_TOKEN_BUDGET) {
    return stop(
      'token-budget-exhausted',
      `delegated repair work has spent ${ledger.childOutputTokensSinceFirstAttempt} output tokens since the first attempt (max ${REPAIR_CHILD_TOKEN_BUDGET})`,
    );
  }
  // 4. An expanding diff is a stopping condition in its own right: a repair that keeps reaching
  //    further is no longer a repair, and the blast radius is exactly what bounds it.
  const expanded = prior.find((a) => a.outOfScope.length > 0);
  if (expanded !== undefined) {
    return stop(
      'scope-expanded',
      `a previous attempt changed file(s) outside its declared scope (${expanded.outOfScope.slice(0, 5).join(', ')}) — the repair is spreading; stop and report what has changed`,
    );
  }
  // 5. A repeat of the same hypothesis for the same failure is the loop, verbatim.
  if (input.hypothesisSha !== undefined && prior.some((a) => a.hypothesisSha === input.hypothesisSha)) {
    return stop(
      'repeated-identical-hypothesis',
      'this exact hypothesis was already attempted for this failure — a new attempt must try a materially different idea, or escalate',
    );
  }

  return {
    ...base,
    eligible: true,
    requires: [
      ...guidance.requiredEvidence.map((r) => `evidence: ${r}`),
      'a hypothesis that differs from the previous attempt(s) for this failure',
      `a declared regression check (${guidance.regressionChecks.length > 0 ? guidance.regressionChecks.join(' or ') : 'any relevant kind'}) that will prove the repair`,
      'a declared scope: changes outside it stop the repair',
    ],
  };
}

/** One compact line for the status/task surfaces. */
export function describeVerdict(v: RepairVerdict): string {
  if (v.stop !== undefined) return `repair BLOCKED (${v.stop.reason}): ${v.stop.detail}`;
  return `repair eligible — ${v.failureClass}, attempt ${v.attemptsUsed + 1}/${MAX_REPAIR_ATTEMPTS}${v.needsNewPlan ? ' (a fresh repair plan is required)' : ''}`;
}
