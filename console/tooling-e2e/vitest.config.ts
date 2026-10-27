import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Real network round-trips through Switch; a whole
    // scenario suite can idle for minutes waiting on a model turn.
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    // Scenarios share one room and one agent, so they must not interleave.
    fileParallelism: false,
    pool: 'forks',
    reporters: ['verbose'],
  },
});
