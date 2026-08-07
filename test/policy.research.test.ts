import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { decide, Grants, isGrantable } from '../src/policy/engine.js';
import type { PolicyRules, ResearchFact, Tool, ToolContext } from '../src/types.js';

/**
 * The bounded external-read policy branch (Session 19). Written BEFORE the tools exist (the S17
 * discipline: the gate lands before the capability), with stub tools over a WIDE schema so these
 * pin the ENGINE rather than any tool's input shape.
 *
 * The S6-trap closure under test: a research call is command-less and mutation-less, so without
 * its own branch it auto-allows as `observe` with the reason "read-only workspace access" — a
 * false record for a call whose actual consequence is SENDING model-authored text off the machine.
 */

const WIDE = z.object({}).passthrough();

const SEARCH: ResearchFact = {
  kind: 'search',
  providerHost: 'api.tavily.com',
  query: 'zod 4 json schema helper',
  bounds: { maxResults: 5, maxContentChars: 12_000, timeoutMs: 20_000, credits: 1 },
  budgetRemaining: '23 search(es), 12 extract(s), 79 credit(s)',
};

const EXTRACT: ResearchFact = {
  kind: 'extract',
  providerHost: 'api.tavily.com',
  targets: [{ url: 'https://zod.dev/v4/changelog', host: 'zod.dev' }],
  bounds: { maxContentChars: 60_000, timeoutMs: 45_000, credits: 1 },
};

function researchTool(fact: ResearchFact, overrides: Partial<Tool<unknown>> = {}): Tool<unknown> {
  return {
    name: 'web_search',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [] }),
    research: () => fact,
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function rules(r: Partial<PolicyRules> = {}): PolicyRules {
  return { protectedPaths: [], secretPatterns: [], envExcludePatterns: [], researchBlockedDomains: [], ...r };
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'research-policy-')));
  return { workspaceRoot: ws, stateDir: path.join(ws, 'state'), ...extra };
}

describe('decide: the S6 trap is closed', () => {
  it('does NOT let a command-less, mutation-less research tool auto-allow as observe', () => {
    const d = decide(researchTool(SEARCH), {}, ctx(), new Grants());
    expect(d.rule).not.toBe('observe.in-workspace');
    expect(d.decision).toBe('ask');
    expect(d.classification).toBe('external');
    expect(d.reason).not.toContain('read-only workspace access');
  });

  it('classifies the consequence as SENDING, and says the text leaves the machine', () => {
    const d = decide(researchTool(SEARCH), {}, ctx(), new Grants());
    expect(d.rule).toBe('research.approval-required');
    expect(d.reason).toContain('LEAVES THIS MACHINE');
    expect(d.reason).toContain('api.tavily.com');
  });
});

describe('decide: search approval', () => {
  it('asks as external, is grantable, and is never undoable', () => {
    const d = decide(researchTool(SEARCH), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'ask', classification: 'external', rule: 'research.approval-required', noUndo: true });
    expect(isGrantable('external')).toBe(true);
  });

  it('states the per-call bounds and the remaining session budget in the reason', () => {
    const d = decide(researchTool(SEARCH), {}, ctx(), new Grants());
    expect(d.reason).toContain('5 source snippet(s)');
    expect(d.reason).toContain('12000 retrieved chars');
    expect(d.reason).toContain('20000 ms');
    expect(d.reason).toContain('1 provider credit(s)');
    expect(d.reason).toContain('23 search(es), 12 extract(s), 79 credit(s)');
  });

  it('states that retrieved content is untrusted and never verifies anything', () => {
    const d = decide(researchTool(SEARCH), {}, ctx(), new Grants());
    expect(d.reason).toContain('untrusted data');
    expect(d.reason).toContain('never verifies anything');
  });

  it('allows once a session grant for THIS tool and class exists', () => {
    const g = new Grants();
    g.add('web_search', 'external');
    expect(decide(researchTool(SEARCH), {}, ctx(), g)).toMatchObject({ decision: 'allow', classification: 'external' });
  });

  it('does NOT leak a grant to a differently-named research tool (grants key on tool AND class)', () => {
    const g = new Grants();
    g.add('web_search', 'external');
    const extractTool = researchTool(EXTRACT, { name: 'web_extract' });
    expect(decide(extractTool, {}, ctx(), g)).toMatchObject({ decision: 'ask' });
  });

  it('refuses an empty query rather than sending a blank request', () => {
    for (const q of ['', '   ']) {
      expect(decide(researchTool({ ...SEARCH, query: q }), {}, ctx(), new Grants())).toMatchObject({
        decision: 'deny',
        rule: 'research.empty-request',
      });
    }
    // ...and an absent query is the same refusal, not a fall-through.
    const { query: _dropped, ...noQuery } = SEARCH;
    expect(decide(researchTool(noQuery), {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'research.empty-request' });
  });
});

describe('decide: extract targets', () => {
  it('allows the ask when every target is a citable public source', () => {
    expect(decide(researchTool(EXTRACT), {}, ctx(), new Grants())).toMatchObject({
      decision: 'ask',
      classification: 'external',
      rule: 'research.approval-required',
    });
  });

  it('refuses an empty target list', () => {
    expect(decide(researchTool({ ...EXTRACT, targets: [] }), {}, ctx(), new Grants())).toMatchObject({
      decision: 'deny',
      rule: 'research.empty-request',
    });
  });

  it('denies the WHOLE call when any single target is unusable, and names the offender', () => {
    const fact: ResearchFact = {
      ...EXTRACT,
      targets: [
        { url: 'https://zod.dev/ok', host: 'zod.dev' },
        { url: 'http://169.254.169.254/latest/meta-data', refusedReason: 'link-local address' },
        { url: 'https://also.fine/ok', host: 'also.fine' },
      ],
    };
    const d = decide(researchTool(fact), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'research.unusable-target' });
    expect(d.reason).toContain('169.254.169.254');
    expect(d.reason).toContain('link-local address');
    expect(d.reason).toContain('the whole call is refused');
  });

  it('a session grant cannot rescue an unusable target — the deny is not an ask', () => {
    const g = new Grants();
    g.add('web_search', 'external');
    const fact: ResearchFact = { ...EXTRACT, targets: [{ url: 'http://localhost/x', refusedReason: 'loopback host' }] };
    expect(decide(researchTool(fact), {}, ctx(), g)).toMatchObject({ decision: 'deny' });
  });
});

describe('decide: the configured domain denylist', () => {
  it('denies an extract target under a blocked domain, naming the rule that blocked it', () => {
    const c = ctx({ rules: rules({ researchBlockedDomains: ['evil.example'] }) });
    const fact: ResearchFact = { ...EXTRACT, targets: [{ url: 'https://docs.evil.example/a', host: 'docs.evil.example' }] };
    const d = decide(researchTool(fact), {}, c, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'research.blocked-domain' });
    expect(d.reason).toContain('evil.example');
  });

  it('respects label boundaries — notevil.example is not under evil.example', () => {
    const c = ctx({ rules: rules({ researchBlockedDomains: ['evil.example'] }) });
    const fact: ResearchFact = { ...EXTRACT, targets: [{ url: 'https://notevil.example/a', host: 'notevil.example' }] };
    expect(decide(researchTool(fact), {}, c, new Grants())).toMatchObject({ decision: 'ask' });
  });

  it('a model-chosen include list never overrides the operator denylist', () => {
    const c = ctx({ rules: rules({ researchBlockedDomains: ['evil.example'] }) });
    const fact: ResearchFact = { ...SEARCH, domains: ['evil.example'] };
    const d = decide(researchTool(fact), {}, c, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'research.blocked-domain' });
    expect(d.reason).toContain('never overrides');
  });

  it('a session grant cannot rescue a blocked domain', () => {
    const g = new Grants();
    g.add('web_search', 'external');
    const c = ctx({ rules: rules({ researchBlockedDomains: ['evil.example'] }) });
    const fact: ResearchFact = { ...EXTRACT, targets: [{ url: 'https://evil.example/a', host: 'evil.example' }] };
    expect(decide(researchTool(fact), {}, c, g)).toMatchObject({ decision: 'deny', rule: 'research.blocked-domain' });
  });

  it('the denylist is inert when unset', () => {
    expect(decide(researchTool(EXTRACT), {}, ctx({ rules: rules() }), new Grants())).toMatchObject({ decision: 'ask' });
  });
});

describe('decide: the session budget is the consent', () => {
  it('denies when the budget is spent, even with a session grant held', () => {
    const g = new Grants();
    g.add('web_search', 'external');
    const fact: ResearchFact = { ...SEARCH, budgetExhausted: '24 of 24 searches used' };
    const d = decide(researchTool(fact), {}, ctx(), g);
    expect(d).toMatchObject({ decision: 'deny', rule: 'research.budget-exhausted' });
    expect(d.reason).toContain('24 of 24 searches used');
  });

  it('denies an exhausted budget inside a researcher child too — the spawn is not a bypass', () => {
    const c = ctx({ lineage: { parentSessionId: 'p1', role: 'researcher' } });
    const fact: ResearchFact = { ...SEARCH, budgetExhausted: '80 of 80 credits used' };
    expect(decide(researchTool(fact), {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'research.budget-exhausted' });
  });
});

describe('decide: delegated-role admission', () => {
  it('allows inside a researcher child, because the spawn was gated and no approver is attached', () => {
    const c = ctx({ lineage: { parentSessionId: 'p1', role: 'researcher' } });
    const d = decide(researchTool(SEARCH), {}, c, new Grants());
    expect(d).toMatchObject({ decision: 'allow', classification: 'external', rule: 'research.delegated-role', noUndo: true });
  });

  it('says "the spawn was allowed", never "the human approved" — dangerous mode approves nothing', () => {
    const c = ctx({ lineage: { parentSessionId: 'p1', role: 'researcher' } });
    const d = decide(researchTool(SEARCH), {}, c, new Grants());
    expect(d.reason).toContain('whose spawn this engine allowed');
    expect(d.reason.toLowerCase()).not.toContain('the human approved');
    expect(d.reason).toContain('same session budget as the parent');
  });

  it('does NOT admit any other role — an explorer child cannot research', () => {
    for (const role of ['explorer', 'planner', 'reviewer', 'executor', 'nonsense']) {
      const c = ctx({ lineage: { parentSessionId: 'p1', role } });
      expect(decide(researchTool(SEARCH), {}, c, new Grants())).toMatchObject({ decision: 'ask' });
    }
  });

  it('does not admit a parent session (no lineage at all)', () => {
    expect(decide(researchTool(SEARCH), {}, ctx(), new Grants())).toMatchObject({ decision: 'ask' });
  });
});

describe('decide: contract integrity', () => {
  it('denies when research() throws — a throw is a deny, never an escape to a fall-through', () => {
    const t = researchTool(SEARCH, {
      research: () => {
        throw new Error('boom');
      },
    });
    const d = decide(t, {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'research.invalid-contract' });
    expect(d.reason).toContain('boom');
  });

  it('denies when mutates() throws', () => {
    const t = researchTool(SEARCH, {
      mutates: () => {
        throw new Error('mutate boom');
      },
    });
    expect(decide(t, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'research.invalid-contract' });
  });

  it('denies a research tool that declares a non-empty mutation plan', () => {
    const c = ctx();
    const t = researchTool(SEARCH, { mutates: () => ({ paths: [path.join(c.workspaceRoot, 'notes.md')] }) });
    expect(decide(t, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'research.mutating-contract' });
  });

  it('denies a research tool whose mutation plan is undeclarable (null)', () => {
    const t = researchTool(SEARCH, { mutates: () => null });
    expect(decide(t, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'research.mutating-contract' });
  });

  it.each([
    ['command', { command: () => 'curl https://x' }],
    ['delegates', { delegates: () => ({ roles: ['explorer'] }) }],
    ['planDoc', { planDoc: () => ({ action: 'update' as const }) }],
    ['check', { check: () => ({ resolved: [] }) }],
    ['browser', { browser: () => ({ flowName: 'f', stepCount: 1, previewBound: true }) }],
    ['evidenceRead', { evidenceRead: () => ({ sha256: 'abc' }) }],
    ['artifact', { artifact: () => ({ kind: 'inspect' as const, path: 'a.pdf' }) }],
  ])('denies a research tool that also declares %s', (_name, extra) => {
    const t = researchTool(SEARCH, extra as Partial<Tool<unknown>>);
    const d = decide(t, {}, ctx(), new Grants());
    expect(d.decision).toBe('deny');
    // Whichever branch runs first must still name a conflicting contract — never allow.
    expect(d.rule).toMatch(/conflicting-contract$/);
  });

  it('names BOTH sides of a conflicting contract in the reason', () => {
    const t = researchTool(SEARCH, { command: () => 'curl https://x' });
    expect(decide(t, {}, ctx(), new Grants()).reason).toContain('a bounded external read');
  });
});

describe('decide: spawning a researcher', () => {
  const delegateTool = (roles: readonly string[]): Tool<unknown> => ({
    name: 'delegate_task',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [] }),
    delegates: () => ({ roles }),
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
  });

  it('asks as external — the spawn IS the consent for every search the child will run', () => {
    const d = decide(delegateTool(['researcher']), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'ask', classification: 'external', rule: 'task.research-role' });
    expect(d.reason).toContain('holds no tool that writes');
    expect(d.reason).toContain('SAME session research budget');
    expect(d.reason).toContain('never verification');
  });

  it('still allows a plain read-only group as observe', () => {
    expect(decide(delegateTool(['explorer', 'reviewer']), {}, ctx(), new Grants())).toMatchObject({
      decision: 'allow',
      classification: 'observe',
      rule: 'task.readonly-role',
    });
  });

  it('a mutating member governs a mixed group — researcher does NOT downgrade it', () => {
    expect(decide(delegateTool(['researcher', 'executor']), {}, ctx(), new Grants())).toMatchObject({
      decision: 'ask',
      classification: 'reversible',
      rule: 'task.mutating-role',
    });
  });

  it('a stored delegate_task::external grant must NOT satisfy a mutating spawn', () => {
    const g = new Grants();
    g.add('delegate_task', 'external');
    // The research grant exists and works for a pure research group — and the rule id records
    // that a GRANT is what allowed it, rather than presenting it as an unconditional allow.
    expect(decide(delegateTool(['researcher']), {}, ctx(), g)).toMatchObject({ decision: 'allow', rule: 'task.research-role+grant' });
    // ...but a group containing an executor is governed by the mutating rule, which is
    // `reversible` and therefore never grantable. One [s] on research must not become standing
    // consent to spawn writers.
    expect(decide(delegateTool(['researcher', 'executor']), {}, ctx(), g)).toMatchObject({
      decision: 'ask',
      rule: 'task.mutating-role',
    });
    expect(decide(delegateTool(['executor']), {}, ctx(), g)).toMatchObject({ decision: 'ask', rule: 'task.mutating-role' });
  });

  it('still fails closed on an unknown role even alongside a researcher', () => {
    expect(decide(delegateTool(['researcher', 'nonsense']), {}, ctx(), new Grants())).toMatchObject({
      decision: 'deny',
      rule: 'task.unknown-role',
    });
  });
});
