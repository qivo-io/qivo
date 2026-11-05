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
import type { BillingUsage, BillingUsageReport, StorageProjects } from './lib/billingTypes'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { forbidden, orgAction, orgQuery, require } from './lib/functions'
import {
  billingSummary,
  billingUsageHead,
  currentUsageOf,
  type StoragePage,
  type StorageProject,
  storagePage,
} from './model/billing'
import { storageProjectsBatch } from './model/billingStorage'
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

/**
 * Billing's usage for an organization admin: the period's API calls with
 * each account's total and the allowances (model/billing.ts
 * billingUsageHead), current storage and the period's storage sample
 * (currentUsageOf). Refused in the demo, to anyone but an admin with an
 * active seat, and while the organization's deletion runs (orgQuery's
 * loadMember).
 *
 * The app reads it once on opening Billing and on each Refresh
 * (convex.query) and never subscribes to it, because API usage changes
 * with every machine call. Current storage is the organization's
 * stored-byte totals, files in Deleted items included until they are
 * deleted for good, or null while the totals are not complete, never 0.
 * The sample is what the current paid period's storage charge uses, which
 * leaves files in Deleted items out, and null for any other bucket or
 * while the sample has not finished.
 *
 * It picks the bucket by the clock when it runs (usagePeriod). Convex can
 * answer a read from its cache of an identical earlier one while nothing
 * it read changed, and drops cached answers of a query that reads the
 * clock often so they do not grow old, so just after a period or month
 * boundary a read can answer the bucket before it for a short while, as
 * apiAccess.summary can. It reads the head's rows, the roster
 * (usageAllowance) and one profile per account with usage, and two single
 * reads, the totals row and the period row. At 1,000 people with 15
 * accounts of usage over 30 usage rows it read 1,047 documents, 22 index
 * ranges and about 384 KB in convex/tests/billingStorage.test.ts ("reads
 * at the design size"), without the caller's seat check.
 */
export const currentUsage = orgQuery({
  args: {},
  handler: async (ctx): Promise<BillingUsage> => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await currentUsageOf(ctx, ctx.me.org_id)
  },
})

/**
 * One batch of Billing's Storage by project list for an organization
 * admin (model/billingStorage.ts storageProjectsBatch): at most LIST_BATCH
 * of the organization's projects with counted task files, largest first,
 * equal bytes newest row first, whether active, archived, in Deleted items
 * or removed, each with its number, key, name, bytes and file count.
 * `search` keeps the projects whose name holds every whitespace-separated
 * fragment of it, ignoring case and accents, over the whole list, and
 * `cursor` is an earlier batch's `next` for the same search. Refused in
 * the demo, to anyone but an admin with an active seat, and while the
 * organization's deletion runs; a search past LIMITS.search and a cursor
 * of another list, organization or search are refused too. Answers
 * `counting` while the organization's totals are not complete, never a
 * partial list.
 *
 * Bytes change while an admin browses, and nothing freezes a snapshot (the
 * owner, 31 October 2026), so a project whose bytes cross the cursor
 * between two batches can be missed until the list starts again, or
 * answered twice, which the app shows once. A batch reads at most
 * STORAGE_PROJECTS.reads and answers `stopped` where that ended it, with a
 * `next` that goes on. It reads no task, file, comment or person. The app
 * reads each batch once (convex.query) and never subscribes to it.
 */
export const storageProjects = orgQuery({
  args: { search: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<StorageProjects> => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await storageProjectsBatch(ctx, ctx.me.org_id, a)
  },
})

/** The legacy usage report's figures other than storage. */
export const usageHead = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }) => await billingUsageHead(ctx, org_id),
})

/** One page of the organization's stored bytes as the legacy usage report
 * counts them now. */
export const storageNowPage = internalQuery({
  args: {
    org_id: v.string(),
    cursor: v.union(v.string(), v.null()),
    size: v.optional(v.number()),
  },
  handler: async (ctx, { org_id, cursor, size }): Promise<StoragePage> =>
    await storagePage(ctx, org_id, { cursor, size, before: Number.MAX_SAFE_INTEGER }),
})

/**
 * @deprecated The app reads billing.currentUsage and billing.storageProjects
 * since the release after v0.1.130. This report stays, with its scan and its
 * answer, through that release, so tabs and desktop windows loaded before it
 * still load Billing, and a later release removes it with usageHead,
 * storageNowPage and the scan and adds it to the Instant Rollback list in
 * docs/deployment.md.
 *
 * The usage report that Billing read before then (model/billing.ts
 * billingUsageHead). Its storage is counted page by page, as a period's
 * storage sample counts it (storagePage), so no transaction reads all the
 * organization's attachment rows, and it leaves files in Deleted items
 * out. Each page is its own snapshot, so a file stored or removed while the
 * report runs may count or not. It is fetched on demand.
 */
export const usageReport = orgAction({
  args: {},
  handler: async (ctx): Promise<BillingUsageReport> => {
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
