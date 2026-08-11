import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { startSession, endSession, runTurn, reconstruct, type Session } from '../src/runtime/session.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout } from '../src/store/layout.js';
import type { Tool } from '../src/types.js';

/**
 * S21 (found by the live-E2E validator against a real refusal): `tool.completed.outputPreview`
 * is contractually "the exact string the model saw" — and for a FAILING result the wire leads
 * with the ERROR text. A result of shape `{ok:false, output:'', error}` (every delegate-gate
 * refusal) persisted as an EMPTY preview: the log could not say why the call failed, and a
 * resumed conversation replayed "(no output recorded)" where the live model had read the reason.
 */

let tmp: string;
let ws: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-errprev-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const refusingTool: Tool = {
  name: 'refusing_tool',
  description: 'always refuses with its message in error only',
  schema: z.object({}).passthrough() as unknown as Tool['schema'],
  mutates: () => ({ paths: [] }),
  execute: async () => ({ ok: false, output: '', error: 'refused: the reviewer round could not bind', durationMs: 0, truncated: false }),
};

function makeSession(): Session {
  const layout = resolveLayout(ws, { ensure: true, env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') } });
  return startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock',
    mode: 'non-interactive',
    provider: new MockProvider([{ say: 'calling', calls: [{ name: 'refusing_tool', input: {} }] }, { say: 'done' }]),
    approver: autoDenyApprover,
    tools: [refusingTool],
    saltHex: '00'.repeat(16),
  });
}

describe('tool.completed for error results', () => {
  it('records the ERROR text the model saw; resume replays it faithfully', async () => {
    const session = makeSession();
    try {
      await runTurn(session, 'go');
      const ev = session.log.events.find((e) => e.type === 'tool.completed');
      expect(ev).toMatchObject({ ok: false });
      expect(ev !== undefined && ev.type === 'tool.completed' ? ev.outputPreview : '').toContain('refused: the reviewer round could not bind');

      // Resume fidelity: the reconstructed tool_result carries the reason, not a placeholder.
      const rebuilt = reconstruct(session.log.events, ws);
      const flat = JSON.stringify(rebuilt.messages);
      expect(flat).toContain('refused: the reviewer round could not bind');
      expect(flat).not.toContain('(no output recorded)');
    } finally {
      await endSession(session, 'completed');
    }
  });
});
