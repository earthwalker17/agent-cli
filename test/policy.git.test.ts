import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { decide, FACT_KINDS, Grants } from '../src/policy/engine.js';
import type { GitCheckpointFact, GitReadFact, Tool, ToolContext } from '../src/types.js';

/**
 * The two LOCAL-git policy branches (Session 21.6), pinned against STUB tools over a wide schema
 * so these test the ENGINE rather than any tool's input shape (the `policy.remote.test.ts`
 * discipline).
 *
 * The claim under test is narrow and load-bearing: these branches make git legible to policy
 * WITHOUT re-creating the trap `test/policy.test.ts`'s `hypothetical_git_commit` regression
 * describes. A read allows because it is a read, and it says so in the record; a checkpoint allows
 * because it is provably additive, and every way a tool could quietly be something else — a second
 * fact, a mutation plan, a child asking — is a deny.
 */

const WIDE = z.object({}).passthrough();

const READ: GitReadFact = { view: 'changes', argvPreview: 'git status --porcelain=v2 -z -- .' };
const CKPT: GitCheckpointFact = {
  refRoot: 'refs/agent-cli/checkpoints/',
  argvPreview: 'git add -A -- . (temporary index)',
  budgetRemaining: '12 of 12 remaining this session',
};

function readTool(fact: GitReadFact = READ, overrides: Partial<Tool<unknown>> = {}): Tool<unknown> {
  return {
    name: 'git_status',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [] }),
    gitRead: () => fact,
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function ckptTool(fact: GitCheckpointFact = CKPT, overrides: Partial<Tool<unknown>> = {}): Tool<unknown> {
  return {
    name: 'git_checkpoint',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [] }),
    gitCheckpoint: () => fact,
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apolgit-')));
const ctx: ToolContext = { workspaceRoot: ws, stateDir: path.join(ws, '.state') };
const child: ToolContext = { ...ctx, lineage: { parentSessionId: 'p1', role: 'executor' } };

describe('the git facts are in the one table every branch derives from', () => {
  it('both are FactKinds, so a new fact breaks FACT_LABELS and CHILD_ADMISSIBLE_FACTS at compile time', () => {
    expect(FACT_KINDS).toContain('gitRead');
    expect(FACT_KINDS).toContain('gitCheckpoint');
  });
});

describe('gitRead', () => {
  it('allows as observe, and the RECORD names the argv instead of "read-only workspace access"', () => {
    const d = decide(readTool(), {}, ctx, new Grants());
    expect(d).toMatchObject({ classification: 'observe', decision: 'allow', rule: 'git.read' });
    expect(d.reason).toContain('git status --porcelain=v2 -z -- .');
    // The precise wording the fall-through would have used, and which this branch exists to avoid.
    expect(d.reason).not.toContain('read-only workspace access');
  });

  it('states the property that makes allowing before readsPaths honest', () => {
    // The branch returns before the secret-name and containment checks ever run. The only thing
    // that makes that defensible is that no file bytes can come back, so the reason must say so.
    expect(decide(readTool(), {}, ctx, new Grants()).reason).toMatch(/no file contents/);
  });

  it('a blocked fact denies by name', () => {
    const d = decide(readTool({ ...READ, blocked: 'the workspace is not inside a git repository' }), {}, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'git.read-refused' });
  });

  it('a throwing fact denies', () => {
    const t = readTool();
    t.gitRead = () => {
      throw new Error('boom');
    };
    expect(decide(t, {}, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'git.read-invalid-contract' });
  });

  it('a non-empty mutation plan denies — the branch must never bypass write validation', () => {
    const t = readTool(READ, { mutates: () => ({ paths: [path.join(ws, 'a.txt')] }) });
    expect(decide(t, {}, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'git.read-mutating-contract' });
  });

  it('an undeclarable mutation plan (null) denies too', () => {
    const t = readTool(READ, { mutates: () => null });
    expect(decide(t, {}, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'git.read-mutating-contract' });
  });

  it('a throwing mutates() denies rather than crashing the turn', () => {
    const t = readTool(READ, {
      mutates: () => {
        throw new Error('nope');
      },
    });
    expect(decide(t, {}, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'git.read-invalid-contract' });
  });

  it('a subagent is denied by the engine even though the registry already withholds the tool', () => {
    const d = decide(readTool(), {}, child, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'git.delegated-role' });
  });

  it('a second fact is a conflicting contract, naming both sides', () => {
    const t = readTool(READ, { gitCheckpoint: () => CKPT });
    const d = decide(t, {}, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'git.read-conflicting-contract' });
    expect(d.reason).toContain('a local repository read');
    expect(d.reason).toContain('a recovery checkpoint');
  });

  it('a read tool that also declares a command is a conflicting contract, not a command', () => {
    const t = readTool(READ, { command: () => 'git log' });
    expect(decide(t, {}, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'git.read-conflicting-contract' });
  });
});

describe('gitCheckpoint', () => {
  it('allows as reversible + noUndo, and the record says exactly what is written', () => {
    const d = decide(ckptTool(), {}, ctx, new Grants());
    expect(d).toMatchObject({ classification: 'reversible', decision: 'allow', rule: 'git.checkpoint', noUndo: true });
    expect(d.reason).toContain('refs/agent-cli/checkpoints/');
    expect(d.reason).toMatch(/HEAD, the index, branches, tags and the working tree are UNTOUCHED/);
    // The allowance is in the record, so an exhausted session is explicable from the log alone.
    expect(d.reason).toContain('12 of 12 remaining this session');
  });

  it('a spent allowance is a DENY recorded as a decision, not a string the model reads later', () => {
    const d = decide(ckptTool({ ...CKPT, blocked: "this session's agent-checkpoint allowance is spent (12/12)" }), {}, ctx, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'git.checkpoint-refused' });
    expect(d.reason).toContain('allowance is spent');
  });

  it('a non-empty mutation plan denies — a checkpoint writes inside .git, never the workspace', () => {
    const t = ckptTool(CKPT, { mutates: () => ({ paths: [path.join(ws, 'a.txt')] }) });
    expect(decide(t, {}, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'git.checkpoint-mutating-contract' });
  });

  it('a subagent is denied: its worktree ref would outlive every fold that could reclaim it', () => {
    const d = decide(ckptTool(), {}, child, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'git.delegated-role' });
    expect(d.reason).toMatch(/different tree/);
  });

  it('a throwing fact denies', () => {
    const t = ckptTool();
    t.gitCheckpoint = () => {
      throw new Error('boom');
    };
    expect(decide(t, {}, ctx, new Grants())).toMatchObject({ decision: 'deny', rule: 'git.checkpoint-invalid-contract' });
  });

  it('is NOT grantable: allow means allow, and there is no standing-authority path to mint', () => {
    // The branch never calls applyGrant, so a stored grant changes nothing — and, because the
    // verdict is already `allow`, no prompt exists that could offer [s] or [a] for it.
    const g = new Grants();
    g.add('git_checkpoint', 'external');
    const d = decide(ckptTool(), {}, ctx, g);
    expect(d.decision).toBe('allow');
    expect(d.rule).toBe('git.checkpoint');
  });
});

describe('the invariant this session did NOT widen', () => {
  it('a git tool cannot become a commit by declaring both git facts', () => {
    const t: Tool<unknown> = {
      name: 'hypothetical_git_commit',
      description: 'test stub',
      schema: WIDE as unknown as Tool<unknown>['schema'],
      mutates: () => ({ paths: [] }),
      gitRead: () => READ,
      gitCheckpoint: () => CKPT,
      execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    };
    expect(decide(t, {}, ctx, new Grants()).decision).toBe('deny');
  });

  it('neither branch can be reached by a tool that also carries a command', () => {
    for (const t of [readTool(READ, { command: () => 'git commit -m x' }), ckptTool(CKPT, { command: () => 'git commit -m x' })]) {
      const d = decide(t, {}, ctx, new Grants());
      expect(d.decision).toBe('deny');
      expect(d.rule).toMatch(/conflicting-contract/);
    }
  });
});
