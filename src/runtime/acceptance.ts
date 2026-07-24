import type { SessionEvent, TaskChangeFile } from '../types.js';
import type { PlanState } from '../plan/canonical.js';
import type { GraphState } from '../plan/graph-state.js';

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
  /** The latest recorded /accept, when any. */
  accepted: RecordedAcceptance | null;
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
]);

/** True when any work-shaped event landed after `seq` (a re-accept is then meaningful). */
export function workSince(events: readonly SessionEvent[], seq: number): boolean {
  return events.some((e) => e.seq > seq && WORK_EVENT_TYPES.has(e.type));
}

export function computeAcceptance(
  planState: PlanState,
  graphState: GraphState | null,
  events: readonly SessionEvent[],
): AcceptanceState {
  const unfinished: string[] = [];

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
        if (t.state === 'completed' || t.state === 'parent-owned') continue;
        unfinished.push(`plan task '${t.id}' is ${t.state}${t.state === 'blocked' ? ` (on ${t.blockedOn.join(', ')})` : ''}`);
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
  for (const [child, files] of captured) {
    const appliedSet = applied.get(child) ?? new Set<string>();
    const applicable = files.filter((f) => f.kind === 'delete' || (f.blobSha256 !== null && f.oversize !== true));
    capturesSeen += applicable.length;
    const unapplied = applicable.filter((f) => !appliedSet.has(f.relPath));
    if (unapplied.length > 0) {
      unfinished.push(`${unapplied.length} captured file(s) from task ${child.slice(-4)} not applied — apply_task_changes (child ${child})`);
    }
  }

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
  const capturesBit = capturesSeen > 0 ? (unfinished.some((u) => u.includes('not applied')) ? 'captures outstanding' : 'captures integrated') : null;
  const summary =
    unfinished.length === 0
      ? `complete — ${planBit}${capturesBit !== null ? ` · ${capturesBit}` : ''}`
      : `${unfinished.length} unfinished — ${planBit}${capturesBit !== null ? ` · ${capturesBit}` : ''}`;

  return { complete: unfinished.length === 0, summary, unfinished, accepted };
}
