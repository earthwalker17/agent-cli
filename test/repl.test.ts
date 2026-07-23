import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runRepl, buildPlanNote } from '../src/repl/repl.js';
import { writeCanonicalPlan } from '../src/plan/canonical.js';
import { PlanGraphSchema } from '../src/plan/schema.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import type { Session } from '../src/runtime/session.js';
import { createRenderer } from '../src/repl/render.js';
import { detectStyle } from '../src/repl/format.js';
import { installSigintAbort } from '../src/cli/index.js';
import { resolveLayout } from '../src/store/layout.js';
import { EventLog } from '../src/store/event-log.js';
import { grantTrust } from '../src/trust/store.js';
import { createNoneSandbox } from '../src/sandbox/none.js';
import type { SandboxBackend } from '../src/sandbox/index.js';
import type { CliValues } from '../src/cli/context.js';
import type { ScriptTurn } from '../src/provider/mock.js';
import type { SessionEvent } from '../src/types.js';

/** A fake backend that reports enforcement (so auto-run triggers) but wraps as identity: the command
 *  really runs, letting a test assert auto-run WITHOUT depending on the machine's true Low-IL support. */
function fakeEnforcedSandbox(): SandboxBackend {
  const facts = {
    mode: 'windows-lowil' as const,
    enforced: true,
    summary: 'fake enforced sandbox (test)',
    confines: ['writes'],
    doesNotConfine: ['reads', 'network'],
    detail: 'test',
  };
  return { mode: 'windows-lowil', async ensureAvailable() { return facts; }, facts() { return facts; }, wrapSpec: (s) => s };
}

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

async function drive(
  script: ScriptTurn[],
  lines: string[],
  extraValues: Partial<CliValues> = {},
  sandbox: SandboxBackend = createNoneSandbox('test'),
): Promise<ReplRun> {
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

  const code = await runRepl(values, { streams: { input, modelOut, chromeOut, isTTY: false }, sandbox });

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

  it('labels a shell command as a label, not a verdict (the [observe]-vs-NOT-undoable nit)', async () => {
    const { formatApprovalPrompt } = await import('../src/runtime/approvals.js');
    const prompt = formatApprovalPrompt({
      callId: 'c1',
      tool: 'run_command',
      classification: 'observe',
      kind: 'command',
      summary: 'run: node --test',
      detail: 'node --test',
      reason: 'r',
      noUndoWarning: true,
    });
    expect(prompt).toContain('[shell command — labeled observe]');
    expect(prompt).not.toContain('  [observe]  ');
    expect(prompt).toContain('NOT undoable');
    // Non-command requests keep the plain class header.
    const filePrompt = formatApprovalPrompt({
      callId: 'c2',
      tool: 'read_file',
      classification: 'sensitive',
      summary: 'read_file ../outside.txt',
      detail: '',
      reason: 'r',
    });
    expect(filePrompt).toContain('[sensitive]');
  });

  it('options-line matrix: [s] never offered for a command; forwarded asks always explain [q] (live-E2E finding)', async () => {
    const { formatApprovalPrompt } = await import('../src/runtime/approvals.js');
    const base = { callId: 'c', summary: 's', detail: '', reason: 'r' } as const;
    const taskContext = { childSessionId: 'child-1', role: 'executor' };

    // A grantable-CLASS command must NOT offer [s]: Grants refuse command tools, so the old
    // prompt offered a silent no-op (observed live on an 'external'-labeled forwarded command).
    const cmdExternal = formatApprovalPrompt({ ...base, tool: 'run_command', classification: 'external', kind: 'command' });
    expect(cmdExternal).not.toContain('[s]');
    const cmdForwarded = formatApprovalPrompt({ ...base, tool: 'run_command', classification: 'external', kind: 'command', taskContext });
    expect(cmdForwarded).not.toContain('[s]');
    expect(cmdForwarded).toContain('deny & stop THIS TASK');

    // A grantable non-command keeps [s]; forwarded wording says the grant is task-scoped.
    const fileSensitive = formatApprovalPrompt({ ...base, tool: 'read_file', classification: 'sensitive' });
    expect(fileSensitive).toContain('[s] allow for the rest of this session');
    const fileForwarded = formatApprovalPrompt({ ...base, tool: 'read_file', classification: 'sensitive', taskContext });
    expect(fileForwarded).toContain('[s] allow for the rest of THIS TASK');
    expect(fileForwarded).toContain('deny & stop THIS TASK');

    // Non-grantable classes never show [s], forwarded or not.
    const rev = formatApprovalPrompt({ ...base, tool: 'delegate_task', classification: 'reversible' });
    expect(rev).not.toContain('[s]');
    expect(rev).toContain('[q] deny & stop');
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

describe('REPL: live command output', () => {
  it('streams command output to chrome (never stdout) with the pid marker', async () => {
    const r = await drive(
      [{ calls: [{ name: 'run_command', input: { command: 'echo repl-live-ok' } }] }, { say: 'after' }],
      ['run it\n', 'y\n', '/quit\n'],
    );
    expect(r.chromeOut).toContain('repl-live-ok'); // live preview line
    expect(r.chromeOut).toMatch(/\(pid \d+\)/);
    expect(r.modelOut).not.toContain('repl-live-ok'); // stdout stays model-text-only
    expect(r.modelOut).toContain('after');
  });
});

describe('REPL: automatic command review', () => {
  it('auto-runs a demonstrably read-only command inside the enforced sandbox (no approval)', async () => {
    const r = await drive(
      [{ calls: [{ name: 'run_command', input: { command: 'echo auto-ok' } }] }, { say: 'done' }],
      ['run it\n', '/quit\n'], // NOTE: no 'y' line — the command must auto-run without asking
      {},
      fakeEnforcedSandbox(),
    );
    // Never asked; policy chose auto-review-allow; the command ran, marked with its boundary.
    expect(r.events.some((e) => e.type === 'approval.resolved')).toBe(false);
    expect(
      r.events.some((e) => e.type === 'policy.decision' && e.rule === 'cmd.auto-review-allow'),
    ).toBe(true);
    expect(r.events.find((e) => e.type === 'command.started')).toMatchObject({ sandbox: 'windows-lowil' });
    const completed = r.events.filter((e) => e.type === 'tool.completed');
    expect(completed[0]).toMatchObject({ ok: true });
    expect(r.modelOut).toContain('done');
  });

  it('still ASKS for a command with shell metacharacters even under the enforced sandbox', async () => {
    const r = await drive(
      [{ calls: [{ name: 'run_command', input: { command: 'echo a; echo b' } }] }, { say: 'x' }],
      ['run it\n', 'n\n', '/quit\n'],
      {},
      fakeEnforcedSandbox(),
    );
    expect(r.events.some((e) => e.type === 'policy.decision' && e.rule === 'cmd.auto-review-ask')).toBe(true);
    expect(r.events.some((e) => e.type === 'approval.resolved')).toBe(true);
  });

  it('records the sandbox.status for the session', async () => {
    const r = await drive([{ say: 'hi' }], ['task\n', '/quit\n'], {}, fakeEnforcedSandbox());
    expect(r.events.find((e) => e.type === 'sandbox.status')).toMatchObject({ mode: 'windows-lowil', enforced: true });
  });
});

describe('REPL: plan mode (Session 11 — canonical structured plans)', () => {
  const PLAN_GRAPH = {
    objective: 'demo objective',
    tasks: [
      { id: 't1', title: 'do the thing', intent: 'build it', role: 'executor', verify: 'npm test', touches: ['src/x'] },
      { id: 't2', title: 'check it', intent: 'verify the result', role: 'main', verify: 'run the app', dependsOn: ['t1'] },
    ],
  };
  const AMENDED_GRAPH = {
    ...PLAN_GRAPH,
    tasks: [{ ...PLAN_GRAPH.tasks[0]!, title: 'do the thing differently' }, PLAN_GRAPH.tasks[1]!],
  };

  it('update_plan → /plan approve → the next turn carries the approved plan as labeled context', async () => {
    const r = await drive(
      [
        { say: 'planning', calls: [{ name: 'update_plan', input: { plan: PLAN_GRAPH } }] },
        { say: 'plan written — awaiting approval' },
        { say: 'executing per plan' },
      ],
      ['plan this work\n', '/plan\n', '/plan approve\n', 'go ahead\n', '/quit\n'],
    );
    expect(r.code).toBe(0);

    // Evidence chain: the routing decision, the gated write (callId-bound, with the graph
    // summary), and the user's approval (content-sha-bound).
    expect(r.events.find((e) => e.type === 'plan.route')).toMatchObject({ mode: 'plan', source: 'model' });
    const updated = r.events.find((e) => e.type === 'plan.updated');
    expect(updated).toBeDefined();
    expect(updated && 'callId' in updated && typeof updated.callId === 'string' && updated.callId.length > 0).toBe(true);
    expect(updated?.type === 'plan.updated' ? updated.graph : undefined).toEqual([
      { id: 't1', role: 'executor', dependsOn: [] },
      { id: 't2', role: 'main', dependsOn: ['t1'] },
    ]);
    const approved = r.events.find((e) => e.type === 'plan.approved');
    expect(approved).toBeDefined();
    // THE Session 11 quirk fix, pinned inverted: approval binds the CONTENT sha, and a status
    // flip is sha-neutral by construction — so the approved sha EQUALS the write's sha.
    expect(approved && updated && approved.type === 'plan.approved' && updated.type === 'plan.updated' && approved.sha256 === updated.sha256).toBe(true);

    // /plan showed the doc: status chrome + the generated user view on stdout (model-text stream).
    expect(r.chromeOut).toContain('status: draft');
    expect(r.modelOut).toContain('| t1 |');
    expect(r.modelOut).toContain('do the thing');
    expect(r.chromeOut).toContain('plan approved');

    // The post-approval turn carried the standing note. The content sha is UNCHANGED by
    // approval and the model wrote it, so the note is the pointer form — with the LIVE
    // execution summary (task states must never hide behind the content-sha dedupe).
    const goMsg = r.events.filter((e) => e.type === 'user.message').find((e) => e.type === 'user.message' && e.text.includes('go ahead'));
    expect(goMsg).toBeDefined();
    const text = goMsg!.type === 'user.message' ? goMsg!.text : '';
    expect(text).toContain('status: APPROVED');
    expect(text).toContain('CONTEXT, NOT AUTHORITY');
    expect(text).toContain('plan content unchanged since last shown');
    expect(text).toContain('execution: 0/2 completed');
    expect(text).toContain('ready: t1');
    expect(text).toContain('the user APPROVED the plan');
  });

  it('@plan routes into plan mode with the explicit note and a user-sigil route event', async () => {
    const r = await drive([{ say: 'ack planning request' }], ['@plan refactor the widget\n', '/quit\n']);
    const msg = r.events.find((e) => e.type === 'user.message');
    const text = msg?.type === 'user.message' ? msg.text : '';
    expect(text).toContain('PLAN MODE');
    expect(text).toContain('do NOT begin implementation');
    expect(text).toContain('refactor the widget');
    expect(text).not.toContain('@plan'); // the sigil is routing, not message content
    expect(r.events.find((e) => e.type === 'plan.route')).toMatchObject({ mode: 'plan', source: 'user-sigil' });
  });

  it('@direct routes into the direct path with a user-sigil route event', async () => {
    const r = await drive([{ say: 'doing it directly' }], ['@direct fix the typo\n', '/quit\n']);
    const msg = r.events.find((e) => e.type === 'user.message');
    const text = msg?.type === 'user.message' ? msg.text : '';
    expect(text).toContain('DIRECT path');
    expect(text).toContain('fix the typo');
    expect(text).not.toContain('@direct');
    expect(r.events.find((e) => e.type === 'plan.route')).toMatchObject({ mode: 'direct', source: 'user-sigil' });
  });

  it('an amendment INVALIDATES the approval; discard stops injection; a new write starts a fresh draft', async () => {
    const r = await drive(
      [
        { say: 'planning', calls: [{ name: 'update_plan', input: { plan: PLAN_GRAPH } }] },
        { say: 'written' },
        { say: 'amending', calls: [{ name: 'update_plan', input: { plan: AMENDED_GRAPH } }] },
        { say: 'amended' },
        { say: 'observing invalidation' },
        { say: 'after discard' },
        { say: 'replanning', calls: [{ name: 'update_plan', input: { plan: PLAN_GRAPH } }] },
        { say: 'fresh draft written' },
      ],
      ['plan it\n', '/plan approve\n', 'amend the plan\n', 'another turn\n', '/plan discard\n', 'now what\n', 'plan again\n', '/quit\n'],
    );
    // The amendment flipped the file back to draft (structural invalidation)...
    const updates = r.events.filter((e) => e.type === 'plan.updated');
    expect(updates[1]).toMatchObject({ status: 'draft' });
    // ...and the injected note names the invalidation with both shas' prefixes.
    const divergentMsg = r.events.filter((e) => e.type === 'user.message').find((e) => e.type === 'user.message' && e.text.includes('another turn'));
    const divText = divergentMsg?.type === 'user.message' ? divergentMsg.text : '';
    expect(divText).toContain('approval is INVALIDATED');
    expect(divText).toContain('status: DRAFT');

    // Discard: consent recorded, injection stops, the model is told.
    expect(r.events.some((e) => e.type === 'plan.discarded')).toBe(true);
    const lastMsg = r.events.filter((e) => e.type === 'user.message').find((e) => e.type === 'user.message' && e.text.includes('now what'));
    const text = lastMsg?.type === 'user.message' ? lastMsg.text : '';
    expect(text).not.toContain('Active plan');
    expect(text).toContain('the user DISCARDED the plan');

    // The superseded un-trap: a fresh write after discard is a new DRAFT and injection resumes.
    expect(updates[2]).toMatchObject({ status: 'draft' });
    const replanned = r.events.filter((e) => e.type === 'user.message').find((e) => e.type === 'user.message' && e.text.includes('plan again'));
    expect(replanned?.type === 'user.message' ? replanned.text : '').not.toContain('Active plan'); // note lands NEXT turn
  });

  it('a hand-edited canonical plan (sha the model never saw) injects the FULL agent view', async () => {
    // The scripted driver owns the whole file lifecycle, so the hand-edit path is unit-tested:
    // a canonical plan written out-of-band is exactly what a user edit between turns produces.
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state }, ensure: true });
    const snapshots = new SnapshotStore(layout.objectsDir);
    const graph = PlanGraphSchema.parse({
      objective: 'edited by hand',
      tasks: [{ id: 'h1', title: 'hand task', intent: 'added by the user', role: 'explorer' }],
    });
    const w = await writeCanonicalPlan(layout, 'sess-x', graph, snapshots);
    expect('error' in w).toBe(false);
    const fakeSession = { id: 'sess-x', log: { events: [] } } as unknown as Session;

    const note = buildPlanNote(layout, fakeSession, null);
    expect(note).not.toBeNull();
    expect(note!.note).toContain('--- plan begin ---');
    expect(note!.note).toContain('hand task');
    expect(note!.note).toContain('CONTEXT, NOT AUTHORITY');

    // Once shown, the same content collapses to the pointer form with the live execution summary.
    const again = buildPlanNote(layout, fakeSession, note!.sha);
    expect(again!.note).toContain('plan content unchanged since last shown');
    expect(again!.note).not.toContain('--- plan begin ---');
  });

  it('semantic validation errors come back verbatim with NOTHING written', async () => {
    const cyclic = {
      objective: 'broken',
      tasks: [
        { id: 't1', title: 'a', intent: 'x', role: 'executor', verify: 'v', dependsOn: ['t2'] },
        { id: 't2', title: 'b', intent: 'y', role: 'executor', verify: 'v', dependsOn: ['t1'] },
      ],
    };
    const r = await drive(
      [{ say: 'planning', calls: [{ name: 'update_plan', input: { plan: cyclic } }] }, { say: 'saw the errors' }],
      ['plan it\n', '/quit\n'],
    );
    // The tool refused with the exact error; no plan.updated event, no canonical file.
    expect(r.events.some((e) => e.type === 'plan.updated')).toBe(false);
    const completed = r.events.find((e) => e.type === 'tool.completed');
    expect(completed).toMatchObject({ ok: false });
    expect(completed?.type === 'tool.completed' ? completed.outputPreview : '').toContain('dependency cycle');
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } });
    expect(fs.existsSync(layout.plansDir) && fs.readdirSync(layout.plansDir).some((f) => f.endsWith('.plan.json'))).toBe(false);
  });
});

describe('renderer: live command output unit behavior', () => {
  let seq = 0;
  function ev(body: Record<string, unknown>): SessionEvent {
    return { v: 1, seq: ++seq, ts: 't', ...body } as unknown as SessionEvent;
  }
  function makeRenderer() {
    const chunks: Buffer[] = [];
    const chrome = new PassThrough();
    chrome.on('data', (c: Buffer) => chunks.push(c));
    const r = createRenderer({ modelOut: new PassThrough(), chromeOut: chrome, style: detectStyle({ isTTY: false }) });
    return { r, text: () => Buffer.concat(chunks).toString('utf8') };
  }

  it('sanitizes live lines (ANSI/bidi cannot reach the terminal) and closes the tool line', () => {
    const { r, text } = makeRenderer();
    r.onEvent(ev({ type: 'tool.requested', callId: 'c1', tool: 'run_command', input: { command: 'x' } }));
    r.onEvent(ev({ type: 'command.started', callId: 'c1', pid: 1234, shell: 'powershell.exe', cwd: 'w', timeoutMs: 1000 }));
    r.onCommandOutput('evil\x1b[2Jwipe‮bidi\n', 'stdout');
    r.onEvent(ev({ type: 'command.ended', callId: 'c1', termination: 'exited', exitCode: 0, durationMs: 5 }));
    expect(text()).toContain('(pid 1234)');
    expect(text()).toContain('evil');
    expect(text()).not.toContain('\x1b[2J');
    expect(text()).not.toContain('‮');
  });

  it('caps the live display and suppresses further output', () => {
    const { r, text } = makeRenderer();
    r.onEvent(ev({ type: 'command.started', callId: 'c1', pid: 1, shell: 's', cwd: 'w', timeoutMs: 1000 }));
    for (let i = 0; i < 5; i++) r.onCommandOutput(('line-' + i + '-' + 'x'.repeat(120) + '\n').repeat(24), 'stdout');
    r.onEvent(ev({ type: 'command.ended', callId: 'c1', termination: 'exited', exitCode: 0, durationMs: 5 }));
    const out = text();
    expect(out).toContain('display capped');
    expect(out.indexOf('line-4')).toBe(-1); // suppressed after the cap
  });

  it('a killed command renders the honest termination line', () => {
    const { r, text } = makeRenderer();
    r.onEvent(ev({ type: 'command.started', callId: 'c1', pid: 1, shell: 's', cwd: 'w', timeoutMs: 400 }));
    r.onEvent(ev({ type: 'command.ended', callId: 'c1', termination: 'timeout', exitCode: null, durationMs: 400 }));
    expect(text()).toContain('timed out');
    expect(text()).toContain('force-killed (best effort)');
    expect(text()).toContain('no exit code');
  });

  it('task lifecycle renders identity-carrying chrome and counts into the turn summary (V0.7)', () => {
    const { r, text } = makeRenderer();
    r.beginTurn();
    r.onEvent(ev({ type: 'task.started', callId: 'c1', role: 'explorer', childSessionId: 'child-ab12', budget: { maxSteps: 15, timeoutMs: 1, maxOutputTokens: 1 } }));
    r.onEvent(ev({ type: 'task.started', callId: 'c1', role: 'reviewer', childSessionId: 'child-cd34', budget: { maxSteps: 15, timeoutMs: 1, maxOutputTokens: 1 } }));
    r.onEvent(ev({ type: 'task.ended', callId: 'c1', childSessionId: 'child-ab12', status: 'completed', steps: 2, usage: { inputTokens: 1, outputTokens: 500 }, resultSha256: 'x', durationMs: 5 }));
    r.onEvent(ev({ type: 'task.ended', callId: 'c1', childSessionId: 'child-cd34', status: 'timeout', steps: 1, usage: { inputTokens: 1, outputTokens: 100 }, resultSha256: 'y', durationMs: 5 }));
    r.endTurn({ finalText: '', stopReason: 'end_turn', denials: 0, steps: 1, stopped: false, aborted: false }, 20);
    const out = text();
    expect(out).toContain('task explorer·ab12 started');
    expect(out).toContain('task reviewer·cd34 started');
    expect(out).toContain('task ab12 completed');
    expect(out).toContain('task cd34 timeout');
    expect(out).toContain('agent report child-ab12');
    expect(out).toContain('2 task(s)');
  });
});

describe('one-shot SIGINT wiring', () => {
  it('first press aborts, second press force-exits via the injected exit', () => {
    // Isolate from vitest's own SIGINT listeners while emitting synthetically.
    const prior = process.listeners('SIGINT');
    for (const l of prior) process.off('SIGINT', l as NodeJS.SignalsListener);
    try {
      const controller = new AbortController();
      const out = new PassThrough();
      const exits: number[] = [];
      const off = installSigintAbort(controller, out, (code) => exits.push(code));
      process.emit('SIGINT');
      expect(controller.signal.aborted).toBe(true);
      expect(exits).toEqual([]);
      process.emit('SIGINT');
      expect(exits).toEqual([130]);
      off();
      // Non-vacuous detach check: after off(), OUR handler is gone, so a further SIGINT must not
      // invoke the injected exit again (a third press would push another 130 if still attached).
      process.emit('SIGINT');
      expect(exits).toEqual([130]);
    } finally {
      for (const l of prior) process.on('SIGINT', l as NodeJS.SignalsListener);
    }
  });
});

describe('REPL: end-of-session memory wiring', () => {
  it('a productive session announces the update and writes the journal on /quit', async () => {
    const narrative = JSON.stringify({
      objective: 'write f',
      outcome: 'f written.',
      decisions: [],
      openIssues: [],
      nextSteps: [],
      codebaseUpdate: null,
    });
    const r = await drive(
      [
        { say: 'writing', calls: [{ name: 'write_file', input: { path: 'f.txt', content: 'x' } }] },
        { say: 'done' },
        { say: narrative },
      ],
      ['make f\n', '/quit\n'],
    );
    expect(r.code).toBe(0);
    expect(r.chromeOut).toContain('updating project memory');
    expect(r.chromeOut).toContain('journal updated');
    expect(r.events.find((e) => e.type === 'memory.narrative')).toMatchObject({ status: 'ok' });

    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } });
    const journal = fs.readFileSync(path.join(layout.projectDir, 'memory', 'JOURNAL.md'), 'utf8');
    expect(journal).toContain('f written.');
    // The memory.* events land BEFORE session.ended (the update runs pre-endSession).
    const types = r.events.map((e) => e.type);
    expect(types.indexOf('memory.updated')).toBeLessThan(types.indexOf('session.ended'));
  });

  it('an unproductive chat session skips the update quietly', async () => {
    const r = await drive([{ say: 'hi' }], ['hello\n', '/quit\n']);
    expect(r.code).toBe(0);
    expect(r.events.find((e) => e.type === 'memory.narrative')).toMatchObject({ status: 'skipped' });
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: state } });
    expect(fs.existsSync(path.join(layout.projectDir, 'memory', 'JOURNAL.md'))).toBe(false);
  });
});

describe('REPL: /tasks', () => {
  it('reports no tasks when none were delegated', async () => {
    const r = await drive([{ say: 'hi' }], ['hello\n', '/tasks\n', '/quit\n']);
    expect(r.chromeOut).toContain('no delegated tasks in this session');
  });
});
