import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, runTurn, repairDanglingToolUses, type Session } from '../src/runtime/session.js';
import { MockProvider, parseScript, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { coalesceUserMessages } from '../src/provider/anthropic.js';
import { TOOLS } from '../src/tools/index.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { Approver, ChatMessage, ContentBlock, Tool } from '../src/types.js';

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-abort-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeSession(
  script: ScriptTurn[],
  opts: { approver?: Approver; onText?: (t: string) => void; tools?: Tool[] } = {},
): Session {
  return startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode: 'interactive',
    provider: new MockProvider(script),
    approver: opts.approver ?? autoDenyApprover,
    saltHex: '0'.repeat(32),
    maxSteps: 10,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
    ...(opts.onText ? { onText: opts.onText } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  });
}

/** Every assistant tool_use must be answered by a tool_result in the immediately following user message. */
function assertApiValidHistory(messages: readonly ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (uses.length === 0) continue;
    const next = messages[i + 1];
    expect(next, `assistant tool_use at index ${i} must be followed by a user message`).toBeDefined();
    expect(next!.role).toBe('user');
    const answered = new Set(
      next!.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => b.toolUseId),
    );
    for (const u of uses) expect(answered.has(u.id), `tool_use ${u.id} answered`).toBe(true);
  }
}

describe('turn abort: model phase', () => {
  it('aborts a hanging stream, logs turn.aborted, and appends nothing partial', async () => {
    const controller = new AbortController();
    const session = makeSession([{ hang: true, say: 'thinking…' }], {
      onText: () => controller.abort(), // abort as soon as the first delta streams
    });
    const result = await runTurn(session, 'do something slow', { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.stopped).toBe(true);

    const types = session.log.events.map((e) => e.type);
    expect(types).toEqual(['session.started', 'user.message', 'turn.aborted']);
    const aborted = session.log.events.find((e) => e.type === 'turn.aborted');
    expect(aborted).toMatchObject({ phase: 'model' });
    // History ends at the dangling user message — nothing partial from the aborted step.
    expect(session.messages.map((m) => m.role)).toEqual(['user']);
    session.log.close();
  });

  it('a pre-aborted signal never reaches the provider', async () => {
    const controller = new AbortController();
    controller.abort();
    // Script is EMPTY: any provider call would throw "script exhausted".
    const session = makeSession([]);
    const result = await runTurn(session, 'task', { signal: controller.signal });
    expect(result.aborted).toBe(true);
    session.log.close();
  });
});

describe('turn abort: tool phase', () => {
  it('skips every remaining call after the abort — including auto-allowed writes', async () => {
    const controller = new AbortController();
    const session = makeSession([
      {
        calls: [
          { name: 'write_file', input: { path: 'a.txt', content: 'A' } },
          { name: 'write_file', input: { path: 'b.txt', content: 'B' } },
        ],
      },
      { say: 'follow-up turn works' },
    ]);
    // Fire the abort while the FIRST write is executing (its file.mutated append).
    session.log.onAppend = (e) => {
      if (e.type === 'file.mutated') controller.abort();
    };
    const result = await runTurn(session, 'write two files', { signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'b.txt'))).toBe(false); // the interrupt actually interrupted

    const events = session.log.events;
    expect(events.some((e) => e.type === 'turn.aborted' && e.phase === 'tools')).toBe(true);
    const completions = events.filter((e) => e.type === 'tool.completed');
    expect(completions.length).toBe(2);
    expect(completions[1]).toMatchObject({ ok: false, outputPreview: 'interrupted by user' });

    // The wire history stays API-valid, and the next turn runs cleanly on it.
    assertApiValidHistory(session.messages);
    session.log.onAppend = undefined;
    const second = await runTurn(session, 'continue');
    expect(second.finalText).toBe('follow-up turn works');
    assertApiValidHistory(session.messages);
    session.log.close();
  });

  it('deny-&-stop also stops auto-allowed writes queued behind it (V0.1 gap regression)', async () => {
    const denyStop: Approver = async () => ({ decision: 'deny-stop', scope: 'once', source: 'user' });
    const session = makeSession(
      [
        {
          calls: [
            { name: 'run_command', input: { command: 'echo hi' } },
            { name: 'write_file', input: { path: 'after-stop.txt', content: 'should never exist' } },
          ],
        },
      ],
      { approver: denyStop },
    );
    const result = await runTurn(session, 'do things');
    expect(result.stopped).toBe(true);
    expect(result.aborted).toBe(false);
    expect(fs.existsSync(path.join(ws, 'after-stop.txt'))).toBe(false);
    const completions = session.log.events.filter((e) => e.type === 'tool.completed');
    expect(completions[1]).toMatchObject({ ok: false, outputPreview: 'skipped: session stopped by user' });
    assertApiValidHistory(session.messages);
    session.log.close();
  });
});

describe('turn-error repair', () => {
  const boomTool: Tool<Record<string, never>> = {
    name: 'boom',
    description: 'always throws',
    schema: z.object({}).strict() as z.ZodType<Record<string, never>>,
    mutates: () => null,
    async execute() {
      throw new Error('tool exploded');
    },
  };

  it('answers dangling tool_use blocks so the next turn stays API-valid', async () => {
    const session = makeSession(
      [
        {
          calls: [
            { name: 'write_file', input: { path: 'ok.txt', content: 'fine' } },
            { name: 'boom', input: {} },
          ],
        },
        { say: 'recovered' },
      ],
      { tools: [...TOOLS, boomTool as Tool] },
    );
    await expect(runTurn(session, 'write then explode')).rejects.toThrow('tool exploded');

    // Mid-loop throw: assistant message pushed, tool results never were.
    expect(session.messages[session.messages.length - 1]!.role).toBe('assistant');
    expect(repairDanglingToolUses(session)).toBe(true);
    assertApiValidHistory(session.messages);

    // The completed write is answered from its recorded result; the thrown call gets an error result.
    const repaired = session.messages[session.messages.length - 1]!;
    const results = repaired.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    expect(results.length).toBe(2);
    expect(results[0]!.isError).toBeUndefined();
    expect(results[0]!.content).toContain('ok.txt');
    expect(results[1]!.isError).toBe(true);

    const second = await runTurn(session, 'go on');
    expect(second.finalText).toBe('recovered');
    session.log.close();
  });

  it('is a no-op when there is nothing to repair', async () => {
    const session = makeSession([{ say: 'done' }]);
    await runTurn(session, 'trivial');
    expect(repairDanglingToolUses(session)).toBe(false);
    session.log.close();
  });
});

describe('coalesceUserMessages', () => {
  it('merges consecutive same-role messages and preserves order', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'r' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ];
    const out = coalesceUserMessages(msgs);
    expect(out.length).toBe(3);
    expect(out[0]!.content.map((b) => (b as { text: string }).text)).toEqual(['a', 'b']);
    expect(out[1]!.role).toBe('assistant');
    expect(msgs.length).toBe(4); // input untouched
  });

  it('leaves an already-alternating history unchanged', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ];
    expect(coalesceUserMessages(msgs)).toEqual(msgs);
  });
});

describe('MockProvider hang turns', () => {
  it('throws immediately when no signal is supplied (never stalls a suite)', async () => {
    const p = new MockProvider([{ hang: true }]);
    await expect(
      p.complete({ model: 'm', system: '', messages: [], tools: [], maxTokens: 16 }),
    ).rejects.toThrow(/requires an abort signal/);
  });

  it('parseScript rejects hang turns in --script files', () => {
    expect(() => parseScript(JSON.stringify([{ hang: true }]))).toThrow();
  });
});
