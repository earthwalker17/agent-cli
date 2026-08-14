import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createReplIO } from '../src/repl/io.js';
import { createStatusArea } from '../src/repl/status.js';
import { NO_STYLE, detectStyle } from '../src/repl/format.js';
import { createSelectWidget, type SelectWidget } from '../src/repl/select.js';
import { stripAnsi } from '../src/shared/text.js';

/**
 * The select widget drives KEYPRESS bytes through the same PassThrough+isTTY:true seam the
 * reactive consent harness uses: `terminal: true` makes readline install its keypress decoder on
 * the input stream, so raw arrow/enter bytes written to the PassThrough arrive as decoded key
 * events. No pty exists anywhere in this suite — isTTY is a boolean on the seam.
 *
 * Control bytes are built programmatically: an invisible literal in a test source is exactly the
 * ambiguity this suite exists to rule out.
 */
const ESC = String.fromCharCode(0x1b);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = '\r';
const CTRL_C = String.fromCharCode(0x03);
const CTRL_D = String.fromCharCode(0x04);
const CTRL_U = String.fromCharCode(0x15);
const BACKSPACE = String.fromCharCode(0x7f);

const CHOICES = [
  { key: 'y', label: 'approve' },
  { key: 'v', label: 'show the plan first' },
  { key: 'n', label: 'not now' },
] as const;

type Key = (typeof CHOICES)[number]['key'];

function rig(opts: { isTTY?: boolean; colors?: boolean } = {}): {
  input: PassThrough;
  chrome: () => string;
  io: ReturnType<typeof createReplIO>;
  widget: SelectWidget;
  chromeLines: string[];
} {
  const isTTY = opts.isTTY ?? true;
  const input = new PassThrough();
  const output = new PassThrough();
  let chromeBuf = '';
  output.on('data', (c: Buffer) => {
    chromeBuf += c.toString('utf8');
  });
  const io = createReplIO({ input, output, isTTY });
  // WT_SESSION forces the Unicode glyph table on win32 too — the pointer expectation must be
  // deterministic across platforms.
  const style = opts.colors === true ? detectStyle({ isTTY: true, env: { WT_SESSION: '1' } }) : NO_STYLE;
  const area = createStatusArea({ chromeOut: output, isTTY, style });
  const chromeLines: string[] = [];
  const widget = createSelectWidget({
    io,
    area,
    style,
    chromeLine: (t) => {
      chromeLines.push(t);
      area.write(t + '\n');
    },
  });
  return { input, chrome: () => chromeBuf, io, widget, chromeLines };
}

function run(w: SelectWidget, initialKey: Key = 'n') {
  return w.run<Key>({ header: '  plan ready: demo', choices: CHOICES, initialKey });
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

describe('select widget: navigation and confirmation', () => {
  it('arrows move the highlight and Enter confirms the highlighted row', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write(`${UP}${UP}${ENTER}`); // n -> v -> y, confirm
    expect(await p).toEqual({ kind: 'picked', key: 'y' });
  });

  it('bare Enter confirms the initial highlight — the decline row (Enter never affirms)', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write(ENTER);
    expect(await p).toEqual({ kind: 'picked', key: 'n' });
  });

  it('navigation clamps: Down past the last row and Up past the first stay put', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write(`${DOWN}${DOWN}${ENTER}`); // initial is already the last row
    expect(await p).toEqual({ kind: 'picked', key: 'n' });

    const { input: i2, widget: w2 } = rig();
    const p2 = run(w2, 'y');
    await tick();
    i2.write(`${UP}${UP}${ENTER}`); // already at the top
    expect(await p2).toEqual({ kind: 'picked', key: 'y' });
  });

  it('the header block prints as chrome before the menu (transcript survives the overlay)', async () => {
    const { input, widget, chromeLines } = rig();
    const p = run(widget);
    await tick();
    expect(chromeLines[0]).toContain('plan ready: demo');
    input.write(ENTER);
    await p;
  });
});

describe('select widget: typed fallback', () => {
  it('typed text resolves as typed — the widget never interprets it', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write(`cancel${ENTER}`);
    expect(await p).toEqual({ kind: 'typed', text: 'cancel' });
  });

  it('backspace edits the buffer; emptying it returns to navigation', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write('y');
    await tick();
    input.write(BACKSPACE);
    await tick();
    input.write(ENTER); // Enter in NAV confirms the initial highlight
    expect(await p).toEqual({ kind: 'picked', key: 'n' });
  });

  it('Ctrl+U clears the buffer back to navigation', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write('yes but');
    await tick();
    input.write(CTRL_U);
    await tick();
    input.write(ENTER);
    expect(await p).toEqual({ kind: 'picked', key: 'n' });
  });

  it('arrow keys are inert while a typed buffer is open (no highlight moves, no corruption)', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write('x');
    await tick();
    input.write(UP);
    await tick();
    input.write(ENTER);
    expect(await p).toEqual({ kind: 'typed', text: 'x' });
  });
});

describe('select widget: interrupt, EOF, and safety', () => {
  it('Ctrl+C fires the registered interrupt handler BEFORE the widget resolves', async () => {
    const { input, io, widget } = rig();
    const order: string[] = [];
    io.onInterrupt(() => order.push('interrupt'));
    const p = run(widget).then((r) => {
      order.push('resolved');
      return r;
    });
    await tick();
    input.write(CTRL_C);
    expect(await p).toEqual({ kind: 'eof' });
    expect(order).toEqual(['interrupt', 'resolved']);
  });

  it('Ctrl+D on an empty buffer resolves EOF; with a non-empty buffer it is inert', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write('a');
    await tick();
    input.write(CTRL_D); // inert: buffer non-empty
    await tick();
    input.write(ENTER);
    expect(await p).toEqual({ kind: 'typed', text: 'a' });

    const { input: i2, widget: w2 } = rig();
    const p2 = run(w2);
    await tick();
    i2.write(CTRL_D);
    expect(await p2).toEqual({ kind: 'eof' });
  });

  it('stream end mid-select resolves EOF instead of hanging', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.end();
    expect(await p).toEqual({ kind: 'eof' });
  });

  it('meta-flagged keys (an Esc-prefixed Enter) never confirm', async () => {
    const { input, widget } = rig();
    const p = run(widget);
    await tick();
    input.write(`${ESC}${ENTER}`); // the decoder folds this into meta+return — must be dropped
    await tick();
    input.write(ENTER); // a plain Enter still works afterwards
    expect(await p).toEqual({ kind: 'picked', key: 'n' });
  });

  it('non-TTY: the widget reports unavailable and touches nothing', async () => {
    const { widget, chrome } = rig({ isTTY: false });
    expect(await run(widget)).toEqual({ kind: 'unavailable' });
    expect(chrome()).toBe('');
  });

  it('a second concurrent capture is refused (exclusivity)', async () => {
    const { input, io, widget } = rig();
    const p = run(widget);
    await tick();
    expect(io.captureKeys(() => {})).toBeNull();
    input.write(ENTER);
    await p;
  });
});

describe('select widget: readline handoff', () => {
  it('a half-typed mid-turn line is drained into the VISIBLE typed buffer — never split (S22 review)', async () => {
    // The hazard: mid-turn typing is unechoed; a select engaging mid-line used to freeze the
    // prefix invisibly in readline and hand only the suffix to the menu, where a fragment like
    // 'sts for the parser' answers a security prompt by its first character. Drained, the WHOLE
    // line is the typed buffer — visible, editable, submitted as one string.
    const { input, io, widget } = rig();
    input.write('add te'); // in flight when the menu engages
    await tick();
    const p = run(widget);
    await tick();
    input.write(`sts${ENTER}`); // the continuation lands in the menu
    expect(await p).toEqual({ kind: 'typed', text: 'add tests' });
    // Nothing stranded in readline: the next line round-trips clean.
    const line = io.prompt('> ');
    await tick();
    input.write(`hello${ENTER}`);
    expect(await line).toEqual({ kind: 'line', text: 'hello' });
  });

  it('after a select resolves, the ordinary line path works again (reattach round-trip)', async () => {
    const { input, io, widget } = rig();
    const p = run(widget);
    await tick();
    input.write(ENTER);
    await p;
    const linePromise = io.prompt('> ');
    await tick();
    input.write(`hello${ENTER}`);
    expect(await linePromise).toEqual({ kind: 'line', text: 'hello' });
  });

  it('keys typed before the select engaged stay out of it (no type-ahead consumption)', async () => {
    const { input, io, widget } = rig();
    input.write(`queued line${ENTER}`); // lands in type-ahead before any select exists
    await tick();
    const p = run(widget);
    await tick();
    input.write(ENTER);
    expect(await p).toEqual({ kind: 'picked', key: 'n' }); // the queued line did not answer it
    expect(await io.prompt('> ')).toEqual({ kind: 'line', text: 'queued line' }); // still queued
  });
});

describe('select widget: overlay rendering', () => {
  it('the highlighted row carries the accent paint; stripped output shows pointer and rows', async () => {
    const { input, widget, chrome } = rig({ colors: true });
    const p = run(widget);
    await tick();
    const plain = stripAnsi(chrome());
    expect(plain).toContain('❯ [n] not now');
    expect(plain).toContain('  [y] approve');
    expect(chrome()).toContain(`${ESC}[7m`); // the accent open on the highlight
    input.write(ENTER);
    await p;
  });

  it('with NO_STYLE the overlay emits the menu without paint', async () => {
    const { input, widget, chrome } = rig();
    const p = run(widget);
    await tick();
    expect(chrome()).toContain('[y] approve');
    expect(chrome()).not.toContain(`${ESC}[7m`);
    input.write(ENTER);
    await p;
  });
});
