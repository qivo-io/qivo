/* Organization retention and deletion jobs (rules in model/orgRetention.ts,
 * deletion steps in model/orgDeletion.ts).
 *
 * `sweep` runs every hour (crons.ts). It starts the read-only period for
 * organizations whose billing ended, stops it when access returns or billing
 * is switched off, hands organizations that never completed checkout to
 * `verifyNoCheckout`, and hands removals whose date has passed to `begin`.
 * Both ask Polar first, so a lost webhook cannot delete an organization that
 * pays. `begin` then sets the first phase, which ends all access
 * (lib/billingAccess.ts), and `step` deletes in bounded transactions until
 * nothing is left. Convex drops the calls a failed mutation scheduled, so
 * `recover` (every ten minutes) restarts a deletion whose step stalled, as
 * labelRemovals.ts does.
 *
 * Admins act through `request` (delete the organization, ending any paid
 * subscription at once), `keep` (stop a deletion they asked for) and
 * `recordExport`, which the export panel calls once the browser has built
 * the archive. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server'
import { subscriptionPayload } from './billingSync'
import {
  assertOrgAvailable,
  billingEnabled,
  orgRemovalFor,
  subscriptionFor,
  subscriptionWritable,
} from './lib/billingAccess'
import { byId } from './lib/db'
import { refuseDemoFeature } from './lib/demo'
import {
  authedMutation,
  forbidden,
  notFound,
  orgAction,
  orgQuery,
  require,
  rule,
} from './lib/functions'
import {
  getPolarCheckout,
  LIVE_POLAR_STATUSES,
  listPolarSubscriptions,
  PolarError,
  polarConfigured,
  revokePolarSubscription,
} from './lib/polar'
import { sendDeletionNotice } from './mail'
import { audit } from './model/admin'
import { deleteOrgStep } from './model/orgDeletion'
import {
  accessReturned,
  DELETION_NOTICE,
  deletionNoticeKey,
  noCheckoutDue,
  scheduleRemoval,
  serviceEndedAt,
  syncOrgRemoval,
} from './model/orgRetention'

/** A deletion whose last step committed longer ago than this is restarted. */
export const STALLED_MS = 5 * 60_000
const RECOVER_BATCH = 32
const RECOVER_SCAN = 512
const DUE_BATCH = 32
/* Removals one sweep starts or stops; each start may queue an email per
 * admin. */
const SWEEP_CHANGES = 32
/* Checkout deadlines one sweep hands to Polar. */
const CHECK_BATCH = 64

const isoNow = () => new Date().toISOString()

const orgArg = { org_id: v.string() }
type OrgArg = { org_id: string }
const stepRef = makeFunctionReference<'mutation', OrgArg, null>('orgRemovals:step')
const beginRef = makeFunctionReference<'action', OrgArg, null>('orgRemovals:begin')
const beginDueRef = makeFunctionReference<'query', OrgArg, boolean>('orgRemovals:beginDue')
const abortRef = makeFunctionReference<'mutation', OrgArg, null>('orgRemovals:abort')
const markDeletingRef = makeFunctionReference<'mutation', OrgArg, null>('orgRemovals:markDeleting')
const verifyNoCheckoutRef = makeFunctionReference<'action', OrgArg, null>(
  'orgRemovals:verifyNoCheckout',
)
const noCheckoutCandidateRef = makeFunctionReference<
  'query',
  OrgArg,
  { checkout_id: string | null } | null
>('orgRemovals:noCheckoutCandidate')
const startNoCheckoutRef = makeFunctionReference<'mutation', OrgArg, null>(
  'orgRemovals:startNoCheckout',
)
const recordRequestRef = makeFunctionReference<
  'mutation',
  { org_id: string; auth_user_id: string },
  { delete_after: string }
>('orgRemovals:recordRequest')
const applyRef = makeFunctionReference<'mutation', { payload: string }, null>('billingSync:apply')
const reconcileRef = makeFunctionReference<'action', OrgArg, null>('billingSync:reconcile')
type Delivery = { to: string; org_name: string; delete_after: string; reason: string; url: string }
const noticeReadyRef = makeFunctionReference<'query', { key: string }, Delivery | null>(
  'orgRemovals:noticeReady',
)
const noticeSentRef = makeFunctionReference<'mutation', { key: string }, null>(
  'orgRemovals:noticeSent',
)
const sendNoticeRef = makeFunctionReference<
  'action',
  { notice_key: string; attempt?: number },
  null
>('orgRemovals:sendNotice')

/** Ends every live Polar subscription of the organization at once and
 * records the result locally, so a deletion never leaves one billing. A
 * Polar failure becomes a readable refusal, and nothing is scheduled. */
export async function revokeLiveSubscriptions(
  ctx: Pick<ActionCtx, 'runMutation'>,
  orgId: string,
): Promise<number> {
  if (!billingEnabled() || !polarConfigured()) return 0
  let revoked = 0
  try {
    for (const subscription of await listPolarSubscriptions(orgId)) {
      if (!LIVE_POLAR_STATUSES.includes(subscription.status)) continue
      const ended = await revokePolarSubscription(subscription.id)
      await ctx.runMutation(applyRef, { payload: subscriptionPayload(ended) })
      revoked += 1
    }
  } catch (error) {
    if (error instanceof PolarError)
      throw rule('Polar could not end the subscription. Try again later.')
    throw error
  }
  return revoked
}

/* Sets the first phase, which refuses all access from here on, and starts
 * the steps. */
async function beginDeletion(ctx: MutationCtx, orgId: string): Promise<void> {
  const removal = await orgRemovalFor(ctx, orgId)
  if (!removal || removal.phase !== undefined) return
  const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { org_id: orgId })
  await ctx.db.patch(removal._id, { phase: 'profiles', progress_at: isoNow(), scheduled_id })
  console.info('Organization deletion started', { org_id: orgId, reason: removal.reason })
}

/* Both tables are read whole, so one run costs a few lookups per change
 * rather than per organization. What a run leaves waits for the next hour;
 * billing webhooks make the same changes at once (billingSync.ts). */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const subs = billingEnabled() ? await ctx.db.query('billing_subscriptions').collect() : []
    const subFor = new Map(subs.map((sub) => [sub.org_id, sub]))
    const removals = await ctx.db.query('org_removals').collect()
    const removed = new Set(removals.map((removal) => removal.org_id))
    let changes = 0
    let checks = 0
    for (const removal of removals) {
      if (changes === SWEEP_CHANGES) break
      if (!accessReturned(removal, subFor.get(removal.org_id) ?? null, now)) continue
      await ctx.db.delete(removal._id)
      changes += 1
    }
    for (const sub of subs) {
      if (removed.has(sub.org_id)) continue
      const endedAt = serviceEndedAt(sub, now)
      if (endedAt && changes < SWEEP_CHANGES) {
        await scheduleRemoval(ctx, { orgId: sub.org_id, reason: 'service_ended', endedAt })
        changes += 1
      } else if (!endedAt && checks < CHECK_BATCH && polarConfigured() && noCheckoutDue(sub, now)) {
        await ctx.scheduler.runAfter(0, verifyNoCheckoutRef, { org_id: sub.org_id })
        checks += 1
      }
    }
    const due = await ctx.db
      .query('org_removals')
      .withIndex('by_delete_after', (q) => q.lte('delete_after', new Date(now).toISOString()))
      .filter((q) => q.eq(q.field('phase'), undefined))
      .take(DUE_BATCH)
    for (const removal of due) await ctx.scheduler.runAfter(0, beginRef, { org_id: removal.org_id })
    return null
  },
})

export const noCheckoutCandidate = internalQuery({
  args: orgArg,
  handler: async (ctx, { org_id }) => {
    const sub = await subscriptionFor(ctx, org_id)
    if (!sub || !noCheckoutDue(sub) || (await orgRemovalFor(ctx, org_id))) return null
    return { checkout_id: sub.checkout_id ?? null }
  },
})

/** Deletes an organization whose checkout deadline passed, once Polar
 * confirms it has no subscription and no checkout that is open or
 * completing. Any doubt waits for the next sweep. */
export const verifyNoCheckout = internalAction({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    if (!billingEnabled() || !polarConfigured()) return null
    const candidate = await ctx.runQuery(noCheckoutCandidateRef, { org_id })
    if (!candidate) return null
    try {
      if ((await listPolarSubscriptions(org_id)).length > 0) {
        await ctx.scheduler.runAfter(0, reconcileRef, { org_id })
        return null
      }
      if (candidate.checkout_id) {
        const session = await getPolarCheckout(candidate.checkout_id)
        if (session.status !== 'expired' && session.status !== 'failed') return null
      }
    } catch (error) {
      console.warn('Checkout deadline check deferred', { org_id, error: String(error) })
      return null
    }
    await ctx.runMutation(startNoCheckoutRef, { org_id })
    return null
  },
})

export const startNoCheckout = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    const sub = await subscriptionFor(ctx, org_id)
    if (!noCheckoutDue(sub) || (await orgRemovalFor(ctx, org_id))) return null
    await scheduleRemoval(ctx, { orgId: org_id, reason: 'no_checkout', endedAt: isoNow() })
    await beginDeletion(ctx, org_id)
    return null
  },
})

export const beginDue = internalQuery({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<boolean> => {
    const removal = await orgRemovalFor(ctx, org_id)
    return (
      !!removal && removal.phase === undefined && Date.parse(removal.delete_after) <= Date.now()
    )
  },
})

/** Begins a deletion whose date has passed, unless Polar still has a live
 * subscription for the organization. Then the deletion stops and billing is
 * reconciled, because someone subscribed again or a webhook was lost. */
export const begin = internalAction({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    if (!(await ctx.runQuery(beginDueRef, { org_id }))) return null
    if (billingEnabled() && polarConfigured()) {
      let live: boolean
      try {
        live = (await listPolarSubscriptions(org_id)).some((subscription) =>
          LIVE_POLAR_STATUSES.includes(subscription.status),
        )
      } catch (error) {
        console.warn('Organization deletion deferred', { org_id, error: String(error) })
        return null
      }
      if (live) {
        await ctx.runMutation(abortRef, { org_id })
        await ctx.scheduler.runAfter(0, reconcileRef, { org_id })
        return null
      }
    }
    await ctx.runMutation(markDeletingRef, { org_id })
    return null
  },
})

export const abort = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    const removal = await orgRemovalFor(ctx, org_id)
    if (!removal || removal.phase !== undefined) return null
    await ctx.db.delete(removal._id)
    console.warn('Organization deletion stopped because a subscription is live', {
      org_id,
      reason: removal.reason,
    })
    return null
  },
})

export const markDeleting = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    // access that returned since the sweep stops the deletion instead
    await syncOrgRemoval(ctx, org_id)
    const removal = await orgRemovalFor(ctx, org_id)
    if (!removal || removal.phase !== undefined) return null
    if (Date.parse(removal.delete_after) > Date.now()) return null
    await beginDeletion(ctx, org_id)
    return null
  },
})

/** One bounded step of a deletion. Safe to run twice or after the removal
 * row is gone. */
export const step = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    const removal = await orgRemovalFor(ctx, org_id)
    if (!removal || removal.phase === undefined) return null
    if (await deleteOrgStep(ctx, removal)) {
      console.info('Organization deletion completed', {
        org_id,
        reason: removal.reason,
        lag_ms: Math.max(0, Date.now() - Date.parse(removal.delete_after)),
      })
      return null
    }
    const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { org_id })
    await ctx.db.patch(removal._id, { progress_at: isoNow(), scheduled_id })
    return null
  },
})

/** Restarts deletions whose last step committed more than STALLED_MS ago.
 * A deletion whose next step still waits or runs is left alone. Removals
 * still in their read-only period have no progress_at, and the lower bound
 * keeps them out of the range (a missing field sorts before every string). */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const stalled = await ctx.db
      .query('org_removals')
      .withIndex('by_progress', (q) =>
        q.gte('progress_at', '').lt('progress_at', new Date(now - STALLED_MS).toISOString()),
      )
      .take(RECOVER_SCAN)
    let restarted = 0
    for (const removal of stalled) {
      if (restarted === RECOVER_BATCH) break
      const next =
        removal.scheduled_id === undefined ? null : await ctx.db.system.get(removal.scheduled_id)
      if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
      restarted += 1
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { org_id: removal.org_id })
      await ctx.db.patch(removal._id, { progress_at: new Date(now).toISOString(), scheduled_id })
      console.warn('Organization deletion resumed', {
        org_id: removal.org_id,
        phase: removal.phase,
        stalled_ms: removal.progress_at ? now - Date.parse(removal.progress_at) : null,
      })
    }
    return null
  },
})

/* ------------------------------------------------------------ admin actions */

/** An admin asks for deletion. Any paid subscription ends at once, then the
 * organization is read-only until its deletion date. The address confirms
 * the choice. */
export const request = orgAction({
  args: { confirm: v.string() },
  handler: async (ctx, { confirm }): Promise<{ delete_after: string }> => {
    require(confirm.trim().toLowerCase() === ctx.org_slug, rule(
      'Type the organization address to confirm.',
    ))
    await revokeLiveSubscriptions(ctx, ctx.orgId)
    return await ctx.runMutation(recordRequestRef, {
      org_id: ctx.orgId,
      auth_user_id: ctx.auth_user_id,
    })
  },
})

export const recordRequest = internalMutation({
  args: { org_id: v.string(), auth_user_id: v.string() },
  handler: async (ctx, { org_id, auth_user_id }): Promise<{ delete_after: string }> => {
    const me = await ctx.db
      .query('profiles')
      .withIndex('by_org_auth', (q) => q.eq('org_id', org_id).eq('auth_user_id', auth_user_id))
      .unique()
    require(me?.active && me.org_role === 'admin', forbidden('admin only'))
    const removal = await scheduleRemoval(ctx, {
      orgId: org_id,
      reason: 'requested',
      endedAt: isoNow(),
      requestedBy: me.id,
    })
    await audit(ctx, {
      actor_email: me.email ?? '',
      actor_auth_id: auth_user_id,
      action: 'org.deletion_requested',
      target_org_id: org_id,
      detail: { delete_after: removal.delete_after },
    })
    return { delete_after: removal.delete_after }
  },
})

/** An admin stops a deletion they or another admin asked for. A deletion
 * that billing started stops only when paid or complimentary access
 * returns. */
export const keep = authedMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<null> => {
    refuseDemoFeature()
    const me = ctx.myProfiles.get(org_id)
    if (me?.org_role !== 'admin') throw forbidden('admin only')
    const removal = await orgRemovalFor(ctx, org_id)
    require(removal && removal.phase === undefined && removal.reason === 'requested', rule(
      'This organization has no requested deletion to stop.',
    ))
    await ctx.db.delete(removal._id)
    await audit(ctx, {
      actor_email: me.email ?? '',
      actor_auth_id: ctx.authUserId,
      action: 'org.deletion_stopped',
      target_org_id: org_id,
      detail: { delete_after: removal.delete_after },
    })
    // An organization left without paid access starts its billing period.
    await syncOrgRemoval(ctx, org_id)
    return null
  },
})

/** What an admin's settings page shows about export and deletion. */
export const state = orgQuery({
  args: {},
  handler: async (ctx) => {
    require(ctx.me.org_role === 'admin', forbidden('admin only'))
    const org = await byId(ctx, 'organizations', ctx.me.org_id)
    require(org, notFound('organization not found'))
    const removal = await orgRemovalFor(ctx, org.id)
    return {
      slug: org.slug,
      last_export_at: org.last_export_at ?? null,
      deletion: removal
        ? {
            reason: removal.reason,
            ended_at: removal.ended_at,
            delete_after: removal.delete_after,
          }
        : null,
    }
  },
})

/** Records that an admin's browser finished an export. Allowed while the
 * organization is read-only, because that is when exports matter most. */
export const recordExport = authedMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<null> => {
    const me = ctx.myProfiles.get(org_id)
    if (me?.org_role !== 'admin') throw forbidden('admin only')
    await assertOrgAvailable(ctx, org_id)
    const org = await byId(ctx, 'organizations', org_id)
    require(org, notFound('organization not found'))
    await ctx.db.patch(org._id, { last_export_at: isoNow() })
    return null
  },
})

/** The deletion date after a cancellation, starting the read-only period
 * if billing has not yet done so. Null while access continues. */
export const recordCancellation = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<string | null> => {
    await syncOrgRemoval(ctx, org_id)
    const existing = await orgRemovalFor(ctx, org_id)
    if (existing) return existing.delete_after
    if (subscriptionWritable(await subscriptionFor(ctx, org_id))) return null
    const removal = await scheduleRemoval(ctx, {
      orgId: org_id,
      reason: 'service_ended',
      endedAt: isoNow(),
    })
    return removal.delete_after
  },
})

/* ----------------------------------------------------------------- notices */

export const noticeReady = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<Delivery | null> => {
    const notice = await ctx.db
      .query('billing_notices')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (!notice || notice.sent_at || notice.kind !== DELETION_NOTICE) return null
    const removal = await orgRemovalFor(ctx, notice.org_id)
    if (!removal || removal.phase !== undefined) return null
    if (key !== deletionNoticeKey(removal, notice.profile_id)) return null
    const profile = await byId(ctx, 'profiles', notice.profile_id)
    if (
      !profile?.active ||
      profile.org_role !== 'admin' ||
      profile.org_id !== notice.org_id ||
      !profile.email
    )
      return null
    const org = await byId(ctx, 'organizations', notice.org_id)
    const base = process.env.SITE_URL
    if (!org || !base) return null
    return {
      to: profile.email,
      org_name: org.name,
      delete_after: removal.delete_after,
      reason: removal.reason,
      url: `${base.replace(/\/$/, '')}/app/${encodeURIComponent(org.slug)}/settings/org-general`,
    }
  },
})

export const noticeSent = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<null> => {
    const notice = await ctx.db
      .query('billing_notices')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (notice && !notice.sent_at) await ctx.db.patch(notice._id, { sent_at: isoNow() })
    return null
  },
})

/** Delivers one admin's deletion email, retrying hourly for a day while
 * mail is unavailable. A stable notice key deduplicates provider retries. */
export const sendNotice = internalAction({
  args: { notice_key: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    const delivery = await ctx.runQuery(noticeReadyRef, { key: args.notice_key })
    if (!delivery) return null
    if (await sendDeletionNotice({ ...delivery, notice_key: args.notice_key }))
      await ctx.runMutation(noticeSentRef, { key: args.notice_key })
    else if ((args.attempt ?? 0) < 24)
      await ctx.scheduler.runAfter(60 * 60_000, sendNoticeRef, {
        ...args,
        attempt: (args.attempt ?? 0) + 1,
      })
    return null
  },
})
