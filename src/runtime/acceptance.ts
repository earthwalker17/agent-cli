import type { SessionEvent, TaskChangeFile } from '../types.js';
import type { PlanState } from '../plan/canonical.js';
import { completionGateState, type GraphState } from '../plan/graph-state.js';
import { foldRepairs, openRepairBlockers } from '../recovery/ledger.js';
import { foldReview } from '../review/ledger.js';
import { proveWith } from '../recovery/catalogue.js';

/**
 * The session completion boundary (Session 11.5) — a PURE fold (the house pattern) that answers
 * one question honestly: is this session's work COMPLETE (plan fully executed, every applicable
 * capture integrated), and if not, exactly what remains? /accept, /status, the quit summary,
 * the report, and the journal handoff all read this one derivation; the recorded consent is the
 * `session.accepted` event, appended only by the user-typed /accept command.
 */

export interface RecordedAcceptance {
  complete: boolean;
  summary: string;
  unfinished: string[];
  /** The event's seq — later work is detected as events after it. */
  seq: number;
}

export interface AcceptanceState {
  /** True when nothing is unfinished RIGHT NOW (independent of any recorded acceptance). */
  complete: boolean;
  /** One compact human line for chrome/status/journal. */
  summary: string;
  /** Honest blockers, empty when complete. */
  unfinished: string[];
  /**
   * Non-blocking caveats a reader of "complete" must still see (Session 12) — above all, gates
   * the user approved that were WAIVED because the project cannot run them. They do not prevent
   * acceptance; hiding them would let "complete" quietly mean "nothing was actually verified".
   */
  caveats: string[];
  /** The latest recorded /accept, when any. */
  accepted: RecordedAcceptance | null;
  /** True when work-shaped events landed AFTER the recorded acceptance — it covers only work
   *  up to its point, and every surface must say so rather than show a fresh-looking accept. */
  acceptedStale: boolean;
}

/** Event types that count as "work happened" after an acceptance (idempotence boundary). */
const WORK_EVENT_TYPES = new Set([
  'file.mutated',
  'task.started',
  'task.changes',
  'task.applied',
  'plan.updated',
  'plan.approved',
  'plan.discarded',
  'undo.applied',
  'git.restore',
  'git.commit',
  'command.started',
  // A typed check SPAWNS a process that can write build outputs — the same reason
  // `command.started` is here (Session 12). Deliberately not `check.completed`: it would
  // double-count one unit of work and make staleness noisier without adding information.
  'check.started',
  // Repair ledger writes are state changes a user would want to re-accept over: an attempt
  // declares work about to happen, and an escalation changes what is outstanding.
  'repair.attempted',
  'repair.escalated',
  // Review records change what is outstanding the same way (Session 14): a captured round or
  // a triage after an acceptance makes re-accepting meaningful. `harness.checkpoint` is
  // deliberately NOT here — the accept's own delivery checkpoint must never stale the accept
  // (the review-F1 lesson above, again).
  'review.findings',
  'review.triage',
  // A preview server is a spawned process that can write outputs — the `command.started` /
  // `check.started` class (Session 13). ready/ended are lifecycle echoes of the same unit.
  'preview.started',
]);

/**
 * True when any work-shaped event landed after `seq` (a re-accept is then meaningful).
 * The acceptance's OWN retirement (`plan.discarded` reason 'accepted') is excluded — the
 * cleanup an accept performs must never read as "work happened since the accept" (review
 * F1: it made the very next /accept append a duplicate consent event).
 */
export function workSince(events: readonly SessionEvent[], seq: number): boolean {
  return events.some(
    (e) => e.seq > seq && WORK_EVENT_TYPES.has(e.type) && !(e.type === 'plan.discarded' && e.reason === 'accepted'),
  );
}

export function computeAcceptance(
  planState: PlanState,
  graphState: GraphState | null,
  events: readonly SessionEvent[],
): AcceptanceState {
  const unfinished: string[] = [];
  /** Non-blocking honesty: things a reader of "complete" must still be told (Session 12). */
  const caveats: string[] = [];

  // Plan axis. A superseded (discarded/retired) plan never blocks; a draft is NOT silently
  // complete — accepting work the user never approved a plan for is a consent mismatch, so it
  // goes on the unfinished list and requires the explicit /accept confirm path.
  if (planState.kind === 'canonical') {
    if (planState.status === 'draft') {
      unfinished.push('plan draft pending approval — /plan approve to execute it, or /plan discard');
    } else if (planState.status === 'unknown') {
      unfinished.push('plan document unreadable (status unknown) — fix the file or /plan discard');
    } else if (planState.status === 'approved' && !planState.approvedAndCurrent) {
      unfinished.push(
        planState.diverged
          ? 'plan DIVERGED after approval — /plan approve the current content or /plan discard'
          : 'plan file says approved but no recorded consent exists — /plan approve',
      );
    } else if (planState.status === 'approved' && graphState !== null) {
      for (const t of graphState.tasks) {
        if (t.state === 'parent-owned') continue;
        if (t.state === 'completed') {
          // Session 12: a completed task whose declared gate has not passed is NOT finished.
          // This axis is explicit rather than free: keeping `completed` as the state (so R5 still
          // refuses duplicate re-runs) means the completeness loop no longer sees it for free.
          if (t.verification.status === 'pending') {
            unfinished.push(
              `plan task '${t.id}' is completed but its required check(s) have not passed since integration: ${t.verification.missing.join(', ')} — prove with ${proveWith(t.verification.missing)}`,
            );
          }
          continue;
        }
        unfinished.push(`plan task '${t.id}' is ${t.state}${t.state === 'blocked' ? ` (on ${t.blockedOn.join(', ')})` : ''}`);
      }
      // The COMPLETION boundary gate: broader checks measured against the LAST change in the
      // session, so integrating more work or undoing something correctly re-opens it.
      const graph = planState.canonical?.graph ?? null;
      if (graph !== null) {
        const gate = completionGateState(graph, events);
        for (const kind of gate.pending) {
          unfinished.push(`completion gate '${kind}' has not passed since the last change — prove with ${proveWith([kind])} before accepting`);
        }
        for (const kind of gate.waived) caveats.push(`completion gate '${kind}' NEVER RAN (unsupported in this project)`);
      }
      // A waived per-task gate is not a blocker, but it must not vanish either: a recorded
      // acceptance that says "complete" while a gate the user approved never executed would be
      // exactly the overclaim this boundary exists to prevent.
      for (const t of graphState.tasks) {
        if (t.verification.waived.length > 0) {
          caveats.push(`task '${t.id}' check(s) ${t.verification.waived.join(', ')} NEVER RAN (unsupported in this project)`);
        }
      }
    }
  } else if (planState.kind === 'legacy' && planState.status !== 'superseded') {
    unfinished.push('a legacy (V0.7) plan document cannot be completion-checked — /plan discard to clear it');
  }

  // Captures axis — registry-wide (bound AND unbound executor work): every applicable captured
  // file must be applied or the work exists only as blobs. Same applicability rule as the fold:
  // deletes always apply; oversize/blob-less entries can never apply and never block.
  const captured = new Map<string, TaskChangeFile[]>();
  const applied = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type === 'task.changes') captured.set(e.childSessionId, e.files);
    else if (e.type === 'task.applied') {
      const set = applied.get(e.childSessionId) ?? new Set<string>();
      for (const p of e.applied) set.add(p);
      applied.set(e.childSessionId, set);
    }
  }
  let capturesSeen = 0;
  let capturesOutstanding = false;
  for (const [child, files] of captured) {
    const appliedSet = applied.get(child) ?? new Set<string>();
    const applicable = files.filter((f) => f.kind === 'delete' || (f.blobSha256 !== null && f.oversize !== true));
    capturesSeen += applicable.length;
    const unapplied = applicable.filter((f) => !appliedSet.has(f.relPath));
    if (unapplied.length > 0) {
      capturesOutstanding = true;
      unfinished.push(`${unapplied.length} captured file(s) from task ${child.slice(-4)} not applied — apply_task_changes (child ${child})`);
    }
  }

  // Repair axis (Session 12): an escalation that nobody resolved, and a repair whose own declared
  // regression checks never passed, are honest unfinished work — a session must not be accepted
  // as complete while the agent has an open "I stopped and need you" on the record. An escalation
  // on a plan task that is now completed with its gate satisfied is resolved BY EVIDENCE, which
  // is what keeps a non-auto-eligible escalation from being an unclosable trap.
  const resolvedTargets = new Set<string>(
    (graphState?.tasks ?? [])
      .filter((t) => (t.state === 'completed' && t.verification.status !== 'pending') || t.state === 'parent-owned')
      .map((t) => t.id),
  );
  for (const blocker of openRepairBlockers(foldRepairs(events), { resolvedTargets })) unfinished.push(blocker);

  // Review axis (Session 14): the structural review gate. The REQUIREMENT derives only from a
  // plan the user actually APPROVED (a draft/superseded/diverged plan is already blocked or
  // retired by the axes above, and a retired plan must not keep requiring reviews of new
  // unplanned work) — but the fold runs even without one, because recorded critical/high
  // findings block regardless of how the round came to run: evidence cannot be unseen. The
  // blockers and caveats arrive pre-rendered from the one fold /review also shows.
  const reviewGraph = planState.kind === 'canonical' && planState.status === 'approved' ? (planState.canonical?.graph ?? null) : null;
  const review = foldReview(reviewGraph, events);
  for (const blocker of review.openBlockers) unfinished.push(blocker);
  for (const caveat of review.caveats) caveats.push(caveat);

  // The latest recorded acceptance, if any.
  let accepted: RecordedAcceptance | null = null;
  for (const e of events) {
    if (e.type === 'session.accepted') {
      accepted = { complete: e.complete, summary: e.summary, unfinished: e.unfinished ?? [], seq: e.seq };
    }
  }

  const retiredByAccept = events.some((e) => e.type === 'plan.discarded' && e.reason === 'accepted');
  const planBit =
    graphState !== null && planState.status !== 'superseded'
      ? `plan ${graphState.summary.split(' · ')[0]!}`
      : planState.kind === 'none'
        ? 'no plan'
        : planState.status === 'superseded' && retiredByAccept
          ? 'plan retired (accepted)'
          : `plan ${planState.status}`;
  const capturesBit = capturesSeen > 0 ? (capturesOutstanding ? 'captures outstanding' : 'captures integrated') : null;
  const caveatBit = caveats.length > 0 ? ` · CAVEATS: ${caveats.join('; ')}` : '';
  const summary =
    unfinished.length === 0
      ? `complete — ${planBit}${capturesBit !== null ? ` · ${capturesBit}` : ''}${caveatBit}`
      : `${unfinished.length} unfinished — ${planBit}${capturesBit !== null ? ` · ${capturesBit}` : ''}${caveatBit}`;

  return {
    complete: unfinished.length === 0,
    summary,
    unfinished,
    caveats,
    accepted,
    acceptedStale: accepted !== null && workSince(events, accepted.seq),
  };
}
