import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { decide, Grants } from '../src/policy/engine.js';
import { TOOLS } from '../src/tools/index.js';
import { startSession, endSession, runTurn } from '../src/runtime/session.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { TaskEvidence, Tool, ToolContext } from '../src/types.js';

/**
 * The delegation policy branch. Stub tools use WIDE schemas on purpose: the real delegate tool's
 * z.literal('explorer') would reject bad roles before the policy gate ever saw them — these tests
 * pin the ENGINE's fail-closed behavior independent of any tool's schema.
 */

const WIDE = z.object({ role: z.string() }).passthrough();

function stubTool(overrides: Partial<Tool<{ role: string }>> = {}): Tool<{ role: string }> {
  return {
    name: 'stub_delegate',
    description: 'test stub',
    schema: WIDE as unknown as Tool<{ role: string }>['schema'],
    mutates: () => null,
    delegates: (i) => ({ role: i.role }),
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function ctx(): ToolContext {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-policy-'));
  return { workspaceRoot: ws, stateDir: path.join(ws, 'state') };
}

describe('decide: delegation branch (step 0, fail closed)', () => {
  it('explorer role → allow as observe under the explicit rule', () => {
    const d = decide(stubTool(), { role: 'explorer' }, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'allow', classification: 'observe', rule: 'task.readonly-role' });
    expect(d.requiresSnapshot).toBe(false);
  });

  it('any other role → deny (future roles must be added deliberately, never default open)', () => {
    for (const role of ['verifier', 'builder', 'EXPLORER', 'explorer ', '']) {
      const d = decide(stubTool(), { role }, ctx(), new Grants());
      expect(d, `role ${JSON.stringify(role)}`).toMatchObject({ decision: 'deny', rule: 'task.unknown-role' });
    }
  });

  it('a tool declaring BOTH delegates and command is a contradictory contract → deny before the command branch', () => {
    const treacherous = stubTool({ command: () => 'git status' }); // a provably-safe-looking command string
    const d = decide(treacherous, { role: 'explorer' }, ctx(), new Grants());
    // The rule proves the delegation branch fired — the command branch would have produced cmd.*.
    expect(d).toMatchObject({ decision: 'deny', rule: 'task.conflicting-contract', classification: 'sensitive' });
  });

  it('regression: the branch does not disturb any existing tool classification', () => {
    const c = ctx();
    fs.writeFileSync(path.join(c.workspaceRoot, 'x.txt'), 'x');
    const table: Record<string, string> = {};
    for (const tool of TOOLS) {
      const input =
        tool.name === 'run_command'
          ? { command: 'git status' }
          : tool.name === 'edit_file'
            ? { path: 'x.txt', old_string: 'x', new_string: 'y' }
            : tool.name === 'write_file'
              ? { path: 'x.txt', content: 'y' }
              : tool.name === 'search'
                ? { pattern: 'x' }
                : { path: 'x.txt' };
      table[tool.name] = decide(tool as Tool, input, c, new Grants()).rule;
    }
    expect(table).toEqual({
      read_file: 'observe.in-workspace',
      list_files: 'observe.in-workspace',
      search: 'observe.in-workspace',
      write_file: 'mutation.in-workspace',
      edit_file: 'mutation.in-workspace',
      run_command: 'cmd.auto-review-ask', // no enforced sandbox in this ctx → ask (fail closed)
    });
  });
});

describe('reportTask: runtime-bound task evidence', () => {
  it('persists task.started/task.ended under the RUNTIME callId', async () => {
    const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-evidence-')));
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(ws);
    const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });

    const reporter = stubTool({
      execute: async (_i, toolCtx) => {
        const started: TaskEvidence = {
          kind: 'started',
          role: 'explorer',
          childSessionId: 'child-1',
          budget: { maxSteps: 15, timeoutMs: 300_000, maxOutputTokens: 30_000 },
        };
        toolCtx.reportTask?.(started);
        toolCtx.reportTask?.({
          kind: 'ended',
          childSessionId: 'child-1',
          status: 'completed',
          steps: 3,
          usage: { inputTokens: 1, outputTokens: 2 },
          resultSha256: 'abc',
          durationMs: 5,
        });
        return { ok: true, output: 'done', durationMs: 5, truncated: false };
      },
    });

    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock',
      mode: 'non-interactive',
      provider: new MockProvider([
        { say: 'delegating', calls: [{ name: 'stub_delegate', input: { role: 'explorer' } }] },
        { say: 'done' },
      ]),
      approver: autoDenyApprover,
      tools: [reporter as Tool],
      saltHex: '00'.repeat(16),
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
    });
    await runTurn(session, 'go');

    const started = session.log.events.find((e) => e.type === 'task.started');
    const ended = session.log.events.find((e) => e.type === 'task.ended');
    const requested = session.log.events.find((e) => e.type === 'tool.requested');
    expect(started).toBeDefined();
    expect(ended).toMatchObject({ status: 'completed', steps: 3, childSessionId: 'child-1' });
    // The callId is the runtime's (the tool_use id) — a tool cannot forge another call's evidence.
    expect(started && 'callId' in started ? started.callId : '?').toBe(requested && 'callId' in requested ? requested.callId : '!');
    endSession(session, 'completed');
  });
});
