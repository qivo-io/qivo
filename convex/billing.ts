import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalQuery } from './_generated/server'
import {
  assertOrgAvailable,
  billingEnabled,
  orgRemovalFor,
  subscriptionFor,
  subscriptionWritable,
} from './lib/billingAccess'
import type { BillingUsage } from './lib/billingTypes'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { forbidden, orgAction, orgQuery, require } from './lib/functions'
import {
  billingSummary,
  billingUsageHead,
  type StoragePage,
  type StorageProject,
  storagePage,
} from './model/billing'
import { checkoutDeadline } from './model/orgRetention'

// Explicit admin-only query keeps amounts/customer state outside the planner.
export const summary = orgQuery({
  args: {},
  handler: async (ctx) => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await billingSummary(ctx, ctx.me.org_id)
  },
})

/** The usage report's figures other than storage. */
export const usageHead = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }) => await billingUsageHead(ctx, org_id),
})

/** One page of the organization's stored bytes as they are now. */
export const storageNowPage = internalQuery({
  args: {
    org_id: v.string(),
    cursor: v.union(v.string(), v.null()),
    size: v.optional(v.number()),
  },
  handler: async (ctx, { org_id, cursor, size }): Promise<StoragePage> =>
    await storagePage(ctx, org_id, { cursor, size, before: Number.MAX_SAFE_INTEGER }),
})

/** The admin Billing page's usage report (model/billing.ts
 * billingUsageHead). Its storage is counted page by page, as a period's
 * storage sample counts it (storagePage), so no transaction reads all the
 * organization's attachment rows. Each page is its own snapshot, so a file
 * stored or removed while the report runs may count or not. It is fetched
 * on demand. A subscribed usage counter would re-render on every API
 * request, so callers refresh the report when they want fresh figures. */
export const usageReport = orgAction({
  args: {},
  handler: async (ctx): Promise<BillingUsage> => {
    const org_id = ctx.orgId
    const head = await ctx.runQuery(internal.billing.usageHead, { org_id })
    const projects = new Map<string, StorageProject>()
    let bytes = 0
    let cursor: string | null = null
    let size: number | undefined
    for (;;) {
      const page: StoragePage = await ctx.runQuery(internal.billing.storageNowPage, {
        org_id,
        cursor,
        size,
      })
      if ('split' in page) {
        size = page.split
        continue
      }
      bytes += page.bytes
      for (const counted of page.projects) {
        const total = projects.get(counted.project_id)
        if (total === undefined) projects.set(counted.project_id, { ...counted })
        else total.storage_bytes += counted.storage_bytes
      }
      if (page.next === null) break
      cursor = page.next
      size = undefined
    }
    return {
      ...head,
      storage_bytes: bytes,
      projects: [...projects.values()]
        .filter((p) => p.storage_bytes > 0)
        .sort((a, b) => b.storage_bytes - a.storage_bytes),
    }
  },
})

/** Why writes are paused and when a read-only organization will be
 * deleted, for every member. Billing terms and IDs stay admin-only. */
export const status = orgQuery({
  args: {},
  handler: async (ctx) => {
    const sub = await subscriptionFor(ctx, ctx.me.org_id)
    const removal = await orgRemovalFor(ctx, ctx.me.org_id)
    return {
      enabled: billingEnabled(),
      writable: subscriptionWritable(sub) && !removal,
      status: sub?.status ?? 'pending',
      complimentary_until: sub?.complimentary_until ?? null,
      current_period_end: sub?.current_period_end ?? null,
      checkout_due_at: checkoutDeadline(sub),
      deletion: removal ? { reason: removal.reason, delete_after: removal.delete_after } : null,
    }
  },
})

/** The signed-in admin and organization an orgAction acts for. Refuses
 * anyone else, the demo and an organization whose deletion has begun. */
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
    await assertOrgAvailable(ctx, org_id)
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
