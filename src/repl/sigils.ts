import type { EventBody } from '../types.js';

/**
 * `@` routing — explicit invocation of a specialist discipline (Session 21.5).
 *
 * Before this the four sigils were four inlined `if/else if` branches in the middle of the turn
 * loop, each repeating the same shape: test a regex, strip it with the same regex, print a usage
 * line when the remainder is empty, append a route event, push a paragraph of instruction. Two
 * defects lived in that repetition, and both are closed here:
 *
 * 1. **`\b` matched too much.** `/^@plan\b/i` matches `@plan.md is stale` — the boundary sits
 *    between `n` and `.` — so the sigil was stripped and the model received `.md is stale` with a
 *    full plan-mode routing note attached to it. The guard is now a lookahead for whitespace or
 *    end-of-line, which is what "the whole first word" actually means.
 * 2. **There was no unknown-sigil branch.** `@web`, `@plna`, `@fix` fell through to the model as
 *    ordinary prose, so a mistyped sigil silently lost its routing with nothing on screen. A
 *    misfire that looks exactly like success is the worst shape a routing bug can take.
 *
 * `@direct` was REMOVED in S21.5. The main-agent system prompt already instructs complexity
 * routing ("a SIMPLE request … is done DIRECTLY … no plan document, no delegation ceremony"), so
 * the sigil forced the path the model already takes by default; it was absent from `/help`, so
 * almost nobody could discover it; and treating `@` as "specialist agent" rather than "mode
 * switch" is what makes the surface teachable. The `plan.route` event type keeps its `direct`
 * member so historical logs still replay.
 */

export interface Sigil {
  /** The word after `@`, lowercase. */
  word: string;
  /** Shown when the sigil is typed with no argument. */
  usage: string;
  /** The routing event to append. */
  event: (word: string) => EventBody;
  /** The instruction prepended to the next user message, clearly delimited. */
  note: string;
  /**
   * Optional availability gate. Returning a string refuses the routing with that reason — the
   * request is NOT sent, because a user who asked for research and silently got a guess has been
   * told something false about what happened.
   */
  unavailable?: (ctx: SigilContext) => string | undefined;
}

export interface SigilContext {
  researchUnavailable?: string | undefined;
}

export const SIGILS: readonly Sigil[] = [
  {
    word: 'plan',
    usage: 'usage: @plan <request> — investigate and produce a plan without executing',
    event: () => ({ type: 'plan.route', mode: 'plan', source: 'user-sigil' }),
    note: 'the user explicitly invoked PLAN MODE for this request: investigate as needed (read-only; delegate explorer tasks where useful), write or update the plan with update_plan, and present it — do NOT begin implementation or any mutating work until the user approves the plan (/plan approve)',
  },
  {
    word: 'review',
    usage: 'usage: @review [focus] — inspect the codebase for bugs, weak points and regressions (advisory; blocks nothing)',
    event: () => ({ type: 'inspection.route', source: 'user-sigil' }),
    note: 'the user explicitly invoked the REVIEW AGENT: delegate one `inspector` task (two or three only if the focus genuinely splits into independent areas), giving it the concrete focus and the questions it must answer. Then read its RECORDED observations and drive the work: confirm anything load-bearing yourself against the real code, tell the user plainly what you agree with and what you do not, and propose or make the fixes that are warranted. Its observations are ADVICE — they block no gate and consume no adversarial review round, so do not treat them as verified defects and do not treat this as the end-of-session review.',
  },
  {
    word: 'search',
    usage: 'usage: @search <question> — one bounded web lookup, answered from snippets',
    event: () => ({ type: 'research.route', mode: 'search', source: 'user-sigil' }),
    note: 'the user explicitly requested a WEB LOOKUP for this request: run ONE bounded web_search and answer from the snippets with their URLs. Do not spawn a researcher subagent for this; if one lookup genuinely cannot settle it, say so and offer @research.',
    unavailable: (c) => c.researchUnavailable,
  },
  {
    word: 'research',
    usage: 'usage: @research <question> — delegate a read-only research subagent and answer from sources',
    event: () => ({ type: 'research.route', mode: 'research', source: 'user-sigil' }),
    note: 'the user explicitly requested WEB RESEARCH for this request: delegate a `researcher` task with the question and the concrete claims it must settle, then answer from its RECORDED findings, citing the sources. Verify anything load-bearing yourself before acting on it, and say plainly what could not be established.',
    unavailable: (c) => c.researchUnavailable,
  },
];

export type SigilOutcome =
  | { kind: 'none' }
  | { kind: 'routed'; text: string; event: EventBody; note: string }
  | { kind: 'usage'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'unknown'; message: string };

/** The `@word` at the head of a line, or null. Whitespace-or-end bounded, never `\b`. */
function leadingSigil(line: string): { word: string; rest: string } | null {
  const m = /^@([A-Za-z][A-Za-z-]*)(?=\s|$)/.exec(line);
  return m === null ? null : { word: m[1]!.toLowerCase(), rest: line.slice(m[0].length).trim() };
}

export function routeSigil(line: string, ctx: SigilContext): SigilOutcome {
  const head = leadingSigil(line);
  if (head === null) return { kind: 'none' };

  const sigil = SIGILS.find((s) => s.word === head.word);
  if (sigil === undefined) {
    return {
      kind: 'unknown',
      message:
        `unknown routing sigil: @${head.word} — the ones that exist are ` +
        `${SIGILS.map((s) => `@${s.word}`).join(', ')}.\n` +
        '  (to send a message that genuinely starts with @, rephrase it — a leading @word is always read as routing)',
    };
  }
  if (head.rest.length === 0) return { kind: 'usage', message: sigil.usage };

  const why = sigil.unavailable?.(ctx);
  if (why !== undefined) return { kind: 'unavailable', message: `@${sigil.word} is unavailable: ${why}` };

  return { kind: 'routed', text: head.rest, event: sigil.event(sigil.word), note: sigil.note };
}
