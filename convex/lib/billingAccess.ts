import type { WithoutSystemFields } from 'convex/server'
import { ConvexError } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { RemovedAccessKind } from './enums'

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
  return !!sub && accessAt(sub, now)
}

/** How long paid access lasts after its period ends, so a delayed renewal
 * webhook does not interrupt a paying team. */
export const RENEWAL_GRACE_MS = 24 * 60 * 60_000

/** How long a subscription stays writable after Polar reports it past due. */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60_000

/** Whether the subscription gives paid or complimentary access at `now`, as
 * if billing were on. Access only ends as time passes; only a write can
 * return it. */
export function accessAt(sub: WithoutSystemFields<Doc<'billing_subscriptions'>>, now: number) {
  if (sub.complimentary_until && Date.parse(sub.complimentary_until) > now) return true
  if (sub.ended_at && Date.parse(sub.ended_at) <= now) return false
  if (sub.cancel_at_period_end)
    return (
      !!sub.current_period_end &&
      Date.parse(sub.current_period_end) > now &&
      ['active', 'trialing', 'canceled'].includes(sub.status)
    )
  // Paid access is bounded by the verified provider period.
  if (sub.status === 'active' || sub.status === 'trialing')
    return !!sub.current_period_end && Date.parse(sub.current_period_end) + RENEWAL_GRACE_MS > now
  if (sub.status === 'past_due')
    return !!sub.past_due_at && Date.parse(sub.past_due_at) + PAST_DUE_GRACE_MS > now
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

/** Whether the organization's deletion has begun: orgRemovals.ts has set
 * its first phase. Its read-only period before that does not count. */
export async function deletionBegun(ctx: QueryCtx, orgId: string): Promise<boolean> {
  return (await orgRemovalFor(ctx, orgId))?.phase !== undefined
}

/** The refusal of every call into an organization whose deletion has begun,
 * in the app, REST and MCP. */
export const ORG_DELETING = 'this organization is being deleted'

/** Refuses every call into an organization whose deletion has begun. Before
 * that, the organization stays readable so admins can export it. */
export async function assertOrgAvailable(ctx: QueryCtx, orgId: string): Promise<void> {
  if (await deletionBegun(ctx, orgId))
    throw new ConvexError({ code: 'forbidden', message: ORG_DELETING })
}

/** Whether the deletion of `orgId` has begun and the organization is still
 * there. Its last steps delete what the deletion recorded (removed_access)
 * after the organization, so from then on every call gets the answer it
 * gets once the deletion is over. */
async function deletionRunning(ctx: QueryCtx, orgId: string): Promise<boolean> {
  if (!(await deletionBegun(ctx, orgId))) return false
  const org = await ctx.db
    .query('organizations')
    .withIndex('by_uuid', (q) => q.eq('id', orgId))
    .unique()
  return org !== null
}

/** Whether the running deletion of an organization deleted the access `key`
 * names (removed_access): a login's seat in `orgId`, or a profile or
 * credential of any organization. A call through such access is refused
 * like every other call into that organization, with ORG_DELETING, rather
 * than as a stranger's or an unknown credential's. False once the
 * organization is gone. */
export async function removedWithOrg(
  ctx: QueryCtx,
  kind: RemovedAccessKind,
  key: string,
  orgId?: string,
): Promise<boolean> {
  const removed = await ctx.db
    .query('removed_access')
    .withIndex('by_key', (q) =>
      orgId === undefined
        ? q.eq('kind', kind).eq('key', key)
        : q.eq('kind', kind).eq('key', key).eq('org_id', orgId),
    )
    .first()
  return removed !== null && (await deletionRunning(ctx, removed.org_id))
}

/** Whether `profile` is its login's home seat: accepted, and not a guest's.
 * A login holds one at most, and while it holds one it cannot create an
 * organization (identity.ts createOrganization). */
export const isHomeSeat = (profile: Pick<Doc<'profiles'>, 'org_role' | 'accepted_at'>) =>
  profile.org_role !== 'guest' && profile.accepted_at !== undefined

/** When a login whose seats a running organization deletion holds may
 * create an organization: `now` with no home seat, `after_deletion` while
 * the deletion has not deleted its home seat yet, which its first phase
 * does, and `blocked` while an organization that is not being deleted
 * holds it, as a deactivated member's. */
export type SeatlessCreate = 'now' | 'after_deletion' | 'blocked'

/** Whether a running organization deletion holds a seat of the login
 * `authUserId`, and if so when it may create an organization
 * (SeatlessCreate), or null. A held seat is a profile the deletion has not
 * deleted yet, active or not, or one it has (removed_access). The app's
 * root part asks this only for a login with no seat left elsewhere
 * (lib/workspaceParts.ts readRoot), so it can say why and what the login
 * can do. */
export async function seatHeldByDeletion(
  ctx: QueryCtx,
  authUserId: string,
): Promise<SeatlessCreate | null> {
  let held = false
  let home: Doc<'profiles'> | undefined
  const profiles = ctx.db
    .query('profiles')
    .withIndex('by_auth', (q) => q.eq('auth_user_id', authUserId))
  for await (const profile of profiles) {
    if (isHomeSeat(profile)) home = profile
    if (!held) held = await deletionBegun(ctx, profile.org_id)
  }
  if (!held) {
    const removed = ctx.db
      .query('removed_access')
      .withIndex('by_key', (q) => q.eq('kind', 'login').eq('key', authUserId))
    for await (const row of removed) {
      held = await deletionRunning(ctx, row.org_id)
      if (held) break
    }
  }
  if (!held) return null
  if (home === undefined) return 'now'
  return (await deletionBegun(ctx, home.org_id)) ? 'after_deletion' : 'blocked'
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
