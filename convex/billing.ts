import { v } from 'convex/values'
import { internalQuery } from './_generated/server'
import {
  assertOrgAvailable,
  billingEnabled,
  orgRemovalFor,
  subscriptionFor,
  subscriptionWritable,
} from './lib/billingAccess'
import type {
  AccountNames,
  ApiAccounts,
  BillingDetails,
  BillingUsageFigures,
  StorageProjects,
} from './lib/billingTypes'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import { forbidden, orgQuery, require } from './lib/functions'
import { billingDetailsOf, usageFiguresOf } from './model/billing'
import { accountNamesBatch, apiAccountsBatch } from './model/billingLists'
import { storageProjectsBatch } from './model/billingStorage'
import { checkoutDeadline } from './model/orgRetention'

/**
 * Billing's details for an organization admin (model/billing.ts
 * billingDetailsOf): the plan, status, the counters of its people and
 * charges, the payment actions available, the last export and any pending
 * deletion, with no account name. An explicit admin-only query keeps
 * amounts and customer state outside the planner. Refused in the demo, to
 * anyone but an admin with an active seat, and while the organization's
 * deletion runs (orgQuery's loadMember).
 *
 * The app keeps it a live subscription (convex.onUpdate), so a payment or a
 * renewal shows without a Refresh. It reads the organization row, the
 * subscription, any removal, the plan and one walk of the roster
 * (lib/billableUsers.ts rosterCounts), so it runs again on any change of a
 * profile of the organization, and answers a few dozen fields. The names of who
 * counts toward the bill and who does not come from billing.accountList, only
 * while a list is open. What it reads at the design size's people is logged by
 * convex/tests/billingLists.test.ts ("reads at the design size"), and the
 * closing review's report in qivo-internal
 * (evaluations/limits/closing-review-2026-11-09/closing-report.md, "View
 * visibility") holds its timed figures.
 */
export const details = orgQuery({
  args: {},
  handler: async (ctx): Promise<BillingDetails> => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await billingDetailsOf(ctx, ctx.me.org_id)
  },
})

/**
 * Billing's usage figures for an organization admin (model/billing.ts
 * usageFiguresOf): the bucket API calls are recorded in now, its calls,
 * the allowances and the charges recorded, current storage and the
 * period's storage, its sample or its daily average, with no account.
 * Refused in the demo, to anyone but an admin with an active seat, and
 * while the organization's deletion runs (orgQuery's loadMember).
 *
 * The app reads it once on opening Billing and on each Refresh
 * (convex.query) and never subscribes to it, because API usage changes
 * with every machine call. The calls are the bucket's aggregates
 * (model/billingUsage.ts periodCalls), the figure API access shows, or
 * null while they are not complete, never 0 in their place. Current
 * storage is the organization's stored-byte totals, files in Deleted items
 * included until they are deleted for good, or null while the totals are
 * not complete, never 0. `storage_basis` says how the current paid
 * period's storage is charged. For a period sampled at its start the
 * sample is what its storage charge uses, the same totals as the period's
 * sample read them, normally when the period started, files in Deleted
 * items included, with when it read them (`sampled_storage_at`, null for a
 * sample an earlier release finished, which scanned the attachment rows
 * and left those files out). Both are null for any other bucket, for a
 * daily period, or while the sample has not finished. A daily period
 * answers `storage_average` instead, the recorded average with its
 * measured and estimated days, or while it is open the average so far,
 * never 0 for a day not measured yet (lib/billingTypes.ts). Billing's API
 * calls by account reads billing.apiAccounts for the period_key this
 * answers.
 *
 * It picks the bucket by the clock when it runs (usagePeriod). Convex can
 * answer a read from its cache of an identical earlier one while nothing
 * it read changed, and drops cached answers of a query that reads the
 * clock often so they do not grow old, so just after a period or month
 * boundary a read can answer the bucket before it for a short while, as
 * apiAccess.summary can. It reads the allowance's plan, the roster only
 * when the subscription has no billed seats (usageAllowance), the bucket's
 * billing events, at most one usage row and the month's shards or the
 * bucket's totals row, and two single reads, the storage totals row and
 * the period row, and for an open daily period one range of the
 * organization's samples of its days so far, at most 31 documents; no
 * other period reads a sample. At 1,000 people without a subscription, so
 * the roster is walked, with 15 accounts of usage over 30 usage rows, it
 * read about 1,040 documents (the month's shards the accounts hash to
 * vary), 28 index ranges and about 377 KB in
 * convex/tests/billingLists.test.ts ("reads at the design size"), without
 * the caller's seat check; with billed seats it reads no profile, and more
 * usage rows add no read.
 */
export const usageFigures = orgQuery({
  args: {},
  handler: async (ctx): Promise<BillingUsageFigures> => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await usageFiguresOf(ctx, ctx.me.org_id)
  },
})

/**
 * One batch of Billing's API calls by account for an organization admin
 * (model/billingLists.ts apiAccountsBatch): at most LIST_BATCH accounts
 * with calls in the bucket keyed `period`, most calls first, equal calls in
 * descending profile id order, each with its total over all its
 * credentials and its name, or "Removed user" for an account whose profile
 * is gone or in another organization. `period` is the period_key
 * billing.usageFigures answered, so the figures, the rows and View
 * credentials name one bucket; it reads only the caller's organization's
 * buckets, past ones included, as API access shows them, and a key that
 * names no bucket answers an empty list. `search` keeps the accounts whose
 * shown name holds every whitespace-separated fragment of it, ignoring
 * case and accents, over the whole list, and `cursor` is an earlier
 * batch's `next` for the same period and search. Refused in the demo, to
 * anyone but an admin with an active seat, and while the organization's
 * deletion runs; a period longer than any bucket key, a search past
 * LIMITS.search and a cursor of another list, organization, period or
 * search are refused too. Answers `counting` while the bucket's usage rows
 * are not all ranked, never a partial list.
 *
 * Calls change while an admin browses, and nothing freezes a snapshot (the
 * owner, 31 October 2026), so an account whose calls grow past the cursor
 * between two batches can be missed until the list starts again, or come
 * back after a re-rank, which the app shows once. A batch reads at most
 * API_ACCOUNTS.reads and answers `stopped` where that ended it, with a
 * `next` that goes on. It reads no credential, task or file. The app reads
 * each batch once (convex.query) and never subscribes to it.
 */
export const apiAccounts = orgQuery({
  args: { period: v.string(), search: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, a): Promise<ApiAccounts> => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await apiAccountsBatch(ctx, ctx.me.org_id, a)
  },
})

/**
 * One batch of Billing's Who counts toward your bill (`kind` billable) or
 * Who does not count toward your bill (`kind` non_billable) for an
 * organization admin (model/billingLists.ts accountNamesBatch): at most
 * LIST_BATCH of the organization's people and agents in name order, each
 * kept by the rule that counts them (lib/billableUsers.ts
 * billingStanding), with its id and name only. `search` keeps those whose
 * name holds every whitespace-separated fragment of it, ignoring case and
 * accents, and `cursor` is an earlier batch's `next` for the same kind and
 * search. Refused in the demo, to anyone but an admin with an active seat,
 * and while the organization's deletion runs; a search past LIMITS.search
 * and a cursor of another list, organization, kind or search are refused
 * too. Answers `not_ready` until every profile holds its name key. A
 * guest's home check reads profiles of its email in other organizations
 * and answers none of them. A batch reads at most ACCOUNT_NAMES.reads and
 * answers `stopped` where that ended it. The app reads each batch once,
 * only while its list is open, and never subscribes to it.
 */
export const accountList = orgQuery({
  args: {
    kind: v.union(v.literal('billable'), v.literal('non_billable')),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<AccountNames> => {
    refuseDemoFeature()
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    return await accountNamesBatch(ctx, ctx.me.org_id, a)
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
