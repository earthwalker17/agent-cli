import type { CheckKind, FailureClass, SessionEvent } from '../types.js';

/**
 * The bounded-repair ledger (Session 12): a PURE fold over the event log — the house pattern, and
 * the reason a repair survives a crash without a second store.
 *
 * An attempt's OUTCOME IS DERIVED, never recorded. There is no `repair.ended` to lose: an attempt
 * closes as `succeeded` only when every declared regression check actually passed after it, is
 * `superseded` when a newer attempt for the same failure signature exists, and otherwise stays
 * `open`. A crash between doing the work and recording the result therefore cannot leave the
 * ledger claiming a repair that was never proven.
 */

export interface RepairAttemptState {
  seq: number;
  ts: string;
  target: string;
  failureClass: FailureClass;
  signature: string;
  hypothesis: string;
  hypothesisSha: string;
  scopePaths: string[];
  regressionChecks: CheckKind[];
  attempt: number;
  /** The project the failure occurred in; a regression proof must come from it (Session 16). */
  projectId?: string;
  outcome: 'succeeded' | 'superseded' | 'open';
  /** Regression kinds still unproven for this attempt. */
  pendingChecks: CheckKind[];
  /** Files changed since this attempt that fall outside its allowed scope — an expanding diff. */
  outOfScope: string[];
  /** Wall time from the attempt to the newest event, in ms (0 when unknown). */
  ageMs: number;
}

export interface RepairEscalationState {
  seq: number;
  target: string;
  failureClass: FailureClass;
  signature: string;
  reason: string;
  /**
   * True when neither a LATER proven attempt for this signature nor a user dismissal has closed
   * it — the escalation still stands.
   */
  open: boolean;
  /**
   * The user's recorded dismissal (S21), when one closed this escalation. Distinct from proven
   * closure on purpose: a dismissed escalation stops blocking acceptance but ALWAYS surfaces as
   * a caveat — dismissed is not resolved.
   */
  dismissed: { seq: number; reason: string } | null;
}

export interface RepairLedger {
  attempts: RepairAttemptState[];
  escalations: RepairEscalationState[];
  /** Attempts grouped by failure signature, in order. */
  bySignature: Map<string, RepairAttemptState[]>;
  /** Total attempts this session — the session-wide repair budget counter. */
  total: number;
  /** Child output tokens spent after the FIRST attempt — the repair-scoped token budget. */
  childOutputTokensSinceFirstAttempt: number;
}

export interface RepairFoldOptions {
  /**
   * Extra allowed path prefixes per target beyond the attempt's declared scope — normally the
   * plan task's own `touches`. Supplied by the caller because the ledger is a pure fold over
   * events and must not read the plan file.
   */
  extraScope?: (target: string) => readonly string[];
}

function parseTs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Inter-event gaps longer than this are treated as the session being idle (the user went away,
 * quit and resumed the next day) rather than as repair effort. Without the clamp the wall-time
 * budget measured CALENDAR time: resuming a session in the morning instantly exhausted every
 * repair signature from the night before, permanently blocking retries for work that took
 * minutes.
 */
const IDLE_GAP_MS = 10 * 60 * 1000;

/** Elapsed IN-SESSION time from `fromSeq` to the end of the log: gaps beyond IDLE_GAP_MS ignored. */
function activeMsSince(events: readonly SessionEvent[], fromSeq: number): number {
  let total = 0;
  let prev: number | null = null;
  for (const e of events) {
    if (e.seq < fromSeq) continue;
    const t = parseTs(e.ts);
    if (prev !== null) {
      const gap = t - prev;
      if (gap > 0 && gap <= IDLE_GAP_MS) total += gap;
    }
    prev = t;
  }
  return total;
}

function withinScope(relPath: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true; // no declared scope ⇒ nothing to expand beyond
  const p = relPath.replace(/\\/g, '/');
  return allowed.some((a) => p === a || p.startsWith(`${a}/`));
}

export function foldRepairs(events: readonly SessionEvent[], opts: RepairFoldOptions = {}): RepairLedger {
  const attempts: RepairAttemptState[] = [];
  const escalations: RepairEscalationState[] = [];
  const dismissals: { seq: number; escalationSeq: number; reason: string }[] = [];
  // Which plan task each child belongs to — so integrating ANOTHER task's reviewed work is never
  // mistaken for this repair's diff spreading.
  const childTarget = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'task.started' && e.planTaskId !== undefined) childTarget.set(e.childSessionId, e.planTaskId);
  }

  for (const e of events) {
    if (e.type === 'repair.attempted') {
      attempts.push({
        seq: e.seq,
        ts: e.ts,
        target: e.target,
        failureClass: e.failureClass,
        signature: e.signature,
        hypothesis: e.hypothesis,
        hypothesisSha: e.hypothesisSha,
        scopePaths: [...e.scopePaths],
        regressionChecks: [...e.regressionChecks],
        attempt: e.attempt,
        ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
        outcome: 'open',
        pendingChecks: [...e.regressionChecks],
        outOfScope: [],
        ageMs: activeMsSince(events, e.seq),
      });
    } else if (e.type === 'repair.escalated') {
      escalations.push({ seq: e.seq, target: e.target, failureClass: e.failureClass, signature: e.signature, reason: e.reason, open: true, dismissed: null });
    } else if (e.type === 'repair.dismissed' && e.source === 'user') {
      // The source guard is defense in depth over the type: the fold reads LENIENTLY-parsed disk
      // bytes, and consent must stay the user's even against a hand-forged event (the
      // review-triage precedent: every rule enforced at the call AND re-derived in the fold).
      dismissals.push({ seq: e.seq, escalationSeq: e.escalationSeq, reason: e.reason });
    }
  }

  const bySignature = new Map<string, RepairAttemptState[]>();
  for (const a of attempts) {
    const list = bySignature.get(a.signature) ?? [];
    list.push(a);
    bySignature.set(a.signature, list);
  }

  /**
   * A repair proof must come from the PROJECT that failed (Session 16). Without this filter a
   * green `build` in `web/` proved that a failed install in `api/` was fixed — the "unrelated
   * green check proves a repair" hole closed in S14.5, reopened along the project axis by this
   * very session, and not caught by the `scopePaths` guard beside it (`build` is not
   * scope-bearing, so that guard passes unconditionally).
   *
   * An attempt with no recorded project is a root/single-project failure, or a pre-Session-16
   * one: any project's pass counts, which is exactly the old reading.
   */
  const provesForProject = (attemptProject: string | undefined, runProject: string | undefined): boolean =>
    attemptProject === undefined || attemptProject === (runProject ?? '.');

  // Resolve each attempt inside its OWN window: from the attempt to the next attempt for the same
  // signature (or the end of the log). A regression check that ran before a later attempt cannot
  // retroactively prove that later attempt, and vice versa.
  for (const [, list] of bySignature) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const windowEnd = i + 1 < list.length ? list[i + 1]!.seq : Number.MAX_SAFE_INTEGER;
      const passed = new Set<CheckKind>();
      const changed: string[] = [];
      for (const e of events) {
        if (e.seq <= a.seq || e.seq >= windowEnd) continue;
        if (e.type === 'check.completed' && e.status === 'pass' && a.regressionChecks.includes(e.check) && provesForProject(a.projectId, e.projectId)) {
          // A SCOPE-BEARING kind proves the repair only when the run actually covered the
          // failing scope: a green `test-targeted` over somebody else's paths said PROVEN while
          // the originally failing test was never re-run — the same "unrelated green check"
          // hole the tool's own refusal guards against at the call (S14.5 review finding, made
          // easier to hit by scope defaulting from plan touches). An unscoped (full) run counts.
          const runScope = e.scopePaths ?? [];
          const proves =
            a.scopePaths.length === 0 || runScope.length === 0 || a.scopePaths.every((want) => runScope.some((got) => withinScope(want.replace(/\\/g, '/'), [got])));
          if (proves) passed.add(e.check);
        }
        else if (e.type === 'file.mutated') changed.push(e.path);
        else if (e.type === 'task.applied') {
          // Only this target's own integrations count toward its scope. Integrating a DIFFERENT
          // plan task's reviewed work is normal progress, not a repair spreading — counting it
          // permanently tripped the scope-expanded stop for whichever repair happened to be open.
          const owner = childTarget.get(e.childSessionId);
          if (owner === undefined || owner === a.target) changed.push(...e.applied);
        }
      }
      a.pendingChecks = a.regressionChecks.filter((k) => !passed.has(k));
      const allowed = [...a.scopePaths, ...(opts.extraScope?.(a.target) ?? [])];
      const seen = new Set<string>();
      for (const p of changed) {
        const rel = p.replace(/\\/g, '/');
        if (!withinScope(rel, allowed) && !seen.has(rel)) {
          seen.add(rel);
          a.outOfScope.push(rel);
        }
      }
      a.outcome =
        a.regressionChecks.length > 0 && a.pendingChecks.length === 0
          ? 'succeeded'
          : i + 1 < list.length
            ? 'superseded'
            : 'open';
    }
  }

  // An escalation stands until a LATER attempt for the same signature actually succeeded — or
  // the user dismissed it (S21). The dismissal joins on the escalation's OWN seq, so dismissing
  // one escalation can never quietly clear a different one that happens to share a signature.
  for (const esc of escalations) {
    esc.open = !attempts.some((a) => a.signature === esc.signature && a.seq > esc.seq && a.outcome === 'succeeded');
    const d = dismissals.find((x) => x.escalationSeq === esc.seq && x.seq > esc.seq);
    if (d !== undefined) {
      esc.dismissed = { seq: d.seq, reason: d.reason };
      esc.open = false;
    }
  }

  const firstAttemptSeq = attempts.length > 0 ? attempts[0]!.seq : Number.MAX_SAFE_INTEGER;
  let childOutputTokensSinceFirstAttempt = 0;
  for (const e of events) {
    if (e.type === 'task.ended' && e.seq > firstAttemptSeq) childOutputTokensSinceFirstAttempt += e.usage.outputTokens;
  }

  return { attempts, escalations, bySignature, total: attempts.length, childOutputTokensSinceFirstAttempt };
}

/**
 * Repair attempts and escalations that still need an answer — the acceptance blockers.
 *
 * `resolvedTargets` closes an escalation whose subject is demonstrably fine now (a plan task
 * that is completed with its check gate satisfied). Without it, an escalation on a
 * non-auto-eligible class was a DEADLOCK: the escalation could only be closed by a successful
 * repair attempt, and the repair policy refuses to record an attempt for exactly those classes —
 * so a session could never be accepted as complete even after the underlying problem was fixed
 * by hand. Escalations on 'session' (no task to inspect) still close only via a successful
 * attempt; the user's `/accept confirm` remains the documented override there.
 */
export function openRepairBlockers(ledger: RepairLedger, opts: { resolvedTargets?: ReadonlySet<string> } = {}): string[] {
  const out: string[] = [];
  for (const esc of ledger.escalations) {
    if (!esc.open) continue;
    if (opts.resolvedTargets?.has(esc.target) === true) continue;
    out.push(`repair escalated and unresolved: ${esc.target} (${esc.failureClass}) — ${esc.reason}`);
  }
  for (const a of ledger.attempts) {
    if (a.outcome === 'open' && a.pendingChecks.length > 0) {
      out.push(
        `repair of '${a.target}' (${a.failureClass}) is unproven: regression check(s) ${a.pendingChecks.join(', ')} have not passed since the attempt`,
      );
    }
  }
  return out;
}
