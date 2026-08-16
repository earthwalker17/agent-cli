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
    // CONCURRENCY (S22.6). Vitest defaults the worker count to the machine's CPU count, which is
    // right on a developer box and wrong on a CI runner: a large share of these 151 files spawn
    // REAL subprocesses (git, node, PowerShell, chromium), so N workers means far more than N
    // concurrent processes. On the 4-vCPU `windows-latest` runner that starved the box — run
    // 31941151786 measured `Duration 347s` wall against `tests 972s` summed, ~2.8x
    // oversubscription — and the symptoms were all scheduling, never logic: a fixture `git init`
    // exceeded runGit's 15s bound, a SYNCHRONOUS `mkdtempSync` hook exceeded 10s, teardown
    // `rmSync` hit Windows EBUSY, and a chromium print blew its cap. Capping CI at 2 trades wall
    // time (comfortably inside the job's 30-minute budget) for a gate that means something.
    // Local runs are untouched.
    ...(process.env['CI'] ? { maxWorkers: 2, minWorkers: 1 } : {}),
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
    // Hooks get the same treatment, and for the same reason (S22.6): the default is 10s, and the
    // hook that failed on CI was a purely synchronous `mkdtempSync` + `mkdirSync` beforeEach —
    // i.e. the box, not the code. A hook backstop exists to catch a hang, not to time I/O.
    hookTimeout: 60_000,
  },
});
