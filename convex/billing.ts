import { v } from 'convex/values'
import { internalQuery } from './_generated/server'
import { billingEnabled, subscriptionFor, subscriptionWritable } from './lib/billingAccess'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { forbidden, orgQuery, require } from './lib/functions'
import { billingSummary, billingUsage } from './model/billing'

// Explicit admin-only query keeps amounts/customer state outside the planner.
export const summary = orgQuery({
  args: {},
  handler: async (ctx) => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await billingSummary(ctx, ctx.me.org_id)
  },
})

// This is fetched on demand. A subscribed usage counter would re-render on
// every API request; callers refresh the report when they want fresh figures.
export const usage = orgQuery({
  args: {},
  handler: async (ctx) => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await billingUsage(ctx, ctx.me.org_id)
  },
})

// Members may see why writes are paused, but never billing terms or IDs.
export const status = orgQuery({
  args: {},
  handler: async (ctx) => {
    const sub = await subscriptionFor(ctx, ctx.me.org_id)
    return {
      enabled: billingEnabled(),
      writable: subscriptionWritable(sub),
      status: sub?.status ?? 'pending',
      complimentary_until: sub?.complimentary_until ?? null,
      current_period_end: sub?.current_period_end ?? null,
    }
  },
})

export const adminContext = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }) => {
    refuseDemoFeature()
    const identity = await ctx.auth.getUserIdentity()
    require(identity, forbidden('not signed in'))
    const me = await ctx.db
      .query('profiles')
      .withIndex('by_org_auth', (q) => q.eq('org_id', org_id).eq('auth_user_id', identity.subject))
      .unique()
    require(me?.active && me.org_role === 'admin', forbidden('admin only'))
    const org = await byId(ctx, 'organizations', org_id)
    require(org, forbidden('organization unavailable'))
    return {
      auth_user_id: identity.subject,
      email: me.email ?? '',
      org_name: org.name,
      org_slug: org.slug,
    }
  },
})
