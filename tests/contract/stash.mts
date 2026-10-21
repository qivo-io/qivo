/* Where the live contract pass keeps the credentials its global setup mints.
 * The suites read them with fs; no vitest `provide` plumbing (version-proof).
 * The file lives in the private fixture directory QIVO_FIXTURE_CREDENTIALS_DIR
 * names, outside the checkout, so no dev server can serve it. The with-dev
 * helper exports it; like the reset, the pass otherwise reads it from
 * .env.local. Hermetic tests in tests/contractSetup.test.ts. */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { fixtureDirectory } from '../../scripts/marketing-demo.mjs'
import { contractDeployment } from './site.mts'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export type Stash = {
  siteUrl: string
  orgId: string
  /** The id every credential the pass mints carries in its name. */
  pass: string
  qva: string
  qvt: string
  qvaId: string
  qvtId: string
}

/** QIVO_FIXTURE_CREDENTIALS_DIR from `env`, else from the checkout's
 * .env.local, the way scripts/marketing-demo.mjs loads it for the reset. */
function fixtureEnv(env: Record<string, string | undefined>, root: string) {
  if (env.QIVO_FIXTURE_CREDENTIALS_DIR !== undefined) return env
  const file = join(root, '.env.local')
  const local = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return { QIVO_FIXTURE_CREDENTIALS_DIR: local.QIVO_FIXTURE_CREDENTIALS_DIR }
}

/**
 * The stash path in QIVO_FIXTURE_CREDENTIALS_DIR, one per deployment so that
 * passes against different deployments never share a stash. Throws unless
 * the key names a development deployment and the directory is an existing
 * private (0700) directory outside the checkout.
 */
export function stashPath(env: Record<string, string | undefined>, root = ROOT): string {
  const deployment = contractDeployment(env)
  const directory = fixtureDirectory(root, fixtureEnv(env, root))
  return join(directory, `contract-${deployment}.credentials.json`)
}

/**
 * Writes a new stash that only this user can read, replacing any old one.
 * The pass writes its id alone before it mints anything. The new file is
 * written beside the old one and renamed over it, so a failed or interrupted
 * write leaves the old stash, and with it the pass id, in place.
 */
export function writeStash(
  path: string,
  stash: Pick<Stash, 'siteUrl' | 'orgId' | 'pass'> & Partial<Stash>,
): void {
  const next = `${path}.new`
  rmSync(next, { force: true })
  writeFileSync(next, JSON.stringify(stash, null, 2), { mode: 0o600, flag: 'wx' })
  renameSync(next, path)
}

/** The stash the global setup wrote for this pass. */
export function readStash(): Stash {
  return JSON.parse(readFileSync(stashPath(process.env), 'utf8'))
}
