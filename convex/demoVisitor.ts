import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { demoForAuth, requireDemoDeployment } from './lib/demo'
import { DEMO_VISITOR_BROWSERS, DEMO_VISITOR_SYSTEMS } from './lib/demoVisitor'

/** Called only from the anonymous auth HTTP response, before the client can
 * provision. Attribution is fixed once and never changes a counted receipt. */
export const record = internalMutation({
  args: { auth_user_id: v.string(), browser: v.string(), os: v.string(), country: v.string() },
  handler: async (ctx, args): Promise<void> => {
    requireDemoDeployment()
    const receipt = await demoForAuth(ctx, args.auth_user_id)
    if (
      receipt?.status !== 'unprovisioned' ||
      receipt.expires_at <= Date.now() ||
      receipt.metrics_counted_at !== undefined ||
      receipt.visitor_browser !== undefined
    )
      return
    await ctx.db.patch(receipt._id, {
      visitor_browser: DEMO_VISITOR_BROWSERS.find((label) => label === args.browser) ?? 'Unknown',
      visitor_os: DEMO_VISITOR_SYSTEMS.find((label) => label === args.os) ?? 'Unknown',
      visitor_country: /^[A-Z]{2}$/.test(args.country) ? args.country : 'ZZ',
    })
  },
})
