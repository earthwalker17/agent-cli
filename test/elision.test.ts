import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { elideHistory } from '../src/runtime/elision.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, endSession, runTurn } from '../src/runtime/session.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ChatMessage, Provider, ProviderRequest } from '../src/types.js';

/**
 * Stage-4 tests. The elision boundary is a pure function of the RAW history — these tests pin
 * the properties the design leans on: determinism, API-valid pairing, tail protection, and
 * monotone (only-advancing) elision across a growing history.
 */

/** One agent step: assistant tool_use + user tool_result of `outChars` chars. */
function step(n: number, outChars: number): ChatMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: `call-${n}`, name: 'read_file', input: { path: `f${n}` } }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: `call-${n}`, content: 'x'.repeat(outChars) }] },
  ];
}

function history(steps: number, outChars: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'task' }] }];
  for (let i = 0; i < steps; i++) msgs.push(...step(i, outChars));
  return msgs;
}

const OPTS = { triggerChars: 50_000, targetChars: 25_000, keepLastSteps: 4 };

describe('elideHistory', () => {
  it('below the trigger: identity (no elision, no marker)', () => {
    const msgs = history(3, 1000);
    const r = elideHistory(msgs, OPTS);
    expect(r.elidedCallIds).toEqual([]);
    expect(r.messages).toEqual(msgs);
    expect(r.sentChars).toBe(r.rawChars);
    expect(r.exhausted).toBe(false);
  });

  it('over the trigger: elides oldest tool_results down to the target, never the protected tail', () => {
    const msgs = history(12, 5000); // raw ≈ 60k > trigger
    const r = elideHistory(msgs, OPTS);
    expect(r.elidedCallIds.length).toBeGreaterThan(0);
    expect(r.sentChars).toBeLessThanOrEqual(OPTS.targetChars);
    // Oldest first…
    expect(r.elidedCallIds[0]).toBe('call-0');
    // …and the last 4 assistant steps' results are verbatim.
    for (const id of ['call-8', 'call-9', 'call-10', 'call-11']) {
      expect(r.elidedCallIds).not.toContain(id);
    }
    // The original history is untouched (pure).
    expect(msgs[2]!.content[0]).toMatchObject({ content: 'x'.repeat(5000) });
  });

  it('preserves tool_use/tool_result pairing and the isError flag', () => {
    const msgs = history(10, 5000);
    // Make one old result an error result.
    const errBlock = msgs[4]!.content[0]!;
    if (errBlock.type === 'tool_result') msgs[4]!.content[0] = { ...errBlock, isError: true };
    const r = elideHistory(msgs, OPTS);
    const uses = new Set<string>();
    const results = new Map<string, { content: string; isError?: boolean }>();
    for (const m of r.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.add(b.id);
        if (b.type === 'tool_result') results.set(b.toolUseId, b);
      }
    }
    for (const id of uses) expect(results.has(id), `result for ${id}`).toBe(true);
    const elidedErr = results.get('call-1')!;
    expect(elidedErr.isError).toBe(true);
    expect(elidedErr.content).toContain('[elided to save context');
    expect(elidedErr.content).toContain('5000 chars');
    expect(elidedErr.content).toMatch(/sha256=[0-9a-f]{12}/);
  });

  it('is deterministic and MONOTONE: the elided set only grows as the history grows', () => {
    const full = history(20, 5000);
    let prev = new Set<string>();
    for (let cut = 1; cut <= full.length; cut++) {
      const r1 = elideHistory(full.slice(0, cut), OPTS);
      const r2 = elideHistory(full.slice(0, cut), OPTS);
      expect(r1).toEqual(r2); // deterministic
      const cur = new Set(r1.elidedCallIds);
      for (const id of prev) expect(cur.has(id), `boundary regressed at prefix ${cut}: lost ${id}`).toBe(true);
      prev = cur;
    }
  });

  it('reports exhausted when even full elision cannot reach the target', () => {
    // One huge protected recent step: nothing elidable is enough.
    const msgs = history(5, 40_000);
    const r = elideHistory(msgs, { triggerChars: 50_000, targetChars: 10_000, keepLastSteps: 4 });
    expect(r.exhausted).toBe(true);
    expect(r.sentChars).toBeGreaterThan(10_000);
  });

  it('never elides when everything is inside the protected tail', () => {
    const msgs = history(3, 30_000); // raw 90k > trigger, but only 3 steps and keep=4
    const r = elideHistory(msgs, OPTS);
    expect(r.elidedCallIds).toEqual([]);
    expect(r.exhausted).toBe(true);
  });

  it('skips outputs smaller than the marker (eliding them would grow the prompt)', () => {
    const msgs = history(10, 10); // tiny outputs; raw stays under trigger — force with tiny trigger
    const r = elideHistory(msgs, { triggerChars: 10, targetChars: 5, keepLastSteps: 1 });
    expect(r.elidedCallIds).toEqual([]); // every candidate is smaller than its marker
  });
});

describe('runTurn integration', () => {
  let tmp: string;
  let ws: string;
  let layout: ProjectLayout;
  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-elide-')));
    ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws);
    layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('sends the elided view to the provider, records context.compacted, never mutates session.messages', async () => {
    fs.writeFileSync(path.join(ws, 'big.txt'), 'B'.repeat(3000));
    const captured: ProviderRequest[] = [];
    const inner = new MockProvider([
      { say: 'r1', calls: [{ name: 'read_file', input: { path: 'big.txt' } }] },
      { say: 'r2', calls: [{ name: 'read_file', input: { path: 'big.txt' } }] },
      { say: 'done' },
    ]);
    const capturing: Provider = {
      name: 'capture',
      complete: (req, onText, signal) => {
        captured.push(req);
        return inner.complete(req, onText, signal);
      },
    };
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: capturing,
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
      // keepLastSteps 0 so even the freshest result is elidable; tiny thresholds arm immediately.
      contextBudget: { triggerChars: 2000, targetChars: 100, keepLastSteps: 0 },
    });
    await runTurn(session, 'read the big file twice');
    endSession(session, 'completed');

    // Later requests carry the marker instead of the 3000-char output…
    const lastReq = captured[captured.length - 1]!;
    const wireResults = lastReq.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(wireResults.some((b) => b.type === 'tool_result' && b.content.includes('[elided to save context'))).toBe(true);
    // …the harness's own history keeps the real bytes…
    const ownResults = session.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(ownResults.some((b) => b.type === 'tool_result' && b.content.includes('[elided'))).toBe(false);
    // …and the evidence log recorded the compaction.
    const compactions = session.log.events.filter((e) => e.type === 'context.compacted');
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0]).toMatchObject({ elidedCount: expect.any(Number) });
  });
});
