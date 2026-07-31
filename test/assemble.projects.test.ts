import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSession } from '../src/cli/assemble.js';
import { childTools } from '../src/runtime/subagent.js';
import { ROLE_CONTRACTS } from '../src/runtime/roles.js';
import { MockProvider } from '../src/provider/mock.js';
import { autoDenyApprover } from '../src/runtime/approvals.js';
import { createNoneSandbox } from '../src/sandbox/none.js';
import type { GitFacts } from '../src/git/types.js';

/** No git: assembly must not probe, exactly as `cli.assemble.test.ts` declares it. */
const NO_GIT = {
  isRepo: false,
  gitPath: null,
  gitVersion: null,
  repoRoot: null,
  workspaceIsRepoRoot: false,
  branch: null,
  detached: false,
  unborn: false,
  head: null,
} as unknown as GitFacts;
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { endSession } from '../src/runtime/session.js';

/**
 * The multi-project seam nothing else crosses (Session 16 review finding): the prompt facts, the
 * three tools' SHARED detection, the tool registry the model actually receives, and the
 * parent-only boundary all meet only inside `assembleSession`.
 *
 * Without the registry pin, deleting one line in assemble.ts makes `project_setup` unreachable by
 * the model and leaves every other test in this session green.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-asmproj-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function nodeProject(rel: string, scripts: Record<string, string>): void {
  const dir = rel === '.' ? ws : path.join(ws, rel);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: rel.replace(/[./]/g, '-') || 'root', private: true, scripts }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
}

const assemble = () =>
  assembleSession({
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
  } as never);

describe('the model actually receives the Session 16 tools', () => {
  it('attaches project_setup beside run_check and preview', async () => {
    nodeProject('api', { test: 'vitest run' });
    const a = await assemble();
    try {
      const names = a.session.tools.map((t) => t.name);
      expect(names).toContain('project_setup');
      expect(names).toContain('run_check');
      expect(names).toContain('preview');
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);

  it('keeps project_setup PARENT-ONLY — no role registry can reach it', () => {
    for (const [role, contract] of Object.entries(ROLE_CONTRACTS)) {
      const tools = childTools(contract.toolNames);
      expect(tools.some((t) => t.name === 'project_setup'), role).toBe(false);
      expect(tools.some((t) => t.name === 'run_check'), role).toBe(false);
      expect(tools.some((t) => t.name === 'preview'), role).toBe(false);
    }
  });
});

describe('ONE detection per session', () => {
  it('hands the SAME snapshot to all three tools', async () => {
    nodeProject('api', { test: 'vitest run' });
    nodeProject('web', { dev: 'vite' });
    const a = await assemble();
    try {
      // Reference identity, not deep equality: the point is that they cannot diverge, which two
      // independent `detectWorkspace` calls would allow the moment a manifest changes mid-session.
      expect(a.checkTool.workspaceSnapshot()).toBe(a.previewTool.workspaceSnapshot());
      expect(a.setupTool.workspaceSnapshot()).toBe(a.checkTool.workspaceSnapshot());
      expect(a.checkTool.workspaceSnapshot().units.map((u) => u.id)).toEqual(['api', 'web']);
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);

  it('tells the model which projects exist, in the system prompt it was built with', async () => {
    nodeProject('api', { test: 'vitest run', migrate: 'node m.js' });
    nodeProject('web', { dev: 'vite' });
    const a = await assemble();
    try {
      expect(a.session.system).toContain('Detected projects in this workspace (2):');
      expect(a.session.system).toContain('- api (node; npm; lockfile package-lock.json');
      expect(a.session.system).toContain('REFUSES to guess');
      expect(a.session.system).toContain('go through `project_setup`');
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);

  it('a single-project workspace still gets the facts, without the multi-project warning', async () => {
    nodeProject('.', { test: 'vitest run' });
    const a = await assemble();
    try {
      expect(a.session.system).toContain('Detected projects in this workspace (1):');
      expect(a.session.system).not.toContain('REFUSES to guess');
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);
});
