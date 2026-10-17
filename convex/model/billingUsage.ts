import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { billingEnabled, subscriptionFor } from '../lib/billingAccess'
import type { BillingUsage } from '../lib/billingTypes'
import { byId } from '../lib/db'
import { isDemoDeployment } from '../lib/demo'

export const MACHINE_WINDOW_MS = 60_000
export const MACHINE_PROFILE_LIMIT = 300
export const MACHINE_INGRESS_LIMIT = 6_000

/** The usage bucket an API call made now belongs to, with the dates the
 * Billing page shows for it. `key` is the stored `period_start`.
 * - `paid`: the live provider period, keyed by `current_period_start`.
 * - `pending`: calls after a live period's end, keyed by `current_period_end`
 *   until a renewal webhook makes that instant the next period's start.
 * - `month`: a UTC calendar month, keyed `month:YYYY-MM`, used whenever there
 *   is no live paid period. Never charged. `end` is the month's last day. */
export type UsagePeriod = {
  kind: BillingUsage['period_kind']
  key: string
  start: string
  end: string | null
}

const MONTH_KEY = /^month:(\d{4})-(0[1-9]|1[0-2])$/

function monthPeriod(year: number, month: number): UsagePeriod {
  return {
    kind: 'month',
    key: `month:${year}-${String(month + 1).padStart(2, '0')}`,
    start: new Date(Date.UTC(year, month, 1)).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 0)).toISOString(),
  }
}

/** Whether the provider subscription still owns its billing period for usage.
 * Active, trialing and past-due subscriptions stay live after their period
 * end, because a renewal webhook can arrive late (`subscriptionWritable` gives
 * the same delivery a grace for editing). A subscription canceled at period
 * end stays live until that end, like its paid-through access. Pending,
 * unpaid and paused subscriptions, other canceled ones and any subscription
 * whose provider end has passed are not live. */
function livePaidSubscription(sub: Doc<'billing_subscriptions'>, now: number): boolean {
  if (!sub.polar_subscription_id) return false
  if (sub.ended_at && Date.parse(sub.ended_at) <= now) return false
  if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due') return true
  return (
    sub.status === 'canceled' &&
    sub.cancel_at_period_end &&
    !!sub.current_period_end &&
    now < Date.parse(sub.current_period_end)
  )
}

/** Picks the usage bucket for a call at `now`. The API-call writer and the
 * Billing page reader both use it, so the page always shows the bucket that
 * calls are being recorded in. Free months, pending checkouts, organizations
 * without a subscription and ended paid subscriptions all count per UTC
 * calendar month. */
export function usagePeriod(sub: Doc<'billing_subscriptions'> | null, now: number): UsagePeriod {
  const start = sub?.current_period_start
  if (sub && start && livePaidSubscription(sub, now)) {
    const end = sub.current_period_end
    // A webhook can arrive after renewal. Preserve requests in the pending new
    // interval, never add them to the closed invoice or charge an unconfirmed
    // allowance. Reconciliation adopts the same boundary when the provider's
    // new period is known. The interval stays waived if confirmation never comes.
    if (end && now >= Date.parse(end)) return { kind: 'pending', key: end, start: end, end: null }
    return { kind: 'paid', key: start, start, end: end ?? null }
  }
  const date = new Date(now)
  return monthPeriod(date.getUTCFullYear(), date.getUTCMonth())
}

/** The API calls a period includes for `seats` billed seats on `plan`,
 * never fewer than the plan's minimum seats allow. recordApiCall sizes
 * overage blocks from it, and the Billing and API access pages show it. */
export const includedApiCalls = (
  plan: Pick<Doc<'billing_plans'>, 'minimum_seats' | 'api_calls_per_seat'>,
  seats: number,
): number => Math.max(plan.minimum_seats, seats) * plan.api_calls_per_seat

/** The seats a subscription's API allowance counts now: its billed seats,
 * or the seats it will bill before its first invoice. */
export const allowanceSeats = (sub: Doc<'billing_subscriptions'>): number =>
  sub.billed_seats || sub.next_seats

/** The plan and seats a paid period of organization `orgId` was billed
 * with, for showing a past period's allowance: the recorded billing_periods
 * row usageKeyRange maps `key` to, or `sub`'s current period while it has no
 * row yet. Null for a month key and any other key without a paid period. */
export async function billedPeriod(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
  key: string,
): Promise<{ plan_id: string; seats: number } | null> {
  if (MONTH_KEY.test(key)) return null
  const rows = await ctx.db
    .query('billing_periods')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  const row = rows.find((candidate) => candidate.period_start === key)
  if (row) return { plan_id: row.plan_id, seats: row.seats }
  if (sub?.org_id === orgId && sub.current_period_start === key && sub.current_period_end)
    return { plan_id: sub.plan_id, seats: allowanceSeats(sub) }
  return null
}

/** The display dates of a stored usage key (see usageKeyRange). */
export type UsageKeyRange = { kind: 'month' | 'paid' | 'open'; start: string; end: string | null }

/** Display dates for any stored usage key of organization `orgId`, for
 * listing past periods.
 * - A month key maps to its UTC month (`kind: 'month'`).
 * - An ISO key maps to the organization's recorded `billing_periods` row,
 *   including rows of a provider subscription that has since been replaced,
 *   or to `sub`'s current period (`kind: 'paid'`).
 * - Anything else, such as an old free-access bucket keyed by
 *   `complimentary_start` or a pending interval that was never adopted, has a
 *   known start only (`kind: 'open'`, `end: null`). */
export async function usageKeyRange(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
  key: string,
): Promise<UsageKeyRange> {
  const [range] = await usageKeyRanges(ctx, orgId, sub, [key])
  return range
}

/** usageKeyRange for several keys of one organization, in the order given.
 * It reads the organization's recorded periods once, and not at all when
 * every key is a month key. */
export async function usageKeyRanges(
  ctx: QueryCtx,
  orgId: string,
  sub: Doc<'billing_subscriptions'> | null,
  keys: readonly string[],
): Promise<UsageKeyRange[]> {
  const ends = new Map<string, string>()
  if (keys.some((key) => !MONTH_KEY.test(key))) {
    // One row per provider period, so an organization has few of them.
    const periods = await ctx.db
      .query('billing_periods')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    for (const row of periods)
      if (!ends.has(row.period_start)) ends.set(row.period_start, row.period_end)
  }
  return keys.map((key): UsageKeyRange => {
    const month = MONTH_KEY.exec(key)
    if (month) {
      const { start, end } = monthPeriod(Number(month[1]), Number(month[2]) - 1)
      return { kind: 'month', start, end }
    }
    const end = ends.get(key)
    if (end !== undefined) return { kind: 'paid', start: key, end }
    if (sub?.org_id === orgId && sub.current_period_start === key && sub.current_period_end)
      return { kind: 'paid', start: key, end: sub.current_period_end }
    return { kind: 'open', start: key, end: null }
  })
}

/** Fixed minute windows use one stable row per subject. A denied call returns
 * false, so the enclosing mutation commits rather than rolling back its fence. */
export async function consumeMachineRequest(
  ctx: MutationCtx,
  key: string,
  limit: number,
  now = Date.now(),
): Promise<boolean> {
  if (isDemoDeployment()) return true
  const windowStart = Math.floor(now / MACHINE_WINDOW_MS) * MACHINE_WINDOW_MS
  const row = await ctx.db
    .query('machine_rate_limits')
    .withIndex('by_key', (q) => q.eq('key', key))
    .unique()
  if (row?.window_start === windowStart) {
    if (row.count >= limit) return false
    await ctx.db.patch(row._id, { count: row.count + 1 })
  } else if (row) {
    await ctx.db.patch(row._id, { window_start: windowStart, count: 1 })
  } else {
    await ctx.db.insert('machine_rate_limits', { key, window_start: windowStart, count: 1 })
  }
  return true
}

/** One accepted authenticated HTTP request, including malformed/routing
 * refusals. All credentials belonging to a profile share the request limit;
 * per-key usage and the org's pooled total commit together, in the bucket
 * `usagePeriod` picks. Every active profile's call that passes the limit is
 * counted, with or without a subscription or plan. Only a paid period can
 * create billing events; a calendar-month bucket never does. Nothing here is
 * read by the planner snapshot, and no provider call runs in this transaction. */
export async function recordApiCall(
  ctx: MutationCtx,
  args: { profile_id: string; credential_id: string; credential_name: string },
): Promise<boolean> {
  if (isDemoDeployment()) return true
  const profile = await byId(ctx, 'profiles', args.profile_id)
  if (!profile?.active) return true // Dispatch retains the established 401 race refusal.
  const now = Date.now()
  if (!(await consumeMachineRequest(ctx, `profile:${profile.id}`, MACHINE_PROFILE_LIMIT, now)))
    return false
  const sub = await subscriptionFor(ctx, profile.org_id)
  const { kind, key: period } = usagePeriod(sub, now)

  const usage = await ctx.db
    .query('billing_usage')
    .withIndex('by_subject_credential_period', (q) =>
      q
        .eq('org_id', profile.org_id)
        .eq('profile_id', profile.id)
        .eq('credential_id', args.credential_id)
        .eq('period_start', period),
    )
    .unique()
  if (usage) {
    await ctx.db.patch(usage._id, { calls: usage.calls + 1, credential_name: args.credential_name })
  } else {
    await ctx.db.insert('billing_usage', {
      org_id: profile.org_id,
      profile_id: profile.id,
      credential_id: args.credential_id,
      credential_name: args.credential_name,
      period_start: period,
      calls: 1,
    })
  }
  const total = await ctx.db
    .query('billing_usage_totals')
    .withIndex('by_org_period', (q) => q.eq('org_id', profile.org_id).eq('period_start', period))
    .unique()
  const calls = (total?.calls ?? 0) + 1
  const alreadyReported = total?.reported_api_blocks ?? 0
  let reported = alreadyReported
  // A calendar month has no allowance and is never charged, so it skips block
  // accounting entirely. A paid or pending bucket whose plan row is missing
  // cannot size its blocks; it only counts.
  const plan = kind === 'month' || !sub ? null : await byId(ctx, 'billing_plans', sub.plan_id)
  if (sub && plan) {
    const included = includedApiCalls(plan, allowanceSeats(sub))
    const blocks = Math.ceil(Math.max(0, calls - included) / plan.api_block_size)
    const complimentary = !!sub.complimentary_until && Date.parse(sub.complimentary_until) > now
    // A pending interval is never charged (see usagePeriod).
    const chargeable =
      billingEnabled() &&
      !!sub.polar_subscription_id &&
      (sub.status === 'active' || sub.status === 'past_due') &&
      !complimentary &&
      kind === 'paid'
    if (chargeable && blocks > alreadyReported) {
      const timestamp = new Date(now).toISOString()
      await ctx.db.insert('billing_events', {
        id: `${sub.id}:${period}:api:${blocks}`,
        org_id: profile.org_id,
        kind: 'api',
        period_start: period,
        units: blocks - alreadyReported,
        attempts: 0,
        next_attempt_at: timestamp,
        created_at: timestamp,
      })
    }
    // Waived blocks are consumed too: a later activation must not retroactively
    // charge the calls made during a free period or before billing was enabled.
    reported = Math.max(alreadyReported, blocks)
  }
  const values = { calls, reported_api_blocks: reported }
  if (total) await ctx.db.patch(total._id, values)
  else
    await ctx.db.insert('billing_usage_totals', {
      org_id: profile.org_id,
      period_start: period,
      ...values,
    })
  return true
}
