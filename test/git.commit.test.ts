import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { prepareCommit, performCommit, runCommitFlow, AGENT_TRAILER, type CommitContext } from '../src/git/commit.js';
import { sha256 } from '../src/shared/hash.js';
import type { SessionEvent } from '../src/types.js';

/**
 * Stage-8 tests: the deliberate-commit flow against real repositories. The global/system git
 * config is pointed at empty files for every test (identity, hooks, and signing settings on
 * the host machine must not leak in); identity is granted repo-locally where a test needs it.
 */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

let tmp: string;
let repo: string;
let msgDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agitcommit-')));
  repo = path.join(tmp, 'repo');
  msgDir = path.join(tmp, 'state');
  fs.mkdirSync(repo);
  fs.mkdirSync(msgDir);
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
  const r = await runGit({ gitPath: REAL_GIT!, argv, cwd });
  return r;
}

async function initRepo(dir: string, withIdentity = true): Promise<void> {
  expect((await git(dir, 'init', '-q', '-b', 'main')).ok).toBe(true);
  if (withIdentity) {
    expect((await git(dir, 'config', 'user.name', 'Test User')).ok).toBe(true);
    expect((await git(dir, 'config', 'user.email', 'test@example.com')).ok).toBe(true);
  }
}

function cctx(workspaceRoot = repo): CommitContext {
  return { gitPath: REAL_GIT!, repoRoot: repo, workspaceRoot, messageDir: msgDir };
}

let seq = 0;
function evt(body: Record<string, unknown>): SessionEvent {
  return { v: 1, seq: ++seq, ts: 't', ...body } as unknown as SessionEvent;
}

/** Write a file and produce the matching file.mutated evidence (what a session records). */
function mutate(abs: string, content: string, before: string | null): SessionEvent {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return evt({
    type: 'file.mutated',
    callId: `c${seq}`,
    path: abs,
    kind: before === null ? 'create' : 'modify',
    beforeSha256: before,
    afterSha256: sha256(Buffer.from(content)),
    createdDirs: [],
  });
}

const TASK = () => evt({ type: 'user.message', text: 'fix the login bug\nmore detail' });

describe.skipIf(!hasGit)('prepareCommit', () => {
  it('blocks without identity and never sets one', async () => {
    await initRepo(repo, false);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    const p = await prepareCommit(cctx(), [TASK(), mutate(path.join(repo, 'a.txt'), 'x', null)], 'session');
    expect(p.blockers.some((b) => b.includes('identity is not configured'))).toBe(true);
    expect((await git(repo, 'config', '--get', 'user.name')).ok).toBe(false); // still unset
  });

  it('session scope: attributed-only staging, unattributed warning, proposed subject from the task', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '-A', '--', '.');
    await git(repo, 'commit', '-q', '-m', 'base');

    const events = [TASK(), mutate(path.join(repo, 'agent.txt'), 'agent-made\n', null)];
    fs.writeFileSync(path.join(repo, 'user.txt'), 'user-made\n'); // NOT attributed

    const p = await prepareCommit(cctx(), events, 'session');
    expect(p.blockers).toEqual([]);
    expect(p.stagePaths).toEqual(['agent.txt']);
    expect(p.entries.find((e) => e.path === 'user.txt')).toMatchObject({ attributed: false });
    expect(p.warnings.some((w) => w.includes('NOT included'))).toBe(true);
    expect(p.proposedSubject).toBe('fix the login bug');
  });

  it('session scope blocks on a pre-staged index; --all only warns', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'pre');
    await git(repo, 'add', '-A', '--', '.');
    const events = [TASK(), mutate(path.join(repo, 'agent.txt'), 'x', null)];
    const session = await prepareCommit(cctx(), events, 'session');
    expect(session.blockers.some((b) => b.includes('already has staged changes'))).toBe(true);
    const all = await prepareCommit(cctx(), events, 'all');
    expect(all.blockers).toEqual([]);
    expect(all.warnings.some((w) => w.includes('already had staged changes'))).toBe(true);
  });

  it('flags a session file the user then edited externally', async () => {
    await initRepo(repo);
    const abs = path.join(repo, 'a.txt');
    const events = [TASK(), mutate(abs, 'session wrote this\n', null)];
    fs.writeFileSync(abs, 'externally changed\n');
    const p = await prepareCommit(cctx(), events, 'session');
    expect(p.entries[0]).toMatchObject({ attributed: true, drifted: true });
    expect(p.warnings.some((w) => w.includes('externally modified'))).toBe(true);
  });

  it('blocks session scope when nothing is attributable', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'user.txt'), 'x');
    const p = await prepareCommit(cctx(), [TASK()], 'session');
    expect(p.blockers.some((b) => b.includes('no attributable session file changes'))).toBe(true);
  });
});

describe.skipIf(!hasGit)('performCommit', () => {
  it('commits ONLY attributed files; message carries Session line + trailer; user files stay dirty', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '-A', '--', '.');
    await git(repo, 'commit', '-q', '-m', 'base');
    const events = [TASK(), mutate(path.join(repo, 'agent.txt'), 'agent\n', null)];
    fs.writeFileSync(path.join(repo, 'user.txt'), 'mine\n');

    const p = await prepareCommit(cctx(), events, 'session');
    const r = await performCommit(cctx(), p, 'fix the login bug', { trailer: true, sessionId: 's-123' });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(['agent.txt']);
    const body = await git(repo, 'log', '-1', '--format=%B');
    expect(body.stdout).toContain('fix the login bug');
    expect(body.stdout).toContain('Session: s-123');
    expect(body.stdout).toContain(AGENT_TRAILER);
    const status = await git(repo, 'status', '--porcelain');
    expect(status.stdout).toContain('user.txt'); // untouched, still dirty
    expect(status.stdout).not.toContain('agent.txt');
  });

  it('supports the very first commit of an unborn repository', async () => {
    await initRepo(repo);
    const events = [TASK(), mutate(path.join(repo, 'first.txt'), 'hello\n', null)];
    const p = await prepareCommit(cctx(), events, 'session');
    expect(p.blockers).toEqual([]);
    const r = await performCommit(cctx(), p, 'first', { trailer: false, sessionId: 's' });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(['first.txt']);
    const body = await git(repo, 'log', '-1', '--format=%B');
    expect(body.stdout).not.toContain('Co-authored-by');
  });

  it('reports a hook failure honestly and leaves the staged state in place', async () => {
    await initRepo(repo);
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n');
    // POSIX git IGNORES a non-executable hook; git-for-windows runs sh hooks regardless, and
    // chmod there is a harmless near-no-op — so one portable fixture serves both platforms.
    fs.chmodSync(hook, 0o755);
    const events = [TASK(), mutate(path.join(repo, 'a.txt'), 'x\n', null)];
    const p = await prepareCommit(cctx(), events, 'session');
    const r = await performCommit(cctx(), p, 'subject', { trailer: true, sessionId: 's' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('REMAIN staged');
    const staged = await git(repo, 'diff', '--cached', '--name-only');
    expect(staged.stdout).toContain('a.txt');
  });

  it('nested workspace: stages repo-relative paths and scopes --all to the subtree', async () => {
    await initRepo(repo);
    fs.writeFileSync(path.join(repo, 'root.txt'), 'root');
    await git(repo, 'add', '-A', '--', '.');
    await git(repo, 'commit', '-q', '-m', 'base');
    const wsSub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(wsSub, { recursive: true });
    const events = [TASK(), mutate(path.join(wsSub, 'inner.txt'), 'in\n', null)];
    fs.writeFileSync(path.join(repo, 'outside.txt'), 'outside the workspace subtree\n');

    const p = await prepareCommit(cctx(wsSub), events, 'session');
    expect(p.stagePaths).toEqual(['packages/app/inner.txt']);
    // outside.txt is not even visible in the workspace-scoped status:
    expect(p.entries.find((e) => e.path === 'outside.txt')).toBeUndefined();
    const r = await performCommit(cctx(wsSub), p, 'inner change', { trailer: true, sessionId: 's' });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(['packages/app/inner.txt']);
    const status = await git(repo, 'status', '--porcelain');
    expect(status.stdout).toContain('outside.txt'); // never swept in
  });
});

describe.skipIf(!hasGit)('runCommitFlow', () => {
  function scriptedIO(answers: (string | null)[], assumeYes = false) {
    const lines: string[] = [];
    let i = 0;
    return {
      lines,
      io: {
        info: (l: string) => lines.push(l),
        question: async () => answers[i++] ?? null,
        assumeYes,
      },
    };
  }

  it('non-interactive without --yes refuses before touching the index', async () => {
    await initRepo(repo);
    const events = [TASK(), mutate(path.join(repo, 'a.txt'), 'x\n', null)];
    const { lines } = { lines: [] as string[] };
    const out = await runCommitFlow(cctx(), events, {
      scope: 'session',
      trailer: true,
      sessionId: 's',
      io: { info: (l) => lines.push(l), question: null, assumeYes: false },
    });
    expect(out.committed).toBe(false);
    expect(lines.some((l) => l.includes('requires --yes'))).toBe(true);
    expect((await git(repo, 'diff', '--cached', '--quiet')).exitCode).toBe(0); // nothing staged
  });

  it('interactive: accepts an edited message, then commits on y', async () => {
    await initRepo(repo);
    const events = [TASK(), mutate(path.join(repo, 'a.txt'), 'x\n', null)];
    const { io } = scriptedIO(['better subject', 'y']);
    const out = await runCommitFlow(cctx(), events, { scope: 'session', trailer: true, sessionId: 's', io: io as never });
    expect(out.committed).toBe(true);
    expect(out.subject).toBe('better subject');
    const body = await git(repo, 'log', '-1', '--format=%s');
    expect(body.stdout.trim()).toBe('better subject');
  });

  it('interactive: declining leaves the repository untouched', async () => {
    await initRepo(repo);
    const events = [TASK(), mutate(path.join(repo, 'a.txt'), 'x\n', null)];
    const { io } = scriptedIO(['', 'n']);
    const out = await runCommitFlow(cctx(), events, { scope: 'session', trailer: true, sessionId: 's', io: io as never });
    expect(out.committed).toBe(false);
    expect((await git(repo, 'rev-parse', '--verify', '-q', 'HEAD')).ok).toBe(false); // still unborn
  });
});
