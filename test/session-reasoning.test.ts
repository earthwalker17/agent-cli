import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, endSession, resumeSession, reconstruct, runTurn, type Session } from '../src/runtime/session.js';
import { MockProvider, parseScript, type ScriptTurn } from '../src/provider/mock.js';
import { elideHistory } from '../src/runtime/elision.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { EventLog } from '../src/store/event-log.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ChatMessage, ContentBlock, SessionEvent } from '../src/types.js';

/**
 * Session 15: the opaque reasoning round-trip core. Reasoning blocks are persisted VERBATIM on
 * assistant.message, replayed by reconstruct at the head of the assistant content, weighed but
 * never replaced by elision, and absent-field old logs rebuild exactly as before.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-reasoning-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeSession(script: ScriptTurn[]): Session {
  return startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode: 'non-interactive',
    provider: new MockProvider(script),
    approver: autoDenyApprover,
    saltHex: '0'.repeat(32),
    maxSteps: 10,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
}

function readLog(session: Session): SessionEvent[] {
  return EventLog.readLenient(layout.sessionFile(session.id)).events;
}

describe('reasoning recording (assistant.message)', () => {
  it('persists reasoning blocks verbatim, in order, tagged provider+model', async () => {
    const s = makeSession([{ reasoning: 'thought-1', say: 'hello' }]);
    await runTurn(s, 'hi');
    const ev = readLog(s).find((e) => e.type === 'assistant.message');
    expect(ev).toBeDefined();
    if (ev?.type !== 'assistant.message') throw new Error('unreachable');
    expect(ev.reasoning).toEqual([{ providerName: 'mock', model: 'mock-model', payload: 'thought-1', text: 'thought-1' }]);
    // The live history carries the block too — head-first, before the text.
    const assistant = s.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content[0]).toMatchObject({ type: 'reasoning', providerName: 'mock', payload: 'thought-1' });
    expect(assistant?.content[1]).toMatchObject({ type: 'text', text: 'hello' });
    endSession(s, 'completed');
  });

  it('omits the reasoning field entirely when the turn produced none', async () => {
    const s = makeSession([{ say: 'plain' }]);
    await runTurn(s, 'hi');
    const ev = readLog(s).find((e) => e.type === 'assistant.message');
    if (ev?.type !== 'assistant.message') throw new Error('unreachable');
    expect('reasoning' in ev).toBe(false);
    endSession(s, 'completed');
  });

  it('records reasoning on tool-looping turns and keeps it in the live history', async () => {
    const s = makeSession([{ reasoning: 'plan the listing', calls: [{ name: 'list_files', input: {} }] }, { say: 'done' }]);
    await runTurn(s, 'list please');
    const events = readLog(s).filter((e) => e.type === 'assistant.message');
    expect(events).toHaveLength(2);
    const first = events[0];
    if (first?.type !== 'assistant.message') throw new Error('unreachable');
    expect(first.reasoning?.[0]?.payload).toBe('plan the listing');
    // The tool-looping assistant message retains its reasoning block ahead of the tool_use.
    const looped = s.messages.find((m) => m.role === 'assistant');
    expect(looped?.content.map((b) => b.type)).toEqual(['reasoning', 'tool_use']);
    endSession(s, 'completed');
  });
});

describe('reasoning replay on resume (reconstruct)', () => {
  it('rebuilds reasoning blocks at the head of the assistant content', async () => {
    const s = makeSession([{ reasoning: 'r-resume', say: 'answer' }]);
    await runTurn(s, 'question');
    endSession(s, 'completed');
    const resumed = resumeSession({
      workspaceRoot: ws,
      layout,
      sessionId: s.id,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: new MockProvider([]),
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      clock: fixedClock(1000, 1),
    });
    const assistant = resumed.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content[0]).toEqual({
      type: 'reasoning',
      providerName: 'mock',
      model: 'mock-model',
      payload: 'r-resume',
      text: 'r-resume',
    });
    expect(assistant?.content[1]).toMatchObject({ type: 'text', text: 'answer' });
    endSession(resumed, 'completed');
  });

  it('OLD LOGS: an assistant.message without the reasoning field rebuilds exactly as before', () => {
    // Synthetic pre-S15 events — the additive field is absent, not empty.
    const events = [
      { v: 1, seq: 1, ts: 't', type: 'user.message', text: 'q' },
      {
        v: 1,
        seq: 2,
        ts: 't',
        type: 'assistant.message',
        text: 'a',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ] as unknown as SessionEvent[];
    const rebuilt = reconstruct(events, ws);
    expect(rebuilt.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
  });
});

describe('elision and reasoning', () => {
  const big = (n: number): string => 'x'.repeat(n);

  it('weighs reasoning payloads into rawChars but NEVER replaces them', () => {
    const reasoning: ContentBlock = { type: 'reasoning', providerName: 'mock', model: 'm', payload: big(5_000) };
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [reasoning, { type: 'tool_use', id: 't1', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: big(8_000) }] },
      // Enough trailing steps that the old tool_result leaves the protected window.
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: [{ type: 'text', text: 'next2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
      { role: 'user', content: [{ type: 'text', text: 'next3' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a4' }] },
      { role: 'user', content: [{ type: 'text', text: 'next4' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a5' }] },
    ];
    const out = elideHistory(messages, { triggerChars: 10_000, targetChars: 2_000, keepLastSteps: 4 });
    // The old tool_result was elided…
    expect(out.elidedCallIds).toContain('t1');
    // …but the reasoning block is byte-identical in the wire view.
    const assistant = out.messages[1]!;
    expect(assistant.content[0]).toEqual(reasoning);
    // And its weight is part of the raw accounting (payload 5000 chars + the rest).
    expect(out.rawChars).toBeGreaterThan(13_000);
  });
});

describe('mock script schema', () => {
  it('parseScript accepts a reasoning turn and still rejects unknown keys', () => {
    const parsed = parseScript(JSON.stringify([{ reasoning: 'r', say: 'ok' }]));
    expect(parsed[0]?.reasoning).toBe('r');
    expect(() => parseScript(JSON.stringify([{ nonsense: true }]))).toThrow();
  });
});
