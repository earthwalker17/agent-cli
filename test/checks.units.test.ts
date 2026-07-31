import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunCheckTool, describeWorkspace, workspaceAvailableKinds } from '../src/tools/run-check.js';
import { detectWorkspace } from '../src/checks/workspace.js';
import { checkReplayKey, decide, Grants } from '../src/policy/engine.js';
import { startSession, endSession, runTurn } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { TOOLS } from '../src/tools/index.js';
import { EventLog } from '../src/store/event-log.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { fixedClock } from '../src/shared/clock.js';
import { seededIdGen } from '../src/shared/ids.js';
import type { ApprovalOutcome, ApprovalRequest, Approver, SessionEvent, ToolContext } from '../src/types.js';

/**
 * Per-unit typed checks (Session 16). The properties here are the ones that make a multi-project
 * workspace safe rather than merely possible: a command runs in the unit it belongs to, its
 * evidence says which unit that was, one unit's approval is not another unit's approval, and a
 * call the harness cannot attribute to a project refuses without recording anything.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-checkunits-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A real Node project at `rel` ('.' = the workspace root). */
function nodeProject(rel: string, scripts: Record<string, string>): void {
  const dir = rel === '.' ? ws : path.join(ws, rel);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: rel.replace(/\//g, '-'), private: true, scripts }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
}

const ctx = (): ToolContext => ({ workspaceRoot: ws, stateDir: layout.projectDir });

describe('resolution is per unit', () => {
  it('qualifies the recipe id, sets the unit cwd, and carries the project on the fact', () => {
    nodeProject('web', { test: 'vitest run' });
    nodeProject('api', { test: 'vitest run' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });

    const api = tool.check!({ checks: ['test'], project: 'api' }).resolved[0]!;
    expect(api.recipeId).toBe('node.script.test@api');
    expect(api.projectId).toBe('api');
    expect(api.cwd).toBe(path.join(ws, 'api'));
    expect(api.command).toBe('npm run test');

    const web = tool.check!({ checks: ['test'], project: 'web' }).resolved[0]!;
    expect(web.recipeId).toBe('node.script.test@web');
    expect(web.cwd).toBe(path.join(ws, 'web'));
  });

  it('leaves a single ROOT project byte-identical to pre-Session-16 — no gratuitous qualification', () => {
    nodeProject('.', { test: 'vitest run' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const r = tool.check!({ checks: ['test'] }).resolved[0]!;
    expect(r.recipeId).toBe('node.script.test'); // NOT 'node.script.test@.'
    expect(r.projectId).toBe('.');
    expect(r.cwd).toBe(ws);
  });

  it('resolves each unit against its OWN scripts, not the root package.json', () => {
    nodeProject('web', { test: 'vitest run', dev: 'vite' });
    nodeProject('api', { build: 'tsc -p .' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });

    // `api` declares no test script and has no test tool ⇒ unsupported there, resolvable in web.
    expect(tool.check!({ checks: ['test'], project: 'api' }).resolved).toEqual([]);
    expect(tool.check!({ checks: ['test'], project: 'web' }).resolved).toHaveLength(1);
    expect(tool.check!({ checks: ['build'], project: 'api' }).resolved[0]!.command).toBe('npm run build');
  });

  it('unions the runnable kinds across units for the plan-time warning surface', () => {
    nodeProject('web', { test: 'vitest run' });
    nodeProject('api', { build: 'tsc -p .' });
    // `build` comes only from api, `test`/`test-targeted` only from web — neither unit alone
    // would have warned the plan validator that both gates are runnable here.
    expect(workspaceAvailableKinds(detectWorkspace(ws))).toEqual(['build', 'test', 'test-targeted']);
  });
});

describe('consent is per unit', () => {
  it('gives two units with an IDENTICAL command different replay keys', () => {
    nodeProject('web', { test: 'vitest run' });
    nodeProject('api', { test: 'vitest run' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });

    const key = (project: string): string => {
      const f = tool.check!({ checks: ['test'], project }).resolved[0]!;
      return checkReplayKey(f.recipeId, f.command, f.bodySha, f.projectId);
    };
    expect(key('api')).not.toBe(key('web'));
  });

  it('an [s] granted for one unit does NOT allow the other', () => {
    nodeProject('web', { test: 'vitest run' });
    nodeProject('api', { test: 'vitest run' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const grants = new Grants();

    const apiAsk = decide(tool, { checks: ['test'], project: 'api' }, ctx(), grants);
    expect(apiAsk.decision).toBe('ask');
    for (const k of apiAsk.checkReplayKeys ?? []) grants.addCheckReplay(k);

    expect(decide(tool, { checks: ['test'], project: 'api' }, ctx(), grants).decision).toBe('allow');
    expect(decide(tool, { checks: ['test'], project: 'web' }, ctx(), grants).decision).toBe('ask');
  });

  it('shows the directory the command will run in, so the human approves WHERE as well as WHAT', () => {
    nodeProject('api', { test: 'vitest run' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const f = tool.check!({ checks: ['test'], project: 'api' }).resolved[0]!;
    expect(f.cwd).toBe(path.join(ws, 'api'));
  });
});

describe('ambiguity refuses; it never guesses', () => {
  function scriptedApprover(outcomes: ApprovalOutcome[]): { approver: Approver; calls: ApprovalRequest[] } {
    const calls: ApprovalRequest[] = [];
    let i = 0;
    return {
      calls,
      approver: async (req) => {
        calls.push(req);
        return outcomes[i++] ?? { decision: 'deny', scope: 'once', source: 'user' };
      },
    };
  }

  function makeSession(script: ScriptTurn[], approver: Approver) {
    const checkTool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    return startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'interactive',
      provider: new MockProvider(script),
      approver,
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      clock: fixedClock(0, 1),
      idGen: seededIdGen(),
      tools: [...TOOLS, checkTool],
    });
  }

  it('refuses an unnamed project when several exist, records NOTHING, and names the real ids', async () => {
    nodeProject('web', { test: 'node -e ""' });
    nodeProject('api', { test: 'node -e ""' });
    const { approver, calls } = scriptedApprover([{ decision: 'allow', scope: 'once', source: 'user' }]);
    const session = makeSession([{ calls: [{ name: 'run_check', input: { checks: ['test'] } }] }, { say: 'done' }], approver);

    await runTurn(session, 'verify');
    endSession(session, 'completed');
    const events: SessionEvent[] = EventLog.readLenient(layout.sessionFile(session.id)).events;

    const completed = events.find((e) => e.type === 'tool.completed');
    expect(completed).toMatchObject({ ok: false });
    expect((completed as { outputPreview: string }).outputPreview).toContain('api, web');
    expect((completed as { outputPreview: string }).outputPreview).toContain('Name one with "project"');

    // A caller mistake must never become gate evidence, and must never spawn.
    expect(events.some((e) => e.type === 'check.started')).toBe(false);
    expect(events.some((e) => e.type === 'check.completed')).toBe(false);
    expect(calls).toHaveLength(0); // nothing was even asked about
  });

  it('refuses an unknown project id', async () => {
    nodeProject('api', { test: 'node -e ""' });
    const { approver } = scriptedApprover([]);
    const session = makeSession([{ calls: [{ name: 'run_check', input: { checks: ['test'], project: 'backend' } }] }, { say: 'done' }], approver);

    await runTurn(session, 'verify');
    endSession(session, 'completed');
    const events: SessionEvent[] = EventLog.readLenient(layout.sessionFile(session.id)).events;
    const completed = events.find((e) => e.type === 'tool.completed');
    expect((completed as { outputPreview: string }).outputPreview).toContain("unknown project 'backend'");
    expect(events.some((e) => e.type === 'check.completed')).toBe(false);
  });

  it('does NOT refuse when the workspace has exactly one project and none was named', () => {
    nodeProject('api', { test: 'vitest run' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    expect(tool.check!({ checks: ['test'] }).resolved[0]!.projectId).toBe('api');
  });

  it('a root manifest does NOT make an unnamed call unambiguous', () => {
    // Root-wins would silently resolve against a container root that declares no test script,
    // yielding `unsupported: no-recipe` — a reason that WAIVES a declared gate. Refusing is the
    // only answer that cannot quietly retire verification the user asked for.
    nodeProject('.', { test: 'vitest run' });
    nodeProject('api', { test: 'vitest run' });
    const tool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    expect(tool.check!({ checks: ['test'] }).resolved).toEqual([]);
    expect(tool.check!({ checks: ['test'], project: '.' }).resolved[0]!.projectId).toBe('.');
  });
});

describe('evidence names the unit', () => {
  it('records projectId on check.started and check.completed, and runs in the unit directory', async () => {
    nodeProject('api', { test: 'node -e "process.exit(0)"' });
    nodeProject('web', { test: 'node -e "process.exit(0)"' });
    const checkTool = createRunCheckTool({ workspaceRoot: ws, caps: { checksRun: 0 } });
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'interactive',
      provider: new MockProvider([{ calls: [{ name: 'run_check', input: { checks: ['test'], project: 'api' } }] }, { say: 'ok' }]),
      approver: async () => ({ decision: 'allow', scope: 'once', source: 'user' }),
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      tools: [...TOOLS, checkTool],
    });

    await runTurn(session, 'verify api');
    endSession(session, 'completed');
    const events: SessionEvent[] = EventLog.readLenient(layout.sessionFile(session.id)).events;

    const started = events.find((e) => e.type === 'check.started') as { projectId?: string; cwd: string; recipeId: string } | undefined;
    expect(started?.projectId).toBe('api');
    expect(started?.recipeId).toBe('node.script.test@api');
    expect(started?.cwd).toBe(path.join(ws, 'api')); // the evidence names where it REALLY ran

    const done = events.find((e) => e.type === 'check.completed') as { projectId?: string; status: string } | undefined;
    expect(done?.projectId).toBe('api');
    expect(done?.status).toBe('pass');
  }, 60_000);
});

describe('the /checks surface', () => {
  it('renders one block per project and surfaces discovery notes', () => {
    nodeProject('web', { test: 'vitest run' });
    nodeProject('api', { build: 'tsc -p .' });
    const text = describeWorkspace(detectWorkspace(ws)).join('\n');
    expect(text).toContain('[project api]');
    expect(text).toContain('[project web]');
  });

  it('renders a single root project exactly as before — no [project] heading to read past', () => {
    nodeProject('.', { test: 'vitest run' });
    const lines = describeWorkspace(detectWorkspace(ws));
    expect(lines.some((l) => l.startsWith('[project'))).toBe(false);
    expect(lines[0]).toBe('project: node');
  });

  it('still describes a workspace with no project at all', () => {
    expect(describeWorkspace(detectWorkspace(ws))[0]).toContain('no supported manifest detected');
  });
});
