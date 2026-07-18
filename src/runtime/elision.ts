import type { ChatMessage, ContentBlock } from '../types.js';
import { sha256 } from '../shared/hash.js';

/**
 * Deterministic history elision — the wire-side context budget (V0.5).
 *
 * A long session resends its whole conversation every step; old tool outputs are the bulk and
 * the least useful tail. When the RAW history size crosses a trigger, the oldest tool_result
 * contents are replaced with a short marker (char count + sha256 + a pointer to the evidence
 * log) until the sent size is back under the target.
 *
 * Load-bearing properties:
 * - PURE and recomputed per request; `session.messages` and the event log are never mutated,
 *   so resume rebuilds the full history and re-derives the same elision.
 * - The trigger is evaluated on the RAW (never-elided) size, which only grows — so the elision
 *   boundary only advances (no oscillation between requests, no stored state needed), and each
 *   advance is the only prompt-cache invalidation event (hysteresis: trigger >> target).
 * - Only tool_result CONTENT is replaced: tool_use/tool_result pairing — and therefore API
 *   validity — is preserved; assistant text and user messages are never touched.
 * - The last `keepLastSteps` assistant steps are always protected: the model keeps verbatim
 *   sight of its recent working set.
 */

export interface ElisionOptions {
  /** Raw-size threshold that arms elision (chars ≈ tokens×4). Default 400k ≈ 100k tokens. */
  triggerChars?: number;
  /** Size to elide down to once armed. Default 200k. */
  targetChars?: number;
  /** Trailing assistant steps whose tool results are never elided. Default 4. */
  keepLastSteps?: number;
}

export interface ElisionOutcome {
  messages: ChatMessage[];
  /** callIds (tool_use ids) whose results are elided in this view, oldest first. */
  elidedCallIds: string[];
  rawChars: number;
  sentChars: number;
  /** True when every candidate is elided and the history STILL exceeds the target. */
  exhausted: boolean;
}

export const DEFAULT_TRIGGER_CHARS = 400_000;
export const DEFAULT_TARGET_CHARS = 200_000;
export const DEFAULT_KEEP_LAST_STEPS = 4;

function blockChars(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return b.text.length;
    case 'tool_use':
      return b.name.length + JSON.stringify(b.input ?? null).length;
    case 'tool_result':
      return b.content.length;
  }
}

function marker(content: string): string {
  return `[elided to save context: tool output of ${content.length} chars, sha256=${sha256(Buffer.from(content, 'utf8')).slice(0, 12)}…; the full output remains in the session evidence log]`;
}

export function elideHistory(messages: readonly ChatMessage[], opts: ElisionOptions = {}): ElisionOutcome {
  const trigger = opts.triggerChars ?? DEFAULT_TRIGGER_CHARS;
  const target = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  const keep = opts.keepLastSteps ?? DEFAULT_KEEP_LAST_STEPS;

  let rawChars = 0;
  for (const m of messages) for (const b of m.content) rawChars += blockChars(b);
  if (rawChars <= trigger) {
    return { messages: [...messages], elidedCallIds: [], rawChars, sentChars: rawChars, exhausted: false };
  }

  // Protection boundary: everything from the keep-th-from-last assistant message onward.
  // keep=0 protects nothing; fewer than `keep` assistant steps protects everything.
  let protectFrom = messages.length;
  if (keep > 0) {
    protectFrom = 0;
    let assistantSeen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'assistant') {
        assistantSeen++;
        if (assistantSeen === keep) {
          protectFrom = i;
          break;
        }
      }
    }
  }

  const out = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const elidedCallIds: string[] = [];
  let sentChars = rawChars;
  outer: for (let i = 0; i < protectFrom; i++) {
    const m = out[i]!;
    if (m.role !== 'user') continue;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j]!;
      if (b.type !== 'tool_result') continue;
      if (sentChars <= target) break outer;
      const replacement = marker(b.content);
      if (replacement.length >= b.content.length) continue; // eliding tiny outputs would grow the prompt
      sentChars -= b.content.length - replacement.length;
      m.content[j] = { type: 'tool_result', toolUseId: b.toolUseId, content: replacement, ...(b.isError ? { isError: true } : {}) };
      elidedCallIds.push(b.toolUseId);
    }
  }
  return { messages: out, elidedCallIds, rawChars, sentChars, exhausted: sentChars > target };
}
