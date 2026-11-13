/* Deployment env for the hermetic suites, planted before any module of the
 * function surface is imported. vitest evaluates setupFiles ahead of the test
 * file, which is the only hook early enough.
 *
 * convex/auth.ts refuses an unset SITE_URL rather than asserting it non-null
 * (lib/deployment.ts requireSiteUrl). http.ts no longer builds Better Auth's
 * options when it loads, but every sign-in, session read and options build
 * in a suite does, and so does the image gateway's CORS check of an Origin,
 * so the values stay planted for every convex suite, not only the ones that
 * name them.
 *
 * Fixture helpers require an explicit development environment. Individual
 * tests override it when exercising hosted environments and refusal paths.
 *
 * Named *.setup.ts because two dots in the basename is the Convex CLI's skip
 * rule — the same one that keeps the *.test.ts files out of the deploy (see
 * helpers.setup.ts). Auth discovery also needs a default CONVEX_SITE_URL;
 * secrets and any specialized URLs a
 * particular suite needs stay planted in that suite, where the reason for the
 * value is visible. `??=` never overwrites one of those.
 *
 * Wired globally from vitest.config.mts, so the src/ suites run it too. They
 * read none of this and the node environment already carries `process`. */

import { afterAll, afterEach } from 'vitest'

/* convex/** runs in edge-runtime, which may or may not carry a process global
 * — attachments.test.ts plants its own vars through the same handle. */
const g = globalThis as unknown as { process?: { env: Record<string, string | undefined> } }
g.process ??= { env: {} }
g.process.env.SITE_URL ??= 'http://localhost:5199'
g.process.env.CONVEX_SITE_URL ??= 'https://some.convex.site'
g.process.env.QIVO_ENVIRONMENT ??= 'development'

/* The Convex adapter for Better Auth reads a table through an index only
 * when one starts with every field a lookup compares for equality. It scans
 * the table otherwise and warns, and a scan grows with the table. Its schema
 * generator knows the lookups of Better Auth itself, not those of the OAuth
 * provider, whose indexes convex/betterAuth/schema.ts adds. A test in which
 * a lookup scans fails after it ran, with the index each warning names.
 * The warning is recorded, not thrown, because Better Auth catches the
 * errors of some lookups, such as the cleanup after a replayed authorization
 * code. A scan after a file's last test fails the file. A scan by work that
 * outlives its test, such as a scheduled function, fails the next test. A
 * test that replaces console.warn hides its scans from this.
 * betterAuthSchema.test.ts checks that the adapter still words the warning
 * this way. */
const scans: string[] = []
const warn = console.warn
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('Querying without an index'))
    scans.push(args[0])
  else warn(...args)
}

/** The scan warnings recorded since the last call, which empties them. For
 * the test that makes a lookup scan on purpose. */
export const takeScans = () => scans.splice(0)

function reportScans() {
  const found = [...new Set(takeScans())]
  if (found.length > 0)
    throw new Error(`A Better Auth lookup scanned a table:\n${found.join('\n')}`)
}
afterEach(reportScans)
afterAll(reportScans)
