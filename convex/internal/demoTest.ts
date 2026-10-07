/* Internal controls for the isolated localhost demo smoke drive. Neither a
 * public argument nor the production demo configuration can enable these. */
import { v } from 'convex/values'
import { components, internal } from '../_generated/api'
import { internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { demoForAuth, demoRefusal, requireDemoDeployment } from '../lib/demo'

function requireTestControls(expectedSiteUrl: string): void {
  requireDemoDeployment()
  const deployment = process.env.CONVEX_DEPLOYMENT
  if (
    process.env.DEMO_TEST_CONTROLS !== 'true' ||
    process.env.SITE_URL !== expectedSiteUrl ||
    !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(expectedSiteUrl) ||
    (deployment !== undefined && !deployment.startsWith('dev:'))
  )
    throw demoRefusal(
      'Demo test controls require an explicitly enabled localhost development deployment.',
      'demo_unavailable',
    )
}

export const inspect = internalQuery({
  args: { auth_user_id: v.string(), org_id: v.optional(v.string()), expected_site_url: v.string() },
  handler: async (ctx, { auth_user_id, org_id, expected_site_url }) => {
    requireTestControls(expected_site_url)
    const receipt = auth_user_id ? await demoForAuth(ctx, auth_user_id) : null
    const user = auth_user_id
      ? await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'user',
          where: [{ field: '_id', value: auth_user_id }],
        })
      : null
    const orgId = receipt?.org_id ?? org_id ?? null
    const org = orgId ? await byId(ctx, 'organizations', orgId) : null
    return {
      mode: 'demo' as const,
      testControls: true,
      authExists: user !== null,
      demoId: receipt?.id ?? null,
      status: receipt?.status ?? null,
      expiresAt: receipt?.expires_at ?? null,
      orgId,
      orgExists: org !== null,
    }
  },
})

export const expireOwned = internalMutation({
  args: { auth_user_id: v.string(), expected_site_url: v.string(), delay_ms: v.number() },
  handler: async (
    ctx,
    { auth_user_id, expected_site_url, delay_ms },
  ): Promise<{ expiresAt: number }> => {
    requireTestControls(expected_site_url)
    if (!Number.isInteger(delay_ms) || delay_ms < 1_000 || delay_ms > 30_000)
      throw demoRefusal(
        'The test expiration delay must be between 1000 and 30000 milliseconds.',
        'demo_unavailable',
      )
    const receipt = await demoForAuth(ctx, auth_user_id)
    if (!receipt || receipt.status === 'deleting') throw demoRefusal()
    const expiresAt = Math.min(receipt.expires_at, Date.now() + delay_ms)
    const sessions = await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'session',
      where: [{ field: 'userId', value: auth_user_id }],
      paginationOpts: { cursor: null, numItems: 100 },
    })
    if (!sessions.isDone)
      throw demoRefusal('Unexpected session count in the demo test fixture.', 'demo_unavailable')
    for (const session of sessions.page)
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'session',
          where: [{ field: '_id', value: session._id as string }],
          update: { expiresAt: Math.min(Number(session.expiresAt), expiresAt) },
        },
      })
    if (receipt.expiry_scheduled_id) await ctx.scheduler.cancel(receipt.expiry_scheduled_id)
    const expiry_scheduled_id = await ctx.scheduler.runAt(expiresAt, internal.demo.expire, {
      id: receipt.id,
    })
    await ctx.db.patch(receipt._id, { expires_at: expiresAt, expiry_scheduled_id })
    return { expiresAt }
  },
})
