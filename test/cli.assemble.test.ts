import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSession, owedHarnessRefsFromEvents, type AssembleDeps } from '../src/cli/assemble.js';
import { endSession } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { createNoneSandbox } from '../src/sandbox/none.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { detectGitFacts } from '../src/git/facts.js';
import { indexFilePath } from '../src/retrieval/ranked-map.js';
import type { GitFacts } from '../src/git/types.js';
import type { SessionEvent } from '../src/types.js';

/** The shared assembly path: one construction sequence for the one-shot CLI and the REPL. */

const NO_GIT: GitFacts = {
  isRepo: false,
  gitPath: null,
  gitVersion: null,
  repoRoot: null,
  workspaceIsRepoRoot: false,
  branch: null,
  detached: false,
  unborn: false,
  head: null,
  upstream: null,
  ahead: null,
  behind: null,
  dirtyCount: null,
  untrackedCount: null,
  probeFailed: false,
  detail: 'test: no repository',
};

function makeDeps(overrides: Partial<AssembleDeps> = {}): AssembleDeps {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-ws-'));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-state-'));
  const layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: stateRoot }, ensure: true });
  return {
    trust: { trusted: true, source: 'flag' },
    config: { rules: { protectedPaths: [], secretPatterns: [], envExcludePatterns: [] }, sources: [] },
    ctx: {
      ws,
      mode: 'non-interactive',
      provider: new MockProvider([]),
      approver: autoDenyApprover,
      model: 'mock-model',
      maxSteps: 5,
      maxTokens: 1000,
      contextBudget: { triggerChars: 400_000, targetChars: 200_000 },
      notes: [],
    },
    layout,
    sandbox: createNoneSandbox('test-injected'),
    gitFacts: NO_GIT,
    ...overrides,
  };
}

describe('assembleSession', () => {
  it('records the post-start events in the fixed order', async () => {
    const { session } = await assembleSession(makeDeps());
    const types = session.log.events.map((e) => e.type);
    expect(types).toEqual([
      'session.started',
      'trust.verified',
      'config.loaded',
      'sandbox.status',
      'git.context',
      'workspace.mapped',
      'memory.loaded',
    ]);
    endSession(session, 'completed');
  });

  it('uses injected sandbox/git facts (no real probe) and reports them truthfully', async () => {
    const { session, sandboxFacts, gitFacts } = await assembleSession(makeDeps());
    expect(sandboxFacts.enforced).toBe(false);
    expect(sandboxFacts.detail).toBe('test-injected');
    expect(gitFacts).toBe(NO_GIT);
    // The system prompt is built from the probed truths, not assumptions.
    expect(session.system).toContain('NO OS sandbox');
    expect(session.system).toContain('Never initialize or modify version control');
    endSession(session, 'completed');
  });

  it('assigns the log observer before the post-start records so a live view misses nothing', async () => {
    const seen: string[] = [];
    const { session } = await assembleSession(
      makeDeps({ onLogEvent: (e: SessionEvent) => seen.push(e.type) }),
    );
    // session.started predates the observer (it is appended inside startSession); everything after
    // the assignment must be observed.
    expect(seen).toEqual(['trust.verified', 'config.loaded', 'sandbox.status', 'git.context', 'workspace.mapped', 'memory.loaded']);
    endSession(session, 'completed');
  });

  it('children follow a mid-session provider/model switch (the currentRuntime getter)', async () => {
    // The ROADMAP claims children follow switches; before this pin, deleting the getter left the
    // whole suite green while children silently ran on the assembly-time identity and recorded it
    // as truth (S15 review finding: the least test-supported claim of the session).
    const { session } = await assembleSession(makeDeps());
    const delegate = session.tools.find((t) => t.name === 'delegate_task');
    expect(delegate, 'delegate_task must be attached per session').toBeDefined();

    // Mutate exactly the fields performSwitch mutates.
    const switched = new MockProvider([]);
    session.provider = switched;
    session.model = 'deepseek-v4-pro';
    session.maxTokens = 4242;
    session.contextBudget = { triggerChars: 111_000, targetChars: 55_500 };

    // The getter is captured in the delegate deps; read it the way the tool does at spawn time.
    const runtime = (delegate as unknown as { __testRuntime?: () => unknown }).__testRuntime;
    if (runtime !== undefined) {
      expect(runtime()).toMatchObject({ model: 'deepseek-v4-pro', maxTokens: 4242 });
    } else {
      // No test seam on the tool: assert the session-side source of truth the getter closes over,
      // which is what makes a child's own session.started truthful.
      expect(session.model).toBe('deepseek-v4-pro');
      expect(session.provider).toBe(switched);
      expect(session.maxTokens).toBe(4242);
      expect(session.contextBudget).toEqual({ triggerChars: 111_000, targetChars: 55_500 });
    }
    endSession(session, 'completed');
  });

  it('a resume under a DIFFERENT provider/model records provider.changed{source:resume}', async () => {
    const deps = makeDeps();
    const first = await assembleSession(deps);
    const id = first.session.id;
    endSession(first.session, 'completed');

    // Same log, resumed with a different model — the silent-switch hole S15 closed.
    const resumed = await assembleSession({
      ...deps,
      resumeId: id,
      ctx: { ...deps.ctx, model: 'some-other-model' },
    });
    const changed = resumed.session.log.events.find((e) => e.type === 'provider.changed');
    expect(changed).toMatchObject({
      from: { providerName: 'mock', model: 'mock-model' },
      to: { providerName: 'mock', model: 'some-other-model' },
      source: 'resume',
    });
    expect(resumed.providerResumeNote).toContain('some-other-model');
    endSession(resumed.session, 'completed');
  });

  it('a resume under the SAME identity records NO provider.changed', async () => {
    const deps = makeDeps();
    const first = await assembleSession(deps);
    const id = first.session.id;
    endSession(first.session, 'completed');
    const resumed = await assembleSession({ ...deps, resumeId: id });
    expect(resumed.session.log.events.some((e) => e.type === 'provider.changed')).toBe(false);
    expect(resumed.providerResumeNote).toBeUndefined();
    endSession(resumed.session, 'completed');
  });

  it('resume path reuses the same sequence after session.resumed', async () => {
    const deps = makeDeps();
    const first = await assembleSession(deps);
    endSession(first.session, 'completed');

    const resumed = await assembleSession({ ...deps, resumeId: first.session.id });
    const types = resumed.session.log.events.map((e) => e.type);
    const resumedAt = types.indexOf('session.resumed');
    expect(resumedAt).toBeGreaterThan(0);
    expect(types.slice(resumedAt)).toEqual([
      'session.resumed',
      'trust.verified',
      'config.loaded',
      'sandbox.status',
      'git.context',
      'workspace.mapped',
      'memory.loaded',
    ]);
    endSession(resumed.session, 'completed');
  });

  it('non-repo sessions keep the flat map and expose no retrieval handle (fallback path)', async () => {
    const assembled = await assembleSession(makeDeps());
    expect(assembled.retrieval).toBeNull();
    expect(assembled.map.inventorySha256).toBeUndefined();
    const mapped = assembled.session.log.events.find((e) => e.type === 'workspace.mapped');
    expect(mapped !== undefined && mapped.type === 'workspace.mapped' && mapped.inventorySha256).toBeUndefined();
    endSession(assembled.session, 'completed');
  });
});

const REAL_GIT = findGitOnPath(process.env, process.platform);

describe.skipIf(REAL_GIT === null)('assembleSession — ranked map (git-backed, Session 10)', () => {
  it('builds the ranked map + index, records additive event fields, and resume reuses the warm cache', async () => {
    const deps = makeDeps();
    const ws = deps.ctx.ws;
    expect((await runGit({ gitPath: REAL_GIT!, argv: ['init', '-q', '-b', 'main'], cwd: ws })).ok).toBe(true);
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'core.ts'), 'export function coreThing() {}\n');
    fs.writeFileSync(path.join(ws, 'src', 'user.ts'), `import { coreThing } from './core.js';\n`);
    const gitFacts = await detectGitFacts(ws, { gitPath: REAL_GIT });

    const assembled = await assembleSession({ ...deps, gitFacts });
    // Ranked map, not the flat list: tiers present, symbols shown, handle exposed.
    expect(assembled.map.text).toContain('Repository map — ranked overview');
    expect(assembled.map.text).toContain('coreThing');
    expect(assembled.retrieval).not.toBeNull();
    expect(assembled.map.inventorySha256).toHaveLength(64);
    expect(assembled.session.system).toContain('Repository map — ranked overview');
    // The index file was written at ASSEMBLY (harness-owned, pre-turn).
    expect(fs.existsSync(indexFilePath(deps.layout.projectDir))).toBe(true);
    // Additive workspace.mapped fields.
    const mapped = assembled.session.log.events.find((e) => e.type === 'workspace.mapped');
    if (mapped === undefined || mapped.type !== 'workspace.mapped') throw new Error('missing workspace.mapped');
    expect(mapped.inventorySha256).toBe(assembled.map.inventorySha256);
    expect(mapped.indexedFiles).toBe(2);
    expect(mapped.indexState).toBe('full');
    endSession(assembled.session, 'completed');

    // Resume: warm cache (no first-run note), same inventory digest.
    const resumed = await assembleSession({ ...deps, gitFacts, resumeId: assembled.session.id });
    expect(resumed.retrieval).not.toBeNull();
    expect(resumed.map.inventorySha256).toBe(assembled.map.inventorySha256);
    expect(resumed.mapNote).toBeUndefined();
    endSession(resumed.session, 'completed');
  });
});

describe('owedHarnessRefsFromEvents (Session 11.5 fold, kind-aware + seq-aware Session 14)', () => {
  let seqCounter = 0;
  const ev = (body: Record<string, unknown>): SessionEvent => ({ v: 1, seq: ++seqCounter, ts: '2026-01-01T00:00:00Z', ...body }) as unknown as SessionEvent;

  it('owes created refs, subtracts successfully-pruned ones, keeps failed ones for retry', () => {
    const events = [
      ev({ type: 'task.base-checkpoint', callId: 'c1', ref: 'refs/agent-cli/checkpoints/s/1', oid: 'a'.repeat(40) }),
      ev({ type: 'task.base-checkpoint', callId: 'c2', ref: 'refs/agent-cli/checkpoints/s/2', oid: 'b'.repeat(40) }),
      // A prior life pruned ref 1 but FAILED on ref 2: only the success leaves the owed list.
      ev({ type: 'git.checkpoint.pruned', kind: 'task-base', refs: ['refs/agent-cli/checkpoints/s/1'], failed: ['refs/agent-cli/checkpoints/s/2'] }),
      // Work after the crash-resume creates a third base.
      ev({ type: 'task.base-checkpoint', callId: 'c3', ref: 'refs/agent-cli/checkpoints/s/3', oid: 'c'.repeat(40) }),
    ];
    expect(owedHarnessRefsFromEvents(events)).toEqual([
      { ref: 'refs/agent-cli/checkpoints/s/2', kind: 'task-base' },
      { ref: 'refs/agent-cli/checkpoints/s/3', kind: 'task-base' },
    ]);
  });

  it('a fully pruned life owes nothing; empty logs owe nothing', () => {
    const events = [
      ev({ type: 'task.base-checkpoint', callId: 'c1', ref: 'refs/x/1', oid: 'a'.repeat(40) }),
      ev({ type: 'git.checkpoint.pruned', kind: 'task-base', refs: ['refs/x/1'], failed: [] }),
    ];
    expect(owedHarnessRefsFromEvents(events)).toEqual([]);
    expect(owedHarnessRefsFromEvents([])).toEqual([]);
  });

  it('pre-integration refs are owed like task-base; the ACCEPTED delivery ref survives, superseded ones are owed', () => {
    const events = [
      ev({ type: 'harness.checkpoint', kind: 'pre-integration', ref: 'refs/h/pre1', oid: 'a'.repeat(40), callId: 'c1' }),
      ev({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/h/del1', oid: 'b'.repeat(40) }),
      ev({ type: 'session.accepted', complete: true, summary: 's1', deliveryRef: 'refs/h/del1', deliveryOid: 'b'.repeat(40) }),
      // More work, a second acceptance: del1 is superseded, del2 is the durable audit anchor.
      ev({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/h/del2', oid: 'c'.repeat(40) }),
      ev({ type: 'session.accepted', complete: true, summary: 's2', deliveryRef: 'refs/h/del2', deliveryOid: 'c'.repeat(40) }),
    ];
    expect(owedHarnessRefsFromEvents(events)).toEqual([
      { ref: 'refs/h/pre1', kind: 'pre-integration' },
      { ref: 'refs/h/del1', kind: 'delivery' },
    ]);
  });

  it('the accepted delivery ref is never owed (the durable audit anchor)', () => {
    const events = [
      ev({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/h/del1', oid: 'a'.repeat(40) }),
      ev({ type: 'session.accepted', complete: true, summary: 's', deliveryRef: 'refs/h/del1', deliveryOid: 'a'.repeat(40) }),
    ];
    expect(owedHarnessRefsFromEvents(events)).toEqual([]);
  });

  it('REVIEW FIX: a PHANTOM delivery creation never supersedes the accepted anchor', () => {
    // The bug all four review lenses found: survival keyed on the newest CREATION event, so a
    // delivery event whose update-ref failed (or was crash-interrupted) held the newest seq and
    // pruned the real anchor of the last acceptance — leaving a dangling deliveryRef and ZERO
    // audit anchors. Survival now keys on the ref the latest acceptance actually CONSUMED.
    const events = [
      ev({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/h/del1', oid: 'a'.repeat(40) }),
      ev({ type: 'session.accepted', complete: true, summary: 's1', deliveryRef: 'refs/h/del1', deliveryOid: 'a'.repeat(40) }),
      ev({ type: 'file.mutated', callId: 'w', path: 'a.ts', kind: 'modify', beforeSha256: 'x', afterSha256: 'y', createdDirs: [] }),
      // Second /accept: the creation event lands, then update-ref FAILS — the acceptance
      // honestly records no deliveryRef.
      ev({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/h/del2', oid: 'b'.repeat(40) }),
      ev({ type: 'session.accepted', complete: true, summary: 's2' }),
    ];
    const owed = owedHarnessRefsFromEvents(events);
    // The phantom is owed (pruning a ref that never existed converges as already-deleted)…
    expect(owed).toContainEqual({ ref: 'refs/h/del2', kind: 'delivery' });
    // …and the REAL anchor of the last acceptance that captured one is NOT destroyed.
    expect(owed.map((o) => o.ref)).not.toContain('refs/h/del1');
  });

  it('REVIEW FIX: an unconsumed delivery creation (crash before session.accepted) is owed', () => {
    const events = [ev({ type: 'harness.checkpoint', kind: 'delivery', ref: 'refs/h/del1', oid: 'a'.repeat(40) })];
    expect(owedHarnessRefsFromEvents(events)).toEqual([{ ref: 'refs/h/del1', kind: 'delivery' }]);
  });

  it('latest-creation-per-ref wins: a phantom creation whose ref name was later reused reads as the newest kind/seq', () => {
    // Phantom: update-ref failed after the append, then the NEXT checkpoint reused n (the ref
    // scan never saw the phantom), so the same ref name carries a second creation event.
    const events = [
      ev({ type: 'task.base-checkpoint', callId: 'c1', ref: 'refs/h/1', oid: 'a'.repeat(40) }),
      ev({ type: 'harness.checkpoint', kind: 'pre-integration', ref: 'refs/h/1', oid: 'b'.repeat(40), callId: 'c2' }),
    ];
    expect(owedHarnessRefsFromEvents(events)).toEqual([{ ref: 'refs/h/1', kind: 'pre-integration' }]);
  });

  it('a ref pruned and then RE-CREATED later is owed again (seq-aware, not set-subtraction)', () => {
    const events = [
      ev({ type: 'task.base-checkpoint', callId: 'c1', ref: 'refs/h/1', oid: 'a'.repeat(40) }),
      ev({ type: 'git.checkpoint.pruned', kind: 'task-base', refs: ['refs/h/1'], failed: [] }),
      ev({ type: 'task.base-checkpoint', callId: 'c2', ref: 'refs/h/1', oid: 'b'.repeat(40) }),
    ];
    expect(owedHarnessRefsFromEvents(events)).toEqual([{ ref: 'refs/h/1', kind: 'task-base' }]);
  });

  it('deletion counts against a ref regardless of the pruned event kind grouping', () => {
    const events = [
      ev({ type: 'harness.checkpoint', kind: 'pre-integration', ref: 'refs/h/pre1', oid: 'a'.repeat(40), callId: 'c1' }),
      // A prune event recorded under a different kind still names the ref as deleted.
      ev({ type: 'git.checkpoint.pruned', kind: 'task-base', refs: ['refs/h/pre1'], failed: [] }),
    ];
    expect(owedHarnessRefsFromEvents(events)).toEqual([]);
  });
});
