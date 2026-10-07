import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { getBillableUsers } from '../lib/billableUsers'
import { billingEnabled, subscriptionFor, subscriptionWritable } from '../lib/billingAccess'
import type { BillingPlan, BillingSummary, BillingUsage } from '../lib/billingTypes'
import { byId } from '../lib/db'
import { badRequest, notFound, require } from '../lib/functions'
import { polarConfigured } from '../lib/polar'
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

export async function enrollOrganization(ctx: MutationCtx, orgId: string, planId?: string) {
  const old = await subscriptionFor(ctx, orgId)
  if (old) return old
  const plan = planId ? await byId(ctx, 'billing_plans', planId) : await defaultPlan(ctx)
  if (!plan) return null
  const count = await getBillableUsers(ctx, orgId)
  const now = isoNow()
  const id = await ctx.db.insert('billing_subscriptions', {
    id: newUuid(),
    org_id: orgId,
    plan_id: plan.id,
    status: 'pending',
    billed_seats: 0,
    next_seats: Math.max(plan.minimum_seats, count.total),
    cancel_at_period_end: false,
    created_at: now,
    updated_at: now,
  })
  return await ctx.db.get(id)
}

export async function billingSummary(ctx: QueryCtx, orgId: string): Promise<BillingSummary> {
  require(await byId(ctx, 'organizations', orgId), notFound('organization not found'))
  const sub = await subscriptionFor(ctx, orgId)
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
    writable: subscriptionWritable(sub),
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
    sync_pending: !!sub?.polar_subscription_id && next !== sub.next_seats,
    sync_error: sub?.sync_error ?? null,
  }
}

export async function storageUsage(ctx: QueryCtx, orgId: string) {
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const totals = new Map(
    projects.map((p) => [p.id, { project_id: p.id, name: p.name, storage_bytes: 0 }]),
  )
  let bytes = 0
  const issues = ctx.db.query('issues').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const issue of issues) {
    const files = ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
    for await (const file of files) {
      bytes += file.size_bytes
      const project = totals.get(issue.project_id)
      if (project) project.storage_bytes += file.size_bytes
    }
  }
  return {
    bytes,
    projects: [...totals.values()]
      .filter((p) => p.storage_bytes > 0)
      .sort((a, b) => b.storage_bytes - a.storage_bytes),
  }
}

export async function billingUsage(ctx: QueryCtx, orgId: string): Promise<BillingUsage> {
  const sub = await subscriptionFor(ctx, orgId)
  const plan = sub ? await byId(ctx, 'billing_plans', sub.plan_id) : await defaultPlan(ctx)
  const count = await getBillableUsers(ctx, orgId)
  const period = sub?.current_period_start ?? sub?.complimentary_start ?? null
  const rows = period
    ? await ctx.db
        .query('billing_usage')
        .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', period))
        .collect()
    : []
  const users = new Map<string, BillingUsage['users'][number]>()
  for (const row of rows) {
    let user = users.get(row.profile_id)
    if (!user) {
      const profile = await byId(ctx, 'profiles', row.profile_id)
      user = {
        profile_id: row.profile_id,
        name: profile?.org_id === orgId ? profile.name : 'Removed user',
        calls: 0,
        keys: [],
      }
      users.set(row.profile_id, user)
    }
    user.calls += row.calls
    user.keys.push({ id: row.credential_id, name: row.credential_name, calls: row.calls })
  }
  const calls = rows.reduce((total, row) => total + row.calls, 0)
  const seats = sub?.billed_seats || Math.max(plan?.minimum_seats ?? 5, count.total)
  const includedCalls = seats * (plan?.api_calls_per_seat ?? 25_000)
  const includedBytes =
    Math.max(plan?.minimum_storage_gb ?? 5, seats * (plan?.storage_gb_per_seat ?? 1)) * GB
  const storage = await storageUsage(ctx, orgId)
  const events = period
    ? await ctx.db
        .query('billing_events')
        .withIndex('by_org_period', (q) => q.eq('org_id', orgId).eq('period_start', period))
        .collect()
    : []
  const apiBlocks = events
    .filter((event) => event.kind === 'api' && (!event.abandoned_at || event.attempts > 0))
    .reduce((total, event) => total + event.units, 0)
  const storageBlocks = events
    .filter((event) => event.kind === 'storage' && (!event.abandoned_at || event.attempts > 0))
    .reduce((total, event) => total + event.units, 0)
  const waived =
    !billingEnabled() ||
    !sub?.polar_subscription_id ||
    (!!sub.complimentary_until && Date.parse(sub.complimentary_until) > Date.now())
  return {
    period_start: period,
    period_end: sub?.current_period_end ?? sub?.complimentary_until ?? null,
    calls,
    included_calls: includedCalls,
    storage_bytes: storage.bytes,
    included_storage_bytes: includedBytes,
    api_overage_cents: apiBlocks * (plan?.api_block_price_cents ?? 100),
    storage_overage_cents: storageBlocks * (plan?.storage_block_price_cents ?? 100),
    waived,
    delivery_unconfirmed: events.some((event) => !!event.abandoned_at && event.attempts > 0),
    users: [...users.values()].sort((a, b) => b.calls - a.calls),
    projects: storage.projects,
  }
}

export function validatePlan(plan: Omit<BillingPlan, 'id' | 'archived' | 'created_at'>) {
  if (!plan.name.trim() || plan.name.length > 80)
    throw badRequest('Use a plan name of 1–80 characters.')
  if (
    !['usd', 'eur', 'gbp', 'nok', 'sek', 'dkk', 'cad', 'aud', 'chf', 'nzd'].includes(plan.currency)
  )
    throw badRequest(
      'Supported plan currencies: USD, EUR, GBP, NOK, SEK, DKK, CAD, AUD, CHF and NZD.',
    )
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
  if (plan.minimum_seats > 1000)
    throw badRequest('Polar supports at most 1,000 seats per subscription.')
  for (const key of ['storage_gb_per_seat', 'minimum_storage_gb'] as const)
    if (!Number.isSafeInteger(plan[key]) || plan[key] < 0 || plan[key] > 1_000_000)
      throw badRequest(`${key} must be a nonnegative whole number.`)
  if (plan.polar_product_id && (!plan.api_meter_id || !plan.storage_meter_id))
    throw badRequest('A paid plan needs both API and storage overage meters.')
}
