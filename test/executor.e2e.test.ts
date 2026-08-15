import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { worktreeSupport } from '../src/git/worktree.js';
import { createApprovalForwarder } from '../src/runtime/approval-forwarder.js';
import { loadRegistry, registerWorktree, registryFile, sweepOrphanedWorktrees, worktreesRoot } from '../src/runtime/worktrees.js';
import { createDelegateTool, type ExecutorDeps, type PlanGateInfo } from '../src/tools/delegate.js';
import type { PlanState } from '../src/plan/canonical.js';
import { owedHarnessRefsFromEvents, pruneHarnessCheckpointRefs } from '../src/cli/assemble.js';
import { createApplyChangesTool, createTaskChangesRegistry, type TaskChangesRegistry } from '../src/tools/apply-changes.js';
import { startSession, endSession, runTurn, type Session } from '../src/runtime/session.js';
import { applyUndo } from '../src/runtime/undo.js';
import { EventLog } from '../src/store/event-log.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ApprovalOutcome, ApprovalRequest, SubagentRoleName, Tool } from '../src/types.js';
import type { SubagentDeps } from '../src/runtime/subagent.js';
import type { WorkspaceMap } from '../src/workspace/map.js';

/**
 * Stage C (V0.7): executor role end to end — approval forwarding, worktree isolation, change
 * capture, drift-refusing integration, deterministic cleanup. Real-git tests are skipped when
 * git is absent; the forwarder and registry are pure-unit.
 */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let repo: string;
let layout: ProjectLayout;
let savedEnv: Record<string, string | undefined>;
const MAP: WorkspaceMap = { text: 'a.txt\n', fileCount: 1, truncated: false, sha256: 'map-x' };

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-exec-')));
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

async function git(cwd: string, ...argv: string[]) {
  return runGit({ gitPath: REAL_GIT!, argv, cwd });
}
async function initRepo(dir: string): Promise<void> {
  expect((await git(dir, 'init', '-q', '-b', 'main')).ok).toBe(true);
}
async function commitAll(dir: string, message: string): Promise<void> {
  expect((await git(dir, 'add', '-A', '--', '.')).ok).toBe(true);
  expect((await git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', message)).ok).toBe(true);
}

describe('worktreeSupport gate', () => {
  it('accepts modern git, refuses old/unknown/unparseable (fail closed)', () => {
    expect(worktreeSupport('git version 2.43.0.windows.1').ok).toBe(true);
    expect(worktreeSupport('git version 2.20.0').ok).toBe(true);
    expect(worktreeSupport('git version 2.19.2').ok).toBe(false);
    expect(worktreeSupport('git version 1.9.5').ok).toBe(false);
    expect(worktreeSupport(null).ok).toBe(false);
    expect(worktreeSupport('mystery build').ok).toBe(false);
  });
});

describe('approval forwarder (serialized, signal-linked)', () => {
  function req(id: string): ApprovalRequest {
    return { callId: id, tool: 'run_command', classification: 'observe', summary: `cmd ${id}`, detail: '', reason: 'test' };
  }

  it('serializes concurrent asks FIFO through the base approver', async () => {
    const order: string[] = [];
    const forwarder = createApprovalForwarder(async (r) => {
      order.push(r.callId);
      await new Promise((res) => setTimeout(res, 10));
      return { decision: 'allow', scope: 'once', source: 'user' };
    });
    const [a, b, c] = await Promise.all([
      forwarder.ask(req('a'), undefined),
      forwarder.ask(req('b'), undefined),
      forwarder.ask(req('c'), undefined),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
    for (const o of [a, b, c]) expect(o.decision).toBe('allow');
  });

  it('an ask whose task died while QUEUED resolves task-aborted without ever displaying', async () => {
    let displayed = 0;
    let releaseFirst!: () => void;
    const forwarder = createApprovalForwarder(async () => {
      displayed++;
      await new Promise<void>((res) => {
        releaseFirst = res;
      });
      return { decision: 'allow', scope: 'once', source: 'user' };
    });
    const first = forwarder.ask(req('first'), undefined);
    const dead = new AbortController();
    const second = forwarder.ask(req('second'), dead.signal);
    dead.abort(); // dies while queued behind `first`
    expect(await second).toMatchObject({ decision: 'deny', source: 'task-aborted' });
    releaseFirst();
    expect((await first).decision).toBe('allow');
    expect(displayed).toBe(1); // the dead ask never reached the terminal
  });

  it('an ask aborted while DISPLAYED unblocks the child immediately; the late answer is discarded loudly', async () => {
    const info: string[] = [];
    let answer!: (o: ApprovalOutcome) => void;
    const forwarder = createApprovalForwarder(
      () => new Promise<ApprovalOutcome>((res) => {
        answer = res;
      }),
      (l) => info.push(l),
    );
    const dying = new AbortController();
    const pending = forwarder.ask(req('x'), dying.signal);
    await new Promise((r) => setTimeout(r, 5)); // let it display
    dying.abort();
    expect(await pending).toMatchObject({ decision: 'deny', source: 'task-aborted' });
    answer({ decision: 'allow', scope: 'once', source: 'user' }); // the human answers too late
    await new Promise((r) => setTimeout(r, 5));
    expect(info.join('\n')).toContain('answer discarded');
  });

  it('a throwing base approver fails closed and keeps serving later asks', async () => {
    let calls = 0;
    const forwarder = createApprovalForwarder(async () => {
      calls++;
      if (calls === 1) throw new Error('io exploded');
      return { decision: 'allow', scope: 'once', source: 'user' };
    });
    expect((await forwarder.ask(req('boom'), undefined)).decision).toBe('deny');
    expect((await forwarder.ask(req('next'), undefined)).decision).toBe('allow');
  });
});

/** Old-style status fixture → the Session 11 PlanGateInfo shape (display/gate tests only). */
function gateInfo(p: { status: 'none' | 'draft' | 'approved' | 'superseded' | 'unknown'; currentSha: string | null; approvedSha: string | null; diverged: boolean }): PlanGateInfo {
  return {
    state: {
      kind: p.status === 'none' ? 'none' : 'canonical',
      status: p.status,
      currentSha: p.currentSha,
      approvedSha: p.approvedSha,
      diverged: p.diverged,
      approvedAndCurrent: p.status === 'approved' && p.approvedSha !== null && p.currentSha === p.approvedSha,
      canonical: null,
      legacy: null,
    } as PlanState,
    graphState: null,
  };
}

describe.skipIf(!hasGit)('executor tasks end to end (real git)', () => {
  interface Harness {
    parent: Session;
    registry: TaskChangesRegistry;
    executorDeps: ExecutorDeps;
    forwarded: ApprovalRequest[];
    /** Task-base checkpoint refs the delegate tool reported (what assembly prunes at quit). */
    baseRefs: string[];
  }

  /** Parent session + delegate tool wired like assembly, with per-child scripted providers. */
  function makeHarness(opts: {
    parentScript: ScriptTurn[];
    childScripts: ScriptTurn[][];
    forwardOutcomes?: ApprovalOutcome[];
    planContext?: () => PlanGateInfo;
    /** Session 14: narrows the pre-integration checkpoint's untracked guard (decline-path tests). */
    checkpointUntrackedThreshold?: number;
  }): Harness {
    const registry = createTaskChangesRegistry();
    const forwarded: ApprovalRequest[] = [];
    const baseRefs: string[] = [];
    let forwardIdx = 0;
    const executorDeps: ExecutorDeps = {
      gitPath: REAL_GIT!,
      gitVersion: 'git version 2.40.0',
      repoRoot: repo,
      stateDir: layout.projectDir,
      worktreesRoot: path.join(tmp, 'wt-home'),
      registryFile: registryFile(layout.projectDir),
      snapshots: undefined as never, // set after the parent exists (shares its store)
      registerChanges: (id, baseOid, files) => registry.register(id, baseOid, files),
      noteBaseRef: (ref) => baseRefs.push(ref),
      clockIso: () => new Date(0).toISOString(),
    };
    const parent = startSession({
      workspaceRoot: repo,
      layout,
      model: 'mock-parent',
      mode: 'interactive',
      provider: new MockProvider(opts.parentScript),
      approver: autoDenyApprover,
      tools: [],
      saltHex: '00'.repeat(16),
      clock: fixedClock(0, 1),
      idGen: seededIdGen('parent'),
    });
    (executorDeps as { snapshots: unknown }).snapshots = parent.snapshots;
    const deps: SubagentDeps = {
      layout,
      workspaceRoot: repo,
      model: 'mock-child',
      maxTokens: 1000,
      provider: new MockProvider([{ say: 'unused fallback' }]),
      map: MAP,
      clock: fixedClock(0, 1),
      idGen: seededIdGen('child'),
      providerForTask: (index: number, _role: SubagentRoleName) => new MockProvider(opts.childScripts[index] ?? [{ say: 'no script' }]),
      forwardAsk: async (req) => {
        forwarded.push(req);
        return opts.forwardOutcomes?.[forwardIdx++] ?? { decision: 'allow', scope: 'once', source: 'user' };
      },
    };
    parent.tools = [
      createDelegateTool(deps, parent.id, executorDeps, {
        planContext: opts.planContext ?? (() => gateInfo({ status: 'none', currentSha: null, approvedSha: null, diverged: false })),
      }) as Tool,
      createApplyChangesTool(registry, parent.snapshots, {
        cctx: { gitPath: REAL_GIT!, repoRoot: repo, workspaceRoot: repo, stateDir: layout.projectDir },
        sessionId: parent.id,
        events: () => parent.log.events,
        ...(opts.checkpointUntrackedThreshold !== undefined ? { untrackedWarnThreshold: opts.checkpointUntrackedThreshold } : {}),
      }) as Tool,
    ];
    return { parent, registry, executorDeps, forwarded, baseRefs };
  }

  const EXEC_CALL = (task = 'apply the change') => ({
    name: 'delegate_task',
    input: { tasks: [{ role: 'executor', task }] },
  });

  it('S14.5 REGRESSION (live-found S14): core.autocrlf=true over an LF tree — the EOL pin makes captures appliable', async () => {
    // The S14 live E2E failure class: system autocrlf=true materialized CRLF worktrees over an
    // LF parent, so EVERY captured file refused at apply as base drift (and a matching base
    // would have written CRLF over LF). The suite's emptied global/system config HID this;
    // repo-local config reproduces it, the way the live machine's system config did.
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line one\nline two\n'); // LF on disk
    await commitAll(repo, 'base');
    expect((await git(repo, 'config', 'core.autocrlf', 'true')).ok).toBe(true);

    const h = makeHarness({
      parentScript: [
        { say: 'delegating', calls: [EXEC_CALL()] },
        { say: 'applying', calls: [{ name: 'apply_task_changes', input: { child_session_id: 'child-session-0001' } }] },
        { say: 'done' },
      ],
      childScripts: [
        [
          {
            say: 'writing',
            calls: [
              { name: 'edit_file', input: { path: 'a.txt', old_string: 'line two', new_string: 'line two EDITED' } },
              { name: 'write_file', input: { path: 'new.txt', content: 'created by executor\n' } },
            ],
          },
          { say: 'REPORT: edited a.txt, created new.txt.' },
        ],
      ],
    });
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });

    const r = await runTurn(h.parent, 'edit under autocrlf');
    expect(r.finalText).toBe('done');

    const events = h.parent.log.events;
    // The pin was announced in the delegate result (honest evidence of the changed config).
    const delegateReq = events.find((e) => e.type === 'tool.requested' && e.tool === 'delegate_task');
    const delegateCallId = delegateReq?.type === 'tool.requested' ? delegateReq.callId : '';
    const delegateDone = events.find((e) => e.type === 'tool.completed' && e.callId === delegateCallId);
    expect(delegateDone?.type === 'tool.completed' ? delegateDone.outputPreview : '').toContain('EOL pin active');
    // Every captured file APPLIED — zero drift refusals (the pre-fix behavior refused all).
    const appliedEv = events.find((e) => e.type === 'task.applied');
    expect(appliedEv).toBeDefined();
    if (appliedEv?.type === 'task.applied') {
      expect(appliedEv.refused).toEqual([]);
      expect([...appliedEv.applied].sort()).toEqual(['a.txt', 'new.txt']);
    }
    // The workspace file keeps the parent's LF form — no EOL flip attributed to the task.
    const bytes = fs.readFileSync(path.join(repo, 'a.txt'));
    expect(bytes.includes('\r')).toBe(false);
    expect(bytes.toString()).toContain('line two EDITED');
  });

  it('S14.5 (A-i): an EOL-only base mismatch refuses with the NORMALIZATION diagnosis, not generic drift', async () => {
    // The un-pinned path (mixed parents, old captures) keeps refusing — but the reason must
    // name the real cause, or it reads as unsatisfiable bookkeeping (the live-run experience).
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'eol.txt'), 'alpha\nbeta\n'); // parent holds LF
    await commitAll(repo, 'base');
    const { SnapshotStore } = await import('../src/store/snapshots.js');
    const snapshots = new SnapshotStore(layout.objectsDir);
    const registry = createTaskChangesRegistry();
    const baseSha = snapshots.putBlob(Buffer.from('alpha\r\nbeta\r\n')); // capture saw CRLF
    const afterSha = snapshots.putBlob(Buffer.from('alpha\r\nbeta EDITED\r\n'));
    registry.register('child-eol', 'f'.repeat(40), [
      { relPath: 'eol.txt', kind: 'modify', baseSha256: baseSha, blobSha256: afterSha, bytes: 14 },
    ]);
    const tool = createApplyChangesTool(registry, snapshots);
    const r = await tool.execute({ child_session_id: 'child-eol' }, { workspaceRoot: repo, stateDir: layout.projectDir });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('line-ending normalization mismatch');
    expect(r.output).toContain('EOL-pinned');
    expect(fs.readFileSync(path.join(repo, 'eol.txt')).toString()).toBe('alpha\nbeta\n'); // untouched
  });

  it('S14.5: probeEolPin pins uniform-LF-under-autocrlf only; CRLF/mixed and non-converting configs get no pin', async () => {
    const { probeEolPin } = await import('../src/git/worktree.js');
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    await commitAll(repo, 'lf base');

    // No autocrlf configured (the emptied global/system config) → no conversion → no pin.
    expect((await probeEolPin(REAL_GIT!, repo, '')).pinArgs).toEqual([]);

    expect((await git(repo, 'config', 'core.autocrlf', 'true')).ok).toBe(true);
    const pinned = await probeEolPin(REAL_GIT!, repo, '');
    expect(pinned.pinArgs).toEqual(['-c', 'core.autocrlf=false', '-c', 'core.eol=lf']);
    expect(pinned.detail).toContain('EOL pin active');

    // A CRLF file in the working tree makes the parent non-uniform → no pin (A-i diagnoses).
    fs.writeFileSync(path.join(repo, 'crlf.txt'), 'one\r\ntwo\r\n');
    expect((await git(repo, 'add', '-A', '--', '.')).ok).toBe(true);
    const mixed = await probeEolPin(REAL_GIT!, repo, '');
    expect(mixed.pinArgs).toEqual([]);
  });

  it('S14.5 (I7): the large-untracked guard ASKS through the forwarded channel; a deny refuses the group with the fix named', async () => {
    // Pre-fix behavior: any repo with >200 untracked files made ALL executor delegation
    // permanently impossible with an error that read as a git problem, while the SAME guard at
    // apply-time degraded gracefully — two call sites, opposite policies, neither chosen.
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    await commitAll(repo, 'base');
    for (let i = 0; i < 201; i++) fs.writeFileSync(path.join(repo, `untracked-${i}.txt`), 'x\n');

    const h = makeHarness({
      parentScript: [{ say: 'unused' }],
      childScripts: [[{ say: 'never runs' }]],
      forwardOutcomes: [{ decision: 'deny', scope: 'once', source: 'user' }],
    });
    const tool = h.parent.tools.find((t) => t.name === 'delegate_task')!;
    const r = await tool.execute({ tasks: [{ role: 'executor', task: 'x' }] } as never, { workspaceRoot: repo, stateDir: layout.projectDir });
    // The guard ask reached the forwarded channel with an honest summary…
    expect(h.forwarded.some((q) => q.summary.includes('UNTRACKED'))).toBe(true);
    // …and the deny refused the whole group, naming the gitignore exit; nothing spawned.
    expect(r.ok).toBe(false);
    expect(r.error).toContain('task-base checkpoint declined');
    expect(r.error).toContain('gitignore');
    expect(h.parent.log.events.some((e) => e.type === 'task.started')).toBe(false);
  });

  it('full flow: worktree isolation, capture, cleanup, apply, undo', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'committed\n');
    fs.writeFileSync(path.join(repo, 'doomed.txt'), 'delete me\n');
    await commitAll(repo, 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'DIRTY parent state\n'); // must reach the child via the base checkpoint

    const h = makeHarness({
      parentScript: [
        { say: 'delegating', calls: [EXEC_CALL()] },
        { say: 'applying', calls: [{ name: 'apply_task_changes', input: { child_session_id: 'child-session-0001' } }] },
        { say: 'done' },
      ],
      childScripts: [
        [
          { say: 'reading', calls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
          {
            say: 'writing',
            calls: [
              { name: 'write_file', input: { path: 'new.txt', content: 'created by executor\n' } },
              { name: 'edit_file', input: { path: 'a.txt', old_string: 'DIRTY parent state', new_string: 'EDITED by executor' } },
            ],
          },
          { say: 'REPORT: created new.txt, edited a.txt. Ran nothing — UNVERIFIED here.' },
        ],
      ],
    });
    // The delegate call is `ask` (mutating role) — the PARENT approver is autoDeny in this
    // harness, which would deny the spawn; drive the spawn approval through a scripted parent
    // approver instead.
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });

    const r1 = await runTurn(h.parent, 'improve the project');
    expect(r1.finalText).toBe('done');

    const events = h.parent.log.events;
    const started = events.find((e) => e.type === 'task.started');
    expect(started).toMatchObject({ role: 'executor' });
    const childId = started?.type === 'task.started' ? started.childSessionId : '';

    // The child worked in ISOLATION: parent workspace untouched by the child's own writes.
    // (The apply in turn 1 then landed them — verify the applied end state below.)
    const changes = events.find((e) => e.type === 'task.changes');
    expect(changes).toBeDefined();
    if (changes?.type === 'task.changes') {
      const byPath = new Map(changes.files.map((f) => [f.relPath, f]));
      expect(byPath.get('new.txt')).toMatchObject({ kind: 'create', baseSha256: null });
      expect(byPath.get('a.txt')).toMatchObject({ kind: 'modify' });
      expect(byPath.get('a.txt')!.baseSha256).not.toBeNull();
    }

    // The child saw the DIRTY parent state (the base checkpoint captured the working tree).
    const childLog = EventLog.readLenient(layout.sessionFile(childId)).events;
    const readCompleted = childLog.filter((e) => e.type === 'tool.completed')[0];
    expect(readCompleted?.type === 'tool.completed' ? readCompleted.outputPreview : '').toContain('DIRTY parent state');
    // The child's own log records mutations in the WORKTREE, not the workspace.
    const childMutation = childLog.find((e) => e.type === 'file.mutated');
    expect(childMutation?.type === 'file.mutated' ? childMutation.path : '').toContain('wt-home');

    // Worktree gone; registry empty; lifecycle events honest.
    expect(fs.existsSync(path.join(tmp, 'wt-home'))).toBe(true); // home dir may remain
    expect(fs.readdirSync(path.join(tmp, 'wt-home'))).toEqual([]); // but no worktrees inside
    expect(loadRegistry(registryFile(layout.projectDir))).toEqual([]);
    expect(events.find((e) => e.type === 'worktree.created')).toBeDefined();
    expect(events.find((e) => e.type === 'worktree.removed')).toMatchObject({ ok: true });

    // Apply landed through the snapshot-backed write path: bytes + file.mutated + one undo unit.
    expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('created by executor\n');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('EDITED by executor\n');
    const applied = events.find((e) => e.type === 'task.applied');
    expect(applied).toMatchObject({ childSessionId: childId, refused: [] });
    const parentMutations = events.filter((e) => e.type === 'file.mutated');
    expect(parentMutations.length).toBe(2);

    // /undo reverts the whole apply as one unit.
    const undo = applyUndo(h.parent.log.events, h.parent.snapshots, 'last');
    h.parent.log.append({ type: 'undo.applied', target: 'last', restored: undo.restored, refused: undo.refused });
    expect(undo.restored.map((x) => path.basename(x.path)).sort()).toEqual(['a.txt', 'new.txt']);
    expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('DIRTY parent state\n');

    endSession(h.parent, 'completed');
  });

  it('delete capture + apply-delete via direct capture (worktree file removed)', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
    fs.writeFileSync(path.join(repo, 'doomed.txt'), 'delete me\n');
    await commitAll(repo, 'base');
    const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();

    // Manual worktree: delete one file, modify another, capture directly.
    const wt = path.join(tmp, 'manual-wt');
    expect((await git(repo, 'worktree', 'add', '--detach', wt, head)).ok).toBe(true);
    fs.rmSync(path.join(wt, 'doomed.txt'));
    fs.writeFileSync(path.join(wt, 'a.txt'), 'task version\n');
    const { captureTaskChanges } = await import('../src/runtime/task-changes.js');
    const { SnapshotStore } = await import('../src/store/snapshots.js');
    const snapshots = new SnapshotStore(layout.objectsDir);
    const cap = await captureTaskChanges({ gitPath: REAL_GIT!, worktreeDir: wt, wsRel: '', baseOid: head, snapshots, scratchDir: layout.projectDir });
    expect(cap.error).toBeUndefined();
    const byPath = new Map(cap.files.map((f) => [f.relPath, f]));
    expect(byPath.get('doomed.txt')).toMatchObject({ kind: 'delete', blobSha256: null });
    expect(byPath.get('a.txt')).toMatchObject({ kind: 'modify' });

    // Apply both: the delete lands, the modify lands, one refusal-free integration. The
    // registry carries a simulated capture-cap omission — apply must re-state it (V0.7.1).
    const registry = createTaskChangesRegistry();
    registry.register('c-del', head, cap.files, 3);
    const tool = createApplyChangesTool(registry, snapshots);
    const ctx = { workspaceRoot: repo, stateDir: layout.projectDir };
    const result = await tool.execute({ child_session_id: 'c-del' } as never, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('3 changed file(s) were OMITTED at capture (over the file-count cap) and are NOT part of this apply');
    expect(fs.existsSync(path.join(repo, 'doomed.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('task version\n');
    expect((await git(repo, 'worktree', 'remove', '--force', wt)).ok).toBe(true);
  });

  it('drift refusal: a post-capture external edit is never overwritten', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n');
    await commitAll(repo, 'base');

    const h = makeHarness({
      parentScript: [{ say: 'delegating', calls: [EXEC_CALL('edit a.txt')] }, { say: 'captured' }],
      childScripts: [
        [
          {
            say: 'working',
            calls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'original', new_string: 'task version' } }],
          },
          { say: 'REPORT: edited a.txt' },
        ],
      ],
    });
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });
    await runTurn(h.parent, 'go');
    const changes = h.parent.log.events.find((e) => e.type === 'task.changes');
    const childId = changes?.type === 'task.changes' ? changes.childSessionId : '';
    expect(changes?.type === 'task.changes' ? changes.files : []).toHaveLength(1);

    // External drift AFTER capture: the workspace file no longer matches the task base.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'the user edited this meanwhile\n');

    const applyTool = h.parent.tools.find((t) => t.name === 'apply_task_changes')!;
    const ctx = { workspaceRoot: repo, stateDir: layout.projectDir };
    // Declared mutations honor the drift: nothing eligible ⇒ no snapshot targets.
    expect(applyTool.mutates({ child_session_id: childId } as never, ctx)).toEqual({ paths: [] });
    const result = await applyTool.execute({ child_session_id: childId } as never, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('REFUSED');
    expect(result.output).toContain('drift');
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('the user edited this meanwhile\n');
    endSession(h.parent, 'completed');
  });

  it('a forwarded deny-stop ends THAT task as user-stopped; the parent turn continues', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');

    const h = makeHarness({
      parentScript: [{ say: 'delegating', calls: [EXEC_CALL('try a command')] }, { say: 'turn survived' }],
      childScripts: [
        [
          { say: 'trying', calls: [{ name: 'run_command', input: { command: 'npm install' } }] },
          { say: 'unreachable' },
        ],
      ],
      forwardOutcomes: [{ decision: 'deny-stop', scope: 'once', source: 'user' }],
    });
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });

    const r = await runTurn(h.parent, 'go');
    expect(r.aborted).toBe(false);
    expect(r.finalText).toBe('turn survived');
    // The forwarded request carried the task identity for an answerable prompt.
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]!.taskContext).toMatchObject({ role: 'executor' });
    const ended = h.parent.log.events.find((e) => e.type === 'task.ended');
    expect(ended).toMatchObject({ status: 'user-stopped' });
    const childId = ended?.type === 'task.ended' ? ended.childSessionId : '';
    expect(EventLog.readLenient(layout.sessionFile(childId)).events.at(-1)).toMatchObject({ reason: 'aborted' });
    endSession(h.parent, 'completed');
  });

  it('an unapproved draft plan blocks executor groups (nothing spawns)', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');

    const h = makeHarness({
      parentScript: [{ say: 'delegating', calls: [EXEC_CALL()] }, { say: 'blocked' }],
      childScripts: [[{ say: 'must never run' }]],
      planContext: () => gateInfo({ status: 'draft', currentSha: 'a'.repeat(64), approvedSha: null, diverged: false }),
    });
    const prompts: ApprovalRequest[] = [];
    h.parent.approver = async (req) => {
      prompts.push(req);
      return { decision: 'allow', scope: 'once', source: 'user' };
    };
    const before = fs.readdirSync(layout.sessionsDir).filter((f) => f.endsWith('.jsonl')).length;
    await runTurn(h.parent, 'go');
    expect(h.parent.log.events.some((e) => e.type === 'task.started')).toBe(false);
    expect(fs.readdirSync(layout.sessionsDir).filter((f) => f.endsWith('.jsonl')).length).toBe(before);
    // The refusal reaches the MODEL as the tool_result error content.
    expect(JSON.stringify(h.parent.messages)).toContain('not approved');
    // The spawn ASK already told the human the plan was a draft (V0.7.1 consent surface).
    expect(prompts[0]!.detail).toContain('plan: DRAFT — executor tasks will refuse');
    endSession(h.parent, 'completed');
  });

  it('the executor spawn ask displays plan-approval state: matching, diverged, none, hand-edited', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');
    const shaA = 'a'.repeat(64);
    const shaB = 'b'.repeat(64);

    const cases: { plan: Parameters<typeof gateInfo>[0]; expectLine: string }[] = [
      {
        plan: { status: 'approved', currentSha: shaA, approvedSha: shaA, diverged: false },
        expectLine: `plan: APPROVED (sha ${shaA.slice(0, 12)}, matches the user-approved content)`,
      },
      {
        plan: { status: 'approved', currentSha: shaB, approvedSha: shaA, diverged: true },
        expectLine: `plan: APPROVED but DIVERGED after approval (approved ${shaA.slice(0, 12)}, current ${shaB.slice(0, 12)})`,
      },
      {
        plan: { status: 'none', currentSha: null, approvedSha: null, diverged: false },
        expectLine: 'plan: none — no plan document exists for this session',
      },
      {
        plan: { status: 'approved', currentSha: shaA, approvedSha: null, diverged: false },
        expectLine: 'no /plan approve is recorded this session',
      },
    ];
    for (const c of cases) {
      const h = makeHarness({
        parentScript: [{ say: 'delegating', calls: [EXEC_CALL()] }, { say: 'done' }],
        childScripts: [[{ say: 'child done' }]],
        planContext: () => gateInfo(c.plan),
      });
      const prompts: ApprovalRequest[] = [];
      h.parent.approver = async (req) => {
        prompts.push(req);
        return { decision: 'deny-stop', scope: 'once', source: 'user' }; // display test only; spawn nothing
      };
      await runTurn(h.parent, 'go');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.detail).toContain(c.expectLine);
      expect(prompts[0]!.detail).toContain('[executor]'); // the role/task lines are still there
      endSession(h.parent, 'completed');
    }
  });

  it('a throwing approvalContext never blocks the ask (display-only seam)', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');

    const h = makeHarness({
      parentScript: [{ say: 'delegating', calls: [EXEC_CALL()] }, { say: 'done' }],
      childScripts: [[{ say: 'child done' }]],
      planContext: () => {
        throw new Error('boom');
      },
    });
    const prompts: ApprovalRequest[] = [];
    h.parent.approver = async (req) => {
      prompts.push(req);
      return { decision: 'deny-stop', scope: 'once', source: 'user' };
    };
    await runTurn(h.parent, 'go');
    expect(prompts).toHaveLength(1); // the ask still happened
    expect(prompts[0]!.detail).toContain('[executor]'); // base detail intact, no plan line
    expect(prompts[0]!.detail).not.toContain('plan:');
    endSession(h.parent, 'completed');
  });

  it('sweep removes only registry entries under OUR worktrees root', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');
    const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();

    const root = worktreesRoot(layout.projectDir);
    const orphan = path.join(root, 'orphan-1');
    fs.mkdirSync(root, { recursive: true });
    expect((await git(repo, 'worktree', 'add', '--detach', orphan, head)).ok).toBe(true);
    const reg = registryFile(layout.projectDir);
    // Legacy entry shape (no owner/pid): always sweepable, exactly as before V0.7.1.
    await registerWorktree(reg, { dir: orphan, repoRoot: repo, childSessionId: 'c1', createdAt: 't' });
    // A hostile/corrupt entry pointing OUTSIDE our root must be dropped, never touched.
    const outside = path.join(tmp, 'precious');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete');
    await registerWorktree(reg, { dir: outside, repoRoot: repo, childSessionId: 'c2', createdAt: 't' });

    const swept = await sweepOrphanedWorktrees(layout.projectDir, REAL_GIT!);
    expect(swept.removed).toEqual([orphan]);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('do not delete'); // untouched
    expect(loadRegistry(reg)).toEqual([]); // both entries gone from the registry
  });

  it('sweep never removes a live sibling session\'s worktree — dead-pid and age-hatch rules', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');
    const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();

    const root = worktreesRoot(layout.projectDir);
    fs.mkdirSync(root, { recursive: true });
    const mk = async (name: string): Promise<string> => {
      const dir = path.join(root, name);
      expect((await git(repo, 'worktree', 'add', '--detach', dir, head)).ok).toBe(true);
      return dir;
    };
    const liveDir = await mk('live-1');
    const deadDir = await mk('dead-1');
    const agedDir = await mk('aged-1');
    const reg = registryFile(layout.projectDir);
    const nowIso = new Date().toISOString();
    // S22.5: 30h old — the shape of a live executor whose forwarded approval waited overnight.
    // The removed age hatch used to sweep this LIVE task's worktree; a live pid always skips now.
    const oldIso = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    await registerWorktree(reg, { dir: liveDir, repoRoot: repo, childSessionId: 'c1', createdAt: nowIso, ownerSessionId: 'sA', pid: 1111 });
    await registerWorktree(reg, { dir: deadDir, repoRoot: repo, childSessionId: 'c2', createdAt: nowIso, ownerSessionId: 'sB', pid: 2222 });
    await registerWorktree(reg, { dir: agedDir, repoRoot: repo, childSessionId: 'c3', createdAt: oldIso, ownerSessionId: 'sC', pid: 3333 });

    // 1111 and 3333 are "alive"; 2222 is dead. ONLY the dead entry sweeps — age never overrides.
    const swept = await sweepOrphanedWorktrees(layout.projectDir, REAL_GIT!, { isAlive: (pid) => pid !== 2222 });
    expect(swept.skippedLive.sort()).toEqual([agedDir, liveDir].sort());
    expect(swept.removed).toEqual([deadDir]);
    expect(fs.existsSync(liveDir)).toBe(true); // the live sibling's worktree is untouched
    expect(fs.existsSync(deadDir)).toBe(false);
    expect(fs.existsSync(agedDir)).toBe(true); // the overnight executor's uncaptured work survives
    // The live entries SURVIVE in the registry for their owners' own cleanup.
    expect(loadRegistry(reg).map((e) => e.dir).sort()).toEqual([agedDir, liveDir].sort());
  });

  it('task-base refs: tracked at spawn, session-end prune deletes + records, apply still works from blobs', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');

    const h = makeHarness({
      parentScript: [
        { say: 'delegating', calls: [EXEC_CALL('write out.txt')] },
        { say: 'captured' }, // turn 1 ends AFTER capture, before any apply
        { say: 'applying', calls: [{ name: 'apply_task_changes', input: { child_session_id: 'child-session-0001' } }] },
        { say: 'done' },
      ],
      childScripts: [
        [
          { say: 'writing', calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'made in worktree\n' } }] },
          { say: 'REPORT: wrote out.txt' },
        ],
      ],
    });
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });

    await runTurn(h.parent, 'go'); // spawn + capture
    expect(h.baseRefs).toHaveLength(1);
    expect(h.baseRefs[0]).toMatch(/^refs\/agent-cli\/checkpoints\//);
    expect((await git(repo, 'for-each-ref', 'refs/agent-cli/')).stdout).toContain(h.baseRefs[0]!);

    // Session 11.5: creation is EVIDENCE now — a resumed session re-derives the owed prune
    // list from the log, so a SIGKILL before the clean-quit prune no longer leaks the ref.
    expect(h.parent.log.events.find((e) => e.type === 'task.base-checkpoint')).toMatchObject({
      ref: h.baseRefs[0]!,
      oid: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(owedHarnessRefsFromEvents(h.parent.log.events)).toEqual(h.baseRefs.map((ref) => ({ ref, kind: 'task-base' })));

    // What assembly's pruneHarnessRefs does at session end: delete + record + summarize.
    const pruneResult = await pruneHarnessCheckpointRefs(
      REAL_GIT!,
      repo,
      h.baseRefs.map((ref) => ({ ref, kind: 'task-base' as const })),
      h.parent.log,
    );
    expect(pruneResult).toEqual({ line: 'pruned 1 task-base checkpoint ref(s)', failed: [] });
    expect((await git(repo, 'for-each-ref', 'refs/agent-cli/')).stdout.trim()).toBe('');
    expect(h.parent.log.events.at(-1)).toMatchObject({
      type: 'git.checkpoint.pruned',
      kind: 'task-base',
      refs: h.baseRefs,
      failed: [],
    });
    // After the recorded prune the event fold owes nothing — the crash-leak loop is closed.
    expect(owedHarnessRefsFromEvents(h.parent.log.events)).toEqual([]);

    // Empty owed list = nothing to do, no event, no line.
    const evCount = h.parent.log.events.length;
    expect(await pruneHarnessCheckpointRefs(REAL_GIT!, repo, [], h.parent.log)).toBeNull();
    expect(h.parent.log.events.length).toBe(evCount);

    // Integration AFTER the ref is gone: apply reads captured blobs, never git.
    await runTurn(h.parent, 'apply it');
    expect(fs.readFileSync(path.join(repo, 'out.txt'), 'utf8')).toBe('made in worktree\n');
    expect(h.parent.log.events.find((e) => e.type === 'task.applied')).toMatchObject({ refused: [] });
    endSession(h.parent, 'completed');
  });

  it('executors are honestly unavailable without a repo bundle', async () => {
    const h = makeHarness({
      parentScript: [{ say: 'delegating', calls: [EXEC_CALL()] }, { say: 'refused' }],
      childScripts: [[{ say: 'never' }]],
    });
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });
    // Simulate a non-repo assembly: rebuild the delegate tool WITHOUT executor deps.
    const depsNoExec: SubagentDeps = {
      layout,
      workspaceRoot: repo,
      model: 'mock-child',
      maxTokens: 1000,
      provider: new MockProvider([{ say: 'never' }]),
      map: MAP,
      clock: fixedClock(0, 1),
      idGen: seededIdGen('child2'),
    };
    h.parent.tools = [createDelegateTool(depsNoExec, h.parent.id) as Tool];
    await runTurn(h.parent, 'go');
    expect(JSON.stringify(h.parent.messages)).toContain('git repository');
    expect(h.parent.log.events.some((e) => e.type === 'task.started')).toBe(false);
    endSession(h.parent, 'completed');
  });

  it('pre-integration checkpoint (Session 14): fires only on covered changes, records event-before-ref, joins the owed fold', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');

    const h = makeHarness({
      parentScript: [
        { say: 'delegating', calls: [EXEC_CALL('write out.txt')] },
        { say: 'captured' }, // turn 1 ends after capture
        { say: 'applying', calls: [{ name: 'apply_task_changes', input: { child_session_id: 'child-session-0001' } }] },
        { say: 'first apply done' },
        { say: 'applying again', calls: [{ name: 'apply_task_changes', input: { child_session_id: 'child-session-0001' } }] },
        { say: 'second apply done' },
      ],
      childScripts: [
        [
          { say: 'writing', calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'made in worktree\n' } }] },
          { say: 'REPORT: wrote out.txt' },
        ],
      ],
    });
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });

    await runTurn(h.parent, 'go'); // spawn + capture: base checkpoint exists, nothing covering after it

    // A shell command SPAWNED since the base checkpoint — the one class of change per-file
    // snapshots structurally cannot cover. This is exactly what the rule keys on (the STARTED
    // event, so a crash mid-command — which never records an ended — still triggers it).
    h.parent.log.append({ type: 'command.started', callId: 'cmd-sim', pid: 4242, shell: 'pwsh', cwd: repo, timeoutMs: 1000 });

    await runTurn(h.parent, 'apply it');
    const hcs = h.parent.log.events.filter((e) => e.type === 'harness.checkpoint');
    expect(hcs).toHaveLength(1);
    const hc = hcs[0]!;
    if (hc.type !== 'harness.checkpoint') throw new Error('unreachable');
    expect(hc.kind).toBe('pre-integration');
    expect(hc.callId).toBeDefined(); // runtime-bound through reportTask
    expect((await git(repo, 'show-ref', '--verify', hc.ref)).ok).toBe(true);
    // The apply itself succeeded and mentioned the recovery point.
    expect(fs.readFileSync(path.join(repo, 'out.txt'), 'utf8')).toBe('made in worktree\n');
    const applyOut = h.parent.log.events.filter((e) => e.type === 'tool.completed' && e.outputPreview?.includes('pre-integration checkpoint:'));
    expect(applyOut.length).toBeGreaterThan(0);

    // REVIEW FIX: a second apply right after creates NO second checkpoint. The covered-change
    // set is exactly the SPAWN events; the first apply's own file.mutated events are
    // snapshot-backed by construction and were wrongly counted before, which made every apply
    // after the first pay a whole-tree capture over already-recoverable changes.
    await runTurn(h.parent, 'apply again');
    const hcs2 = h.parent.log.events.filter((e) => e.type === 'harness.checkpoint');
    expect(hcs2).toHaveLength(1);

    // Owed fold: pre-integration refs are session-scoped recovery state — owed like task-base.
    const owed = owedHarnessRefsFromEvents(h.parent.log.events);
    expect(owed).toContainEqual({ ref: hc.ref, kind: 'pre-integration' });
    const pruned = await pruneHarnessCheckpointRefs(REAL_GIT!, repo, owed, h.parent.log);
    expect(pruned?.line).toContain('pre-integration');
    expect(pruned?.failed).toEqual([]);
    expect((await git(repo, 'for-each-ref', 'refs/agent-cli/')).stdout.trim()).toBe('');
    endSession(h.parent, 'completed');
  });

  it('pre-integration checkpoint decline (large untracked set) SKIPS with a note and never refuses the apply', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await commitAll(repo, 'base');

    const h = makeHarness({
      checkpointUntrackedThreshold: 1,
      parentScript: [
        { say: 'delegating', calls: [EXEC_CALL('write out.txt')] },
        { say: 'captured' },
        { say: 'applying', calls: [{ name: 'apply_task_changes', input: { child_session_id: 'child-session-0001' } }] },
        { say: 'done' },
      ],
      childScripts: [
        [
          { say: 'writing', calls: [{ name: 'write_file', input: { path: 'out.txt', content: 'from task\n' } }] },
          { say: 'REPORT: wrote out.txt' },
        ],
      ],
    });
    h.parent.approver = async () => ({ decision: 'allow', scope: 'once', source: 'user' });
    await runTurn(h.parent, 'go');

    // Covering event + more untracked files than the narrowed threshold allows.
    h.parent.log.append({ type: 'command.started', callId: 'cmd-sim', pid: 4242, shell: 'pwsh', cwd: repo, timeoutMs: 1000 });
    fs.writeFileSync(path.join(repo, 'untracked-1.txt'), '1\n');
    fs.writeFileSync(path.join(repo, 'untracked-2.txt'), '2\n');

    await runTurn(h.parent, 'apply it');
    // Declined checkpoint: no harness.checkpoint event, no ref — but the apply LANDED.
    expect(h.parent.log.events.filter((e) => e.type === 'harness.checkpoint')).toHaveLength(0);
    expect((await git(repo, 'for-each-ref', 'refs/agent-cli/checkpoints/')).stdout).not.toContain('pre-integration');
    expect(fs.readFileSync(path.join(repo, 'out.txt'), 'utf8')).toBe('from task\n');
    const skipped = h.parent.log.events.filter((e) => e.type === 'tool.completed' && e.outputPreview?.includes('pre-integration checkpoint SKIPPED'));
    expect(skipped.length).toBeGreaterThan(0);
    expect(h.parent.log.events.find((e) => e.type === 'task.applied')).toMatchObject({ refused: [] });
    endSession(h.parent, 'completed');
  });
});
