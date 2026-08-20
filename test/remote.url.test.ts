import { describe, expect, it } from 'vitest';
import { endpointOf, parseRemoteUrl, parseRemoteVerbose } from '../src/remote/url.js';
import { isOid, qualifyBranch, qualifyTag, refNameProblem, remoteNameProblem, shortOid, shortRef } from '../src/remote/refs.js';

/**
 * Remote URL parsing and ref qualification (Session 20).
 *
 * Both are identity work: a mutation must name an exact destination, and both of these decide what
 * "exact" means. The interesting cases are the ones where a naive implementation is confidently
 * wrong — a Windows drive path that looks like an scp remote, a credential-bearing URL that must
 * never be echoed, and a tag name that must not be coerced into a branch.
 */

describe('parseRemoteUrl', () => {
  it('parses https with owner/repo', () => {
    const p = parseRemoteUrl('https://github.com/earthwalker17/agent-cli.git');
    expect(p).toMatchObject({ scheme: 'https', host: 'github.com', slug: 'earthwalker17/agent-cli', isGitHubHost: true, hadCredentials: false });
  });

  it('parses the scp-like form without treating the username as a secret', () => {
    const p = parseRemoteUrl('git@github.com:earthwalker17/agent-cli.git');
    expect(p).toMatchObject({ scheme: 'scp', host: 'github.com', slug: 'earthwalker17/agent-cli', isGitHubHost: true, hadCredentials: false });
    expect(p.displayUrl).toBe('git@github.com:earthwalker17/agent-cli.git');
  });

  it('parses ssh:// with an explicit scheme', () => {
    const p = parseRemoteUrl('ssh://git@github.com/o/r.git');
    expect(p).toMatchObject({ scheme: 'ssh', host: 'github.com', slug: 'o/r' });
  });

  it('REDACTS embedded credentials and reports that it did', () => {
    // Synthetic token fixture: real shape, never a live credential.
    const p = parseRemoteUrl('https://x-access-token:ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/o/r.git');
    expect(p.hadCredentials).toBe(true);
    expect(p.displayUrl).not.toContain('ghs_');
    expect(p.displayUrl).toContain('[REDACTED credentials]');
    expect(p.host).toBe('github.com');
  });

  it('treats a Windows drive path as a local path, NOT an scp-like remote', () => {
    // `C:\repos\bare.git` has the same host:path shape to a naive splitter — and it is exactly how
    // this pack is tested without a network, so getting it wrong would be self-inflicted.
    for (const local of ['C:\\repos\\bare.git', 'c:/repos/bare.git']) {
      const p = parseRemoteUrl(local);
      expect(p.scheme).toBe('file');
      expect(p.host).toBeNull();
      expect(p.isGitHubHost).toBe(false);
    }
  });

  it('treats posix paths and file:// URLs as local', () => {
    for (const local of ['/srv/git/bare.git', './bare.git', '../bare.git', 'file:///srv/git/bare.git']) {
      expect(parseRemoteUrl(local).scheme).toBe('file');
    }
  });

  it('normalizes a trailing dot in the host, matching shared/domain.ts', () => {
    // Two host comparisons in one codebase must not disagree about whether `github.com.` is
    // `github.com` — that disagreement is precisely the S19 trailing-dot bypass, one layer over.
    expect(parseRemoteUrl('https://github.com./o/r.git').host).toBe('github.com');
    expect(parseRemoteUrl('https://github.com./o/r.git').isGitHubHost).toBe(true);
  });

  it('recognises enterprise-shaped GitHub hosts but not lookalikes', () => {
    expect(parseRemoteUrl('https://acme.ghe.com/o/r.git').isGitHubHost).toBe(true);
    expect(parseRemoteUrl('https://github.com.evil.test/o/r.git').isGitHubHost).toBe(false);
    expect(parseRemoteUrl('https://notgithub.com/o/r.git').isGitHubHost).toBe(false);
  });

  it('returns a null slug for a path that is not exactly owner/repo', () => {
    expect(parseRemoteUrl('https://gitlab.com/group/sub/proj.git').slug).toBeNull();
    expect(parseRemoteUrl('https://example.test/').slug).toBeNull();
  });

  it('never throws on garbage', () => {
    for (const junk of ['', '   ', 'not a url', '://', 'https://']) {
      expect(() => parseRemoteUrl(junk)).not.toThrow();
    }
  });
});

describe('parseRemoteVerbose', () => {
  const OUT = [
    'origin\thttps://github.com/o/r.git (fetch)',
    'origin\thttps://github.com/o/r.git (push)',
    'upstream\thttps://github.com/up/r.git (fetch)',
    'upstream\thttps://github.com/other/r.git (push)',
    '',
  ].join('\n');

  it('reads the fetch URL and names remotes whose push URL differs', () => {
    const { endpoints, pushUrlDiffers } = parseRemoteVerbose(OUT);
    expect(endpoints.map((e) => e.name)).toEqual(['origin', 'upstream']);
    expect(endpoints[0]?.slug).toBe('o/r');
    // A divergent pushurl means an observation of one URL would not describe the other. That is a
    // stop, not something to resolve silently.
    expect(pushUrlDiffers).toEqual(['upstream']);
  });

  it('ignores lines it cannot parse rather than inventing a remote', () => {
    expect(parseRemoteVerbose('garbage\nmore garbage').endpoints).toEqual([]);
  });
});

describe('endpointOf', () => {
  it('carries the credential warning through to the endpoint', () => {
    const e = endpointOf('origin', 'https://user:pw@github.com/o/r.git');
    expect(e.hadCredentials).toBe(true);
    expect(e.displayUrl).not.toContain('pw@');
  });
});

describe('ref qualification', () => {
  it('qualifies short names', () => {
    expect(qualifyBranch('session-20')).toEqual({ ref: 'refs/heads/session-20' });
    expect(qualifyBranch('feat/x')).toEqual({ ref: 'refs/heads/feat/x' });
    expect(qualifyTag('v1.6.0')).toEqual({ ref: 'refs/tags/v1.6.0' });
  });

  it('accepts an already-qualified ref of the right kind', () => {
    expect(qualifyBranch('refs/heads/main')).toEqual({ ref: 'refs/heads/main' });
    expect(qualifyTag('refs/tags/v1')).toEqual({ ref: 'refs/tags/v1' });
  });

  it('REFUSES to coerce a tag into a branch (or vice versa)', () => {
    // `refs/heads/refs/tags/v1` is how a tag quietly becomes a branch.
    expect(qualifyBranch('refs/tags/v1')).toHaveProperty('error');
    expect(qualifyTag('refs/heads/main')).toHaveProperty('error');
  });

  it('rejects names that could be read as flags or that git forbids', () => {
    for (const bad of ['-x', '--force', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', '/lead', 'trail/', '..', 'a..b', 'a@{b', '@', 'x.lock', '.hidden']) {
      expect(refNameProblem(bad), `should reject ${bad}`).toBeDefined();
    }
  });

  it('accepts ordinary names, including hyphens and dots', () => {
    for (const ok of ['session-20', 'v1.6.0', 'feat/thing', 'a_b', 'RELEASE.2026']) {
      expect(refNameProblem(ok), `should accept ${ok}`).toBeUndefined();
    }
  });

  it('validates remote names on the same terms', () => {
    expect(remoteNameProblem('origin')).toBeUndefined();
    expect(remoteNameProblem('-o')).toBeDefined();
    expect(remoteNameProblem('a b')).toBeDefined();
    expect(remoteNameProblem('')).toBeDefined();
  });

  it('shortens refs and oids for display', () => {
    expect(shortRef('refs/heads/x')).toBe('x');
    expect(shortRef('refs/tags/v1')).toBe('v1');
    expect(shortRef('HEAD')).toBe('HEAD');
    expect(shortOid(null)).toBe('(absent)');
    expect(shortOid('0123456789abcdef0123456789abcdef01234567')).toBe('0123456789ab');
  });

  it('recognises sha1 and sha256 object ids', () => {
    expect(isOid('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(isOid('a'.repeat(64))).toBe(true);
    expect(isOid('nope')).toBe(false);
  });
});
