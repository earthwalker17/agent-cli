import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createReplIO } from '../src/repl/io.js';

/**
 * Mid-turn command interception (Session 11): TTY-only, never while a read is pending, only
 * `/`-prefixed lines, and a false/throwing handler falls back to the exact pre-Session-11
 * type-ahead behavior. The three V0.2 io pins (fresh-TTY approvals, piped queue semantics,
 * Ctrl+C ordering) keep running unmodified in repl.test.ts — this file pins the NEW seam.
 */

function makeIo(isTTY: boolean): { io: ReturnType<typeof createReplIO>; input: PassThrough; chrome: () => string } {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const output = new PassThrough();
  output.on('data', (c: Buffer) => chunks.push(c));
  const io = createReplIO({ input, output, isTTY });
  return { io, input, chrome: () => Buffer.concat(chunks).toString('utf8') };
}

const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 10));

describe('mid-turn interception (TTY)', () => {
  it('consumes a handled /-line; unhandled and non-slash lines buffer as type-ahead', async () => {
    const { io, input } = makeIo(true);
    const seen: string[] = [];
    io.setMidTurnHandler((line) => {
      seen.push(line);
      return line === '/tasks';
    });

    input.write('/tasks\n'); // handled → consumed
    input.write('/unknown\n'); // offered, false → buffered
    input.write('next instruction\n'); // not slash → never offered
    await tick();
    expect(seen).toEqual(['/tasks', '/unknown']);

    io.setMidTurnHandler(null);
    const first = await io.prompt('> ');
    const second = await io.prompt('> ');
    expect(first).toEqual({ kind: 'line', text: '/unknown' });
    expect(second).toEqual({ kind: 'line', text: 'next instruction' });
    io.close();
  });

  it('NEVER intercepts while a question is pending: the typed line answers the approval', async () => {
    const { io, input } = makeIo(true);
    let offered = 0;
    io.setMidTurnHandler(() => {
      offered++;
      return true;
    });
    const answer = io.question('approve? ');
    await tick(); // the question is displayed → pending is set
    input.write('/cancel t1\n'); // the user is answering the DISPLAYED prompt, not commanding
    expect(await answer).toBe('/cancel t1');
    expect(offered).toBe(0);
    io.close();
  });

  it('a throwing handler never eats input', async () => {
    const { io, input } = makeIo(true);
    io.setMidTurnHandler(() => {
      throw new Error('boom');
    });
    input.write('/tasks\n');
    await tick();
    io.setMidTurnHandler(null);
    expect(await io.prompt('> ')).toEqual({ kind: 'line', text: '/tasks' });
    io.close();
  });
});

describe('mid-turn interception is disabled on piped input (driver determinism)', () => {
  it('a /-line with a handler set still buffers — scripted drivers pre-supply future lines', async () => {
    const { io, input } = makeIo(false);
    let offered = 0;
    io.setMidTurnHandler(() => {
      offered++;
      return true;
    });
    input.write('/plan approve\n'); // a driver's FUTURE command — must not be consumed mid-turn
    await tick();
    expect(offered).toBe(0);
    io.setMidTurnHandler(null);
    expect(await io.prompt('> ')).toEqual({ kind: 'line', text: '/plan approve' });
    io.close();
  });
});
