import { sanitizeLine } from '../shared/text.js';
import { clipToWidth } from './width.js';

/**
 * The sticky status area (Session 11) — the ONLY cursor-moving code in the codebase, strictly
 * confined to this file and to the chrome stream (stderr).
 *
 * Contract, load-bearing:
 * - Active only on a TTY: with `isTTY: false` every method is a pass-through/no-op and ZERO
 *   escape bytes are ever emitted (piped transcripts stay byte-identical to pre-Session-11).
 * - Every chrome write is routed THROUGH this writer: erase the status region → write the
 *   chrome → redraw at the next line boundary. While a chrome line is half-open (the
 *   renderer's unterminated tool line), redraws are DEFERRED until a newline lands — the
 *   region never injects itself into someone's open line.
 * - The safe window is a running turn (readline echo is muted then); approval prompts
 *   suspend() the region, and the REPL clear()s it before every idle prompt — readline owns
 *   the bottom line whenever it is live.
 * - Status content is sanitized (sanitizeLine strips \r and escapes) and clipped to the
 *   terminal width per redraw, so untrusted text can never move the cursor itself. The clip
 *   counts DISPLAY COLUMNS (width.ts, Session 22 — the prerequisite the old code-unit clip
 *   named before free-form text could land here); ambiguous-width characters measure 1, which
 *   the 2-column margin absorbs.
 * - A terminal SHRUNK after a draw can reflow the on-screen region; the next erase then
 *   under-counts physical rows and may leave a stale fragment ABOVE the region until it
 *   scrolls away (cosmetic; real output above the region is never touched — the cursor never
 *   moves above the region's own top row).
 * - stdout is untouched: during delegate flight the parent is blocked on the tool call, so no
 *   model text streams while the region redraws — stderr cursor movement cannot interleave
 *   with stdout content by construction.
 */

export interface StatusArea {
  /** The status-aware chrome sink: every chrome byte goes through here. */
  write(chunk: string): void;
  /** Replace the region's content ([] hides it). Sanitized + clipped at render time. */
  setLines(lines: readonly string[]): void;
  /** Erase and stop redrawing (an approval prompt owns the screen); resume() restores. */
  suspend(): void;
  resume(): void;
  /** Erase and drop the content (turn end / before an idle prompt). */
  clear(): void;
}

const ESC = '[';

export function createStatusArea(opts: { chromeOut: NodeJS.WritableStream; isTTY: boolean }): StatusArea {
  const { chromeOut, isTTY } = opts;
  if (!isTTY) {
    // Non-TTY: a pure pass-through — no state, no escapes, byte-identical chrome.
    return {
      write: (chunk) => void chromeOut.write(chunk),
      setLines: () => {},
      suspend: () => {},
      resume: () => {},
      clear: () => {},
    };
  }

  let lines: string[] = [];
  let height = 0; // lines currently ON SCREEN (0 = region not drawn)
  let suspended = false;
  let atLineStart = true; // column state of the chrome stream under the region
  let dirty = false;

  const columns = (): number => {
    const c = (chromeOut as Partial<NodeJS.WriteStream>).columns;
    return typeof c === 'number' && c > 10 ? c : 80;
  };

  const erase = (): void => {
    if (height === 0) return;
    // The cursor sits at column 0 below the region (every region line ends with \n): move to
    // the region's first line and clear to the end of the screen.
    chromeOut.write(`${ESC}${height}A${ESC}0J`);
    height = 0;
  };

  const draw = (): void => {
    if (suspended || lines.length === 0) return;
    if (!atLineStart) {
      dirty = true; // a chrome line is half-open — defer to the next newline-terminated write
      return;
    }
    const width = columns() - 2; // margin for the ambiguous-width glyphs (▸ ⚑ ·) in status lines
    for (const l of lines) {
      const clean = sanitizeLine(l);
      chromeOut.write(`${clipToWidth(clean, width)}\n`);
    }
    height = lines.length;
    dirty = false;
  };

  return {
    write(chunk): void {
      if (chunk.length === 0) return;
      erase();
      chromeOut.write(chunk);
      atLineStart = chunk.endsWith('\n');
      if (atLineStart && (dirty || lines.length > 0)) draw();
    },
    setLines(next): void {
      lines = [...next];
      erase();
      draw();
    },
    suspend(): void {
      erase();
      suspended = true;
    },
    resume(): void {
      suspended = false;
      draw();
    },
    clear(): void {
      erase();
      lines = [];
      dirty = false;
    },
  };
}
