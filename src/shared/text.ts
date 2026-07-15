/**
 * Terminal-output sanitization. Untrusted strings (workspace paths, file names, model output
 * echoed into chrome) can carry control characters, ANSI escapes, or Unicode bidi overrides that
 * spoof what the user sees — e.g. a bidi-reversed folder name in the trust consent prompt.
 */

// C0 controls, DEL, C1 controls (covers ESC → ANSI injection), bidi marks and
// embedding/override/isolate controls, zero-width characters and the BOM.
const UNSAFE = new RegExp(
  '[' +
    '\\u0000-\\u001f' + // C0 (raw \t\n\r are normalized to spaces first)
    '\\u007f-\\u009f' + // DEL + C1
    '\\u200b-\\u200f' + // zero-width space/joiners, LRM/RLM
    '\\u202a-\\u202e' + // bidi embedding/override
    '\\u2066-\\u2069' + // bidi isolates
    '\\ufeff' + // BOM / zero-width no-break space
    ']',
  'gu',
);

/** Escape spoofing-capable characters as \u{...} so a single display line reads literally. */
export function sanitizeLine(s: string): string {
  return s.replace(/[\t\n\r]/g, ' ').replace(UNSAFE, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}
