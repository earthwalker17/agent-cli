import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, runTurn, type Session } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { isAlive } from '../src/exec/kill.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { Approver, ChatMessage, ContentBlock } from '../src/types.js';

/**
 * Mid-command cancellation through the full runtime: the abort fires while a real child process
 * is RUNNING (triggered by the command.started evidence append — event-driven, no sleeps), and
 * the assertions cover the process, the evidence log, and the wire history together.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-cmdabort-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const allowOnce: Approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });

function makeSession(script: ScriptTurn[]): Session {
  return startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode: 'interactive',
    provider: new MockProvider(script),
    approver: allowOnce,
    saltHex: '0'.repeat(32),
    maxSteps: 10,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
}

function assertApiValidHistory(messages: readonly ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (uses.length === 0) continue;
    const next = messages[i + 1];
    expect(next?.role).toBe('user');
    const answered = new Set(
      next!.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.toolUseId),
    );
    for (const u of uses) expect(answered.has(u.id)).toBe(true);
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const SLEEP_CMD = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';

describe('mid-command cancellation (runtime)', () => {
  it('Ctrl+C-style abort kills the RUNNING command and skips the queued write', async () => {
    const controller = new AbortController();
    const session = makeSession([
      {
        calls: [
          { name: 'run_command', input: { command: SLEEP_CMD } },
          { name: 'write_file', input: { path: 'never.txt', content: 'must not exist' } },
        ],
      },
      { say: 'follow-up works' },
    ]);
    session.log.onAppend = (e) => {
      if (e.type === 'command.started') controller.abort(); // the process is provably alive here
    };
    const result = await runTurn(session, 'run then write', { signal: controller.signal });
    session.log.onAppend = undefined;

    expect(result.aborted).toBe(true);
    expect(fs.existsSync(path.join(ws, 'never.txt'))).toBe(false);

    const events = session.log.events;
    const started = events.find((e) => e.type === 'command.started');
    expect(started).toBeDefined();
    expect(started!.type === 'command.started' && started!.pid).toBeGreaterThan(0);

    const ended = events.find((e) => e.type === 'command.ended');
    expect(ended).toMatchObject({ termination: 'aborted', exitCode: null });

    const completions = events.filter((e) => e.type === 'tool.completed');
    expect(completions.length).toBe(2);
    expect(completions[0]).toMatchObject({ ok: false });
    expect(completions[1]).toMatchObject({ ok: false, outputPreview: 'interrupted by user' }); // the skipped write

    expect(events.some((e) => e.type === 'turn.aborted' && e.phase === 'tools')).toBe(true);

    // The model-facing result for the killed command states what happened.
    const toolResults = session.messages
      .flatMap((m) => m.content)
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    expect(toolResults[0]!.content).toMatch(/aborted by user/);

    // The real child is actually dead (bounded poll, not a fixed sleep).
    const pid = started!.type === 'command.started' ? started!.pid : 0;
    expect(await waitDead(pid)).toBe(true);

    assertApiValidHistory(session.messages);
    const second = await runTurn(session, 'continue');
    expect(second.finalText).toBe('follow-up works');
    assertApiValidHistory(session.messages);
    session.log.close();
  }, 45000);

  it('a normal command produces the full lifecycle evidence chain in order', async () => {
    const session = makeSession([{ calls: [{ name: 'run_command', input: { command: 'echo evidence-ok' } }] }, { say: 'done' }]);
    await runTurn(session, 'run it');

    const seq = session.log.events
      .filter((e) =>
        ['tool.requested', 'policy.decision', 'approval.resolved', 'command.started', 'command.ended', 'tool.completed'].includes(
          e.type,
        ),
      )
      .map((e) => e.type);
    expect(seq).toEqual([
      'tool.requested',
      'policy.decision',
      'approval.resolved',
      'command.started',
      'command.ended',
      'tool.completed',
    ]);

    const ended = session.log.events.find((e) => e.type === 'command.ended');
    expect(ended).toMatchObject({ termination: 'exited', exitCode: 0 });
    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    expect(completed).toMatchObject({ ok: true, exitCode: 0 });
    expect(completed!.type === 'tool.completed' && completed!.outputPreview).toMatch(/evidence-ok/);
    session.log.close();
  });

  it('streams live command output through the session onCommandOutput seam', async () => {
    const chunks: { callId: string; chunk: string; stream: string }[] = [];
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'interactive',
      provider: new MockProvider([{ calls: [{ name: 'run_command', input: { command: 'echo live-line' } }] }, { say: 'ok' }]),
      approver: allowOnce,
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
      onCommandOutput: (callId, chunk, stream) => chunks.push({ callId, chunk, stream }),
    });
    await runTurn(session, 'run it');
    expect(chunks.some((c) => c.chunk.includes('live-line') && c.stream === 'stdout')).toBe(true);
    expect(chunks.every((c) => c.callId.length > 0)).toBe(true);
    session.log.close();
  });
});
