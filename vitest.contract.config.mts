/* The LIVE contract pass (`npm run test:contract`) — drives the REAL cloud
 * dev deployment named in .env.local over HTTP. Deliberately NOT a vitest
 * workspace: a workspace would make ALL projects run under a plain
 * `vitest run`, which is exactly the hermeticity failure the separate config
 * exists to prevent (the main vitest.config.mts excludes tests/contract/**).
 *
 * The target deployment is SHARED: globalSetup resets the Northstar Labs work
 * (manual edits and saved views there are lost by design; logins, portraits and keys survive) and mints test credentials that the
 * teardown deletes. Never run this while `npm run dev` work or the smoke is
 * in flight. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.mts'],
    environment: 'node',
    globalSetup: 'tests/contract/global.setup.mts',
    fileParallelism: false, // one shared live backend — serialize the two files
    testTimeout: 30_000,
  },
})
