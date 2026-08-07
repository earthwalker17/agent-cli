import {
  CONTENT_CHARS_PER_SESSION,
  CREDITS_PER_SESSION,
  EXTRACTS_PER_SESSION,
  SEARCHES_PER_SESSION,
} from '../research/types.js';
import type { SessionEvent } from '../types.js';

/**
 * The session research budget — ONE mutable object shared by the parent's `web_search` instance
 * and by every researcher child's instances (the `checkCaps` precedent: one live object, never a
 * per-instance copy).
 *
 * Sharing is not a convenience here, it is the correctness argument. A researcher's searches run
 * in a CHILD session with its own event log, so a budget each instance folded from "its own
 * events" would let three parallel researchers each spend the full allowance while the parent's
 * fold reported zero. The object is the single accountant; the events are how it survives a
 * restart.
 *
 * Resume works through two different event sources, deliberately:
 *  - the parent's OWN `research.searched` / `research.extracted` events, for calls the main agent
 *    made itself;
 *  - `research.usage`, one record per finished researcher task, captured into the PARENT log by
 *    the delegate — because the child's own events live in a log this fold never reads.
 * A task killed mid-flight loses its unrecorded spend on resume. That is a known and deliberately
 * accepted gap: under-counting a budget after a crash is the failure direction that costs money
 * rather than the one that loses work, and it is bounded by one task's own ceiling.
 */
export interface ResearchSpend {
  searches: number;
  extracts: number;
  credits: number;
  contentChars: number;
}

export interface ResearchBudget {
  /** Live totals. Read by `/research` and by the approval prompt; mutated only through `charge`. */
  readonly spent: ResearchSpend;
  /**
   * Why a call of this shape cannot be admitted, or undefined when it can. The estimated credit
   * cost is checked BEFORE the call, so a request that would overshoot is refused rather than
   * half-spent — the engine turns this string into `research.budget-exhausted`.
   */
  exhausted(kind: 'search' | 'extract', estimatedCredits: number): string | undefined;
  /** One line of remaining allowance, for the approval prompt and `/research`. */
  remaining(): string;
  /** Record a COMPLETED call's real spend (provider-reported credits, actual characters). */
  charge(kind: 'search' | 'extract', actual: { credits: number; contentChars: number }): void;
  /** Fold a whole researcher task's spend in at once (the delegate's `research.usage` capture). */
  chargeUsage(usage: ResearchSpend): void;
}

export const RESEARCH_LIMITS = {
  searches: SEARCHES_PER_SESSION,
  extracts: EXTRACTS_PER_SESSION,
  credits: CREDITS_PER_SESSION,
  contentChars: CONTENT_CHARS_PER_SESSION,
} as const;

export function createResearchBudget(initial: ResearchSpend = zero()): ResearchBudget {
  const spent: ResearchSpend = { ...initial };
  return {
    spent,
    exhausted(kind, estimatedCredits) {
      if (kind === 'search' && spent.searches >= RESEARCH_LIMITS.searches) {
        return `${String(spent.searches)} of ${String(RESEARCH_LIMITS.searches)} searches used`;
      }
      if (kind === 'extract' && spent.extracts >= RESEARCH_LIMITS.extracts) {
        return `${String(spent.extracts)} of ${String(RESEARCH_LIMITS.extracts)} extracts used`;
      }
      // Checked against the ESTIMATE, not against the remainder after the fact: a call that would
      // cross the credit ceiling is refused whole. Half-spending a budget is the one outcome a
      // cost bound exists to prevent.
      if (spent.credits + estimatedCredits > RESEARCH_LIMITS.credits) {
        return `${String(spent.credits)} of ${String(RESEARCH_LIMITS.credits)} provider credits used; this call needs ~${String(estimatedCredits)} more`;
      }
      if (spent.contentChars >= RESEARCH_LIMITS.contentChars) {
        return `${String(spent.contentChars)} of ${String(RESEARCH_LIMITS.contentChars)} retrieved characters used`;
      }
      return undefined;
    },
    remaining() {
      const left = (used: number, cap: number): number => Math.max(0, cap - used);
      return (
        `${String(left(spent.searches, RESEARCH_LIMITS.searches))} search(es), ` +
        `${String(left(spent.extracts, RESEARCH_LIMITS.extracts))} extract(s), ` +
        `${String(left(spent.credits, RESEARCH_LIMITS.credits))} credit(s), ` +
        `${String(left(spent.contentChars, RESEARCH_LIMITS.contentChars))} char(s)`
      );
    },
    charge(kind, actual) {
      if (kind === 'search') spent.searches += 1;
      else spent.extracts += 1;
      spent.credits += Math.max(0, actual.credits);
      spent.contentChars += Math.max(0, actual.contentChars);
    },
    chargeUsage(usage) {
      spent.searches += Math.max(0, usage.searches);
      spent.extracts += Math.max(0, usage.extracts);
      spent.credits += Math.max(0, usage.credits);
      spent.contentChars += Math.max(0, usage.contentChars);
    },
  };
}

/**
 * Rebuild the spend from a PARENT session's events, so a resumed session cannot refill its
 * allowance by restarting. Reads the parent's own calls plus each researcher task's captured
 * usage; a child's own `research.*` events are in a different log and are never double-counted
 * here, because this fold only ever sees one log.
 */
export function researchSpendFromEvents(events: readonly SessionEvent[]): ResearchSpend {
  const spend = zero();
  for (const e of events) {
    if (e.type === 'research.searched') {
      spend.searches += 1;
      spend.credits += e.credits;
      spend.contentChars += e.contentChars;
    } else if (e.type === 'research.extracted') {
      spend.extracts += 1;
      spend.credits += e.credits;
      spend.contentChars += e.contentChars;
    } else if (e.type === 'research.usage') {
      spend.searches += e.searches;
      spend.extracts += e.extracts;
      spend.credits += e.credits;
      spend.contentChars += e.contentChars;
    }
  }
  return spend;
}

export function researchBudgetFromEvents(events: readonly SessionEvent[]): ResearchBudget {
  return createResearchBudget(researchSpendFromEvents(events));
}

function zero(): ResearchSpend {
  return { searches: 0, extracts: 0, credits: 0, contentChars: 0 };
}
