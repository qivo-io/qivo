/* The on-demand measurement of REST and MCP active task pages at the full
 * testing envelope (convex/tests/activeTaskPages.envelope.ts, whose header
 * says when and how to run it): `npx vitest run --config
 * vitest.envelope.config.mts`. A config of its own, as vitest.contract.config.mts
 * is, so a plain `vitest run` never picks the hour-long file up. It runs it
 * as vitest.config.mts runs the convex/ suites: in edge-runtime, with
 * convex-test inlined and the same convex-test patches and setup. */
import { defineConfig } from 'vitest/config'
import { convexTestActionStorage } from './scripts/convex-test-action-storage.mjs'
import { convexTestTableIds } from './scripts/convex-test-table-ids.mjs'

export default defineConfig({
  plugins: [convexTestTableIds(), convexTestActionStorage()],
  test: {
    include: ['convex/tests/**/*.envelope.ts'],
    environment: 'edge-runtime',
    setupFiles: ['convex/tests/env.setup.ts'],
    server: { deps: { inline: ['convex-test'] } },
    // each case builds an organization of 50,000 tasks and reads it
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
})
