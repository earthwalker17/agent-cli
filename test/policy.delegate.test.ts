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
 * z.enum of roles would reject bad roles before the policy gate ever saw them — these tests
 * pin the ENGINE's fail-closed behavior independent of any tool's schema. V0.7: the fact names
 * every role in a parallel GROUP; the strictest member governs and any unknown denies the batch.
 */

const WIDE = z.object({ roles: z.array(z.string()) }).passthrough();

function stubTool(overrides: Partial<Tool<{ roles: string[] }>> = {}): Tool<{ roles: string[] }> {
  return {
    name: 'stub_delegate',
    description: 'test stub',
    schema: WIDE as unknown as Tool<{ roles: string[] }>['schema'],
    mutates: () => null,
    delegates: (i) => ({ roles: i.roles }),
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function ctx(): ToolContext {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-policy-'));
  return { workspaceRoot: ws, stateDir: path.join(ws, 'state') };
}

describe('decide: delegation branch (step 0, fail closed)', () => {
  it('every read-only role → allow as observe under the explicit rule (alone and batched)', () => {
    for (const roles of [['explorer'], ['planner'], ['reviewer'], ['explorer', 'planner', 'reviewer']]) {
      const d = decide(stubTool(), { roles }, ctx(), new Grants());
      expect(d, roles.join(',')).toMatchObject({ decision: 'allow', classification: 'observe', rule: 'task.readonly-role' });
      expect(d.requiresSnapshot).toBe(false);
    }
  });

  it('any unknown role → deny (future roles must be added deliberately, never default open)', () => {
    for (const role of ['verifier', 'builder', 'EXPLORER', 'explorer ', '']) {
      const d = decide(stubTool(), { roles: [role] }, ctx(), new Grants());
      expect(d, `role ${JSON.stringify(role)}`).toMatchObject({ decision: 'deny', rule: 'task.unknown-role' });
    }
  });

  it('one unknown role denies the WHOLE batch — read-only companions cannot carry it', () => {
    const d = decide(stubTool(), { roles: ['explorer', 'saboteur', 'reviewer'] }, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'task.unknown-role' });
  });

  it('an empty group is refused, never classified', () => {
    const d = decide(stubTool(), { roles: [] }, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'task.empty-group' });
  });

  it('the mutating executor role is DENIED until worktree isolation ships (Stage B pin)', () => {
    // Stage C flips this to ask/'reversible' deliberately; until then a batch containing an
    // executor must fail closed even next to read-only companions.
    for (const roles of [['executor'], ['explorer', 'executor']]) {
      const d = decide(stubTool(), { roles }, ctx(), new Grants());
      expect(d, roles.join(',')).toMatchObject({ decision: 'deny', rule: 'task.mutating-role-unavailable' });
    }
  });

  it('a throwing delegates() is a deny, never an escape into the fall-throughs', () => {
    const bomb = stubTool({
      delegates: () => {
        throw new Error('model-shaped input exploded');
      },
    });
    const d = decide(bomb, { roles: ['explorer'] }, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'task.invalid-contract', classification: 'sensitive' });
  });

  it('a tool declaring BOTH delegates and command is a contradictory contract → deny before the command branch', () => {
    const treacherous = stubTool({ command: () => 'git status' }); // a provably-safe-looking command string
    const d = decide(treacherous, { roles: ['explorer'] }, ctx(), new Grants());
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

describe('decide: planDoc branch (V0.7, fail closed — the S6 trap pinned again)', () => {
  function planTool(overrides: Partial<Tool<{ content: string }>> = {}): Tool<{ content: string }> {
    return {
      name: 'stub_update_plan',
      description: 'test stub',
      schema: z.object({ content: z.string() }).passthrough() as unknown as Tool<{ content: string }>['schema'],
      mutates: () => null, // the trap shape: null mutates + no command would fall through to observe
      planDoc: () => ({ action: 'update' }),
      execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
      ...overrides,
    };
  }

  it('a planDoc tool with null mutates classifies plan.update/reversible — NEVER observe', () => {
    const d = decide(planTool(), { content: 'x' }, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'allow', classification: 'reversible', rule: 'plan.update' });
    expect(d.requiresSnapshot).toBe(false); // the plan store archives prior bytes itself
  });

  it('planDoc + command is a contradictory contract → deny', () => {
    const d = decide(planTool({ command: () => 'git status' }), { content: 'x' }, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'plan.conflicting-contract' });
  });

  it('planDoc + delegates is denied by the delegation branch (which fires first)', () => {
    const d = decide(
      planTool({ delegates: () => ({ roles: ['explorer'] }) }),
      { content: 'x' },
      ctx(),
      new Grants(),
    );
    expect(d).toMatchObject({ decision: 'deny', rule: 'task.conflicting-contract' });
  });

  it('a throwing planDoc() is a deny, never an escape', () => {
    const bomb = planTool({
      planDoc: () => {
        throw new Error('boom');
      },
    });
    expect(decide(bomb, { content: 'x' }, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'plan.invalid-contract' });
  });

  it('an unknown plan action is denied', () => {
    const weird = planTool({ planDoc: () => ({ action: 'delete' as 'update' }) });
    expect(decide(weird, { content: 'x' }, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'plan.unknown-action' });
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
        { say: 'delegating', calls: [{ name: 'stub_delegate', input: { roles: ['explorer'] } }] },
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
