/* Vercel previews seed themselves with Northstar Labs — vercel.json runs
 * `npx convex deploy … --preview-run 'internal/previewSeed:seed'` on every
 * push of a branch. A preview has no private credentials file, so its seven
 * Northstar logins share the one documented fixture password (qivo-demo),
 * exactly like the operator login this action also ensures.
 *
 * Boundaries, in the order they are checked:
 *   · never production (lib/deployment: a SITE_URL ending in qivo.io);
 *   · only a Vercel preview origin — a fixed-password Northstar on a
 *     development deployment would collide with the CLI's private credential
 *     set (scripts/marketing-demo.mjs, scripts/browser-demo.mjs);
 *   · never a Northstar the CLI provisioned: the receipt's credential set
 *     must be this action's fixed one, or the run refuses before touching it.
 *
 * Idempotent across pushes: a ready receipt with the current UTC Monday and
 * the current dataset version is a documented no-op (manual edits on the
 * preview survive). Every other push resets the work, the teardown-first
 * parity the old preview seed had: a stale anchor, a dataset bump, a new
 * preview, or one a failed seed left empty. The reset is two transactions, a
 * wipe and then a seed (internal/marketingDemo:apply). A failed seed leaves
 * the preview as the wipe left it, and the next push resets it again, even
 * if someone added work to the empty preview meanwhile. Portraits come from
 * the bundled samples (profiles.sample_avatar); nothing is uploaded. */

import { hashPassword } from 'better-auth/crypto'
import { internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import { internalAction } from '../_generated/server'
import { authComponent, createAuth } from '../auth'
import { isPreviewOrigin, refuseProduction } from '../lib/deployment'
import { demoMonday } from '../model/demoSeed'
import { MARKETING_DEMO, MARKETING_DEMO_VERSION } from './marketingDemoData'
import { ensureOperator, FIXTURE_PASSWORD } from './operator'

/* Fixed on purpose: the CLI mints a random v4 uuid per credentials file, so a
 * CLI-provisioned receipt can never carry this id — and vice versa. */
export const PREVIEW_CREDENTIAL_SET_ID = '00000000-0000-4000-8000-000000000000'

export type PreviewSeedResult = {
  site_url: string
  org_id: string
  state: 'absent' | 'empty' | 'ready'
  anchor?: string
  // 'reset' ran a wipe and then a seed; 'seed' found the preview ready and
  // current, so its seed call was the documented no-op
  mode: 'seed' | 'reset'
  operator_auth_id: string
  counts: { projects: number; subprojects: number; tasks: number; users: number; avatars: number }
}

async function run(ctx: ActionCtx): Promise<PreviewSeedResult> {
  refuseProduction('previewSeed')
  const site = process.env.SITE_URL
  if (site === undefined || !isPreviewOrigin(site)) {
    throw new Error(
      'previewSeed: SITE_URL is not a Vercel preview origin — this seed runs only under --preview-run',
    )
  }
  const { auth } = await authComponent.getAuth(createAuth, ctx)
  const operator_auth_id = await ensureOperator(ctx, auth)

  const target = { expected_site_url: site }
  let state = await ctx.runQuery(internal.internal.marketingDemo.inspect, target)
  if (state.state === 'absent') {
    // one scrypt, shared: the seven logins carry one documented password, so
    // a per-account salt buys nothing and keeps the hermetic test affordable
    const hash = await hashPassword(FIXTURE_PASSWORD)
    const humans = MARKETING_DEMO.people.filter((p) => p.kind === 'person')
    state = await ctx.runMutation(internal.internal.marketingDemo.provision, {
      ...target,
      credential_set_id: PREVIEW_CREDENTIAL_SET_ID,
      password_hashes: Object.fromEntries(humans.map((p) => [p.key, hash])),
      sample_avatars: true,
    })
  } else if (state.credential_set_id !== PREVIEW_CREDENTIAL_SET_ID) {
    throw new Error(
      'previewSeed: this Northstar Labs was provisioned by the CLI with private passwords — refusing to touch it',
    )
  }

  const anchor = demoMonday(Date.now())
  const current =
    state.state === 'ready' &&
    'anchor' in state &&
    state.anchor === anchor &&
    state.version === MARKETING_DEMO_VERSION
  // Wipe unless ready and current, an empty receipt included: a seed alone
  // refuses work added to an empty preview, which would fail every push.
  const mode = current ? 'seed' : 'reset'
  // separate runMutation calls, so the wipe commits before the seed starts
  if (mode === 'reset') {
    await ctx.runMutation(internal.internal.marketingDemo.apply, {
      ...target,
      anchor,
      mode: 'wipe',
    })
  }
  const result = await ctx.runMutation(internal.internal.marketingDemo.apply, {
    ...target,
    anchor,
    mode: 'seed',
  })
  return {
    site_url: site,
    org_id: result.org_id,
    state: result.state,
    anchor: 'anchor' in result ? result.anchor : undefined,
    mode,
    operator_auth_id,
    counts: result.counts,
  }
}

export const seed = internalAction({
  args: {},
  handler: (ctx): Promise<PreviewSeedResult> => run(ctx),
})
