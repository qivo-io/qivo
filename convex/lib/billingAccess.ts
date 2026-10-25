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

/** Whether `profile` is a home seat of its login: accepted, and not a
 * guest's. Joining demotes a second one to a guest (identity.ts), though an
 * admin who promotes a guest can give a login two. While a login holds any,
 * active or not, it cannot create an organization (identity.ts
 * createOrganization), which OrgCreate tells the app. */
export const isHomeSeat = (profile: Pick<Doc<'profiles'>, 'org_role' | 'accepted_at'>) =>
  profile.org_role !== 'guest' && profile.accepted_at !== undefined

/** When a login may create an organization, as createOrganization decides
 * it: `now` with no home seat, `after_deletion` while running organization
 * deletions hold its only home seats, which their first phase deletes, and
 * `blocked` while an organization that is not being deleted holds one,
 * active or not, as a deactivated member's, or on the demo, which creates
 * none. createOrganization refuses exactly while it is not `now`. */
export type OrgCreate = 'now' | 'after_deletion' | 'blocked'

/** The login's profiles judged for a new organization: when it may create
 * one (OrgCreate), and whether a running organization deletion holds one of
 * its profiles. */
async function seatsOfLogin(
  ctx: QueryCtx,
  authUserId: string,
): Promise<{ create: OrgCreate; held: boolean }> {
  let held = false
  // whether a home seat is in an organization that is not being deleted
  let kept = false
  let homes = 0
  const profiles = ctx.db
    .query('profiles')
    .withIndex('by_auth', (q) => q.eq('auth_user_id', authUserId))
  for await (const profile of profiles) {
    const deleting = await deletionBegun(ctx, profile.org_id)
    held ||= deleting
    if (!isHomeSeat(profile)) continue
    homes += 1
    kept ||= !deleting
  }
  // createOrganization refuses the demo before it looks at any seat
  const create =
    process.env.APP_MODE === 'demo' || kept ? 'blocked' : homes === 0 ? 'now' : 'after_deletion'
  return { create, held }
}

/** When the login `authUserId` may create an organization (OrgCreate). The
 * app's root part tells it to a login with a seat (lib/workspaceParts.ts
 * readRoot), and the app offers creation only for `now`. It reads the
 * ranges the login's memberships already read (lib/functions.ts). */
export async function orgCreateFor(ctx: QueryCtx, authUserId: string): Promise<OrgCreate> {
  return (await seatsOfLogin(ctx, authUserId)).create
}

/** What the root part tells the login `authUserId` when it has no seat it
 * can open (lib/workspaceParts.ts readRoot): whether a running organization
 * deletion holds one of its seats, and when it may create an organization
 * (OrgCreate). A held seat is a profile the deletion has not deleted yet,
 * active or not, or one it has (removed_access). Null for a login that may
 * create an organization and that no deletion holds, as a new one. Without a
 * deletion the answer is `blocked`, from a seat the login cannot open, as a
 * deactivated member's. */
export async function seatlessState(
  ctx: QueryCtx,
  authUserId: string,
): Promise<{ deleting: boolean; create: OrgCreate } | null> {
  const { create, held } = await seatsOfLogin(ctx, authUserId)
  let deleting = held
  if (!deleting) {
    const removed = ctx.db
      .query('removed_access')
      .withIndex('by_key', (q) => q.eq('kind', 'login').eq('key', authUserId))
    for await (const row of removed) {
      deleting = await deletionRunning(ctx, row.org_id)
      if (deleting) break
    }
  }
  if (!deleting && create === 'now') return null
  return { deleting, create }
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
