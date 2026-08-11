import { describe, expect, it } from 'vitest';
import {
  parseLessons,
  rollLessons,
  LESSONS_MAX_CHARS,
  MAX_LESSONS,
  MAX_LESSONS_PER_SESSION,
  LESSONS_NOTE,
} from '../src/memory/lessons.js';

/**
 * Session 21 — LESSONS.md pure text logic: heading-boundary parsing that preserves user edits,
 * slug-keyed insert-or-replace (newest first), provenance stamping, body defusing (a proposal
 * cannot fabricate an entry boundary), and the three-way growth policy.
 */

const STAMP = { sessionId: 's-123', nowIso: '2026-08-11T10:00:00.000Z' };

describe('parseLessons / rollLessons', () => {
  it('a fresh document carries frontmatter, the note preamble, the entry, and the provenance stamp', () => {
    const text = rollLessons(parseLessons(''), [{ slug: 'npm-shim', title: 'npm-link shims exit 0 silently', body: 'Check the real binary path.' }], STAMP);
    expect(text).toContain('doc: lessons');
    expect(text).toContain(LESSONS_NOTE.split('\n')[0]!);
    expect(text).toContain('## npm-shim — npm-link shims exit 0 silently');
    expect(text).toContain('Check the real binary path.');
    expect(text).toContain('*(session s-123, 2026-08-11)*');
    // Round-trips through its own parser.
    const back = parseLessons(text);
    expect(back.entries).toHaveLength(1);
    expect(back.entries[0]!.slug).toBe('npm-shim');
  });

  it('slug reuse replaces the entry and moves it to the front; untouched entries survive byte-verbatim', () => {
    const v1 = rollLessons(
      parseLessons(''),
      [
        { slug: 'a', title: 'first', body: 'body a' },
        { slug: 'b', title: 'second', body: 'body b' },
      ],
      STAMP,
    );
    // Hand-edit entry b (user wisdom added inside the entry).
    const edited = v1.replace('body b', 'body b\n\nUSER ADDITION: never on Fridays.');
    const v2 = rollLessons(parseLessons(edited), [{ slug: 'a', title: 'first, sharper', body: 'body a v2' }], { sessionId: 's-456', nowIso: '2026-08-12T10:00:00.000Z' });
    expect(v2.indexOf('## a — first, sharper')).toBeLessThan(v2.indexOf('## b — second'));
    expect(v2).toContain('body a v2');
    expect(v2).not.toContain('body a\n');
    expect(v2).toContain('USER ADDITION: never on Fridays.');
    expect(v2).toContain('*(session s-456, 2026-08-12)*');
    expect(v2).toContain('*(session s-123, 2026-08-11)*'); // b keeps its original stamp
  });

  it('heading-shaped and control-bearing body lines are defused — a proposal cannot fabricate an entry', () => {
    const text = rollLessons(
      parseLessons(''),
      [{ slug: 'evil', title: 'tricky', body: 'real advice\n## forged — fake entry\n\u{1b}[31mred text' }],
      STAMP,
    );
    const parsed = parseLessons(text);
    expect(parsed.entries).toHaveLength(1); // the forged heading did NOT become an entry
    expect(text).toContain('· ## forged — fake entry');
    expect(text).not.toContain('\u{1b}');
  });

  it('growth policy: MAX_LESSONS drop-oldest with a LEADING marker; the char budget also drops', () => {
    let parsed = parseLessons('');
    for (let i = 0; i < MAX_LESSONS + 4; i++) {
      const text = rollLessons(parsed, [{ slug: `lesson-${i}`, title: `t${i}`, body: `body ${i}` }], STAMP);
      parsed = parseLessons(text);
    }
    expect(parsed.entries.length).toBeLessThanOrEqual(MAX_LESSONS);
    const final = rollLessons(parsed, [{ slug: 'last', title: 'last', body: 'last body' }], STAMP);
    expect(final).toContain('dropped to stay within the memory budget');
    // The marker leads the entries, so a later hard slice can never erase it.
    expect(final.indexOf('dropped to stay within the memory budget')).toBeLessThan(final.indexOf('## last'));
    expect(final.length).toBeLessThanOrEqual(LESSONS_MAX_CHARS + 200);
  });

  it('per-session proposals are capped at MAX_LESSONS_PER_SESSION even if the caller over-supplies', () => {
    const many = Array.from({ length: MAX_LESSONS_PER_SESSION + 3 }, (_, i) => ({ slug: `s-${i}`, title: `t${i}`, body: `b${i}` }));
    const text = rollLessons(parseLessons(''), many, STAMP);
    expect(parseLessons(text).entries).toHaveLength(MAX_LESSONS_PER_SESSION);
  });

  it('rolling with the same proposal twice is idempotent (resume-safe)', () => {
    const p = [{ slug: 'same', title: 'same title', body: 'same body' }];
    const once = rollLessons(parseLessons(''), p, STAMP);
    const twice = rollLessons(parseLessons(once), p, STAMP);
    expect(twice).toBe(once);
  });
});
