import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGhEnv, compareVersions, findGhOnPath, parseGhVersion, probeGhFacts } from '../src/remote/gh.js';
import { ghAuthStatusArgv, ghIssueListArgv, ghPullListArgv, ghReleaseCreateArgv, ghRepoViewArgv, ghRunListArgv, gitPushArgv, renderArgv } from '../src/remote/argv.js';
import { parseAuthStatus, parseIssues, parsePulls, parseRelease, parseRepository, parseRun, parseRuns, releaseUrlFromCreate } from '../src/remote/parse.js';
import { RemoteError } from '../src/remote/errors.js';
import type { GhResult, GhRunner } from '../src/remote/types.js';

/**
 * The managed gh client, the argv catalogue, and the tolerant JSON parsers (Session 20).
 *
 * Hermetic by construction: the runner is an injected seam (the research pack's `fetchImpl`
 * precedent), so nothing here opens a socket or reads a real credential store. The gh JSON
 * fixtures are the REAL shapes, captured from gh 2.96.0 during the session that wrote this code —
 * including the one that surprises: `scopes` is a comma-separated string, not an array.
 */

function ok(stdout: string): GhResult {
  return { ok: true, exitCode: 0, termination: 'exited', stdout, stderr: '', durationMs: 1 };
}
function fail(stderr: string, exitCode = 1): GhResult {
  return { ok: false, exitCode, termination: 'exited', stdout: '', stderr, durationMs: 1 };
}

describe('findGhOnPath', () => {
  let tmp: string;
  const mk = (dir: string, name: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, '');
    // findGhOnPath demands the executable bit on POSIX (X_OK); chmod is a harmless no-op on win32.
    fs.chmodSync(p, 0o755);
    return p;
  };

  it('resolves an absolute PATH entry and skips relative ones', () => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ghpath-')));
    try {
      const good = path.join(tmp, 'bin');
      mk(good, 'gh.exe');
      mk(good, 'gh');
      // A relative PATH entry resolves against the CHILD cwd on Windows — a planted binary in a
      // workspace must never win, so relative entries are skipped outright.
      const env = { PATH: ['.', 'relative/bin', good].join(path.delimiter) };
      expect(findGhOnPath(env, 'win32')).toBe(path.join(good, 'gh.exe'));
      expect(findGhOnPath(env, 'linux')).toBe(path.join(good, 'gh'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT accept a .cmd/.bat shim on Windows', () => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ghpath-')));
    try {
      const dir = path.join(tmp, 'bin');
      mk(dir, 'gh.cmd');
      mk(dir, 'gh.bat');
      // A shim cannot be spawned without a shell, and a shell is a code-injection surface.
      expect(findGhOnPath({ PATH: dir }, 'win32')).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns null when gh is nowhere on PATH', () => {
    expect(findGhOnPath({ PATH: '' }, 'linux')).toBeNull();
  });
});

describe('buildGhEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    SystemRoot: 'C:\\Windows',
    GH_REPO: 'attacker/elsewhere',
    GH_DEBUG: 'api',
    DEBUG: '1',
    GH_FORCE_TTY: '100',
    GH_TOKEN: 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    GITHUB_TOKEN: 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ9876543210',
    GH_HOST: 'ghe.example.test',
    GH_CONFIG_DIR: '/elsewhere/gh',
  };

  it('scrubs GH_REPO — it retargets every command the way GIT_DIR does', () => {
    expect(buildGhEnv(parent)['GH_REPO']).toBeUndefined();
  });

  it('scrubs GH_DEBUG/DEBUG — gh debug mode prints the Authorization header', () => {
    const env = buildGhEnv(parent);
    expect(env['GH_DEBUG']).toBeUndefined();
    expect(env['DEBUG']).toBeUndefined();
  });

  it('never forwards a token-shaped variable (buildChildEnv already drops them)', () => {
    const env = buildGhEnv(parent);
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(Object.values(env).join(' ')).not.toContain('gho_');
  });

  it('forces non-interactive, colourless, pager-free, telemetry-free operation', () => {
    const env = buildGhEnv(parent);
    expect(env['GH_PROMPT_DISABLED']).toBe('1');
    expect(env['NO_COLOR']).toBe('1');
    expect(env['GH_PAGER']).toBe('');
    expect(env['DO_NOT_TRACK']).toBe('1');
    expect(env['GH_FORCE_TTY']).toBeUndefined();
  });

  it('PASSES THROUGH GH_HOST and GH_CONFIG_DIR — they are legitimate configuration', () => {
    // Removing them would break an enterprise or multi-account setup. They are recorded in
    // remote.context instead, so an override is auditable rather than invisible.
    const env = buildGhEnv(parent);
    expect(env['GH_HOST']).toBe('ghe.example.test');
    expect(env['GH_CONFIG_DIR']).toBe('/elsewhere/gh');
  });
});

describe('version handling', () => {
  it('parses the gh banner', () => {
    expect(parseGhVersion('gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0')).toBe('2.96.0');
    expect(parseGhVersion('something else')).toBeNull();
  });

  it('compares versions numerically, not lexically', () => {
    expect(compareVersions('2.96.0', '2.97.0')).toBeLessThan(0);
    expect(compareVersions('2.100.0', '2.97.0')).toBeGreaterThan(0);
    expect(compareVersions('2.97.0', '2.97.0')).toBe(0);
    expect(compareVersions('3.0.0', '2.97.0')).toBeGreaterThan(0);
  });
});

describe('probeGhFacts', () => {
  const cwd = process.cwd();

  it('reports the leak risk for a gh below the GHSA-cg6r-mpgc-h9mm fix', async () => {
    const runner: GhRunner = async () => ok('gh version 2.96.0 (2026-07-02)\n');
    const f = await probeGhFacts({ runner, ghPath: '/x/gh', cwd, env: {} });
    expect(f.version).toBe('2.96.0');
    expect(f.authStatusLeakRisk).toBe(true);
    expect(f.detail).toContain('GHSA-cg6r-mpgc-h9mm');
  });

  it('does not flag a fixed gh', async () => {
    const runner: GhRunner = async () => ok('gh version 2.97.0 (2026-07-31)\n');
    const f = await probeGhFacts({ runner, ghPath: '/x/gh', cwd, env: {} });
    expect(f.authStatusLeakRisk).toBe(false);
  });

  it('records a GH_TOKEN in the parent shell as NOT forwarded, rather than silently ignoring it', async () => {
    // Without this, the user sees an inexplicable "not logged in" from a machine where `gh` works
    // perfectly in their own terminal.
    const runner: GhRunner = async () => ok('gh version 2.97.0\n');
    const f = await probeGhFacts({ runner, ghPath: '/x/gh', cwd, env: { GH_TOKEN: 'x' } });
    expect(f.tokenEnvPresentButNotForwarded).toBe(true);
    expect(f.detail).toContain('NOT forwarded');
  });

  it('records GH_HOST / GH_CONFIG_DIR overrides so a retarget is auditable', async () => {
    const runner: GhRunner = async () => ok('gh version 2.97.0\n');
    const f = await probeGhFacts({ runner, ghPath: '/x/gh', cwd, env: { GH_HOST: 'ghe.example.test', GH_CONFIG_DIR: '/tmp/x' } });
    expect(f.hostOverride).toBe('ghe.example.test');
    expect(f.configDirOverride).toBe('/tmp/x');
    expect(f.detail).toContain('GH_HOST=ghe.example.test');
  });

  it('degrades honestly when gh is absent or the probe fails', async () => {
    const absent = await probeGhFacts({ ghPath: null, cwd, env: {} });
    expect(absent.detail).toBe('gh not found');
    const broken = await probeGhFacts({ runner: async () => fail('boom'), ghPath: '/x/gh', cwd, env: {} });
    expect(broken.probeFailed).toBe(true);
    expect(broken.version).toBeNull();
  });

  it('never spawns anything to answer "is gh installed" when it is not on PATH', async () => {
    let called = 0;
    const runner: GhRunner = async () => {
      called += 1;
      return ok('');
    };
    await probeGhFacts({ runner, ghPath: null, cwd, env: {} });
    expect(called).toBe(0);
  });
});

describe('argv composition', () => {
  it('emits every option in --flag=value form so a value cannot become a flag', () => {
    const argv = ghPullListArgv('o/r', { limit: 5, state: 'open' });
    for (const a of argv) {
      if (a.startsWith('--') && !['--json'].includes(a)) expect(a.includes('=') || a === '--json').toBe(true);
    }
    expect(argv).toContain('--repo=o/r');
    expect(argv).toContain('--limit=5');
  });

  it('clamps the item limit into the declared bound', () => {
    expect(ghIssueListArgv('o/r', { limit: 9999 })).toContain('--limit=30');
    expect(ghRunListArgv('o/r', { limit: 0 })).toContain('--limit=1');
  });

  it('never passes --show-token, in any view', () => {
    expect(ghAuthStatusArgv()).toEqual(['auth', 'status', '--json', 'hosts']);
    expect(ghAuthStatusArgv()).not.toContain('--show-token');
  });

  it('ALWAYS passes --verify-tag on a release create', () => {
    // Without it gh creates the tag from the default branch as a side effect: a publish nobody
    // asked for, at a commit nobody named.
    const argv = ghReleaseCreateArgv({ slug: 'o/r', tag: 'v1.6.0', title: 'T', notesFile: '/tmp/n.md', draft: false, prerelease: false });
    expect(argv).toContain('--verify-tag');
    expect(argv).toContain('--notes-file=/tmp/n.md');
    // Notes never travel through argv.
    expect(argv.some((a) => a.startsWith('--notes='))).toBe(false);
  });

  it('composes a push refspec from the OID, not a branch name', () => {
    const oid = '0123456789abcdef0123456789abcdef01234567';
    expect(gitPushArgv({ remoteName: 'origin', refName: 'refs/heads/x', sourceOid: oid, dryRun: false })).toEqual([
      'push',
      '--porcelain',
      '--no-follow-tags',
      'origin',
      `${oid}:refs/heads/x`,
    ]);
  });

  it('binds a force push to the observed oid with an explicit lease, and uses the empty lease for an absent ref', () => {
    const oid = 'a'.repeat(40);
    const remote = 'b'.repeat(40);
    expect(gitPushArgv({ remoteName: 'origin', refName: 'refs/heads/x', sourceOid: oid, lease: { expect: remote }, dryRun: true })).toEqual([
      'push',
      '--porcelain',
      '--no-follow-tags',
      '--dry-run',
      `--force-with-lease=refs/heads/x:${remote}`,
      'origin',
      `${oid}:refs/heads/x`,
    ]);
    expect(gitPushArgv({ remoteName: 'origin', refName: 'refs/heads/x', sourceOid: oid, lease: { expect: null }, dryRun: false })).toContain(
      '--force-with-lease=refs/heads/x:',
    );
  });

  it('never passes --force-if-includes (a no-op without a fetched remote-tracking reflog)', () => {
    const argv = gitPushArgv({ remoteName: 'origin', refName: 'refs/heads/x', sourceOid: 'a'.repeat(40), lease: { expect: 'b'.repeat(40) }, dryRun: false });
    expect(argv).not.toContain('--force-if-includes');
  });

  it('renders argv for display without ever being parsed by a shell', () => {
    expect(renderArgv('gh', ['release', 'create', 'v1', '--title=a b'])).toBe('gh release create v1 "--title=a b"');
  });
});

describe('tolerant gh JSON parsers', () => {
  const AUTH = JSON.stringify({
    hosts: {
      'github.com': [
        { state: 'success', active: true, host: 'github.com', login: 'earthwalker17', tokenSource: 'keyring', scopes: 'gist, read:org, repo', gitProtocol: 'https' },
      ],
    },
  });

  it('parses the real auth shape, splitting the comma-separated scopes string', () => {
    const [id] = parseAuthStatus(AUTH);
    expect(id).toMatchObject({ host: 'github.com', account: 'earthwalker17', protocol: 'https', source: 'keyring', multipleAccounts: false });
    expect(id?.scopes).toEqual(['gist', 'read:org', 'repo']);
    // The absence of `workflow` is load-bearing downstream.
    expect(id?.scopes).not.toContain('workflow');
  });

  it('drops a host whose token failed validation rather than reporting it as authenticated', () => {
    const bad = JSON.stringify({ hosts: { 'github.com': [{ state: 'error', active: true, host: 'github.com', login: 'x' }] } });
    expect(parseAuthStatus(bad)).toEqual([]);
  });

  it('sorts the ACTIVE identity first so a caller taking the head gets the credential gh would use', () => {
    const two = JSON.stringify({
      hosts: {
        'github.com': [
          { state: 'success', active: false, host: 'github.com', login: 'inactive', scopes: 'repo' },
          { state: 'success', active: true, host: 'github.com', login: 'active', scopes: 'repo' },
        ],
      },
    });
    const ids = parseAuthStatus(two);
    expect(ids[0]?.account).toBe('active');
    expect(ids.every((i) => i.multipleAccounts)).toBe(true);
  });

  it('parses the real repository shape, including the nested defaultBranchRef', () => {
    const r = parseRepository(
      JSON.stringify({
        defaultBranchRef: { name: 'main' },
        description: 'd',
        isArchived: false,
        isFork: false,
        isPrivate: false,
        nameWithOwner: 'o/r',
        pushedAt: '2026-08-07T17:19:34Z',
        url: 'https://github.com/o/r',
        viewerPermission: 'ADMIN',
      }),
    );
    expect(r).toMatchObject({ nameWithOwner: 'o/r', defaultBranch: 'main', viewerPermission: 'ADMIN', isPrivate: false });
  });

  it('reads an author object OR a bare string without crashing', () => {
    const objForm = parsePulls(JSON.stringify([{ number: 1, title: 't', author: { login: 'a' }, state: 'OPEN' }]));
    const strForm = parsePulls(JSON.stringify([{ number: 1, title: 't', author: 'a', state: 'OPEN' }]));
    expect(objForm[0]?.author).toBe('a');
    expect(strForm[0]?.author).toBe('a');
  });

  it('degrades a missing or retyped field to an empty value instead of throwing', () => {
    // gh's shapes are a third party's contract. A cosmetic upstream change must not crash a
    // publish flow.
    const r = parseRepository(JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: 'not-an-object', viewerPermission: 42 }));
    expect(r.defaultBranch).toBeNull();
    expect(r.viewerPermission).toBeNull();
    expect(parseIssues(JSON.stringify([{ number: 1, labels: 'nope' }]))[0]?.labels).toEqual([]);
  });

  it('parses runs and a single run', () => {
    const one = { databaseId: 1, workflowName: 'CI', displayTitle: 't', status: 'completed', conclusion: 'success', headBranch: 'main', headSha: 'a'.repeat(40), event: 'push', url: 'u', createdAt: 'c' };
    expect(parseRuns(JSON.stringify([one]))[0]?.workflowName).toBe('CI');
    expect(parseRun(JSON.stringify(one)).conclusion).toBe('success');
  });

  it('parses a release and extracts the created URL from stdout', () => {
    expect(parseRelease(JSON.stringify({ url: 'u', tagName: 'v1', isDraft: true, isPrerelease: false })).isDraft).toBe(true);
    expect(releaseUrlFromCreate('https://github.com/o/r/releases/tag/v1\n')).toBe('https://github.com/o/r/releases/tag/v1');
    expect(releaseUrlFromCreate('no url here')).toBeNull();
  });

  it('raises a typed malformed-output error for output that is not JSON at all', () => {
    expect(() => parseRepository('not json')).toThrow(RemoteError);
    expect(() => parseRuns('{}')).toThrow(/did not return a list/);
  });
});
