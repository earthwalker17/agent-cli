import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkspaceMap, buildWorkspaceMapAuto } from '../src/workspace/map.js';
import { findGitOnPath, runGit } from '../src/git/client.js';
import { detectGitFacts } from '../src/git/facts.js';
import { FIXTURE_GIT_TIMEOUT_MS, rmTemp } from './common.fixtures.js';

/** Stage-5 tests: the git-backed map builder (real repos; skipped when git is absent). */

const REAL_GIT = findGitOnPath(process.env, process.platform);
const hasGit = REAL_GIT !== null;

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmTemp(dir);
});

function tmpdir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agitmap-')));
  cleanups.push(dir);
  return dir;
}

async function initRepo(dir: string): Promise<void> {
  expect((await runGit({ gitPath: REAL_GIT!, argv: ['init', '-q', '-b', 'main'], cwd: dir, timeoutMs: FIXTURE_GIT_TIMEOUT_MS })).ok).toBe(true);
}

describe.skipIf(!hasGit)('buildWorkspaceMapAuto (git-backed)', () => {
  it('honors NESTED .gitignore files — the walker only reads the root one', async () => {
    const dir = tmpdir();
    await initRepo(dir);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', '.gitignore'), 'generated.txt\n');
    fs.writeFileSync(path.join(dir, 'sub', 'generated.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'kept.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');

    const facts = await detectGitFacts(dir, { gitPath: REAL_GIT });
    const viaGit = await buildWorkspaceMapAuto(dir, {}, facts);
    expect(viaGit.text.split('\n')).toEqual(['a.txt', 'sub/.gitignore', 'sub/kept.txt']);
    expect(viaGit.fileCount).toBe(3);

    // The walker (no git) DOES leak the nested-ignored file — the documented gap this closes.
    const viaWalk = buildWorkspaceMap(dir);
    expect(viaWalk.text).toContain('sub/generated.txt');
  });

  it('subtracts tracked-but-deleted files and applies the builtin exclude set', async () => {
    const dir = tmpdir();
    await initRepo(dir);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'gone.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'x');
    expect((await runGit({ gitPath: REAL_GIT!, argv: ['add', '-A', '--', '.'], cwd: dir, timeoutMs: FIXTURE_GIT_TIMEOUT_MS })).ok).toBe(true);
    expect((await runGit({ gitPath: REAL_GIT!, argv: ['-c', 'user.name=T', '-c', 'user.email=t@e.c', 'commit', '-q', '-m', 'init'], cwd: dir, timeoutMs: FIXTURE_GIT_TIMEOUT_MS })).ok).toBe(true);
    fs.rmSync(path.join(dir, 'gone.txt'));

    const facts = await detectGitFacts(dir, { gitPath: REAL_GIT });
    const map = await buildWorkspaceMapAuto(dir, {}, facts);
    const files = map.text.split('\n');
    expect(files).toContain('keep.txt');
    expect(files).not.toContain('gone.txt'); // tracked in the index but absent on disk
    expect(files).not.toContain('dist/bundle.js'); // builtin exclude applies even when tracked
  });

  it('falls back to the walker outside a repo and applies the same budget contract', async () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const facts = await detectGitFacts(dir, { gitPath: REAL_GIT });
    expect(facts.isRepo).toBe(false);
    const map = await buildWorkspaceMapAuto(dir, {}, facts);
    expect(map.text).toBe('a.txt');
    expect(map.sha256).toHaveLength(64);

    const tight = await buildWorkspaceMapAuto(dir, { budget: 2 }, facts);
    expect(tight.truncated).toBe(true);
    expect(tight.text).toContain('truncated to fit the budget');
  });

  it('scopes to the workspace subtree when the workspace is a repo subdirectory', async () => {
    const dir = tmpdir();
    await initRepo(dir);
    fs.mkdirSync(path.join(dir, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'root.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'packages', 'app', 'inner.txt'), 'x');
    const sub = path.join(dir, 'packages', 'app');
    const facts = await detectGitFacts(sub, { gitPath: REAL_GIT });
    const map = await buildWorkspaceMapAuto(sub, {}, facts);
    expect(map.text).toBe('inner.txt');
  });
});
