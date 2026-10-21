/* The LIVE contract pass (`npm run test:contract`) — drives the REAL cloud
 * dev deployment that CONVEX_DEPLOY_KEY names over HTTP. Run it under the
 * private with-dev helper (tests/contract/global.setup.mts). Deliberately NOT a vitest
 * workspace: a workspace would make ALL projects run under a plain
 * `vitest run`, which is exactly the hermeticity failure the separate config
 * exists to prevent (the main vitest.config.mts excludes tests/contract/**).
 *
 * The target deployment is SHARED: globalSetup resets the Northstar Labs work
 * (manual edits and saved views there are lost by design; logins, portraits and keys survive) and mints test credentials that the
 * teardown deletes, together with their stash in the private fixture
 * directory (tests/contract/stash.mts). Never run this while `npm run dev` work or the smoke is
 * in flight. The setup refuses to start while another pass on this machine that uses the same
 * fixture directory runs against the deployment. It cannot see passes elsewhere. */
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
