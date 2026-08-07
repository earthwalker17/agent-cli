import { describe, it, expect } from 'vitest';
import { createResearchBudget, RESEARCH_LIMITS, researchBudgetFromEvents, researchSpendFromEvents } from '../src/tools/research-budget.js';
import type { SessionEvent } from '../src/types.js';

/**
 * The session research budget. Two properties matter more than the arithmetic:
 *
 * 1. It is ONE shared object. A researcher spends from inside a child session, so a budget each
 *    instance folded from "its own events" would let parallel researchers each spend the full
 *    allowance while the parent reported zero.
 * 2. It survives a restart. Without the events fold, a resumed session refills its allowance —
 *    the same class of bug `delegateCapsFromEvents` exists to prevent.
 */

const ev = (body: Record<string, unknown>): SessionEvent => ({ v: 1, seq: 1, ts: '2026-08-07T00:00:00.000Z', ...body }) as SessionEvent;

const searched = (credits: number, chars: number): SessionEvent =>
  ev({ type: 'research.searched', callId: 'c', provider: 'api.tavily.com', query: 'q', resultCount: 1, hosts: [], refused: [], credits, contentChars: chars, durationMs: 1 });
const extracted = (credits: number, chars: number): SessionEvent =>
  ev({ type: 'research.extracted', callId: 'c', provider: 'api.tavily.com', urls: [], pageCount: 1, failed: [], credits, contentChars: chars, durationMs: 1 });
const usage = (s: number, x: number, credits: number, chars: number): SessionEvent =>
  ev({ type: 'research.usage', callId: 'c', childSessionId: 'child-1', searches: s, extracts: x, credits, contentChars: chars });

describe('charging', () => {
  it('counts calls, credits and characters separately', () => {
    const b = createResearchBudget();
    b.charge('search', { credits: 1, contentChars: 500 });
    b.charge('search', { credits: 2, contentChars: 300 });
    b.charge('extract', { credits: 1, contentChars: 9_000 });
    expect(b.spent).toEqual({ searches: 2, extracts: 1, credits: 4, contentChars: 9_800 });
  });

  it('never lets a negative provider figure reduce the spend', () => {
    const b = createResearchBudget();
    b.charge('search', { credits: -5, contentChars: -100 });
    expect(b.spent).toMatchObject({ searches: 1, credits: 0, contentChars: 0 });
  });

  it('folds a whole researcher task in one step', () => {
    const b = createResearchBudget();
    b.chargeUsage({ searches: 4, extracts: 2, credits: 9, contentChars: 40_000 });
    expect(b.spent).toEqual({ searches: 4, extracts: 2, credits: 9, contentChars: 40_000 });
  });
});

describe('exhaustion', () => {
  it('admits a call while every ceiling has room', () => {
    expect(createResearchBudget().exhausted('search', 1)).toBeUndefined();
  });

  it('refuses further searches at the call ceiling, naming the numbers', () => {
    const b = createResearchBudget({ searches: RESEARCH_LIMITS.searches, extracts: 0, credits: 0, contentChars: 0 });
    expect(b.exhausted('search', 1)).toContain(`${String(RESEARCH_LIMITS.searches)} of ${String(RESEARCH_LIMITS.searches)} searches used`);
    // ...but an extract is a separate ceiling and is still admissible.
    expect(b.exhausted('extract', 1)).toBeUndefined();
  });

  it('refuses further extracts at their own ceiling', () => {
    const b = createResearchBudget({ searches: 0, extracts: RESEARCH_LIMITS.extracts, credits: 0, contentChars: 0 });
    expect(b.exhausted('extract', 1)).toContain('extracts used');
    expect(b.exhausted('search', 1)).toBeUndefined();
  });

  it('refuses a call that WOULD cross the credit ceiling — never half-spends it', () => {
    const b = createResearchBudget({ searches: 0, extracts: 0, credits: RESEARCH_LIMITS.credits - 1, contentChars: 0 });
    expect(b.exhausted('search', 1)).toBeUndefined(); // exactly reaches the ceiling: allowed
    expect(b.exhausted('search', 2)).toContain('this call needs ~2 more');
  });

  it('refuses at the retrieved-character ceiling', () => {
    const b = createResearchBudget({ searches: 0, extracts: 0, credits: 0, contentChars: RESEARCH_LIMITS.contentChars });
    expect(b.exhausted('search', 1)).toContain('retrieved characters used');
  });

  it('reports what remains in one line for the approval prompt', () => {
    const b = createResearchBudget();
    b.charge('search', { credits: 3, contentChars: 1_000 });
    const r = b.remaining();
    expect(r).toContain(`${String(RESEARCH_LIMITS.searches - 1)} search(es)`);
    expect(r).toContain(`${String(RESEARCH_LIMITS.credits - 3)} credit(s)`);
    expect(r).toContain(`${String(RESEARCH_LIMITS.contentChars - 1_000)} char(s)`);
  });

  it('never reports a negative remainder', () => {
    const b = createResearchBudget({ searches: 999, extracts: 999, credits: 999, contentChars: 999_999 });
    expect(b.remaining()).not.toContain('-');
  });
});

describe('rebuilding from events (resume)', () => {
  it('sums the parent session\'s own calls', () => {
    const spend = researchSpendFromEvents([searched(1, 400), searched(2, 600), extracted(1, 20_000)]);
    expect(spend).toEqual({ searches: 2, extracts: 1, credits: 4, contentChars: 21_000 });
  });

  it('counts a researcher task through its captured usage record', () => {
    // The child's own research.searched events live in the CHILD's log, which this fold never
    // reads. research.usage is how that spend reaches the parent's accounting at all.
    const spend = researchSpendFromEvents([usage(5, 2, 12, 80_000)]);
    expect(spend).toEqual({ searches: 5, extracts: 2, credits: 12, contentChars: 80_000 });
  });

  it('adds parent calls and child usage without double-counting either', () => {
    const spend = researchSpendFromEvents([searched(1, 100), usage(3, 1, 5, 9_000), extracted(2, 500)]);
    expect(spend).toEqual({ searches: 4, extracts: 2, credits: 8, contentChars: 9_600 });
  });

  it('a resumed session does NOT get its allowance back', () => {
    const events = Array.from({ length: RESEARCH_LIMITS.searches }, () => searched(1, 10));
    const b = researchBudgetFromEvents(events);
    expect(b.spent.searches).toBe(RESEARCH_LIMITS.searches);
    expect(b.exhausted('search', 1)).toContain('searches used');
  });

  it('ignores unrelated events', () => {
    const spend = researchSpendFromEvents([ev({ type: 'user.message', text: 'hi' }), searched(1, 10)]);
    expect(spend).toMatchObject({ searches: 1 });
  });

  it('starts empty on a fresh session', () => {
    expect(researchSpendFromEvents([])).toEqual({ searches: 0, extracts: 0, credits: 0, contentChars: 0 });
  });
});

describe('sharing (the correctness argument)', () => {
  it('two instances holding the SAME object see each other\'s spend', () => {
    const shared = createResearchBudget();
    // Stand-ins for the parent's web_search and a researcher child's web_extract.
    const parentView = shared;
    const childView = shared;
    parentView.charge('search', { credits: 1, contentChars: 100 });
    childView.charge('extract', { credits: 4, contentChars: 30_000 });
    expect(parentView.spent).toEqual({ searches: 1, extracts: 1, credits: 5, contentChars: 30_100 });
    expect(childView.spent).toBe(parentView.spent);
  });

  it('parallel researchers cannot each spend the full allowance', () => {
    const shared = createResearchBudget();
    for (let i = 0; i < RESEARCH_LIMITS.searches; i++) shared.charge('search', { credits: 1, contentChars: 1 });
    // A second "child" holding the same object is already out, not starting fresh.
    expect(shared.exhausted('search', 1)).toBeDefined();
  });
});
