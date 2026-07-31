import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectSetupTool, setupCapsFromEvents, SETUPS_PER_SESSION } from '../src/tools/project-setup.js';
import { resolveSetup, setupFact } from '../src/setup/intents.js';
import { detectWorkspace } from '../src/checks/workspace.js';
import { decide, Grants, isGrantable } from '../src/policy/engine.js';
import { formatApprovalPrompt } from '../src/runtime/approvals.js';
import { startSession, endSession, runTurn, reconstruct } from '../src/runtime/session.js';
import { MockProvider, type ScriptTurn } from '../src/provider/mock.js';
import { TOOLS } from '../src/tools/index.js';
import { EventLog } from '../src/store/event-log.js';
import { resolveLayout, type ProjectLayout } from '../src/store/layout.js';
import { sha256 } from '../src/shared/hash.js';
import type { ApprovalOutcome, ApprovalRequest, Approver, SessionEvent, SetupEvidence, ToolContext } from '../src/types.js';

/**
 * project_setup (Session 16). The rule the whole tool exists to keep: **the model names an INTENT
 * and a UNIT; the harness names the command.** These pins cover the resolution table, the two
 * different consents (an install may replay while its lockfile is unchanged; a migration never
 * may), and the honesty of the resulting evidence.
 */

let tmp: string;
let ws: string;
let layout: ProjectLayout;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcli-setup-')));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  layout = resolveLayout(ws, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface ProjectOpts {
  scripts?: Record<string, string>;
  lock?: { name: string; body: string };
  packageManager?: string;
  deps?: boolean;
  nodeModules?: boolean;
}

function project(rel: string, o: ProjectOpts = {}): void {
  const dir = rel === '.' ? ws : path.join(ws, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (o.nodeModules !== false) fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: rel.replace(/[./]/g, '-') || 'root',
      private: true,
      ...(o.scripts !== undefined ? { scripts: o.scripts } : {}),
      ...(o.packageManager !== undefined ? { packageManager: o.packageManager } : {}),
      ...(o.deps !== false ? { dependencies: { left: '^1.0.0' } } : {}),
    }),
  );
  if (o.lock !== undefined) fs.writeFileSync(path.join(dir, o.lock.name), o.lock.body);
}

const unit = (id: string) => detectWorkspace(ws).units.find((u) => u.id === id)!;
const ctx = (): ToolContext => ({ workspaceRoot: ws, stateDir: layout.projectDir });

describe('install resolution is lockfile-driven', () => {
  it('npm lockfile → npm ci', () => {
    project('.', { lock: { name: 'package-lock.json', body: '{"lockfileVersion":3}' } });
    const r = resolveSetup(unit('.'), 'install').resolved!;
    expect(r.command).toBe('npm ci');
    expect(r.recipeId).toBe('setup.install.npm.ci');
    expect(r.lockfile?.name).toBe('package-lock.json');
    expect(r.replayable).toBe(true);
    expect(r.consequence).toContain('DOWNLOADS AND EXECUTES');
  });

  it('pnpm lockfile → pnpm install --frozen-lockfile', () => {
    project('.', { lock: { name: 'pnpm-lock.yaml', body: 'lockfileVersion: 9\n' } });
    expect(resolveSetup(unit('.'), 'install').resolved!.command).toBe('pnpm install --frozen-lockfile');
  });

  it('yarn v1 and Berry differ, and are read from the packageManager declaration', () => {
    project('.', { lock: { name: 'yarn.lock', body: '# yarn lockfile v1\n' }, packageManager: 'yarn@1.22.22' });
    expect(resolveSetup(unit('.'), 'install').resolved!.command).toBe('yarn install --frozen-lockfile');

    project('.', { lock: { name: 'yarn.lock', body: '__metadata:\n  version: 8\n' }, packageManager: 'yarn@4.5.0' });
    expect(resolveSetup(unit('.'), 'install').resolved!.command).toBe('yarn install --immutable');
  });

  it('REFUSES to guess yarn’s flag when the project does not declare packageManager', () => {
    project('.', { lock: { name: 'yarn.lock', body: '# yarn lockfile v1\n' } });
    const r = resolveSetup(unit('.'), 'install');
    expect(r.resolved).toBeNull();
    expect(r.reason).toContain('--frozen-lockfile');
    expect(r.reason).toContain('--immutable');
    expect(r.reason).toContain('will not guess');
  });

  it('no lockfile still installs, but SAYS the versions are not pinned', () => {
    project('.');
    const r = resolveSetup(unit('.'), 'install').resolved!;
    expect(r.command).toBe('npm install');
    expect(r.consequence).toContain('NO LOCKFILE');
    expect(r.consequence).toContain('NOT pinned');
    // Nothing stable to bind consent to ⇒ this approval covers this call only.
    expect(r.replayable).toBe(false);
  });

  it('refuses Python installs with the reason, rather than guessing an interpreter', () => {
    fs.writeFileSync(path.join(ws, 'pyproject.toml'), '[project]\nname = "x"\n');
    const r = resolveSetup(unit('.'), 'install');
    expect(r.resolved).toBeNull();
    expect(r.reason).toContain('virtual environment');
  });

  it('binds the lockfile CONTENT: editing it changes the consent identity', () => {
    project('.', { lock: { name: 'package-lock.json', body: '{"lockfileVersion":3}' } });
    const before = setupFact(resolveSetup(unit('.'), 'install').resolved!);
    expect(before.bodySha).toBe(sha256(Buffer.from('{"lockfileVersion":3}')));

    fs.writeFileSync(path.join(ws, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    expect(setupFact(resolveSetup(unit('.'), 'install').resolved!).bodySha).not.toBe(before.bodySha);
  });
});

describe('migrate and seed resolve to the project’s OWN declared script', () => {
  it('resolves from the fixed allowlist and binds the untruncated body', () => {
    project('.', { scripts: { 'db:migrate': 'node scripts/migrate.js', seed: 'node scripts/seed.js' } });
    const m = resolveSetup(unit('.'), 'migrate').resolved!;
    expect(m.command).toBe('npm run db:migrate');
    expect(m.recipeId).toBe('setup.migrate.script.db:migrate');
    expect(m.bodySha).toBe(sha256('node scripts/migrate.js'));
    expect(m.replayable).toBe(false);
    expect(m.consequence).toContain('CANNOT undo');

    expect(resolveSetup(unit('.'), 'seed').resolved!.command).toBe('npm run seed');
  });

  it('a project with no migrate script is a capability gap, stated plainly', () => {
    project('.', { scripts: { test: 'vitest run' } });
    const r = resolveSetup(unit('.'), 'migrate');
    expect(r.resolved).toBeNull();
    expect(r.reason).toContain('declares no migrate script');
    expect(r.badRequest).toBeUndefined();
  });

  it('an arbitrary script name is unreachable — migrate is not "run any script"', () => {
    project('.', { scripts: { deploy: 'node deploy.js', 'migrate:prod': 'node prod.js' } });
    expect(resolveSetup(unit('.'), 'migrate').resolved).toBeNull();
  });

  it('refuses while dependencies are missing, pointing at the install', () => {
    project('.', { scripts: { migrate: 'node m.js' }, nodeModules: false });
    expect(resolveSetup(unit('.'), 'migrate').reason).toContain('project_setup install');
  });

  it('qualifies the recipe id per unit', () => {
    project('api', { scripts: { migrate: 'node m.js' } });
    expect(resolveSetup(unit('api'), 'migrate').resolved!.recipeId).toBe('setup.migrate.script.migrate@api');
  });
});

describe('consent: an install may replay; a migration never may', () => {
  it('an install asks as external, then replays under [s] until the lockfile changes', () => {
    project('.', { lock: { name: 'package-lock.json', body: '{"lockfileVersion":3}' } });
    const t = createProjectSetupTool({ workspaceRoot: ws, caps: { setupsRun: 0 } });
    const grants = new Grants();

    const ask = decide(t, { action: 'install' }, ctx(), grants);
    expect(ask).toMatchObject({ decision: 'ask', classification: 'external', rule: 'setup.install-approval-required', noUndo: true, execBoundary: 'unsandboxed' });
    expect(ask.reason).toContain('DOWNLOADS AND EXECUTES');
    for (const k of ask.checkReplayKeys ?? []) grants.addCheckReplay(k);

    expect(decide(t, { action: 'install' }, ctx(), grants)).toMatchObject({ decision: 'allow', rule: 'setup.install-replay-consent' });

    // Any dependency change re-asks — that is the whole point of binding the lockfile.
    fs.writeFileSync(path.join(ws, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    const t2 = createProjectSetupTool({ workspaceRoot: ws, caps: { setupsRun: 0 } });
    expect(decide(t2, { action: 'install' }, ctx(), grants).decision).toBe('ask');
  });

  it('an unhashable-lockfile install issues NO replay keys, so it cannot be granted', () => {
    project('.');
    const t = createProjectSetupTool({ workspaceRoot: ws, caps: { setupsRun: 0 } });
    const d = decide(t, { action: 'install' }, ctx(), new Grants());
    expect(d.decision).toBe('ask');
    expect(d.checkReplayKeys).toBeUndefined();
    expect(d.reason).toContain('THIS CALL ONLY');
  });

  it('migrate/seed are destructive, issue no replay keys, and ask EVERY time', () => {
    project('.', { scripts: { migrate: 'node m.js', seed: 'node s.js' } });
    const t = createProjectSetupTool({ workspaceRoot: ws, caps: { setupsRun: 0 } });
    const grants = new Grants();

    for (const action of ['migrate', 'seed'] as const) {
      const d = decide(t, { action }, ctx(), grants);
      expect(d, action).toMatchObject({ decision: 'ask', classification: 'destructive', rule: 'setup.state-change-approval-required' });
      expect(d.checkReplayKeys, action).toBeUndefined();
      expect(d.reason).toContain('CANNOT undo');
      // Even if something tried to grant it, `destructive` is structurally non-grantable.
      expect(isGrantable(d.classification)).toBe(false);
      grants.add('project_setup', d.classification);
      expect(decide(t, { action }, ctx(), grants).decision, action).toBe('ask');
    }
  });

  it('an [s] for one project’s install does not install the other', () => {
    project('web', { lock: { name: 'package-lock.json', body: '{"a":1}' } });
    project('api', { lock: { name: 'package-lock.json', body: '{"a":1}' } }); // identical lockfile bytes
    const t = createProjectSetupTool({ workspaceRoot: ws, caps: { setupsRun: 0 } });
    const grants = new Grants();

    const ask = decide(t, { action: 'install', project: 'api' }, ctx(), grants);
    for (const k of ask.checkReplayKeys ?? []) grants.addCheckReplay(k);
    expect(decide(t, { action: 'install', project: 'api' }, ctx(), grants).decision).toBe('allow');
    expect(decide(t, { action: 'install', project: 'web' }, ctx(), grants).decision).toBe('ask');
  });
});

describe('the approval prompt', () => {
  const req = (over: Partial<ApprovalRequest> = {}, withCount = false): ApprovalRequest => ({
    callId: 'c1',
    tool: 'project_setup',
    classification: 'external',
    kind: 'setup',
    summary: 'project_setup: install [project api]',
    detail: 'npm ci   [setup.install.npm.ci@api]\n  in: C:/ws/api',
    reason: 'installs dependencies',
    noUndoWarning: true,
    ...(withCount ? { checkCount: 1 } : {}),
    ...over,
  });

  it('shows the command AND the directory, and offers a lockfile-bound [s] for an install', () => {
    const p = formatApprovalPrompt(req({}, true));
    expect(p).toContain('[project setup — harness-resolved command; external]');
    expect(p).toContain('npm ci');
    expect(p).toContain('in: C:/ws/api');
    expect(p).toContain('[s] allow re-runs of THIS EXACT install while the lockfile is unchanged');
    expect(p).toContain('NOT undoable');
  });

  it('offers NO [s] for a migration — nothing would be stored, so nothing is advertised', () => {
    const p = formatApprovalPrompt(req({ classification: 'destructive', summary: 'project_setup: migrate' }));
    expect(p).not.toContain('[s]');
    expect(p).toContain('[y] allow once');
  });

  it('offers no [s] for an install with no bindable lockfile identity', () => {
    expect(formatApprovalPrompt(req())).not.toContain('[s]');
  });
});

describe('execution, evidence and refusals', () => {
  function scriptedApprover(outcomes: ApprovalOutcome[]): { approver: Approver; calls: ApprovalRequest[] } {
    const calls: ApprovalRequest[] = [];
    let i = 0;
    return {
      calls,
      approver: async (r) => {
        calls.push(r);
        return outcomes[i++] ?? { decision: 'deny', scope: 'once', source: 'user' };
      },
    };
  }

  function drive(script: ScriptTurn[], approver: Approver, caps = { setupsRun: 0 }) {
    const setupTool = createProjectSetupTool({ workspaceRoot: ws, caps });
    const session = startSession({
      workspaceRoot: ws,
      layout,
      model: 'mock-model',
      mode: 'interactive',
      provider: new MockProvider(script),
      approver,
      saltHex: '0'.repeat(32),
      maxSteps: 10,
      tools: [...TOOLS, setupTool],
    });
    return { session, setupTool };
  }

  const events = (id: string): SessionEvent[] => EventLog.readLenient(layout.sessionFile(id)).events;

  it('runs the resolved script in the unit directory and records ok', async () => {
    project('api', { scripts: { migrate: 'node -e "process.exit(0)"' } });
    const { approver } = scriptedApprover([{ decision: 'allow', scope: 'once', source: 'user' }]);
    const { session } = drive([{ calls: [{ name: 'project_setup', input: { action: 'migrate', project: 'api' } }] }, { say: 'done' }], approver);

    await runTurn(session, 'migrate');
    endSession(session, 'completed');
    const evs = events(session.id);

    const started = evs.find((e) => e.type === 'setup.started') as { cwd: string; action: string; projectId: string; recipeId: string };
    expect(started.action).toBe('migrate');
    expect(started.projectId).toBe('api');
    expect(started.cwd).toBe(path.join(ws, 'api'));
    expect(started.recipeId).toBe('setup.migrate.script.migrate@api');

    const done = evs.find((e) => e.type === 'setup.completed') as { status: string; exitCode: number | null };
    expect(done.status).toBe('ok');
    expect(done.exitCode).toBe(0);
  }, 60_000);

  it('a non-zero exit is FAILED, never ok — the exit code is the verdict', async () => {
    project('api', { scripts: { seed: 'node -e "process.exit(3)"' } });
    const { approver } = scriptedApprover([{ decision: 'allow', scope: 'once', source: 'user' }]);
    const { session } = drive([{ calls: [{ name: 'project_setup', input: { action: 'seed', project: 'api' } }] }, { say: 'done' }], approver);

    await runTurn(session, 'seed');
    endSession(session, 'completed');
    const done = events(session.id).find((e) => e.type === 'setup.completed') as { status: string; exitCode: number | null };
    expect(done.status).toBe('failed');
    expect(done.exitCode).toBe(3);
  }, 60_000);

  it('a denial runs nothing and records no setup events', async () => {
    project('api', { scripts: { migrate: 'node -e "process.exit(0)"' } });
    const { approver, calls } = scriptedApprover([{ decision: 'deny', scope: 'once', source: 'user' }]);
    const { session } = drive([{ calls: [{ name: 'project_setup', input: { action: 'migrate', project: 'api' } }] }, { say: 'done' }], approver);

    await runTurn(session, 'migrate');
    endSession(session, 'completed');
    expect(calls).toHaveLength(1);
    expect(events(session.id).some((e) => e.type === 'setup.started')).toBe(false);
    expect(events(session.id).some((e) => e.type === 'setup.completed')).toBe(false);
  }, 60_000);

  it('records a capability gap as unsupported WITHOUT a started event — nothing spawned', async () => {
    project('api', { scripts: { test: 'vitest run' } });
    const { approver } = scriptedApprover([]);
    const { session } = drive([{ calls: [{ name: 'project_setup', input: { action: 'migrate', project: 'api' } }] }, { say: 'done' }], approver);

    await runTurn(session, 'migrate');
    endSession(session, 'completed');
    const evs = events(session.id);
    expect(evs.some((e) => e.type === 'setup.started')).toBe(false);
    const done = evs.find((e) => e.type === 'setup.completed') as { status: string; unsupportedReason?: string };
    expect(done.status).toBe('unsupported');
    expect(done.unsupportedReason).toBe('no-recipe');
  }, 60_000);

  it('refuses an unattributable call, recording NOTHING', async () => {
    project('web', { scripts: { migrate: 'node -e ""' } });
    project('api', { scripts: { migrate: 'node -e ""' } });
    const { approver } = scriptedApprover([]);
    const { session } = drive([{ calls: [{ name: 'project_setup', input: { action: 'migrate' } }] }, { say: 'done' }], approver);

    await runTurn(session, 'migrate');
    endSession(session, 'completed');
    const evs = events(session.id);
    expect(evs.some((e) => e.type.startsWith('setup.'))).toBe(false);
    const completed = evs.find((e) => e.type === 'tool.completed') as { outputPreview: string };
    expect(completed.outputPreview).toContain('api, web');
  }, 60_000);

  it('refuses when the lockfile changed after the approval, and spawns nothing', async () => {
    project('.', { scripts: { migrate: 'node -e "process.exit(0)"' } });
    const caps = { setupsRun: 0 };
    const t = createProjectSetupTool({ workspaceRoot: ws, caps });
    // Gate on the current body, then rewrite the script the command invokes.
    const gate = t.check!({ action: 'migrate' });
    expect(gate.resolved).toHaveLength(1);
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'root', private: true, dependencies: { left: '^1' }, scripts: { migrate: 'node -e "process.exit(9)"' } }),
    );
    const r = await t.execute({ action: 'migrate' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain('no longer matches what was gated');
    expect(caps.setupsRun).toBe(0);
  });

  it('refuses once the session budget is spent', async () => {
    project('.', { scripts: { migrate: 'node -e ""' } });
    const t = createProjectSetupTool({ workspaceRoot: ws, caps: { setupsRun: SETUPS_PER_SESSION } });
    const r = await t.execute({ action: 'migrate' }, ctx());
    expect(r.error).toBe('setup budget exhausted');
    expect(r.output).toContain('not progress');
  });

  it('rebuilds the budget from events across a resume, counting attempts', () => {
    const ev = (body: Record<string, unknown>, seq: number): SessionEvent =>
      ({ v: 1, seq, ts: '2026-07-31T00:00:00.000Z', ...body }) as unknown as SessionEvent;
    const evs = [
      ev({ type: 'setup.started', callId: 'a', action: 'install', projectId: '.', recipeId: 'r', command: 'npm ci', cwd: ws, timeoutMs: 1 }, 1),
      ev({ type: 'setup.completed', callId: 'a', action: 'install', projectId: '.', recipeId: 'r', status: 'ok', exitCode: 0, durationMs: 1, summary: 's' }, 2),
      // A crash mid-run leaves a started with no completion: still an attempt.
      ev({ type: 'setup.started', callId: 'b', action: 'seed', projectId: '.', recipeId: 'r2', command: 'npm run seed', cwd: ws, timeoutMs: 1 }, 3),
      // An `unsupported` completion never spawned, so it is NOT an attempt.
      ev({ type: 'setup.completed', callId: 'c', action: 'migrate', projectId: '.', recipeId: 'r3', status: 'unsupported', exitCode: null, durationMs: 0, summary: 's' }, 4),
    ];
    expect(setupCapsFromEvents(evs)).toEqual({ setupsRun: 2 });
  });

  it('reports a setup interrupted by a crash as UNKNOWN state, never as done', async () => {
    project('api', { scripts: { migrate: 'node -e "process.exit(0)"' } });
    const { approver } = scriptedApprover([{ decision: 'allow', scope: 'once', source: 'user' }]);
    const { session } = drive([{ calls: [{ name: 'project_setup', input: { action: 'migrate', project: 'api' } }] }, { say: 'done' }], approver);
    await runTurn(session, 'migrate');
    endSession(session, 'completed');

    // Simulate the crash window: the started event survived, the completion did not.
    const kept = events(session.id).filter((e) => e.type !== 'setup.completed' && e.type !== 'tool.completed');
    const rebuilt = reconstruct(kept, ws);
    const text = JSON.stringify(rebuilt);
    expect(text).toContain('dependency or local data state is UNKNOWN');
  }, 60_000);
});

describe('a setup collects the evidence channel, not the check channel', () => {
  it('never reports through reportCheck — an install must not reach a verification reader', async () => {
    project('api', { scripts: { migrate: 'node -e "process.exit(0)"' } });
    const t = createProjectSetupTool({ workspaceRoot: ws, caps: { setupsRun: 0 } });
    const setups: SetupEvidence[] = [];
    let checkCalls = 0;
    await t.execute(
      { action: 'migrate', project: 'api' },
      { workspaceRoot: ws, stateDir: layout.projectDir, reportSetup: (e) => setups.push(e), reportCheck: () => checkCalls++ },
    );
    expect(setups.map((e) => e.kind)).toEqual(['started', 'ended']);
    expect(checkCalls).toBe(0);
  }, 60_000);
});
