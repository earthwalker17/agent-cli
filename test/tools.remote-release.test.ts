import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemoteReleaseTool } from '../src/tools/remote-release.js';
import { createRemoteState, type RemoteState } from '../src/tools/remote-state.js';
import { endpointOf } from '../src/remote/url.js';
import type { GhInvocation, GhResult, GhRunner, RemoteContext, RemoteObservation } from '../src/remote/types.js';
import type { RemoteEvidence, ToolContext } from '../src/types.js';

/**
 * remote_release (Session 20).
 *
 * The behaviour worth the most scrutiny here is a REFUSAL: `gh release create` creates the tag
 * from the default branch when it does not exist, so a release tool that did not check would
 * publish a tag nobody asked for at a commit nobody named. This tool refuses unless an observation
 * shows the tag on the remote, and passes `--verify-tag` regardless — belt and braces, because the
 * observation is ours and the flag is GitHub's.
 */

let tmp: string;
let evidence: RemoteEvidence[];
let ghCalls: GhInvocation[];

function ghOk(stdout: string): GhResult {
  return { ok: true, exitCode: 0, termination: 'exited', stdout, stderr: '', durationMs: 1 };
}

function runner(byFirstArgs: Record<string, GhResult>): GhRunner {
  return async (inv) => {
    ghCalls.push(inv);
    const key = inv.argv.slice(0, 2).join(' ');
    return byFirstArgs[key] ?? { ok: false, exitCode: 1, termination: 'exited', stdout: '', stderr: `unexpected: ${key}`, durationMs: 1 };
  };
}

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aremorel-')));
  evidence = [];
  ghCalls = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function context(): RemoteContext {
  return {
    gh: { ghPath: '/x/gh', version: '2.97.0', authStatusLeakRisk: false, tokenEnvPresentButNotForwarded: false, probeFailed: false, detail: 'gh 2.97.0' },
    endpoints: [endpointOf('origin', 'https://github.com/earthwalker17/agent-cli.git')],
    defaultRemote: 'origin',
    ambiguity: null,
    detail: 'gh 2.97.0; 1 remote(s)',
  };
}

function observation(over: Partial<RemoteObservation> = {}): RemoteObservation {
  return {
    id: 'obs1',
    remoteName: 'origin',
    host: 'github.com',
    slug: 'earthwalker17/agent-cli',
    refName: 'refs/tags/v1.6.0',
    remoteOid: 'a'.repeat(40),
    localOid: 'a'.repeat(40),
    localRef: 'refs/tags/v1.6.0',
    relation: 'up-to-date',
    ahead: 0,
    behind: 0,
    commits: [],
    commitsOmitted: 0,
    changedPaths: [],
    changedPathsOmitted: 0,
    basesIncomplete: false,
    touchesWorkflows: false,
    dirtyCount: 0,
    observedAtMs: 1_000,
    ...over,
  };
}

function state(withIdentity = true, withObservation = true): RemoteState {
  const s = createRemoteState({ context: context(), nowMs: () => 1_000 });
  if (withIdentity) {
    s.setIdentities([{ host: 'github.com', account: 'earthwalker17', protocol: 'https', scopes: ['repo'], source: 'keyring', multipleAccounts: false }]);
  }
  if (withObservation) s.observe(observation());
  return s;
}

function tool(s: RemoteState, gh: GhRunner | null) {
  return createRemoteReleaseTool({ state: s, gh, git: null, notesDir: path.join(tmp, 'state'), events: () => [] });
}

function ctx(): ToolContext {
  return { workspaceRoot: tmp, stateDir: path.join(tmp, 'state'), reportRemote: (e) => evidence.push(e) };
}

const NOTES = '## What changed\n\n- a thing\n- another thing\n';

describe('remote_release — the fact it declares', () => {
  it('composes an argv that ALWAYS carries --verify-tag and never inlines the notes', () => {
    const fact = tool(state(), runner({})).remoteWrite!({ tag: 'v1.6.0', title: 'v1.6.0', notes: NOTES });
    expect(fact.blocked).toBeUndefined();
    expect(fact.argvPreview).toContain('--verify-tag');
    expect(fact.argvPreview).toContain('--notes-file=');
    expect(fact.argvPreview).not.toContain('What changed');
    expect(fact.overwrites).toBe(false);
    expect(fact.exactTarget).toBe('release v1.6.0');
  });

  it('shows the notes the user is about to publish, not merely their length', () => {
    const effect = tool(state(), runner({})).remoteWrite!({ tag: 'v1.6.0', title: 'T', notes: NOTES }).effect.join('\n');
    expect(effect).toContain('What changed');
    expect(effect).toContain('published publicly');
    expect(effect).toContain('notifies watchers');
  });

  it('says plainly that a DRAFT is different', () => {
    const effect = tool(state(), runner({})).remoteWrite!({ tag: 'v1.6.0', title: 'T', notes: NOTES, draft: true }).effect.join('\n');
    expect(effect).toContain('DRAFT');
    expect(effect).toContain('visible only to people who can write');
  });

  it('REFUSES when the tag is not on the remote — the whole reason this is its own operation', () => {
    const s = createRemoteState({ context: context(), nowMs: () => 1_000 });
    s.setIdentities([{ host: 'github.com', account: 'a', protocol: 'https', scopes: ['repo'], source: 'keyring', multipleAccounts: false }]);
    s.observe(observation({ remoteOid: null, relation: 'new' }));
    const fact = tool(s, runner({})).remoteWrite!({ tag: 'v1.6.0', title: 'T', notes: NOTES });
    expect(fact).toMatchObject({ blockedKind: 'precondition' });
    expect(fact.blocked).toContain('would otherwise CREATE the tag');
    expect(fact.blocked).toContain('remote_push');
  });

  it('REFUSES without an observation of that exact tag', () => {
    expect(tool(state(true, false), runner({})).remoteWrite!({ tag: 'v1.6.0', title: 'T', notes: NOTES })).toMatchObject({ blockedKind: 'unobserved' });
    // …and an observation of a DIFFERENT tag does not count.
    const s = state(true, false);
    s.observe(observation({ refName: 'refs/tags/v1.5.0' }));
    expect(tool(s, runner({})).remoteWrite!({ tag: 'v1.6.0', title: 'T', notes: NOTES })).toMatchObject({ blockedKind: 'unobserved' });
  });

  it('REFUSES until the publishing account is on the record', () => {
    const fact = tool(state(false), runner({})).remoteWrite!({ tag: 'v1.6.0', title: 'T', notes: NOTES });
    expect(fact).toMatchObject({ blockedKind: 'unauthenticated' });
    expect(fact.blocked).toContain('view=auth');
  });

  it('REFUSES when gh is absent, and against a non-GitHub destination', () => {
    expect(tool(state(), null).remoteWrite!({ tag: 'v1', title: 'T', notes: NOTES })).toMatchObject({ blockedKind: 'unavailable' });
    const s = createRemoteState({
      context: { ...context(), endpoints: [endpointOf('origin', 'https://gitlab.example.test/g/s/p.git')] },
      nowMs: () => 1_000,
    });
    expect(tool(s, runner({})).remoteWrite!({ tag: 'v1', title: 'T', notes: NOTES })).toMatchObject({ blockedKind: 'not-github' });
  });
});

describe('remote_release — execute', () => {
  const created = ghOk('https://github.com/earthwalker17/agent-cli/releases/tag/v1.6.0\n');
  const viewed = ghOk(JSON.stringify({ url: 'https://github.com/earthwalker17/agent-cli/releases/tag/v1.6.0', tagName: 'v1.6.0', isDraft: false, isPrerelease: false }));

  it('publishes, reads the release back, and records a VERIFIED mutation', async () => {
    const s = state();
    const r = await tool(s, runner({ 'release create': created, 'release view': viewed })).execute({ tag: 'v1.6.0', title: 'T', notes: NOTES }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain('VERIFIED by reading it back');
    expect(evidence[0]).toMatchObject({ kind: 'mutated', operation: 'release.create', exactTarget: 'release v1.6.0', ok: true, verified: true, overwrote: false });
    expect(s.spend.writes).toBe(1);
  });

  it('stages the notes in the STATE dir and removes the staging file afterwards', async () => {
    const notesDir = path.join(tmp, 'state');
    let seenPath: string | undefined;
    const gh: GhRunner = async (inv) => {
      ghCalls.push(inv);
      const flag = inv.argv.find((a) => a.startsWith('--notes-file='));
      if (flag !== undefined) {
        seenPath = flag.slice('--notes-file='.length);
        // The file must exist AND hold the exact notes at the moment gh runs.
        expect(fs.readFileSync(seenPath, 'utf8')).toBe(NOTES);
      }
      return inv.argv[1] === 'create' ? created : viewed;
    };
    await tool(state(), gh).execute({ tag: 'v1.6.0', title: 'T', notes: NOTES }, ctx());
    expect(seenPath?.startsWith(notesDir)).toBe(true);
    expect(fs.existsSync(seenPath!)).toBe(false);
  });

  it('reports ok-but-UNVERIFIED when the release cannot be read back', async () => {
    const gh = runner({ 'release create': created });
    const r = await tool(state(), gh).execute({ tag: 'v1.6.0', title: 'T', notes: NOTES }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain('could NOT be read back');
    expect(evidence[0]).toMatchObject({ ok: true, verified: false });
  });

  it('records a FAILED publish honestly, with the reason gh gave', async () => {
    const gh = runner({ 'release create': { ok: false, exitCode: 1, termination: 'exited', stdout: '', stderr: 'release already exists', durationMs: 1 } });
    const r = await tool(state(), gh).execute({ tag: 'v1.6.0', title: 'T', notes: NOTES }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('release already exists');
    expect(evidence[0]).toMatchObject({ ok: false, verified: false });
  });

  it('refuses at execute when the observation expired while the prompt was open', async () => {
    let now = 1_000;
    const s = createRemoteState({ context: context(), nowMs: () => now });
    s.setIdentities([{ host: 'github.com', account: 'a', protocol: 'https', scopes: ['repo'], source: 'keyring', multipleAccounts: false }]);
    s.observe(observation({ observedAtMs: now }));
    now += 10 * 60_000;
    const r = await tool(s, runner({ 'release create': created })).execute({ tag: 'v1.6.0', title: 'T', notes: NOTES }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('expired');
    expect(ghCalls).toHaveLength(0);
  });
});
