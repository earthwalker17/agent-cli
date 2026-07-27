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
 * 2. A ROUND QUALIFIES ONLY AGAINST REAL WORK. A qualifying round must START after the last
 *    effective integration (`task.applied` with applied files) AND at least one workspace
 *    change must PRECEDE its start — otherwise a review run before any work (or before the
 *    work landed) would satisfy the gate vacuously. Post-round parent fix-ups do NOT
 *    re-require review (that would loop forever: fix → stale → re-review → fix …); they
 *    surface as a caveat, and the deterministic completion gates still cover correctness.
 *
 * 3. FINDINGS NEVER EXPIRE; TRIAGE ANNOTATES. A later round does not supersede earlier
 *    findings — that would let a weak round 2 launder round 1's criticals. Every critical/high
 *    finding must be individually cleared: refuted with recorded evidence (an UNVERIFIED MODEL
 *    CLAIM, labeled as such everywhere), or addressed with cited refs the fold can verify
 *    EXIST in the log (existence is derived; semantic adequacy stays a model claim), or
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
 *  (the completionGateState change set — undo/restore count only when they restored files). */
function isWorkspaceChange(e: SessionEvent): boolean {
  if (e.type === 'file.mutated') return true;
  if (e.type === 'undo.applied' && e.restored.length > 0) return true;
  if (e.type === 'git.restore' && e.restored.length > 0) return true;
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
        findings: [],
      };
      roundByCall.set(e.callId, acc);
    }
    acc.endSeq = Math.max(acc.endSeq, e.seq);
    if (e.type === 'task.started') {
      acc.startSeq = Math.min(acc.startSeq, e.seq);
      if (e.role === 'reviewer') acc.reviewerChildren.add(e.childSessionId);
    } else if (e.type === 'task.ended') {
      if (acc.reviewerChildren.has(e.childSessionId) && e.status === 'completed') acc.completedChildren.add(e.childSessionId);
    } else {
      acc.capturedChildren.add(e.childSessionId);
      for (const f of e.findings) {
        acc.findings.push({ f, child: e.childSessionId, ...(e.lens !== undefined ? { lens: e.lens } : {}) });
      }
    }
  }

  // Rule 2's anchors: the last effective integration, and whether any change precedes a seq.
  let lastEffectiveApply = 0;
  for (const e of events) {
    if (e.type === 'task.applied' && e.applied.length > 0) lastEffectiveApply = Math.max(lastEffectiveApply, e.seq);
  }
  const changeSeqs = events.filter(isWorkspaceChange).map((e) => e.seq);
  const anyChangeBefore = (seq: number): boolean => changeSeqs.some((s) => s < seq);

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
      } else if (acc.startSeq <= lastEffectiveApply) {
        qualifying = false;
        note = 'the last integration postdates this round — the reviewers observed pre-integration state';
      } else if (!anyChangeBefore(acc.startSeq)) {
        qualifying = false;
        note = 'no workspace change preceded this round — a review of nothing satisfies nothing';
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
  // callId that produced mutations/applies/passing checks, or a passing check's recipeId.
  const mutatingCallIds = new Set<string>();
  const passingRecipeIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'file.mutated' || (e.type === 'task.applied' && e.applied.length > 0)) mutatingCallIds.add(e.callId);
    else if (e.type === 'check.completed' && e.status === 'pass') {
      mutatingCallIds.add(e.callId);
      passingRecipeIds.add(e.recipeId);
    }
  }
  const refExists = (ref: string): boolean => mutatingCallIds.has(ref) || passingRecipeIds.has(ref);

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
      const missing = refs.filter((r) => !refExists(r));
      if (refs.length === 0) {
        rec.effective = false;
        rec.note = "'address' requires refs citing the fix (mutating callIds or passing check recipeIds)";
      } else if (missing.length > 0) {
        rec.effective = false;
        rec.note = `cited ref(s) not found in this session's evidence: ${missing.join(', ')}`;
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
    if (r.deadLenses.length > 0 && r.captured > 0) {
      caveats.push(`review round ${roundIndexByCall.get(r.callId)}: lens(es) ${r.deadLenses.join(', ')} did not complete — their scope went unreviewed`);
    }
  }
  for (const st of findings) {
    if (st.status === 'accepted') {
      caveats.push(`accepted limitation (${st.finding.severity}): ${st.finding.findingId} '${st.finding.title}'`);
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
