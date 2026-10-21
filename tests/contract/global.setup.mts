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
 *      machine/auth.ts looks up).
 *   3. Stash them for the suites in the private fixture directory, outside
 *      the checkout (contract/stash.mts). Setup refuses to start without
 *      that directory. Before the reset it revokes the credentials an
 *      interrupted pass left in its stash, or in the stash older passes
 *      kept inside the checkout, and removes that file.
 *   4. Teardown: delete both minted credentials via
 *      machine/testing:deleteCredential — a live qva_ key on a shared
 *      deployment is a standing capability — then remove the stash. A
 *      failed delete keeps the stash, so the next pass revokes the rest. Tolerates already-deleted rows:
 *      mcp.test.mts's finale deletes the qvt token mid-suite to capture the
 *      revoked-token 401 live. A setup that fails after minting runs the
 *      same cleanup before it rethrows, because vitest runs no teardown
 *      then. A teardown failure sets a failing exit code, which vitest
 *      would otherwise only log. */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { marketingId } from '../../convex/internal/marketingDemoData'
import { contractDeployment, contractSiteUrl } from './site.mts'
import { ROOT, type Stash, stashPath, writeStash } from './stash.mts'

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

function mint(
  run: Run,
  kind: Kind,
  who: Record<string, string>,
  name: string,
): { id: string; secret: string } {
  const secret = (kind === 'agent_key' ? 'qva_' : 'qvt_') + randomBytes(24).toString('hex')
  const out = run('machine/testing:mintCredential', {
    ...who,
    kind,
    key_prefix: secret.slice(0, 11),
    key_hash: sha256(secret),
    name,
    // the suites write with the person token; an agent key's role decides
    ...(kind === 'mcp_token' ? { access: 'write' } : {}),
  })
  return { id: out.id as string, secret }
}

/** Whether `site` is a convex.site origin of `deployment`, in any region. */
function siteOf(site: unknown, deployment: string): boolean {
  return (
    typeof site === 'string' &&
    URL.canParse(site) &&
    new URL(site).hostname.split('.')[0] === deployment
  )
}

/**
 * Revokes the credentials named by a stash an interrupted pass left at
 * `path`, when they belong to this pass's deployment, then removes the file.
 * A stash that cannot be read or names another deployment is removed
 * unrevoked, because this key cannot reach that deployment.
 */
function revokeLeftover(path: string, deployment: string, run: Run): void {
  if (!existsSync(path)) return
  let left: Partial<Stash> = {}
  try {
    left = JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  if (siteOf(left.siteUrl, deployment)) {
    const ids = [
      [left.qvaId, 'agent_key'],
      [left.qvtId, 'mcp_token'],
    ] as const
    for (const [id, kind] of ids)
      if (typeof id === 'string') run('machine/testing:deleteCredential', { id, kind })
  } else {
    console.log('[contract] removing a stash from another deployment without revoking it')
  }
  rmSync(path, { force: true })
}

/**
 * The setup with its side effects passed in, so tests can drive it without a
 * deployment. `reset` resets Northstar Labs and `run` runs a Convex function
 * on the deployment the key names. Returns the teardown.
 */
export async function contractSetup(
  { env, run, reset }: { env: Record<string, string | undefined>; run: Run; reset: () => void },
  root = ROOT,
): Promise<() => void> {
  const siteUrl = contractSiteUrl(env, envLocal(root))
  const deployment = contractDeployment(env)
  const stash = stashPath(env, root)
  revokeLeftover(join(root, 'tests', 'contract', '.credentials.json'), deployment, run)
  revokeLeftover(stash, deployment, run)
  console.log(
    `[contract] resetting Northstar Labs on ${siteUrl} (the shared development deployment the key names, where manual work in that organization is lost)`,
  )
  reset()
  const orgId = await marketingId(NORTHSTAR, 'org')

  const minted: { id: string; kind: Kind }[] = []
  // Every delete runs even when an earlier one fails. Both tolerate
  // already-deleted (the mcp finale kills the qvt mid-suite). The stash goes
  // only once both succeed, so the next pass can revoke what remains.
  const teardown = () => {
    const failures: unknown[] = []
    for (const { id, kind } of minted) {
      try {
        run('machine/testing:deleteCredential', { id, kind })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 0) {
      try {
        rmSync(stash, { force: true })
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      process.exitCode = 1
      throw new AggregateError(failures, '[contract] teardown did not finish every step')
    }
    console.log('[contract] minted credentials deleted')
  }

  try {
    const nora = await marketingId(NORTHSTAR, 'person:nora')
    const qvt = mint(run, 'mcp_token', { profile_id: nora }, 'contract pass token')
    minted.push({ id: qvt.id, kind: 'mcp_token' })
    const atlas = await marketingId(NORTHSTAR, 'person:atlas')
    const qva = mint(run, 'agent_key', { profile_id: atlas }, 'contract pass key')
    minted.push({ id: qva.id, kind: 'agent_key' })
    writeStash(stash, {
      siteUrl,
      orgId,
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
