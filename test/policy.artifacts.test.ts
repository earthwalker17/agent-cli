import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { decide, Grants, isGrantable } from '../src/policy/engine.js';
import type { ArtifactFact, Tool, ToolContext } from '../src/types.js';

/**
 * The document-artifact policy branch (Session 17). Stub tools with a WIDE schema pin the
 * ENGINE, independent of the real tools' schemas — the delegation-branch rationale. The two
 * S6-trap closures under test: a render must not ride the generic mutation rule (its reason
 * says nothing about a browser), and an inspect must not fall through to observe (command-less,
 * mutation-less, with a browser behind it).
 */

const WIDE = z.object({}).passthrough();

function artifactTool(fact: ArtifactFact, overrides: Partial<Tool<unknown>> = {}): Tool<unknown> {
  return {
    name: 'render_document',
    description: 'test stub',
    schema: WIDE as unknown as Tool<unknown>['schema'],
    mutates: () => ({ paths: [...(fact.kind === 'render' ? (fact.outputs ?? []) : [])] }),
    artifact: () => fact,
    execute: async () => ({ ok: true, output: '', durationMs: 0, truncated: false }),
    ...overrides,
  };
}

function ctx(): ToolContext {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-policy-'));
  return { workspaceRoot: ws, stateDir: path.join(ws, 'state') };
}

describe('decide: artifact render', () => {
  it('allows an in-workspace render as reversible with snapshot, naming the browser and the execute-time read contract', () => {
    const c = ctx();
    const out = [path.join(c.workspaceRoot, 'report.docx'), path.join(c.workspaceRoot, 'report.pdf')];
    const d = decide(artifactTool({ kind: 'render', outputs: out, usesBrowser: true }), {}, c, new Grants());
    expect(d).toMatchObject({
      decision: 'allow',
      classification: 'reversible',
      rule: 'artifact.render',
      requiresSnapshot: true,
    });
    expect(d.reason).toContain('HEADLESS');
    expect(d.reason).toContain('network access blocked');
    expect(d.reason).toContain('validated at execute');
  });

  it('does not claim a browser launch when none is requested', () => {
    const c = ctx();
    const out = [path.join(c.workspaceRoot, 'report.docx')];
    const d = decide(artifactTool({ kind: 'render', outputs: out }), {}, c, new Grants());
    expect(d).toMatchObject({ decision: 'allow', rule: 'artifact.render' });
    expect(d.reason).not.toContain('browser');
  });

  it('denies a render declaring no outputs', () => {
    const d = decide(artifactTool({ kind: 'render', outputs: [] }), {}, ctx(), new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'artifact.no-outputs' });
  });

  it('denies a fact/mutates divergence — the snapshot machinery follows mutates()', () => {
    const c = ctx();
    const out = [path.join(c.workspaceRoot, 'report.docx')];
    const diverged = artifactTool({ kind: 'render', outputs: out }, { mutates: () => ({ paths: [path.join(c.workspaceRoot, 'other.docx')] }) });
    expect(decide(diverged, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.inconsistent-contract' });
    const nullPlan = artifactTool({ kind: 'render', outputs: out }, { mutates: () => null });
    expect(decide(nullPlan, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.inconsistent-contract' });
  });

  it('denies outputs outside the workspace or into protected paths', () => {
    const c = ctx();
    const outside = artifactTool({ kind: 'render', outputs: [path.join(os.tmpdir(), 'esc.docx')] });
    expect(decide(outside, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.output-outside-workspace' });
    fs.mkdirSync(path.join(c.workspaceRoot, 'state'), { recursive: true });
    const protectedOut = artifactTool({ kind: 'render', outputs: [path.join(c.workspaceRoot, 'state', 'x.docx')] });
    expect(decide(protectedOut, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.output-protected' });
  });
});

describe('decide: artifact inspect', () => {
  const inWs = (c: ToolContext, rel: string): string => path.join(c.workspaceRoot, rel);

  it('auto-allows a session-rendered artifact, naming the inherited consent and execute re-verification', () => {
    const c = ctx();
    const d = decide(artifactTool({ kind: 'inspect', path: inWs(c, 'report.pdf'), sessionRendered: true }), {}, c, new Grants());
    expect(d).toMatchObject({
      decision: 'allow',
      classification: 'reversible',
      rule: 'artifact.inspect-session-artifact',
      noUndo: true,
    });
    expect(d.reason).toContain('re-verified at execute');
    expect(d.reason).toContain('network access blocked');
  });

  it('asks for a document the harness did not produce — grantable, so [s] works', () => {
    const c = ctx();
    const tool = artifactTool({ kind: 'inspect', path: inWs(c, 'vendor.pdf') });
    const grants = new Grants();
    const d = decide(tool, {}, c, grants);
    expect(d).toMatchObject({ decision: 'ask', classification: 'sensitive', rule: 'artifact.inspect-approval-required', noUndo: true });
    expect(isGrantable(d.classification)).toBe(true);
    grants.add(tool.name, 'sensitive');
    expect(decide(tool, {}, c, grants)).toMatchObject({ decision: 'allow', rule: 'artifact.inspect-approval-required+grant' });
  });

  it('denies inspection outside the workspace', () => {
    const c = ctx();
    const d = decide(artifactTool({ kind: 'inspect', path: path.join(os.tmpdir(), 'foreign.pdf') }), {}, c, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'artifact.inspect-outside-workspace' });
  });

  it('denies secret-named documents outright — pixels cannot be redacted', () => {
    const c = ctx();
    for (const rel of ['.env', 'conf/.env.production', 'keys/server.pem', 'credentials.pdf']) {
      const d = decide(artifactTool({ kind: 'inspect', path: inWs(c, rel), sessionRendered: true }), {}, c, new Grants());
      expect(d, rel).toMatchObject({ decision: 'deny', rule: 'artifact.inspect-secret-name' });
    }
  });

  it('denies an inspect tool that declares mutations, and one that declares none at all', () => {
    const c = ctx();
    const mutating = artifactTool({ kind: 'inspect', path: inWs(c, 'a.pdf') }, { mutates: () => ({ paths: [inWs(c, 'x')] }) });
    expect(decide(mutating, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.mutating-contract' });
    const undeclarable = artifactTool({ kind: 'inspect', path: inWs(c, 'a.pdf') }, { mutates: () => null });
    expect(decide(undeclarable, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.mutating-contract' });
  });

  it('denies an inspect that names no path', () => {
    expect(decide(artifactTool({ kind: 'inspect' }), {}, ctx(), new Grants())).toMatchObject({
      decision: 'deny',
      rule: 'artifact.invalid-contract',
    });
  });
});

describe('decide: artifact contract hygiene', () => {
  it('a throwing artifact() is a deny, never an escape into a later branch', () => {
    const tool = artifactTool(
      { kind: 'inspect', path: 'x' },
      {
        artifact: () => {
          throw new Error('boom');
        },
      },
    );
    expect(decide(tool, {}, ctx(), new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.invalid-contract' });
  });

  it('artifact combined with any other fact is a conflicting contract, from both directions', () => {
    const c = ctx();
    const withCommand = artifactTool({ kind: 'inspect', path: inWsPath(c) }, { command: () => 'echo hi' });
    expect(decide(withCommand, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'artifact.conflicting-contract' });
    const checkSide = artifactTool({ kind: 'inspect', path: inWsPath(c) }, { check: () => ({ resolved: [] }) });
    expect(decide(checkSide, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'check.conflicting-contract' });
    const browserSide = artifactTool(
      { kind: 'inspect', path: inWsPath(c) },
      { browser: () => ({ flowName: 'f', stepCount: 1, previewBound: true }) },
    );
    expect(decide(browserSide, {}, c, new Grants())).toMatchObject({ decision: 'deny', rule: 'browser.conflicting-contract' });
    function inWsPath(cc: ToolContext): string {
      return path.join(cc.workspaceRoot, 'a.pdf');
    }
  });
});
