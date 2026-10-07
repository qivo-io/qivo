/* Anonymous demo startup and lifecycle. Only the auth component creates an
 * ownership receipt. Neither public browser function accepts an owner or
 * tenant identifier, and provisioning never resets an existing copy. */
import { v } from 'convex/values'
import { components, internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { authComponent } from './auth'
import { byId } from './lib/db'
import {
  demoAdmissionOpen,
  demoForAuth,
  demoRefusal,
  isDemoDeployment,
  requireActiveDemo,
  requireDemoDeployment,
} from './lib/demo'
import { demoBootstrapMutation, demoConfigurationQuery, demoLifecycleQuery } from './lib/functions'
import { recordDemoCreated } from './model/demoMetrics'
import { provisionPublicDemo } from './model/demoSeed'

export const { onCreate, onDelete } = authComponent.triggersApi()

export type DemoCurrent = {
  mode: 'demo'
  status: 'unprovisioned' | 'ready' | 'deleting' | 'expired' | 'missing'
  expiresAt: number | null
  orgId: string | null
  orgSlug: string | null
  serverNow: number
}

async function publicReceipt(
  ctx: QueryCtx,
  receipt: Doc<'demo_sessions'> | null,
): Promise<DemoCurrent> {
  const now = Date.now()
  const status = !receipt ? 'missing' : receipt.expires_at <= now ? 'expired' : receipt.status
  const org =
    status === 'ready' && receipt?.org_id ? await byId(ctx, 'organizations', receipt.org_id) : null
  return {
    mode: 'demo',
    status,
    expiresAt: receipt?.expires_at ?? null,
    orgId: org?.id ?? null,
    orgSlug: org?.slug ?? null,
    serverNow: now,
  }
}

export const configuration = demoConfigurationQuery({
  args: {},
  handler: async (): Promise<{ mode: 'demo' | 'normal'; admissionOpen: boolean }> => {
    if (isDemoDeployment()) requireDemoDeployment()
    return { mode: isDemoDeployment() ? 'demo' : 'normal', admissionOpen: demoAdmissionOpen() }
  },
})

export const current = demoLifecycleQuery({
  args: {},
  handler: async (ctx): Promise<DemoCurrent> =>
    publicReceipt(ctx, await demoForAuth(ctx, ctx.authUserId)),
})

export const ensureMine = demoBootstrapMutation({
  args: {},
  handler: async (ctx): Promise<DemoCurrent> => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user?.isAnonymous)
      throw demoRefusal('A temporary demo login is required.', 'demo_unavailable')
    const receipt = await requireActiveDemo(ctx, ctx.authUserId, { ready: false })
    if (receipt.status === 'ready') {
      const org = receipt.org_id ? await byId(ctx, 'organizations', receipt.org_id) : null
      if (!org) throw demoRefusal()
      await recordDemoCreated(ctx, receipt._id)
      return publicReceipt(ctx, receipt)
    }
    const seeded = await provisionPublicDemo(ctx, receipt, { _id: user._id, email: user.email })
    await ctx.db.patch(receipt._id, { ...seeded, status: 'ready' })
    await recordDemoCreated(ctx, receipt._id, Date.now())
    return publicReceipt(ctx, { ...receipt, ...seeded, status: 'ready' })
  },
})

/** Auth HTTP token creation cannot access ctx.db; this query supplies only
 * the already-created receipt's deadline to the server's JWT callback. */
export const tokenDeadline = internalQuery({
  args: { auth_user_id: v.string() },
  handler: async (ctx, { auth_user_id }): Promise<number> =>
    (await requireActiveDemo(ctx, auth_user_id, { ready: false })).expires_at,
})

export const expire = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<void> => {
    const receipt = await ctx.db
      .query('demo_sessions')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (!receipt) return
    if (receipt.status !== 'deleting' && receipt.expires_at > Date.now()) return
    await ctx.db.patch(receipt._id, { status: 'deleting', cleanup_progress_at: Date.now() })
    // Anonymous visitors have no way to create secondary sessions. Remove a
    // bounded page immediately; the resumable purge drains any remainder.
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: 'session', where: [{ field: 'userId', value: receipt.auth_user_id }] },
      paginationOpts: { numItems: 100, cursor: null },
    })
    const cleanup_scheduled_id = await ctx.scheduler.runAfter(
      0,
      internal.internal.demoCleanup.purge,
      { demo_id: receipt.id },
    )
    await ctx.db.patch(receipt._id, { cleanup_scheduled_id })
  },
})
