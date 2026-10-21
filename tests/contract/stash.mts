/* Where the live contract pass keeps the credentials its global setup mints.
 * The suites read them with fs; no vitest `provide` plumbing (version-proof).
 * The file lives in the private fixture directory the with-dev helper names
 * in QIVO_FIXTURE_CREDENTIALS_DIR, outside the checkout, so no dev server can
 * serve it. Hermetic tests in tests/contractSetup.test.ts. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureDirectory } from '../../scripts/marketing-demo.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export type Stash = {
  siteUrl: string
  orgId: string
  qva: string
  qvt: string
  qvaId: string
  qvtId: string
}

/**
 * The stash path in QIVO_FIXTURE_CREDENTIALS_DIR. Throws unless that is an
 * existing private (0700) directory outside the checkout.
 */
export function stashPath(env: Record<string, string | undefined>, root = ROOT): string {
  return join(fixtureDirectory(root, env), 'contract.credentials.json')
}

/** Writes a new stash that only this user can read, replacing any old one. */
export function writeStash(path: string, stash: Stash): void {
  rmSync(path, { force: true })
  writeFileSync(path, JSON.stringify(stash, null, 2), { mode: 0o600, flag: 'wx' })
}

/** The stash the global setup wrote for this pass. */
export function readStash(): Stash {
  return JSON.parse(readFileSync(stashPath(process.env), 'utf8'))
}
