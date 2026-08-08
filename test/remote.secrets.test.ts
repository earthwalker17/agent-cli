import { describe, expect, it } from 'vitest';
import { hasResidualSecret, scrubSecrets } from '../src/shared/secrets.js';

/**
 * The credential scrubber (Session 20).
 *
 * These are not hypothetical shapes. Each case below is one of the three real ways a credential
 * travels with gh/git output: the GHSA-cg6r-mpgc-h9mm leak in `gh auth status` below 2.97.0, the
 * standard CI remote URL, and git echoing that URL back inside an authentication failure.
 *
 * The fixtures use structurally valid but obviously synthetic token bodies — a test that carried a
 * real credential would be the failure it exists to prevent.
 */

const FAKE_OAUTH = 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const FAKE_PAT = 'github_pat_11ABCDEFG0aBcDeFgHiJk_LmNoPqRsTuVwXyZ0123456789abcdef';

describe('scrubSecrets', () => {
  it('removes every documented GitHub token prefix', () => {
    for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      const token = `${prefix}_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
      const out = scrubSecrets(`Token: ${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain('[REDACTED gh-token]');
    }
  });

  it('removes a fine-grained PAT, whose body contains underscores', () => {
    const out = scrubSecrets(`using ${FAKE_PAT} for auth`);
    expect(out).not.toContain(FAKE_PAT);
    expect(out).toContain('[REDACTED github-pat]');
  });

  it('strips URL userinfo in both the x-access-token and reversed forms', () => {
    const a = scrubSecrets(`https://x-access-token:${FAKE_OAUTH}@github.com/o/r.git`);
    expect(a).not.toContain(FAKE_OAUTH);
    expect(a).toBe('https://[REDACTED credentials]@github.com/o/r.git');
    const b = scrubSecrets(`https://${FAKE_OAUTH}:x-oauth-basic@github.com/o/r.git`);
    expect(b).not.toContain(FAKE_OAUTH);
  });

  it('leaves an scp-style remote alone — `git@host:path` carries a role name, not a secret', () => {
    const url = 'git@github.com:earthwalker17/agent-cli.git';
    expect(scrubSecrets(url)).toBe(url);
  });

  it('keeps the surrounding diagnostic text — the point is not to destroy the message', () => {
    const line = `fatal: Authentication failed for 'https://x-access-token:${FAKE_OAUTH}@github.com/o/r.git/'`;
    const out = scrubSecrets(line);
    expect(out).toContain('fatal: Authentication failed for');
    expect(out).toContain('github.com/o/r.git');
    expect(out).not.toContain(FAKE_OAUTH);
  });

  it('scrubs an Authorization header value if a verbose transport ever echoes one', () => {
    const out = scrubSecrets(`> Authorization: Bearer ${FAKE_OAUTH}`);
    expect(out).not.toContain(FAKE_OAUTH);
  });

  it('is stable across repeated calls (no shared regex lastIndex)', () => {
    // A module-level /g regex used with .test() answers differently on alternate calls. That bug
    // would make the scrubber silently miss every other occurrence, which is the worst possible
    // failure mode for this function.
    const text = `a ${FAKE_OAUTH} b`;
    for (let i = 0; i < 5; i += 1) {
      expect(hasResidualSecret(text)).toBe(true);
      expect(hasResidualSecret(scrubSecrets(text))).toBe(false);
    }
  });

  it('leaves ordinary text untouched', () => {
    const text = 'pushed refs/heads/session-20 to github.com/earthwalker17/agent-cli (4 commits)';
    expect(scrubSecrets(text)).toBe(text);
    expect(hasResidualSecret(text)).toBe(false);
  });
});
