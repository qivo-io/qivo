/* When an organization's data is kept, and when its deletion is scheduled.
 * orgRemovals.ts runs the jobs; model/orgDeletion.ts deletes the data.
 *
 * When an organization's service ends, it stays read-only for RETENTION_DAYS
 * so its admins can export it, then everything it owns is deleted. The
 * service ends when an admin asks for deletion, when Polar ends a
 * subscription, including a cancelled one at the end of its paid period, or
 * when complimentary access ends without a paid subscription. Overdue
 * payments only pause editing. An organization
 * that has not completed checkout CHECKOUT_DAYS after enrollment is deleted
 * without that period: every write waits for checkout, so it holds nothing
 * customers made. The terms of service promise these periods.
 *
 * Admins are emailed when the period starts, unless one of them finished an
 * export within EXPORT_FRESH_DAYS before the service ended. */

import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import {
  accessAt,
  billingEnabled,
  orgRemovalFor,
  PAST_DUE_GRACE_MS,
  RENEWAL_GRACE_MS,
  subscriptionFor,
  subscriptionWritable,
} from '../lib/billingAccess'
import { byId } from '../lib/db'
import type { OrgRemovalReason } from '../lib/enums'

export const RETENTION_DAYS = 30
export const CHECKOUT_DAYS = 3
export const EXPORT_FRESH_DAYS = 7
export const DAY_MS = 86_400_000

/** The notice kind stored on billing_notices for a deletion email. */
export const DELETION_NOTICE = 'deletion'

const sendNoticeRef = makeFunctionReference<'action', { notice_key: string }, null>(
  'orgRemovals:sendNotice',
)

type Subscription = WithoutSystemFields<Doc<'billing_subscriptions'>>

/** When billing ended the organization's service, or null while it
 * continues. Overdue, unpaid and paused subscriptions only pause editing,
 * and an organization still waiting for its first checkout is handled by
 * noCheckoutDue. */
export function serviceEndedAt(sub: Subscription | null, now = Date.now()): string | null {
  if (!billingEnabled() || !sub) return null
  return endedAt(sub, now)
}

/* serviceEndedAt as if billing were on. */
function endedAt(sub: Subscription, now: number): string | null {
  if (accessAt(sub, now)) return null
  if (sub.ended_at && Date.parse(sub.ended_at) <= now) return sub.ended_at
  if (sub.status === 'canceled') return sub.updated_at
  if (sub.status === 'pending' && sub.complimentary_until) return sub.complimentary_until
  return null
}

/** The checkout deadline that applies to an organization, or null. Only an
 * organization enrolled while billing runs has one, and complimentary access
 * or a provider subscription ends it for good. */
export function checkoutDeadline(sub: Subscription | null): string | null {
  if (!billingEnabled() || !sub) return null
  return deadlineOf(sub)
}

/* checkoutDeadline as if billing were on. */
function deadlineOf(sub: Subscription): string | null {
  if (sub.status !== 'pending' || sub.complimentary_until || sub.polar_subscription_id) return null
  return sub.checkout_due_at ?? null
}

/** Whether an organization has gone CHECKOUT_DAYS without completing
 * checkout. Organizations enrolled before billing started have no
 * checkout_due_at and never qualify. A checkout still being prepared waits;
 * orgRemovals.ts asks Polar about any other checkout before deleting. */
export function noCheckoutDue(sub: Subscription | null, now = Date.now()): boolean {
  const due = checkoutDeadline(sub)
  return (
    !!due &&
    Date.parse(due) <= now &&
    !(sub?.checkout_lock_until && Date.parse(sub.checkout_lock_until) > now)
  )
}

/** When the hourly sweep (orgRemovals.ts) next needs to read a subscription:
 * the first time at which its service has ended (serviceEndedAt) or its
 * checkout deadline has passed (noCheckoutDue) if nothing writes the row
 * meanwhile, as if billing were on, or null when neither can happen without
 * a write. Neither undoes itself as time passes, so it is the first of the
 * times the row names at which one of them holds. A checkout being prepared
 * is left out, so the time is never later than either; the sweep reads the
 * row again an hour later. Every write to these fields stores it as
 * retention_at. */
export function retentionDue(sub: Subscription): string | null {
  const after = (at: string | undefined, ms: number) => (at ? Date.parse(at) + ms : null)
  const times = [
    after(sub.created_at, 0),
    after(sub.complimentary_until, 0),
    after(sub.ended_at, 0),
    after(sub.current_period_end, 0),
    after(sub.current_period_end, RENEWAL_GRACE_MS),
    after(sub.past_due_at, PAST_DUE_GRACE_MS),
    after(sub.checkout_due_at, 0),
  ]
  const deadline = deadlineOf(sub)
  let due: number | null = null
  for (const at of times) {
    if (at === null || Number.isNaN(at) || (due !== null && at >= due)) continue
    if (endedAt(sub, at) !== null || (deadline !== null && Date.parse(deadline) <= at)) due = at
  }
  return due === null ? null : new Date(due).toISOString()
}

/** Starts the read-only period before an organization's deletion and emails
 * its admins when no recent export exists. An existing removal is kept, so
 * its date never moves later. An admin's request upgrades a billing-driven
 * removal, so a later subscription no longer stops it. The deletion date
 * counts from now, so admins always get the full period after the notice,
 * even when the service ended before a sweep noticed. */
export async function scheduleRemoval(
  ctx: MutationCtx,
  a: { orgId: string; reason: OrgRemovalReason; endedAt: string; requestedBy?: string },
): Promise<Doc<'org_removals'>> {
  const existing = await orgRemovalFor(ctx, a.orgId)
  if (existing) {
    if (a.reason === 'requested' && existing.phase === undefined && existing.reason !== 'requested')
      await ctx.db.patch(existing._id, { reason: 'requested', requested_by: a.requestedBy })
    return (await ctx.db.get(existing._id)) as Doc<'org_removals'>
  }
  const now = Date.now()
  const id = await ctx.db.insert('org_removals', {
    org_id: a.orgId,
    reason: a.reason,
    ended_at: a.endedAt,
    delete_after: new Date(
      a.reason === 'no_checkout' ? now : now + RETENTION_DAYS * DAY_MS,
    ).toISOString(),
    ...(a.requestedBy ? { requested_by: a.requestedBy } : {}),
    created_at: new Date(now).toISOString(),
  })
  const removal = (await ctx.db.get(id)) as Doc<'org_removals'>
  if (a.reason !== 'no_checkout') await queueDeletionNotices(ctx, removal)
  return removal
}

/** Whether a billing-driven removal that has not begun should stop, because
 * paid or complimentary access returned or billing was switched off.
 * Requested and no-checkout removals never stop this way. */
export function accessReturned(
  removal: Doc<'org_removals'>,
  sub: Doc<'billing_subscriptions'> | null,
  now = Date.now(),
): boolean {
  return (
    removal.phase === undefined &&
    removal.reason === 'service_ended' &&
    subscriptionWritable(sub, now)
  )
}

/** Brings a billing-driven removal in line with the subscription. It starts
 * the read-only period once the service has ended, and stops it when
 * accessReturned. */
export async function syncOrgRemoval(
  ctx: MutationCtx,
  orgId: string,
  now = Date.now(),
): Promise<void> {
  const sub = await subscriptionFor(ctx, orgId)
  const removal = await orgRemovalFor(ctx, orgId)
  if (removal) {
    if (accessReturned(removal, sub, now)) await dropRemoval(ctx, removal)
    return
  }
  const endedAt = serviceEndedAt(sub, now)
  if (endedAt) await scheduleRemoval(ctx, { orgId, reason: 'service_ended', endedAt })
}

/** Deletes a removal that has not begun. The hourly sweep leaves the
 * subscription of an organization with a removal until the removal's date
 * (orgRemovals.ts), so this sets when it next reads it. */
export async function dropRemoval(ctx: MutationCtx, removal: Doc<'org_removals'>): Promise<void> {
  await ctx.db.delete(removal._id)
  const sub = await subscriptionFor(ctx, removal.org_id)
  if (sub) await ctx.db.patch(sub._id, { retention_at: retentionDue(sub) })
}

/** Queues one notice per active admin with an address, keyed by the
 * removal so a repeated call cannot send twice. orgRemovals.ts delivers
 * them. */
async function queueDeletionNotices(ctx: MutationCtx, removal: Doc<'org_removals'>) {
  const org = await byId(ctx, 'organizations', removal.org_id)
  if (!org) return
  const freshAfter = Date.parse(removal.ended_at) - EXPORT_FRESH_DAYS * DAY_MS
  if (org.last_export_at && Date.parse(org.last_export_at) >= freshAfter) return
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', removal.org_id))
    .collect()
  for (const profile of profiles) {
    if (!profile.active || profile.org_role !== 'admin' || !profile.email) continue
    const key = deletionNoticeKey(removal, profile.id)
    if (
      await ctx.db
        .query('billing_notices')
        .withIndex('by_key', (q) => q.eq('key', key))
        .unique()
    )
      continue
    await ctx.db.insert('billing_notices', {
      key,
      org_id: removal.org_id,
      profile_id: profile.id,
      kind: DELETION_NOTICE,
      created_at: new Date().toISOString(),
    })
    await ctx.scheduler.runAfter(0, sendNoticeRef, { notice_key: key })
  }
}

/** The notice key for one admin's deletion email. */
export const deletionNoticeKey = (removal: Doc<'org_removals'>, profileId: string) =>
  `${removal.org_id}:${removal.created_at}:${profileId}:${DELETION_NOTICE}`
