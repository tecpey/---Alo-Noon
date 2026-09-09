import { defineConfig } from 'vitest/config'

/**
 * Integration tests all target the one database named by DATABASE_URL, and
 * several of them deliberately race concurrent writes to prove serialization
 * holds. Run in parallel workers they contend with each other rather than with
 * what they are testing, and fail with conflicts that say nothing about the
 * code. Unit tests touch nothing shared, so they keep full parallelism.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'eslint-rules/**/*.test.js'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
})
