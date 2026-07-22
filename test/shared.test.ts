import { describe, it, expect } from 'vitest';
import { fixedClock, systemClock } from '../src/shared/clock.js';
import { seededIdGen, systemIdGen, formatStamp } from '../src/shared/ids.js';
import { sha256, truncateForModel, redactSecret, randomSaltHex } from '../src/shared/hash.js';

describe('clock', () => {
  it('fixedClock advances by step per read', () => {
    const c = fixedClock(1000, 5);
    expect(c.now()).toBe(1000);
    expect(c.now()).toBe(1005);
    expect(c.iso()).toBe(new Date(1010).toISOString());
  });

  it('systemClock returns a plausible timestamp', () => {
    expect(systemClock.now()).toBeGreaterThan(0);
    expect(systemClock.iso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('ids', () => {
  it('formatStamp produces sortable yyyymmdd-hhmmss in UTC', () => {
    // 2026-07-14T09:08:07Z
    const ms = Date.UTC(2026, 6, 14, 9, 8, 7);
    expect(formatStamp(ms)).toBe('20260714-090807');
  });

  it('seededIdGen is deterministic and monotonic', () => {
    const g = seededIdGen('t');
    expect(g.sessionId()).toBe('t-session-0001');
    expect(g.sessionId()).toBe('t-session-0002');
    expect(g.callId()).toBe('t-call-0001');
    expect(g.callId()).toBe('t-call-0002');
  });

  it('systemIdGen embeds the clock stamp and a 32-bit random suffix', () => {
    const g = systemIdGen(fixedClock(Date.UTC(2026, 0, 2, 3, 4, 5)));
    // 8 hex chars (4 random bytes): same-second collisions must be a never-hit backstop once
    // one process starts several child sessions inside a single second (V0.7 parallel tasks).
    expect(g.sessionId()).toMatch(/^20260102-030405-[0-9a-f]{8}$/);
    expect(g.callId()).toMatch(/^call_[0-9a-f]{12}$/);
  });
});

describe('hash', () => {
  it('sha256 matches a known vector', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('truncateForModel leaves short output untouched', () => {
    const r = truncateForModel('hello', 100);
    expect(r).toEqual({ text: 'hello', truncated: false });
  });

  it('truncateForModel keeps head+tail with a marker and records full hash', () => {
    const big = 'A'.repeat(20_000) + 'B'.repeat(20_000);
    const r = truncateForModel(big, 1000);
    expect(r.truncated).toBe(true);
    expect(r.fullSha256).toBe(sha256(big));
    expect(r.text.length).toBeLessThanOrEqual(1000 + 200); // budget + marker slack
    expect(r.text.startsWith('A')).toBe(true);
    expect(r.text.endsWith('B')).toBe(true);
    expect(r.text).toContain('truncated');
  });

  it('truncateForModel output is deterministic (resume fidelity)', () => {
    const big = 'x'.repeat(50_000);
    expect(truncateForModel(big, 5000).text).toBe(truncateForModel(big, 5000).text);
  });

  it('redactSecret hides content but is stable within a salt', () => {
    const salt = randomSaltHex();
    const a = redactSecret('hunter2', salt);
    const b = redactSecret('hunter2', salt);
    expect(a).toBe(b);
    expect(a).not.toContain('hunter2');
    expect(a).toContain('7 bytes');
  });

  it('redactSecret differs across salts (per-session unlinkability)', () => {
    expect(redactSecret('hunter2', randomSaltHex())).not.toBe(
      redactSecret('hunter2', randomSaltHex()),
    );
  });
});
