import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAnsi } from '../src/shared/text.js';
import { parsePortCandidates, waitForReady } from '../src/preview/ready.js';
import { resolveChecks } from '../src/checks/recipes.js';
import { detectProject } from '../src/checks/detect.js';
import { createSharedWorkspace } from '../src/checks/session-workspace.js';
import { resolveSetup, sameSetup } from '../src/setup/intents.js';
import { completionGateState, foldGraphState } from '../src/plan/graph-state.js';
import { computeAcceptance } from '../src/runtime/acceptance.js';
import { validatePlanGraph } from '../src/plan/schema.js';
import { readCanonicalPlan } from '../src/plan/canonical.js';
import { proveWith } from '../src/recovery/catalogue.js';
import { collectPassingEvidence, firstPassingEvidenceAfter } from '../src/report/report.js';
import { runCommandTool } from '../src/tools/run-command.js';
import { planApprovalReminder } from '../src/repl/repl.js';
import { resolveLayout } from '../src/store/layout.js';
import { createRunCheckTool } from '../src/tools/run-check.js';
import { createProjectSetupTool } from '../src/tools/project-setup.js';
import { createBrowserFlowTool, type BrowserToolDeps } from '../src/tools/browser-flow.js';
import { decide, Grants } from '../src/policy/engine.js';
import type { ActivePreview } from '../src/tools/preview.js';
import type { PlanGraph } from '../src/plan/schema.js';
import type { SupervisedHandle } from '../src/preview/types.js';
import type { BrowserFlowEvidence, CheckEvidence, SessionEvent, ToolContext } from '../src/types.js';

/**
 * The defects that would have broken — or silently falsified — the FIRST real full-stack live run
 * (Session 16.5). Every one was found by the bounded adversarial review over the Session 16 change
 * set, and every one is here because the shape of the run is what exposed it: two projects, two
 * dev servers, a browser flow over the integrated stack, and an install that has to happen before
 * anything can be verified.
 *
 * They are pinned together because they share that provenance. Two of them were measured on real
 * behaviour of this platform before a line was changed, and neither would have been caught by any
 * amount of single-project testing.
 */

const tmpdir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-blockers-'));

/** The literal bytes Vite writes to a log file on win32: picocolors forces colour off-TTY. */
const VITE_BANNER =
  '\n  \x1b[32m\x1b[1mVITE\x1b[22m v6.0.7\x1b[39m  \x1b[2mready in 412 ms\x1b[22m\n\n' +
  '  \x1b[32m\x1b[1m➤\x1b[22m\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n' +
  '  \x1b[32m\x1b[1m➤\x1b[22m\x1b[39m  \x1b[2mNetwork: use \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\n';

function fakeHandle(tail: string, alive = true): SupervisedHandle {
  return {
    pid: 1,
    logFile: 'x.log',
    exited: new Promise(() => undefined),
    isAlive: () => alive,
    stop: () => Promise.resolve({ ok: true, detail: '' }),
    tail: () => tail,
  };
}

describe('a dev server that colourises its banner is still findable', () => {
  it('stripAnsi removes CSI/OSC/two-char escapes and leaves the text', () => {
    expect(stripAnsi('\x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toBe('http://localhost:5173/');
    expect(stripAnsi('\x1b]0;title\x07plain')).toBe('plain');
    expect(stripAnsi('a\x1b(Bb')).toBe('ab');
    expect(stripAnsi('nothing to strip')).toBe('nothing to strip');
  });

  it('parsePortCandidates finds the port in a REAL colourised Vite banner', () => {
    // Before the strip this returned [] — the port sits behind an SGR sequence, so a parser
    // anchored on `localhost:` matched nothing and a healthy Vite server was reported as never
    // having announced a port. The frontend half of a full-stack session was unstartable.
    expect(parsePortCandidates(VITE_BANNER)).toEqual([5173]);
    // A plain backend log still works, and IPv6 literals are recognised too.
    expect(parsePortCandidates('depot-api listening on http://localhost:3001')).toEqual([3001]);
    expect(parsePortCandidates('Listening on http://[::1]:4000/')).toEqual([4000]);
  });
});

describe('readiness reaches a server bound to IPv6 loopback', () => {
  it('probes 127.0.0.1 then [::1], and records the address that answered', async () => {
    // Node 22 resolves `localhost` verbatim, which on this platform is ::1 first — so a dev
    // server told to listen on the string "localhost" refuses every IPv4 connection. Measured
    // before the fix: listen(0,'localhost') bound ::1 and http://127.0.0.1 was ECONNREFUSED.
    const probed: string[] = [];
    const out = await waitForReady(fakeHandle('Local: http://localhost:5173/'), {
      expectedPort: 5173,
      probeHttp: (url) => {
        probed.push(url);
        return Promise.resolve(url.includes('[::1]') ? 200 : null);
      },
    });
    expect(out).toMatchObject({ ready: true, port: 5173, httpStatus: 200, url: 'http://[::1]:5173/' });
    expect(probed).toEqual(['http://127.0.0.1:5173/', 'http://[::1]:5173/']);
    expect(out.probeDetail).toContain('[::1]');
  });

  it('IPv4 still wins when it answers, and the timeout names both families', async () => {
    const ok = await waitForReady(fakeHandle('http://localhost:5173/'), { expectedPort: 5173, probeHttp: () => Promise.resolve(204) });
    expect(ok.url).toBe('http://127.0.0.1:5173/');

    const dead = await waitForReady(fakeHandle('http://localhost:5173/'), {
      expectedPort: 5173,
      waitMs: 30,
      pollMs: 5,
      probeHttp: () => Promise.resolve(null),
    });
    expect(dead.ready).toBe(false);
    expect(dead.probeDetail).toContain('127.0.0.1');
    expect(dead.probeDetail).toContain('[::1]');
  });
});

describe('an uninstalled project is UNVERIFIED, not unverifiable', () => {
  const write = (root: string, rel: string, body: string): void => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };

  it('a missing node_modules resolves precondition-curable, which does NOT waive a declared gate', () => {
    const root = tmpdir();
    write(root, 'package.json', JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: 'vitest run' }, dependencies: { vitest: '^4' } }));
    const uninstalled = detectProject(root, '.');
    expect(uninstalled.hasDependencies && !uninstalled.hasNodeModules).toBe(true);

    const r = resolveChecks(uninstalled, ['build', 'test']);
    expect(r.resolved).toEqual([]);
    expect(r.unsupported.map((u) => u.why)).toEqual(['build', 'test'].map(() => 'precondition-curable'));
    expect(r.unsupported[0]!.reason).toContain('project_setup');

    // A project-capability precondition is a different answer and still waives.
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    write(root, 'package.json', JSON.stringify({ name: 'x', scripts: {}, dependencies: { vitest: '^4' } }));
    const installed = detectProject(root, '.');
    expect(resolveChecks(installed, ['lint']).unsupported[0]!.why).toBe('no-recipe');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a completion gate stays PENDING over a curable precondition and is waived by a genuine one', () => {
    const graph = { version: 1, goal: 'g', tasks: [], gates: { completion: ['test'] } } as unknown as PlanGraph;
    const base = { v: 1, ts: 't', callId: 'c' } as const;
    const change = { ...base, seq: 1, type: 'file.mutated' } as unknown as SessionEvent;
    const unsupported = (why: string, seq: number): SessionEvent =>
      ({ ...base, seq, type: 'check.completed', check: 'test', recipeId: 'r', status: 'unsupported', unsupportedReason: why, exitCode: null, durationMs: 1, summary: 's' }) as unknown as SessionEvent;

    // Curable: the project was never installed. The gate must NOT go green with a caveat.
    const curable = completionGateState(graph, [change, unsupported('precondition-curable', 2)]);
    expect(curable).toMatchObject({ pending: ['test'], waived: [] });

    // Genuine capability gap: the project has no test recipe at all. Waived, with a caveat.
    const genuine = completionGateState(graph, [change, unsupported('no-recipe', 2)]);
    expect(genuine).toMatchObject({ pending: [], waived: ['test'] });

    // Legacy events (no reason at all) keep the old permissive reading.
    const legacy = completionGateState(graph, [
      change,
      { ...base, seq: 2, type: 'check.completed', check: 'test', recipeId: 'r', status: 'unsupported', exitCode: null, durationMs: 1, summary: 's' } as unknown as SessionEvent,
    ]);
    expect(legacy).toMatchObject({ pending: [], waived: ['test'] });
  });
});

describe('browser evidence carries the project it verified', () => {
  const preview = (over: Partial<ActivePreview> = {}): ActivePreview => ({
    previewId: 'pv-web',
    recipeId: 'preview.script.dev@web',
    projectId: 'web',
    command: 'npm run dev',
    startedAtMs: 0,
    readyObserved: true,
    port: 5173,
    url: 'http://127.0.0.1:5173',
    handle: fakeHandle(''),
    ...over,
  });

  const deps = (over: Partial<BrowserToolDeps> = {}): { deps: BrowserToolDeps; checks: CheckEvidence[]; flows: BrowserFlowEvidence[] } => {
    const checks: CheckEvidence[] = [];
    const flows: BrowserFlowEvidence[] = [];
    const d: BrowserToolDeps = {
      preview: { readyPreview: () => preview(), active: () => [preview()] },
      putBlob: () => 'sha',
      caps: { checksRun: 0 },
      artifactBudget: { usedBytes: 0 },
      probe: () => Promise.resolve({ available: true, channel: 'msedge' }),
      run: (_f, d2) => {
        d2.onBrowserLaunched?.();
        return Promise.resolve({
          status: 'pass' as const,
          steps: [{ n: 1, kind: 'goto', target: '/', ok: true }],
          artifacts: [],
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          offOriginRequests: [],
          finalUrl: 'http://127.0.0.1:5173/',
          durationMs: 5,
          signals: [],
          summary: "flow 'ui': pass",
        });
      },
      ...over,
    };
    return { deps: d, checks, flows };
  };

  const FLOW = { flow: { name: 'ui', steps: [{ do: 'goto' as const, path: '/', ready_when: { selector: '#app' } }] } };

  it('a passing flow records projectId, so a project-scoped browser gate can go green', async () => {
    const h = deps();
    const t = createBrowserFlowTool(h.deps);
    const ctx: ToolContext = { workspaceRoot: tmpdir(), stateDir: tmpdir(), reportCheck: (e) => h.checks.push(e), reportBrowser: (e) => h.flows.push(e) };
    const res = await t.execute(FLOW, ctx);
    expect(res.ok).toBe(true);
    // Both the spawn record and the verdict are attributed — a gate reads the verdict, the
    // report reads both.
    expect(h.checks.map((c) => c.projectId)).toEqual(['web', 'web']);
    // And the result says what it drove: an unbound flow binds to whatever single preview is
    // ready, which in a full-stack session can legitimately be the wrong service.
    expect(res.output).toContain('drove preview pv-web [project web]');
    expect(res.output).toContain('no preview_id was given');

    // The gate this unblocks: `gates.projects: ['web']` over kind 'browser'.
    const graph = { version: 1, goal: 'g', tasks: [], gates: { completion: ['browser'], projects: ['web'] } } as unknown as PlanGraph;
    const events = [
      { v: 1, seq: 1, ts: 't', callId: 'c', type: 'file.mutated' },
      { v: 1, seq: 2, ts: 't', callId: 'c', type: 'check.completed', check: 'browser', recipeId: 'browser.flow/ui', status: 'pass', projectId: 'web', exitCode: null, durationMs: 5, summary: 'ok' },
    ] as unknown as SessionEvent[];
    expect(completionGateState(graph, events)).toMatchObject({ pending: [], waived: [] });
  });

  it('with TWO previews ready and none named, the denial NAMES them instead of saying "start one first"', () => {
    const two = [preview(), preview({ previewId: 'pv-api', projectId: 'api', port: 3001 })];
    const h = deps({ preview: { readyPreview: () => null, active: () => two } });
    const t = createBrowserFlowTool(h.deps);
    const d = decide(t, FLOW, { workspaceRoot: tmpdir(), stateDir: tmpdir() }, new Grants());
    expect(d).toMatchObject({ decision: 'deny', rule: 'browser.no-preview' });
    expect(d.reason).toContain('2 previews are running');
    expect(d.reason).toContain('pv-web [project web]');
    expect(d.reason).toContain('pv-api [project api]');
    expect(d.reason).toContain('preview_id');
    // The old message told a model with two live servers to start a third.
    expect(d.reason).not.toContain('start one with the preview tool first');
  });

  it('a named preview that is not ready is refused with what IS ready', () => {
    const h = deps({ preview: { readyPreview: () => null, active: () => [preview()] } });
    const t = createBrowserFlowTool(h.deps);
    const d = decide(t, { flow: { ...FLOW.flow, preview_id: 'pv-gone' } }, { workspaceRoot: tmpdir(), stateDir: tmpdir() }, new Grants());
    expect(d.reason).toContain("no READY preview with id 'pv-gone'");
    expect(d.reason).toContain('pv-web [project web]');
  });
});

describe('CHECKED does not cross project boundaries', () => {
  const ev = (over: Record<string, unknown>): SessionEvent => ({ v: 1, ts: 't', ...over }) as unknown as SessionEvent;

  it('a green check in web/ does not mark an api/ file CHECKED, and its own file still is', () => {
    const evidence = collectPassingEvidence([
      ev({ seq: 10, callId: 'c1', type: 'check.completed', check: 'build', recipeId: 'node.script.build@web', status: 'pass', projectId: 'web', exitCode: 0, durationMs: 1, summary: 'ok' }),
    ]);
    expect(evidence[0]).toMatchObject({ scope: 'web', exitCode: 0 });
    // The file the check actually covers.
    expect(firstPassingEvidenceAfter(evidence, 5, 'web/src/App.tsx')).toBeDefined();
    // The one it does not. Before this, the report and /diff both asserted the backend was
    // CHECKED by a command that never entered its directory.
    expect(firstPassingEvidenceAfter(evidence, 5, 'api/src/routes.ts')).toBeUndefined();
    // A root-scoped check still covers everything, which is every pre-S16 event.
    const rootRun = collectPassingEvidence([
      ev({ seq: 10, callId: 'c1', type: 'check.completed', check: 'test', recipeId: 'node.script.test', status: 'pass', projectId: '.', exitCode: 0, durationMs: 1, summary: 'ok' }),
    ]);
    expect(firstPassingEvidenceAfter(rootRun, 5, 'api/src/routes.ts')).toBeDefined();
  });

  it("a run_command's declared cwd scopes it the same way", () => {
    const evidence = collectPassingEvidence([
      ev({ seq: 1, callId: 'c1', type: 'tool.requested', tool: 'run_command', input: { command: 'npm test', cwd: 'api' } }),
      ev({ seq: 2, callId: 'c1', type: 'policy.decision', decision: 'ask', tool: 'run_command', classification: 'reversible', rule: 'r', reason: 'x' }),
      ev({ seq: 3, callId: 'c1', type: 'approval.resolved', decision: 'allow', scope: 'once' }),
      ev({ seq: 4, callId: 'c1', type: 'command.ended', termination: 'exited', exitCode: 0, durationMs: 1 }),
      ev({ seq: 5, callId: 'c1', type: 'tool.completed', tool: 'run_command', ok: true, exitCode: 0, durationMs: 1, outputPreview: '' }),
    ]);
    expect(evidence[0]).toMatchObject({ scope: 'api' });
    expect(firstPassingEvidenceAfter(evidence, 0, 'api/src/x.ts')).toBeDefined();
    expect(firstPassingEvidenceAfter(evidence, 0, 'web/src/x.tsx')).toBeUndefined();
  });
});

describe('a blocker has to name the project it means', () => {
  it('boundaryGate reports WHICH scope is missing, and proveWith names it', () => {
    const graph = {
      version: 1,
      goal: 'g',
      tasks: [],
      gates: { completion: ['test'], projects: ['api', 'web'] },
    } as unknown as PlanGraph;
    const events = [
      { v: 1, seq: 1, ts: 't', callId: 'c', type: 'file.mutated' },
      { v: 1, seq: 2, ts: 't', callId: 'c', type: 'check.completed', check: 'test', recipeId: 'r@api', status: 'pass', projectId: 'api', exitCode: 0, durationMs: 1, summary: 'ok' },
    ] as unknown as SessionEvent[];
    const gate = completionGateState(graph, events);
    expect(gate.pending).toEqual(['test']);
    expect(gate.byKind).toEqual([{ kind: 'test', passedIn: ['api'], waivedIn: [], missingIn: ['web'] }]);
    // The guidance a multi-project workspace can actually act on: an unnamed run_check is
    // refused as ambiguous, so the old "prove with run_check test" could never converge.
    expect(proveWith(['test'], 'web')).toBe('run_check test project web');
    expect(proveWith(['test'])).toBe('run_check test');
  });

  it('an unscoped gate over a multi-project workspace is WARNED at the consent boundary', () => {
    const graph = {
      version: 1,
      objective: 'ship it',
      tasks: [{ id: 'a', title: 't', intent: 'i', role: 'executor', dependsOn: [], touches: ['api/'], verify: 'v', risk: 'low', checks: ['test'] }],
      gates: { completion: ['test'] },
    } as unknown as PlanGraph;
    const v = validatePlanGraph(graph, { knownProjects: ['api', 'web'] });
    expect(v.errors).toEqual([]);
    expect(v.warnings.join('\n')).toContain('an unscoped gate is satisfied by a pass in ANY ONE of them');
    expect(v.warnings.join('\n')).toContain('declare checks but no `project`');

    // …and a correctly-scoped plan spelled `./api` is NOT scolded for naming a project that
    // exists. The old raw comparison pushed the model toward dropping scoping altogether.
    const scoped = {
      ...graph,
      tasks: [{ ...(graph as unknown as { tasks: unknown[] }).tasks[0]!, project: './api' }],
      gates: { completion: ['test'], projects: ['api', 'web'] },
    } as unknown as PlanGraph;
    expect(validatePlanGraph(scoped, { knownProjects: ['api', 'web'] }).warnings.join('\n')).not.toContain('which detection does not currently see');
  });
});

describe('an install identity binds every file that changes what an install executes', () => {
  it('.pnpmfile.cjs and .yarnrc.yml move the identity, so a granted [s] does not cover them', () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { x: '^1' } }));
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const before = resolveSetup(detectProject(root, '.'), 'install').resolved;
    expect(before?.command).toBe('pnpm install --frozen-lockfile');

    // An ordinary in-workspace write — auto-allowed — that makes the next install run a hook.
    fs.writeFileSync(path.join(root, '.pnpmfile.cjs'), 'module.exports={hooks:{readPackage:(p)=>p}}');
    const after = resolveSetup(detectProject(root, '.'), 'install').resolved;
    expect(after?.command).toBe(before?.command); // same string…
    expect(after?.installIdentity).not.toBe(before?.installIdentity); // …different consent identity
    expect(sameSetup(before, after)).toBe(false);

    fs.writeFileSync(path.join(root, '.yarnrc.yml'), 'yarnPath: ./evil.cjs\n');
    expect(resolveSetup(detectProject(root, '.'), 'install').resolved?.installIdentity).not.toBe(after?.installIdentity);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('a protected directory is protected as a PLACE, not only as a write target', () => {
  it('run_command refuses .git and .agent-cli as a cwd', async () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.agent-cli'), { recursive: true });
    fs.mkdirSync(path.join(root, 'api'), { recursive: true });
    const ctx: ToolContext = { workspaceRoot: root, stateDir: path.join(tmpdir(), 'state') };
    for (const cwd of ['.git', '.agent-cli']) {
      const r = await runCommandTool.execute({ command: 'node -v', cwd }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('protected directory');
    }
    // A real project directory is still fine (the command itself still asks for approval).
    const ok = await runCommandTool.execute({ command: 'node -v', cwd: 'api' }, ctx);
    expect(ok.output).not.toContain('protected directory');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('the blocker only the user can clear is shown to the USER', () => {
  // Found in the first live full-stack take: the agent amended its own approved plan on the first
  // step of the build turn. The amendment was legitimate, and the harness said so — in the tool
  // result and in the standing note, every turn. But it said it to the MODEL, which cannot type
  // `/plan approve`. Executor delegation was silently impossible from that moment; the agent did
  // all the "parallel isolated" work serially in the main session, and the human found out ten
  // minutes later when /accept refused.
  it('reminds when an amended plan still has unspawned executor tasks, and stays silent otherwise', () => {
    // Driven through the REAL readers (a real layout, a real plan file on disk), so the reminder
    // is pinned against the same `readPlanState` + `foldGraphState` every other surface uses.
    const tmp = tmpdir();
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const layout = resolveLayout(repo, { env: { AGENT_CLI_STATE_DIR: path.join(tmp, 'state') }, ensure: true });
    const graph = {
      version: 1,
      objective: 'ship it',
      tasks: [
        { id: 'summary', title: 'Summary panel', intent: 'build it', role: 'executor', dependsOn: [], touches: ['web/'], verify: 'tests pass', risk: 'low' },
      ],
    };
    const writePlan = (status: string): void => {
      const f = layout.canonicalPlanFile('s1');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ version: 1, planId: 's1', status, updated: 'now', plan: graph }));
    };
    const run = (status: string, events: SessionEvent[]): string[] => {
      const lines: string[] = [];
      writePlan(status);
      planApprovalReminder({
        layout,
        session: { id: 's1', log: { events } },
        renderer: { chromeLine: (l: string) => lines.push(l) },
      } as never);
      return lines;
    };

    // A freshly written, never-approved plan is the ORDINARY post-planning state — the model is
    // presenting it for approval in the same breath. Warning there is noise, and noise at the
    // idle prompt is how real warnings stop being read. (Observed live: the first version of this
    // reminder fired at the end of every planning turn.)
    expect(run('draft', [])).toEqual([]);

    // The take-1 case: an approval EXISTED and no longer covers the plan. Nothing about the
    // screen changed when that happened, so this is the one the user cannot see coming.
    const staleConsent = [{ v: 1, seq: 1, ts: 't', type: 'plan.approved', sha256: 'a'.repeat(64) }] as unknown as SessionEvent[];
    const warned = run('draft', staleConsent);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('CANNOT run until you re-approve');
    expect(warned[0]).toContain('/plan approve');
    expect(warned[0]).toContain('summary');
    expect(warned[0]).toContain('changed after you approved it');

    // Approved AND consented => nothing. The reminder must not become idle-prompt noise.
    // (Both halves are required: a file that merely SAYS approved without a recorded consent
    // event is not approved-and-current, and the harness is right to keep warning about it.)
    // The sha comes from the DOC, not from hashing the literal: the reader parses through zod
    // (applying defaults) before hashing, so a hand-hashed literal is a different plan.
    writePlan('approved');
    const consent = [
      { v: 1, seq: 1, ts: 't', type: 'plan.approved', sha256: readCanonicalPlan(layout, 's1').contentSha },
    ] as unknown as SessionEvent[];
    expect(run('approved', consent)).toEqual([]);
    // A file claiming approval with NO consent recorded is also silent here: there is no
    // approval to have lost, so it is the never-approved case wearing a misleading status word.
    // `/accept` still refuses it, and says so in its own words.
    expect(run('approved', [])).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('an unbound reviewer task is a dead end, not outstanding work', () => {
  // Found in the third live full-stack take. Three lens captures, fourteen findings, every
  // executor task green — and /accept refused four times on `plan task 'review' is queued`,
  // because the reviewers were spawned without `plan_task: 'review'`. With MAX_REVIEW_ROUNDS
  // already spent there was no call left that could bind it: unclearable by the agent, and by
  // the user only via a plan amendment or an override.
  const graph = {
    version: 1,
    objective: 'ship it',
    tasks: [
      { id: 'build', title: 'B', intent: 'i', role: 'executor', dependsOn: [], touches: ['src/'], verify: 'v', risk: 'low' },
      { id: 'review', title: 'R', intent: 'i', role: 'reviewer', dependsOn: ['build'], touches: [], verify: 'v', risk: 'low' },
    ],
  } as unknown as PlanGraph;

  const planState = {
    kind: 'canonical',
    status: 'approved',
    approvedAndCurrent: true,
    diverged: false,
    canonical: { graph },
  } as never;

  /** An executor that ran and applied, then a review round captured with NO plan_task binding. */
  const events = [
    { v: 1, seq: 1, ts: 't', callId: 'c1', type: 'task.started', role: 'executor', planTaskId: 'build', childSessionId: 'k1' },
    { v: 1, seq: 2, ts: 't', callId: 'c1', type: 'task.changes', childSessionId: 'k1', files: [{ relPath: 'src/a.ts', kind: 'modify', afterSha256: 'a', beforeSha256: 'b', bytes: 1 }], omittedCount: 0 },
    { v: 1, seq: 3, ts: 't', callId: 'c1', type: 'task.ended', childSessionId: 'k1', status: 'completed' },
    { v: 1, seq: 4, ts: 't', callId: 'c1', type: 'task.applied', childSessionId: 'k1', applied: ['src/a.ts'], refused: [] },
    { v: 1, seq: 5, ts: 't', callId: 'c1', type: 'file.mutated', path: 'C:/ws/src/a.ts' },
    { v: 1, seq: 6, ts: 't', callId: 'c2', type: 'task.started', role: 'reviewer', childSessionId: 'k2' },
    { v: 1, seq: 7, ts: 't', callId: 'c2', type: 'review.findings', childSessionId: 'k2', lens: 'security', findings: [] },
    { v: 1, seq: 8, ts: 't', callId: 'c2', type: 'task.ended', childSessionId: 'k2', status: 'completed' },
  ] as unknown as SessionEvent[];

  it('does not block acceptance, and says so as a caveat', () => {
    const fold = foldGraphState(graph, events);
    expect(fold.byId.get('review')?.state).not.toBe('completed'); // the binding genuinely is absent
    const acc = computeAcceptance(planState, fold, events);
    expect(acc.unfinished).toEqual([]);
    expect(acc.complete).toBe(true);
    expect(acc.caveats.join('\n')).toContain("plan task 'review' was never bound");
    expect(acc.caveats.join('\n')).toContain('review requirement itself IS satisfied');
  });

  it('still blocks when the review requirement is genuinely unmet', () => {
    // Same graph, same executor work — but no review round at all. The requirement is real and
    // the task is real outstanding work; nothing here may be waived.
    const noReview = events.filter((e) => (e as { callId?: string }).callId !== 'c2');
    const acc = computeAcceptance(planState, foldGraphState(graph, noReview), noReview);
    expect(acc.complete).toBe(false);
    expect(acc.unfinished.join('\n')).toContain("plan task 'review'");
  });
});

describe('the session sees its own install', () => {
  it('after project_setup, the next run_check resolves the real command instead of a false drift refusal', () => {
    const root = tmpdir();
    const api = path.join(root, 'api');
    fs.mkdirSync(api, { recursive: true });
    fs.writeFileSync(path.join(api, 'package.json'), JSON.stringify({ name: 'api', scripts: { build: 'tsc' }, dependencies: { express: '^4' } }));
    fs.writeFileSync(path.join(api, 'package-lock.json'), '{"lockfileVersion":3}');

    const shared = createSharedWorkspace(root);
    const check = createRunCheckTool({ workspaceRoot: root, caps: { checksRun: 0 }, shared });
    const setup = createProjectSetupTool({ workspaceRoot: root, caps: { setupsRun: 0 }, shared });

    // Before the install nothing resolves: the project declares dependencies and has none.
    expect(check.check?.({ checks: ['build'], project: 'api' }).resolved).toEqual([]);
    expect(setup.check?.({ action: 'install', project: 'api' }).resolved[0]?.command).toBe('npm ci');

    // The install happens (its effect, not its execution — this is about snapshot propagation).
    fs.mkdirSync(path.join(api, 'node_modules'), { recursive: true });
    shared.refresh();

    // The very next check now resolves a REAL command at DECIDE time, so the human is asked
    // about `npm run build` rather than the call being allowed as "nothing to run" and then
    // refused at execute with "the project changed after this call was approved".
    const resolved = check.check?.({ checks: ['build'], project: 'api' }).resolved ?? [];
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ command: 'npm run build', projectId: 'api' });
    expect(check.workspaceSnapshot().units.map((u) => u.id)).toEqual(['api']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('all three tools share ONE snapshot, so any refresh is visible to the others', () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'solo', scripts: { test: 'vitest run' } }));
    const shared = createSharedWorkspace(root);
    const check = createRunCheckTool({ workspaceRoot: root, caps: { checksRun: 0 }, shared });
    const setup = createProjectSetupTool({ workspaceRoot: root, caps: { setupsRun: 0 }, shared });
    expect(check.workspaceSnapshot()).toBe(setup.workspaceSnapshot());

    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'vite' } }));
    setup.refresh();
    expect(check.workspaceSnapshot().units.map((u) => u.id)).toEqual(['.', 'web']);
    expect(check.workspaceSnapshot()).toBe(setup.workspaceSnapshot());
    fs.rmSync(root, { recursive: true, force: true });
  });
});

