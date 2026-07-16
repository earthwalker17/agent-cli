import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Filesystem and lockfile behavior is process-global; keep suites isolated.
    fileParallelism: true,
    environment: 'node',
    // Several suites spawn the built CLI (and, inside it, PowerShell) as real subprocesses,
    // up to six spawns in one test; on a loaded Windows machine a single Node spawn can take
    // multiple seconds, so the 5s default produced spurious timeouts. This is a hang backstop,
    // not an expected duration — in-process tests still finish in milliseconds.
    testTimeout: 60_000,
  },
});
