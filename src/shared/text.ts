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

/**
 * Break any line that mimics a harness FENCE (`--- <label> begin|end ---`). Such a line inside
 * untrusted text would fake a provenance boundary the model trusts: closing a region early and
 * occupying space labeled harness-authored. A visible middle dot breaks the mimicry without
 * hiding content.
 *
 * Session 10 introduced this for child reports and forwarded context; S14.5 generalized the
 * pattern to EVERY fence and extended it to the memory documents (AGENT.md is workspace bytes a
 * cloned repo controls; JOURNAL.md/CODEBASE.md carry model-authored text from earlier sessions
 * — both are injected into the system prompt itself).
 */
export function neutralizeHarnessDelimiters(text: string): string {
  // Any line that OPENS like a fence and carries begin/end — the trailing `---` is optional,
  // because the mimicry only needs the opening form to be convincing in a prompt.
  return text.replace(/^(\s*)(---\s+\S.*\b(?:begin|end)\b.*)$/gm, '$1·$2');
}
