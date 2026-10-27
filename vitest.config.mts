/* Standalone Vitest config keeps most src/ suites on plain Vite transforms
 * in the Node environment. Component tests opt into jsdom per file and use
 * the same source alias as the application.
 *
 * convex/ tests run in edge-runtime, the environment closest to the Convex
 * isolate (no node globals leaking into code that will not have them).
 * convex-test must be inlined so its import.meta.glob default and the
 * `global.Convex` syscall proxy are processed by vite inside that VM.
 * Inlining also lets convexTestTableIds apply convex/convex-test#154 to it,
 * so that a query reads only its own table's documents. Both projects get
 * the plugin, because some node tests build convex-test backends too. */
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { convexTestTableIds } from './scripts/convex-test-table-ids.mjs'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [convexTestTableIds()],
  test: {
    /* Runs inside the test environment before the test file is imported —
     * the only hook early enough for convex/auth.ts's module-scope SITE_URL
     * requirement. See convex/tests/env.setup.ts. */
    setupFiles: ['convex/tests/env.setup.ts'],
    server: { deps: { inline: ['convex-test'] } },
    // Four test files at a time, here and in CI, whose runner has four CPUs.
    // `--maxWorkers` overrides it for one run.
    maxWorkers: 4,
    /* tests/contract/** is the LIVE contract pass (vitest.contract.config.mts,
     * `npm run test:contract`): it reseeds and drives the shared dev
     * deployment. `*.test.mts` matches vitest's default include, so without
     * this exclude a plain `vitest run` would pick the live suite up and stop
     * being hermetic. `.claude/**` holds other sessions' git worktrees — whole
     * checkouts, contract suite included — that must not be tested from here.
     * `dev-temp/**` holds disposable files, which can include copies of this
     * checkout and its tests. */
    exclude: [
      ...configDefaults.exclude,
      'tests/contract/**',
      '.local/**',
      '**/.claude/**',
      'dev-temp/**',
    ],
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
