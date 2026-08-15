import { describe, expect, it } from 'vitest';
import { parseAnswer } from '../src/runtime/approvals.js';

/**
 * S22.5 — the pooled first-character hazard, closed and pinned.
 *
 * parseAnswer resolves scope-WIDENING answers ([s] session, [a] machine-durable) as EXACT tokens
 * gated on what the prompt offered. Before this, any word beginning with 's' was a session grant
 * and any word beginning with 'a' a machine grant where offered — and because the engine executes
 * on ANY allow, the refusal word `stop` typed at a remote-write prompt would have run the push.
 * The minimum-privilege affirmative and the two refusals stay first-character tolerant: those can
 * only grant the least privileged choice or reduce privilege (the NEGATIVE_WORDS narrowing rule,
 * applied to the approval grammar).
 */
describe('parseAnswer scope hardening (S22.5)', () => {
  const both = { session: true, durable: true };
  const none = { session: false, durable: false };

  it('exact s/session is a session grant where [s] was offered', () => {
    expect(parseAnswer('s', both)).toEqual({ decision: 'allow', scope: 'session', source: 'user' });
    expect(parseAnswer(' Session ', both)).toEqual({ decision: 'allow', scope: 'session', source: 'user' });
  });

  it('exact a/always is a machine grant where [a] was offered', () => {
    expect(parseAnswer('a', both)).toEqual({ decision: 'allow', scope: 'machine', source: 'user' });
    expect(parseAnswer('ALWAYS', both)).toEqual({ decision: 'allow', scope: 'machine', source: 'user' });
  });

  it('refusal-shaped words are DENIES, never grants: stop/skip/sure/abort/later', () => {
    // Every one of these previously parsed by first character; `stop`/`skip`/`sure` minted a
    // SESSION grant and `abort` a MACHINE grant. All must deny now, even with both scopes offered.
    for (const word of ['stop', 'skip', 'sure', 'later', 'sounds good']) {
      expect(parseAnswer(word, both)).toEqual({ decision: 'deny', scope: 'once', source: 'user' });
    }
    expect(parseAnswer('abort', both)).toEqual({ decision: 'deny', scope: 'once', source: 'user' });
  });

  it('a scope key the prompt never OFFERED is a deny, not an allow', () => {
    // A remote-write prompt offers no [s]; typing `s` there must not execute the push.
    expect(parseAnswer('s', none)).toEqual({ decision: 'deny', scope: 'once', source: 'user' });
    expect(parseAnswer('a', none)).toEqual({ decision: 'deny', scope: 'once', source: 'user' });
    expect(parseAnswer('session', none)).toEqual({ decision: 'deny', scope: 'once', source: 'user' });
    expect(parseAnswer('always', none)).toEqual({ decision: 'deny', scope: 'once', source: 'user' });
  });

  it('the minimum-privilege affirmative stays tolerant: y/yes/yeah, exact allow → once', () => {
    for (const word of ['y', 'yes', 'yeah ', 'Y']) {
      expect(parseAnswer(word, none)).toEqual({ decision: 'allow', scope: 'once', source: 'user' });
    }
    // `allow` starts with 'a' — under the old grammar it was a MACHINE grant where offered.
    expect(parseAnswer('allow', both)).toEqual({ decision: 'allow', scope: 'once', source: 'user' });
  });

  it('refusals keep their meanings: q/quit stop, n/no/empty/unrecognized deny', () => {
    expect(parseAnswer('q', none)).toEqual({ decision: 'deny-stop', scope: 'once', source: 'user' });
    expect(parseAnswer('quit', none)).toEqual({ decision: 'deny-stop', scope: 'once', source: 'user' });
    for (const word of ['n', 'no', '', '  ', 'cancel', 'zzz']) {
      expect(parseAnswer(word, both)).toEqual({ decision: 'deny', scope: 'once', source: 'user' });
    }
  });
});
