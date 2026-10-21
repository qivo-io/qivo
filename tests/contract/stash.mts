/* Where the live contract pass keeps the credentials its global setup mints.
 * The suites read them with fs; no vitest `provide` plumbing (version-proof).
 * The file lives in the private fixture directory QIVO_FIXTURE_CREDENTIALS_DIR
 * names, outside the checkout, so no dev server can serve it. The with-dev
 * helper exports it; like the reset, the pass otherwise reads it from
 * .env.local. A lease beside the stash keeps a second pass on the same
 * deployment from starting while one runs. Hermetic tests in
 * tests/contractSetup.test.ts. */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

/** Where writeStash writes a replacement before it renames it over `path`.
 * The name keeps the .credentials.json ending the dev server refuses. */
export function nextStashPath(path: string): string {
  return path.replace(/(\.credentials\.json)?$/, '.new.credentials.json')
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
  const next = nextStashPath(path)
  rmSync(next, { force: true })
  writeFileSync(next, JSON.stringify(stash, null, 2), { mode: 0o600, flag: 'wx' })
  renameSync(next, path)
}

/** SQLite's answer when another connection holds the lock. */
const SQLITE_BUSY = 5

/**
 * Takes the lease that lets one contract pass at a time use the stash at
 * `stash`, and returns the function that gives it back. Throws, naming the
 * process that holds it, while another pass on `deployment` runs.
 *
 * The lease is an exclusive SQLite lock on a file beside the stash. The
 * operating system drops it when its process ends, even when the process is
 * killed, so a stash found under the lease belongs to a pass that is gone,
 * and two passes that start together cannot both take it. The lock file is
 * never removed: a pass could otherwise lock a file another pass removed,
 * while a third locks a new one. The holder file only names the process for
 * the refusal.
 *
 * Only SQLite opens an existing lock file. Closing any descriptor of a file
 * drops every lock its process holds on it, so a plain open and close in a
 * process that holds the lease would give the lease away.
 */
export function takeLease(stash: string, deployment: string): () => void {
  const base = stash.replace(/\.credentials\.json$/, '')
  const lock = `${base}.lease`
  const holder = `${base}.lease.json`
  try {
    closeSync(openSync(lock, 'wx', 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const db = new DatabaseSync(lock, { timeout: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if ((error as { errcode?: unknown }).errcode !== SQLITE_BUSY) throw error
    let by = ''
    try {
      const { pid, started } = JSON.parse(readFileSync(holder, 'utf8'))
      by = ` (process ${pid}, started ${started})`
    } catch {}
    throw new Error(
      `contract setup: another contract pass${by} is running against ${deployment}. Let it finish or stop it, then start this pass again.`,
    )
  }
  const started = new Date(performance.timeOrigin).toISOString()
  try {
    writeFileSync(holder, JSON.stringify({ pid: process.pid, started }), { mode: 0o600 })
  } catch (error) {
    db.close()
    throw error
  }
  let held = true
  return () => {
    if (!held) return
    held = false
    try {
      rmSync(holder, { force: true })
    } finally {
      db.close()
    }
  }
}

/** The stash the global setup wrote for this pass. */
export function readStash(): Stash {
  return JSON.parse(readFileSync(stashPath(process.env), 'utf8'))
}
