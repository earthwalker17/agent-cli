import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { checkDagRules, createDelegateTool, delegateCapsFromEvents, type ExecutorDeps, type PlanGateInfo } from '../src/tools/delegate.js';
import { createApplyChangesTool, createTaskChangesRegistry } from '../src/tools/apply-changes.js';
import { registryFile } from '../src/runtime/worktrees.js';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { EventLog } from '../src/store/event-log.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import { PlanGraphSchema, planContentSha, type PlanGraph } from '../src/plan/schema.js';
import { readPlanState, setCanonicalStatus, writeCanonicalPlan, type PlanState } from '../src/plan/canonical.js';
import { foldGraphState } from '../src/plan/graph-state.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import type { SessionEvent, SubagentRoleName, Tool } from '../src/types.js';
import type { SubagentDeps } from '../src/runtime/subagent.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * Session 11: the task-DAG scheduler gate (R1–R9), events-rebuilt delegation caps, and the
 * complete wave flow — parallel disjoint executors → integration → the dependent unblocks —
 * against real git, with the REAL planContext wiring (readPlanState + foldGraphState).
 */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let repo: string;
let layout: ProjectLayout;
let savedEnv: Record<string, string | undefined>;
const MAP: WorkspaceMap = { text: 'a.txt\n', fileCount: 1, truncated: false, sha256: 'map-x' };

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-dag-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  layout = resolveLayout(repo, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
  const emptyCfg = path.join(tmp, 'empty-gitconfig');
  fs.writeFileSync(emptyCfg, '');
  savedEnv = { GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'], GIT_CONFIG_SYSTEM: process.env['GIT_CONFIG_SYSTEM'] };
  process.env['GIT_CONFIG_GLOBAL'] = emptyCfg;
  process.env['GIT_CONFIG_SYSTEM'] = emptyCfg;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Part A: the gate rules, pure ─────────────────────────────────────────────────────────────

const T = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `task ${id}`,
  intent: `do ${id}`,
  role: 'executor',
  verify: 'checks pass',
  ...over,
});

function graphOf(...tasks: Record<string, unknown>[]): PlanGraph {
  return PlanGraphSchema.parse({ objective: 'gate matrix', tasks });
}

let seq = 0;
const ev = (body: Record<string, unknown>): SessionEvent =>
  ({ v: 1, seq: ++seq, ts: '2026-07-24T00:00:00.000Z', ...body }) as unknown as SessionEvent;
const started = (planTaskId: string, child: string): SessionEvent =>
  ev({ type: 'task.started', callId: 'c', role: 'executor', childSessionId: child, budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 }, planTaskId });
const endedAs = (child: string, status: string): SessionEvent =>
  ev({ type: 'task.ended', callId: 'c', childSessionId: child, status, steps: 1, usage: { inputTokens: 0, outputTokens: 1 }, resultSha256: 'x', durationMs: 1 });
const changed = (child: string, relPath: string): SessionEvent =>
  ev({ type: 'task.changes', callId: 'c', childSessionId: child, baseOid: 'b', files: [{ relPath, kind: 'modify', baseSha256: 'x', blobSha256: 'y', bytes: 1 }] });
const appliedAll = (child: string, paths: string[]): SessionEvent =>
  ev({ type: 'task.applied', callId: 'c', childSessionId: child, applied: paths, refused: [] });

function activeGate(graph: PlanGraph, events: SessionEvent[] = []): PlanGateInfo {
  const sha = planContentSha(graph);
  const state: PlanState = {
    kind: 'canonical',
    status: 'approved',
    currentSha: sha,
    approvedSha: sha,
    diverged: false,
    approvedAndCurrent: true,
    canonical: {
      planId: 'p', file: 'p.plan.json', exists: true, status: 'approved', contentSha: sha, graph, updated: null, bytes: 1,
    },
    legacy: null,
  };
  return { state, graphState: foldGraphState(graph, events) };
}

const spec = (role: string, plan_task?: string): { role: string; plan_task?: string | undefined } =>
  plan_task !== undefined ? { role, plan_task } : { role };

describe('checkDagRules — the scheduler gate matrix (pure)', () => {
  it('R1: an unbound executor refuses while the approved DAG is active, naming ready ids and escape hatches', () => {
    const g = graphOf(T('t1'), T('t2', { dependsOn: ['t1'] }));
    const r = checkDagRules([spec('executor')], activeGate(g));
    expect(r).toContain('must name its plan task via "plan_task"');
    expect(r).toContain('ready executor tasks: t1');
    expect(r).toContain('amend the plan');
    // Read-only tasks never need a binding.
    expect(checkDagRules([spec('explorer')], activeGate(g))).toBeNull();
  });

  it('R2 unknown id / R3 role mismatch, with the defined ids named', () => {
    const g = graphOf(T('t1'), T('scan', { role: 'explorer', verify: '' }));
    expect(checkDagRules([spec('executor', 'ghost')], activeGate(g))).toContain("unknown plan task 'ghost' — the approved plan defines: t1, scan");
    expect(checkDagRules([spec('executor', 'scan')], activeGate(g))).toContain("plan role: explorer) but was requested as executor");
  });

  it('R4: unmet dependencies refuse with the dependency state named; satisfied deps pass', () => {
    const g = graphOf(T('t1'), T('t2', { dependsOn: ['t1'] }));
    expect(checkDagRules([spec('executor', 't2')], activeGate(g))).toContain("blocked: dependency 't1' is queued");

    const doneEvents = [started('t1', 'c1'), endedAs('c1', 'completed'), changed('c1', 'a.txt'), appliedAll('c1', ['a.txt'])];
    expect(checkDagRules([spec('executor', 't2')], activeGate(g, doneEvents))).toBeNull();

    // Completed-but-NOT-integrated does not satisfy: the dependent still refuses.
    const unapplied = [started('t1', 'c1'), endedAs('c1', 'completed'), changed('c1', 'a.txt')];
    expect(checkDagRules([spec('executor', 't2')], activeGate(g, unapplied))).toContain("'t1' is integrating");
  });

  it('R5/integrating: completed re-runs refuse; failed/cancelled/interrupted re-runs are allowed', () => {
    const g = graphOf(T('t1'));
    const done = [started('t1', 'c1'), endedAs('c1', 'completed'), changed('c1', 'a.txt'), appliedAll('c1', ['a.txt'])];
    expect(checkDagRules([spec('executor', 't1')], activeGate(g, done))).toContain('already completed and integrated');

    const integrating = [started('t1', 'c1'), endedAs('c1', 'completed'), changed('c1', 'a.txt')];
    expect(checkDagRules([spec('executor', 't1')], activeGate(g, integrating))).toContain('captured changes not yet fully applied');

    for (const status of ['error', 'timeout', 'stalled', 'cancelled', 'user-stopped']) {
      expect(checkDagRules([spec('executor', 't1')], activeGate(g, [started('t1', 'c1'), endedAs('c1', status)]))).toBeNull();
    }
    expect(checkDagRules([spec('executor', 't1')], activeGate(g, [started('t1', 'c1')]))).toBeNull(); // interrupted
  });

  it('R6 duplicate binding / R9 intra-group dependency / R8 serial and high-risk isolation', () => {
    const g = graphOf(T('t1'), T('t2', { dependsOn: ['t1'] }), T('s1', { serial: true }), T('h1', { risk: 'high' }), T('t3'));
    expect(checkDagRules([spec('executor', 't1'), spec('executor', 't1')], activeGate(g))).toContain('bound by more than one task in this group');
    // Grouping a dependent with its dependency gets the ACTIONABLE message (group rules run
    // before per-task state, which would otherwise always shadow R9 with "blocked").
    expect(checkDagRules([spec('executor', 't2'), spec('executor', 't1')], activeGate(g))).toContain('cannot run in parallel; sequence them across calls');
    expect(checkDagRules([spec('executor', 's1'), spec('executor', 't3')], activeGate(g))).toContain("'s1' is marked serial and must run alone");
    expect(checkDagRules([spec('executor', 'h1'), spec('executor', 't3')], activeGate(g))).toContain("'h1' is marked high risk and must run alone");
    // Alone, serial and high-risk tasks run fine.
    expect(checkDagRules([spec('executor', 's1')], activeGate(g))).toBeNull();
  });

  it('R7: overlapping declared touches refuse an executor pair; disjoint touches pass', () => {
    const g = graphOf(T('t1', { touches: ['src/core'] }), T('t2', { touches: ['src/core/deep'] }), T('t3', { touches: ['src/other'] }));
    expect(checkDagRules([spec('executor', 't1'), spec('executor', 't2')], activeGate(g))).toContain('overlapping touch prefixes (src/core)');
    expect(checkDagRules([spec('executor', 't1'), spec('executor', 't3')], activeGate(g))).toBeNull();
  });

  it('review F3: an approved plan whose document VANISHED refuses executors (never "no plan, no gate")', () => {
    const vanished: PlanGateInfo = {
      state: { kind: 'none', status: 'none', currentSha: null, approvedSha: 'a'.repeat(64), diverged: false, approvedAndCurrent: false, canonical: null, legacy: null },
      graphState: null,
    };
    expect(checkDagRules([spec('executor')], vanished)).toContain('document is now missing');
    // Read-only work continues — only executor authority is held back.
    expect(checkDagRules([spec('explorer')], vanished)).toBeNull();
  });

  it('bindings without an approved-and-current plan refuse honestly (none / unapproved)', () => {
    const none: PlanGateInfo = {
      state: { kind: 'none', status: 'none', currentSha: null, approvedSha: null, diverged: false, approvedAndCurrent: false, canonical: null, legacy: null },
      graphState: null,
    };
    expect(checkDagRules([spec('explorer', 't1')], none)).toContain('no plan document exists');

    const g = graphOf(T('t1'));
    const draft = activeGate(g);
    (draft.state as { approvedAndCurrent: boolean }).approvedAndCurrent = false;
    (draft.state as { status: string }).status = 'draft';
    expect(checkDagRules([spec('explorer', 't1')], draft)).toContain('enforced only against the user-approved plan');
    // Unbound groups stay ungated in both cases.
    expect(checkDagRules([spec('explorer')], none)).toBeNull();
    expect(checkDagRules([spec('explorer')], draft)).toBeNull();
  });
});

// ── Part B: caps rebuilt from events ─────────────────────────────────────────────────────────

describe('delegateCapsFromEvents — resume keeps counting', () => {
  it('counts task.started and sums child output tokens from task.ended', () => {
    seq = 0;
    const events = [
      started('t1', 'c1'),
      endedAs('c1', 'completed'),
      ev({ type: 'task.started', callId: 'c2', role: 'explorer', childSessionId: 'c2x', budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 } }),
      ev({ type: 'task.ended', callId: 'c2', childSessionId: 'c2x', status: 'completed', steps: 1, usage: { inputTokens: 5, outputTokens: 41 }, resultSha256: 'x', durationMs: 1 }),
    ];
    expect(delegateCapsFromEvents(events)).toEqual({ tasksStarted: 2, childOutputTokens: 42 });
  });

  it('a resumed session with 11 started tasks refuses a group of 2 whole (group-atomic)', async () => {
    const deps: SubagentDeps = {
      layout,
      workspaceRoot: repo,
      model: 'mock',
      maxTokens: 100,
      provider: new MockProvider([{ say: 'never runs' }]),
      map: MAP,
    };
    const tool = createDelegateTool(deps, 'parent-x', undefined, { caps: { tasksStarted: 11, childOutputTokens: 0 } });
    const r = await tool.execute(
      { tasks: [{ role: 'explorer', task: 'a' }, { role: 'explorer', task: 'b' }] } as never,
      { workspaceRoot: repo, stateDir: layout.projectDir },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('already delegated 11 of 12');
  });
});

// ── Crash/resume honesty ─────────────────────────────────────────────────────────────────────

describe('crash mid-group: the replay and the fold stay honest', () => {
  it('reconstruct names the plan task; the fold reports interrupted with the child-log pointer', async () => {
    const { reconstruct } = await import('../src/runtime/session.js');
    seq = 0;
    const graph = graphOf(T('t1'), T('t2', { dependsOn: ['t1'] }));
    const events = [
      ev({ type: 'user.message', text: 'go' }),
      ev({
        type: 'assistant.message',
        text: 'delegating',
        toolCalls: [{ id: 'c1', name: 'delegate_task', input: { tasks: [] } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      ev({ type: 'tool.requested', callId: 'c1', tool: 'delegate_task', input: {} }),
      ev({
        type: 'task.started',
        callId: 'c1', // must join the orphaned tool call, not the helper's synthetic id
        role: 'executor',
        childSessionId: 'child-crashed',
        budget: { maxSteps: 1, timeoutMs: 1, maxOutputTokens: 1 },
        planTaskId: 't1',
      }),
    ];
    const r = reconstruct(events, repo);
    const replay = JSON.stringify(r.messages);
    expect(replay).toContain("plan task 't1'");
    expect(replay).toContain('child-crashed');
    expect(r.orphanedCallIds).toContain('c1');

    const gs = foldGraphState(graph, events);
    expect(gs.byId.get('t1')).toMatchObject({ state: 'interrupted' });
    expect(gs.byId.get('t1')!.note).toContain('child-crashed');
    expect(gs.byId.get('t2')).toMatchObject({ state: 'blocked', blockedOn: ['t1'] });
    // Interrupted tasks stay re-spawnable — the recovery path after resume.
    expect(checkDagRules([spec('executor', 't1')], activeGate(graph, events))).toBeNull();
  });
});

// ── Part C: the wave flow against real git, with the REAL planContext wiring ────────────────

describe.skipIf(!hasGit)('task-graph execution end to end (real git)', () => {
  async function git(cwd: string, ...argv: string[]) {
    return runGit({ gitPath: REAL_GIT!, argv, cwd });
  }

  it('parallel disjoint wave → early dependent refused → integrate → hand-edit blocks → dependent runs → completed re-run refused', async () => {
    expect((await git(repo, 'init', '-q', '-b', 'main')).ok).toBe(true);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base-a\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'base-b\n');
    expect((await git(repo, 'add', '-A', '--', '.')).ok).toBe(true);
    expect((await git(repo, '-c', 'user.name=T', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', 'base')).ok).toBe(true);

    const registry = createTaskChangesRegistry();
    const parentScript: ScriptTurn[] = [
      { say: 'wave 1', calls: [{ name: 'delegate_task', input: { tasks: [
        { role: 'executor', task: 'write a', plan_task: 't1' },
        { role: 'executor', task: 'write b', plan_task: 't2' },
      ] } }] },
      { say: 'wave 1 done' },
      { say: 'trying t3 early', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'executor', task: 'edit a', plan_task: 't3' }] } }] },
      { say: 'saw the dependency refusal' },
      { say: 'applying', calls: [
        { name: 'apply_task_changes', input: { child_session_id: 'child-session-0001' } },
        { name: 'apply_task_changes', input: { child_session_id: 'child-session-0002' } },
      ] },
      { say: 'applied' },
      { say: 'trying t3 while diverged', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'executor', task: 'edit a', plan_task: 't3' }] } }] },
      { say: 'saw the divergence refusal' },
      { say: 'running t3', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'executor', task: 'edit a', plan_task: 't3' }] } }] },
      { say: 'applying t3', calls: [{ name: 'apply_task_changes', input: { child_session_id: 'child-session-0003' } }] },
      { say: 're-running t1', calls: [{ name: 'delegate_task', input: { tasks: [{ role: 'executor', task: 'again', plan_task: 't1' }] } }] },
      { say: 'saw the completed-rerun refusal' },
    ];
    const childScripts: ScriptTurn[][] = [
      [{ say: 'writing a', calls: [{ name: 'write_file', input: { path: 'a.txt', content: 'from-t1\n' } }] }, { say: 'REPORT t1: wrote a.txt; ran nothing — UNVERIFIED here.' }],
      [{ say: 'writing b', calls: [{ name: 'write_file', input: { path: 'b.txt', content: 'from-t2\n' } }] }, { say: 'REPORT t2: wrote b.txt; ran nothing — UNVERIFIED here.' }],
      [{ say: 'editing a', calls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'from-t1', new_string: 'from-t1-and-t3' } }] }, { say: 'REPORT t3: edited a.txt on top of t1; ran nothing — UNVERIFIED here.' }],
    ];
    let spawnCount = 0;

    const parent: Session = startSession({
      workspaceRoot: repo,
      layout,
      model: 'mock-parent',
      mode: 'interactive',
      provider: new MockProvider(parentScript),
      approver: autoDenyApprover,
      tools: [],
      saltHex: '00'.repeat(16),
      clock: fixedClock(0, 1),
      idGen: seededIdGen('parent'),
    });
    parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });

    // The REAL plan wiring: canonical plan on disk, user approval bound to the content sha.
    const graph = PlanGraphSchema.parse({
      objective: 'demo wave flow',
      tasks: [
        { id: 't1', title: 'write a', intent: 'produce a.txt', role: 'executor', verify: 'a.txt says from-t1', touches: ['a.txt'] },
        { id: 't2', title: 'write b', intent: 'produce b.txt', role: 'executor', verify: 'b.txt says from-t2', touches: ['b.txt'] },
        { id: 't3', title: 'edit a', intent: 'build on t1', role: 'executor', verify: 'a.txt says from-t1-and-t3', dependsOn: ['t1'], touches: ['a.txt'] },
      ],
    });
    const w = await writeCanonicalPlan(layout, parent.id, graph, parent.snapshots, fixedClock(0, 1));
    expect('error' in w).toBe(false);
    const a = await setCanonicalStatus(layout, parent.id, 'approved', parent.snapshots, fixedClock(0, 1));
    expect('error' in a).toBe(false);
    parent.log.append({ type: 'plan.approved', planId: parent.id, sha256: (a as { contentSha: string }).contentSha });

    const executorDeps: ExecutorDeps = {
      gitPath: REAL_GIT!,
      gitVersion: 'git version 2.40.0',
      repoRoot: repo,
      stateDir: layout.projectDir,
      worktreesRoot: path.join(tmp, 'wt-home'),
      registryFile: registryFile(layout.projectDir),
      snapshots: parent.snapshots,
      registerChanges: (id, baseOid, files) => registry.register(id, baseOid, files),
      noteBaseRef: () => {},
      clockIso: () => new Date(0).toISOString(),
    };
    const deps: SubagentDeps = {
      layout,
      workspaceRoot: repo,
      model: 'mock-child',
      maxTokens: 1000,
      provider: new MockProvider([{ say: 'unused' }]),
      map: MAP,
      clock: fixedClock(0, 1),
      idGen: seededIdGen('child'),
      providerForTask: (_i: number, _r: SubagentRoleName) => new MockProvider(childScripts[spawnCount++] ?? [{ say: 'no script' }]),
      forwardAsk: async () => ({ decision: 'allow', scope: 'once', source: 'user' }),
    };
    const planContext = (): PlanGateInfo => {
      const state = readPlanState(layout, parent.id, parent.log.events);
      const g = state.canonical?.graph ?? null;
      return { state, graphState: g !== null ? foldGraphState(g, parent.log.events) : null };
    };
    parent.tools = [
      createDelegateTool(deps, parent.id, executorDeps, { planContext, caps: { tasksStarted: 0, childOutputTokens: 0 } }) as Tool,
      createApplyChangesTool(registry, parent.snapshots) as Tool,
    ];

    // Wave 1: disjoint pair runs in parallel, both bound.
    expect((await runTurn(parent, 'start wave 1')).finalText).toBe('wave 1 done');
    const startedEvents = parent.log.events.filter((e) => e.type === 'task.started');
    expect(startedEvents).toHaveLength(2);
    // Parallel group: the two children's started events land in EITHER order.
    expect(startedEvents.map((e) => (e.type === 'task.started' ? e.planTaskId : '')).sort()).toEqual(['t1', 't2']);
    // Session 11.5: every bound spawn records the definition sha it ran as.
    for (const e of startedEvents) {
      expect(e.type === 'task.started' ? e.planTaskSha : undefined).toMatch(/^[0-9a-f]{64}$/);
    }

    // Early dependent: refused before anything spawns (R4 — t1 captured but not applied).
    expect((await runTurn(parent, 'try t3')).finalText).toBe('saw the dependency refusal');
    expect(parent.log.events.filter((e) => e.type === 'task.started')).toHaveLength(2);
    expect(JSON.stringify(parent.messages)).toContain('is integrating');

    // Integrate both captures.
    expect((await runTurn(parent, 'apply')).finalText).toBe('applied');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('from-t1\n');
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('from-t2\n');

    // Hand-edit divergence blocks executors; restoring the exact content re-enables (content identity).
    const planFile = layout.canonicalPlanFile(parent.id);
    const originalBytes = fs.readFileSync(planFile);
    const tampered = JSON.parse(originalBytes.toString('utf8')) as { plan: { objective: string } };
    tampered.plan.objective = 'tampered objective';
    fs.writeFileSync(planFile, JSON.stringify(tampered, null, 2));
    expect((await runTurn(parent, 'try t3 diverged')).finalText).toBe('saw the divergence refusal');
    expect(JSON.stringify(parent.messages)).toContain('DIVERGED');
    fs.writeFileSync(planFile, originalBytes);

    // The dependent now runs on a base that INCLUDES the integrated t1 (edit_file finds
    // from-t1), integrates, and the follow-up t1 re-run is refused (R5) — one scripted turn.
    expect((await runTurn(parent, 'run t3')).finalText).toBe('saw the completed-rerun refusal');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('from-t1-and-t3\n');
    expect(JSON.stringify(parent.messages)).toContain('already completed and integrated');
    expect(parent.log.events.filter((e) => e.type === 'task.started')).toHaveLength(3);

    // The final fold: every plan task completed, derived purely from evidence.
    const finalState = planContext();
    expect(finalState.graphState!.tasks.map((t) => `${t.id}:${t.state}`)).toEqual(['t1:completed', 't2:completed', 't3:completed']);

    // Every bound child log exists and carries lineage.
    for (const s of startedEvents) {
      if (s.type !== 'task.started') continue;
      const first = EventLog.readLenient(layout.sessionFile(s.childSessionId)).events[0];
      expect(first).toMatchObject({ type: 'session.started', lineage: { parentSessionId: parent.id } });
    }
    endSession(parent, 'completed');
  }, 120_000);
});
