import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

export const billingEnabled = () =>
  process.env.BILLING_ENABLED === 'true' && process.env.APP_MODE !== 'demo'

export async function subscriptionFor(ctx: QueryCtx, orgId: string) {
  return await ctx.db
    .query('billing_subscriptions')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()
}

export function subscriptionWritable(sub: Doc<'billing_subscriptions'> | null, now = Date.now()) {
  if (!billingEnabled()) return true
  if (!sub) return false
  if (sub.complimentary_until && Date.parse(sub.complimentary_until) > now) return true
  if (sub.ended_at && Date.parse(sub.ended_at) <= now) return false
  if (sub.cancel_at_period_end)
    return (
      !!sub.current_period_end &&
      Date.parse(sub.current_period_end) > now &&
      ['active', 'trialing', 'canceled'].includes(sub.status)
    )
  // Paid access is bounded by the verified provider period. A short delivery
  // grace keeps a delayed renewal webhook from interrupting a paying team.
  if (sub.status === 'active' || sub.status === 'trialing')
    return !!sub.current_period_end && Date.parse(sub.current_period_end) + 24 * 60 * 60_000 > now
  if (sub.status === 'past_due')
    return !!sub.past_due_at && Date.parse(sub.past_due_at) + 7 * 24 * 60 * 60_000 > now
  return false
}

export async function assertBillingWritable(ctx: QueryCtx, orgId: string): Promise<void> {
  if (!billingEnabled() || subscriptionWritable(await subscriptionFor(ctx, orgId))) return
  throw new ConvexError({
    code: 'forbidden',
    reason: 'billing_required',
    message:
      'This organization is read-only. An organization admin can subscribe or update payment details in Billing.',
  })
}

export function addCalendarMonths(iso: string, months: number): string {
  const d = new Date(iso)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const end = new Date(d.getTime())
  end.setUTCMonth(end.getUTCMonth() + 1, 0)
  d.setUTCDate(Math.min(day, end.getUTCDate()))
  return d.toISOString()
}
