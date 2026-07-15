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

export interface ReplIO {
  /** Idle prompt. One pending read at a time. */
  prompt(promptText: string): Promise<ReplLine>;
  /**
   * Approval question through the same readline. Resolves null on EOF (caller must fail safe)
   * and on Ctrl+C (the registered interrupt handler fires first, so the caller sees an abort).
   */
  question(q: string): Promise<string | null>;
  /** Register the Ctrl+C handler for the duration of a turn; returns an unsubscriber. */
  onInterrupt(handler: () => void): () => void;
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
}

export interface ReplIOOptions {
  input: NodeJS.ReadableStream;
  /** Chrome stream (prompts, echo). The REPL binds this to stderr; stdout stays model-text-only. */
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

export function createReplIO(opts: ReplIOOptions): ReplIO {
  const gate = new Gate(opts.output);
  const rl = readline.createInterface({
    input: opts.input,
    output: gate,
    terminal: opts.isTTY,
    historySize: opts.isTTY ? 100 : 0,
  });

  let closed = false;
  const typedAhead: string[] = [];
  let pending: ((r: ReplLine) => void) | undefined;
  let interruptHandler: (() => void) | undefined;

  const settle = (r: ReplLine): void => {
    const p = pending;
    pending = undefined;
    p?.(r);
  };

  rl.on('line', (text) => {
    if (pending) settle({ kind: 'line', text });
    else typedAhead.push(text);
  });
  rl.on('close', () => {
    closed = true;
    settle({ kind: 'eof' });
  });
  rl.on('SIGINT', () => {
    // Order matters: fire the turn-abort first, then unblock whoever is waiting on a read.
    interruptHandler?.();
    settle({ kind: 'interrupt' });
  });

  async function ask(promptText: string): Promise<ReplLine> {
    let r: ReplLine;
    if (typedAhead.length > 0) {
      r = { kind: 'line', text: typedAhead.shift()! };
      if (!opts.isTTY) opts.output.write(promptText);
    } else if (closed) {
      return { kind: 'eof' };
    } else {
      const wasMuted = gate.muted;
      gate.muted = false;
      if (opts.isTTY) {
        rl.setPrompt(promptText);
        rl.prompt();
      } else {
        opts.output.write(promptText);
      }
      try {
        r = await new Promise<ReplLine>((resolve) => {
          pending = resolve;
        });
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
      const r = await ask(q);
      return r.kind === 'line' ? r.text : null;
    },
    onInterrupt(handler) {
      interruptHandler = handler;
      return () => {
        if (interruptHandler === handler) interruptHandler = undefined;
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
