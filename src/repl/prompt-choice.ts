import { sanitizeLine } from '../shared/text.js';

/**
 * The ONE answer grammar for contextual consent prompts (Session 21.5).
 *
 * The interaction audit found four incompatible yes-parsers already shipping: approval prompts
 * read the first character of any word (`runtime/approvals.ts` — `sure` is a session grant); the
 * git-shaped confirmations require an exact `^y(es)?$` (`yeah` cancels); `/init` uses
 * `startsWith('y')`; and the trust gate wants an exact `t`. This module deliberately does NOT add
 * a fifth. It tokenizes IDENTICALLY to `parseAnswer` — trim, lowercase, first character — so the
 * two agree on what a keystroke *is* and differ only in what the keys *mean*.
 *
 * It is a separate parser from `parseAnswer` rather than a reuse of it because that one returns an
 * `ApprovalOutcome` whose keys denote permission SCOPE — `a` mints machine-durable authority.
 * Forcing "approve this plan" into `{decision, scope}` would be a category error, and sharing the
 * letter `a` across the two would be standing authority won by muscle memory.
 *
 * Three rules, spelled once and enforced by the return type:
 *
 * - `null` (EOF / Ctrl+C) → `'eof'`
 * - empty after trim → `'declined'`
 * - anything unrecognized → `'unrecognized'`
 *
 * and all three carry `key: null`, which every caller must treat as DO NOTHING. There is no
 * affirmative default: approving a plan, accepting a session and dismissing an escalation are all
 * consent, and `parseAnswer`'s `default: deny` is the precedent.
 */

export interface PromptChoice<K extends string> {
  /** One lowercase letter, unique within the set. */
  key: K;
  /** Rendered after `[k]`. */
  label: string;
}

export interface PromptAnswer<K extends string> {
  /** null ALWAYS means "do nothing". */
  key: K | null;
  raw: string | null;
  reason: 'chosen' | 'declined' | 'eof' | 'unrecognized';
}

/**
 * Words that mean NO, resolved before the first character is (Session 21.6).
 *
 * First-character resolution is this family's inherited hazard, and the header above already names
 * it. It became load-bearing the moment an affirmative key started with the same letter as a
 * common refusal: on the completion prompt, `[c] commit … then accept` sits one keystroke away
 * from someone typing `cancel` to back out, and the parse would have read that as consent to
 * record an acceptance and open a commit flow.
 *
 * The list can only ever turn a would-be key into a DECLINE — never the reverse — so it cannot
 * make any prompt more permissive, and "anything unrecognized does nothing" was already the
 * module's stated rule. Exact words only: no prefix matching, because `never mind` and `nothing`
 * are refusals while a future `n`-keyed affirmative would not be.
 */
const NEGATIVE_WORDS: ReadonlySet<string> = new Set([
  'no',
  'nope',
  'nah',
  'never',
  'never mind',
  'nevermind',
  'nothing',
  'cancel',
  'quit',
  'exit',
  'stop',
  'abort',
  'back',
  'skip',
  'later',
  'wait',
  'not now',
  'not yet',
]);

/** Pure. `answer === null` is EOF/Ctrl+C. Empty is a DECLINE, never a default-yes. */
export function parseChoice<K extends string>(
  answer: string | null,
  choices: readonly PromptChoice<K>[],
): PromptAnswer<K> {
  if (answer === null) return { key: null, raw: null, reason: 'eof' };
  const trimmed = answer.trim();
  if (trimmed.length === 0) return { key: null, raw: answer, reason: 'declined' };
  const lower = trimmed.toLowerCase();
  // Keys are single characters and every word above is at least two, so this can never shadow a
  // key the user typed exactly. `no` on a prompt with an `[n] not now` key resolves to `declined`
  // rather than to that key, which is the same outcome by construction: the decline-shaped key IS
  // the decline, and every caller treats a null key as do-nothing.
  if (NEGATIVE_WORDS.has(lower)) return { key: null, raw: answer, reason: 'declined' };
  const first = lower[0];
  const hit = choices.find((c) => c.key === first);
  return hit !== undefined
    ? { key: hit.key, raw: answer, reason: 'chosen' }
    : { key: null, raw: answer, reason: 'unrecognized' };
}

/**
 * Render the block and ask once.
 *
 * `header` may be multi-line and MUST already be sanitized by the caller where it embeds
 * model-authored text (plan objectives, escalation reasons, task titles are all untrusted); the
 * choice labels are sanitized here because they are ours.
 *
 * The block opens with a blank line for the same reason `formatApprovalPrompt` does: the renderer
 * may have an unterminated tool line open, and the leading newline closes it visually.
 */
export async function askChoice<K extends string>(
  ask: (q: string) => Promise<string | null>,
  header: string,
  choices: readonly PromptChoice<K>[],
  declineLabel: string,
): Promise<PromptAnswer<K>> {
  const keys = choices.map((c) => `[${c.key}] ${sanitizeLine(c.label)}`).join('   ');
  const block = ['', ...header.split('\n').map((l) => `  ${l}`), `  ${keys}   (Enter = ${sanitizeLine(declineLabel)})`, '  > '].join(
    '\n',
  );
  return parseChoice(await ask(block), choices);
}
