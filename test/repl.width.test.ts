import { describe, expect, it } from 'vitest';
import { clipToWidth, codePointWidth, displayWidth } from '../src/repl/width.js';

// Every ambiguity-prone fixture is CONSTRUCTED from code points (S22 review): a precomposed
// character and a base+combining sequence are indistinguishable to a reader, and any
// NFC-normalizing editor or formatter would silently convert a raw combining literal into the
// precomposed form — leaving the "combining marks measure zero" tests vacuously green.
const cp = (n: number): string => String.fromCodePoint(n);
const CJK = cp(0x4e2d); // one CJK unified ideograph, display width 2
const ELLIPSIS = cp(0x2026);
const E_COMBINING = `e${cp(0x0301)}`; // e + combining acute — NEVER the precomposed U+00E9
const N_COMBINING = `n${cp(0x0303)}`; // n + combining tilde
const E_PRECOMPOSED = cp(0x00e9);
const ZWSP = cp(0x200b);
const BOM = cp(0xfeff);
const RLO = cp(0x202e);

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
    expect(E_COMBINING.length).toBe(2); // proof the fixture really is base+combining
    expect(displayWidth(E_COMBINING)).toBe(1);
    expect(displayWidth(N_COMBINING)).toBe(1);
    expect(E_PRECOMPOSED.length).toBe(1); // and the precomposed contrast really is one unit
    expect(displayWidth(E_PRECOMPOSED)).toBe(1);
  });

  it('zero-width and bidi characters measure zero (raw content honesty)', () => {
    expect(displayWidth(`a${ZWSP}b`)).toBe(2);
    expect(displayWidth(BOM)).toBe(0);
    expect(displayWidth(RLO)).toBe(0);
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
    expect(clipToWidth(`${E_COMBINING}bcdef`, 3)).toBe(`${E_COMBINING}b${ELLIPSIS}`);
  });

  it('degenerate budgets fail closed', () => {
    expect(clipToWidth('abc', 0)).toBe('');
    expect(clipToWidth('abcdef', 1)).toBe(ELLIPSIS);
    expect(clipToWidth('', 5)).toBe('');
  });
});
