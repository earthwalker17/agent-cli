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
  /** True when no LATER attempt for this signature has succeeded — the escalation still stands. */
  open: boolean;
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

function withinScope(relPath: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true; // no declared scope ⇒ nothing to expand beyond
  const p = relPath.replace(/\\/g, '/');
  return allowed.some((a) => p === a || p.startsWith(`${a}/`));
}

export function foldRepairs(events: readonly SessionEvent[], opts: RepairFoldOptions = {}): RepairLedger {
  const attempts: RepairAttemptState[] = [];
  const escalations: RepairEscalationState[] = [];
  const lastTs = events.length > 0 ? parseTs(events[events.length - 1]!.ts) : 0;

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
        outcome: 'open',
        pendingChecks: [...e.regressionChecks],
        outOfScope: [],
        ageMs: Math.max(0, lastTs - parseTs(e.ts)),
      });
    } else if (e.type === 'repair.escalated') {
      escalations.push({ seq: e.seq, target: e.target, failureClass: e.failureClass, signature: e.signature, reason: e.reason, open: true });
    }
  }

  const bySignature = new Map<string, RepairAttemptState[]>();
  for (const a of attempts) {
    const list = bySignature.get(a.signature) ?? [];
    list.push(a);
    bySignature.set(a.signature, list);
  }

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
        if (e.type === 'check.completed' && e.status === 'pass' && a.regressionChecks.includes(e.check)) passed.add(e.check);
        else if (e.type === 'file.mutated') changed.push(e.path);
        else if (e.type === 'task.applied') changed.push(...e.applied);
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

  // An escalation stands until a LATER attempt for the same signature actually succeeded.
  for (const esc of escalations) {
    esc.open = !attempts.some((a) => a.signature === esc.signature && a.seq > esc.seq && a.outcome === 'succeeded');
  }

  const firstAttemptSeq = attempts.length > 0 ? attempts[0]!.seq : Number.MAX_SAFE_INTEGER;
  let childOutputTokensSinceFirstAttempt = 0;
  for (const e of events) {
    if (e.type === 'task.ended' && e.seq > firstAttemptSeq) childOutputTokensSinceFirstAttempt += e.usage.outputTokens;
  }

  return { attempts, escalations, bySignature, total: attempts.length, childOutputTokensSinceFirstAttempt };
}

/** Repair attempts and escalations that still need an answer — acceptance blockers. */
export function openRepairBlockers(ledger: RepairLedger): string[] {
  const out: string[] = [];
  for (const esc of ledger.escalations) {
    if (esc.open) out.push(`repair escalated and unresolved: ${esc.target} (${esc.failureClass}) — ${esc.reason}`);
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
