import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createStatusArea } from '../src/repl/status.js';
import { createTaskTable } from '../src/repl/live-tasks.js';
import { TASKS_PER_SESSION } from '../src/runtime/subagent.js';

/**
 * The sticky status area (Session 11): exact escape-byte behavior on a (fake) TTY — the
 * deliberate TTY-simulation seam, since piped drivers can never exercise cursor movement —
 * and the hard guarantee that non-TTY output carries ZERO escape bytes.
 */

const ESC = String.fromCharCode(27); // the escape byte, kept out of source literals

function fakeTty(columns = 80): { out: PassThrough & { columns?: number }; bytes: () => string } {
  const chunks: Buffer[] = [];
  const out = new PassThrough() as PassThrough & { columns?: number };
  out.columns = columns;
  out.on('data', (c: Buffer) => chunks.push(c));
  return { out, bytes: () => Buffer.concat(chunks).toString('utf8') };
}

describe('status area on a TTY', () => {
  it('draws on setLines, then erases/redraws around every newline-terminated chrome write', () => {
    const { out, bytes } = fakeTty();
    const area = createStatusArea({ chromeOut: out, isTTY: true });

    area.setLines(['line-one', 'line-two']);
    expect(bytes()).toBe('line-one\nline-two\n'); // first draw: no erase needed

    area.write('chrome A\n');
    // Erase the 2-line region (up 2, clear to end), write the chrome, redraw the region.
    expect(bytes()).toBe(`line-one\nline-two\n${ESC}[2A${ESC}[0J` + 'chrome A\n' + 'line-one\nline-two\n');
  });

  it('defers the redraw while a chrome line is half-open, and catches up at the newline', () => {
    const { out, bytes } = fakeTty();
    const area = createStatusArea({ chromeOut: out, isTTY: true });
    area.setLines(['status']);
    area.write('partial tool line ');
    // Erased, chrome written, NO redraw injected into the open line.
    expect(bytes()).toBe(`status\n${ESC}[1A${ESC}[0J` + 'partial tool line ');
    area.write('done\n');
    expect(bytes().endsWith('done\nstatus\n')).toBe(true);
  });

  it('suspend erases and blocks redraws (approval prompts own the screen); resume restores', () => {
    const { out, bytes } = fakeTty();
    const area = createStatusArea({ chromeOut: out, isTTY: true });
    area.setLines(['status']);
    area.suspend();
    expect(bytes().endsWith(`${ESC}[1A${ESC}[0J`)).toBe(true);
    const before = bytes();
    area.setLines(['newer']); // stored, not drawn
    area.write('prompt-adjacent chrome\n');
    expect(bytes()).toBe(before + 'prompt-adjacent chrome\n'); // no escapes while suspended
    area.resume();
    expect(bytes().endsWith('newer\n')).toBe(true);
  });

  it('clear erases and forgets; clipping respects the terminal width; content cannot move the cursor', () => {
    const { out, bytes } = fakeTty(20);
    const area = createStatusArea({ chromeOut: out, isTTY: true });
    area.setLines([`wide-${'x'.repeat(50)}`, `evil-${ESC}[2J-content\rmore`]);
    const drawn = bytes();
    // Clipped to columns-1 with an ellipsis; the region's own escapes are the ONLY raw ESC
    // bytes — content ESC/\r arrived sanitized as visible escapes, not control bytes.
    const lines = drawn.split('\n').filter((l) => l !== '');
    expect(lines[0]!.length).toBeLessThanOrEqual(19);
    expect(lines[0]!.endsWith('…')).toBe(true);
    expect(drawn.includes(`evil-${ESC}`)).toBe(false);
    area.clear();
    const afterClear = bytes();
    area.write('plain\n');
    expect(bytes()).toBe(afterClear + 'plain\n'); // nothing redraws after clear
  });

  it('the empty region never emits erase sequences', () => {
    const { out, bytes } = fakeTty();
    const area = createStatusArea({ chromeOut: out, isTTY: true });
    area.write('one\n');
    area.write('two\n');
    area.clear();
    area.suspend();
    area.resume();
    expect(bytes()).toBe('one\ntwo\n');
  });
});

describe('status area off-TTY: byte-identical pass-through', () => {
  it('emits ZERO escape bytes across every operation', () => {
    const { out, bytes } = fakeTty();
    const area = createStatusArea({ chromeOut: out, isTTY: false });
    area.setLines(['status line']);
    area.write('chrome A\n');
    area.write('partial ');
    area.write('rest\n');
    area.suspend();
    area.resume();
    area.clear();
    expect(bytes()).toBe('chrome A\npartial rest\n');
    expect(bytes().includes(ESC)).toBe(false);
  });
});

describe('the live task table', () => {
  it('tracks phases, tokens, supervision flags; cancel resolves by suffix or plan task id', () => {
    let now = 1_000;
    const table = createTaskTable(() => now);
    const cancelled: string[] = [];
    const unregA = table.registerCancel('child-session-aaaa', () => cancelled.push('a'));
    table.registerCancel('child-session-bbbb', () => cancelled.push('b'));

    table.update({ childSessionId: 'child-session-aaaa', role: 'executor', planTaskId: 't1', phase: 'running' });
    table.update({ childSessionId: 'child-session-bbbb', role: 'explorer', phase: 'running' });
    table.update({ childSessionId: 'child-session-aaaa', phase: 'tool', tool: 'edit_file', steps: 3, outTokens: 1200 });
    table.update({ childSessionId: 'child-session-aaaa', supervision: 'budget-pressure' }); // no phase change
    table.update({ childSessionId: 'child-session-bbbb', phase: 'approval-wait' });

    now = 65_000;
    const lines = table.statusLines({ tasksStarted: 3, childOutputTokens: 40_000, reviewRoundsStarted: 0 });
    expect(lines[0]).toContain('2 agent(s) running');
    expect(lines[0]).toContain(`tasks 3/${String(TASKS_PER_SESSION)}`);
    const a = lines.find((l) => l.includes('aaaa'))!;
    expect(a).toContain('(t1)');
    expect(a).toContain('edit_file');
    expect(a).toContain('s3');
    expect(a).toContain('⚑ budget-pressure');
    expect(a).toContain('1m04s');
    expect(lines.find((l) => l.includes('bbbb'))).toContain('WAITING FOR APPROVAL');

    // The fold overlay: approval-wait maps to awaiting-approval.
    expect(table.livePhases().get('child-session-bbbb')).toBe('awaiting-approval');

    // Cancellation by plan task id and by suffix; ambiguity refuses.
    expect(table.cancel('t1')).toMatchObject({ outcome: 'ok', childSessionId: 'child-session-aaaa' });
    expect(cancelled).toEqual(['a']);
    expect(table.cancel('child-session')).toMatchObject({ outcome: 'not-found' }); // too short to suffix-match
    expect(table.cancel('bbbb')).toMatchObject({ outcome: 'ok' });
    expect(cancelled).toEqual(['a', 'b']);

    // Ended rows leave the live set and the status lines empty out.
    table.update({ childSessionId: 'child-session-aaaa', phase: 'ended', status: 'cancelled' });
    table.update({ childSessionId: 'child-session-bbbb', phase: 'ended', status: 'cancelled' });
    expect(table.live()).toEqual([]);
    expect(table.statusLines()).toEqual([]);
    unregA();
    expect(table.cancel('aaaa')).toMatchObject({ outcome: 'not-found' }); // unregistered
  });
});
