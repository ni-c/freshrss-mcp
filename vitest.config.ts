import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and exits
      // the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-17: statements 96.5, branches 83.5, functions 99.2,
      // lines 97.4. Set just below, with headroom on functions. Write the missing
      // tests instead of lowering them.
      thresholds: {
        statements: 94,
        branches: 80,
        functions: 94,
        lines: 95,
      },
    },
  },
});
