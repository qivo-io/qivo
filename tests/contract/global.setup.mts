/* globalSetup for the LIVE contract pass (vitest.contract.config.mts).
 *
 * Run it under the private with-dev helper (qivo-internal
 * docs/verification.md), which exports the development CONVEX_DEPLOY_KEY,
 * QIVO_ENVIRONMENT=development and QIVO_FIXTURE_CREDENTIALS_DIR along with
 * its runtime file's values. The key chooses the target: the reset and every
 * `npx convex run` below reach the deployment it names, whatever .env.local
 * links. The suites call VITE_CONVEX_SITE_URL, from the environment or else
 * from .env.local, and the setup refuses to start unless that site belongs
 * to the key's deployment (contract/site.mts). The deployment is SHARED:
 * this setup RESETS the Northstar Labs development copy — manual work and
 * saved views inside that organization are lost by design; logins, portraits
 * and keys survive — so never run the contract pass while `npm run dev` work
 * or a smoke is in flight.
 *
 * Sequence (cwd = repo root; marketing-demo.mjs also loads .env.local, but
 * the values with-dev exports take precedence):
 *   1. `node scripts/marketing-demo.mjs reset --dev --anchor <ANCHOR>
 *      --confirm northstar-labs` — the same command a person runs. It
 *      provisions the organization when absent, then wipes and seeds its
 *      work in two transactions (a failed seed exits non-zero and can
 *      leave the demo empty; the next pass's reset refills it); contract
 *      asserts about seeded shapes are only valid immediately after. ANCHOR
 *      is the production scenario's Monday (docs/marketing-demo.md) so a
 *      pass never moves the dates local screenshots are matched against;
 *      CONTRACT_ANCHOR overrides it.
 *   2. Mint one qvt_ person token (Nora) and one qva_ agent key (Atlas), both
 *      resolved by their deterministic profile ids (marketingId) — a name
 *      lookup would be ambiguous once any other organization on the
 *      deployment has an Atlas. Secrets are generated locally; only the
 *      sha256 crosses the wire (machine/testing.ts, the same hash contract
 *      machine/auth.ts looks up). Each credential's name carries a random
 *      pass id, so the pass can delete what it minted by name even when it
 *      never learned a row's id, for example after a mint whose output could
 *      not be parsed. A minted credential is pending, so machine/auth
 *      finds no row for its secret, until the pass activates both by name
 *      after both mints. Activation skips a credential that anyone revoked
 *      while it was pending, its owner or an organization admin alike.
 *      When only the vitest process is killed, its running `npx convex run`
 *      child goes on and can finish after the next pass has revoked the
 *      killed pass's names. The pass runs one call at a time and activates
 *      only after both mints returned, so that child is a late mint, which
 *      leaves a pending row, or a late activation, which finds nothing. No
 *      credential of a killed pass becomes usable after its revocation.
 *      Keep that order: a mint and an activation that could both run late
 *      would make a usable credential again.
 *   3. Stash them for the suites in the private fixture directory, outside
 *      the checkout (contract/stash.mts). Setup refuses to start without
 *      that directory, and while another pass on the same deployment holds
 *      the lease beside the stash (only passes on this machine that use the
 *      same fixture directory share it). The pass holds that lease until its
 *      teardown ends, and the operating system drops it when the pass is
 *      killed. The pass id is stashed before the first mint. Before the
 *      reset it revokes the credentials an interrupted pass left in its
 *      stash, or in the stash older passes kept inside the checkout: by
 *      name when the stash holds a pass id, and by id for every id it
 *      holds. Then it removes that file. It also deletes every pass
 *      credential created more than an hour ago: the pending rows of late
 *      mints, and credentials of passes that no stash names any more. That
 *      sweep runs before the reset and fails on a deployment that does not
 *      mint pending credentials, so such a deployment gets no reset and no
 *      credential.
 *   4. Teardown: delete every credential named for the pass via
 *      machine/testing:deleteNamedCredentials — a live qva_ key on a shared
 *      deployment is a standing capability — then remove the stash. A
 *      failed delete keeps the stash, so the next pass revokes the rest.
 *      Tolerates already-deleted rows: mcp.test.mts's finale deletes the qvt
 *      token mid-suite to capture the revoked-token 401 live. A setup that
 *      fails runs the same cleanup before it rethrows, because vitest runs
 *      no teardown then. A teardown failure sets a failing exit code, which
 *      vitest would otherwise only log. */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { marketingId } from '../../convex/internal/marketingDemoData'
import { contractDeployment, contractSiteUrl } from './site.mts'
import { nextStashPath, ROOT, type Stash, stashPath, takeLease, writeStash } from './stash.mts'

const NORTHSTAR = 'northstar-labs'
const ANCHOR = process.env.CONTRACT_ANCHOR ?? '2026-09-07'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

type Run = (fn: string, args?: unknown) => Record<string, unknown>

/* `npx convex run` prints the function's return value as (pretty) JSON on
 * stdout, sometimes after CLI chatter — parse the outermost object. */
const convexRun: Run = (fn, args) => {
  const argv = ['convex', 'run', fn]
  if (args !== undefined) argv.push(JSON.stringify(args))
  const out = execFileSync('npx', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error(`convex run ${fn}: no JSON on stdout:\n${out}`)
  return JSON.parse(out.slice(start, end + 1)) as Record<string, unknown>
}

/** The .env.local text, or undefined when the checkout has none. */
function envLocal(root: string): string | undefined {
  const file = join(root, '.env.local')
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

type Kind = 'agent_key' | 'mcp_token'

/** The profile and name of one credential a pass mints. */
type Named = { profile_id: string; name: string }

/**
 * The profile and the start of the name of every credential a pass mints,
 * by kind: Nora's personal token and Atlas's agent key. Passes before the
 * pass id used these names alone.
 */
async function passPrefixes(): Promise<Record<Kind, Named>> {
  return {
    mcp_token: {
      profile_id: await marketingId(NORTHSTAR, 'person:nora'),
      name: 'contract pass token',
    },
    agent_key: {
      profile_id: await marketingId(NORTHSTAR, 'person:atlas'),
      name: 'contract pass key',
    },
  }
}

/** The credentials pass `pass` mints, by kind, each named after the pass. */
async function passCredentials(pass: string): Promise<Record<Kind, Named>> {
  const { mcp_token, agent_key } = await passPrefixes()
  return {
    mcp_token: { ...mcp_token, name: `${mcp_token.name} ${pass}` },
    agent_key: { ...agent_key, name: `${agent_key.name} ${pass}` },
  }
}

/** How old a pass credential gets before any later pass deletes it. A pass
 * takes minutes, so the sweep leaves a pass running elsewhere alone. */
const STALE_MS = 60 * 60 * 1000

/** Mints the `kind` credential `named` describes. Throws unless the output
 * names the new row's id. */
function mint(run: Run, kind: Kind, { profile_id, name }: Named): { id: string; secret: string } {
  const secret = (kind === 'agent_key' ? 'qva_' : 'qvt_') + randomBytes(24).toString('hex')
  const out = run('machine/testing:mintCredential', {
    profile_id,
    kind,
    key_prefix: secret.slice(0, 11),
    key_hash: sha256(secret),
    name,
    pending: true,
    // the suites write with the person token; an agent key's role decides
    ...(kind === 'mcp_token' ? { access: 'write' } : {}),
  })
  if (typeof out.id !== 'string')
    throw new Error('convex run machine/testing:mintCredential: no credential id in its output')
  return { id: out.id, secret }
}

/** Makes the pending credential `named` describes usable. Throws unless
 * exactly one row was pending. */
function activate(run: Run, named: Named): void {
  const out = run('machine/testing:activateNamedCredentials', named)
  if (out.activated !== 1)
    throw new Error(
      `convex run machine/testing:activateNamedCredentials: activated ${String(out.activated)} credentials of ${named.name}, not 1`,
    )
}

/**
 * Deletes every pass credential created more than STALE_MS ago, and returns
 * how many rows went. The deployment answers only when it has
 * machine/testing:deleteOldCredentials, which shipped with pending mints.
 */
async function deleteStale(run: Run): Promise<number> {
  const created_before = new Date(Date.now() - STALE_MS).toISOString()
  let deleted = 0
  for (const { profile_id, name } of Object.values(await passPrefixes())) {
    const out = run('machine/testing:deleteOldCredentials', {
      profile_id,
      name_prefix: name,
      created_before,
    })
    if (typeof out.deleted !== 'number')
      throw new Error('convex run machine/testing:deleteOldCredentials: no count in its output')
    deleted += out.deleted
  }
  return deleted
}

/** Deletes the credentials `named` describes and returns how many rows went. */
function deleteNamed(run: Run, named: Named): number {
  const out = run('machine/testing:deleteNamedCredentials', named)
  if (typeof out.deleted !== 'number')
    throw new Error('convex run machine/testing:deleteNamedCredentials: no count in its output')
  return out.deleted
}

/** Whether `site` is a convex.site origin of `deployment`, in any region. */
function siteOf(site: unknown, deployment: string): boolean {
  return (
    typeof site === 'string' &&
    URL.canParse(site) &&
    new URL(site).hostname.split('.')[0] === deployment
  )
}

/** The form of the random id every pass names its credentials after. */
const PASS_ID = /^[0-9a-f]{16}$/

/**
 * Revokes the credentials named by a stash an interrupted pass left at
 * `path`, when they belong to this pass's deployment, then removes the file
 * and any replacement a failed write left beside it. A stash with a pass id
 * is revoked by name, which also covers a credential whose id the pass never
 * saved, and every id it holds is revoked as well. A stash that cannot be
 * read or names another deployment is removed unrevoked, because this key
 * cannot reach that deployment.
 */
async function revokeLeftover(path: string, deployment: string, run: Run): Promise<void> {
  if (!existsSync(path)) return
  let left: Partial<Stash> | null = null
  try {
    left = JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  if (!siteOf(left?.siteUrl, deployment)) {
    console.log('[contract] removing a stash from another deployment without revoking it')
  } else {
    if (typeof left?.pass === 'string' && PASS_ID.test(left.pass))
      for (const named of Object.values(await passCredentials(left.pass))) deleteNamed(run, named)
    const ids = [
      [left?.qvaId, 'agent_key'],
      [left?.qvtId, 'mcp_token'],
    ] as const
    for (const [id, kind] of ids)
      if (typeof id === 'string') run('machine/testing:deleteCredential', { id, kind })
  }
  rmSync(path, { force: true })
  rmSync(nextStashPath(path), { force: true, recursive: true })
}

type Effects = { run: Run; reset: () => void }

/**
 * The setup with its side effects passed in, so tests can drive it without a
 * deployment. `reset` resets Northstar Labs and `run` runs a Convex function
 * on the deployment the key names. Returns the teardown.
 *
 * The pass holds the deployment's lease from before it revokes a leftover
 * stash until its teardown ends, so it never revokes the credentials of a
 * running pass that shares its fixture directory. A setup that fails gives
 * the lease back.
 */
export async function contractSetup(
  { env, run, reset }: Effects & { env: Record<string, string | undefined> },
  root = ROOT,
): Promise<() => void> {
  const siteUrl = contractSiteUrl(env, envLocal(root))
  const deployment = contractDeployment(env)
  const stash = stashPath(env, root)
  const release = takeLease(stash, deployment)
  let teardown: () => void
  try {
    teardown = await leasedSetup({ run, reset }, { siteUrl, deployment, stash }, root)
  } catch (error) {
    release()
    throw error
  }
  return () => {
    try {
      teardown()
    } finally {
      release()
    }
  }
}

/** The setup that runs under the lease. Returns the teardown. */
async function leasedSetup(
  { run, reset }: Effects,
  { siteUrl, deployment, stash }: { siteUrl: string; deployment: string; stash: string },
  root: string,
): Promise<() => void> {
  await revokeLeftover(join(root, 'tests', 'contract', '.credentials.json'), deployment, run)
  await revokeLeftover(stash, deployment, run)
  const stale = await deleteStale(run)
  if (stale > 0) console.log(`[contract] deleted ${stale} pass credentials older than an hour`)
  console.log(
    `[contract] resetting Northstar Labs on ${siteUrl} (the shared development deployment the key names, where manual work in that organization is lost)`,
  )
  reset()
  const orgId = await marketingId(NORTHSTAR, 'org')
  const pass = randomBytes(8).toString('hex')
  const credentials = await passCredentials(pass)

  // The credentials this pass has tried to mint. A mint can succeed on the
  // server even when its output cannot be read, so each is deleted by name.
  const minting: Named[] = []
  // Every delete runs even when an earlier one fails. Both tolerate
  // already-deleted (the mcp finale kills the qvt mid-suite). The stash goes
  // only once both succeed, so the next pass can revoke what remains.
  const teardown = () => {
    const failures: unknown[] = []
    let deleted = 0
    for (const named of minting) {
      try {
        deleted += deleteNamed(run, named)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 0) {
      // the stash, and a replacement that a failed write left behind
      const removals = [
        () => rmSync(stash, { force: true }),
        () => rmSync(nextStashPath(stash), { force: true, recursive: true }),
      ]
      for (const remove of removals) {
        try {
          remove()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    if (failures.length > 0) {
      process.exitCode = 1
      throw new AggregateError(failures, '[contract] teardown did not finish every step')
    }
    const rest = deleted < minting.length ? '; the rest were never created or already deleted' : ''
    console.log(
      minting.length === 0
        ? '[contract] the pass minted no credentials, so there was nothing to delete'
        : `[contract] deleted ${deleted} of the ${minting.length} credentials the pass tried to mint${rest}`,
    )
  }

  try {
    writeStash(stash, { siteUrl, orgId, pass })
    minting.push(credentials.mcp_token)
    const qvt = mint(run, 'mcp_token', credentials.mcp_token)
    minting.push(credentials.agent_key)
    const qva = mint(run, 'agent_key', credentials.agent_key)
    activate(run, credentials.mcp_token)
    activate(run, credentials.agent_key)
    writeStash(stash, {
      siteUrl,
      orgId,
      pass,
      qva: qva.secret,
      qvt: qvt.secret,
      qvaId: qva.id,
      qvtId: qvt.id,
    })
  } catch (error) {
    // vitest runs no teardown for a failed setup
    try {
      teardown()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], '[contract] setup failed')
    }
    throw error
  }
  return teardown
}

export default function setup(): Promise<() => void> {
  return contractSetup({
    env: process.env,
    run: convexRun,
    // exits non-zero on any refusal (missing key, wrong deployment, bad
    // anchor); prints paths, never secrets
    reset: () =>
      execFileSync(
        'node',
        [
          'scripts/marketing-demo.mjs',
          'reset',
          '--dev',
          '--anchor',
          ANCHOR,
          '--confirm',
          NORTHSTAR,
        ],
        { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
      ),
  })
}
