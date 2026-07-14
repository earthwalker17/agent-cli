import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Filesystem and lockfile behavior is process-global; keep suites isolated.
    fileParallelism: true,
    environment: 'node',
  },
});
