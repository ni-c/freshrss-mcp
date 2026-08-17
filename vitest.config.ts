import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and exits
      // the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-17 after the pre-release security audit: statements
      // 97.2, branches 87.4, functions 99.2, lines 97.8. Set just below, with
      // headroom on functions. Write the missing tests instead of lowering them.
      thresholds: {
        statements: 95,
        branches: 84,
        functions: 94,
        lines: 96,
      },
    },
  },
});
