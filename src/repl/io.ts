import readline from 'node:readline';
import { Writable } from 'node:stream';
import { sanitizeLine } from '../shared/text.js';

/**
 * The REPL's terminal seam: ONE persistent readline owns stdin for the whole session — the idle
 * prompt and every approval question funnel through it, so two interfaces can never fight over
 * the stream.
 *
 * Windows notes that shaped this design:
 * - With `terminal: true` stdin is in raw mode; Ctrl+C arrives as readline's 'SIGINT' event (no
 *   process signal), and Ctrl+D on an empty line is the EOF chord (Ctrl+Z+Enter only applies to
 *   cooked/piped input).
 * - Type-ahead during a running turn would be echoed by readline into the middle of streamed
 *   output, so the readline OUTPUT is muted while a turn runs (input keeps flowing — muting
 *   input would also kill the 'SIGINT' channel). Typed-ahead lines are buffered and consumed by
 *   the next prompt/question.
 * - With piped stdio (`--interactive` driving) there is no raw mode: prompts are written
 *   manually, 'SIGINT' never fires, and stream end resolves any pending read as EOF.
 */

export type ReplLine = { kind: 'line'; text: string } | { kind: 'eof' } | { kind: 'interrupt' };

/** One decoded keypress, as delivered to a captureKeys handler (S22). */
export interface KeyEvent {
  seq: string;
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface ReplIO {
  /** Idle prompt. One pending read at a time. Consumes typed-ahead lines. */
  prompt(promptText: string): Promise<ReplLine>;
  /**
   * Approval question through the same readline. Resolves null on EOF (caller must fail safe)
   * and on Ctrl+C (the registered interrupt handler fires first, so the caller sees an abort).
   * On a TTY this NEVER consumes typed-ahead lines: a line typed before the question existed
   * (the user's next instruction, buffered during a running turn) is not an answer to a
   * security prompt the user never saw — it stays queued for the next idle prompt, and only a
   * line typed after the question is displayed can answer it. Piped input keeps queue semantics
   * so scripted drivers can pre-supply answers.
   */
  question(q: string): Promise<string | null>;
  /** Register the Ctrl+C handler for the duration of a turn; returns an unsubscriber. */
  onInterrupt(handler: () => void): () => void;
  /**
   * Session 11 — mid-turn command interception, TTY ONLY. While a handler is set and NO read is
   * pending, a typed `/`-prefixed line is offered to the handler; a true return consumes it,
   * false falls back to the type-ahead buffer exactly as before. Never active on piped input
   * (scripted drivers pre-supply future lines — interception would consume them
   * nondeterministically), and never while a prompt/question is displayed (`pending` set ⇒ the
   * line answers it — the existing approval-safety pins hold by construction).
   */
  setMidTurnHandler(handler: ((line: string) => boolean) | null): void;
  /**
   * S22 — exclusive raw-key routing for the select widget. TTY only. Detaches readline's OWN
   * keypress processing (arrow-history recall, echo, 'line' assembly) for the capture's
   * lifetime, so no key can reach the line path: type-ahead, the mid-turn handler and the
   * pending-read slot are structurally inert while a capture is active — "a displayed prompt
   * always wins", by construction. Returns the idempotent release plus `drained`: the
   * half-typed line readline was holding at engage (echo is muted mid-turn, so it was
   * INVISIBLE), which the widget must surface as its typed buffer — leaving it split would
   * strand the prefix in readline and hand the suffix to the menu, where a fragment like
   * 'sts for the parser' answers a security prompt by its first character (the review
   * finding). Null when unavailable (non-TTY, a capture already active, or readline's
   * internals changed shape) — the caller falls back to the line-question path unchanged.
   * Ctrl+C fires the registered interrupt handler BEFORE the key is delivered (the 'SIGINT'
   * ordering contract); stream close delivers a synthetic name:'eof' key so a mid-capture EOF
   * can never hang.
   */
  captureKeys(handler: (k: KeyEvent) => void): { release: () => void; drained: string } | null;
  /** Suppress readline echo while a turn is running (input keeps flowing). */
  mute(): void;
  unmute(): void;
  close(): void;
}

class Gate extends Writable {
  muted = false;
  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!this.muted) this.target.write(chunk);
    cb();
  }
  /** Readline uses output.columns/rows for line-wrap redraw; pass the real terminal's through. */
  get columns(): number | undefined {
    return (this.target as Partial<NodeJS.WriteStream>).columns;
  }
  get rows(): number | undefined {
    return (this.target as Partial<NodeJS.WriteStream>).rows;
  }
}

export interface ReplIOOptions {
  input: NodeJS.ReadableStream;
  /** Chrome stream (prompts, echo). The REPL binds this to stderr; stdout stays model-text-only. */
  output: NodeJS.WritableStream;
  isTTY: boolean;
  /** S22 — readline Tab completion (slash commands). Only ever invoked with terminal: true, so
   *  piped input is untouched by construction. */
  completer?: (line: string) => [string[], string];
}

export function createReplIO(opts: ReplIOOptions): ReplIO {
  const gate = new Gate(opts.output);
  const emitter = opts.input as NodeJS.EventEmitter;
  // S22: snapshot the input's 'keypress' listeners around construction. With terminal:true,
  // readline installs exactly ONE keypress listener on the input stream; the diff identifies
  // it so captureKeys can detach it for a select's lifetime. If a Node upgrade changes that
  // shape, rlKeypress is undefined and captureKeys degrades to null — the widget falls back
  // to the line grammar rather than fighting an unknown readline.
  const keypressBefore = opts.isTTY ? emitter.listeners('keypress') : [];
  const rl = readline.createInterface({
    input: opts.input,
    output: gate,
    terminal: opts.isTTY,
    historySize: opts.isTTY ? 100 : 0,
    ...(opts.completer !== undefined ? { completer: opts.completer } : {}),
  });
  const rlKeypress = opts.isTTY
    ? emitter.listeners('keypress').find((l) => !keypressBefore.includes(l))
    : undefined;

  let closed = false;
  const typedAhead: string[] = [];
  let pending: ((r: ReplLine) => void) | undefined;
  /** What the pending read IS (S22): the Ctrl+E chord fires only at the idle PROMPT — resolving
   *  a security QUESTION with '/expand' would parse as a deny, surprising the user. */
  let pendingKind: 'prompt' | 'question' | undefined;
  let interruptHandler: (() => void) | undefined;
  let midTurnHandler: ((line: string) => boolean) | null = null;
  let keyCapture: ((k: KeyEvent) => void) | null = null;

  const settle = (r: ReplLine): void => {
    const p = pending;
    pending = undefined;
    pendingKind = undefined;
    p?.(r);
  };

  // S22 — Ctrl+E at the idle prompt expands the last folded output. This listener OBSERVES the
  // keypress stream (readline stays attached; a capture detaches readline but not this — the
  // pendingKind guard keeps it inert during selects and questions alike). Readline's own Ctrl+E
  // is end-of-line, a no-op on an empty buffer, so the chord claims exactly the state where the
  // binding does nothing; mid-edit the readline binding wins untouched.
  if (opts.isTTY) {
    emitter.on('keypress', (_seq: unknown, key: unknown) => {
      const k = (key ?? {}) as { name?: string; ctrl?: boolean; meta?: boolean };
      if (
        k.ctrl === true &&
        k.meta !== true &&
        k.name === 'e' &&
        pendingKind === 'prompt' &&
        (rl as unknown as { line?: string }).line === ''
      ) {
        opts.output.write('/expand\n'); // echo, so the transcript shows what happened
        settle({ kind: 'line', text: '/expand' });
      }
    });
  }

  rl.on('line', (text) => {
    if (pending) settle({ kind: 'line', text });
    else if (midTurnHandler !== null && opts.isTTY && text.trimStart().startsWith('/')) {
      // Mid-turn command (Session 11): offered to the handler; unhandled lines buffer as before.
      let consumed = false;
      try {
        consumed = midTurnHandler(text.trim());
      } catch {
        consumed = false; // a throwing handler must never eat input
      }
      if (!consumed) typedAhead.push(text);
    } else typedAhead.push(text);
  });
  rl.on('close', () => {
    closed = true;
    settle({ kind: 'eof' });
    // A capture must learn about stream end too — without this, a select whose input dies
    // mid-menu would wait on keys that can never arrive.
    keyCapture?.({ seq: '', name: 'eof', ctrl: false, meta: false, shift: false });
  });
  rl.on('SIGINT', () => {
    // Order matters: fire the turn-abort first, then unblock whoever is waiting on a read.
    interruptHandler?.();
    settle({ kind: 'interrupt' });
  });

  async function ask(promptText: string, o: { fresh?: boolean } = {}): Promise<ReplLine> {
    // `fresh` (TTY approvals): never satisfy a security prompt with a line typed before the
    // prompt existed; leave the queue for the next idle prompt and wait for a NEW line.
    const useQueue = !(o.fresh && opts.isTTY);
    let r: ReplLine;
    if (useQueue && typedAhead.length > 0) {
      r = { kind: 'line', text: typedAhead.shift()! };
      // Echo the consumed line after the prompt: piped transcripts need the dialogue, and a
      // TTY user must SEE which buffered line is now being executed (it was typed unechoed).
      opts.output.write(promptText + sanitizeLine(r.text) + '\n');
      return r;
    }
    if (closed) return { kind: 'eof' };
    {
      const wasMuted = gate.muted;
      gate.muted = false;
      // Resolver BEFORE prompt bytes (S22). A PassThrough delivers 'data' synchronously, so a
      // driver whose chrome listener answers the instant the prompt appears re-enters readline
      // INSIDE rl.prompt() — before the old post-write install ran — and the answer landed in
      // typedAhead, where a `fresh` question never looks: the REPL waited forever. Installing
      // the resolver first makes that window zero by construction. (Reactive drivers keep their
      // small answer delays: they may also react to HEADER chrome printed before ask() runs.)
      const settled = new Promise<ReplLine>((resolve) => {
        pending = resolve;
        pendingKind = o.fresh === true ? 'question' : 'prompt';
      });
      if (opts.isTTY) {
        rl.setPrompt(promptText);
        rl.prompt();
      } else {
        opts.output.write(promptText);
      }
      try {
        r = await settled;
      } finally {
        gate.muted = wasMuted;
      }
    }
    // Piped input is never echoed by readline; echo accepted lines into the chrome stream so a
    // captured transcript shows the dialogue ("> instruction"), not just prompts merging into
    // the next status line.
    if (!opts.isTTY && r.kind === 'line') opts.output.write(sanitizeLine(r.text) + '\n');
    return r;
  }

  return {
    prompt: (p) => ask(p),
    async question(q) {
      const r = await ask(q, { fresh: true });
      return r.kind === 'line' ? r.text : null;
    },
    onInterrupt(handler) {
      interruptHandler = handler;
      return () => {
        if (interruptHandler === handler) interruptHandler = undefined;
      };
    },
    setMidTurnHandler(handler) {
      midTurnHandler = handler;
    },
    captureKeys(handler) {
      if (!opts.isTTY || rlKeypress === undefined || keyCapture !== null || closed) return null;
      const deliver = (ev: KeyEvent): void => {
        try {
          handler(ev);
        } catch {
          /* a throwing handler must never break the stream */
        }
      };
      const wrapped = (seq: unknown, key: unknown): void => {
        const k = (key ?? {}) as { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };
        const ev: KeyEvent = {
          seq: typeof seq === 'string' ? seq : '',
          ...(k.name !== undefined ? { name: k.name } : {}),
          ctrl: k.ctrl === true,
          meta: k.meta === true,
          shift: k.shift === true,
        };
        // Ctrl+C ordering, identical to the 'SIGINT' path above: the turn-abort fires before
        // the waiter — here, the select widget — learns anything.
        if (ev.ctrl && ev.name === 'c') interruptHandler?.();
        deliver(ev);
      };
      emitter.removeListener('keypress', rlKeypress as (...args: unknown[]) => void);
      emitter.on('keypress', wrapped);
      keyCapture = deliver;
      // Drain the half-typed line readline was holding (typed unechoed mid-turn): the widget
      // shows it as its typed buffer, so in-flight input is never split across the two
      // surfaces — the whole line stays visible and submits as one string, exactly what the
      // pre-S22 line path did. The write into readline's internals is deliberate and single-
      // site: leaving the prefix would prepend it invisibly to the user's next instruction.
      const rlAny = rl as unknown as { line?: string; cursor?: number };
      const drained = typeof rlAny.line === 'string' ? rlAny.line : '';
      if (drained.length > 0) {
        rlAny.line = '';
        rlAny.cursor = 0;
      }
      let released = false;
      return {
        drained,
        release: () => {
          if (released) return;
          released = true;
          emitter.removeListener('keypress', wrapped);
          emitter.on('keypress', rlKeypress as (...args: unknown[]) => void);
          keyCapture = null;
        },
      };
    },
    mute() {
      gate.muted = true;
    },
    unmute() {
      gate.muted = false;
    },
    close() {
      rl.close();
    },
  };
}
