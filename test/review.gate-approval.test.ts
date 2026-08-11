import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import type { SubagentDeps } from '../src/runtime/subagent.js';
import { createDelegateTool, MAX_REVIEW_ROUNDS, type PlanGateInfo } from '../src/tools/delegate.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { Tool } from '../src/types.js';
import type { PlanState } from '../src/plan/canonical.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * Session 21 (Fix B, the S20.5 live finding): a review round started while a once-approved
 * plan's approval is invalidated cannot bind to the plan's reviewer task, yet it consumed one of
 * the MAX_REVIEW_ROUNDS — the live E2E's two rounds both ran unbound inside an amendment window
 * and the spent cap then blocked the bound round the plan's review task needed. The fix is
 * EX-ANTE: delegate refuses the reviewer group naming /plan approve as the cure. The cap itself
 * is untouched (a round is a round; no-plan / never-approved / discarded sessions keep today's
 * behavior).
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;
const MAP: WorkspaceMap = { text: 'a.txt\n', fileCount: 1, truncated: false, sha256: 'map-x' };

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'revgate-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function subagentDeps(childScripts: ScriptTurn[][]): SubagentDeps {
  let i = 0;
  return {
    layout,
    workspaceRoot: ws,
    model: 'mock-child',
    maxTokens: 1000,
    provider: new MockProvider([{ say: 'fallback' }]),
    map: MAP,
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
    providerForTask: () => new MockProvider(childScripts[i++] ?? [{ say: 'no script' }]),
  };
}

function makeParent(parentScript: ScriptTurn[], planContext: () => PlanGateInfo): Session {
  const parent = startSession({
    workspaceRoot: ws,
    layout,
    model: 'mock-parent',
    mode: 'non-interactive',
    provider: new MockProvider(parentScript),
    approver: autoDenyApprover,
    tools: [],
    saltHex: '00'.repeat(16),
    clock: fixedClock(0, 1),
    idGen: seededIdGen(),
  });
  parent.tools = [
    createDelegateTool(subagentDeps([[{ say: 'clean lens, nothing found' }]]), parent.id, undefined, {
      planContext,
      caps: { tasksStarted: 0, childOutputTokens: 0, reviewRoundsStarted: 0 },
    }) as Tool,
  ];
  return parent;
}

const REVIEW_CALL: ScriptTurn[] = [
  { say: 'reviewing', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'reviewer', task: 'Correctness lens over the change' }] } }] },
  { say: 'done' },
];

function state(over: Partial<PlanState>): PlanState {
  return {
    kind: 'canonical',
    status: 'approved',
    currentSha: 'cur',
    approvedSha: 'appr',
    diverged: false,
    approvedAndCurrent: true,
    ...over,
  } as PlanState;
}

async function run(parent: Session): Promise<{ text: string; spawned: boolean }> {
  await runTurn(parent, 'review it');
  await endSession(parent, 'completed');
  return {
    text: JSON.stringify(parent.messages),
    spawned: parent.log.events.some((e) => e.type === 'task.started'),
  };
}

describe('the reviewer gate under an invalidated approval (S21)', () => {
  it('once-approved + DIVERGED refuses the reviewer group ex ante, naming the cure and the cap', async () => {
    const parent = makeParent(REVIEW_CALL, () => ({
      state: state({ status: 'approved', approvedAndCurrent: false, diverged: true }),
      graphState: null,
    }));
    const r = await run(parent);
    expect(r.spawned).toBe(false);
    expect(r.text).toContain('approval is no longer current');
    expect(r.text).toContain('the document changed after approval');
    expect(r.text).toContain(`${MAX_REVIEW_ROUNDS} review rounds`);
    expect(r.text).toContain('/plan approve');
  });

  it('draft-after-amendment (approval event stands, file went back to draft) refuses too', async () => {
    const parent = makeParent(REVIEW_CALL, () => ({
      state: state({ status: 'draft', approvedAndCurrent: false, diverged: true }),
      graphState: null,
    }));
    const r = await run(parent);
    expect(r.spawned).toBe(false);
    expect(r.text).toContain('status: draft');
    expect(r.text).toContain('/plan approve');
  });

  it('a NEVER-approved draft keeps today\'s behavior: the voluntary unbound round runs', async () => {
    const parent = makeParent(REVIEW_CALL, () => ({
      state: state({ status: 'draft', approvedSha: null, approvedAndCurrent: false }),
      graphState: null,
    }));
    const r = await run(parent);
    expect(r.spawned).toBe(true);
  });

  it('no plan at all: the round runs', async () => {
    const parent = makeParent(REVIEW_CALL, () => ({
      state: state({ kind: 'none', status: 'none', currentSha: null, approvedSha: null, approvedAndCurrent: false }),
      graphState: null,
    }));
    const r = await run(parent);
    expect(r.spawned).toBe(true);
  });

  it('a DISCARDED plan (planApprovalSha clears on plan.discarded) keeps rounds legal', async () => {
    const parent = makeParent(REVIEW_CALL, () => ({
      state: state({ status: 'superseded', approvedSha: null, approvedAndCurrent: false }),
      graphState: null,
    }));
    const r = await run(parent);
    expect(r.spawned).toBe(true);
  });

  it('an unreadable plan state fails CLOSED for reviewer groups now (an expensive consumable)', async () => {
    const parent = makeParent(REVIEW_CALL, () => {
      throw new Error('disk unhappy');
    });
    const r = await run(parent);
    expect(r.spawned).toBe(false);
    expect(r.text).toContain('reviewer rounds and plan bindings are blocked');
  });

  it('an EXPLORER group under the same invalidated approval is unaffected (nothing to gate)', async () => {
    const parent = makeParent(
      [
        { say: 'exploring', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'explorer', task: 'map the module' }] } }] },
        { say: 'done' },
      ],
      () => ({ state: state({ status: 'approved', approvedAndCurrent: false, diverged: true }), graphState: null }),
    );
    const r = await run(parent);
    expect(r.spawned).toBe(true);
  });
});
