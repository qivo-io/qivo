import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { getBillableUsers, type RosterCounts, rosterCounts } from '../lib/billableUsers'
import {
  addCalendarMonths,
  billingEnabled,
  orgRemovalFor,
  subscriptionFor,
  subscriptionWritable,
} from '../lib/billingAccess'
import type {
  BillingDetails,
  BillingPeriodHead,
  BillingPlan,
  BillingUsageFigures,
} from '../lib/billingTypes'
import { byId } from '../lib/db'
import { badRequest, notFound, require, rule } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { grouped, LIMITS, PLAN_CURRENCIES, PLAN_CURRENCY } from '../lib/limits'
import { polarConfigured } from '../lib/polar'
import { allowanceSeats, includedApiCalls, periodCalls, usagePeriod } from './billingUsage'
import {
  CHECKOUT_DAYS,
  checkoutDeadline,
  DAY_MS,
  retentionDue,
  syncOrgRemoval,
} from './orgRetention'
import { newUuid } from './orgs'
import { storageTotalsOf } from './storageTotals'

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

/* Billing's details of organization `orgId` around the counters `roster`:
 * the organization row, the subscription, any removal and the plan, read
 * here, and nothing of the roster. */
async function detailsWith(
  ctx: QueryCtx,
  orgId: string,
  roster: RosterCounts,
): Promise<BillingDetails> {
  const org = await byId(ctx, 'organizations', orgId)
  require(org, notFound('organization not found'))
  const sub = await subscriptionFor(ctx, orgId)
  const removal = await orgRemovalFor(ctx, orgId)
  const plan = sub ? await byId(ctx, 'billing_plans', sub.plan_id) : await defaultPlan(ctx)
  const next = Math.max(plan?.minimum_seats ?? 5, roster.billable)
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
    active_users: roster.active,
    inactive_users: roster.inactive,
    invited_users_with_own_billing: roster.ownBilling,
    billable_users: roster.billable,
    billed_seats: sub?.billed_seats ?? 0,
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

/** What an admin's Billing page shows of organization `orgId`
 * (billing.details, and the operator console's adminBilling.orgBilling):
 * plan, status, the counters of its people and charges, the payment
 * actions available, the last export and any pending deletion. It walks
 * the roster once (lib/billableUsers.ts rosterCounts), and answers no
 * name; Billing's name lists read billing.accountList. */
export async function billingDetailsOf(ctx: QueryCtx, orgId: string): Promise<BillingDetails> {
  return await detailsWith(ctx, orgId, await rosterCounts(ctx, orgId))
}

/** The plan usage allowances follow (the subscription's, else the default
 * plan before enrollment, else none), the seats they are sized by and the API
 * calls they include. The Billing and API access pages both use it, so their
 * allowances agree. A subscription's billed seats decide both figures, so
 * it counts the billable users (getBillableUsers, a walk of every profile)
 * only without them: before enrollment, and while a subscription has
 * billed no seat yet. */
export async function usageAllowance(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
) {
  const plan = sub ? await byId(ctx, 'billing_plans', sub.plan_id) : await defaultPlan(ctx)
  // Included calls are the allowance recordApiCall charges against.
  if (sub?.billed_seats) {
    const includedCalls = plan ? includedApiCalls(plan, allowanceSeats(sub)) : null
    return { plan, seats: sub.billed_seats, includedCalls }
  }
  const count = await getBillableUsers(ctx, orgId)
  const seats = Math.max(plan?.minimum_seats ?? 5, count.total)
  // Before enrollment there is no subscription, so the preview counts members.
  const includedCalls = plan
    ? includedApiCalls(plan, sub ? allowanceSeats(sub) : count.total)
    : null
  return { plan, seats, includedCalls }
}

/** The bucket Billing shows for organization `orgId` and what it has
 * recorded, without its calls: the same bucket the API-call writer is
 * filling now (`usagePeriod`), the live paid period, the pending interval
 * after it, or the current UTC calendar month, with its key, which API
 * calls by account reads and View credentials hands to API access.
 * Allowances come from the subscription's plan, or the default plan before
 * enrollment, and are null when there is no plan (usageAllowance). A
 * calendar month and a pending interval are always waived. It reads every
 * billing_events row of the bucket for the recorded charges, one row per
 * started block of API overage and per storage charge. `sub` is the
 * organization's subscription. */
export async function periodHead(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
): Promise<BillingPeriodHead> {
  const { plan, seats, includedCalls } = await usageAllowance(ctx, orgId, sub)
  const now = Date.now()
  const period = usagePeriod(sub, now)
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
    included_calls: includedCalls,
    included_storage_bytes: includedBytes,
    api_overage_cents: apiBlocks * (plan?.api_block_price_cents ?? 100),
    storage_overage_cents: storageBlocks * (plan?.storage_block_price_cents ?? 100),
    waived,
    delivery_unconfirmed: events.some((event) => !!event.abandoned_at && event.attempts > 0),
  }
}

/** The open daily periods of every organization that end at or before
 * `until`, an ISO time, by their end: on the daily basis, not recorded and
 * not stopped (schema.ts billing_periods by_storage_open). period_end is an
 * ISO time from toISOString, so its order is the time's. billingSync.ts
 * finalizeDue pages it. */
export const openDailyPeriods = (ctx: QueryCtx, until: string) =>
  ctx.db
    .query('billing_periods')
    .withIndex('by_storage_open', (q) =>
      q
        .eq('storage_basis', 'daily')
        .eq('storage_finalized_at', undefined)
        .eq('storage_failed_at', undefined)
        .lte('period_end', until),
    )

/** The first open daily period that ends at or before `until`, or null:
 * one indexed read of at most one row, which the daily samples' triggers
 * read before they schedule billingSync.ts finalizeDue (storageSamples.ts). */
export const openDailyPeriodBy = (ctx: QueryCtx, until: string) =>
  openDailyPeriods(ctx, until).first()

/** The storage sample of the paid period `head` for organization `orgId`,
 * whose subscription is `sub`, as its billing_periods row holds it
 * (billingSync.ts storageStep), found by the provider subscription id and
 * the period's start. It answers the bytes the period's storage charge
 * uses, the organization's stored-byte totals when the sample read them,
 * files in Deleted items included, and when it read them. Both are null
 * for a calendar month or a pending interval, a subscription without a
 * provider id, a period without a row or of another organization, and a
 * sample that is running or stopped. The time is null too for a sample an
 * earlier release finished, which measured the period's start. One read at
 * most. */
async function sampledStorage(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
  head: Pick<BillingPeriodHead, 'period_kind' | 'period_key'>,
): Promise<Pick<BillingUsageFigures, 'sampled_storage_bytes' | 'sampled_storage_at'>> {
  const none = { sampled_storage_bytes: null, sampled_storage_at: null }
  const subscriptionId = sub?.polar_subscription_id
  if (head.period_kind !== 'paid' || !subscriptionId) return none
  const period = await ctx.db
    .query('billing_periods')
    .withIndex('by_subscription_period', (q) =>
      q.eq('subscription_id', subscriptionId).eq('period_start', head.period_key),
    )
    .unique()
  if (period?.org_id !== orgId || period.storage_bytes === undefined) return none
  return {
    sampled_storage_bytes: period.storage_bytes,
    sampled_storage_at: period.storage_sampled_at ?? null,
  }
}

/** Billing's usage figures for organization `orgId`
 * (billing.usageFigures): the bucket and what it recorded (periodHead),
 * its calls from its aggregates (model/billingUsage.ts periodCalls), the
 * figure API access shows, or null while they are not complete, never 0
 * in their place, current storage from the stored-byte totals, files in
 * Deleted items included until they are deleted for good, or null while
 * they are not complete, and the bytes the current paid period's sample
 * measured from the same totals, normally at the period's start, with when
 * it measured them (sampledStorage).
 * It reads at most one usage row (the ranked check), the month's shards or
 * the bucket's totals row, two single reads, and no account, profile
 * beyond the allowance's or attachment row. */
export async function usageFiguresOf(ctx: QueryCtx, orgId: string): Promise<BillingUsageFigures> {
  const sub = await subscriptionFor(ctx, orgId)
  const head = await periodHead(ctx, orgId, sub)
  const totals = await storageTotalsOf(ctx, orgId)
  return {
    ...head,
    calls: await periodCalls(ctx, orgId, head.period_key),
    storage_bytes: totals?.bytes ?? null,
    ...(await sampledStorage(ctx, orgId, sub, head)),
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
