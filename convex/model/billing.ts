import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { getBillableUsers } from '../lib/billableUsers'
import {
  addCalendarMonths,
  billingEnabled,
  orgRemovalFor,
  subscriptionFor,
  subscriptionWritable,
} from '../lib/billingAccess'
import type { BillingPlan, BillingSummary, BillingUsage } from '../lib/billingTypes'
import { byId } from '../lib/db'
import { badRequest, notFound, require, rule } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { grouped, LIMITS, PLAN_CURRENCIES, PLAN_CURRENCY } from '../lib/limits'
import { polarConfigured } from '../lib/polar'
import { allowanceSeats, includedApiCalls, usagePeriod } from './billingUsage'
import { estimateDocumentBytes } from './demoMetrics'
import {
  CHECKOUT_DAYS,
  checkoutDeadline,
  DAY_MS,
  retentionDue,
  syncOrgRemoval,
} from './orgRetention'
import { newUuid } from './orgs'

export const GB = 1_000_000_000
export const isoNow = () => new Date().toISOString()

// A cached checkout may have succeeded before its local expiry with a lost
// webhook. Keep it locked until reconciliation verifies its provider state.
// An abandoned preparation lease has no exposed session and may expire locally.
export function hasPendingCheckout(sub: Doc<'billing_subscriptions'> | null, now = isoNow()) {
  return !!(
    sub?.checkout_id ||
    (sub?.checkout_lock && (!sub.checkout_lock_until || sub.checkout_lock_until > now))
  )
}

export async function defaultPlan(ctx: QueryCtx) {
  const settings = await ctx.db
    .query('billing_settings')
    .withIndex('by_key', (q) => q.eq('key', 'default'))
    .unique()
  return settings ? await byId(ctx, 'billing_plans', settings.default_plan_id) : null
}

export const planRow = (plan: Doc<'billing_plans'>): BillingPlan => {
  const { _id, _creationTime, ...row } = plan
  return row
}

/** The organization's subscription row, created as `pending` on the given
 * or default plan when it has none. Null when no plan exists. Enrollment
 * while billing runs starts the CHECKOUT_DAYS checkout deadline. */
export async function enrollOrganization(ctx: MutationCtx, orgId: string, planId?: string) {
  const old = await subscriptionFor(ctx, orgId)
  if (old) return old
  const plan = planId ? await byId(ctx, 'billing_plans', planId) : await defaultPlan(ctx)
  if (!plan) return null
  const count = await getBillableUsers(ctx, orgId)
  const now = isoNow()
  const row = {
    id: newUuid(),
    org_id: orgId,
    plan_id: plan.id,
    status: 'pending',
    billed_seats: 0,
    next_seats: Math.max(plan.minimum_seats, count.total),
    cancel_at_period_end: false,
    // reconciled once among the other due organizations (billingSync.ts sweep)
    sync_due_at: now,
    // Only organizations enrolled while billing runs get a checkout deadline.
    ...(billingEnabled()
      ? { checkout_due_at: new Date(Date.parse(now) + CHECKOUT_DAYS * DAY_MS).toISOString() }
      : {}),
    created_at: now,
    updated_at: now,
  } as const
  const id = await ctx.db.insert('billing_subscriptions', {
    ...row,
    retention_at: retentionDue(row),
    remind_at: null,
  })
  return await ctx.db.get(id)
}

/** How long before a free period ends its two reminders go out, and its end,
 * when the expired notice goes out and the members' pages refresh
 * (billingSync.ts reminders). */
export const REMINDER_THRESHOLDS = [7 * DAY_MS, DAY_MS, 0]

/** The time of the first reminder of a free period ending at `until` that
 * comes after `after`, or null when none is left. Stored as remind_at. */
export function nextReminder(until: string, after: number): string | null {
  for (const threshold of REMINDER_THRESHOLDS) {
    const at = Date.parse(until) - threshold
    if (at > after) return new Date(at).toISOString()
  }
  return null
}

/** Complimentary access for `months` calendar months, without a card. Enrolls
 * the organization on the default plan when it has no subscription yet.
 * Repeating a grant extends it from the current end date, and the restored
 * access stops a deletion that billing started. Refused once a checkout or
 * provider subscription exists, because Polar then owns the terms. Shared by
 * the operator's grant on an existing organization and the grant chosen
 * while creating one. The caller writes the audit row. */
export async function grantComplimentaryMonths(
  ctx: MutationCtx,
  orgId: string,
  months: number,
): Promise<{ until: string; plan_id: string }> {
  if (!Number.isInteger(months) || months < 1 || months > 24)
    throw badRequest('Choose 1–24 calendar months.')
  require(await byId(ctx, 'organizations', orgId), notFound('organization not found'))
  const sub = await enrollOrganization(ctx, orgId)
  require(sub, rule('Create and select a default billing plan first.'))
  require(!sub.polar_subscription_id && !hasPendingCheckout(sub), rule(
    'Complimentary access must be granted before checkout. Manage an existing paid promotion in Polar.',
  ))
  const now = isoNow()
  const from =
    sub.complimentary_until && sub.complimentary_until > now ? sub.complimentary_until : now
  const until = addCalendarMonths(from, months)
  await ctx.db.patch(sub._id, {
    complimentary_start: sub.complimentary_start ?? now,
    complimentary_until: until,
    retention_at: retentionDue({ ...sub, complimentary_until: until }),
    remind_at: nextReminder(until, Date.parse(now)),
    updated_at: now,
    checkout_id: undefined,
    checkout_url: undefined,
    checkout_expires_at: undefined,
    checkout_lock: undefined,
    checkout_lock_until: undefined,
  })
  // Restored access stops a deletion that billing started.
  await syncOrgRemoval(ctx, orgId)
  return { until, plan_id: sub.plan_id }
}

/** What an admin's Billing page shows: plan, status, users and charges, the
 * payment actions available, the last export and any pending deletion. */
export async function billingSummary(ctx: QueryCtx, orgId: string): Promise<BillingSummary> {
  const org = await byId(ctx, 'organizations', orgId)
  require(org, notFound('organization not found'))
  const sub = await subscriptionFor(ctx, orgId)
  const removal = await orgRemovalFor(ctx, orgId)
  const plan = sub ? await byId(ctx, 'billing_plans', sub.plan_id) : await defaultPlan(ctx)
  const count = await getBillableUsers(ctx, orgId)
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const billableIds = new Set(count.users.map((user) => user.profile_id))
  const excluded: BillingSummary['non_billable_accounts'] = []
  for (const profile of profiles) {
    // Inactive guests belong to the inactive count, even if a home membership
    // would also exempt them. The counters and lists therefore partition the roster.
    if (!profile.active)
      excluded.push({ profile_id: profile.id, name: profile.name, reason: 'inactive' })
    else if (profile.org_role === 'guest' && !billableIds.has(profile.id))
      excluded.push({ profile_id: profile.id, name: profile.name, reason: 'guest_with_home' })
  }
  excluded.sort((a, b) => a.name.localeCompare(b.name) || a.profile_id.localeCompare(b.profile_id))
  const next = Math.max(plan?.minimum_seats ?? 5, count.total)
  const complimentary =
    !!sub?.complimentary_until && Date.parse(sub.complimentary_until) > Date.now()
  const configured = polarConfigured() && !!plan?.polar_product_id
  const enabled = billingEnabled()
  // Internal identifiers and provider IDs are omitted from customer-facing terms.
  const safePlan = plan ? planRow(plan) : null
  if (safePlan) {
    delete safePlan.polar_product_id
    delete safePlan.api_meter_id
    delete safePlan.storage_meter_id
  }
  return {
    enabled,
    configured,
    plan: safePlan,
    plan_assigned: !!sub,
    can_assign_plan: !sub?.polar_subscription_id && !hasPendingCheckout(sub),
    can_grant_complimentary: !!plan && !sub?.polar_subscription_id && !hasPendingCheckout(sub),
    status: complimentary
      ? 'complimentary'
      : (sub?.status ?? (enabled ? 'pending' : 'unconfigured')),
    writable: subscriptionWritable(sub) && !removal,
    active_users: profiles.filter((p) => p.active).length,
    inactive_users: excluded.filter((account) => account.reason === 'inactive').length,
    invited_users_with_own_billing: excluded.filter(
      (account) => account.reason === 'guest_with_home',
    ).length,
    billable_users: count.total,
    billed_seats: sub?.billed_seats ?? 0,
    billable_accounts: count.users.map(({ profile_id, name, reason }) => ({
      profile_id,
      name,
      reason,
    })),
    non_billable_accounts: excluded,
    next_seats: next,
    next_seat_amount_cents: next * (plan?.seat_price_cents ?? 100),
    current_period_start: sub?.current_period_start ?? null,
    current_period_end: sub?.current_period_end ?? null,
    complimentary_until: sub?.complimentary_until ?? null,
    cancel_at_period_end: sub?.cancel_at_period_end ?? false,
    checkout_available:
      enabled &&
      configured &&
      !complimentary &&
      (!sub?.polar_subscription_id || sub.status === 'canceled'),
    portal_available: enabled && configured && !!sub?.polar_customer_id,
    // Cancelling keeps access until the period ends, so it is offered only
    // while the organization is paid up and its subscription still renews.
    cancel_available:
      enabled &&
      polarConfigured() &&
      !!sub?.polar_subscription_id &&
      ['active', 'trialing'].includes(sub.status) &&
      !sub.cancel_at_period_end &&
      !removal,
    checkout_due_at: checkoutDeadline(sub),
    last_export_at: org.last_export_at ?? null,
    deletion: removal ? { reason: removal.reason, delete_after: removal.delete_after } : null,
    sync_pending: !!sub?.polar_subscription_id && next !== sub.next_seats,
    sync_error: sub?.sync_error ?? null,
  }
}

/**
 * The attachment bytes an organization stores, in total and per project,
 * largest first. Counts every attachment and description image of its
 * tasks, archived ones included, whose project still exists, so a task left
 * under a removed project is not counted. Reads the organization's
 * attachment rows in one index range and counts each row in its task's
 * project, reading each task once.
 *
 * Files in Deleted items are not billed. A task item's rows leave
 * issue_attachments with its move, in the delete's transaction or in the
 * steps just after it, and count nowhere once their task has left issues.
 * A project item's project rows leave projects first, so the rows of its
 * tasks still moving count nowhere. A restore writes the rows back before
 * it reveals the task, and they count from then on where its project is
 * live.
 *
 * It reads every attachment row of the organization in one transaction, so
 * no function serves it. The Billing page and the storage samples count the
 * same bytes page by page (storagePage), and the tests check those pages
 * against it.
 */
export async function storageUsage(ctx: QueryCtx, orgId: string) {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const totals = new Map(
    projects.map((p) => [p.id, { project_id: p.id, name: p.name, storage_bytes: 0 }]),
  )
  const tasks = new Map<string, Doc<'issues'> | null>()
  let bytes = 0
  const files = ctx.db
    .query('issue_attachments')
    .withIndex('by_org_task_archived_issue', (q) => q.eq('org_id', orgId))
  for await (const file of files) {
    let task = tasks.get(file.issue_id)
    if (task === undefined) {
      task = await byId(ctx, 'issues', file.issue_id)
      tasks.set(file.issue_id, task)
    }
    const project = task === null ? undefined : totals.get(task.project_id)
    if (project === undefined) continue
    project.storage_bytes += file.size_bytes
    bytes += file.size_bytes
  }
  return {
    bytes,
    projects: [...totals.values()]
      .filter((p) => p.storage_bytes > 0)
      .sort((a, b) => b.storage_bytes - a.storage_bytes),
  }
}

/** Sizes of one step of a period's storage sample (storagePage). A step
 * reads at most `rows` attachment rows and `bytes` of their range, one task
 * for each task it meets and one project for each project it meets. When
 * the tasks it read pass `taskBytes`, it stops and the step after it reads
 * the same page again, only as far as the rows before the one that passed.
 * Tests lower them. */
export const STORAGE_PAGE = {
  rows: 1000,
  bytes: 4 * 1024 * 1024,
  taskBytes: 4 * 1024 * 1024,
}

/** One project's counted bytes. */
export type StorageProject = BillingUsage['projects'][number]

/** A storage sample's page, or the smaller size to read the same page at. */
export type StoragePage =
  | { bytes: number; projects: StorageProject[]; next: string | null }
  | { split: number }

/* Counts bytes in the projects of `orgId` that still exist, reading each
 * project once. */
function projectCounter(ctx: QueryCtx, orgId: string) {
  const live = new Map<string, StorageProject | null>()
  let bytes = 0
  return {
    async add(projectId: string, size: number) {
      let project = live.get(projectId)
      if (project === undefined) {
        const row = await byId(ctx, 'projects', projectId)
        project =
          row?.org_id === orgId ? { project_id: row.id, name: row.name, storage_bytes: 0 } : null
        live.set(projectId, project)
      }
      if (project === null) return
      project.storage_bytes += size
      bytes += size
    },
    counted: () => ({
      bytes,
      projects: [...live.values()].filter((p): p is StorageProject => p !== null),
    }),
  }
}

/**
 * One page of the bytes storageUsage counts for organization `orgId`, for a
 * sample taken over many transactions or the Billing page's report. It
 * counts the same rows: each row counts in its task's project, which must
 * still exist in the organization. The page also gives the bytes of each
 * project it counted.
 *
 * Pages follow the order rows were stored, so archiving a task or restoring
 * an archived one during the sample moves none of them. Rows stored after
 * `before` (a _creationTime, the period row's) are left out. Those include
 * the rows a restore from Deleted items writes back, which would otherwise
 * be counted a second time if their earlier copies were counted before the
 * task was deleted. Each page is its own snapshot, so a file removed while
 * the sample runs may count or not.
 *
 * Returns the bytes the page counts and the cursor of the next one, or
 * `split` with a smaller size when the tasks it read pass
 * STORAGE_PAGE.taskBytes. A page of one row always completes. `size`
 * defaults to STORAGE_PAGE.rows.
 */
export async function storagePage(
  ctx: QueryCtx,
  orgId: string,
  { cursor, size, before }: { cursor: string | null; size?: number; before: number },
): Promise<StoragePage> {
  const counter = projectCounter(ctx, orgId)
  const page = await ctx.db
    .query('issue_attachments')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .paginate({
      cursor,
      numItems: Math.max(1, size ?? STORAGE_PAGE.rows),
      maximumBytesRead: STORAGE_PAGE.bytes,
    })
  const tasks = new Map<string, Doc<'issues'> | null>()
  let taskBytes = 0
  for (const [i, file] of page.page.entries()) {
    if (file._creationTime > before) continue
    let task = tasks.get(file.issue_id)
    if (task === undefined) {
      task = await byId(ctx, 'issues', file.issue_id)
      tasks.set(file.issue_id, task)
      if (task !== null) taskBytes += estimateDocumentBytes(task)
      // the rows before this one fit, and a page of one always completes
      if (taskBytes > STORAGE_PAGE.taskBytes && page.page.length > 1)
        return { split: Math.max(1, i) }
    }
    if (task === null) continue
    await counter.add(task.project_id, file.size_bytes)
  }
  return { ...counter.counted(), next: page.isDone ? null : page.continueCursor }
}

/** The plan usage allowances follow (the subscription's, else the default
 * plan before enrollment, else none), the seats they are sized by and the API
 * calls they include. The Billing and API access pages both use it, so their
 * allowances agree. */
export async function usageAllowance(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
) {
  const plan = sub ? await byId(ctx, 'billing_plans', sub.plan_id) : await defaultPlan(ctx)
  const count = await getBillableUsers(ctx, orgId)
  const seats = sub?.billed_seats || Math.max(plan?.minimum_seats ?? 5, count.total)
  // Included calls are the allowance recordApiCall charges against. Before
  // enrollment there is no subscription, so the preview counts members.
  const includedCalls = plan
    ? includedApiCalls(plan, sub ? allowanceSeats(sub) : count.total)
    : null
  return { plan, seats, includedCalls }
}

/** The admin Billing page's usage report without its storage figures. It
 * reads the same bucket the API-call writer is filling now (`usagePeriod`):
 * the live paid period, the pending interval after it, or the current UTC
 * calendar month, and names its key, which View credentials hands to API
 * access. Allowances come from the subscription's plan, or the default plan
 * before enrollment, and are null when there is no plan. A calendar month
 * and a pending interval are always waived. */
export async function billingUsageHead(
  ctx: QueryCtx,
  orgId: string,
): Promise<Omit<BillingUsage, 'storage_bytes' | 'projects'>> {
  const sub = await subscriptionFor(ctx, orgId)
  const { plan, seats, includedCalls } = await usageAllowance(ctx, orgId, sub)
  const now = Date.now()
  const period = usagePeriod(sub, now)
  const rows = await ctx.db
    .query('billing_usage')
    .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', period.key))
    .collect()
  const users = new Map<string, BillingUsage['users'][number]>()
  for (const row of rows) {
    let user = users.get(row.profile_id)
    if (!user) {
      const profile = await byId(ctx, 'profiles', row.profile_id)
      user = {
        profile_id: row.profile_id,
        name: profile?.org_id === orgId ? profile.name : 'Removed user',
        calls: 0,
      }
      users.set(row.profile_id, user)
    }
    user.calls += row.calls
  }
  const calls = rows.reduce((total, row) => total + row.calls, 0)
  const includedBytes = plan
    ? Math.max(plan.minimum_storage_gb, seats * plan.storage_gb_per_seat) * GB
    : null
  // A calendar month never has billing events, so this finds none for it.
  const events = await ctx.db
    .query('billing_events')
    .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', period.key))
    .collect()
  const apiBlocks = events
    .filter((event) => event.kind === 'api' && (!event.abandoned_at || event.attempts > 0))
    .reduce((total, event) => total + event.units, 0)
  const storageBlocks = events
    .filter((event) => event.kind === 'storage' && (!event.abandoned_at || event.attempts > 0))
    .reduce((total, event) => total + event.units, 0)
  // recordApiCall never charges a calendar month or a pending interval.
  const waived =
    period.kind !== 'paid' ||
    !billingEnabled() ||
    !sub?.polar_subscription_id ||
    (!!sub.complimentary_until && Date.parse(sub.complimentary_until) > now)
  return {
    period_kind: period.kind,
    period_key: period.key,
    period_start: period.start,
    period_end: period.end,
    calls,
    included_calls: includedCalls,
    included_storage_bytes: includedBytes,
    api_overage_cents: apiBlocks * (plan?.api_block_price_cents ?? 100),
    storage_overage_cents: storageBlocks * (plan?.storage_block_price_cents ?? 100),
    waived,
    delivery_unconfirmed: events.some((event) => !!event.abandoned_at && event.attempts > 0),
    users: [...users.values()].sort((a, b) => b.calls - a.calls),
  }
}

export function validatePlan(plan: Omit<BillingPlan, 'id' | 'archived' | 'created_at'>) {
  if (!limitedText(LIMITS.planName, plan.name)) throw badRequest('Add a plan name.')
  if (!PLAN_CURRENCIES.some((c) => c === plan.currency)) throw rule(PLAN_CURRENCY)
  for (const key of [
    'seat_price_cents',
    'minimum_seats',
    'api_calls_per_seat',
    'api_block_size',
    'storage_block_price_cents',
    'api_block_price_cents',
  ] as const) {
    if (!Number.isSafeInteger(plan[key]) || plan[key] < 1 || plan[key] > 1_000_000_000)
      throw badRequest(`${key} must be a positive whole number.`)
  }
  if (plan.minimum_seats > LIMITS.billingSeats.max)
    throw badRequest(
      `Polar supports at most ${grouped(LIMITS.billingSeats.max)} seats per subscription.`,
    )
  for (const key of ['storage_gb_per_seat', 'minimum_storage_gb'] as const)
    if (!Number.isSafeInteger(plan[key]) || plan[key] < 0 || plan[key] > 1_000_000)
      throw badRequest(`${key} must be a nonnegative whole number.`)
  if (plan.polar_product_id && (!plan.api_meter_id || !plan.storage_meter_id))
    throw badRequest('A paid plan needs both API and storage overage meters.')
}
