import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { EventLog } from '../src/store/event-log.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ApprovalOutcome, ApprovalRequest, Approver, SessionEvent, SessionMode } from '../src/types.js';

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-e2e-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function scriptedApprover(outcomes: ApprovalOutcome[]): { approver: Approver; calls: ApprovalRequest[] } {
  const calls: ApprovalRequest[] = [];
  let i = 0;
  const approver: Approver = async (req) => {
    calls.push(req);
    return outcomes[i++] ?? { decision: 'deny', scope: 'once', source: 'user' };
  };
  return { approver, calls };
}

function makeSession(script: ScriptTurn[], approver: Approver, mode: SessionMode = 'interactive'): Session {
  return startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode,
    provider: new MockProvider(script),
    approver,
    saltHex: '0'.repeat(32),
    maxSteps: 10,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
}

function readLog(session: Session): SessionEvent[] {
  return EventLog.readLenient(layout.sessionFile(session.id)).events;
}

describe('startSession fresh-id allocation (Stage A)', () => {
  function collidingIdGen(ids: string[]) {
    let s = 0;
    let c = 0;
    return {
      sessionId: () => ids[Math.min(s++, ids.length - 1)]!,
      callId: () => `call-${(++c).toString().padStart(4, '0')}`,
    };
  }

  it('regenerates on a colliding id and leaves the sibling session untouched', () => {
    const first = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: new MockProvider([]),
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      idGen: collidingIdGen(['dup-id']),
    });
    const second = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: new MockProvider([]),
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      idGen: collidingIdGen(['dup-id', 'fresh-id']),
    });
    expect(first.id).toBe('dup-id');
    expect(second.id).toBe('fresh-id');
    // Separate logs, separate evidence; the sibling keeps its lock and stays writable.
    expect(EventLog.readLenient(layout.sessionFile('dup-id')).events.length).toBe(1);
    expect(EventLog.readLenient(layout.sessionFile('fresh-id')).events.length).toBe(1);
    first.log.append({ type: 'user.message', text: 'sibling unharmed' });
    endSession(first, 'completed');
    endSession(second, 'completed');
  });

  it('throws after exhausting regeneration attempts instead of merging evidence', () => {
    const first = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'non-interactive',
      provider: new MockProvider([]),
      approver: autoDenyApprover,
      saltHex: '0'.repeat(32),
      idGen: collidingIdGen(['stuck-id']),
    });
    expect(() =>
      startSession({
        workspaceRoot: ws,
        layout,
        model: 'mock-model',
        mode: 'non-interactive',
        provider: new MockProvider([]),
        approver: autoDenyApprover,
        saltHex: '0'.repeat(32),
        idGen: collidingIdGen(['stuck-id']),
      }),
    ).toThrow(/could not allocate a fresh session id/);
    // The stuck session's evidence is exactly what it wrote — nothing merged in.
    expect(EventLog.readLenient(layout.sessionFile('stuck-id')).events.length).toBe(1);
    endSession(first, 'completed');
  });
});

describe('runTurn happy path', () => {
  it('reads, edits, and runs a command with one approval', async () => {
    fs.writeFileSync(path.join(ws, 'f.txt'), 'hello world');
    const { approver, calls } = scriptedApprover([{ decision: 'allow', scope: 'once', source: 'user' }]);
    const session = makeSession(
      [
        { say: 'reading', calls: [{ name: 'read_file', input: { path: 'f.txt' } }] },
        { say: 'editing', calls: [{ name: 'edit_file', input: { path: 'f.txt', old_string: 'hello', new_string: 'HELLO' } }] },
        { say: 'checking', calls: [{ name: 'run_command', input: { command: 'echo ok' } }] },
        { say: 'done' },
      ],
      approver,
    );
    const result = await runTurn(session, 'improve f.txt');
    endSession(session, 'completed');

    expect(result.finalText).toBe('done');
    expect(fs.readFileSync(path.join(ws, 'f.txt'), 'utf8')).toBe('HELLO world');
    // Only the shell command asked for approval; read + edit were auto-allowed.
    expect(calls.length).toBe(1);
    expect(calls[0]!.tool).toBe('run_command');

    const types = readLog(session).map((e) => e.type);
    expect(types).toContain('snapshot.created');
    expect(types).toContain('file.mutated');
    const mutated = readLog(session).find((e) => e.type === 'file.mutated');
    expect(mutated).toMatchObject({ kind: 'modify' });
  });
});

describe('runTurn approvals and grants', () => {
  it('a session grant lets a second sensitive read through without re-asking', async () => {
    fs.writeFileSync(path.join(ws, '.env'), 'SECRET=abc123');
    const { approver, calls } = scriptedApprover([{ decision: 'allow', scope: 'session', source: 'user' }]);
    const session = makeSession(
      [
        { calls: [{ name: 'read_file', input: { path: '.env' } }] },
        { calls: [{ name: 'read_file', input: { path: '.env' } }] },
        { say: 'done' },
      ],
      approver,
    );
    await runTurn(session, 'read the env twice');
    endSession(session, 'completed');

    expect(calls.length).toBe(1); // second read used the grant

    // The persisted log redacts the secret; the model saw the real bytes.
    const completed = readLog(session).filter((e) => e.type === 'tool.completed');
    expect(completed.some((e) => (e as { outputPreview: string }).outputPreview.includes('REDACTED'))).toBe(true);
    expect(JSON.stringify(readLog(session))).not.toContain('SECRET=abc123');
    expect(JSON.stringify(session.messages)).toContain('SECRET=abc123');
  });

  it('a session-scope approval on a COMMAND-bearing tool stores no grant — the second call asks again', async () => {
    // The live V0.7 E2E surfaced the display half of this ([s] offered on an 'external'-labeled
    // command); this pins the ENFORCEMENT half: a command's class is a best-effort label over
    // untrusted model text, so a session grant keyed on it would be standing shell permission
    // won by a label. applyGrant upgrades any matching ask, so without the fact-based gate a
    // non-run_command command tool WOULD have auto-run here on the second call.
    const { z } = await import('zod');
    const fetchTool = {
      name: 'fetch_url',
      description: 'test-only command-bearing tool',
      schema: z.object({}).strict(),
      mutates: () => null,
      command: () => 'curl http://example.com/', // deterministically labeled 'external' (grantable class)
      execute: async () => ({ ok: true, output: 'fetched', durationMs: 0, truncated: false }),
    };
    const { approver, calls } = scriptedApprover([
      { decision: 'allow', scope: 'session', source: 'user' },
      { decision: 'allow', scope: 'once', source: 'user' },
    ]);
    const session = makeSession(
      [{ calls: [{ name: 'fetch_url', input: {} }] }, { calls: [{ name: 'fetch_url', input: {} }] }, { say: 'done' }],
      approver,
    );
    session.tools = [...session.tools, fetchTool as never];
    const result = await runTurn(session, 'fetch twice');
    endSession(session, 'completed');

    expect(result.finalText).toBe('done');
    expect(calls.length).toBe(2); // BOTH asked — no grant was stored or honored
    expect(calls.every((c) => c.tool === 'fetch_url')).toBe(true);
    expect(calls[0]!.classification).toBe('external'); // the premise: a grantable CLASS
    expect(session.grants.has('fetch_url', 'external')).toBe(false);
  });

  it('deny & stop halts the turn before the next model call', async () => {
    const { approver } = scriptedApprover([{ decision: 'deny-stop', scope: 'once', source: 'user' }]);
    const session = makeSession(
      [{ calls: [{ name: 'run_command', input: { command: 'echo hi' } }] }, { say: 'should not be reached' }],
      approver,
    );
    const result = await runTurn(session, 'do a thing');
    endSession(session, 'user-quit');
    expect(result.stopped).toBe(true);
    expect(result.finalText).not.toBe('should not be reached');
  });
});

describe('runTurn non-interactive', () => {
  it('auto-denies asks and records the denial, letting observe-only work continue', async () => {
    const session = makeSession(
      [{ calls: [{ name: 'run_command', input: { command: 'echo hi' } }] }, { say: 'blocked but done' }],
      autoDenyApprover,
      'non-interactive',
    );
    const result = await runTurn(session, 'try a command');
    endSession(session, 'completed');
    expect(result.denials).toBe(1);
    expect(result.finalText).toBe('blocked but done');
    const approvals = readLog(session).filter((e) => e.type === 'approval.resolved');
    expect(approvals[0]).toMatchObject({ decision: 'deny', source: 'non-interactive' });
  });
});

describe('runTurn stop reasons', () => {
  it('handles a refusal without crashing', async () => {
    const session = makeSession([{ stopReason: 'refusal' }], autoDenyApprover);
    const result = await runTurn(session, 'do something disallowed');
    endSession(session, 'completed');
    expect(result.stopReason).toBe('refusal');
    expect(result.finalText).toBe('');
  });

  it('S14.5 FIX: tool_use blocks with a NON-tool_use stop reason are answered — the live history stays API-valid', async () => {
    // A max_tokens cut mid-tool-call yields tool_use blocks with stopReason 'max_tokens'. The
    // old loop broke without answering them, so the next user message produced an unanswered
    // tool_use on the wire: a 400 on THAT turn and every later one (repairDanglingToolUses
    // cannot help once a user message is last). The session was dead until quit+resume.
    const session = makeSession(
      [
        { say: 'starting', calls: [{ name: 'read_file', input: { path: 'a.txt' } }], stopReason: 'max_tokens' },
        { say: 'second turn ran fine' },
      ],
      autoDenyApprover,
    );
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello\n');
    const first = await runTurn(session, 'read it');
    expect(first.stopReason).toBe('max_tokens');

    // The unanswered call is closed with evidence AND a tool_result, so the history is valid.
    const events = readLog(session);
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(completed).toHaveLength(1);
    expect((completed[0] as { outputPreview: string }).outputPreview).toContain("stop reason 'max_tokens'");
    const last = session.messages[session.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content.some((b) => b.type === 'tool_result')).toBe(true);

    // The very next turn is the proof: it must not throw and must reach the model.
    const second = await runTurn(session, 'carry on');
    endSession(session, 'completed');
    expect(second.finalText).toBe('second turn ran fine');
  });

  it('denies an out-of-workspace write with a terminal tool.completed', async () => {
    const session = makeSession(
      [{ calls: [{ name: 'write_file', input: { path: '..\\evil.txt', content: 'x' } }] }, { say: 'done' }],
      autoDenyApprover,
    );
    await runTurn(session, 'write outside');
    endSession(session, 'completed');
    const events = readLog(session);
    const decision = events.find((e) => e.type === 'policy.decision');
    expect(decision).toMatchObject({ decision: 'deny', rule: 'path.outside-workspace' });
    // Denied call still gets a terminal tool.completed (so resume never treats it as a crash orphan).
    expect(events.some((e) => e.type === 'tool.completed' && (e as { ok: boolean }).ok === false)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
  });
});
