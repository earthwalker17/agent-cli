import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorkingHeartbeat } from '../src/repl/heartbeat.js';
import { createStatusArea } from '../src/repl/status.js';
import { startSession, runTurn, endSession } from '../src/runtime/session.js';
import { MockProvider } from '../src/provider/mock.js';
import { TOOLS } from '../src/tools/index.js';
import { resolveLayout } from '../src/store/layout.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The "working" heartbeat (S16.5b): a dim `· model working (Ns)` line while a model request is
 * in flight and no text has streamed — an always-thinking model (kimi-k3) otherwise looks
 * frozen between tool steps. The invariants pinned here:
 *
 * - nothing is drawn before the grace period (fast responses never flash it);
 * - the FIRST text delta erases it synchronously and suppresses redraws for the step;
 * - a settled request erases it; the next request starts a fresh cycle;
 * - off-TTY the whole feature emits ZERO bytes (piped transcripts stay byte-identical);
 * - runTurn reports the request lifecycle around EVERY provider call, false on error too.
 */

interface FakeArea {
  setLines: (lines: readonly string[]) => void;
  clear: () => void;
  drawn: string[][];
  clears: number;
}

function fakeArea(): FakeArea {
  const a: FakeArea = {
    drawn: [],
    clears: 0,
    setLines: (lines) => a.drawn.push([...lines]),
    clear: () => a.clears++,
  };
  return a;
}

const dimStyle = { dim: (s: string) => `DIM(${s})` };

describe('createWorkingHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays invisible through the grace period, then ticks with elapsed seconds', () => {
    const area = fakeArea();
    const hb = createWorkingHeartbeat({ area, style: dimStyle, graceMs: 2_000, tickMs: 1_000 });
    hb.modelCallStarted();
    vi.advanceTimersByTime(1_999);
    expect(area.drawn).toEqual([]); // a fast response never flashes the line
    vi.advanceTimersByTime(1);
    expect(area.drawn).toEqual([['DIM(· model working (2s))']]);
    vi.advanceTimersByTime(2_000);
    expect(area.drawn[area.drawn.length - 1]).toEqual(['DIM(· model working (4s))']);
    hb.modelCallEnded();
    expect(area.clears).toBe(1);
  });

  it('the first text delta erases it and suppresses every later redraw of the step', () => {
    const area = fakeArea();
    const hb = createWorkingHeartbeat({ area, style: dimStyle, graceMs: 100, tickMs: 50 });
    hb.modelCallStarted();
    vi.advanceTimersByTime(200);
    expect(area.drawn.length).toBeGreaterThan(0);
    const drawnBefore = area.drawn.length;
    hb.textArrived();
    expect(area.clears).toBe(1);
    vi.advanceTimersByTime(5_000); // streaming continues — no redraw may land on it
    expect(area.drawn.length).toBe(drawnBefore);
    // …and the NEXT request starts a fresh cycle.
    hb.modelCallStarted();
    vi.advanceTimersByTime(200);
    expect(area.drawn.length).toBeGreaterThan(drawnBefore);
  });

  it('a call that never streamed (tool-only step) is erased when the request settles', () => {
    const area = fakeArea();
    const hb = createWorkingHeartbeat({ area, style: dimStyle, graceMs: 100, tickMs: 50 });
    hb.modelCallStarted();
    vi.advanceTimersByTime(300);
    hb.modelCallEnded();
    expect(area.clears).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(area.clears).toBe(1); // idempotent — nothing left ticking
  });

  it('off-TTY the whole feature emits ZERO bytes', () => {
    let bytes = '';
    const out = { write: (c: string) => ((bytes += c), true) } as unknown as NodeJS.WritableStream;
    const area = createStatusArea({ chromeOut: out, isTTY: false });
    const hb = createWorkingHeartbeat({ area, style: dimStyle, graceMs: 10, tickMs: 5 });
    hb.modelCallStarted();
    vi.advanceTimersByTime(1_000);
    hb.textArrived();
    hb.modelCallEnded();
    expect(bytes).toBe(''); // piped transcripts stay byte-identical
  });
});

describe('runTurn reports the model-request lifecycle', () => {
  it('true before each provider call, false after — including on a thrown provider error', async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-hb-')));
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws);
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
    const seen: boolean[] = [];
    const mk = (provider: MockProvider) =>
      startSession({
        workspaceRoot: ws,
        layout,
        model: 'mock-model',
        mode: 'interactive',
        provider,
        approver: async () => ({ decision: 'deny', scope: 'once', source: 'user' }),
        tools: TOOLS,
        saltHex: 'ab'.repeat(16),
        onModelRequest: (inFlight) => seen.push(inFlight),
      });

    // Two-step turn (one tool call, then a final say): two request cycles.
    const s1 = mk(
      new MockProvider([
        { calls: [{ name: 'list_files', input: { path: '.' } }] },
        { say: 'done' },
      ]),
    );
    await runTurn(s1, 'go');
    endSession(s1, 'completed');
    expect(seen).toEqual([true, false, true, false]);

    // A provider that throws still reports false (the finally path).
    seen.length = 0;
    const boom = new MockProvider([]);
    const s2 = mk(boom); // an exhausted script throws on the first call
    await expect(runTurn(s2, 'go')).rejects.toThrow();
    endSession(s2, 'error');
    expect(seen).toEqual([true, false]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
