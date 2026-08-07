import type { SessionEvent, TaskChangeFile } from '../types.js';
import { approvedCurrentGraph, type PlanState } from '../plan/canonical.js';
import { completionGateState, type GraphState } from '../plan/graph-state.js';
import { foldRepairs, openRepairBlockers } from '../recovery/ledger.js';
import { foldReview, MAX_REVIEW_ROUNDS } from '../review/ledger.js';
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
  // An install writes a whole dependency tree and a migration writes a database (Session 16):
  // the same spawned-and-writes class again. Deliberately `setup.started` only, matching
  // `check.started` — counting the completion too would double one unit of work.
  'setup.started',
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
  // Folded once, up front: the plan-task loop needs it to tell an UNBOUND reviewer task apart
  // from outstanding review work, and the review axis below consumes the same result.
  const reviewFold = foldReview(approvedCurrentGraph(planState), events);

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
            const taskProject = planState.canonical?.graph?.tasks.find((x) => x.id === t.id)?.project;
            unfinished.push(
              `plan task '${t.id}' is completed but its required check(s) have not passed since integration: ${t.verification.missing.join(', ')} — prove with ${proveWith(t.verification.missing, taskProject)}`,
            );
          }
          continue;
        }
        // A REVIEWER task that was never bound to a delegate call, in a session whose review
        // requirement is otherwise satisfied, is a dead end rather than outstanding work. The
        // reviewers ran — their captures and findings are in the log — but without
        // `plan_task: '<id>'` on the delegate call the DAG fold cannot see the binding, so the
        // task sits `queued` forever. And once MAX_REVIEW_ROUNDS is spent there is NO call left
        // that could bind it: the agent cannot clear this, and neither can the user except by
        // amending the plan or overriding. (Found live: a session with three lens captures and
        // fourteen findings refused four times on `plan task 'review' is queued`.)
        //
        // The REVIEW GATE is unaffected — `foldReview` derives the requirement from the recorded
        // rounds and findings independently, and still blocks below on anything it finds open.
        // What is dropped here is only the planning artifact's binding, and it is dropped
        // LOUDLY, as a caveat.
        const unboundReviewer =
          t.role === 'reviewer' && (t.state === 'queued' || t.state === 'blocked') && t.attempts === 0 && reviewFold.satisfied && reviewFold.rounds.length > 0;
        if (unboundReviewer) {
          caveats.push(
            `plan task '${t.id}' was never bound to a delegate call (no \`plan_task\` argument), so the graph cannot ` +
              `attribute the ${String(reviewFold.rounds.length)} recorded review round(s) to it — the review requirement itself IS satisfied`,
          );
          continue;
        }
        // The BOUND-but-dead variant, one event later (S16.5b review): a reviewer task whose
        // child ended failed/cancelled/interrupted while a SIBLING round satisfied the review
        // requirement. While rounds remain, a re-spawn with `plan_task` is a real cure — keep
        // blocking. Once the round cap is spent, no delegate call that could re-bind it will
        // ever be allowed again: the same dead end e933677 closed for the unbound case.
        const deadBoundReviewer =
          t.role === 'reviewer' &&
          (t.state === 'failed' || t.state === 'cancelled' || t.state === 'interrupted') &&
          reviewFold.satisfied &&
          reviewFold.rounds.length >= MAX_REVIEW_ROUNDS;
        if (deadBoundReviewer) {
          caveats.push(
            `plan task '${t.id}' (reviewer) ended ${t.state}, but the review requirement itself IS satisfied by the ` +
              `recorded round(s), and the ${String(MAX_REVIEW_ROUNDS)}-round cap is spent — no delegate call remains that could re-bind it`,
          );
          continue;
        }
        unfinished.push(`plan task '${t.id}' is ${t.state}${t.state === 'blocked' ? ` (on ${t.blockedOn.join(', ')})` : ''}`);
      }
      // The COMPLETION boundary gate: broader checks measured against the LAST change in the
      // session, so integrating more work or undoing something correctly re-opens it.
      const graph = planState.canonical?.graph ?? null;
      if (graph !== null) {
        const gate = completionGateState(graph, events);
        const scopeOf = (
          kind: string,
        ): { missingIn: string[]; passedIn: string[]; waivedIn: string[]; toolchainUnavailableIn?: string[] } | undefined =>
          gate.byKind.find((b) => b.kind === kind);
        for (const kind of gate.pending) {
          // Name the project that is actually missing. "prove with run_check test" is a call a
          // multi-project workspace refuses as ambiguous, so a blocker that omits the scope it
          // already knows cannot be acted on — the agent re-runs where it already passed and
          // gets the identical blocker back.
          const s = scopeOf(kind);
          const missing = s?.missingIn.filter((p) => p !== '.') ?? [];
          const where = missing.length > 0 ? ` in project ${missing.join(', ')}` : '';
          unfinished.push(
            `completion gate '${kind}' has not passed since the last change${where} — prove with ${proveWith([kind], missing[0])} before accepting`,
          );
        }
        for (const kind of gate.waived) {
          // "NEVER RAN" was false whenever the kind passed somewhere and was unsupported
          // elsewhere — the caveat has to say which half of the stack it is talking about.
          // Session 18: a MISSING-TOOLCHAIN waiver says so loudly. "This machine lacks the
          // compiler (the recorded check evidence names the install cure)" and "this project
          // cannot run the kind" are different statements to hand a reader of the acceptance.
          const s = scopeOf(kind);
          // S18 review, two rendering rules: '.' is a REAL, nameable scope whenever the gate is
          // project-scoped (filtering it as the unscoped placeholder silently dropped a root
          // toolchain waiver), and mixed reasons SPLIT — the toolchain sentence must never be
          // asserted about a project whose waiver was a genuine capability answer.
          const rawWaived = s?.waivedIn ?? [];
          const rawTc = s?.toolchainUnavailableIn ?? [];
          const passedIn = s?.passedIn ?? [];
          const name = (p: string): string => (p === '.' ? 'the workspace root' : `project ${p}`);
          const names = (list: string[]): string => list.map(name).join(', ');
          const tcUnscoped = gate.toolchainUnavailable?.includes(kind) === true;
          if (rawWaived.length > 0) {
            const tcScopes = rawWaived.filter((p) => rawTc.includes(p));
            const plainScopes = rawWaived.filter((p) => !rawTc.includes(p));
            const passedClause = passedIn.length > 0 ? `; it passed in ${names(passedIn)}` : '';
            if (plainScopes.length > 0) {
              caveats.push(
                `completion gate '${kind}' NEVER RAN in ${names(plainScopes)} (unsupported there)` +
                  (tcScopes.length === 0 ? passedClause : ''),
              );
            }
            if (tcScopes.length > 0) {
              caveats.push(
                `completion gate '${kind}' NEVER RAN in ${names(tcScopes)} — its TOOLCHAIN IS NOT INSTALLED on this machine; the recorded check evidence names the install cure` +
                  passedClause,
              );
            }
          } else {
            caveats.push(
              tcUnscoped
                ? `completion gate '${kind}' NEVER RAN — the TOOLCHAIN IS NOT INSTALLED on this machine; the recorded check evidence names the install cure`
                : `completion gate '${kind}' NEVER RAN (unsupported in this project)`,
            );
          }
        }
      }
      // A waived per-task gate is not a blocker, but it must not vanish either: a recorded
      // acceptance that says "complete" while a gate the user approved never executed would be
      // exactly the overclaim this boundary exists to prevent.
      for (const t of graphState.tasks) {
        if (t.verification.waived.length > 0) {
          const p = planState.canonical?.graph?.tasks.find((x) => x.id === t.id)?.project;
          const where = p !== undefined && p !== '.' ? `project ${p}` : 'this project';
          const tc = t.verification.toolchainUnavailable ?? [];
          const plain = t.verification.waived.filter((k) => !tc.includes(k));
          if (plain.length > 0) {
            caveats.push(`task '${t.id}' check(s) ${plain.join(', ')} NEVER RAN (unsupported in ${where})`);
          }
          if (tc.length > 0) {
            caveats.push(
              `task '${t.id}' check(s) ${tc.join(', ')} NEVER RAN — the TOOLCHAIN IS NOT INSTALLED on this machine; the recorded check evidence names the install cure`,
            );
          }
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
  // Document artifacts (Session 17): the LATEST render per path speaks for the file on disk.
  // A failing deterministic validation is a LOUD CAVEAT, deliberately not unfinished work this
  // session: blocker semantics need delete/undo resolution rules that do not exist yet, and an
  // abandoned draft artifact must not hold acceptance hostage. Never blocking ≠ never said.
  {
    const latestByPath = new Map<string, { format: string; failures: number }>();
    for (const e of events) {
      if (e.type !== 'artifact.rendered') continue;
      if (e.validation.status === 'fail') {
        // failureCount, never findings.length: the findings array mixes structural failures with
        // layout NOTES and is capped at the emit site, so its length both inflates and
        // under-reports the number this line is about.
        latestByPath.set(e.path, { format: e.format, failures: e.validation.failureCount ?? e.validation.findings.length });
      } else {
        latestByPath.delete(e.path);
      }
    }
    // An artifact that was undone or removed after its failing render is not a delivered file:
    // a later mutation of that path (undo restores bytes through file.mutated too) retires the
    // caveat rather than asserting something about bytes that are gone.
    for (const e of events) {
      if (e.type === 'file.mutated' && latestByPath.has(e.path)) {
        const renderSeqs = events.filter((x) => x.type === 'artifact.rendered' && x.path === e.path).map((x) => x.seq);
        const lastRenderSeq = renderSeqs.length > 0 ? Math.max(...renderSeqs) : -1;
        if (e.seq > lastRenderSeq) latestByPath.delete(e.path);
      }
    }
    for (const [p, v] of latestByPath) {
      caveats.push(
        `artifact '${p}' (${v.format}): its LATEST render failed deterministic validation (${String(v.failures)} structural finding(s)) — ` +
          'the delivered file does not match its spec; re-render or state why it is acceptable',
      );
    }
  }

  // Web research (Session 19). Never a blocker and never work: research events stay out of
  // WORK_EVENT_TYPES, exactly like artifacts, because reading the web changes nothing here.
  //
  // But a session accepted as COMPLETE whose conclusions rest on external sources should not hide
  // that provenance behind the word "complete". Two things a later reader needs and cannot
  // reconstruct: that external material shaped this work at all, and that some of it rested on a
  // single source or on sources that disagreed — the two shapes most likely to be wrong. Named,
  // never blocking.
  {
    let searches = 0;
    let extracts = 0;
    let notes = 0;
    let single = 0;
    let conflicting = 0;
    const childTasks = new Set<string>();
    for (const e of events) {
      if (e.type === 'research.searched') searches++;
      else if (e.type === 'research.extracted') extracts++;
      else if (e.type === 'research.usage') {
        childTasks.add(e.childSessionId);
        searches += e.searches;
        extracts += e.extracts;
      } else if (e.type === 'research.findings') {
        notes += e.notes.length;
        single += e.notes.filter((n) => n.corroboration === 'single-source').length;
        conflicting += e.notes.filter((n) => n.corroboration === 'sources-disagree').length;
      }
    }
    if (searches > 0 || extracts > 0) {
      caveats.push(
        `this session consulted the WEB (${String(searches)} search(es), ${String(extracts)} page read(s)` +
          `${childTasks.size > 0 ? `, ${String(childTasks.size)} delegated research task(s)` : ''}` +
          `${notes > 0 ? `, ${String(notes)} recorded finding(s)` : ''}) — external information is context, ` +
          'never verification; nothing it produced marks a file CHECKED (`/research` shows every query and source)',
      );
    }
    if (single > 0 || conflicting > 0) {
      caveats.push(
        `research findings needing a second look: ${String(single)} rest on a SINGLE source` +
          `${conflicting > 0 ? ` and ${String(conflicting)} record SOURCES THAT DISAGREE` : ''} — ` +
          'verify any of these that load-bearing work depends on',
      );
    }
  }

  // blockers and caveats arrive pre-rendered from the one fold /review also shows.
  // approvedCurrentGraph, not merely 'approved' (review): divergence is already its own
  // blocker; the shared filter keeps the ATTRIBUTION honest too (see its doc in canonical.ts).
  for (const blocker of reviewFold.openBlockers) unfinished.push(blocker);
  for (const caveat of reviewFold.caveats) caveats.push(caveat);

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
