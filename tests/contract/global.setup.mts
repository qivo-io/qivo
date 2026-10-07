/* globalSetup for the LIVE contract pass (vitest.contract.config.mts).
 *
 * Target: the cloud dev deployment named in .env.local (CONVEX_DEPLOYMENT /
 * VITE_CONVEX_SITE_URL — the site URL var is the VITE_-prefixed one; there is
 * no bare CONVEX_SITE_URL). The deployment is SHARED: this setup RESETS the
 * Northstar Labs development copy — manual work and saved views inside that
 * organization are lost by design; logins, portraits and keys survive — so
 * never run the contract pass while `npm run dev` work or a smoke is in
 * flight.
 *
 * Sequence (cwd = repo root — the CLIs read .env.local themselves, no env
 * plumbing needed; the reset needs the dev-scoped CONVEX_DEPLOY_KEY the
 * browser drives already require, see docs/marketing-demo.md):
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
 *   3. Stash tests/contract/.credentials.json (gitignored) — the tests read
 *      it with fs; no vitest `provide` plumbing (version-proof).
 *   4. Teardown: delete both minted credentials via
 *      machine/testing:deleteCredential — a live qva_ key on a shared
 *      deployment is a standing capability. Tolerates already-deleted rows:
 *      mcp.test.mts's finale deletes the qvt token mid-suite to capture the
 *      revoked-token 401 live. */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketingId } from '../../convex/internal/marketingDemoData'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STASH = resolve(ROOT, 'tests', 'contract', '.credentials.json')
const NORTHSTAR = 'northstar-labs'
const ANCHOR = process.env.CONTRACT_ANCHOR ?? '2026-09-07'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/* `npx convex run` prints the function's return value as (pretty) JSON on
 * stdout, sometimes after CLI chatter — parse the outermost object. */
function convexRun(fn: string, args?: unknown): Record<string, unknown> {
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

function siteUrlFromEnvLocal(): string {
  const env = readFileSync(resolve(ROOT, '.env.local'), 'utf8')
  const m = env.match(/^VITE_CONVEX_SITE_URL=(\S+)\s*$/m)
  if (m === null) throw new Error('contract setup: VITE_CONVEX_SITE_URL not found in .env.local')
  return m[1].replace(/\/$/, '')
}

type Minted = { id: string; secret: string }

function mint(kind: 'agent_key' | 'mcp_token', who: Record<string, string>, name: string): Minted {
  const secret = (kind === 'agent_key' ? 'qva_' : 'qvt_') + randomBytes(24).toString('hex')
  const out = convexRun('machine/testing:mintCredential', {
    ...who,
    kind,
    key_prefix: secret.slice(0, 11),
    key_hash: sha256(secret),
    name,
  })
  return { id: out.id as string, secret }
}

export default async function setup(): Promise<() => void> {
  const siteUrl = siteUrlFromEnvLocal()
  console.log(
    `[contract] resetting Northstar Labs on ${siteUrl} (shared dev deployment — manual work in that organization is lost)`,
  )
  // exits non-zero on any refusal (missing key, wrong deployment, bad anchor);
  // prints paths, never secrets
  execFileSync(
    'node',
    ['scripts/marketing-demo.mjs', 'reset', '--dev', '--anchor', ANCHOR, '--confirm', NORTHSTAR],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
  )
  const orgId = await marketingId(NORTHSTAR, 'org')

  const qvt = mint(
    'mcp_token',
    { profile_id: await marketingId(NORTHSTAR, 'person:nora') },
    'contract pass token',
  )
  const qva = mint(
    'agent_key',
    { profile_id: await marketingId(NORTHSTAR, 'person:atlas') },
    'contract pass key',
  )

  writeFileSync(
    STASH,
    JSON.stringify(
      { siteUrl, orgId, qva: qva.secret, qvt: qvt.secret, qvaId: qva.id, qvtId: qvt.id },
      null,
      2,
    ),
  )

  return () => {
    // both tolerate already-deleted (the mcp finale kills the qvt mid-suite)
    convexRun('machine/testing:deleteCredential', { id: qva.id, kind: 'agent_key' })
    convexRun('machine/testing:deleteCredential', { id: qvt.id, kind: 'mcp_token' })
    console.log('[contract] minted credentials deleted')
  }
}
