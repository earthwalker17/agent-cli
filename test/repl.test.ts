import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runRepl } from '../src/repl/repl.js';
import { resolveLayout } from '../src/store/layout.js';
import { EventLog } from '../src/store/event-log.js';
import { grantTrust } from '../src/trust/store.js';
import type { CliValues } from '../src/cli/context.js';
import type { ScriptTurn } from '../src/provider/mock.js';
import type { SessionEvent } from '../src/types.js';

let tmp: string;
let ws: string;
let state: string;
let savedStateDir: string | undefined;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-repl-')));
  ws = path.join(tmp, 'ws');
  state = path.join(tmp, 'state');
  fs.mkdirSync(ws);
  savedStateDir = process.env['AGENT_CLI_STATE_DIR'];
  process.env['AGENT_CLI_STATE_DIR'] = state;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env['AGENT_CLI_STATE_DIR'];
  else process.env['AGENT_CLI_STATE_DIR'] = savedStateDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface ReplRun {
  code: number;
  modelOut: string;
  chromeOut: string;
  events: SessionEvent[];
}

async function drive(script: ScriptTurn[], lines: string[], extraValues: Partial<CliValues> = {}): Promise<ReplRun> {
  const scriptFile = path.join(tmp, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const values: CliValues = {
    C: ws,
    provider: 'mock',
    script: scriptFile,
    interactive: true,
    'trust-this-workspace': true,
    ...extraValues,
  };

  const input = new PassThrough();
  const modelChunks: Buffer[] = [];
  const chromeChunks: Buffer[] = [];
  const modelOut = new PassThrough();
  modelOut.on('data', (c: Buffer) => modelChunks.push(c));
  const chromeOut = new PassThrough();
  chromeOut.on('data', (c: Buffer) => chromeChunks.push(c));

  input.write(lines.join(''));
  input.end();

  const code = await runRepl(values, { streams: { input, modelOut, chromeOut, isTTY: false } });

  const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } });
  let events: SessionEvent[] = [];
  try {
    const files = fs.readdirSync(layout.sessionsDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) events = EventLog.readLenient(layout.sessionFile(files[0]!.slice(0, -6))).events;
  } catch {
    /* no sessions */
  }
  return {
    code,
    modelOut: Buffer.concat(modelChunks).toString('utf8'),
    chromeOut: Buffer.concat(chromeChunks).toString('utf8'),
    events,
  };
}

describe('REPL: conversation loop', () => {
  it('runs multiple turns in one session and ends with user-quit', async () => {
    const r = await drive([{ say: 'hi' }, { say: 'bye' }], ['first\n', 'second\n', '/quit\n']);
    expect(r.code).toBe(0);
    expect(r.modelOut).toBe('hi\nbye\n');
    const userMsgs = r.events.filter((e) => e.type === 'user.message');
    expect(userMsgs).toHaveLength(2);
    const ended = r.events.find((e) => e.type === 'session.ended');
    expect(ended).toMatchObject({ reason: 'user-quit' });
    // One session, one log: trust + config provenance recorded.
    expect(r.events.some((e) => e.type === 'trust.verified' && e.source === 'flag')).toBe(true);
    expect(r.events.some((e) => e.type === 'config.loaded')).toBe(true);
  });

  it('stdout carries ONLY model text; all chrome goes to stderr', async () => {
    const r = await drive([{ say: 'clean' }], ['task\n', '/quit\n']);
    expect(r.modelOut).toBe('clean\n');
    expect(r.chromeOut).toContain('agent session');
    expect(r.chromeOut).toContain('workspace:');
  });

  it('EOF (stream end) quits cleanly without /quit', async () => {
    const r = await drive([{ say: 'only' }], ['task\n']);
    expect(r.code).toBe(0);
    expect(r.events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: 'user-quit' });
  });

  it('an untrusted workspace refuses with exit 3 before any session exists', async () => {
    const r = await drive([{ say: 'never' }], ['task\n'], { 'trust-this-workspace': false });
    expect(r.code).toBe(3);
    expect(r.events).toHaveLength(0);
    expect(r.chromeOut).toContain('refusing to start');
  });

  it('recorded trust (agent trust) also satisfies the gate', async () => {
    grantTrust(state, ws, 'command');
    const r = await drive([{ say: 'trusted' }], ['task\n', '/quit\n'], { 'trust-this-workspace': false });
    expect(r.code).toBe(0);
    expect(r.events.some((e) => e.type === 'trust.verified' && e.source === 'store')).toBe(true);
  });
});

describe('REPL: approvals through the shared readline', () => {
  it('an approval prompt consumes the next input line (y allows)', async () => {
    const r = await drive(
      [{ calls: [{ name: 'run_command', input: { command: 'echo repl-ok' } }] }, { say: 'after' }],
      ['run it\n', 'y\n', '/quit\n'],
    );
    expect(r.modelOut).toContain('after');
    const approval = r.events.find((e) => e.type === 'approval.resolved');
    expect(approval).toMatchObject({ decision: 'allow', source: 'user' });
    const completed = r.events.filter((e) => e.type === 'tool.completed');
    expect(completed[0]).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('stdin ending at a pending approval fails safe as deny-&-stop', async () => {
    const r = await drive([{ calls: [{ name: 'run_command', input: { command: 'echo never' } }] }], ['run it\n']);
    expect(r.code).toBe(0);
    const approval = r.events.find((e) => e.type === 'approval.resolved');
    expect(approval).toMatchObject({ decision: 'deny-stop' });
    expect(r.events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: 'user-quit' });
  });
});

describe('REPL: slash commands over the live log', () => {
  it('/undo restores a file written THIS session and informs the model via a harness note', async () => {
    const r = await drive(
      [
        { calls: [{ name: 'write_file', input: { path: 'gen.txt', content: 'generated' } }] },
        { say: 'created' },
        { say: 'understood' },
      ],
      ['make a file\n', '/undo\n', 'continue please\n', '/quit\n'],
    );
    expect(fs.existsSync(path.join(ws, 'gen.txt'))).toBe(false);
    const undo = r.events.find((e) => e.type === 'undo.applied');
    expect(undo).toBeDefined();
    expect((undo as Extract<SessionEvent, { type: 'undo.applied' }>).restored).toHaveLength(1);
    const userMsgs = r.events.filter((e) => e.type === 'user.message');
    expect(userMsgs[1]!.type === 'user.message' && userMsgs[1]).toMatchObject({
      text: expect.stringContaining('[[harness note:'),
    });
    expect(r.chromeOut).toContain('restored');
  });

  it('/report prints the evidence report to stdout', async () => {
    const r = await drive([{ say: 'noop' }], ['do nothing\n', '/report\n', '/quit\n']);
    expect(r.modelOut).toContain('# Agent CLI session report');
    expect(r.modelOut).toContain('Assistant narrative is not evidence');
  });

  it('/status and /help are chrome; unknown commands hint', async () => {
    const r = await drive([{ say: 'x' }], ['t\n', '/status\n', '/help\n', '/nope\n', '/quit\n']);
    expect(r.chromeOut).toContain('user messages: 1');
    expect(r.chromeOut).toContain('/undo [all]');
    expect(r.chromeOut).toContain('unknown command: /nope');
  });
});

describe('REPL io: approval prompts vs typed-ahead lines (TTY)', () => {
  async function tick(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('a line typed BEFORE an approval question never answers it; it stays queued for the prompt', async () => {
    const { createReplIO } = await import('../src/repl/io.js');
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => {});
    const io = createReplIO({ input, output, isTTY: true });

    // The user types their NEXT INSTRUCTION while a turn is running ("sure, add tests too"
    // happens to start with 's' — which parseAnswer reads as allow-for-session).
    input.write('sure, add tests too\n');
    await tick();

    let answered: string | null | undefined;
    const q = io.question('approve command? ').then((a) => (answered = a));
    await tick();
    expect(answered).toBeUndefined(); // the buffered line did NOT answer the security prompt

    input.write('n\n'); // only a line typed AFTER the question can answer it
    await q;
    expect(answered).toBe('n');

    // The buffered instruction is still there for the next idle prompt.
    const line = await io.prompt('> ');
    expect(line).toEqual({ kind: 'line', text: 'sure, add tests too' });
    io.close();
  });

  it('piped (non-TTY) input keeps queue semantics so scripted drivers can pre-supply answers', async () => {
    const { createReplIO } = await import('../src/repl/io.js');
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => {});
    const io = createReplIO({ input, output, isTTY: false });
    input.write('y\n');
    await tick();
    expect(await io.question('approve? ')).toBe('y');
    io.close();
  });

  it('Ctrl+C during a pending question fires the interrupt handler and resolves null', async () => {
    const { createReplIO } = await import('../src/repl/io.js');
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => {});
    const io = createReplIO({ input, output, isTTY: true });
    let interrupted = false;
    io.onInterrupt(() => (interrupted = true));
    const q = io.question('approve? ');
    await tick();
    input.write('\x03'); // raw ^C keypress in terminal mode
    expect(await q).toBeNull();
    expect(interrupted).toBe(true);
    io.close();
  });
});

describe('approval prompt display safety', () => {
  it('escapes ANSI/bidi in the model-controlled command before it reaches the terminal', async () => {
    const { formatApprovalPrompt } = await import('../src/runtime/approvals.js');
    const esc = String.fromCharCode(0x1b);
    const prompt = formatApprovalPrompt({
      callId: 'c1',
      tool: 'run_command',
      classification: 'observe',
      summary: `run: echo safe${esc}[2K${esc}[1A‮rm -rf /`,
      detail: `echo safe${esc}[2K`,
      reason: 'r',
    });
    expect(prompt).not.toContain(esc);
    expect(prompt).not.toContain('‮');
    expect(prompt).toContain('\\u{1b}');
    expect(prompt).toContain('\\u{202e}');
  });
});

describe('REPL: resilience', () => {
  it('a turn error keeps the session alive and the next turn works', async () => {
    // Turn 1: an invalid tool input → recorded deny, then 'recovered'. Turn 2: the script is
    // EXHAUSTED → the provider throws → the REPL must render the error, keep the session alive,
    // and still accept /quit cleanly.
    const r = await drive(
      [{ calls: [{ name: 'write_file', input: { nope: true } }] }, { say: 'recovered' }],
      ['bad tool call\n', 'again\n', '/quit\n'],
    );
    expect(r.code).toBe(0);
    expect(r.modelOut).toContain('recovered');
    // Second user turn hits an exhausted script → turn failed, session survived to /quit.
    expect(r.chromeOut).toContain('turn failed');
    expect(r.events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: 'user-quit' });
  });

  it('max-steps warns and returns to the prompt instead of ending the session', async () => {
    const r = await drive(
      [
        { calls: [{ name: 'list_files', input: {} }] },
        { calls: [{ name: 'list_files', input: {} }] },
        { say: 'never reached' },
      ],
      ['loop\n', '/quit\n'],
      { 'max-turns': '2' },
    );
    expect(r.code).toBe(0);
    expect(r.chromeOut).toContain('step budget reached');
    expect(r.events.find((e) => e.type === 'session.ended')).toMatchObject({ reason: 'user-quit' });
  });
});
