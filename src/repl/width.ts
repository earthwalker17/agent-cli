/**
 * Display-width measurement for status-region clipping (Session 22).
 *
 * The status area's clip counted UTF-16 code units, which `status.ts` documented as safe only
 * while every status line was structurally ASCII-narrow — and named a width-aware clip as the
 * prerequisite before any free-form text (choice labels, task titles) may land there. This is
 * that prerequisite.
 *
 * The table is a deliberate approximation of Unicode East Asian Width plus emoji presentation,
 * not a full UAX #11 implementation: combining marks and zero-width characters measure 0, the
 * CJK/Hangul/Kana/fullwidth/emoji blocks measure 2, everything else measures 1. Ambiguous-width
 * characters measure 1 (the terminal disagreement they embody is exactly why callers keep a
 * small margin). Wrong only toward a slightly-early ellipsis, never toward cursor corruption:
 * the clip consumer already sanitizes control characters out before measuring.
 */

/** [start, end] inclusive code-point ranges. Frozen, ordered, non-overlapping. */
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489], // Cyrillic combining
  [0x0591, 0x05bd], // Hebrew points
  [0x0610, 0x061a], // Arabic marks
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x08e3, 0x0902], // Arabic/Devanagari combining
  [0x093c, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0e31, 0x0e31], // Thai
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff], // combining extended
  [0x1dc0, 0x1dff], // combining supplement
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM (post-sanitize these are escaped text,
  [0x202a, 0x202e], // but the measurer stays honest for callers that measure raw content)
  [0x2066, 0x2069],
  [0x20d0, 0x20ff], // combining for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // combining half marks
  [0xfeff, 0xfeff], // BOM/ZWNBSP
];

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo (choseong)
  [0x2e80, 0x303e], // CJK radicals … CJK symbols and punctuation (U+303F is narrow)
  [0x3041, 0x33ff], // Hiragana … CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1faff], // emoji & pictographs (emoji presentation is wide in every modern terminal)
  [0x20000, 0x2fffd], // CJK extensions B+
  [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  // Linear scan: the tables are small and the strings are status lines, not documents.
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false; // ranges are ordered
    if (cp <= hi) return true;
  }
  return false;
}

/** Terminal display columns for one code point. */
export function codePointWidth(cp: number): number {
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

/** Terminal display columns for a string (code-point walk; surrogate pairs counted once). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += codePointWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * Clip to at most `cols` display columns, appending `ellipsis` when anything was dropped.
 * The ellipsis' own width is budgeted, so the result never exceeds `cols`. A non-positive
 * budget yields the empty string rather than a bare ellipsis wider than the budget.
 */
export function clipToWidth(s: string, cols: number, ellipsis = '…'): string {
  if (cols <= 0) return '';
  if (displayWidth(s) <= cols) return s;
  const budget = cols - displayWidth(ellipsis);
  if (budget <= 0) return ellipsis.slice(0, Math.max(0, cols)); // degenerate: budget too small to keep content
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = codePointWidth(ch.codePointAt(0)!);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}
