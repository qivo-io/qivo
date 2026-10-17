/* When an organization's data is kept, and when its deletion is scheduled.
 * orgRemovals.ts runs the jobs; model/orgDeletion.ts deletes the data.
 *
 * When an organization's service ends, it stays read-only for RETENTION_DAYS
 * so its admins can export it, then everything it owns is deleted. The
 * service ends when an admin cancels the subscription or asks for deletion,
 * when Polar ends a subscription, or when complimentary access ends without
 * a paid subscription. Overdue payments only pause editing. An organization
 * that has not completed checkout CHECKOUT_DAYS after enrollment is deleted
 * without that period: every write waits for checkout, so it holds nothing
 * customers made. The terms of service promise these periods.
 *
 * Admins are emailed when the period starts, unless one of them finished an
 * export within EXPORT_FRESH_DAYS before the service ended. */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import {
  billingEnabled,
  orgRemovalFor,
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

/** When billing ended the organization's service, or null while it
 * continues. Overdue, unpaid and paused subscriptions only pause editing,
 * and an organization still waiting for its first checkout is handled by
 * noCheckoutDue. */
export function serviceEndedAt(
  sub: Doc<'billing_subscriptions'> | null,
  now = Date.now(),
): string | null {
  if (!billingEnabled() || !sub || subscriptionWritable(sub, now)) return null
  if (sub.ended_at && Date.parse(sub.ended_at) <= now) return sub.ended_at
  if (sub.status === 'canceled') return sub.updated_at
  if (sub.status === 'pending' && sub.complimentary_until) return sub.complimentary_until
  return null
}

/** Whether an organization has gone CHECKOUT_DAYS without completing
 * checkout. Organizations enrolled before billing started have no
 * checkout_due_at and never qualify. A checkout still being prepared waits;
 * orgRemovals.ts asks Polar about any other checkout before deleting. */
export function noCheckoutDue(sub: Doc<'billing_subscriptions'> | null, now = Date.now()): boolean {
  return (
    billingEnabled() &&
    !!sub &&
    sub.status === 'pending' &&
    !!sub.checkout_due_at &&
    Date.parse(sub.checkout_due_at) <= now &&
    !sub.complimentary_until &&
    !sub.polar_subscription_id &&
    !(sub.checkout_lock_until && Date.parse(sub.checkout_lock_until) > now)
  )
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
    if (accessReturned(removal, sub, now)) await ctx.db.delete(removal._id)
    return
  }
  const endedAt = serviceEndedAt(sub, now)
  if (endedAt) await scheduleRemoval(ctx, { orgId, reason: 'service_ended', endedAt })
}

/* One notice per active admin with an address, keyed by the removal so a
 * repeated call cannot send twice. orgRemovals.ts delivers them. */
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
