import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assembleSession, CHILD_ONLY_TOOL_NAMES, SESSION_TOOL_NAMES } from '../src/cli/assemble.js';
import { childTools } from '../src/runtime/subagent.js';
import { ROLE_CONTRACTS } from '../src/runtime/roles.js';
import { TOOLS } from '../src/tools/index.js';
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
    config: { rules: { protectedPaths: [], secretPatterns: [], envExcludePatterns: [], researchBlockedDomains: [] }, sources: [] },
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

/**
 * `SESSION_TOOL_NAMES` is the vocabulary two other places read (the provider naming rule, the
 * child-registry checks). A vocabulary that drifts from the registry is worse than no vocabulary,
 * because everything downstream keeps passing while covering less — which is exactly how the
 * naming rule went four names stale between S16 and S19. This is the pin that catches it.
 */
describe('the exported tool vocabulary matches the registry the model receives', () => {
  it('every tool a real assembly attaches is either a static TOOL or a declared session name', async () => {
    nodeProject('.', { test: 'vitest run' });
    const a = await assemble();
    try {
      const statics = new Set(TOOLS.map((t) => t.name));
      const declared = new Set<string>(SESSION_TOOL_NAMES);
      for (const name of a.session.tools.map((t) => t.name)) {
        expect(statics.has(name) || declared.has(name), `undeclared session tool: ${name}`).toBe(true);
      }
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);

  it('every UNCONDITIONAL session name is actually attached (a name nothing registers is a lie)', async () => {
    nodeProject('.', { test: 'vitest run' });
    const a = await assemble();
    try {
      const attached = new Set(a.session.tools.map((t) => t.name));
      // `retrieve` needs a git-backed index, `web_search` needs a research credential, and the
      // three `remote_*` tools need a configured git remote; none is present in this hermetic
      // no-git, no-key assembly. Everything else is unconditional.
      const conditional = new Set(['retrieve', 'web_search', 'remote_status', 'remote_push', 'remote_release']);
      for (const name of SESSION_TOOL_NAMES) {
        if (conditional.has(name)) continue;
        expect(attached.has(name), `declared but never registered: ${name}`).toBe(true);
      }
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);

  it('no CHILD-ONLY name leaks into the parent registry', async () => {
    nodeProject('.', { test: 'vitest run' });
    const a = await assemble();
    try {
      const attached = new Set(a.session.tools.map((t) => t.name));
      for (const name of CHILD_ONLY_TOOL_NAMES) {
        expect(attached.has(name), `child-only tool reached the parent: ${name}`).toBe(false);
      }
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);
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
      expect(a.session.system).toContain('Detected projects in this workspace (2), AS OBSERVED AT SESSION START');
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
      expect(a.session.system).toContain('Detected projects in this workspace (1), AS OBSERVED AT SESSION START');
      expect(a.session.system).not.toContain('REFUSES to guess');
    } finally {
      endSession(a.session, 'completed');
    }
  }, 60_000);
});
