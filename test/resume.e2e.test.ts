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

  it('never replays an EMPTY error tool_result (the API rejects it — found live in the S13 E2E)', () => {
    // A failing command with no output (findstr with zero matches: exit 1, empty combined
    // capture) records outputPreview ''. Replayed verbatim, the empty is_error block 400s
    // every later request of the resumed conversation.
    const events: SessionEvent[] = [
      ...base(),
      { v: 1, seq: 4, ts: 't', type: 'tool.completed', callId: 'c1', ok: false, outputPreview: '', durationMs: 5, truncated: false },
    ];
    const r = reconstruct(events, ws);
    const block = r.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 'c1');
    expect(block).toBeDefined();
    expect(block!.type === 'tool_result' && block!.isError).toBe(true);
    expect(block!.type === 'tool_result' && typeof block!.content === 'string' && block!.content.length > 0).toBe(true);
  });

  it('uses the recorded tool.completed verbatim when present (faithful replay)', () => {
    const events: SessionEvent[] = [
      ...base(),
      { v: 1, seq: 4, ts: 't', type: 'tool.completed', callId: 'c1', ok: true, outputPreview: 'edited f.txt (1 replacement)', durationMs: 5, truncated: false },
    ];
    const r = reconstruct(events, ws);
    expect(JSON.stringify(r.messages)).toContain('edited f.txt (1 replacement)');
  });

  it('a command that was EXECUTING at the crash resumes with an unknown-effects message', () => {
    const events: SessionEvent[] = [
      { v: 1, seq: 1, ts: 't', type: 'user.message', text: 'run the build' },
      {
        v: 1, seq: 2, ts: 't', type: 'assistant.message', text: 'running',
        toolCalls: [{ id: 'c1', name: 'run_command', input: { command: 'npm run build' } }],
        stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 },
      },
      { v: 1, seq: 3, ts: 't', type: 'tool.requested', callId: 'c1', tool: 'run_command', input: { command: 'npm run build' } },
      { v: 1, seq: 4, ts: 't', type: 'command.started', callId: 'c1', pid: 777, shell: 'powershell.exe', cwd: ws, timeoutMs: 120000 },
      // Crash: no command.ended, no tool.completed.
    ];
    const r = reconstruct(events, ws);
    expect(r.orphanedCallIds).toContain('c1');
    const rendered = JSON.stringify(r.messages);
    expect(rendered).toContain('the command was executing when the session crashed');
    expect(rendered).toContain('effects are unknown');
    expect(rendered).not.toContain('"interrupted by session crash"');
  });

  // ── S22.5: completion-aware replay — the kill window between the report* evidence append and
  // the tool.completed append (redaction + up-to-8MiB spill write) used to replay as "effects
  // unknown, re-run" while /report showed the same call's recorded verdict. Two surfaces, one
  // call, two different truths; the log's own completion evidence now wins.
  const cmdBase = (tool: string, input: unknown): SessionEvent[] => [
    { v: 1, seq: 1, ts: 't', type: 'user.message', text: 'go' },
    {
      v: 1, seq: 2, ts: 't', type: 'assistant.message', text: 'running',
      toolCalls: [{ id: 'c1', name: tool, input }],
      stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 },
    },
    { v: 1, seq: 3, ts: 't', type: 'tool.requested', callId: 'c1', tool, input },
  ];

  it('a command whose command.ended LANDED replays its verdict, not "effects unknown" (S22.5)', () => {
    const events: SessionEvent[] = [
      ...cmdBase('run_command', { command: 'npm run build' }),
      { v: 1, seq: 4, ts: 't', type: 'command.started', callId: 'c1', pid: 777, shell: 'powershell.exe', cwd: ws, timeoutMs: 120000 },
      { v: 1, seq: 5, ts: 't', type: 'command.ended', callId: 'c1', termination: 'exited', exitCode: 0, durationMs: 900 },
      // Crash in the post-processing window: no tool.completed.
    ];
    const r = reconstruct(events, ws);
    expect(r.orphanedCallIds).not.toContain('c1'); // positive evidence, not an orphan
    const block = r.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 'c1');
    expect(block!.type === 'tool_result' && block!.isError === true).toBe(false); // isError is omitted when false
    const rendered = JSON.stringify(r.messages);
    expect(rendered).toContain('FINISHED (exit 0)');
    expect(rendered).not.toContain('effects are unknown');
  });

  it('typed checks whose verdicts LANDED replay them by name instead of demanding a re-run (S22.5)', () => {
    const events: SessionEvent[] = [
      ...cmdBase('run_check', { checks: ['build', 'test'] }),
      { v: 1, seq: 4, ts: 't', type: 'check.started', callId: 'c1', check: 'build', recipeId: 'node.script.build', command: 'npm run build', cwd: ws, timeoutMs: 600000 },
      { v: 1, seq: 5, ts: 't', type: 'check.completed', callId: 'c1', check: 'build', recipeId: 'node.script.build', status: 'pass', summary: 'build passed', exitCode: 0, durationMs: 5 },
      { v: 1, seq: 6, ts: 't', type: 'check.completed', callId: 'c1', check: 'test', recipeId: 'node.script.test', status: 'fail', summary: 'test failed', exitCode: 1, durationMs: 5 },
    ];
    const r = reconstruct(events, ws);
    expect(r.orphanedCallIds).not.toContain('c1');
    const rendered = JSON.stringify(r.messages);
    expect(rendered).toContain('build: pass, test: fail');
    expect(rendered).toContain('re-run only checks NOT listed here');
    expect(rendered).not.toContain('produced no verdict');
  });

  it('a VERIFIED remote mutation replays as landed — never as a generic crash inviting a second push (S22.5)', () => {
    const events: SessionEvent[] = [
      ...cmdBase('remote_push', { ref: 'main' }),
      {
        v: 1, seq: 4, ts: 't', type: 'remote.mutated', callId: 'c1', operation: 'push.branch', host: 'github.com',
        target: 'github.com/u/r', exactTarget: 'refs/heads/main', afterOid: 'abc123abc123abc123', overwrote: false,
        ok: true, verified: true, durationMs: 900,
      },
    ];
    const r = reconstruct(events, ws);
    expect(r.orphanedCallIds).not.toContain('c1');
    const block = r.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 'c1');
    expect(block!.type === 'tool_result' && block!.isError === true).toBe(false); // isError is omitted when false
    const rendered = JSON.stringify(r.messages);
    expect(rendered).toContain('VERIFIED against the remote');
    expect(rendered).toContain('do NOT re-run it');
    expect(rendered).not.toContain('interrupted by session crash');
  });

  it('an UNREADABLE mutated file degrades to unknown-post-state instead of failing the resume (S22.5)', () => {
    // A directory at the recorded path makes readFileSync throw (EISDIR) — the same failure
    // class as an AV/indexer holding a just-written file at the moment of resume. Crash
    // recovery must degrade honestly, not die with a raw fs error.
    const dirAsFile = path.join(ws, 'held.txt');
    fs.mkdirSync(dirAsFile, { recursive: true });
    const events: SessionEvent[] = [
      ...base(),
      { v: 1, seq: 4, ts: 't', type: 'file.mutated', callId: 'c1', path: dirAsFile, kind: 'modify', beforeSha256: sha256('a'), afterSha256: sha256('b'), createdDirs: [] },
    ];
    const r = reconstruct(events, ws);
    expect(r.unknownPostStateCallIds).toContain('c1');
    expect(JSON.stringify(r.messages)).toContain('disk state could not be verified');
  });
});
