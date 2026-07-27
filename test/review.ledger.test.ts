import { describe, it, expect } from 'vitest';
import { deriveRequirement, foldReview } from '../src/review/ledger.js';
import { PlanGraphSchema, validatePlanGraph, type PlanGraph } from '../src/plan/schema.js';
import type { ReviewFinding, SessionEvent } from '../src/types.js';

/**
 * Session 14 — the review ledger fold: requirement derivation, round qualification (a review
 * of nothing satisfies nothing; the last integration postdates a stale round), never-expiring
 * findings with derived triage effectiveness, and the blocker/caveat surfaces the acceptance
 * axis consumes.
 */

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-27T00:00:00.000Z', ...body }) as unknown as SessionEvent;
const reset = (): void => {
  seq = 0;
};

function graphOf(over: Record<string, unknown> = {}, tasks?: unknown[]): PlanGraph {
  const parsed = PlanGraphSchema.parse({
    objective: 'ship it',
    tasks: tasks ?? [{ id: 'api', title: 'API', intent: 'i', role: 'executor', verify: 'tests pass', touches: ['src'] }],
    ...over,
  });
  const v = validatePlanGraph(parsed);
  if (v.graph === undefined) throw new Error(`fixture graph invalid: ${v.errors.join('; ')}`);
  return v.graph;
}

const finding = (id: string, severity: ReviewFinding['severity'], title = 'bad thing'): ReviewFinding => ({
  findingId: id,
  severity,
  title,
  paths: ['src/a.ts'],
  evidence: 'read src/a.ts:10-20; the guard is missing',
  scenario: 'empty input reaches parseInt and NaN propagates',
  confidence: 'high',
});

const mutated = (): SessionEvent =>
  ev({ type: 'file.mutated', callId: 'm', path: 'src/a.ts', kind: 'modify', beforeSha256: 'a', afterSha256: 'b', createdDirs: [] });
const applied = (child: string, paths: string[] = ['src/a.ts']): SessionEvent =>
  ev({ type: 'task.applied', callId: `c-${child}`, childSessionId: child, applied: paths, refused: [] });

/** A complete reviewer round on one delegate callId: started → ended completed → captured. */
function round(callId: string, children: { id: string; findings: ReviewFinding[]; status?: string; captured?: boolean }[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const c of children) {
    out.push(ev({ type: 'task.started', callId, role: 'reviewer', childSessionId: c.id, budget: {} }));
  }
  for (const c of children) {
    out.push(
      ev({
        type: 'task.ended',
        callId,
        childSessionId: c.id,
        status: c.status ?? 'completed',
        steps: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        resultSha256: 'x',
        durationMs: 1,
      }),
    );
    if (c.captured !== false) {
      out.push(ev({ type: 'review.findings', callId, childSessionId: c.id, lens: 'correctness', findings: c.findings }));
    }
  }
  return out;
}

const triage = (findingId: string, action: string, evidence = 'checked the actual file: the guard exists at line 12', refs?: string[]): SessionEvent =>
  ev({ type: 'review.triage', callId: 't', findingId, action, evidence, ...(refs !== undefined ? { refs } : {}) });

describe('requirement derivation', () => {
  it('executor plans derive required; parent-only plans derive none; declarations override', () => {
    expect(deriveRequirement(null)).toEqual({ kind: 'none' });
    expect(deriveRequirement(graphOf())).toEqual({ kind: 'required', source: 'derived' });
    expect(deriveRequirement(graphOf({}, [{ id: 'a', title: 'A', intent: 'i', role: 'main', verify: 'v' }]))).toEqual({ kind: 'none' });
    expect(
      deriveRequirement(graphOf({ review: { mode: 'required' } }, [{ id: 'a', title: 'A', intent: 'i', role: 'main', verify: 'v' }])),
    ).toEqual({ kind: 'required', source: 'declared' });
    expect(deriveRequirement(graphOf({ review: { mode: 'waived', reason: 'demo scope only, hand-reviewed' } }))).toEqual({
      kind: 'waived',
      reason: 'demo scope only, hand-reviewed',
    });
  });
});

describe('round qualification (rule 2)', () => {
  it('required with no round at all → the round blocker; a clean qualifying round satisfies', () => {
    reset();
    const g = graphOf();
    const none = foldReview(g, [mutated()]);
    expect(none.satisfied).toBe(false);
    expect(none.openBlockers.join(' ')).toContain('no review round has run');

    reset();
    const events = [mutated(), applied('ch1'), ...round('r1', [{ id: 'rev-aaaa', findings: [] }])];
    const st = foldReview(g, events);
    expect(st.rounds).toHaveLength(1);
    expect(st.rounds[0]!.qualifying).toBe(true);
    expect(st.satisfied).toBe(true);
    expect(st.openBlockers).toEqual([]);
  });

  it('a review of NOTHING never qualifies (no workspace change preceded the round)', () => {
    reset();
    const st = foldReview(graphOf(), [...round('r1', [{ id: 'rev-aaaa', findings: [] }]), mutated()]);
    expect(st.rounds[0]!.qualifying).toBe(false);
    expect(st.rounds[0]!.note).toContain('review of nothing');
    expect(st.satisfied).toBe(false);
  });

  it('an integration AFTER the round makes it stale (reviewers observed pre-integration state)', () => {
    reset();
    const st = foldReview(graphOf(), [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [] }]), applied('ch1')]);
    expect(st.rounds[0]!.qualifying).toBe(false);
    expect(st.rounds[0]!.note).toContain('last integration postdates');
    expect(st.satisfied).toBe(false);
    expect(st.openBlockers.join(' ')).toContain('no round qualifies');
  });

  it('a completed reviewer with NO capture does not qualify a round (the executor-F1 mirror)', () => {
    reset();
    const st = foldReview(graphOf(), [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [], captured: false }])]);
    expect(st.rounds[0]!.qualifying).toBe(false);
    expect(st.rounds[0]!.note).toContain('no reviewer lens completed with a recorded findings capture');
  });

  it('a dead lens does not disqualify the round but is surfaced as a caveat', () => {
    reset();
    const st = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [
        { id: 'rev-aaaa', findings: [] },
        { id: 'rev-bbbb', findings: [], status: 'timeout', captured: false },
      ]),
    ]);
    expect(st.rounds[0]!.qualifying).toBe(true);
    expect(st.rounds[0]!.deadLenses).toEqual(['bbbb']);
    expect(st.caveats.join(' ')).toContain('bbbb');
    expect(st.caveats.join(' ')).toContain('unreviewed');
  });

  it('post-round parent fix-ups do NOT re-block; they surface as the staleness caveat', () => {
    reset();
    const st = foldReview(graphOf(), [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [] }]), mutated(), mutated()]);
    expect(st.satisfied).toBe(true);
    expect(st.caveats.join(' ')).toContain('2 workspace change event(s) after the last review round');
  });
});

describe('finding triage (rule 3)', () => {
  const CRIT = finding('rev-aaaa#1', 'critical');

  it('an untriaged critical blocks; verify keeps it blocking (confirmed real, unfixed)', () => {
    reset();
    const base = [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }])];
    const open = foldReview(graphOf(), base);
    expect(open.satisfied).toBe(false);
    expect(open.openBlockers.join(' ')).toContain('rev-aaaa#1');
    expect(open.openBlockers.join(' ')).toContain('untriaged');

    reset();
    const st = foldReview(graphOf(), [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]), triage('rev-aaaa#1', 'verify')]);
    expect(st.findings[0]!.status).toBe('verified');
    expect(st.findings[0]!.blocking).toBe(true);
    expect(st.openBlockers.join(' ')).toContain('verified real and unaddressed');
  });

  it('refute clears the block (recorded verbatim; a labeled model claim)', () => {
    reset();
    const st = foldReview(graphOf(), [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]), triage('rev-aaaa#1', 'refute')]);
    expect(st.findings[0]!.status).toBe('refuted');
    expect(st.findings[0]!.blocking).toBe(false);
    expect(st.satisfied).toBe(true);
  });

  it("'address' clears ONLY when every cited ref exists in the log", () => {
    reset();
    // The fix: a mutating callId 'm' exists (file.mutated below); 'ghost' does not.
    const base = [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }])];
    const bad = foldReview(graphOf(), [...base, triage('rev-aaaa#1', 'address', 'fixed it', ['ghost'])]);
    expect(bad.findings[0]!.status).toBe('open');
    expect(bad.findings[0]!.triage[0]!.effective).toBe(false);
    expect(bad.findings[0]!.triage[0]!.note).toContain('ghost');
    expect(bad.satisfied).toBe(false);

    reset();
    const good = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]),
      mutated(), // the actual fix, recorded AFTER the finding (the ordering rule)
      triage('rev-aaaa#1', 'address', 'fixed it', ['m']),
    ]);
    expect(good.findings[0]!.status).toBe('addressed');
    expect(good.satisfied).toBe(true);

    reset();
    const noRefs = foldReview(graphOf(), [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]), triage('rev-aaaa#1', 'address', 'fixed it')]);
    expect(noRefs.findings[0]!.status).toBe('open');
    expect(noRefs.findings[0]!.triage[0]!.note).toContain('requires refs');
  });

  it("'address' accepts a passing check recipeId as a ref", () => {
    reset();
    const st = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]),
      ev({ type: 'check.completed', callId: 'k', check: 'test', recipeId: 'npm-script:test', status: 'pass', exitCode: 0, durationMs: 1, summary: 'ok' }),
      triage('rev-aaaa#1', 'address', 'fix landed and the suite is green', ['npm-script:test']),
    ]);
    expect(st.findings[0]!.status).toBe('addressed');
  });

  it('REVIEW FIX: an address ref that PREDATES the finding cannot clear it (zero new evidence)', () => {
    // Found by the gate-evasion lens: refExists only asked "does this ref appear anywhere",
    // so citing a check that passed BEFORE the round — or the very mutation the finding
    // criticizes — flipped a critical to non-blocking with no fix and no re-run.
    reset();
    const st = foldReview(graphOf(), [
      ev({ type: 'check.completed', callId: 'k', check: 'typecheck', recipeId: 'tsc', status: 'pass', exitCode: 0, durationMs: 1, summary: 'ok' }),
      mutated(), // callId 'm', BEFORE the round
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]),
      triage('rev-aaaa#1', 'address', 'claiming an old green check as the fix', ['tsc']),
      triage('rev-aaaa#1', 'address', 'claiming the criticized mutation as its own fix', ['m']),
    ]);
    expect(st.findings[0]!.status).toBe('open');
    expect(st.findings[0]!.blocking).toBe(true);
    expect(st.findings[0]!.triage[0]!.effective).toBe(false);
    expect(st.findings[0]!.triage[0]!.note).toContain('predate the finding');
    expect(st.findings[0]!.triage[1]!.effective).toBe(false);

    // A ref recorded AFTER the finding still clears it.
    reset();
    const fixed = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]),
      ev({ type: 'file.mutated', callId: 'fix', path: 'src/a.ts', kind: 'modify', beforeSha256: 'b', afterSha256: 'c', createdDirs: [] }),
      triage('rev-aaaa#1', 'address', 'the real fix, after the finding', ['fix']),
    ]);
    expect(fixed.findings[0]!.status).toBe('addressed');
  });

  it('REVIEW FIX: a REFUTED critical/high is surfaced as a consent caveat (an unverified model claim)', () => {
    // Found by the consent lens: refute was the cheapest gate-clearing path AND the only one
    // invisible on the /accept summary — an accepted MEDIUM was more visible than a refuted
    // CRITICAL. ADDRESSED stays caveat-free: its refs are existence- and order-checked.
    reset();
    const st = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]),
      triage('rev-aaaa#1', 'refute', 'checked src/a.ts:12 — the guard exists upstream'),
    ]);
    expect(st.satisfied).toBe(true);
    expect(st.caveats.join(' ')).toContain('was REFUTED by the agent, not fixed');
    expect(st.caveats.join(' ')).toContain('UNVERIFIED model claim');
    expect(st.caveats.join(' ')).toContain('rev-aaaa#1');

    // A refuted MEDIUM is not a consent caveat (it never blocked in the first place).
    reset();
    const med = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [finding('rev-aaaa#1', 'medium')] }]),
      triage('rev-aaaa#1', 'refute', 'checked it, not real at all'),
    ]);
    expect(med.caveats.join(' ')).not.toContain('REFUTED');
  });

  it("'accept' is invalid for critical/high (ineffective, with why) but valid for medium/low → caveat", () => {
    reset();
    const st = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT, finding('rev-aaaa#2', 'medium', 'minor thing')] }]),
      triage('rev-aaaa#1', 'accept', 'we can live with it'),
      triage('rev-aaaa#2', 'accept', 'cosmetic; recorded as a limitation'),
    ]);
    const crit = st.findings.find((f) => f.finding.findingId === 'rev-aaaa#1')!;
    expect(crit.status).toBe('open');
    expect(crit.triage[0]!.effective).toBe(false);
    expect(crit.triage[0]!.note).toContain('invalid for critical');
    const med = st.findings.find((f) => f.finding.findingId === 'rev-aaaa#2')!;
    expect(med.status).toBe('accepted');
    expect(med.blocking).toBe(false);
    expect(st.caveats.join(' ')).toContain('accepted limitation (medium)');
    expect(st.satisfied).toBe(false); // the critical still blocks
  });

  it('the latest effective triage wins; ineffective ones never overwrite', () => {
    reset();
    const st = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]),
      triage('rev-aaaa#1', 'verify'),
      triage('rev-aaaa#1', 'address', 'tried', ['ghost']), // ineffective — status stays verified
      triage('rev-aaaa#1', 'refute', 'deeper read: the input is pre-validated upstream'),
    ]);
    expect(st.findings[0]!.status).toBe('refuted');
    expect(st.findings[0]!.triage).toHaveLength(3);
    expect(st.findings[0]!.triage[1]!.effective).toBe(false);
  });

  it('medium/low findings never block, even untriaged', () => {
    reset();
    const st = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [finding('rev-aaaa#1', 'medium'), finding('rev-aaaa#2', 'low')] }]),
    ]);
    expect(st.satisfied).toBe(true);
    expect(st.findings.every((f) => !f.blocking)).toBe(true);
  });

  it('findings NEVER expire across rounds — a clean round 2 cannot launder round 1 criticals', () => {
    reset();
    const st = foldReview(graphOf(), [
      mutated(),
      ...round('r1', [{ id: 'rev-aaaa', findings: [CRIT] }]),
      ...round('r2', [{ id: 'rev-bbbb', findings: [] }]),
    ]);
    expect(st.rounds).toHaveLength(2);
    expect(st.satisfied).toBe(false);
    expect(st.openBlockers.join(' ')).toContain('rev-aaaa#1');
  });

  it('a triage for an unknown findingId annotates nothing (no throw, no phantom finding)', () => {
    reset();
    const st = foldReview(graphOf(), [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [] }]), triage('nope#9', 'refute')]);
    expect(st.findings).toHaveLength(0);
    expect(st.satisfied).toBe(true);
  });
});

describe('requirement interplay', () => {
  it('a WAIVED plan carries the waiver caveat and needs no round — but recorded criticals still block', () => {
    reset();
    const g = graphOf({ review: { mode: 'waived', reason: 'demo scope only, hand-reviewed' } });
    const clean = foldReview(g, [mutated()]);
    expect(clean.satisfied).toBe(true);
    expect(clean.caveats.join(' ')).toContain('WAIVED');

    reset();
    const withCrit = foldReview(g, [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [finding('rev-aaaa#1', 'critical')] }])]);
    expect(withCrit.satisfied).toBe(false);
    expect(withCrit.openBlockers.join(' ')).toContain('rev-aaaa#1');
  });

  it('no plan → no requirement, but voluntary rounds still fold (findings included)', () => {
    reset();
    const st = foldReview(null, [mutated(), ...round('r1', [{ id: 'rev-aaaa', findings: [finding('rev-aaaa#1', 'high')] }])]);
    expect(st.requirement).toEqual({ kind: 'none' });
    expect(st.rounds).toHaveLength(1);
    expect(st.satisfied).toBe(false); // the recorded high blocks until triaged
  });
});
