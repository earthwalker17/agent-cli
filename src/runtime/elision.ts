import type { ChatMessage, ContentBlock, ToolResultPart } from '../types.js';
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
 *
 * IMAGE parts (Session 13) have their own, EARLIER pass that runs even below the char trigger:
 * pixels are the most token-expensive, least re-usable payload in a history, so any image part
 * older than the last `IMAGE_KEEP_LAST_STEPS` assistant steps is replaced with a text marker
 * pointing at its blob (`objects/<sha>`). Deliberately a SEPARATE window from `keepLastSteps`
 * (2 vs 4): the model needs pixels NOW, while judging — two steps later the marker is enough.
 * Monotone for the same reason the char walk is: history is append-only, so a block outside
 * the window stays outside. Across resume the question dissolves: reconstruct rebuilds results
 * from outputPreview (text only), so a resumed history has no image parts at all — the model
 * saw the pixels live, and the marker/pointer is what remains, by construction.
 *
 * Cache note: each image→marker flip invalidates the prompt cache from that block onward, but
 * flips happen ~IMAGE_KEEP_LAST_STEPS from the tail, so the invalidation cost is bounded to
 * the recent suffix. Do not "optimize" the flip away — pixels resent every step cost more.
 */

export interface ElisionOptions {
  /** Raw-size threshold that arms elision (chars ≈ tokens×4). Default 400k ≈ 100k tokens. */
  triggerChars?: number;
  /** Size to elide down to once armed. Default 200k. */
  targetChars?: number;
  /** Trailing assistant steps whose tool results are never elided. Default 4. */
  keepLastSteps?: number;
  /** Trailing assistant steps whose IMAGE parts stay pixels. Default 2 (see module doc). */
  imageKeepLastSteps?: number;
  /**
   * callIds this session has ALREADY elided (S14.5). They stay elided regardless of the budget,
   * which is what actually makes the boundary monotone: the image pass can free enough chars
   * that the char walk would otherwise restore older outputs verbatim — invalidating the cache
   * suffix and contradicting the `context.compacted` record. The runtime passes its live set.
   */
  alreadyElided?: readonly string[];
}

export interface ElisionOutcome {
  messages: ChatMessage[];
  /** callIds (tool_use ids) whose results are elided in this view, oldest first. */
  elidedCallIds: string[];
  /** callIds whose IMAGE parts are markers in this view (text intact), oldest first (Session 13). */
  imageElidedCallIds: string[];
  rawChars: number;
  sentChars: number;
  /** True when every candidate is elided and the history STILL exceeds the target. */
  exhausted: boolean;
}

export const DEFAULT_TRIGGER_CHARS = 400_000;
export const DEFAULT_TARGET_CHARS = 200_000;
export const DEFAULT_KEEP_LAST_STEPS = 4;
export const IMAGE_KEEP_LAST_STEPS = 2;

/**
 * Char-equivalent weight of an image part: base64 length / 4 ≈ the raw byte count. This
 * deliberately OVERWEIGHTS relative to real image token cost — the safe direction: elision
 * arms sooner, never later, and the weight only feeds the budget, not any user-visible count.
 */
function imageCharWeight(dataBase64Length: number): number {
  return Math.ceil(dataBase64Length / 4);
}

function partChars(p: ToolResultPart): number {
  return p.type === 'text' ? p.text.length : imageCharWeight(p.dataBase64.length);
}

function contentChars(content: string | ToolResultPart[]): number {
  if (typeof content === 'string') return content.length;
  let n = 0;
  for (const p of content) n += partChars(p);
  return n;
}

function blockChars(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return b.text.length;
    case 'tool_use':
      return b.name.length + JSON.stringify(b.input ?? null).length;
    case 'tool_result':
      return contentChars(b.content);
    case 'reasoning': {
      // Session 15: reasoning blocks are never REPLACED (elision rewrites only tool_result
      // content, and reasoning lives on assistant messages), but their opaque payload must
      // count toward the budget — it is resent within the provider's replay scope.
      // `text` is a DISPLAY copy that is never re-sent (types.ts); the compat adapters set it
      // to the SAME string as the payload, so adding both double-weighed every kimi/deepseek
      // block and could fire the "history still exceeds the context target" warning at half
      // the real reasoning volume (S16.5b review). Count text only when there is no payload.
      const payloadChars = JSON.stringify(b.payload ?? null).length;
      return b.payload === undefined || b.payload === null ? payloadChars + (b.text?.length ?? 0) : payloadChars;
    }
  }
}

function marker(content: string | ToolResultPart[]): string {
  if (typeof content === 'string') {
    return `[elided to save context: tool output of ${content.length} chars, sha256=${sha256(Buffer.from(content, 'utf8')).slice(0, 12)}…; the full output remains in the session evidence log]`;
  }
  // The digest and char count must describe what the TOOL said — i.e. what outputPreview holds
  // in the evidence log — so harness-authored image-replacement markers (and image parts, which
  // are never logged verbatim) are counted as images, not as tool text.
  const originals = content.filter(
    (p): p is Extract<ToolResultPart, { type: 'text' }> => p.type === 'text' && p.elisionMarker !== true,
  );
  const text = originals.map((p) => p.text).join('\n');
  const images = content.filter((p) => p.type === 'image' || (p.type === 'text' && p.elisionMarker === true)).length;
  return `[elided to save context: tool output of ${text.length} chars${images > 0 ? ` + ${images} image(s)` : ''}, sha256=${sha256(Buffer.from(text, 'utf8')).slice(0, 12)}…; the full output remains in the session evidence log]`;
}

function imageMarker(p: Extract<ToolResultPart, { type: 'image' }>): ToolResultPart {
  const where = p.sha256 !== undefined ? `preserved at objects/${p.sha256}` : 'preserved in the session evidence store';
  return {
    type: 'text',
    text: `[screenshot${p.label !== undefined ? ` ${p.label}` : ''}: viewed live earlier this session; ${where} — view_image can re-fetch it if genuinely needed]`,
    elisionMarker: true,
  };
}

/**
 * Index of the message from which the last `keep` assistant steps begin. keep<=0 protects
 * NOTHING (the boundary is the end of the list, so every message is elidable); fewer than
 * `keep` assistant steps protects everything (boundary 0).
 */
function protectionBoundary(messages: readonly ChatMessage[], keep: number): number {
  if (keep <= 0) return messages.length;
  let assistantSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      assistantSeen++;
      if (assistantSeen === keep) return i;
    }
  }
  return 0;
}

export function elideHistory(messages: readonly ChatMessage[], opts: ElisionOptions = {}): ElisionOutcome {
  const trigger = opts.triggerChars ?? DEFAULT_TRIGGER_CHARS;
  const target = opts.targetChars ?? DEFAULT_TARGET_CHARS;
  const keep = opts.keepLastSteps ?? DEFAULT_KEEP_LAST_STEPS;
  const imageKeep = opts.imageKeepLastSteps ?? IMAGE_KEEP_LAST_STEPS;

  let rawChars = 0;
  for (const m of messages) for (const b of m.content) rawChars += blockChars(b);

  // ── Pass 1 (Session 13): image parts age out of the recent window UNCONDITIONALLY — even
  // below the char trigger — replaced part-by-part so the text of the result stays verbatim.
  const imgProtectFrom = protectionBoundary(messages, imageKeep);
  const out: ChatMessage[] = messages.map((m) => ({ role: m.role, content: [...m.content] }));
  const imageElidedCallIds: string[] = [];
  let sentChars = rawChars;
  for (let i = 0; i < imgProtectFrom; i++) {
    const m = out[i]!;
    if (m.role !== 'user') continue;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j]!;
      if (b.type !== 'tool_result' || typeof b.content === 'string') continue;
      if (!b.content.some((p) => p.type === 'image')) continue;
      let replacedAny = false;
      const replaced = b.content.map((p) => {
        if (p.type !== 'image') return p;
        const mk = imageMarker(p);
        // Never let a "compaction" grow the prompt: a tiny image stays pixels (the char walk's
        // own too-small guard, mirrored here).
        if (partChars(mk) >= partChars(p)) return p;
        sentChars -= partChars(p) - partChars(mk);
        replacedAny = true;
        return mk;
      });
      if (!replacedAny) continue;
      m.content[j] = { type: 'tool_result', toolUseId: b.toolUseId, content: replaced, ...(b.isError ? { isError: true } : {}) };
      imageElidedCallIds.push(b.toolUseId);
    }
  }

  // ── Pass 2: the V0.5 char-budget walk, over the image-elided view.
  const protectFrom = protectionBoundary(messages, keep);
  const elidedCallIds: string[] = [];
  // MONOTONICITY (S14.5 review finding): an output this session already elided STAYS elided.
  // Pass 1 subtracts image weight unconditionally, so an aging screenshot could free enough
  // budget that pass 2 stopped early and RESTORED previously-elided outputs verbatim — which
  // invalidated the moving cache breakpoint (the whole suffix re-billed) and left
  // `context.compacted` claiming the model could not see text it could. The module's own
  // monotonicity promise is only true with this carry-over, since the trigger is not.
  // The sticky pass runs BEFORE the trigger check (S15 review finding): `contextBudget` became
  // mutable mid-session with /provider and /model, so a switch to a LARGER-budget model can raise
  // the trigger above the current raw size — and an early return here would have restored, verbatim,
  // outputs the log already recorded as elided in `context.compacted`. Monotonicity is a property
  // of the SET, not of the threshold.
  const sticky = new Set(opts.alreadyElided ?? []);
  if (sticky.size > 0) {
    for (let i = 0; i < protectFrom; i++) {
      const m = out[i]!;
      if (m.role !== 'user') continue;
      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j]!;
        if (b.type !== 'tool_result' || !sticky.has(b.toolUseId)) continue;
        if (typeof b.content === 'string' && b.content.startsWith('[elided to save context:')) continue; // already a marker
        const replacement = marker(b.content);
        if (replacement.length >= contentChars(b.content)) continue;
        sentChars -= contentChars(b.content) - replacement.length;
        m.content[j] = { type: 'tool_result', toolUseId: b.toolUseId, content: replacement, ...(b.isError ? { isError: true } : {}) };
        elidedCallIds.push(b.toolUseId);
      }
    }
  }
  // The trigger gates only the CHAR WALK, preserving the hysteresis (trigger >> target): below it
  // the sticky set has still been re-applied above, so nothing previously elided comes back.
  if (rawChars <= trigger) {
    return { messages: out, elidedCallIds, imageElidedCallIds, rawChars, sentChars, exhausted: false };
  }

  outer: for (let i = 0; i < protectFrom; i++) {
    const m = out[i]!;
    if (m.role !== 'user') continue;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j]!;
      if (b.type !== 'tool_result') continue;
      if (elidedCallIds.includes(b.toolUseId)) continue; // already handled by the sticky pass
      if (sentChars <= target) break outer;
      const replacement = marker(b.content);
      if (replacement.length >= contentChars(b.content)) continue; // eliding tiny outputs would grow the prompt
      sentChars -= contentChars(b.content) - replacement.length;
      m.content[j] = { type: 'tool_result', toolUseId: b.toolUseId, content: replacement, ...(b.isError ? { isError: true } : {}) };
      elidedCallIds.push(b.toolUseId);
    }
  }
  return { messages: out, elidedCallIds, imageElidedCallIds, rawChars, sentChars, exhausted: sentChars > target };
}
