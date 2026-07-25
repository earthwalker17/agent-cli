import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { checkReplayKey, decide, Grants, isGrantable } from '../src/policy/engine.js';
import { formatApprovalPrompt } from '../src/runtime/approvals.js';
import type { ApprovalRequest, ResolvedCheckFact, Tool, ToolContext } from '../src/types.js';

/**
 * The typed-check policy branch (Session 12) and its replay consent. Stub tools use a WIDE schema
 * so these pin the ENGINE, independent of the real tool's schema — the same rationale as the
 * delegation-branch tests.
 */

const WIDE = z.object({}).passthrough();

function fact(over: Partial<ResolvedCheckFact> = {}): ResolvedCheckFact {
  return {
    recipeId: 'node.script.test',
    kind: 'test',
    command: 'npm run test',
    timeoutMs: 900_000,
    effects: { writesOutputs: true, network: false, workspaceAuthored: false },
    ...over,
  };
}

function stubTool(resolved: readonly ResolvedCheckFact[], overrides: Partial<Tool<unknown>> = {}): Tool<unknown> {
  return {
    name: 'run_check',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [] }),
    check: () => ({ resolved }),
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function ctx(): ToolContext {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'check-policy-'));
  return { workspaceRoot: ws, stateDir: path.join(ws, 'state') };
}

describe('decide: typed-check branch (fail closed, before the command branch)', () => {
  it('asks by default, reversible, no-undo, and explicitly unsandboxed', () => {
    const d = decide(stubTool([fact()]), {}, ctx(), new Grants());
    expect(d).toMatchObject({
      decision: 'ask',
      classification: 'reversible',
      rule: 'check.approval-required',
      noUndo: true,
      execBoundary: 'unsandboxed',
    });
    expect(d.reason).toContain('NOT sandboxed');
    expect(d.checkReplayKeys).toEqual([checkReplayKey('node.script.test', 'npm run test')]);
  });

  it('names workspace-authored scripts in the reason (their real effects are unknown)', () => {
    const authored = fact({ effects: { writesOutputs: true, network: true, workspaceAuthored: true } });
    expect(decide(stubTool([authored]), {}, ctx(), new Grants()).reason).toContain('script defined by this workspace');
    expect(decide(stubTool([fact()]), {}, ctx(), new Grants()).reason).not.toContain('script defined by this workspace');
  });

  it('a throwing check() is a deny, never an escape into a later branch', () => {
    const tool = stubTool([], {
      check: () => {
        throw new Error('boom');
      },
    });
    expect(decide(tool, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'check.invalid-contract' });
  });

  it('nothing resolved is an allow with nothing to consent to (the tool reports unsupported itself)', () => {
    const d = decide(stubTool([]), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'allow', classification: 'observe', rule: 'check.nothing-to-run' });
    expect(d.checkReplayKeys).toBeUndefined();
  });

  it('refuses every conflicting fact combination (the S6 trap in a new shape)', () => {
    const withCommand = stubTool([fact()], { command: () => 'npm test' });
    expect(decide(withCommand, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'check.conflicting-contract' });

    // delegates and planDoc are evaluated BEFORE the check branch, so they refuse under their own
    // rule ids — what matters is that no combination reaches a permissive classification.
    const withDelegates = stubTool([fact()], { delegates: () => ({ roles: ['explorer'] }) });
    expect(decide(withDelegates, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'task.conflicting-contract' });

    const withPlanDoc = stubTool([fact()], { planDoc: () => ({ action: 'update' as const }) });
    expect(decide(withPlanDoc, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'plan.conflicting-contract' });
  });

  it('a check tool never reaches the observe fall-through even with an empty mutation plan', () => {
    const d = decide(stubTool([fact()]), {}, ctx(), new Grants());
    expect(d.rule).not.toBe('observe.in-workspace');
    expect(d.decision).not.toBe('allow');
  });
});

describe('replay consent', () => {
  it('allows only when EVERY resolved command already carries consent', () => {
    const grants = new Grants();
    const a = fact();
    const b = fact({ recipeId: 'node.script.typecheck', kind: 'typecheck', command: 'npm run typecheck' });
    grants.addCheckReplay(checkReplayKey(a.recipeId, a.command));

    expect(decide(stubTool([a]), {}, ctx(), grants)).toMatchObject({ decision: 'allow', rule: 'check.replay-consent' });
    expect(decide(stubTool([a, b]), {}, ctx(), grants)).toMatchObject({ decision: 'ask' });

    grants.addCheckReplay(checkReplayKey(b.recipeId, b.command));
    expect(decide(stubTool([a, b]), {}, ctx(), grants)).toMatchObject({ decision: 'allow', rule: 'check.replay-consent' });
  });

  it('binds the exact command: a changed resolution asks again', () => {
    const grants = new Grants();
    grants.addCheckReplay(checkReplayKey('node.script.test', 'npm run test'));
    const changed = fact({ command: 'npm run test -- --coverage' });
    expect(decide(stubTool([changed]), {}, ctx(), grants)).toMatchObject({ decision: 'ask' });
  });

  it('binds the recipe too: the same command under a different recipe asks again', () => {
    const grants = new Grants();
    grants.addCheckReplay(checkReplayKey('node.script.test', 'npm run test'));
    expect(decide(stubTool([fact({ recipeId: 'other.recipe' })]), {}, ctx(), grants)).toMatchObject({ decision: 'ask' });
  });

  it('lives in its own store: it is not an ActionClass grant and cannot leak into one', () => {
    const grants = new Grants();
    grants.addCheckReplay(checkReplayKey('node.script.test', 'npm run test'));
    expect(grants.has('run_check', 'reversible')).toBe(false);
    expect(grants.has('run_check', 'observe')).toBe(false);
    // And the class-keyed path still refuses `reversible`, so the executor-spawn ask is untouched.
    grants.add('delegate_task', 'reversible');
    expect(grants.has('delegate_task', 'reversible')).toBe(false);
    expect(isGrantable('reversible')).toBe(false);
  });
});

describe('the approval prompt for a typed check', () => {
  function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
      callId: 'c1',
      tool: 'run_check',
      classification: 'reversible',
      kind: 'check',
      summary: 'run_check: typecheck, test',
      detail: 'typecheck → npm run typecheck   [node.script.typecheck; timeout 300s]\ntest → npm run test   [node.script.test; timeout 900s]',
      reason: 'runs harness-resolved project check(s)',
      noUndoWarning: true,
      ...over,
    };
  }

  it('shows every resolved command and offers replay consent with distinct wording', () => {
    const p = formatApprovalPrompt(req());
    expect(p).toContain('[typed check — harness-resolved command]');
    expect(p).toContain('npm run typecheck');
    expect(p).toContain('npm run test');
    expect(p).toContain('[s] allow re-runs of THIS EXACT command');
    expect(p).not.toContain('allow for the rest of this session');
    expect(p).toContain('NOT undoable');
  });

  it('leaves the executor-spawn prompt exactly as it was (no [s] on a reversible ask)', () => {
    const spawn = formatApprovalPrompt({
      callId: 'c2',
      tool: 'delegate_task',
      classification: 'reversible',
      summary: 'delegate_task: 1 task(s) — executor',
      detail: '1. [executor] do the thing',
      reason: 'spawns MUTATING subagent(s)',
    });
    expect(spawn).not.toContain('[s]');
  });
});
