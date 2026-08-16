import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitOnPath, runGit } from '../src/git/client.js';
import {
  describeRelation,
  expectedPushFlags,
  lsRemoteOid,
  observeRemoteRef,
  parseLsRemote,
  parseLsRemoteRows,
  parsePushPorcelain,
  runRemoteGit,
  touchesWorkflowFiles,
  type RemoteGitDeps,
} from '../src/remote/observe.js';
import { RemoteError } from '../src/remote/errors.js';
import { FIXTURE_GIT_TIMEOUT_MS, rmTemp } from './common.fixtures.js';

/**
 * Observing a real remote (Session 20).
 *
 * The decisive trick that makes this hermetic: **a local `git init --bare` repository is a real
 * remote**. Every relation, the porcelain parser, and the ls-remote path are exercised against
 * genuine git behaviour — no network, no credential, no mock of the thing under test.
 *
 * The `unknown` relation gets its own case because it is the one an implementation is most tempted
 * to guess at: this pack never fetches, so a commit the remote holds and we have never seen is
 * genuinely outside our object database, and ancestry against it is unknowable rather than false.
 */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let repo: string;
let bare: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'aremobs-')));
  repo = path.join(tmp, 'repo');
  bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(repo);
  // Host git config must not leak in: a global core.autocrlf or a signing key would make these
  // assertions machine-dependent (the git.checkpoint.test.ts discipline).
  const emptyCfg = path.join(tmp, 'empty-gitconfig');
  fs.writeFileSync(emptyCfg, '');
  savedEnv = { GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'], GIT_CONFIG_SYSTEM: process.env['GIT_CONFIG_SYSTEM'] };
  process.env['GIT_CONFIG_GLOBAL'] = emptyCfg;
  process.env['GIT_CONFIG_SYSTEM'] = emptyCfg;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTemp(tmp);
});

async function git(cwd: string, ...argv: string[]) {
  return runGit({ gitPath: REAL_GIT!, argv, cwd, timeoutMs: FIXTURE_GIT_TIMEOUT_MS });
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
  expect((await git(repo, 'add', '-A', '--', '.')).ok).toBe(true);
  expect((await git(repo, ...IDENT, 'commit', '-q', '-m', message)).ok).toBe(true);
  const r = await git(repo, 'rev-parse', 'HEAD');
  return r.stdout.trim();
}

function deps(): RemoteGitDeps {
  return { gitPath: REAL_GIT!, repoRoot: repo, workspaceRoot: repo };
}

const REQ = { remoteName: 'origin', host: 'localhost', slug: null, refName: 'refs/heads/main', localRev: 'refs/heads/main' };

describe.skipIf(!hasGit)('observeRemoteRef against a real bare repository', () => {
  it('reports `new` for a ref the remote does not have, with the branch commit count', async () => {
    await setup();
    await commit('one');
    await commit('two');
    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o).toMatchObject({ relation: 'new', remoteOid: null, behind: 0, ahead: 2, remoteName: 'origin', refName: 'refs/heads/main' });
    expect(o.commits.map((c) => c.subject)).toEqual(['two', 'one']);
    expect(o.id).toHaveLength(12);
    expect(describeRelation(o)).toContain('CREATE');
  });

  it('reports `up-to-date` once the remote holds the same commit', async () => {
    await setup();
    const oid = await commit('one');
    expect((await runRemoteGit(deps(), ['push', 'origin', 'refs/heads/main:refs/heads/main'])).ok).toBe(true);
    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o).toMatchObject({ relation: 'up-to-date', remoteOid: oid, localOid: oid, ahead: 0, behind: 0 });
  });

  it('reports `fast-forward` with the exact commits and paths that would be published', async () => {
    await setup();
    await commit('base');
    await runRemoteGit(deps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await commit('add feature', { 'src/feature.ts': 'export const f = 1;\n' });
    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o.relation).toBe('fast-forward');
    expect(o.ahead).toBe(1);
    expect(o.behind).toBe(0);
    expect(o.commits.map((c) => c.subject)).toEqual(['add feature']);
    expect(o.changedPaths).toContain('src/feature.ts');
    expect(describeRelation(o)).toContain('FAST-FORWARD');
  });

  it('reports `behind` when the local ref is an ancestor of the remote', async () => {
    await setup();
    await commit('one');
    await commit('two');
    await runRemoteGit(deps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    // Reset back: the remote is now ahead, and we still HAVE its commit, so ancestry is knowable.
    expect((await git(repo, 'reset', '--hard', '-q', 'HEAD~1')).ok).toBe(true);
    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o.relation).toBe('behind');
    expect(o.behind).toBe(1);
    expect(o.ahead).toBe(0);
    expect(describeRelation(o)).toContain('AHEAD of the local ref');
  });

  it('reports `diverged` with both counts', async () => {
    await setup();
    await commit('one');
    await commit('remote-only');
    await runRemoteGit(deps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await git(repo, 'reset', '--hard', '-q', 'HEAD~1');
    await commit('local-only');
    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o.relation).toBe('diverged');
    expect(o.ahead).toBe(1);
    expect(o.behind).toBe(1);
    expect(describeRelation(o)).toContain('DIVERGED');
  });

  it('reports `unknown` — never a guess — when the remote holds a commit this repository never fetched', async () => {
    await setup();
    await commit('base');
    await runRemoteGit(deps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    // A SECOND clone pushes a commit our object database has never seen. Because this pack uses
    // ls-remote and never fetches, ancestry against it is genuinely unknowable.
    const other = path.join(tmp, 'other');
    expect((await git(tmp, 'clone', '-q', bare, other)).ok).toBe(true);
    fs.writeFileSync(path.join(other, 'b.txt'), 'from elsewhere');
    expect((await git(other, 'add', '-A', '--', '.')).ok).toBe(true);
    expect((await git(other, ...IDENT, 'commit', '-q', '-m', 'elsewhere')).ok).toBe(true);
    expect((await git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main')).ok).toBe(true);

    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o.relation).toBe('unknown');
    expect(o.remoteOid).not.toBeNull();
    expect(describeRelation(o)).toContain('never fetched');
  });

  it('detects a workflow-file change, which GitHub rejects without the `workflow` scope', async () => {
    await setup();
    await commit('base');
    await runRemoteGit(deps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    await commit('ci', { '.github/workflows/ci.yml': 'name: CI\n' });
    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o.touchesWorkflows).toBe(true);
  });

  it('counts uncommitted entries so the prompt can say they are NOT included', async () => {
    await setup();
    await commit('base');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted');
    const o = await observeRemoteRef(deps(), REQ, 1_000);
    expect(o.dirtyCount).toBe(1);
  });

  it('refuses when the local ref does not resolve, naming the cure', async () => {
    await setup();
    await commit('base');
    await expect(observeRemoteRef(deps(), { ...REQ, localRev: 'refs/heads/nope' }, 1_000)).rejects.toThrow(RemoteError);
    await observeRemoteRef(deps(), { ...REQ, localRev: 'refs/heads/nope' }, 1_000).catch((e: RemoteError) => {
      expect(e.reason).toBe('precondition');
      expect(e.detail?.cure).toContain('/commit');
    });
  });

  it('raises a typed failure — never a silent null — when the remote cannot be reached', async () => {
    await setup();
    await commit('base');
    await expect(lsRemoteOid(deps(), 'nonexistent-remote', 'refs/heads/main')).rejects.toThrow(RemoteError);
  });

  it('handles an annotated tag: ls-remote reports the tag object, not the peeled commit', async () => {
    await setup();
    const commitOid = await commit('base');
    expect((await git(repo, ...IDENT, 'tag', '-a', 'v1', '-m', 'release one')).ok).toBe(true);
    expect((await runRemoteGit(deps(), ['push', 'origin', 'refs/tags/v1:refs/tags/v1'])).ok).toBe(true);
    const tagOid = await lsRemoteOid(deps(), 'origin', 'refs/tags/v1');
    // The `^{}` peeled line must NOT win: what a push updates, and what a lease compares, is the
    // ref's own value.
    expect(tagOid).not.toBe(commitOid);
    const o = await observeRemoteRef(deps(), { ...REQ, refName: 'refs/tags/v1', localRev: 'refs/tags/v1' }, 1_000);
    expect(o.relation).toBe('up-to-date');
    expect(o.remoteOid).toBe(tagOid);
  });

  it('returns null for an absent ref rather than failing', async () => {
    await setup();
    await commit('base');
    expect(await lsRemoteOid(deps(), 'origin', 'refs/heads/never')).toBeNull();
  });

  it('a refs/pull/ namespace on the remote neither hides the target nor degrades the bases (S20.5)', async () => {
    // GitHub exposes two refs per PR under refs/pull/, which sorts BEFORE refs/tags/ — an
    // unscoped listing let them starve the row bound and a real tag read as absent. The listing
    // is now scoped to heads+tags(+target), so PR refs are structurally outside it.
    await setup();
    const first = await commit('base');
    await runRemoteGit(deps(), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    for (let i = 1; i <= 25; i++) {
      expect((await git(bare, 'update-ref', `refs/pull/${String(i)}/head`, first)).ok).toBe(true);
    }
    expect((await git(repo, ...IDENT, 'tag', '-a', 'v9', '-m', 'after the pull refs')).ok).toBe(true);
    expect((await runRemoteGit(deps(), ['push', 'origin', 'refs/tags/v9:refs/tags/v9'])).ok).toBe(true);
    // The tag (which sorts after refs/pull) is still found…
    const o = await observeRemoteRef(deps(), { ...REQ, refName: 'refs/tags/v9', localRev: 'refs/tags/v9' }, 1_000);
    expect(o.relation).toBe('up-to-date');
    // …and a NEW branch's exclusion bases stay complete: the pull refs never enter the candidate
    // set at all, so 25 extra refs over an object we hold cannot mark the bases incomplete.
    await commit('feature work');
    const n = await observeRemoteRef(deps(), { ...REQ, refName: 'refs/heads/feat', localRev: 'refs/heads/main' }, 1_000);
    expect(n.relation).toBe('new');
    expect(n.basesIncomplete).toBe(false);
    expect(n.ahead).toBe(1); // only the commit main does not already hold
  });
});

describe('parseLsRemote', () => {
  it('prefers the ref line over its peeled counterpart', () => {
    const out = ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1^{}'].join('\n');
    expect(parseLsRemote(out, 'refs/tags/v1')).toBe('a'.repeat(40));
  });

  it('returns null when the ref is not present', () => {
    expect(parseLsRemote('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/other', 'refs/heads/main')).toBeNull();
  });

  it('REPORTS hitting the row bound instead of silently stopping (S20.5)', () => {
    const row = (i: number): string => `${'c'.repeat(40)}\trefs/heads/b-${String(i)}`;
    const under = Array.from({ length: 20_000 }, (_, i) => row(i)).join('\n');
    expect(parseLsRemoteRows(under)).toMatchObject({ truncated: false });
    const over = `${under}\n${row(20_000)}`;
    const parsed = parseLsRemoteRows(over);
    expect(parsed.rows).toHaveLength(20_000);
    expect(parsed.truncated).toBe(true);
  });
});

describe('parsePushPorcelain', () => {
  it('decodes every documented flag character', () => {
    const out = [
      'To https://github.com/o/r.git',
      '*\trefs/heads/new:refs/heads/new\t[new branch]',
      ' \trefs/heads/ff:refs/heads/ff\tabc..def',
      '+\trefs/heads/forced:refs/heads/forced\tabc...def (forced update)',
      '=\trefs/heads/same:refs/heads/same\t[up to date]',
      '-\t:refs/heads/gone\t[deleted]',
      '!\trefs/heads/no:refs/heads/no\t[rejected] (non-fast-forward)',
      'Done',
    ].join('\n');
    const p = parsePushPorcelain(out);
    expect(p.done).toBe(true);
    expect(p.lines.map((l) => l.flag)).toEqual(['new', 'fast-forward', 'forced', 'up-to-date', 'deleted', 'rejected']);
    expect(p.lines[2]).toMatchObject({ to: 'refs/heads/forced', reason: 'forced update' });
    expect(p.lines[5]?.reason).toBe('non-fast-forward');
  });

  it('reports a missing terminating Done rather than assuming success', () => {
    expect(parsePushPorcelain('To x\n*\ta:b\t[new branch]').done).toBe(false);
  });
});

describe('expectedPushFlags', () => {
  it('permits exactly one outcome per non-forced relation', () => {
    expect(expectedPushFlags('new', false)).toEqual(['new']);
    expect(expectedPushFlags('fast-forward', false)).toEqual(['fast-forward']);
    expect(expectedPushFlags('up-to-date', false)).toEqual(['up-to-date']);
  });

  it('permits NOTHING for relations a normal push cannot satisfy', () => {
    for (const r of ['behind', 'diverged', 'unknown'] as const) expect(expectedPushFlags(r, false)).toEqual([]);
  });
});

describe('touchesWorkflowFiles', () => {
  it('matches only .github/workflows/*.yml|yaml, at any depth, on either separator', () => {
    expect(touchesWorkflowFiles(['.github/workflows/ci.yml'])).toBe(true);
    expect(touchesWorkflowFiles(['sub/.github/workflows/release.yaml'])).toBe(true);
    expect(touchesWorkflowFiles(['.github\\workflows\\ci.yml'])).toBe(true);
    expect(touchesWorkflowFiles(['.github/dependabot.yml', 'src/workflows/ci.yml', 'docs/.github-workflows.md'])).toBe(false);
  });
});
