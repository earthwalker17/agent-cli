import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGitEnv, findGitOnPath, gitHardeningArgs, runGit } from '../src/git/client.js';
import { detectGitFacts } from '../src/git/facts.js';
import { parsePorcelainV2 } from '../src/git/porcelain.js';

/**
 * Stage-1 substrate tests. The parser and PATH-resolution tests are pure; the integration
 * tests run against REAL temporary repositories with the real git binary and are skipped
 * when git is absent (mirrors the sandbox suite's real-OS gating — no simulated parity).
 */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

const IDENT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}

async function git(cwd: string, ...argv: string[]) {
  const r = await runGit({ gitPath: REAL_GIT!, argv, cwd });
  return r;
}

async function initRepo(dir: string): Promise<void> {
  const r = await git(dir, 'init', '-q', '-b', 'main');
  expect(r.ok).toBe(true);
}

async function commitAll(dir: string, message: string): Promise<void> {
  expect((await git(dir, 'add', '-A', '--', '.')).ok).toBe(true);
  expect((await git(dir, ...IDENT, 'commit', '-q', '-m', message)).ok).toBe(true);
}

describe('findGitOnPath', () => {
  it('finds git.exe in an absolute PATH directory (win32 semantics)', () => {
    const dir = tmpdir('agitpath-');
    fs.writeFileSync(path.join(dir, 'git.exe'), 'x');
    const found = findGitOnPath({ PATH: dir }, 'win32');
    expect(found).toBe(path.join(dir, 'git.exe'));
  });

  it('skips relative PATH entries — they would resolve against cwd', () => {
    // The fixture dir must live under cwd so `path.relative` yields a genuinely RELATIVE entry.
    // Using the OS temp dir breaks on Windows CI, where cwd is on D: and TEMP on C:: with no
    // common root, path.relative returns an ABSOLUTE path and the test asserts nothing.
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-relpath-'));
    try {
      fs.writeFileSync(path.join(dir, 'git.exe'), 'x');
      const rel = path.relative(process.cwd(), dir);
      expect(path.isAbsolute(rel)).toBe(false); // the premise the assertion depends on
      expect(findGitOnPath({ PATH: rel }, 'win32')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips surrounding quotes from PATH entries', () => {
    const dir = tmpdir('agitpath-');
    fs.writeFileSync(path.join(dir, 'git.exe'), 'x');
    expect(findGitOnPath({ PATH: `"${dir}"` }, 'win32')).toBe(path.join(dir, 'git.exe'));
  });

  it('does not accept git.cmd/git.bat shims on win32', () => {
    const dir = tmpdir('agitpath-');
    fs.writeFileSync(path.join(dir, 'git.cmd'), 'x');
    fs.writeFileSync(path.join(dir, 'git.bat'), 'x');
    expect(findGitOnPath({ PATH: dir }, 'win32')).toBeNull();
  });

  it('returns null when PATH has no git', () => {
    expect(findGitOnPath({ PATH: tmpdir('agitpath-') }, 'win32')).toBeNull();
  });
});

describe('buildGitEnv', () => {
  it('scrubs repo-targeting GIT_* vars, sets the hardening vars, keeps extra overrides', () => {
    const prev = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = 'C:\\somewhere\\else\\.git';
    try {
      const env = buildGitEnv({ GIT_INDEX_FILE: 'X' });
      expect(Object.keys(env).find((k) => k.toLowerCase() === 'git_dir')).toBeUndefined();
      expect(env['GIT_OPTIONAL_LOCKS']).toBe('0');
      expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
      expect(env['GIT_INDEX_FILE']).toBe('X'); // explicit override survives the scrub
      expect(env['AGENT_CLI']).toBe('1');
    } finally {
      if (prev === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = prev;
    }
  });

  it('always disables fsmonitor via config args', () => {
    expect(gitHardeningArgs('win32')).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true']);
    expect(gitHardeningArgs('linux')).toEqual(['-c', 'core.fsmonitor=false']);
  });
});

describe('parsePorcelainV2', () => {
  const NUL = '\0';

  it('parses branch headers with upstream and ahead/behind', () => {
    const raw = ['# branch.oid ' + 'a'.repeat(40), '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'].join(NUL) + NUL;
    const s = parsePorcelainV2(raw);
    expect(s.branchOid).toBe('a'.repeat(40));
    expect(s.branchHead).toBe('main');
    expect(s.detached).toBe(false);
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
  });

  it('maps (initial) and (detached) to explicit null/flag', () => {
    const s = parsePorcelainV2(['# branch.oid (initial)', '# branch.head (detached)'].join(NUL) + NUL);
    expect(s.branchOid).toBeNull();
    expect(s.branchHead).toBeNull();
    expect(s.detached).toBe(true);
  });

  it('parses ordinary, rename (two NUL-separated paths), unmerged, untracked, ignored entries', () => {
    const h = '0'.repeat(40);
    const raw =
      [
        `1 .M N... 100644 100644 100644 ${h} ${h} file with space.txt`,
        `2 R. N... 100644 100644 100644 ${h} ${h} R100 new näme.txt`,
        'old näme.txt',
        `u UU N... 100644 100644 100644 100644 ${h} ${h} ${h} conflicted.txt`,
        '? unt racked.txt',
        '! ignored.txt',
      ].join(NUL) + NUL;
    const s = parsePorcelainV2(raw);
    expect(s.entries).toEqual([
      { kind: 'changed', path: 'file with space.txt', x: '.', y: 'M' },
      { kind: 'renamed', path: 'new näme.txt', x: 'R', y: '.', origPath: 'old näme.txt' },
      { kind: 'unmerged', path: 'conflicted.txt', x: 'U', y: 'U' },
      { kind: 'untracked', path: 'unt racked.txt', x: '?', y: '?' },
      { kind: 'ignored', path: 'ignored.txt', x: '!', y: '!' },
    ]);
  });

  it('returns an empty summary for empty input', () => {
    const s = parsePorcelainV2('');
    expect(s.entries).toEqual([]);
    expect(s.branchOid).toBeNull();
  });
});

describe.skipIf(!hasGit)('git substrate against real repositories', () => {
  it('runGit reports real exit codes and never fakes ok on failure', async () => {
    const dir = tmpdir('agit-');
    await initRepo(dir);
    const bad = await git(dir, 'rev-parse', '--verify', '-q', 'HEAD'); // unborn → nonzero
    expect(bad.ok).toBe(false);
    expect(bad.termination).toBe('exited');
    expect(bad.exitCode).not.toBe(0);
  });

  it('scrubbed env: an inherited GIT_DIR cannot re-target the invocation', async () => {
    const repoA = tmpdir('agit-a-');
    const repoB = tmpdir('agit-b-');
    await initRepo(repoA);
    await initRepo(repoB);
    const prev = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = path.join(repoB, '.git');
    try {
      const r = await git(repoA, 'rev-parse', '--absolute-git-dir');
      expect(r.ok).toBe(true);
      expect(path.normalize(r.stdout.trim()).toLowerCase()).toBe(path.join(repoA, '.git').toLowerCase());
    } finally {
      if (prev === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = prev;
    }
  });

  it('detectGitFacts: honest degrade when git is "absent"', async () => {
    const facts = await detectGitFacts(tmpdir('agit-'), { gitPath: null });
    expect(facts.isRepo).toBe(false);
    expect(facts.gitVersion).toBeNull();
    expect(facts.detail).toBe('git not found on PATH');
  });

  it('detectGitFacts: not a repository', async () => {
    const facts = await detectGitFacts(tmpdir('agit-'), { gitPath: REAL_GIT });
    expect(facts.isRepo).toBe(false);
    expect(facts.gitVersion).not.toBeNull();
    expect(facts.detail).toBe('not a git repository');
    expect(facts.probeFailed).toBe(false);
  });

  it('detectGitFacts: unborn branch after init', async () => {
    const dir = tmpdir('agit-');
    await initRepo(dir);
    const facts = await detectGitFacts(dir, { gitPath: REAL_GIT });
    expect(facts.isRepo).toBe(true);
    expect(facts.unborn).toBe(true);
    expect(facts.head).toBeNull();
    expect(facts.branch).toBe('main');
    expect(facts.dirtyCount).toBe(0);
    expect(facts.detail).toContain('no commits yet');
  });

  it('detectGitFacts: clean repo with a commit, then dirty counts', async () => {
    const dir = tmpdir('agit-');
    await initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await commitAll(dir, 'init');

    let facts = await detectGitFacts(dir, { gitPath: REAL_GIT });
    expect(facts.isRepo).toBe(true);
    expect(facts.branch).toBe('main');
    expect(facts.unborn).toBe(false);
    expect(facts.head).toHaveLength(12);
    expect(facts.dirtyCount).toBe(0);
    expect(facts.workspaceIsRepoRoot).toBe(true);
    expect(facts.detail).toContain('clean');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'spa ce.txt'), 'new\n');
    facts = await detectGitFacts(dir, { gitPath: REAL_GIT });
    expect(facts.dirtyCount).toBe(2);
    expect(facts.untrackedCount).toBe(1);
  });

  it('detectGitFacts: workspace as a subdirectory of the repository', async () => {
    const dir = tmpdir('agit-');
    await initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await commitAll(dir, 'init');
    const sub = path.join(dir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const facts = await detectGitFacts(sub, { gitPath: REAL_GIT });
    expect(facts.isRepo).toBe(true);
    expect(facts.workspaceIsRepoRoot).toBe(false);
    expect(facts.detail).toContain('subdirectory');
  });

  it('status parsing round-trips unicode and spaces through -z', async () => {
    const dir = tmpdir('agit-');
    await initRepo(dir);
    fs.writeFileSync(path.join(dir, 'näme with space.txt'), 'x\n');
    const r = await git(dir, 'status', '--porcelain=v2', '-b', '-z');
    expect(r.ok).toBe(true);
    const s = parsePorcelainV2(r.stdout);
    expect(s.entries).toEqual([{ kind: 'untracked', path: 'näme with space.txt', x: '?', y: '?' }]);
  });
});
