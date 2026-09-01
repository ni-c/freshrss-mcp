import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite has its own config and its own command, because it
    // needs a FreshRSS in Docker. Excluding it here keeps `npm test` runnable
    // with nothing installed, and keeps the coverage numbers below comparable
    // to what they measured before it existed.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    // mcp-internal-hosts is transformed rather than taken as an external
    // dependency, so that `vi.mock('node:dns/promises')` reaches the resolving
    // it does on this server's behalf. Without it the guard tests would pass
    // against a real resolver, which is to say against whatever the machine
    // running them happens to answer.
    server: { deps: { inline: ['mcp-internal-hosts'] } },
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
