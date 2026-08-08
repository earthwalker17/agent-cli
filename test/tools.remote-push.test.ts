import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { observeRemoteRef, runRemoteGit, type RemoteGitDeps } from '../src/remote/observe.js';
import { createRemotePushTool } from '../src/tools/remote-push.js';
import { createRemoteState, type RemoteState } from '../src/tools/remote-state.js';
import { LOCAL_FILESYSTEM_HOST, endpointOf } from '../src/remote/url.js';
import { REMOTE_OBSERVATION_MAX_AGE_MS, type RemoteEvidence, type SessionEvent, type ToolContext } from '../src/types.js';
import type { RemoteContext } from '../src/remote/types.js';

/**
 * remote_push end to end against a REAL remote (Session 20).
 *
 * A local `git init --bare` repository is a real remote, so observe → declare → dry-run compare →
 * push → verify runs against genuine git behaviour with no network and no credential. Both halves
 * of the boundary are proved here: the automation after approval, and the refusals before it.
 *
 * Note what these tests deliberately DO NOT do: they never call `decide()`. The engine's refusals
 * are pinned in `policy.remote.test.ts`; these pin the TOOL — the fact it declares, and what its
 * execute actually does to a remote.
 */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let repo: string;
let bare: string;
let savedEnv: Record<string, string | undefined>;
let evidence: RemoteEvidence[];

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aremopush-')));
  repo = path.join(tmp, 'repo');
  bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(repo);
  const emptyCfg = path.join(tmp, 'empty-gitconfig');
  fs.writeFileSync(emptyCfg, '');
  savedEnv = { GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'], GIT_CONFIG_SYSTEM: process.env['GIT_CONFIG_SYSTEM'] };
  process.env['GIT_CONFIG_GLOBAL'] = emptyCfg;
  process.env['GIT_CONFIG_SYSTEM'] = emptyCfg;
  evidence = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function git(cwd: string, ...argv: string[]) {
  return runGit({ gitPath: REAL_GIT!, argv, cwd });
}
const IDENT = ['-c', 'user.name=T', '-c', 'user.email=t@e.c'];

async function setup(): Promise<void> {
  expect((await git(tmp, 'init', '--bare', '-q', '-b', 'main', bare)).ok).toBe(true);
  expect((await git(repo, 'init', '-q', '-b', 'main')).ok).toBe(true);
  expect((await git(repo, 'remote', 'add', 'origin', bare)).ok).toBe(true);
}

async function commit(message: string, files: Record<string, string> = { 'a.txt': message }): Promise<string> {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  await git(repo, 'add', '-A', '--', '.');
  expect((await git(repo, ...IDENT, 'commit', '-q', '-m', message)).ok).toBe(true);
  return (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
}

function gitDeps(): RemoteGitDeps {
  return { gitPath: REAL_GIT!, repoRoot: repo, workspaceRoot: repo };
}

function remoteContext(): RemoteContext {
  return {
    gh: { ghPath: null, version: null, authStatusLeakRisk: false, tokenEnvPresentButNotForwarded: false, probeFailed: false, detail: 'gh not found' },
    endpoints: [endpointOf('origin', bare)],
    defaultRemote: 'origin',
    ambiguity: null,
    detail: 'local bare remote',
  };
}

let clock = 10_000;
function makeState(): RemoteState {
  clock = 10_000;
  return createRemoteState({ context: remoteContext(), nowMs: () => clock });
}

function tool(state: RemoteState, events: readonly SessionEvent[] = []) {
  return createRemotePushTool({ state, git: { gitPath: REAL_GIT!, repoRoot: repo, workspaceRoot: repo }, events: () => events });
}

function ctx(): ToolContext {
  return { workspaceRoot: repo, stateDir: path.join(tmp, 'state'), reportRemote: (e) => evidence.push(e) };
}

/** Observe one ref exactly as `remote_status view=refs` would, and file it in the shared state. */
async function observe(state: RemoteState, refName: string, localRev: string): Promise<void> {
  const o = await observeRemoteRef(gitDeps(), { remoteName: 'origin', host: 'localhost', slug: null, refName, localRev }, clock);
  state.observe(o);
}

async function remoteOid(refName: string): Promise<string | null> {
  const r = await runRemoteGit(gitDeps(), ['ls-remote', 'origin', refName]);
  const m = /^([0-9a-f]{40,64})\s/m.exec(r.stdout.trim());
  return m?.[1] ?? null;
}

describe.skipIf(!hasGit)('remote_push — the fact it declares', () => {
  it('REFUSES with `unobserved` before anything has been looked at', async () => {
    await setup();
    await commit('one');
    const t = tool(makeState());
    const fact = t.remoteWrite!({ ref: 'main' });
    expect(fact).toMatchObject({ blockedKind: 'unobserved', operation: 'push.branch' });
    expect(fact.blocked).toContain('remote_status view=refs');
  });

  it('declares a complete, machine-derived effect once the ref has been observed', async () => {
    await setup();
    await commit('one');
    await commit('two', { 'src/x.ts': 'export const x = 1;\n' });
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    const fact = tool(state).remoteWrite!({ ref: 'main' });

    expect(fact.blocked).toBeUndefined();
    expect(fact.overwrites).toBe(false);
    expect(fact.exactTarget).toBe('refs/heads/main');
    expect(fact.effect.join('\n')).toContain('CREATE');
    expect(fact.effect.join('\n')).toContain('two');
    expect(fact.effect.join('\n')).toContain('remote-tracking ref');
    // The refspec source is the OBSERVED OID, never a branch name.
    const head = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
    expect(fact.argvPreview).toContain(`${head}:refs/heads/main`);
    expect(fact.observation).toMatchObject({ ageMs: 0, remoteOid: null, localOid: head });
  });

  it('names the uncommitted files that are NOT included', async () => {
    await setup();
    await commit('one');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    expect(tool(state).remoteWrite!({ ref: 'main' }).effect.join('\n')).toContain('uncommitted workspace');
  });

  it('warns about a workflow-file change when the identity lacks the `workflow` scope', async () => {
    await setup();
    await commit('base');
    await runRemoteGit(gitDeps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await commit('ci', { '.github/workflows/ci.yml': 'name: CI\n' });
    const state = makeState();
    // The identity is whatever an `auth` read established — here, one WITHOUT `workflow`, which is
    // the real shape of this machine's token. It is keyed on the sentinel host because the
    // hermetic remote is a filesystem path; against github.com the key is the real hostname and
    // the branch under test is identical.
    state.setIdentities([
      { host: LOCAL_FILESYSTEM_HOST, account: 'earthwalker17', protocol: 'https', scopes: ['gist', 'read:org', 'repo'], source: 'keyring', multipleAccounts: false },
    ]);
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    const effect = tool(state).remoteWrite!({ ref: 'main' }).effect.join('\n');
    expect(effect).toContain('workflow');
    expect(effect).toContain('gh auth refresh');
  });

  it('REFUSES `behind` and `diverged` without force, and classifies force over them as overwriting', async () => {
    await setup();
    await commit('one');
    await commit('two');
    await runRemoteGit(gitDeps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await git(repo, 'reset', '--hard', '-q', 'HEAD~1');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');

    const refused = tool(state).remoteWrite!({ ref: 'main' });
    expect(refused).toMatchObject({ blockedKind: 'precondition' });
    expect(refused.blocked).toContain('force');

    const forced = tool(state).remoteWrite!({ ref: 'main', force: true });
    expect(forced.blocked).toBeUndefined();
    expect(forced.overwrites).toBe(true);
    expect(forced.effect.join('\n')).toContain('DISCARDS');
    // The lease carries the exact oid the remote held when it was observed.
    const observed = state.observationFor('origin', 'refs/heads/main')!.remoteOid!;
    expect(forced.argvPreview).toContain(`--force-with-lease=refs/heads/main:${observed}`);
  });

  it('REFUSES `unknown` even WITH force — the harness cannot say what would be discarded', async () => {
    await setup();
    await commit('base');
    await runRemoteGit(gitDeps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    const other = path.join(tmp, 'other');
    await git(tmp, 'clone', '-q', bare, other);
    fs.writeFileSync(path.join(other, 'b.txt'), 'elsewhere');
    await git(other, 'add', '-A', '--', '.');
    await git(other, ...IDENT, 'commit', '-q', '-m', 'elsewhere');
    await git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    const forced = tool(state).remoteWrite!({ ref: 'main', force: true });
    expect(forced).toMatchObject({ blockedKind: 'precondition' });
    expect(forced.blocked).toContain('never fetched');
  });

  it('REFUSES an up-to-date ref rather than performing a no-op publish', async () => {
    await setup();
    await commit('one');
    await runRemoteGit(gitDeps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    expect(tool(state).remoteWrite!({ ref: 'main' })).toMatchObject({ blockedKind: 'precondition' });
  });

  it('REFUSES a malformed ref name and an unknown remote', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    expect(tool(state).remoteWrite!({ ref: '--force' })).toMatchObject({ blockedKind: 'precondition' });
    expect(tool(state).remoteWrite!({ ref: 'main', remote: 'nope' })).toMatchObject({ blockedKind: 'ambiguous' });
  });

  it('reports a spent write allowance as a blocker rather than letting the tool overspend', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    for (let i = 0; i < 10; i += 1) state.charge('write');
    expect(tool(state).remoteWrite!({ ref: 'main' })).toMatchObject({ blockedKind: 'budget' });
  });

  it('carries the local verification state into the fact WITHOUT making it a precondition', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    const events = [{ v: 1, seq: 1, ts: 't', type: 'check.completed', callId: 'a', check: 'test', recipeId: 'r', status: 'fail', exitCode: 1, durationMs: 1, summary: '' }] as unknown as SessionEvent[];
    const fact = tool(state, events).remoteWrite!({ ref: 'main' });
    // A FAILING check is reported, and the call is still admissible: a green gate must never
    // become an authorization, so a red one must not become a veto either.
    expect(fact.localEvidence).toContain('test fail');
    expect(fact.blocked).toBeUndefined();
  });
});

describe.skipIf(!hasGit)('remote_push — execute against a real remote', () => {
  it('publishes, verifies against the remote, and records attributable evidence', async () => {
    await setup();
    const oid = await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');

    const r = await tool(state).execute({ ref: 'main' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain('VERIFIED');
    expect(await remoteOid('refs/heads/main')).toBe(oid);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      kind: 'mutated',
      operation: 'push.branch',
      exactTarget: 'refs/heads/main',
      beforeOid: null,
      afterOid: oid,
      overwrote: false,
      ok: true,
      verified: true,
    });
    expect(state.spend.writes).toBe(1);
  });

  it('publishes a tag', async () => {
    await setup();
    await commit('one');
    await git(repo, ...IDENT, 'tag', '-a', 'v1.6.0', '-m', 'release');
    const state = makeState();
    await observe(state, 'refs/tags/v1.6.0', 'refs/tags/v1.6.0');
    const r = await tool(state).execute({ ref: 'v1.6.0', ref_kind: 'tag' }, ctx());
    expect(r.ok).toBe(true);
    expect(await remoteOid('refs/tags/v1.6.0')).not.toBeNull();
    expect(evidence[0]).toMatchObject({ operation: 'push.tag', exactTarget: 'refs/tags/v1.6.0', verified: true });
  });

  it('force-pushes over a diverged remote and records that it OVERWROTE', async () => {
    await setup();
    await commit('one');
    const discarded = await commit('remote-only');
    await runRemoteGit(gitDeps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await git(repo, 'reset', '--hard', '-q', 'HEAD~1');
    const kept = await commit('local-only');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');

    const r = await tool(state).execute({ ref: 'main', force: true }, ctx());
    expect(r.ok).toBe(true);
    expect(await remoteOid('refs/heads/main')).toBe(kept);
    expect(await remoteOid('refs/heads/main')).not.toBe(discarded);
    expect(evidence[0]).toMatchObject({ overwrote: true, verified: true });
  });

  it('sends NOTHING when the remote moved after the observation — the approval-window guard', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    // Someone else publishes while a human is reading the prompt.
    const other = path.join(tmp, 'other');
    await git(tmp, 'clone', '-q', bare, other);
    fs.writeFileSync(path.join(other, 'z.txt'), 'z');
    await git(other, 'add', '-A', '--', '.');
    await git(other, ...IDENT, 'commit', '-q', '-m', 'sneaked in');
    await git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const before = await remoteOid('refs/heads/main');

    const r = await tool(state).execute({ ref: 'main' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('nothing was sent');
    expect(r.error).toContain('moved since it was observed');
    expect(await remoteOid('refs/heads/main')).toBe(before);
    expect(evidence).toHaveLength(0);
    expect(state.spend.writes).toBe(0);
  });

  it('sends NOTHING when the LOCAL ref moved after the observation', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    await commit('two');

    const r = await tool(state).execute({ ref: 'main' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('the local ref moved since it was observed');
    expect(await remoteOid('refs/heads/main')).toBeNull();
  });

  it('sends NOTHING when the observation expired between the ask and the act', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    clock += REMOTE_OBSERVATION_MAX_AGE_MS + 1;

    const r = await tool(state).execute({ ref: 'main' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('expired');
    expect(await remoteOid('refs/heads/main')).toBeNull();
  });

  it('refuses at execute when the write allowance ran out while the prompt was open', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    for (let i = 0; i < 10; i += 1) state.charge('write');
    const r = await tool(state).execute({ ref: 'main' }, ctx());
    expect(r.ok).toBe(false);
    expect(await remoteOid('refs/heads/main')).toBeNull();
  });

  it('records a REJECTED push honestly rather than reporting success', async () => {
    await setup();
    await commit('one');
    const state = makeState();
    await observe(state, 'refs/heads/main', 'refs/heads/main');
    // Make the remote reject: a receive hook that always fails is the closest hermetic analogue of
    // a protected branch.
    const hooks = path.join(bare, 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-receive'), '#!/bin/sh\necho "declined by policy" 1>&2\nexit 1\n', { mode: 0o755 });

    const r = await tool(state).execute({ ref: 'main' }, ctx());
    expect(r.ok).toBe(false);
    expect(await remoteOid('refs/heads/main')).toBeNull();
    // Either the dry run or the push itself catches it; both must record a failure, never silence.
    if (evidence.length > 0) expect(evidence[0]).toMatchObject({ kind: 'mutated', ok: false, verified: false });
  });
});
