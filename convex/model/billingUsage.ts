import type { MutationCtx } from '../_generated/server'
import { billingEnabled, subscriptionFor } from '../lib/billingAccess'
import { byId } from '../lib/db'
import { isDemoDeployment } from '../lib/demo'

export const MACHINE_WINDOW_MS = 60_000
export const MACHINE_PROFILE_LIMIT = 300
export const MACHINE_INGRESS_LIMIT = 6_000

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
 * per-key usage and the org's pooled total commit together. Nothing here is
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
  // A webhook can arrive after renewal. Preserve requests in the pending new
  // interval, never add them to the closed invoice or charge an unconfirmed
  // allowance. Reconciliation adopts the same boundary when the provider's
  // new period is known. The interval stays waived if confirmation never comes.
  const stalePeriod = !!sub?.current_period_end && now >= Date.parse(sub.current_period_end)
  const period = stalePeriod
    ? sub?.current_period_end
    : (sub?.current_period_start ?? sub?.complimentary_start)
  if (!sub || !period) return true
  const plan = await byId(ctx, 'billing_plans', sub.plan_id)
  if (!plan) return true

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
  const included =
    Math.max(plan.minimum_seats, sub.billed_seats || sub.next_seats) * plan.api_calls_per_seat
  const blocks = Math.ceil(Math.max(0, calls - included) / plan.api_block_size)
  const alreadyReported = total?.reported_api_blocks ?? 0
  const complimentary = !!sub.complimentary_until && Date.parse(sub.complimentary_until) > now
  const chargeable =
    billingEnabled() &&
    !!sub.polar_subscription_id &&
    (sub.status === 'active' || sub.status === 'past_due') &&
    !complimentary &&
    !stalePeriod
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
  const values = { calls, reported_api_blocks: Math.max(alreadyReported, blocks) }
  if (total) await ctx.db.patch(total._id, values)
  else
    await ctx.db.insert('billing_usage_totals', {
      org_id: profile.org_id,
      period_start: period,
      ...values,
    })
  return true
}
