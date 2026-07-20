import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSession, type AssembleDeps } from '../src/cli/assemble.js';
import { endSession } from '../src/runtime/session.js';
import { resolveLayout } from '../src/store/layout.js';
import { createNoneSandbox } from '../src/sandbox/none.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
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
});
