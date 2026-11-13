import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/support/postgres-global-setup.ts'],
          // Integration tests share one PostgreSQL container per file and may wait on real I/O.
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
