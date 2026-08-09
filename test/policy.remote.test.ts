import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { decide, FACT_KINDS, Grants, isGrantable } from '../src/policy/engine.js';
import { formatApprovalPrompt } from '../src/runtime/approvals.js';
import { REMOTE_OBSERVATION_MAX_AGE_MS } from '../src/types.js';
import type { ApprovalRequest, PolicyRules, RemoteReadFact, RemoteWriteFact, Tool, ToolContext } from '../src/types.js';

/**
 * The two remote policy branches (Session 20), pinned against STUB tools over a wide schema so
 * these test the ENGINE rather than any tool's input shape (the `policy.research.test.ts`
 * discipline).
 *
 * What is under test is the session's central claim: remote reads and remote mutations are
 * different authorities, and no path exists by which consent to one becomes consent to the other.
 */

const WIDE = z.object({}).passthrough();

const TARGET = { remoteName: 'origin', host: 'github.com', slug: 'o/r', display: "github.com/o/r via remote 'origin'" };

const READ: RemoteReadFact = {
  operation: 'repository',
  target: TARGET,
  argvPreview: 'gh repo view o/r --json nameWithOwner',
  bounds: { maxItems: 10, timeoutMs: 30_000 },
  budgetRemaining: '39 of 40 read(s)',
};

const WRITE: RemoteWriteFact = {
  operation: 'push.branch',
  target: TARGET,
  exactTarget: 'refs/heads/session-20',
  overwrites: false,
  effect: ['CREATE origin:refs/heads/session-20 at 9f3c1ab (4 commits)'],
  argvPreview: 'git push --porcelain origin 9f3c…:refs/heads/session-20',
  observation: { id: 'obs123456789', ageMs: 5_000, remoteOid: null, localOid: '9'.repeat(40) },
  localEvidence: 'checks since the last change: test pass · 1 commit(s) this session',
  budgetRemaining: '10 of 10 mutation(s)',
  timeoutMs: 120_000,
};

function readTool(fact: RemoteReadFact = READ, overrides: Partial<Tool<unknown>> = {}): Tool<unknown> {
  return {
    name: 'remote_status',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [] }),
    remoteRead: () => fact,
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function writeTool(fact: RemoteWriteFact = WRITE, overrides: Partial<Tool<unknown>> = {}): Tool<unknown> {
  return {
    name: 'remote_push',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [] }),
    remoteWrite: () => fact,
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function rules(r: Partial<PolicyRules> = {}): PolicyRules {
  return { protectedPaths: [], secretPatterns: [], envExcludePatterns: [], researchBlockedDomains: [], remoteBlockedHosts: [], ...r };
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-policy-')));
  return { workspaceRoot: ws, stateDir: path.join(ws, 'state'), ...extra };
}

describe('the S6 trap is closed for both remote facts', () => {
  it('a command-less, mutation-less remote tool never auto-allows as observe', () => {
    for (const tool of [readTool(), writeTool()]) {
      const d = decide(tool, {}, ctx(), new Grants());
      expect(d.rule).not.toBe('observe.in-workspace');
      expect(d.decision).not.toBe('allow');
    }
  });

  it('both facts are members of FACT_KINDS, so a third fact cannot be added without deciding about them', () => {
    expect(FACT_KINDS).toContain('remoteRead');
    expect(FACT_KINDS).toContain('remoteWrite');
  });
});

describe('read and write are structurally different capabilities', () => {
  it('DENIES a tool that declares both — the conflicting-contract rule does the work', () => {
    // This is the whole reason for two facts rather than one with a mode: a tool that could both
    // read and publish would be gated by whichever branch ran first.
    const both = readTool(READ, { remoteWrite: () => WRITE } as Partial<Tool<unknown>>);
    const d = decide(both, {}, ctx(), new Grants());
    expect(d.decision).toBe('deny');
    expect(d.rule).toBe('remote.read-conflicting-contract');
    expect(d.reason).toContain('remote mutation');
  });

  it('DENIES a remote tool combined with any other fact', () => {
    const withCommand = writeTool(WRITE, { command: () => 'echo hi' } as Partial<Tool<unknown>>);
    expect(decide(withCommand, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.write-conflicting-contract' });
  });

  it('DENIES a remote tool that declares a workspace mutation, or an undeclarable one', () => {
    const mutating = readTool(READ, { mutates: () => ({ paths: ['/tmp/x'] }) } as Partial<Tool<unknown>>);
    expect(decide(mutating, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.read-mutating-contract' });
    const undeclarable = writeTool(WRITE, { mutates: () => null } as Partial<Tool<unknown>>);
    expect(decide(undeclarable, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.write-mutating-contract' });
  });

  it('treats a throwing fact as a deny, never an escape into the fall-throughs', () => {
    const boom = readTool(READ, {
      remoteRead: () => {
        throw new Error('nope');
      },
    } as Partial<Tool<unknown>>);
    expect(decide(boom, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.read-invalid-contract' });
  });
});

describe('remote reads', () => {
  it('ask `external`, and a session grant then covers further reads', () => {
    const d = decide(readTool(), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'ask', classification: 'external', rule: 'remote.read-approval-required' });
    expect(d.reason).toContain('never reads the token');
    expect(d.reason).toContain('NEVER a mutation');

    const grants = new Grants();
    grants.add('remote_status', 'external');
    expect(decide(readTool(), {}, ctx(), grants)).toMatchObject({ decision: 'allow', rule: 'remote.read-approval-required+grant' });
  });

  it('a read grant does NOT satisfy a write — different tool name AND a branch that never consults grants', () => {
    const grants = new Grants();
    grants.add('remote_status', 'external');
    // Even a grant recorded under the WRITE tool's own name cannot help: the branch never calls
    // applyGrant, so there is no code path from a stored grant to an allowed publish.
    grants.add('remote_push', 'external');
    expect(decide(writeTool(), {}, ctx(), grants)).toMatchObject({ decision: 'ask', rule: 'remote.write-approval-required' });
  });

  it('maps every declared blocker kind to its own rule id', () => {
    const cases: [NonNullable<RemoteReadFact['blockedKind']>, string][] = [
      ['unavailable', 'remote.unavailable'],
      ['unauthenticated', 'remote.unauthenticated'],
      ['not-github', 'remote.not-github'],
      ['ambiguous', 'remote.ambiguous-target'],
      ['budget', 'remote.budget-exhausted'],
      ['precondition', 'remote.precondition'],
    ];
    for (const [kind, rule] of cases) {
      const d = decide(readTool({ ...READ, blocked: 'because', blockedKind: kind }), {}, ctx(), new Grants());
      expect(d, `kind ${String(kind)}`).toMatchObject({ decision: 'deny', rule });
    }
    // A blocker with no kind gets the least specific rule, not the benefit of the doubt.
    expect(decide(readTool({ ...READ, blocked: 'because' }), {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.refused' });
  });

  it('a PRE-RESOLUTION blocker (no host yet) keeps its own rule id — never remote.unresolved-target (S20.5)', () => {
    // Every real early refusal (budget spent, gh missing, no repository, ambiguous remote) is
    // built on an unresolved target whose host is ''. Checking the host before the blocker
    // recorded all of them as 'name the host it contacts' — a cure no input could satisfy.
    const noHost = { ...TARGET, host: '', slug: null, display: '(unresolved)' };
    const cases: [NonNullable<RemoteReadFact['blockedKind']>, string][] = [
      ['budget', 'remote.budget-exhausted'],
      ['unavailable', 'remote.unavailable'],
      ['ambiguous', 'remote.ambiguous-target'],
    ];
    for (const [kind, rule] of cases) {
      const read = decide(readTool({ ...READ, target: noHost, blocked: 'because', blockedKind: kind }), {}, ctx(), new Grants());
      expect(read, `read kind ${String(kind)}`).toMatchObject({ decision: 'deny', rule });
      const write = decide(writeTool({ ...WRITE, target: noHost, blocked: 'because', blockedKind: kind }), {}, ctx(), new Grants());
      expect(write, `write kind ${String(kind)}`).toMatchObject({ decision: 'deny', rule });
    }
  });

  it('lineage outranks a blocked fact: a child hears the permanent answer, not the transient one', () => {
    const c = ctx({ lineage: { parentSessionId: 'p', role: 'researcher' } });
    const d = decide(readTool({ ...READ, blocked: 'budget spent', blockedKind: 'budget' }), {}, c, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'remote.delegated-role' });
  });

  it('DENIES a host the operator forbids — reads included', () => {
    const c = ctx({ rules: rules({ remoteBlockedHosts: ['github.com'] }) });
    expect(decide(readTool(), {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.blocked-host' });
    expect(decide(writeTool(), {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.blocked-host' });
  });

  it('matches the host denylist on label boundaries, like every other host predicate here', () => {
    const c = ctx({ rules: rules({ remoteBlockedHosts: ['example.test'] }) });
    const sub = readTool({ ...READ, target: { ...TARGET, host: 'git.example.test' } });
    const lookalike = readTool({ ...READ, target: { ...TARGET, host: 'notexample.test' } });
    expect(decide(sub, {}, c, new Grants()).rule).toBe('remote.blocked-host');
    expect(decide(lookalike, {}, c, new Grants()).decision).toBe('ask');
  });

  it('DENIES a fact with no host', () => {
    expect(decide(readTool({ ...READ, target: { ...TARGET, host: '  ' } }), {}, ctx(), new Grants())).toMatchObject({
      decision: 'deny',
      rule: 'remote.unresolved-target',
    });
  });
});

describe('no subagent reaches the remote', () => {
  it('DENIES both facts under any lineage', () => {
    for (const role of ['explorer', 'researcher', 'executor', 'reviewer']) {
      const c = ctx({ lineage: { role, parentSessionId: 'p' } });
      expect(decide(readTool(), {}, c, new Grants()), role).toMatchObject({ decision: 'deny', rule: 'remote.delegated-role' });
      expect(decide(writeTool(), {}, c, new Grants()), role).toMatchObject({ decision: 'deny', rule: 'remote.delegated-role' });
    }
  });
});

describe('remote mutations are observation-bound', () => {
  it('DENIES a write with no observation — this is a deny, not an ask', () => {
    const { observation: _drop, ...noObs } = WRITE;
    const d = decide(writeTool(noObs as RemoteWriteFact), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'remote.unobserved' });
    expect(d.reason).toContain('inspect the remote ref first');
  });

  it('DENIES an observation older than the kernel-owned freshness bound', () => {
    const stale = { ...WRITE, observation: { ...WRITE.observation!, ageMs: REMOTE_OBSERVATION_MAX_AGE_MS + 1 } };
    expect(decide(writeTool(stale), {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.stale-observation' });
    // A clock that went backwards is also refused rather than treated as very fresh.
    const negative = { ...WRITE, observation: { ...WRITE.observation!, ageMs: -1 } };
    expect(decide(writeTool(negative), {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.stale-observation' });
  });

  it('accepts an observation at exactly the bound', () => {
    const edge = { ...WRITE, observation: { ...WRITE.observation!, ageMs: REMOTE_OBSERVATION_MAX_AGE_MS } };
    expect(decide(writeTool(edge), {}, ctx(), new Grants()).decision).toBe('ask');
  });

  it('DENIES a mutation that names no exact target, or describes no effect', () => {
    expect(decide(writeTool({ ...WRITE, exactTarget: '  ' }), {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.unresolved-target' });
    // A prompt that asks "may I do something" is not a question anyone can answer.
    expect(decide(writeTool({ ...WRITE, effect: [] }), {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'remote.undescribed-effect' });
  });
});

describe('remote mutations classify honestly and are never granted', () => {
  it('a publish is `external`, non-undoable, and states that local completion is not authorization', () => {
    const d = decide(writeTool(), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'ask', classification: 'external', rule: 'remote.write-approval-required', noUndo: true });
    expect(d.reason).toContain('PUBLISHES');
    expect(d.reason).toContain('re-reads the remote immediately before sending');
    expect(d.reason).toContain('NOT as authorization');
  });

  it('an OVERWRITE is `destructive`, which is non-grantable by construction', () => {
    const d = decide(writeTool({ ...WRITE, overwrites: true }), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'ask', classification: 'destructive', rule: 'remote.write-overwrite-approval-required' });
    expect(d.reason).toContain('OVERWRITES');
    expect(isGrantable(d.classification)).toBe(false);
  });

  it('re-deciding after any number of approvals still asks', () => {
    const grants = new Grants();
    for (let i = 0; i < 5; i += 1) {
      const d = decide(writeTool(), {}, ctx(), grants);
      expect(d.decision).toBe('ask');
      grants.add('remote_push', d.classification);
    }
  });
});

describe('the approval prompt cannot make the two look alike', () => {
  const base: ApprovalRequest = { callId: 'c1', tool: 'remote_status', classification: 'external', summary: 's', detail: 'd', reason: 'r' };

  it('a remote READ offers [s], worded so it cannot be mistaken for permission to publish', () => {
    const text = formatApprovalPrompt({ ...base, kind: 'remote-read' });
    expect(text).toContain('[remote READ');
    expect(text).toContain('contacts the remote under your existing credential');
    expect(text).toContain('[s] allow further remote READS this session (never a push, tag or release)');
  });

  it('a remote WRITE offers NO [s] at all', () => {
    const text = formatApprovalPrompt({ ...base, tool: 'remote_push', kind: 'remote-write', noUndoWarning: true });
    expect(text).toContain('[remote WRITE');
    expect(text).toContain('NOT undoable from here');
    expect(text).not.toContain('[s]');
    expect(text).toContain('[y] allow once');
    expect(text).toContain('[n] deny');
  });

  it('an OVERWRITING write says so in the header', () => {
    const text = formatApprovalPrompt({ ...base, tool: 'remote_push', kind: 'remote-write', classification: 'destructive' });
    expect(text).toContain('OVERWRITES remote state');
    expect(text).not.toContain('[s]');
  });
});
