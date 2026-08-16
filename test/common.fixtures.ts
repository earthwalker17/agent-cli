import fs from 'node:fs';

/**
 * Shared fixture-side helpers (S22.6). Both exist because of one CI failure mode: on a starved
 * runner, the code that BUILDS a test's world starts failing before the code under test does.
 *
 * The distinction that matters — a fixture is not the thing under test. Bounds that are correct
 * for the product are wrong for a fixture, and the fix belongs here rather than in `src/`.
 */

/**
 * The timeout a test's own `git` plumbing runs under.
 *
 * `runGit`'s product default is 15s (`src/git/client.ts`), which is right for the local plumbing
 * the harness actually issues in a session. It is NOT right for `git init` inside a `beforeEach`
 * on a 4-vCPU runner executing two other spawn-heavy suites: run 31941151786 killed a fixture
 * `git init` and a fixture `git push`/`git commit` at exactly that bound, and the tests then
 * reported `ok: false` as if git had refused. Fixture setup gets a hang backstop instead.
 *
 * Deliberately NOT applied to product call sites: those must keep asserting the real bounds.
 */
export const FIXTURE_GIT_TIMEOUT_MS = 120_000;

/**
 * Remove a temp directory, tolerating the Windows handle race.
 *
 * A just-exited child (git, node, PowerShell) can still hold a handle for a few milliseconds
 * after `wait` returns, and an AV scanner can hold one for longer; `rmSync` then throws
 * `EBUSY`/`EPERM`/`ENOTEMPTY` from an `afterEach` and turns a passing test into a reported
 * failure. Node retries exactly that error class when asked, so ask.
 */
export function rmTemp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
