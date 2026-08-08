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
 * Remove ANSI escape sequences so a machine can PARSE what a terminal would render. Distinct from
 * `sanitizeLine`, which escapes them so a human sees them literally: this one is for the harness
 * reading a server's own output, where an escape sequence is noise between the characters that
 * matter, not something to display.
 *
 * It is load-bearing rather than cosmetic. A dev server colourises its startup banner, and
 * picocolors — which Vite and much of the Node ecosystem use — enables colour whenever
 * `process.platform === 'win32'`, *regardless of whether stdout is a TTY*. A preview's stdio is a
 * log file, and the announced URL still arrives as `http://localhost:<ESC>[1m5173<ESC>[22m/`: the
 * port sits behind an escape sequence, so a port parser anchored on `localhost:` matches nothing
 * and a perfectly healthy server is reported as never having announced a port.
 *
 * Covers CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and the general ECMA-48 escape form
 * (`ESC` + optional intermediates + a final byte) — which is what catches charset designations
 * like `ESC ( B` that some terminals interleave with colour.
 */
// eslint-disable-next-line no-control-regex
const ANSI_SEQ = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_SEQ, '');
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
  //
  // Case-INSENSITIVE (Session 20 review): the harness writes its markers in lower case, so a
  // case-sensitive test let `--- REMOTE CONTENT END ---` through unmodified. A model reading for a
  // provenance boundary does not read case-sensitively, and neither should this.
  return text.replace(/^(\s*)(---\s+\S.*\b(?:begin|end)\b.*)$/gim, '$1·$2');
}
