import type { PlanGraph } from '../plan/schema.js';
import type { ReviewFinding, SessionEvent } from '../types.js';

/**
 * The structural review gate's pure fold (Session 14): events → ReviewState. The house
 * pattern — no store, no recorded outcomes, everything re-derivable from the log alone.
 *
 * Three load-bearing rules, each the survivor of a design attack:
 *
 * 1. REQUIREMENT IS DERIVED, NOT STORED. A plan with ≥1 executor task requires a review round
 *    by default; the plan's optional `review` field can waive it (visibly, with a reason the
 *    user approved) or force it. Storing the requirement would let a schema default rewrite
 *    history; deriving it keeps resumed pre-S14 plans honest — they newly block, which is the
 *    point of a structural gate, and /accept confirm remains the user's sovereign exit.
 *
 *    SCOPE BOUNDARY (deliberate, review-confirmed): the requirement is PLAN-scoped. Executor
 *    work delegated with no plan at all — which the DAG gate deliberately permits, with the
 *    per-spawn human ask as the consent floor — derives no requirement, so such a session can
 *    be accepted without a review round. This is the user's explicit choice of "executor plans
 *    by default" over "any mutating session"; the alternative would change acceptance for
 *    every plan-less session. What is NOT optional: findings recorded by a round that DID run
 *    block regardless of requirement or plan (see the blockers below).
 *
 * 2. A ROUND QUALIFIES ONLY AGAINST REAL WORK. No effective integration (`task.applied` with
 *    applied files) may land INSIDE the round's window — reviewers that observed mid-apply
 *    state reviewed neither the before nor the after. And at least one unit of real work must
 *    PRECEDE the round's start: a workspace change, or an executor capture (`task.changes`) —
 *    the capture covers the legitimate zero-net-change case, where an executor ran, concluded
 *    nothing needed to change, and the session is genuinely complete (S14.5: the old
 *    change-only anchor made such a session's gate unsatisfiable). Otherwise a review run
 *    before any work would satisfy the gate vacuously. POST-ROUND fixes — parent edits AND
 *    integrated executor re-runs alike — do NOT de-qualify the round (that would loop forever:
 *    fix → stale → re-review → fix …, and the S14 whole-log rule punished exactly the
 *    harness-recommended fix path); they surface as the changes-after caveat, findings never
 *    expire (rule 3), and the deterministic completion gates still cover the current state.
 *
 * 3. FINDINGS NEVER EXPIRE; TRIAGE ANNOTATES. A later round does not supersede earlier
 *    findings — that would let a weak round 2 launder round 1's criticals. Every critical/high
 *    finding must be individually cleared: refuted with recorded evidence (an UNVERIFIED MODEL
 *    CLAIM, labeled as such everywhere — and surfaced as an acceptance CAVEAT, because it is
 *    the cheapest path past the gate and the only one whose evidence is a bare claim), or
 *    addressed with cited refs the fold verifies both EXIST in the log and POSTDATE the
 *    finding (existence and ordering are derived; semantic adequacy stays a model claim), or
 *    carried past the gate by the user's /accept confirm. 'accept' (a recorded limitation) is
 *    valid for medium/low only — re-checked here, not just in the tool schema.
 */

export type ReviewRequirement =
  | { kind: 'none' }
  | { kind: 'required'; source: 'declared' | 'derived' }
  | { kind: 'waived'; reason: string };

export type FindingStatus = 'open' | 'verified' | 'refuted' | 'accepted' | 'addressed';

export interface TriageRecord {
  seq: number;
  action: 'verify' | 'refute' | 'accept' | 'address';
  evidence: string;
  refs?: string[];
  /** Whether this triage changed the derived status (an ineffective one is kept, with why). */
  effective: boolean;
  note?: string;
}

export interface ReviewFindingState {
  finding: ReviewFinding;
  childSessionId: string;
  lens?: string;
  /** 1-based index of the round that recorded it. */
  round: number;
  status: FindingStatus;
  triage: TriageRecord[];
  /** critical/high and neither refuted nor addressed — the gate blockers. 'verified' is still
   *  blocking: confirmed-real-and-unfixed is the strongest reason to block. */
  blocking: boolean;
}

export interface ReviewRound {
  callId: string;
  /** When the round's reviewers started observing (first task.started of the call). */
  startSeq: number;
  /** The last capture/end evidence of the call. */
  endSeq: number;
  /** Reviewer children observed on this call. */
  lenses: number;
  /** Lenses that completed AND captured (an empty findings list is a recorded clean lens). */
  captured: number;
  /** Short child ids of lenses that died/timed out/lost capture — surfaced, never hidden. */
  deadLenses: string[];
  findingsCount: number;
  qualifying: boolean;
  note?: string;
}

export interface ReviewState {
  requirement: ReviewRequirement;
  rounds: ReviewRound[];
  findings: ReviewFindingState[];
  /** Rendered blocker lines for the acceptance axis (empty when the gate is satisfiable now):
   *  the missing/stale-round blocker (only when required) plus every blocking finding
   *  (ALWAYS — a waiver never launders what a voluntarily-run round recorded). */
  openBlockers: string[];
  /** No open blockers right now. */
  satisfied: boolean;
  /** Non-blocking honesty: the waiver, accepted limitations, dead lenses, post-review changes. */
  caveats: string[];
}

/** The workspace-change event test shared by rule 2's precondition and the staleness caveat
 *  (the completionGateState change set — undo/restore count only when they restored files —
 *  plus effective applies: a real apply also records file.mutated, but the fold must not
 *  depend on that coupling; an apply after a round is already a hard disqualifier anyway). */
function isWorkspaceChange(e: SessionEvent): boolean {
  if (e.type === 'file.mutated') return true;
  if (e.type === 'undo.applied' && e.restored.length > 0) return true;
  if (e.type === 'git.restore' && e.restored.length > 0) return true;
  if (e.type === 'task.applied' && e.applied.length > 0) return true;
  return false;
}

export function deriveRequirement(graph: PlanGraph | null): ReviewRequirement {
  if (graph === null) return { kind: 'none' };
  if (graph.review?.mode === 'waived') return { kind: 'waived', reason: graph.review.reason ?? '(no reason recorded)' };
  if (graph.review?.mode === 'required') return { kind: 'required', source: 'declared' };
  if (graph.tasks.some((t) => t.role === 'executor')) return { kind: 'required', source: 'derived' };
  return { kind: 'none' };
}

export function foldReview(graph: PlanGraph | null, events: readonly SessionEvent[]): ReviewState {
  const requirement = deriveRequirement(graph);

  // ---- Rounds: group review.findings captures by delegate callId. -------------------------
  interface RoundAcc {
    callId: string;
    startSeq: number;
    endSeq: number;
    reviewerChildren: Set<string>;
    completedChildren: Set<string>;
    capturedChildren: Set<string>;
    /** Terminal status per reviewer child — lets a non-qualifying note NAME a budget exit. */
    endStatuses: Map<string, string>;
    findings: { f: ReviewFinding; child: string; lens?: string }[];
  }
  const roundByCall = new Map<string, RoundAcc>();
  const reviewerCallIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'task.started' && e.role === 'reviewer') reviewerCallIds.add(e.callId);
    else if (e.type === 'review.findings') reviewerCallIds.add(e.callId);
  }
  for (const e of events) {
    if (e.type !== 'task.started' && e.type !== 'task.ended' && e.type !== 'review.findings') continue;
    if (!reviewerCallIds.has(e.callId)) continue;
    let acc = roundByCall.get(e.callId);
    if (acc === undefined) {
      acc = {
        callId: e.callId,
        startSeq: e.seq,
        endSeq: e.seq,
        reviewerChildren: new Set(),
        completedChildren: new Set(),
        capturedChildren: new Set(),
        endStatuses: new Map(),
        findings: [],
      };
      roundByCall.set(e.callId, acc);
    }
    acc.endSeq = Math.max(acc.endSeq, e.seq);
    if (e.type === 'task.started') {
      acc.startSeq = Math.min(acc.startSeq, e.seq);
      if (e.role === 'reviewer') acc.reviewerChildren.add(e.childSessionId);
    } else if (e.type === 'task.ended') {
      if (acc.reviewerChildren.has(e.childSessionId)) {
        acc.endStatuses.set(e.childSessionId, e.status);
        if (e.status === 'completed') acc.completedChildren.add(e.childSessionId);
      }
    } else {
      acc.capturedChildren.add(e.childSessionId);
      for (const f of e.findings) {
        acc.findings.push({ f, child: e.childSessionId, ...(e.lens !== undefined ? { lens: e.lens } : {}) });
      }
    }
  }

  // Rule 2's anchors: every effective integration seq (the in-window test), and the "real
  // work" seqs — workspace changes plus executor captures (`task.changes`, S14.5: an executor
  // that ran and concluded nothing needed changing is still real work a round can review).
  const effectiveApplySeqs: number[] = [];
  for (const e of events) {
    if (e.type === 'task.applied' && e.applied.length > 0) effectiveApplySeqs.push(e.seq);
  }
  const changeSeqs = events.filter(isWorkspaceChange).map((e) => e.seq);
  const workSeqs = [...changeSeqs, ...events.filter((e) => e.type === 'task.changes').map((e) => e.seq)];
  const anyWorkBefore = (seq: number): boolean => workSeqs.some((s) => s < seq);

  const rounds: ReviewRound[] = [...roundByCall.values()]
    .sort((a, b) => a.startSeq - b.startSeq)
    .map((acc) => {
      // A lens qualifies the round only when it completed AND its capture landed (a completed
      // reviewer with no capture = the round's evidence was lost — mirror of executor F1).
      const effective = [...acc.completedChildren].filter((c) => acc.capturedChildren.has(c));
      const dead = [...acc.reviewerChildren].filter((c) => !effective.includes(c));
      let qualifying = true;
      let note: string | undefined;
      if (effective.length === 0) {
        qualifying = false;
        note = 'no reviewer lens completed with a recorded findings capture';
        // Name a budget/timeout exit so the parent knows the honest next move (S14.5: the
        // generic note plus per-finding blockers read as a dead end; it is a scoping problem).
        const spent = [...acc.endStatuses.entries()].filter(([, s]) => s === 'budget-steps' || s === 'budget-tokens' || s === 'timeout');
        if (spent.length > 0) {
          note += ` (${spent.map(([c, s]) => `lens ${c.slice(-4)} ended '${s}'`).join(', ')} — re-run ONE round with narrower lens scopes; findings it recorded are already counted)`;
        }
      } else if (effectiveApplySeqs.some((s) => s >= acc.startSeq && s <= acc.endSeq)) {
        qualifying = false;
        note = 'an integration landed DURING this round — the reviewers observed mixed state; re-run the round against the settled workspace';
      } else if (!anyWorkBefore(acc.startSeq)) {
        qualifying = false;
        note = 'no workspace change or executor capture preceded this round — a review of nothing satisfies nothing';
      }
      return {
        callId: acc.callId,
        startSeq: acc.startSeq,
        endSeq: acc.endSeq,
        lenses: acc.reviewerChildren.size,
        captured: effective.length,
        deadLenses: dead.map((c) => c.slice(-4)),
        findingsCount: acc.findings.length,
        qualifying,
        ...(note !== undefined ? { note } : {}),
      };
    });

  // ---- Findings: flat across all rounds (rule 3 — no expiry), with derived triage status. --
  const roundIndexByCall = new Map(rounds.map((r, i) => [r.callId, i + 1] as const));
  const findingStates = new Map<string, ReviewFindingState>();
  for (const acc of roundByCall.values()) {
    for (const { f, child, lens } of acc.findings) {
      findingStates.set(f.findingId, {
        finding: f,
        childSessionId: child,
        ...(lens !== undefined ? { lens } : {}),
        round: roundIndexByCall.get(acc.callId) ?? 0,
        status: 'open',
        triage: [],
        blocking: false,
      });
    }
  }

  // 'address' existence check: cited refs must name evidence that EXISTS in this log — a
  // callId that produced mutations/applies/passing checks, or a passing check's recipeId —
  // and that evidence must POSTDATE the finding it claims to address (review: citing a check
  // that passed before the round ran, or the very mutation the finding criticizes, cleared a
  // critical with no new evidence at all). Existence and ordering are both derived; whether
  // the fix is semantically adequate stays a labeled model claim.
  const refSeqs = new Map<string, number>();
  const noteRef = (key: string, seq: number): void => {
    refSeqs.set(key, Math.max(refSeqs.get(key) ?? 0, seq));
  };
  for (const e of events) {
    if (e.type === 'file.mutated' || (e.type === 'task.applied' && e.applied.length > 0)) noteRef(e.callId, e.seq);
    else if (e.type === 'check.completed' && e.status === 'pass') {
      noteRef(e.callId, e.seq);
      noteRef(e.recipeId, e.seq);
    }
  }
  /** The seq at which each finding was RECORDED (its capture event) — the ordering anchor. */
  const findingSeq = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'review.findings') for (const f of e.findings) findingSeq.set(f.findingId, e.seq);
  }

  for (const e of events) {
    if (e.type !== 'review.triage') continue;
    const st = findingStates.get(e.findingId);
    if (st === undefined) continue; // a triage for an unknown finding annotates nothing
    const rec: TriageRecord = {
      seq: e.seq,
      action: e.action,
      evidence: e.evidence,
      ...(e.refs !== undefined ? { refs: e.refs } : {}),
      effective: true,
    };
    const sev = st.finding.severity;
    if (e.action === 'accept' && (sev === 'critical' || sev === 'high')) {
      rec.effective = false;
      rec.note = `'accept' is invalid for ${sev} findings — refute with evidence, address with cited refs, or the user records /accept confirm`;
    } else if (e.action === 'address') {
      const refs = e.refs ?? [];
      const anchor = findingSeq.get(e.findingId) ?? 0;
      const missing = refs.filter((r) => !refSeqs.has(r));
      const stale = refs.filter((r) => refSeqs.has(r) && (refSeqs.get(r) ?? 0) < anchor);
      if (refs.length === 0) {
        rec.effective = false;
        rec.note = "'address' requires refs citing the fix (mutating callIds or passing check recipeIds)";
      } else if (missing.length > 0) {
        rec.effective = false;
        rec.note = `cited ref(s) not found in this session's evidence: ${missing.join(', ')}`;
      } else if (stale.length > 0) {
        rec.effective = false;
        rec.note = `cited ref(s) predate the finding and cannot be its fix: ${stale.join(', ')} — make the change, then re-run the check that proves it`;
      }
    }
    st.triage.push(rec);
    if (rec.effective) {
      st.status =
        e.action === 'verify' ? 'verified' : e.action === 'refute' ? 'refuted' : e.action === 'accept' ? 'accepted' : 'addressed';
    }
  }

  const findings = [...findingStates.values()];
  for (const st of findings) {
    const sev = st.finding.severity;
    st.blocking = (sev === 'critical' || sev === 'high') && (st.status === 'open' || st.status === 'verified');
  }

  // ---- Gate derivation. --------------------------------------------------------------------
  const caveats: string[] = [];
  const openBlockers: string[] = [];
  const qualifying = rounds.filter((r) => r.qualifying);
  const latestQualifying = qualifying.length > 0 ? qualifying[qualifying.length - 1]! : null;

  if (requirement.kind === 'waived') {
    caveats.push(`adversarial review WAIVED by the approved plan: ${requirement.reason}`);
  }

  if (requirement.kind === 'required' && latestQualifying === null) {
    const label = requirement.source === 'declared' ? 'declared by the plan' : 'derived: the plan has executor tasks';
    const why =
      rounds.length === 0
        ? 'no review round has run'
        : `no round qualifies (${rounds[rounds.length - 1]!.note ?? 'see /review'})`;
    openBlockers.push(
      `adversarial review required (${label}) — ${why}; run ONE bounded reviewer group (delegate_task, 2-3 differentiated read-only lenses) after integration`,
    );
  }
  // A recorded critical/high finding blocks REGARDLESS of the requirement: a waiver waives the
  // round requirement, never the consequences of what a voluntarily-run round actually found —
  // evidence, once recorded, cannot be unseen.
  for (const st of findings) {
    if (!st.blocking) continue;
    openBlockers.push(
      `review finding ${st.finding.findingId} (${st.finding.severity}) '${st.finding.title}' is ${st.status === 'verified' ? 'verified real and unaddressed' : 'untriaged'} — verify/refute/address it via the review tool, or /accept confirm`,
    );
  }

  for (const r of rounds) {
    if (r.deadLenses.length === 0) continue;
    // S14.5: the `captured > 0` guard hid the WORST case — a round in which every lens died
    // emitted no caveat at all when no requirement was in force, so a review that entirely
    // failed read identically to a session that never ran one.
    caveats.push(
      r.captured > 0
        ? `review round ${roundIndexByCall.get(r.callId)}: lens(es) ${r.deadLenses.join(', ')} did not complete — their scope went unreviewed`
        : `review round ${roundIndexByCall.get(r.callId)}: ALL ${r.lenses} lens(es) (${r.deadLenses.join(', ')}) died without qualifying evidence — the round proved nothing`,
    );
  }
  for (const st of findings) {
    if (st.status === 'accepted') {
      caveats.push(`accepted limitation (${st.finding.severity}): ${st.finding.findingId} '${st.finding.title}'`);
    }
    // A REFUTED critical/high is the cheapest path past the gate and the only one whose
    // evidence is a bare model claim — it must be as visible at the consent boundary as an
    // accepted medium (review: 'complete' otherwise showed nothing at all). ADDRESSED is
    // deliberately not a caveat: its refs are existence- and order-checked against the log.
    if (st.status === 'refuted' && (st.finding.severity === 'critical' || st.finding.severity === 'high')) {
      caveats.push(
        `${st.finding.severity} finding ${st.finding.findingId} '${st.finding.title}' was REFUTED by the agent, not fixed — an UNVERIFIED model claim (see /review or the report for its evidence)`,
      );
    }
  }
  if (latestQualifying !== null) {
    const changesAfter = changeSeqs.filter((s) => s > latestQualifying.endSeq).length;
    if (changesAfter > 0) {
      caveats.push(
        `${changesAfter} workspace change event(s) after the last review round — the round reviewed earlier state (deterministic gates still cover the current state)`,
      );
    }
  }

  const satisfied = openBlockers.length === 0;
  return { requirement, rounds, findings, openBlockers, satisfied, caveats };
}
