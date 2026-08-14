import { describe, expect, it } from 'vitest';
import { clipToWidth, codePointWidth, displayWidth } from '../src/repl/width.js';

// Every non-ASCII character in this file is written as an escape on purpose: a precomposed
// character and a base+combining sequence are indistinguishable to a reader, and this suite
// exists precisely to tell their widths apart.
const CJK = '中'; // one CJK unified ideograph, display width 2
const ELLIPSIS = '…';

describe('displayWidth', () => {
  it('ASCII measures one column per character', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('x'.repeat(50))).toBe(50);
  });

  it('CJK measures two columns per character', () => {
    expect(displayWidth(CJK)).toBe(2);
    expect(displayWidth(CJK.repeat(2))).toBe(4);
    expect(displayWidth('カタカナ')).toBe(8); // katakana
    expect(displayWidth('한글')).toBe(4); // hangul syllables
  });

  it('fullwidth forms are wide, the one narrow gap is respected', () => {
    expect(displayWidth('Ａ')).toBe(2); // fullwidth A
    expect(codePointWidth(0x303f)).toBe(1); // the narrow gap in the CJK-symbols block
  });

  it('combining marks measure zero', () => {
    expect(displayWidth('é')).toBe(1); // e + combining acute
    expect(displayWidth('ñ')).toBe(1); // n + combining tilde
    expect(displayWidth('é')).toBe(1); // precomposed for contrast
  });

  it('zero-width and bidi characters measure zero (raw content honesty)', () => {
    expect(displayWidth('a​b')).toBe(2); // zero-width space
    expect(displayWidth('﻿')).toBe(0); // BOM/ZWNBSP
    expect(displayWidth('‮')).toBe(0); // RLO
  });

  it('emoji measure two columns and surrogate pairs count once', () => {
    expect(displayWidth('\u{1F642}')).toBe(2); // slightly smiling face
    expect('\u{1F642}'.length).toBe(2); // the code-unit count the old clip would have used
    expect(displayWidth('a\u{1F680}b')).toBe(4);
  });
});

describe('clipToWidth', () => {
  it('returns the string untouched when it fits exactly', () => {
    expect(clipToWidth('abc', 3)).toBe('abc');
    expect(clipToWidth(CJK.repeat(2), 4)).toBe(CJK.repeat(2));
  });

  it('matches the legacy code-unit clip byte-for-byte on ASCII', () => {
    // The status-area pins depend on this: for ASCII, width == length, so the new clip must
    // produce exactly `slice(0, width - 1) + ellipsis`.
    const s = 'x'.repeat(50);
    const width = 18;
    expect(clipToWidth(s, width)).toBe(`${s.slice(0, width - 1)}${ELLIPSIS}`);
  });

  it('never exceeds the column budget when clipping wide characters', () => {
    const clipped = clipToWidth(CJK.repeat(3), 3);
    expect(clipped).toBe(`${CJK}${ELLIPSIS}`);
    expect(displayWidth(clipped)).toBe(3);
  });

  it('drops a wide character that would straddle the boundary', () => {
    // budget 4 - ellipsis 1 = 3 columns of content: one wide char (2) fits, a second needs 4.
    const clipped = clipToWidth(CJK.repeat(3), 4);
    expect(clipped).toBe(`${CJK}${ELLIPSIS}`);
    expect(displayWidth(clipped)).toBeLessThanOrEqual(4);
  });

  it('a combining sequence survives the clip attached to its base', () => {
    expect(clipToWidth('ébcdef', 3)).toBe(`éb${ELLIPSIS}`);
  });

  it('degenerate budgets fail closed', () => {
    expect(clipToWidth('abc', 0)).toBe('');
    expect(clipToWidth('abcdef', 1)).toBe(ELLIPSIS);
    expect(clipToWidth('', 5)).toBe('');
  });
});
