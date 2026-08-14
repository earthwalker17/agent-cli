import type { KeyEvent, ReplIO } from './io.js';
import type { StatusArea } from './status.js';
import type { Style } from './format.js';
import { sanitizeLine } from '../shared/text.js';

/**
 * The arrow-key select widget (Session 22) — the one interactive surface that reads KEYS instead
 * of lines, built strictly from the existing primitives: `io.captureKeys` (exclusive keypress
 * routing behind the ONE readline) and the status area's overlay channel (the ONE cursor-moving
 * module redraws the menu; this file emits zero escape bytes itself).
 *
 * Contract, load-bearing:
 *
 * - **Capture before output.** `captureKeys` is engaged before the header block is written, so a
 *   reactive driver that answers the instant header bytes appear cannot lose keystrokes — the
 *   select-widget analog of the resolver-before-prompt ordering in io.ts.
 * - **Enter never affirms.** The initial highlight is the caller-named decline/deny entry; Enter
 *   with no navigation resolves exactly what an empty line resolves today. There is no wrap-
 *   around: one Down past the last entry stays put rather than landing on the top (affirmative)
 *   row.
 * - **Letters do not act immediately.** A printable key opens a visible typed buffer submitted
 *   on Enter through the CALLER's parser — never interpreted here. First-character resolution at
 *   the keypress level would reintroduce the exact hazard NEGATIVE_WORDS closed (`cancel` one
 *   keystroke from `[c] commit`), so the widget refuses to own any answer grammar.
 * - **Ctrl+C preserves io.ts ordering**: the io layer fires the turn-interrupt handler BEFORE
 *   the widget resolves, so an abort lands before the waiter unblocks — byte-for-byte the
 *   'SIGINT' contract of the line path. Ctrl+D and stream close resolve EOF.
 * - **Esc is not advertised.** Node's keypress decoder holds a bare ESC waiting for a sequence
 *   continuation, so a lone Esc press emits nothing until the NEXT key — which then arrives
 *   meta-flagged. The widget declines on a delivered 'escape' event where a decoder produces
 *   one, and IGNORES every other meta-flagged key so an Esc-prefixed Enter can never confirm;
 *   the reliable declines are Enter on the highlighted decline row, or typing a refusal.
 * - **Fallback is structural.** When capture is unavailable (non-TTY, or another capture is
 *   somehow active) the caller falls back to the line-question path unchanged — the widget is
 *   an enhancement layered over the grammar, never a replacement for it.
 */

export interface SelectRow<K extends string> {
  key: K;
  label: string;
}

export type SelectResult<K extends string> =
  | { kind: 'picked'; key: K }
  | { kind: 'typed'; text: string }
  | { kind: 'declined' }
  | { kind: 'eof' }
  | { kind: 'unavailable' };

export interface SelectWidget {
  run<K extends string>(opts: {
    /** Pre-rendered block (already sanitized where it embeds untrusted text), printed as chrome
     *  before the menu so scrollback keeps a complete transcript after the overlay is erased. */
    header: string;
    choices: readonly SelectRow<K>[];
    /** The entry highlighted first — always the decline/deny-shaped one. */
    initialKey: K;
    /** Render `[k]` before each label (default true). The `/` menu turns it off: its keys are
     *  full command names already shown in the label. */
    showKeys?: boolean;
    /** Window tall lists around the highlight (default: no window). The overlay's erase math
     *  counts drawn lines, so a menu taller than the terminal would corrupt the region — long
     *  menus stay short instead, with honest "… N more" markers. */
    maxVisible?: number;
  }): Promise<SelectResult<K>>;
}

export function createSelectWidget(deps: {
  io: ReplIO;
  area: StatusArea;
  style: Style;
  /** The renderer's chromeLine — header and outcome echo go through it. */
  chromeLine: (text: string) => void;
}): SelectWidget {
  const { io, area, style } = deps;
  const g = style.glyph;

  return {
    run<K extends string>(opts: {
      header: string;
      choices: readonly SelectRow<K>[];
      initialKey: K;
      showKeys?: boolean;
      maxVisible?: number;
    }): Promise<SelectResult<K>> {
      const { choices } = opts;
      const showKeys = opts.showKeys !== false;
      const maxVisible = Math.max(3, opts.maxVisible ?? Number.MAX_SAFE_INTEGER);
      const initialIndex = Math.max(
        0,
        choices.findIndex((c) => c.key === opts.initialKey),
      );
      let highlight = initialIndex;
      let typed: string | null = null;

      const menuLines = (): readonly (string | { text: string; role: 'accent' | 'muted' })[] => {
        const all: (string | { text: string; role: 'accent' | 'muted' })[] = choices.map((c, i) => {
          const label = showKeys ? `[${c.key}] ${sanitizeLine(c.label)}` : sanitizeLine(c.label);
          return i === highlight && typed === null
            ? { text: `${g.pointer}${label}`, role: 'accent' as const }
            : `  ${label}`;
        });
        let rows = all;
        if (all.length > maxVisible) {
          // Window around the highlight, with honest edges.
          const start = Math.min(Math.max(0, highlight - Math.floor(maxVisible / 2)), all.length - maxVisible);
          rows = all.slice(start, start + maxVisible);
          if (start > 0) rows.unshift({ text: `  … ${start} more above`, role: 'muted' as const });
          const below = all.length - (start + maxVisible);
          if (below > 0) rows.push({ text: `  … ${below} more below`, role: 'muted' as const });
        }
        if (typed !== null) rows.push({ text: `  > ${sanitizeLine(typed)}_`, role: 'muted' as const });
        else rows.push({ text: `  (arrows move, Enter confirms the highlight — or type an answer and press Enter)`, role: 'muted' as const });
        return rows;
      };

      return new Promise<SelectResult<K>>((resolve) => {
        let release: (() => void) | null = null;
        let done = false;
        let drained = '';
        const finish = (r: SelectResult<K>): void => {
          if (done) return;
          done = true;
          area.overlay(null);
          release?.();
          // The transcript echo: the overlay is ephemeral, so the answer must land in
          // scrollback the way a typed line would have.
          const echo =
            r.kind === 'picked'
              ? `  > ${sanitizeLine(choices[highlight]!.label)}`
              : r.kind === 'typed'
                ? `  > ${sanitizeLine(r.text)}`
                : r.kind === 'declined'
                  ? '  > (declined)'
                  : r.kind === 'eof'
                    ? '  > (no answer)'
                    : null;
          if (echo !== null) deps.chromeLine(style.seg('muted', echo));
          resolve(r);
        };

        // Capture BEFORE any output (see the module contract).
        const capture = io.captureKeys((k: KeyEvent) => {
          try {
            handleKey(k);
          } catch {
            /* a throwing handler must never wedge the stream */
          }
        });
        if (capture === null) {
          done = true;
          resolve({ kind: 'unavailable' });
          return;
        }
        release = capture.release;
        drained = capture.drained;
        // A half-typed mid-turn line was invisibly in flight when the menu engaged: surface it
        // as the typed buffer, so it stays ONE string the user can see, finish, clear (Ctrl+U)
        // or submit — never a hidden prefix plus a fragment answering a security prompt.
        if (drained.length > 0) typed = drained;
        deps.chromeLine(opts.header);
        area.overlay(menuLines());

        const redraw = (): void => {
          if (!done) area.overlay(menuLines());
        };

        const handleKey = (k: KeyEvent): void => {
          if (done) return;
          // Interrupt/EOF first — io has already fired the turn-interrupt handler for Ctrl+C.
          if (k.name === 'eof' || (k.ctrl === true && k.name === 'c')) {
            finish({ kind: 'eof' });
            return;
          }
          if (k.ctrl === true && k.name === 'd') {
            if (typed === null || typed.length === 0) finish({ kind: 'eof' });
            return; // readline's own convention: Ctrl+D with a non-empty buffer is inert
          }
          if (k.name === 'escape') {
            if (typed !== null) {
              typed = null;
              redraw();
            } else finish({ kind: 'declined' });
            return;
          }
          // Any other meta-flagged key is an Esc-prefixed chord the decoder folded together —
          // dropping it means an Esc followed by Enter can never confirm a highlight.
          if (k.meta === true) return;
          if (k.name === 'return' || k.name === 'enter') {
            if (typed !== null) finish({ kind: 'typed', text: typed });
            else finish({ kind: 'picked', key: choices[highlight]!.key });
            return;
          }
          if (typed === null && (k.name === 'up' || k.name === 'down')) {
            // Clamped, no wrap: one Down past the end must not land on the top row.
            highlight = k.name === 'up' ? Math.max(0, highlight - 1) : Math.min(choices.length - 1, highlight + 1);
            redraw();
            return;
          }
          if (k.ctrl === true && k.name === 'u') {
            if (typed !== null) {
              typed = null;
              redraw();
            }
            return;
          }
          if (k.name === 'backspace') {
            if (typed !== null) {
              typed = [...typed].slice(0, -1).join('');
              if (typed.length === 0) typed = null;
              redraw();
            }
            return;
          }
          // Printable input (single keys and pastes): opens/extends the typed buffer. Control
          // bytes are dropped; the buffer is submitted through the CALLER's parser on Enter.
          // (meta already returned above.)
          if (k.ctrl !== true && k.seq.length > 0) {
            const printable = [...k.seq].filter((ch) => ch.codePointAt(0)! >= 0x20).join('');
            if (printable.length > 0) {
              typed = (typed ?? '') + printable;
              redraw();
            }
          }
        };
      });
    },
  };
}
