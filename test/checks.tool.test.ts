import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECKS_PER_SESSION, checkCapsFromEvents, createRunCheckTool, type CheckCaps } from '../src/tools/run-check.js';
import { CHECK_KINDS } from '../src/types.js';
import { sha256 } from '../src/shared/hash.js';
import { startSession, endSession, runTurn, reconstruct } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { TOOLS } from '../src/tools/index.js';
import { EventLog } from '../src/store/event-log.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ApprovalOutcome, ApprovalRequest, Approver, CheckEvidence, SessionEvent, ToolContext } from '../src/types.js';

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-checktool-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A minimal but REAL Node project: the recipe table resolves `npm run <name>` against it. */
function nodeProject(scripts: Record<string, string>): void {
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }));
  fs.writeFileSync(path.join(ws, 'package-lock.json'), '{}');
  fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
}

function collectingCtx(): { ctx: ToolContext; evidence: CheckEvidence[] } {
  const evidence: CheckEvidence[] = [];
  return {
    evidence,
    ctx: { workspaceRoot: ws, stateDir: layout.projectDir, reportCheck: (e) => evidence.push(e) },
  };
}

function scriptedApprover(outcomes: ApprovalOutcome[]): { approver: Approver; calls: ApprovalRequest[] } {
  const calls: ApprovalRequest[] = [];
  let i = 0;
  const approver: Approver = async (req) => {
    calls.push(req);
    return outcomes[i++] ?? { decision: 'deny', scope: 'once', source: 'user' };
  };
  return { approver, calls };
}

function makeSession(script: ScriptTurn[], approver: Approver, caps: CheckCaps) {
  const checkTool = createRunCheckTool({ workspaceRoot: ws, caps });
  const session = startSession({
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
    tools: [...TOOLS, checkTool],
  });
  return { session, checkTool };
}

function readLog(id: string): SessionEvent[] {
  return EventLog.readLenient(layout.sessionFile(id)).events;
}

describe('run_check — the wire contract', () => {
  it('accepts exactly the shared CheckKind vocabulary', () => {
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    for (const kind of CHECK_KINDS) {
      expect(tool.schema.safeParse({ checks: [kind] }).success, kind).toBe(true);
    }
    expect(tool.schema.safeParse({ checks: ['deps'] }).success).toBe(false);
    expect(tool.schema.safeParse({ checks: [] }).success).toBe(false);
    expect(tool.schema.safeParse({ checks: ['test'], surprise: 1 }).success).toBe(false);
  });

  it('declares side effects as undeclarable — a build writes files it cannot enumerate', () => {
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    expect(tool.mutates({ checks: ['test'] }, { workspaceRoot: ws, stateDir: tmp })).toBeNull();
    expect(tool.command).toBeUndefined();
    expect(tool.delegates).toBeUndefined();
    expect(tool.planDoc).toBeUndefined();
  });

  it('resolves the check fact purely from its snapshot, with no filesystem read', () => {
    nodeProject({ test: 'node -e ""' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    // Change the project AFTER construction: the fact must still describe the snapshot, because
    // decide() is pure and the human must approve exactly what the gate saw.
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'other' } }));
    fs.writeFileSync(path.join(ws, 'pnpm-lock.yaml'), '');
    expect(tool.check!({ checks: ['test'] }).resolved[0]!.command).toBe('npm run test');
  });
});

describe('run_check — refusals that never spawn', () => {
  it('refuses when the resolved command changed after the gate, and runs nothing', async () => {
    nodeProject({ test: 'node -e ""' });
    const caps: CheckCaps = { checksRun: 0 };
    const tool = createRunCheckTool({ workspaceRoot: ws, caps });
    expect(tool.check!({ checks: ['test'] }).resolved[0]!.command).toBe('npm run test');

    // A different package manager changes the resolved command for the same kind.
    fs.writeFileSync(path.join(ws, 'pnpm-lock.yaml'), '');
    fs.rmSync(path.join(ws, 'package-lock.json'));

    const { ctx, evidence } = collectingCtx();
    const r = await tool.execute({ checks: ['test'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('the project changed after this call was approved');
    expect(r.output).toContain('npm run test');
    expect(r.output).toContain('pnpm run test');
    expect(evidence).toEqual([]);
    expect(caps.checksRun).toBe(0);
    // The snapshot advanced, so the NEXT call is gated on the new command and asks again.
    expect(tool.check!({ checks: ['test'] }).resolved[0]!.command).toBe('pnpm run test');
  });

  it('refuses when the session check budget is exhausted, and runs nothing', async () => {
    nodeProject({ test: 'node -e ""' });
    const caps: CheckCaps = { checksRun: CHECKS_PER_SESSION };
    const tool = createRunCheckTool({ workspaceRoot: ws, caps });
    const { ctx, evidence } = collectingCtx();
    const r = await tool.execute({ checks: ['test'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('budget is exhausted');
    expect(evidence).toEqual([]);
  });

  it('reports an unsupported kind WITHOUT a started event — nothing spawned, so nothing started', async () => {
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const { ctx, evidence } = collectingCtx();
    const r = await tool.execute({ checks: ['test'] }, ctx);
    // "Nothing could be checked here" is NOT a successful verification: ok stays false and the
    // error says so, or a report reader would see a bare `ok` for an action that never ran.
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no check ran');
    expect(r.output).toContain('UNSUPPORTED');
    expect(r.output).toContain('no supported project manifest');
    expect(evidence.length).toBe(1);
    expect(evidence[0]).toMatchObject({ kind: 'ended', check: 'test', status: 'unsupported' });
  });
});

describe('run_check — real execution and evidence', () => {
  it('runs a passing check, records started+completed evidence, and reports the verdict', async () => {
    nodeProject({ test: 'node -e "process.exit(0)"' });
    const caps: CheckCaps = { checksRun: 0 };
    const tool = createRunCheckTool({ workspaceRoot: ws, caps });
    const { ctx, evidence } = collectingCtx();
    const r = await tool.execute({ checks: ['test'], plan_task: 'build-api' }, ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toContain('[PASS]');
    expect(caps.checksRun).toBe(1);
    expect(evidence[0]).toMatchObject({ kind: 'started', check: 'test', command: 'npm run test', planTaskId: 'build-api' });
    expect(evidence[1]).toMatchObject({ kind: 'ended', check: 'test', status: 'pass', exitCode: 0, termination: 'exited', planTaskId: 'build-api' });
  }, 60_000);

  it('runs a failing check and reports FAIL with the exit code — never a pass', async () => {
    nodeProject({ test: 'node -e "console.error(\'boom\'); process.exit(1)"' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const { ctx, evidence } = collectingCtx();
    const r = await tool.execute({ checks: ['test'] }, ctx);

    expect(r.ok).toBe(false);
    expect(r.error).toContain('test=fail');
    expect(r.output).toContain('[FAIL]');
    expect(r.output).toContain('output (tail)');
    const ended = evidence.find((e) => e.kind === 'ended');
    expect(ended).toMatchObject({ status: 'fail', termination: 'exited' });
    expect((ended as Extract<CheckEvidence, { kind: 'ended' }>).exitCode).not.toBe(0);
  }, 60_000);

  it('spills the SAME string it hashed, so the runtime can actually store the blob', async () => {
    // Review finding: truncateForModel ran over the excerpted model text while fullOutput carried
    // the raw text, so sha(fullOutput) never equalled the recorded fullOutputSha256. The runtime
    // verifies that equality before storing — the blob was written, rejected, and orphaned, and
    // the recorded sha pointed at bytes nothing could resolve.
    const noisy = 'x'.repeat(200);
    nodeProject({ test: `node -e "for(let i=0;i<200;i++)console.log('${noisy}')"` });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const { ctx } = collectingCtx();
    const r = await tool.execute({ checks: ['test'] }, ctx);
    expect(r.truncated).toBe(true);
    expect(r.fullOutputSha256).toBeDefined();
    expect(r.fullOutput).toBeDefined();
    expect(sha256(r.fullOutput!)).toBe(r.fullOutputSha256);
  }, 60_000);

  it('refuses a malformed request outright instead of recording it as "unsupported"', async () => {
    // Review finding: `test-targeted` with no scope resolved to `unsupported`, which a declared
    // gate then treated as a waiver — a routine caller mistake could retire real verification.
    nodeProject({ test: 'node -e ""' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const { ctx, evidence } = collectingCtx();
    const r = await tool.execute({ checks: ['test-targeted'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid check request');
    expect(r.output).toContain('never be mistaken');
    expect(evidence).toEqual([]);
  });

  it('mixes supported and unsupported kinds in one call honestly', async () => {
    nodeProject({ test: 'node -e ""' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const { ctx } = collectingCtx();
    const r = await tool.execute({ checks: ['test', 'lint'] }, ctx);
    expect(r.output).toContain('lint=unsupported');
    expect(r.output).toContain('test=pass');
  }, 60_000);
});

describe('run_check — through runTurn (approval, policy, persistence)', () => {
  it('shows every resolved command in the approval prompt and offers replay consent', async () => {
    nodeProject({ test: 'node -e ""', typecheck: 'node -e ""' });
    const { approver, calls } = scriptedApprover([{ decision: 'allow', scope: 'once', source: 'user' }]);
    const { session } = makeSession(
      [{ say: 'verifying', calls: [{ name: 'run_check', input: { checks: ['test', 'typecheck'] } }] }, { say: 'done' }],
      approver,
      { checksRun: 0 },
    );
    await runTurn(session, 'verify');
    endSession(session, 'completed');

    expect(calls.length).toBe(1);
    expect(calls[0]!.kind).toBe('check');
    expect(calls[0]!.summary).toContain('typecheck');
    expect(calls[0]!.detail).toContain('npm run test');
    expect(calls[0]!.detail).toContain('npm run typecheck');
    expect(calls[0]!.noUndoWarning).toBe(true);

    const events = readLog(session.id);
    const decision = events.find((e) => e.type === 'policy.decision');
    expect(decision).toMatchObject({ decision: 'ask', rule: 'check.approval-required', classification: 'reversible' });
    expect(events.filter((e) => e.type === 'check.started').length).toBe(2);
    expect(events.filter((e) => e.type === 'check.completed' && e.status === 'pass').length).toBe(2);
  }, 60_000);

  it('a session-scope approval lets the SAME command re-run without asking again', async () => {
    nodeProject({ test: 'node -e ""' });
    const { approver, calls } = scriptedApprover([{ decision: 'allow', scope: 'session', source: 'user' }]);
    const { session } = makeSession(
      [
        { say: 'first', calls: [{ name: 'run_check', input: { checks: ['test'] } }] },
        { say: 'second', calls: [{ name: 'run_check', input: { checks: ['test'] } }] },
        { say: 'done' },
      ],
      approver,
      { checksRun: 0 },
    );
    await runTurn(session, 'verify twice');
    endSession(session, 'completed');

    expect(calls.length).toBe(1);
    const rules = readLog(session.id)
      .filter((e): e is Extract<SessionEvent, { type: 'policy.decision' }> => e.type === 'policy.decision')
      .map((e) => e.rule);
    expect(rules).toEqual(['check.approval-required', 'check.replay-consent']);
  }, 60_000);

  it('a denied check runs nothing and records the denial', async () => {
    nodeProject({ test: 'node -e ""' });
    const { approver } = scriptedApprover([{ decision: 'deny', scope: 'once', source: 'user' }]);
    const { session } = makeSession(
      [{ say: 'verifying', calls: [{ name: 'run_check', input: { checks: ['test'] } }] }, { say: 'done' }],
      approver,
      { checksRun: 0 },
    );
    await runTurn(session, 'verify');
    endSession(session, 'completed');

    const events = readLog(session.id);
    expect(events.some((e) => e.type === 'check.started')).toBe(false);
    expect(events.some((e) => e.type === 'approval.resolved' && e.decision === 'deny')).toBe(true);
  }, 60_000);
});

describe('run_check — caps and crash replay', () => {
  it('rebuilds the session check counter from events (a resumed session keeps counting)', () => {
    const ev = (body: Record<string, unknown>): SessionEvent => ({ v: 1, seq: 1, ts: 't', ...body }) as unknown as SessionEvent;
    const events = [
      // A normal run: started + completed, counted once.
      ev({ type: 'check.started', callId: 'c1', check: 'test', recipeId: 'r', command: 'x', cwd: '.', timeoutMs: 1 }),
      ev({ type: 'check.completed', callId: 'c1', check: 'test', recipeId: 'r', status: 'pass', exitCode: 0, durationMs: 1, summary: 's' }),
      // Interrupted mid-run (no completion) — it still consumed a run.
      ev({ type: 'check.started', callId: 'c2', check: 'lint', recipeId: 'r', command: 'x', cwd: '.', timeoutMs: 1 }),
      // Spawn failure (no start event) — it also consumed a run.
      ev({ type: 'check.completed', callId: 'c3', check: 'build', recipeId: 'r', status: 'error', exitCode: null, termination: 'spawn-error', durationMs: 1, summary: 's' }),
      // Unsupported never ran and must not consume the budget.
      ev({ type: 'check.completed', callId: 'c4', check: 'format', recipeId: '(none)', status: 'unsupported', exitCode: null, durationMs: 0, summary: 's' }),
    ];
    expect(checkCapsFromEvents(events)).toEqual({ checksRun: 3 });
  });

  it('replays an interrupted check as having produced NO verdict', () => {
    const ev = (seq: number, body: Record<string, unknown>): SessionEvent => ({ v: 1, seq, ts: 't', ...body }) as unknown as SessionEvent;
    const events = [
      ev(1, {
        type: 'assistant.message',
        text: '',
        toolCalls: [{ id: 'c1', name: 'run_check', input: { checks: ['build'] } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      ev(2, { type: 'tool.requested', callId: 'c1', tool: 'run_check', input: { checks: ['build'] } }),
      ev(3, { type: 'check.started', callId: 'c1', check: 'build', recipeId: 'node.script.build', command: 'npm run build', cwd: ws, timeoutMs: 1000 }),
    ];
    const r = reconstruct(events, ws);
    const last = r.messages[r.messages.length - 1]!;
    const text = JSON.stringify(last.content);
    expect(text).toContain('produced no verdict');
    expect(text).toContain('build');
    expect(r.orphanedCallIds).toContain('c1');
  });
});
