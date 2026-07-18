import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { createCheckpoint, listCheckpoints, pruneCheckpoints, runRestoreFlow, EMPTY_TREE, type CheckpointContext, type RestoreDeps } from '../src/git/checkpoint.js';
import { SnapshotStore } from '../src/store/snapshots.js';
import { applyUndo } from '../src/runtime/undo.js';
import type { EventBody, SessionEvent } from '../src/types.js';

/** Stage-9 tests: checkpoint plumbing against real repositories (skipped when git is absent). */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let repo: string;
let stateDir: string;
let savedEnv: Record<string, string | undefined>;

// Host git config (identity, core.autocrlf, signing…) must not leak into these tests:
// restore materializes the git-native worktree form, so a host-global autocrlf=true would
// legitimately turn LF fixtures into CRLF and make assertions machine-dependent.
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agitckpt-')));
  repo = path.join(tmp, 'repo');
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(repo);
  fs.mkdirSync(stateDir);
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
  fs.rmSync(tmp, { recursive: true, force: true });
});

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

describe.skipIf(!hasGit)('runRestoreFlow', () => {
  /** In-memory event sink + real SnapshotStore so applyUndo can run against the batch. */
  function restoreDeps(answers: (string | null)[] = ['y'], assumeYes = false) {
    const events: SessionEvent[] = [];
    let seq = 0;
    let i = 0;
    const objectsDir = path.join(stateDir, 'objects');
    fs.mkdirSync(objectsDir, { recursive: true });
    const snapshots = new SnapshotStore(objectsDir);
    const lines: string[] = [];
    const deps: RestoreDeps = {
      snapshots,
      appendEvent: (e: EventBody) => void events.push({ v: 1, seq: ++seq, ts: 't', ...e } as SessionEvent),
      callId: 'git-restore-1',
      info: (l) => lines.push(l),
      question: async () => answers[i++] ?? null,
      assumeYes,
    };
    return { deps, events, snapshots, lines };
  }

  async function checkpointOf(sessionId: string): Promise<Parameters<typeof runRestoreFlow>[1]> {
    const list = await listCheckpoints(cctx(), sessionId);
    return list[list.length - 1]!;
  }

  it('returns the workspace to the checkpoint — including DELETING later files — as one undoable batch', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
    await commitAll(repo, 'base');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v2-at-checkpoint\n');
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'exists at checkpoint\n');
    expect((await createCheckpoint(cctx(), 's1')).ok).toBe(true);

    // Post-checkpoint divergence: modify, delete, create.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v3-after\n');
    fs.rmSync(path.join(repo, 'extra.txt'));
    fs.writeFileSync(path.join(repo, 'later.txt'), 'created after checkpoint\n');

    const { deps, events } = restoreDeps(['y']);
    const r = await runRestoreFlow(cctx(), await checkpointOf('s1'), deps);
    expect(r.performed).toBe(true);
    expect(r.refused).toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('v2-at-checkpoint\n');
    expect(fs.readFileSync(path.join(repo, 'extra.txt'), 'utf8')).toBe('exists at checkpoint\n');
    expect(fs.existsSync(path.join(repo, 'later.txt'))).toBe(false); // the half-restore trap, closed

    // Evidence: one snapshot batch + one file.mutated per file + git.restore, sharing the callId.
    expect(events.filter((e) => e.type === 'snapshot.created')).toHaveLength(1);
    const muts = events.filter((e) => e.type === 'file.mutated');
    expect(muts).toHaveLength(3);
    expect(new Set(muts.map((m) => (m.type === 'file.mutated' ? m.callId : '')))).toEqual(new Set(['git-restore-1']));
    expect(events.at(-1)).toMatchObject({ type: 'git.restore', restored: expect.arrayContaining(['a.txt', 'extra.txt', 'later.txt']) });

    // And the WHOLE restore is one applyUndo('last') unit: back to the pre-restore state.
    const undo = applyUndo(events, deps.snapshots, 'last');
    expect(undo.refused).toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('v3-after\n');
    expect(fs.existsSync(path.join(repo, 'extra.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'later.txt'), 'utf8')).toBe('created after checkpoint\n');
  });

  it('round-trips CRLF content through the clean/smudge filters (raw-blob restore would corrupt it)', async () => {
    await initRepo(repo);
    expect((await git(repo, 'config', 'core.autocrlf', 'true')).ok).toBe(true);
    const crlf = 'line one\r\nline two\r\n';
    fs.writeFileSync(path.join(repo, 'win.txt'), crlf);
    expect((await createCheckpoint(cctx(), 's1')).ok).toBe(true);
    fs.rmSync(path.join(repo, 'win.txt'));

    const { deps } = restoreDeps(['y']);
    const r = await runRestoreFlow(cctx(), await checkpointOf('s1'), deps);
    expect(r.performed).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'win.txt'), 'utf8')).toBe(crlf);
  });

  it('restores binary content byte-identically (no pipe capture in the content path)', async () => {
    await initRepo(repo);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe, 0x00, 0x7f]);
    fs.writeFileSync(path.join(repo, 'img.bin'), bytes);
    expect((await createCheckpoint(cctx(), 's1')).ok).toBe(true);
    fs.writeFileSync(path.join(repo, 'img.bin'), 'corrupted');

    const { deps } = restoreDeps(['y']);
    const r = await runRestoreFlow(cctx(), await checkpointOf('s1'), deps);
    expect(r.performed).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'img.bin'))).toEqual(bytes);
  });

  it('never touches files outside the workspace subtree even after HEAD moved', async () => {
    await initRepo(repo);
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(repo, 'root.txt'), 'root-v1\n');
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner-v1\n');
    await commitAll(repo, 'base');

    fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner-v2-checkpointed\n');
    expect((await createCheckpoint(cctx(sub), 's1')).ok).toBe(true);

    // HEAD moves via a user commit touching an OUTSIDE file; then the inner file diverges.
    fs.writeFileSync(path.join(repo, 'root.txt'), 'root-v2-user-committed\n');
    await commitAll(repo, 'user moves HEAD');
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner-v3\n');

    const { deps } = restoreDeps(['y']);
    const r = await runRestoreFlow(cctx(sub), await checkpointOf('s1'), deps);
    expect(r.performed).toBe(true);
    expect(r.restored).toEqual(['packages/app/inner.txt']);
    expect(fs.readFileSync(path.join(sub, 'inner.txt'), 'utf8')).toBe('inner-v2-checkpointed\n');
    expect(fs.readFileSync(path.join(repo, 'root.txt'), 'utf8')).toBe('root-v2-user-committed\n'); // untouched
  });

  it('refuses non-interactively without --yes, and a declined confirm changes nothing', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'at-checkpoint\n');
    expect((await createCheckpoint(cctx(), 's1')).ok).toBe(true);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'after\n');

    const nonInteractive = restoreDeps([], false);
    nonInteractive.deps.question = null;
    const r1 = await runRestoreFlow(cctx(), await checkpointOf('s1'), nonInteractive.deps);
    expect(r1.performed).toBe(false);
    expect(nonInteractive.lines.some((l) => l.includes('requires --yes'))).toBe(true);

    const declined = restoreDeps(['n']);
    const r2 = await runRestoreFlow(cctx(), await checkpointOf('s1'), declined.deps);
    expect(r2.performed).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('after\n');
    expect(declined.events).toEqual([]); // nothing recorded, nothing snapshotted
  });

  it('reports "already matches" when there is nothing to restore', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'same\n');
    expect((await createCheckpoint(cctx(), 's1')).ok).toBe(true);
    const { deps, lines, events } = restoreDeps(['y']);
    const r = await runRestoreFlow(cctx(), await checkpointOf('s1'), deps);
    expect(r.performed).toBe(false);
    expect(lines.some((l) => l.includes('already matches'))).toBe(true);
    expect(events).toEqual([]);
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
