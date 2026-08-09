import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { truncateForModel, sha256 } from '../src/shared/hash.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import { z } from 'zod';
import type { Approver, Tool } from '../src/types.js';

/**
 * Truncation spill blobs (Session 11.5): output bytes the 16k model truncation would discard
 * forever are preserved as content-addressed blobs at the tool.completed choke point —
 * opt-in per tool (run_command + delegate attach the transient ToolResult.fullOutput; file
 * tools deliberately never do), skipped under any redaction, size-capped, never turn-failing.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-spill-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A command-less read-shaped tool (observe/auto-allow) whose result the test fully controls. */
function bigOutputTool(name: string, fullText: string, opts: { attachFullOutput: boolean; redactForLog?: boolean } = { attachFullOutput: true }): Tool<Record<string, never>> {
  const t = truncateForModel(fullText);
  return {
    name,
    description: 'test tool with oversized output',
    schema: z.object({}).strict(),
    mutates: () => ({ paths: [] }),
    ...(opts.redactForLog === true ? { redactForLog: (r: import('../src/types.js').ToolResult) => r } : {}),
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

function makeSession(script: ScriptTurn[], extraTools: Tool[] = [], approver: Approver = autoDenyApprover): Session {
  const s = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-model',
    mode: 'interactive',
    provider: new MockProvider(script),
    approver,
    saltHex: '0'.repeat(32),
    maxSteps: 10,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
  s.tools = [...s.tools, ...extraTools];
  return s;
}

const BIG = 'A'.repeat(40_000); // well past the 16k model truncation budget

describe('spillFullOutput at the tool.completed choke point', () => {
  it('spills truncated fullOutput to a content-addressed blob; event carries fullOutputSaved', async () => {
    const tool = bigOutputTool('big_out', BIG);
    const session = makeSession([{ say: 'calling', calls: [{ name: 'big_out', input: {} }] }, { say: 'done' }], [tool]);
    await runTurn(session, 'go');

    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    if (completed === undefined || completed.type !== 'tool.completed') throw new Error('missing tool.completed');
    expect(completed.truncated).toBe(true);
    expect(completed.fullOutputSha256).toBe(sha256(BIG));
    expect(completed.fullOutputSaved).toBe(true);
    // The blob holds the exact pre-truncation bytes, keyed by the recorded sha.
    expect(session.snapshots.getBlob(completed.fullOutputSha256!).toString('utf8')).toBe(BIG);
    // The persisted preview stays the truncated text — fullOutput is never persisted verbatim.
    expect(completed.outputPreview.length).toBeLessThan(BIG.length);
    endSession(session, 'completed');
  });

  it('a tool that does not attach fullOutput (the file-tool posture) records no fullOutputSaved', async () => {
    const tool = bigOutputTool('no_attach', BIG, { attachFullOutput: false });
    const session = makeSession([{ say: 'calling', calls: [{ name: 'no_attach', input: {} }] }, { say: 'done' }], [tool]);
    await runTurn(session, 'go');

    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    if (completed === undefined || completed.type !== 'tool.completed') throw new Error('missing tool.completed');
    expect(completed.truncated).toBe(true);
    expect(completed.fullOutputSha256).toBe(sha256(BIG)); // the sha marker stays
    expect(completed.fullOutputSaved).toBeUndefined(); // but nothing was persisted
    expect(() => session.snapshots.getBlob(sha256(BIG))).toThrow();
    endSession(session, 'completed');
  });

  it('read_file never spills: >16k reads carry the sha marker but persist no blob (scope pin)', async () => {
    fs.writeFileSync(path.join(ws, 'big.txt'), BIG);
    const session = makeSession([{ say: 'reading', calls: [{ name: 'read_file', input: { path: 'big.txt' } }] }, { say: 'done' }]);
    await runTurn(session, 'go');

    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    if (completed === undefined || completed.type !== 'tool.completed') throw new Error('missing tool.completed');
    expect(completed.truncated).toBe(true);
    expect(completed.fullOutputSaved).toBeUndefined();
    expect(completed.fullOutputSha256).toBeDefined();
    expect(() => session.snapshots.getBlob(completed.fullOutputSha256!)).toThrow();
    endSession(session, 'completed');
  });

  it('any redaction disables the spill (redacted outputs must never persist un-redacted)', async () => {
    const tool = bigOutputTool('redacted_out', BIG, { attachFullOutput: true, redactForLog: true });
    const session = makeSession([{ say: 'calling', calls: [{ name: 'redacted_out', input: {} }] }, { say: 'done' }], [tool]);
    await runTurn(session, 'go');

    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    if (completed === undefined || completed.type !== 'tool.completed') throw new Error('missing tool.completed');
    expect(completed.fullOutputSaved).toBeUndefined();
    expect(() => session.snapshots.getBlob(sha256(BIG))).toThrow();
    endSession(session, 'completed');
  });

  it('oversize fullOutput (past the spill cap) is not spilled; the turn is unaffected', async () => {
    const huge = 'B'.repeat(8 * 1024 * 1024 + 16);
    const tool = bigOutputTool('huge_out', huge);
    const session = makeSession([{ say: 'calling', calls: [{ name: 'huge_out', input: {} }] }, { say: 'done' }], [tool]);
    const result = await runTurn(session, 'go');
    expect(result.stopReason).toBe('end_turn');

    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    if (completed === undefined || completed.type !== 'tool.completed') throw new Error('missing tool.completed');
    expect(completed.fullOutputSaved).toBeUndefined();
    endSession(session, 'completed');
  });

  it('a failing blob store skips the flag and never fails the turn', async () => {
    const tool = bigOutputTool('big_out', BIG);
    const session = makeSession([{ say: 'calling', calls: [{ name: 'big_out', input: {} }] }, { say: 'done' }], [tool]);
    // Break putBlob for this session (the injected-failure seam; disk permission tricks are
    // not portable on Windows).
    session.snapshots.putBlob = () => {
      throw new Error('disk full');
    };
    const result = await runTurn(session, 'go');
    expect(result.stopReason).toBe('end_turn');

    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    if (completed === undefined || completed.type !== 'tool.completed') throw new Error('missing tool.completed');
    expect(completed.ok).toBe(true);
    expect(completed.fullOutputSaved).toBeUndefined();
    endSession(session, 'completed');
  });

  it('run_command attaches fullOutput: a real >16k command output survives as a blob', async () => {
    const approver: Approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });
    const session = makeSession(
      [{ say: 'running', calls: [{ name: 'run_command', input: { command: `node -p "'x'.repeat(20000)"` } }] }, { say: 'done' }],
      [],
      approver,
    );
    await runTurn(session, 'go');

    const completed = session.log.events.find((e) => e.type === 'tool.completed');
    if (completed === undefined || completed.type !== 'tool.completed') throw new Error('missing tool.completed');
    expect(completed.ok).toBe(true);
    expect(completed.truncated).toBe(true);
    expect(completed.fullOutputSaved).toBe(true);
    const blob = session.snapshots.getBlob(completed.fullOutputSha256!).toString('utf8');
    expect(blob).toContain('x'.repeat(20_000)); // the full captured stream, not the 16k preview
    endSession(session, 'completed');
  });
});
