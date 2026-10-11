import { defineConfig } from 'vitest/config';

// Tests cover the pure offline core (src/core) against node:sqlite and the real server.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000, pool: 'forks' },
});
