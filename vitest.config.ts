import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Test files run concurrently, each in its own isolated worker process (the vitest
    // default, stated here deliberately): every suite creates its own temp dirs, so
    // filesystem/lock state never crosses files. Do not flip this to false as a "fix" for a
    // flaky test — a cross-file collision means a suite leaked shared state, which is the bug.
    fileParallelism: true,
    environment: 'node',
    // Several suites spawn the built CLI (and, inside it, PowerShell) as real subprocesses,
    // up to six spawns in one test; on a loaded Windows machine a single Node spawn can take
    // multiple seconds, so the 5s default produced spurious timeouts. This is a hang backstop,
    // not an expected duration — in-process tests still finish in milliseconds.
    //
    // 60s → 120s in S21.5. That session added two more process-heavy suites (`cli.surface`
    // spawns the binary ~15 times; `repl.consent` runs two entire REPLs with `isTTY: true`), and
    // the extra concurrent load pushed `cli.smoke` past the old backstop in roughly one clean run
    // in three — always a TIMEOUT, never an assertion, and never the same test twice. Diagnosed
    // rather than assumed: the failing test was measured at 75s of real work under load.
    testTimeout: 120_000,
  },
});
