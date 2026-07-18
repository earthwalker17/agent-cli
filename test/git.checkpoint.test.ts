import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { createCheckpoint, listCheckpoints, pruneCheckpoints, EMPTY_TREE, type CheckpointContext } from '../src/git/checkpoint.js';

/** Stage-9 tests: checkpoint plumbing against real repositories (skipped when git is absent). */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let repo: string;
let stateDir: string;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agitckpt-')));
  repo = path.join(tmp, 'repo');
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(repo);
  fs.mkdirSync(stateDir);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function git(cwd: string, ...argv: string[]) {
  return runGit({ gitPath: REAL_GIT!, argv, cwd });
}

async function initRepo(dir: string): Promise<void> {
  expect((await git(dir, 'init', '-q', '-b', 'main')).ok).toBe(true);
}

async function commitAll(dir: string, message: string): Promise<void> {
  expect((await git(dir, 'add', '-A', '--', '.')).ok).toBe(true);
  expect((await git(dir, '-c', 'user.name=T', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', message)).ok).toBe(true);
}

function cctx(workspaceRoot = repo): CheckpointContext {
  return { gitPath: REAL_GIT!, repoRoot: repo, workspaceRoot, stateDir };
}

/** The user-visible git state that a checkpoint must NEVER change. */
async function userGitState(dir: string): Promise<string> {
  const head = await git(dir, 'rev-parse', '--verify', '-q', 'HEAD');
  const status = await git(dir, 'status', '--porcelain=v2', '-z', '-uall');
  const index = await git(dir, 'ls-files', '-z', '--stage');
  const branches = await git(dir, 'for-each-ref', 'refs/heads');
  return [head.stdout, status.stdout, index.stdout, branches.stdout].join('|');
}

describe.skipIf(!hasGit)('createCheckpoint', () => {
  it('captures dirty + untracked (unignored) state WITHOUT touching index/HEAD/worktree/branches', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'committed\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
    await commitAll(repo, 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'MODIFIED\n');
    fs.writeFileSync(path.join(repo, 'newfile.txt'), 'untracked\n');
    fs.writeFileSync(path.join(repo, 'ignored.log'), 'never captured\n');

    const before = await userGitState(repo);
    const r = await createCheckpoint(cctx(), 's-20260718', { label: 'pre-refactor' });
    expect(r.ok).toBe(true);
    expect(r.ref).toBe('refs/agent-cli/checkpoints/s-20260718/1');
    expect(await userGitState(repo)).toBe(before); // byte-identical user-visible git state

    // The checkpoint commit holds the captured content…
    const shown = await git(repo, 'show', `${r.oid}:a.txt`);
    expect(shown.stdout).toBe('MODIFIED\n');
    const newFile = await git(repo, 'show', `${r.oid}:newfile.txt`);
    expect(newFile.stdout).toBe('untracked\n');
    // …and the gitignored file was NOT swept in (the Codex ghost-commit failure).
    const ignored = await git(repo, 'show', `${r.oid}:ignored.log`);
    expect(ignored.ok).toBe(false);
    // Parent is the user's HEAD, so history/gc reachability is sane.
    const parent = await git(repo, 'rev-parse', `${r.oid}^`);
    expect(parent.stdout.trim()).toBe((await git(repo, 'rev-parse', 'HEAD')).stdout.trim());
    // Normal git log does NOT show the checkpoint.
    const log = await git(repo, 'log', '--oneline');
    expect(log.stdout).not.toContain('agent checkpoint');
  });

  it('works without ANY git identity configured (plumbing identity is explicit env)', async () => {
    const emptyCfg = path.join(tmp, 'empty');
    fs.writeFileSync(emptyCfg, '');
    const saved = { g: process.env['GIT_CONFIG_GLOBAL'], s: process.env['GIT_CONFIG_SYSTEM'] };
    process.env['GIT_CONFIG_GLOBAL'] = emptyCfg;
    process.env['GIT_CONFIG_SYSTEM'] = emptyCfg;
    try {
      await initRepo(repo);
      fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
      const r = await createCheckpoint(cctx(), 's1');
      expect(r.ok).toBe(true);
    } finally {
      if (saved.g === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = saved.g;
      if (saved.s === undefined) delete process.env['GIT_CONFIG_SYSTEM'];
      else process.env['GIT_CONFIG_SYSTEM'] = saved.s;
    }
  });

  it('unborn repository: checkpoints against the empty tree with no parent', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'first.txt'), 'hello\n');
    const r = await createCheckpoint(cctx(), 's1');
    expect(r.ok).toBe(true);
    expect(r.filesChanged).toBe(1);
    const parent = await git(repo, 'rev-parse', '-q', '--verify', `${r.oid}^`);
    expect(parent.ok).toBe(false); // root checkpoint commit
    expect((await git(repo, 'rev-parse', '--verify', '-q', 'HEAD')).ok).toBe(false); // still unborn
    // EMPTY_TREE constant matches git's well-known empty tree.
    const et = await git(repo, 'hash-object', '-t', 'tree', '/dev/null');
    void et; // (not portable on Windows; the constant is asserted via diff-tree below)
    const diff = await git(repo, 'diff-tree', '-r', '--name-only', EMPTY_TREE, r.oid!);
    expect(diff.stdout).toContain('first.txt');
  });

  it('numbers checkpoints sequentially and scopes the capture to a subdirectory workspace', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'root.txt'), 'root\n');
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'v1\n');
    await commitAll(repo, 'base');

    fs.writeFileSync(path.join(repo, 'root.txt'), 'ROOT CHANGED\n'); // outside the workspace subtree
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'v2\n');

    const r1 = await createCheckpoint(cctx(sub), 's1');
    const r2 = await createCheckpoint(cctx(sub), 's1', { label: 'second' });
    expect(r1.n).toBe(1);
    expect(r2.n).toBe(2);
    // The subtree change is captured; the outside change is NOT (tree keeps HEAD's version).
    expect((await git(repo, 'show', `${r1.oid}:packages/app/inner.txt`)).stdout).toBe('v2\n');
    expect((await git(repo, 'show', `${r1.oid}:root.txt`)).stdout).toBe('root\n');
  });

  it('guards a large untracked sweep behind confirmation (declines by default)', async () => {
    await initRepo(repo);
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), 'x');
    const declined = await createCheckpoint(cctx(), 's1', { untrackedWarnThreshold: 10 });
    expect(declined.ok).toBe(false);
    expect(declined.declined).toBe(true);
    let asked = 0;
    const accepted = await createCheckpoint(cctx(), 's1', {
      untrackedWarnThreshold: 10,
      confirmLargeUntracked: async (count) => {
        asked = count;
        return true;
      },
    });
    expect(accepted.ok).toBe(true);
    expect(asked).toBe(12);
  });
});

describe.skipIf(!hasGit)('list + prune', () => {
  it('lists across sessions and prunes only the requested scope', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    await createCheckpoint(cctx(), 'session-a');
    await createCheckpoint(cctx(), 'session-a');
    await createCheckpoint(cctx(), 'session-b');

    expect((await listCheckpoints(cctx())).map((c) => c.ref)).toEqual([
      'refs/agent-cli/checkpoints/session-a/1',
      'refs/agent-cli/checkpoints/session-a/2',
      'refs/agent-cli/checkpoints/session-b/1',
    ]);
    const pruned = await pruneCheckpoints(cctx(), 'session-a');
    expect(pruned.deleted).toHaveLength(2);
    expect((await listCheckpoints(cctx())).map((c) => c.sessionId)).toEqual(['session-b']);
    const all = await pruneCheckpoints(cctx());
    expect(all.deleted).toHaveLength(1);
    expect(await listCheckpoints(cctx())).toEqual([]);
  });
});
