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

/* The refusal every write gets while billing pauses editing, and the reason
 * get_me reports for it. */
export const BILLING_READ_ONLY =
  'This organization is read-only. An organization admin can subscribe or update payment details in Billing.'

/** The refusal while an organization waits for deletion, with its date. */
export function deletionReadOnly(deleteAfter: string): string {
  return `This organization is read-only and will be deleted on ${deleteAfter.slice(0, 10)}. An organization admin can export its data in Settings.`
}

/** The organization's pending or running deletion (orgRemovals.ts), or null. */
export async function orgRemovalFor(ctx: QueryCtx, orgId: string) {
  return await ctx.db
    .query('org_removals')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .unique()
}

export type WriteBlock = { reason: 'billing_required' | 'deletion_scheduled'; message: string }

/** Why writes to the organization are refused, or null while they are
 * allowed. A pending deletion wins over billing: a deletion an admin asked
 * for stays in force whatever the subscription does. */
export async function orgWriteBlock(ctx: QueryCtx, orgId: string): Promise<WriteBlock | null> {
  const removal = await orgRemovalFor(ctx, orgId)
  if (removal)
    return { reason: 'deletion_scheduled', message: deletionReadOnly(removal.delete_after) }
  if (billingEnabled() && !subscriptionWritable(await subscriptionFor(ctx, orgId)))
    return { reason: 'billing_required', message: BILLING_READ_ONLY }
  return null
}

/** Refuses a write while billing or a pending deletion makes the
 * organization read-only. */
export async function assertOrgWritable(ctx: QueryCtx, orgId: string): Promise<void> {
  const block = await orgWriteBlock(ctx, orgId)
  if (block) throw new ConvexError({ code: 'forbidden', ...block })
}

/** Refuses every call into an organization whose deletion has begun. Before
 * that, the organization stays readable so admins can export it. */
export async function assertOrgAvailable(ctx: QueryCtx, orgId: string): Promise<void> {
  const removal = await orgRemovalFor(ctx, orgId)
  if (removal?.phase !== undefined)
    throw new ConvexError({ code: 'forbidden', message: 'this organization is being deleted' })
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
