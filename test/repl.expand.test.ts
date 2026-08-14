import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { dispatchSlash, type CommandContext } from '../src/repl/commands.js';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { truncateForModel } from '../src/shared/hash.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { Renderer } from '../src/repl/render.js';
import type { Tool } from '../src/types.js';

/**
 * S22 — /expand reprints a folded output IN FULL from the record: the spill blob when one was
 * saved, the recorded head+tail otherwise, with the provenance named either way. It reads the
 * event log + blob store — never renderer memory — so it survives resume by construction.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;
let session: Session;
let chrome: string[];
let modelText: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-expand-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  chrome = [];
  modelText = '';
});
afterEach(() => {
  try {
    endSession(session, 'user-quit');
  } catch {
    /* already ended */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A command-less tool named run_command so /expand's discovery sees it (observe/auto-allow). */
function fakeRunCommand(fullText: string, opts: { attachFullOutput: boolean }): Tool<Record<string, never>> {
  const t = truncateForModel(fullText);
  return {
    name: 'run_command',
    description: 'test stand-in with controlled output',
    schema: z.object({}).strict(),
    mutates: () => ({ paths: [] }),
    async execute() {
      return {
        ok: true,
        output: t.text,
        durationMs: 1,
        truncated: t.truncated,
        ...(t.fullSha256 !== undefined ? { fullOutputSha256: t.fullSha256 } : {}),
        ...(opts.attachFullOutput && t.fullSha256 !== undefined ? { fullOutput: fullText } : {}),
      };
    },
  };
}

function makeSession(script: ScriptTurn[], extraTools: Tool[]): Session {
  const s = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode: 'interactive',
    provider: new MockProvider(script),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '0'.repeat(32),
    maxSteps: 10,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
  s.tools = [...s.tools, ...extraTools];
  return s;
}

function ctx(): CommandContext {
  const modelOut = new PassThrough();
  modelOut.on('data', (c: Buffer) => {
    modelText += c.toString('utf8');
  });
  const renderer: Renderer = {
    onText: () => {},
    onCommandOutput: () => {},
    onEvent: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    turnError: () => {},
    banner: () => {},
    chromeLine: (t) => chrome.push(t),
    flush: () => {},
  };
  return { session, layout, renderer, modelOut, pendingNotes: [] };
}

const CALL = [{ say: 'calling', calls: [{ name: 'run_command', input: {} }] }, { say: 'done' }];
const BIG = `first-line\n${'A'.repeat(40_000)}\nlast-line`; // past the 16k truncation budget

describe('/expand', () => {
  it('reprints the FULL spilled output from the blob, with provenance in the header', async () => {
    session = makeSession(CALL, [fakeRunCommand(BIG, { attachFullOutput: true })]);
    await runTurn(session, 'go');
    expect(await dispatchSlash('/expand', ctx())).toBe('continue');
    expect(modelText).toContain('first-line');
    expect(modelText).toContain('last-line');
    expect(modelText.length).toBeGreaterThan(40_000); // the whole thing, not the 16k preview
    expect(chrome.join('\n')).toContain('full output ');
  });

  it('falls back to the recorded head+tail when no blob was saved, and says so', async () => {
    session = makeSession(CALL, [fakeRunCommand(BIG, { attachFullOutput: false })]);
    await runTurn(session, 'go');
    await dispatchSlash('/expand last', ctx());
    expect(modelText).toContain('first-line'); // the head survives in the preview
    expect(modelText.length).toBeLessThan(20_000); // but it IS the preview, not the full bytes
    expect(chrome.join('\n')).toContain('head+tail as recorded (the full output was not retained)');
  });

  it('an untruncated output reprints verbatim with no provenance suffix', async () => {
    session = makeSession(CALL, [fakeRunCommand('short and sweet', { attachFullOutput: true })]);
    await runTurn(session, 'go');
    await dispatchSlash('/expand', ctx());
    expect(modelText).toContain('short and sweet');
    expect(chrome.join('\n')).not.toContain('full output ');
    expect(chrome.join('\n')).not.toContain('not retained');
  });

  it('nothing on record and out-of-range targets answer honestly', async () => {
    session = makeSession([{ say: 'hi' }], []);
    await runTurn(session, 'go');
    await dispatchSlash('/expand', ctx());
    expect(chrome.join('\n')).toContain('nothing to expand');

    chrome.length = 0;
    session.tools = [...session.tools];
    endSession(session, 'user-quit');
    session = makeSession(CALL, [fakeRunCommand('x', { attachFullOutput: true })]);
    await runTurn(session, 'go');
    await dispatchSlash('/expand 99', ctx());
    expect(chrome.join('\n')).toContain('usage: /expand');
    expect(chrome.join('\n')).toContain('1 expandable output(s) on record');
  });
});
