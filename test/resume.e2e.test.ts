import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, endSession, runTurn, resumeSession, reconstruct } from '../src/runtime/session.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { EventLog } from '../src/store/event-log.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import { sha256 } from '../src/shared/hash.js';
import type { SessionEvent } from '../src/types.js';

let tmp: string;
let ws: string;
let layout: ProjectLayout;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-resume-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const salt = '0'.repeat(32);

describe('resumeSession', () => {
  it('reconstructs the conversation and continues to completion', async () => {
    fs.writeFileSync(path.join(ws, 'f.txt'), 'v1');
    // Run half the work, then close the session (simulating a stopped session).
    const s1 = startSession({
      workspaceRoot: ws, layout, model: 'm', mode: 'interactive',
      provider: new MockProvider([{ say: 'read it', calls: [{ name: 'read_file', input: { path: 'f.txt' } }] }, { say: 'paused' }]),
      approver: autoDenyApprover, saltHex: salt, clock: fixedClock(0, 1), idGen: seededIdGen(),
    });
    await runTurn(s1, 'start');
    endSession(s1, 'user-quit');

    // Resume and finish.
    const s2 = resumeSession({
      workspaceRoot: ws, layout, model: 'm', mode: 'interactive',
      provider: new MockProvider([{ say: 'finished' }]),
      approver: autoDenyApprover, saltHex: salt, clock: fixedClock(1000, 1), sessionId: s1.id,
    });
    // The rebuilt conversation includes the prior user + assistant + tool_result turns.
    expect(s2.messages.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(s2.messages)).toContain('read it');
    const result = await runTurn(s2, 'continue');
    endSession(s2, 'completed');
    expect(result.finalText).toBe('finished');

    const events = EventLog.readLenient(layout.sessionFile(s1.id)).events;
    expect(events.some((e) => e.type === 'session.resumed')).toBe(true);
  });

  it('holds a lock file while open and releases it on end (cross-process refuse: see store.test)', async () => {
    const s1 = startSession({
      workspaceRoot: ws, layout, model: 'm', mode: 'interactive',
      provider: new MockProvider([{ say: 'hi' }]), approver: autoDenyApprover,
      saltHex: salt, clock: fixedClock(0, 1), idGen: seededIdGen(),
    });
    await runTurn(s1, 'x');
    expect(fs.existsSync(layout.lockFile(s1.id))).toBe(true);
    endSession(s1, 'completed');
    expect(fs.existsSync(layout.lockFile(s1.id))).toBe(false);
  });
});

describe('reconstruct crash reconciliation', () => {
  const base = (): SessionEvent[] => [
    { v: 1, seq: 1, ts: 't', type: 'user.message', text: 'edit the file' },
    {
      v: 1, seq: 2, ts: 't', type: 'assistant.message', text: 'editing',
      toolCalls: [{ id: 'c1', name: 'edit_file', input: { path: 'f.txt', old_string: 'a', new_string: 'b' } }],
      stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 },
    },
    { v: 1, seq: 3, ts: 't', type: 'tool.requested', callId: 'c1', tool: 'edit_file', input: {} },
  ];

  it('treats a completed edit whose tool.completed was lost as APPLIED (postHash matches disk)', () => {
    const f = path.join(ws, 'f.txt');
    fs.writeFileSync(f, 'b'); // the edit really did land on disk
    const events: SessionEvent[] = [
      ...base(),
      { v: 1, seq: 4, ts: 't', type: 'file.mutated', callId: 'c1', path: f, kind: 'modify', beforeSha256: sha256('a'), afterSha256: sha256('b'), createdDirs: [] },
      // tool.completed intentionally missing (truncated tail)
    ];
    const r = reconstruct(events, ws);
    expect(r.orphanedCallIds).toEqual([]);
    expect(JSON.stringify(r.messages)).toContain('recovered after an interruption');
  });

  it('flags an unverifiable post-state when disk does not match the recorded postHash', () => {
    const f = path.join(ws, 'f.txt');
    fs.writeFileSync(f, 'something else');
    const events: SessionEvent[] = [
      ...base(),
      { v: 1, seq: 4, ts: 't', type: 'file.mutated', callId: 'c1', path: f, kind: 'modify', beforeSha256: sha256('a'), afterSha256: sha256('b'), createdDirs: [] },
    ];
    const r = reconstruct(events, ws);
    expect(r.unknownPostStateCallIds).toContain('c1');
  });

  it('flags a true orphan (crash before any snapshot/mutation)', () => {
    const r = reconstruct(base(), ws);
    expect(r.orphanedCallIds).toContain('c1');
    expect(JSON.stringify(r.messages)).toContain('interrupted by session crash');
  });

  it('uses the recorded tool.completed verbatim when present (faithful replay)', () => {
    const events: SessionEvent[] = [
      ...base(),
      { v: 1, seq: 4, ts: 't', type: 'tool.completed', callId: 'c1', ok: true, outputPreview: 'edited f.txt (1 replacement)', durationMs: 5, truncated: false },
    ];
    const r = reconstruct(events, ws);
    expect(JSON.stringify(r.messages)).toContain('edited f.txt (1 replacement)');
  });
});
