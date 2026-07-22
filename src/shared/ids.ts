import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';

/**
 * Injectable id generation. Session ids are lexically sortable (`yyyymmdd-hhmmss-<4hex>`).
 * A seeded generator gives tests stable ids for byte-identical logs.
 */
export interface IdGen {
  sessionId(): string;
  callId(): string;
}

function two(n: number): string {
  return n.toString().padStart(2, '0');
}

/** `yyyymmdd-hhmmss` in UTC for a given epoch-ms instant. */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}` +
    `-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`
  );
}

export function systemIdGen(clock: Clock): IdGen {
  return {
    // 4 random bytes (2^32 per same-second window): concurrent same-process child sessions made
    // same-second id generation routine, so the collision space must be wide enough that the
    // structural refusal (exclusive log creation) is a never-hit backstop, not a working path.
    sessionId: () => `${formatStamp(clock.now())}-${randomBytes(4).toString('hex')}`,
    callId: () => `call_${randomBytes(6).toString('hex')}`,
  };
}

/** Deterministic ids for tests: `<prefix>-session-0001`, `<prefix>-call-0001`, ... */
export function seededIdGen(prefix = 'test'): IdGen {
  let s = 0;
  let c = 0;
  return {
    sessionId: () => `${prefix}-session-${(++s).toString().padStart(4, '0')}`,
    callId: () => `${prefix}-call-${(++c).toString().padStart(4, '0')}`,
  };
}
