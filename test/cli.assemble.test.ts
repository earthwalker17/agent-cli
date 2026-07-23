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
