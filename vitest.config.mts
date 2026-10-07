/* Standalone vitest config. Its existence REPLACES the fallback to
 * vite.config.ts — deliberate: the pure-logic src/ suites use none of the
 * vite plugins (no JSX, no CSS, planner mocked where touched), so
 * they run on plain Vite transforms in the node environment.
 *
 * convex/ tests run in edge-runtime, the environment closest to the Convex
 * isolate (no node globals leaking into code that will not have them).
 * convex-test must be inlined so its import.meta.glob default and the
 * `global.Convex` syscall proxy are processed by vite inside that VM. */
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /* Runs inside the test environment before the test file is imported —
     * the only hook early enough for convex/auth.ts's module-scope SITE_URL
     * requirement. See convex/tests/env.setup.ts. */
    setupFiles: ['convex/tests/env.setup.ts'],
    server: { deps: { inline: ['convex-test'] } },
    /* tests/contract/** is the LIVE contract pass (vitest.contract.config.mts,
     * `npm run test:contract`): it reseeds and drives the shared dev
     * deployment. `*.test.mts` matches vitest's default include, so without
     * this exclude a plain `vitest run` would pick the live suite up and stop
     * being hermetic. `.claude/**` holds other sessions' git worktrees — whole
     * checkouts, contract suite included — that must not be tested from here. */
    exclude: [...configDefaults.exclude, 'tests/contract/**', '.local/**', '**/.claude/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          exclude: ['convex/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'convex',
          environment: 'edge-runtime',
          // Full fixture transactions need time to finish on shared CI workers.
          testTimeout: 20_000,
          include: ['convex/**/*.test.ts'],
        },
      },
    ],
  },
})
