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

/** Pure. `answer === null` is EOF/Ctrl+C. Empty is a DECLINE, never a default-yes. */
export function parseChoice<K extends string>(
  answer: string | null,
  choices: readonly PromptChoice<K>[],
): PromptAnswer<K> {
  if (answer === null) return { key: null, raw: null, reason: 'eof' };
  const trimmed = answer.trim();
  if (trimmed.length === 0) return { key: null, raw: answer, reason: 'declined' };
  const first = trimmed.toLowerCase()[0];
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
