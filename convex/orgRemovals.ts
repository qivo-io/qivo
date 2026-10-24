/* Organization retention and deletion jobs (rules in model/orgRetention.ts,
 * deletion steps in model/orgDeletion.ts).
 *
 * `sweep` runs every hour (crons.ts), one page per transaction, and reads
 * only the removals and subscriptions that are due. It starts
 * the read-only period for organizations whose billing ended, stops it when
 * access returns or billing is switched off, hands organizations that never
 * completed checkout to `verifyNoCheckout`, and hands removals whose date has
 * passed to `begin`. Both ask Polar first, so neither a lost webhook nor a
 * checkout still open can let Qivo delete an organization that pays. The
 * mutation that starts a deletion refuses any checkout saved meanwhile. It
 * sets the first phase, which ends all access (lib/functions.ts and
 * lib/billingAccess.ts), and `step` deletes in bounded transactions until
 * nothing is left. Convex drops the calls a failed mutation scheduled, so
 * `recover` (every ten minutes) restarts a deletion whose step stalled, as
 * labelRemovals.ts does.
 *
 * Admins act through `request` (delete the organization, ending any paid
 * subscription at once without a refund), `keep` (stop a deletion they asked
 * for) and `recordExport`, which the export panel calls once the browser has
 * built the archive. Cancelling in Billing (billingActions.cancelSubscription)
 * only stops renewal, so its period starts when Polar ends the subscription. */

import { makeFunctionReference } from 'convex/server'
import { type ObjectType, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { NOTICE_RETRIES } from './billingMail'
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
import type { OrgRemovalReason } from './lib/enums'
import {
  authedMutation,
  badRequest,
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
import { hasPendingCheckout } from './model/billing'
import { deleteOrgStep } from './model/orgDeletion'
import {
  accessReturned,
  DELETION_NOTICE,
  deletionNoticeKey,
  dropRemoval,
  noCheckoutDue,
  retentionDue,
  scheduleRemoval,
  serviceEndedAt,
  syncOrgRemoval,
} from './model/orgRetention'
import { countUsage } from './model/usage'

/** A deletion whose last step committed longer ago than this is restarted. */
export const STALLED_MS = 5 * 60_000
const RECOVER_BATCH = 32
const RECOVER_SCAN = 512

/** The most rows one sweep leg reads. A removal costs at most one
 * subscription lookup. A subscription costs one removal lookup and, when
 * its service ended, the reads and emails scheduleRemoval queues. Tests
 * lower these. */
export const SWEEP_PAGES = { removals: 128, subscriptions: 64 }

/** The current time as an ISO string, as the tables store it. */
const isoNow = (ms = Date.now()) => new Date(ms).toISOString()

const orgArg = { org_id: v.string() }
type OrgArg = { org_id: string }
const stepRef = makeFunctionReference<'mutation', OrgArg, null>('orgRemovals:step')
const beginRef = makeFunctionReference<'action', OrgArg, null>('orgRemovals:begin')
type Due = { reason: OrgRemovalReason; checkout_id: string | null }
const beginDueRef = makeFunctionReference<'query', OrgArg, Due | null>('orgRemovals:beginDue')
const clearEndedRef = makeFunctionReference<'mutation', OrgArg & { checkout_id: string }, null>(
  'billingActions:clearEndedCheckout',
)
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
const requestSyncRef = makeFunctionReference<'mutation', OrgArg, null>('billingSync:requestSync')
type Delivery = { to: string; org_name: string; delete_after: string; reason: string; url: string }
const noticeReadyRef = makeFunctionReference<'query', { key: string }, Delivery | null>(
  'orgRemovals:noticeReady',
)
const noticeSentRef = makeFunctionReference<'mutation', { key: string }, null>(
  'orgRemovals:noticeSent',
)
const noticeUnsentRef = makeFunctionReference<'mutation', { key: string; attempts: number }, null>(
  'billingMail:unsent',
)
const sendNoticeRef = makeFunctionReference<
  'action',
  { notice_key: string; attempt?: number },
  null
>('orgRemovals:sendNotice')

/** Ends every live Polar subscription of the organization at once, without
 * a refund, and records the result locally, so a deletion never leaves one
 * billing. A Polar failure, or billing without Polar credentials, becomes a
 * readable refusal, and nothing is scheduled. */
async function revokeLiveSubscriptions(
  ctx: Pick<ActionCtx, 'runMutation'>,
  orgId: string,
): Promise<number> {
  if (!billingEnabled()) return 0
  require(polarConfigured(), rule('Billing is not available. Try again later.'))
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

/** Whether the organization's last checkout could still become a
 * subscription. Polar answers for it; an ended one is cleared, so the
 * mutation that starts a deletion can refuse any checkout saved since. A
 * checkout naming another customer throws, and the caller waits. */
async function checkoutOpen(
  ctx: Pick<ActionCtx, 'runMutation'>,
  orgId: string,
  checkoutId: string | null,
): Promise<boolean> {
  if (!checkoutId) return false
  const session = await getPolarCheckout(checkoutId)
  require(session.externalCustomerId === orgId, badRequest('Checkout ownership mismatch.'))
  if (session.status !== 'expired' && session.status !== 'failed') return true
  await ctx.runMutation(clearEndedRef, { org_id: orgId, checkout_id: checkoutId })
  return false
}

/** Sets the first phase, which refuses all access from here on, and starts
 * the steps. */
async function beginDeletion(ctx: MutationCtx, orgId: string): Promise<void> {
  const removal = await orgRemovalFor(ctx, orgId)
  if (!removal || removal.phase !== undefined) return
  const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { org_id: orgId })
  await ctx.db.patch(removal._id, { phase: 'profiles', progress_at: isoNow(), scheduled_id })
  console.info('Organization deletion started', { org_id: orgId, reason: removal.reason })
}

const sweepArgs = {
  lane: v.optional(v.union(v.literal('removals'), v.literal('due'), v.literal('unset'))),
  cursor: v.optional(v.string()), // the lane's page cursor
  now: v.optional(v.number()), // the run's start, epoch milliseconds
  // A leg an earlier release queued, which paged whole tables. It stops, and
  // the next hourly run reads what is due.
  phase: v.optional(v.string()),
}
type SweepLeg = ObjectType<typeof sweepArgs>
type Lane = NonNullable<SweepLeg['lane']>
const SWEEP_LANES: Lane[] = ['removals', 'due', 'unset']
const sweepRef = makeFunctionReference<'mutation', SweepLeg, null>('orgRemovals:sweep')

/* The removals a sweep reads: those still waiting whose date has passed,
 * and while billing is off every one still waiting, so the billing-driven
 * ones stop. */
const waitingRemovals = (ctx: QueryCtx, now: number) =>
  ctx.db
    .query('org_removals')
    .withIndex('by_progress', (q) =>
      billingEnabled()
        ? q.eq('progress_at', undefined).lte('delete_after', isoNow(now))
        : q.eq('progress_at', undefined),
    )

/* The subscriptions a sweep reads: those whose retention_at has passed
 * (every string sorts after null and an absent value), and those written
 * before retention_at existed. */
const sweptSubscriptions = (ctx: QueryCtx, lane: Exclude<Lane, 'removals'>, now: number) =>
  ctx.db
    .query('billing_subscriptions')
    .withIndex('by_retention', (q) =>
      lane === 'due'
        ? q.gte('retention_at', '').lte('retention_at', isoNow(now))
        : q.eq('retention_at', undefined),
    )

/* Whether a sweep reads the lane, and whether it holds a row. Due
 * subscriptions wait while billing is off, as their service cannot end. */
async function laneHasRows(ctx: QueryCtx, lane: Lane, now: number): Promise<boolean> {
  if (lane === 'removals') return (await waitingRemovals(ctx, now).first()) !== null
  if (lane === 'due' && !billingEnabled()) return false
  return (await sweptSubscriptions(ctx, lane, now).first()) !== null
}

/* Stops a billing-driven removal whose access returned, or hands one whose
 * date has passed to `begin`. */
async function sweepRemoval(ctx: MutationCtx, removal: Doc<'org_removals'>, now: number) {
  if (removal.phase !== undefined) return
  if (
    removal.reason === 'service_ended' &&
    accessReturned(removal, await subscriptionFor(ctx, removal.org_id), now)
  )
    await dropRemoval(ctx, removal)
  else if (Date.parse(removal.delete_after) <= now)
    await ctx.scheduler.runAfter(0, beginRef, { org_id: removal.org_id })
}

/* Starts the read-only period of an organization whose service ended, or
 * hands one past its checkout deadline to `verifyNoCheckout`, and stores
 * when the sweep next reads the subscription. While the organization has a
 * removal, that is the removal's date; dropRemoval sets it again if the
 * removal stops sooner. One past its checkout deadline stays due, so a
 * check that waits for Polar runs again an hour later. */
async function sweepSubscription(ctx: MutationCtx, sub: Doc<'billing_subscriptions'>, now: number) {
  const removal = await orgRemovalFor(ctx, sub.org_id)
  let next = removal ? removal.delete_after : retentionDue(sub)
  if (!removal && next !== null && Date.parse(next) <= now) {
    const endedAt = serviceEndedAt(sub, now)
    if (endedAt)
      next = (await scheduleRemoval(ctx, { orgId: sub.org_id, reason: 'service_ended', endedAt }))
        .delete_after
    else if (polarConfigured() && noCheckoutDue(sub, now))
      await ctx.scheduler.runAfter(0, verifyNoCheckoutRef, { org_id: sub.org_id })
  }
  if (next !== sub.retention_at) await ctx.db.patch(sub._id, { retention_at: next })
}

/** One leg of the hourly sweep. Empty arguments start a run, and each leg
 * reads one page of one lane and schedules the next, as files.reapOrphans
 * does. A run reads only what is due, so an hour with nothing due costs one
 * call and at most three empty index ranges. The removals lane stops billing-driven
 * periods whose access returned and hands removals whose date has passed to
 * `begin`. The due lane, while billing is on, reads the subscriptions whose
 * retention_at has passed: it starts the period for organizations whose
 * service ended and hands those past their checkout deadline to
 * `verifyNoCheckout`. The unset lane does the same for rows written before
 * retention_at existed and fills it in, so the first run after the release
 * that added it reads every subscription once. Billing webhooks make the
 * same changes at once (billingSync.ts); the sweep catches what they miss. */
export const sweep = internalMutation({
  args: sweepArgs,
  handler: async (ctx, a): Promise<null> => {
    if (a.phase !== undefined) return null
    const now = a.now ?? Date.now()
    const lane = a.lane ?? 'removals'
    const cursor = a.cursor ?? null
    let more: string | null
    if (lane === 'removals') {
      const page = await waitingRemovals(ctx, now).paginate({
        cursor,
        numItems: SWEEP_PAGES.removals,
      })
      for (const removal of page.page) await sweepRemoval(ctx, removal, now)
      more = page.isDone ? null : page.continueCursor
    } else {
      const page = await sweptSubscriptions(ctx, lane, now).paginate({
        cursor,
        numItems: SWEEP_PAGES.subscriptions,
      })
      for (const sub of page.page) await sweepSubscription(ctx, sub, now)
      more = page.isDone ? null : page.continueCursor
    }
    let next: Pick<SweepLeg, 'lane' | 'cursor'> | null = more ? { lane, cursor: more } : null
    for (const later of SWEEP_LANES.slice(SWEEP_LANES.indexOf(lane) + 1)) {
      if (next) break
      if (await laneHasRows(ctx, later, now)) next = { lane: later }
    }
    if (next) await ctx.scheduler.runAfter(0, sweepRef, { ...next, now })
    return null
  },
})

/** The saved checkout of an organization past its checkout deadline, or
 * null when the deadline no longer applies. */
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
        await ctx.runMutation(requestSyncRef, { org_id })
        return null
      }
      if (await checkoutOpen(ctx, org_id, candidate.checkout_id)) return null
    } catch (error) {
      console.warn('Checkout deadline check deferred', { org_id, error: String(error) })
      return null
    }
    await ctx.runMutation(startNoCheckoutRef, { org_id })
    return null
  },
})

/** Records the no-checkout removal and begins the deletion at once, after
 * checking again that the deadline applies and no checkout is pending. */
export const startNoCheckout = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    const sub = await subscriptionFor(ctx, org_id)
    // a checkout saved after Polar was asked waits for the next sweep
    if (!noCheckoutDue(sub) || hasPendingCheckout(sub) || (await orgRemovalFor(ctx, org_id)))
      return null
    await scheduleRemoval(ctx, { orgId: org_id, reason: 'no_checkout', endedAt: isoNow() })
    await beginDeletion(ctx, org_id)
    return null
  },
})

/** What `begin` needs about a removal whose date has passed, or null when
 * none is due. */
export const beginDue = internalQuery({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<Due | null> => {
    const removal = await orgRemovalFor(ctx, org_id)
    if (!removal || removal.phase !== undefined) return null
    if (Date.parse(removal.delete_after) > Date.now()) return null
    const sub = await subscriptionFor(ctx, org_id)
    return { reason: removal.reason, checkout_id: sub?.checkout_id ?? null }
  },
})

/** Begins a deletion whose date has passed, once Polar confirms that the
 * organization has no live subscription and no checkout that could still
 * become one. A live subscription stops a deletion that billing started and
 * reconciles billing, because someone subscribed again or a webhook was
 * lost. A deletion an admin asked for waits instead, until an admin keeps
 * the organization or the subscription ends. Missing Polar credentials or a
 * Polar error also wait. */
export const begin = internalAction({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    const due = await ctx.runQuery(beginDueRef, { org_id })
    if (!due) return null
    if (billingEnabled()) {
      if (!polarConfigured()) {
        console.warn('Organization deletion deferred until Polar is configured', { org_id })
        return null
      }
      try {
        const live = (await listPolarSubscriptions(org_id)).some((subscription) =>
          LIVE_POLAR_STATUSES.includes(subscription.status),
        )
        if (live) {
          if (due.reason !== 'requested') await ctx.runMutation(abortRef, { org_id })
          await ctx.runMutation(requestSyncRef, { org_id })
          return null
        }
        if (await checkoutOpen(ctx, org_id, due.checkout_id)) return null
      } catch (error) {
        console.warn('Organization deletion deferred', { org_id, error: String(error) })
        return null
      }
    }
    await ctx.runMutation(markDeletingRef, { org_id })
    return null
  },
})

/** Drops a billing-driven removal that has not begun, because Polar shows
 * a live subscription. A deletion an admin asked for stays, including one
 * asked for after `begin` read the removal. */
export const abort = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    const removal = await orgRemovalFor(ctx, org_id)
    if (!removal || removal.phase !== undefined || removal.reason === 'requested') return null
    await dropRemoval(ctx, removal)
    console.warn('Organization deletion stopped because a subscription is live', {
      org_id,
      reason: removal.reason,
    })
    return null
  },
})

/** Begins a due deletion after `begin` asked Polar, unless access returned
 * or a checkout was saved since. */
export const markDeleting = internalMutation({
  args: orgArg,
  handler: async (ctx, { org_id }): Promise<null> => {
    // access that returned since the sweep stops the deletion instead
    await syncOrgRemoval(ctx, org_id)
    const removal = await orgRemovalFor(ctx, org_id)
    if (!removal || removal.phase !== undefined) return null
    if (Date.parse(removal.delete_after) > Date.now()) return null
    // a checkout saved after Polar was asked waits for the next sweep
    if (billingEnabled() && hasPendingCheckout(await subscriptionFor(ctx, org_id))) return null
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

/** An admin asks for deletion. Any paid subscription ends at once, without
 * a refund, then the organization is read-only until its deletion date. The
 * address confirms the choice. */
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

/** Records an admin's deletion request and its audit row once `request`
 * has ended any paid subscription. */
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

/** An admin stops a deletion they or another admin asked for, once the
 * organization has paid or complimentary access again. A deletion that
 * billing started stops only when that access returns. */
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
    // Without paid or complimentary access, keeping would only start a new
    // billing period, and repeating it would postpone deletion for free.
    require(subscriptionWritable(await subscriptionFor(ctx, org_id)), rule(
      'Subscribe again in Billing before keeping this organization.',
    ))
    await dropRemoval(ctx, removal)
    await audit(ctx, {
      actor_email: me.email ?? '',
      actor_auth_id: ctx.authUserId,
      action: 'org.deletion_stopped',
      target_org_id: org_id,
      detail: { delete_after: removal.delete_after },
    })
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
            keep_available:
              removal.reason === 'requested' &&
              subscriptionWritable(await subscriptionFor(ctx, org.id)),
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

/* ----------------------------------------------------------------- notices */

/** What one admin's deletion email needs, or null when it should not be
 * sent: already sent, deletion begun or stopped, or the admin is gone. */
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

/** Marks a deletion email delivered and counts it in the organization's
 * mail usage. */
export const noticeSent = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }): Promise<null> => {
    const notice = await ctx.db
      .query('billing_notices')
      .withIndex('by_key', (q) => q.eq('key', key))
      .unique()
    if (notice && !notice.sent_at) {
      await ctx.db.patch(notice._id, { sent_at: isoNow() })
      await countUsage(ctx, { org_id: notice.org_id, metric: 'mail_deletion_notices' })
    }
    return null
  },
})

/** Delivers one admin's deletion email, retrying hourly for a day while
 * mail is unavailable. A notice that runs out of attempts, or stops being
 * due after a failed one, is recorded for the operator (billingMail.unsent). Each hourly attempt sends under its own idempotency
 * key (mail.ts noticeKey). */
export const sendNotice = internalAction({
  args: { notice_key: v.string(), attempt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    const delivery = await ctx.runQuery(noticeReadyRef, { key: args.notice_key })
    if (!delivery) {
      const failed = args.attempt ?? 0
      if (failed > 0)
        await ctx.runMutation(noticeUnsentRef, { key: args.notice_key, attempts: failed })
      return null
    }
    if (
      await sendDeletionNotice({
        ...delivery,
        notice_key: args.notice_key,
        attempt: args.attempt ?? 0,
      })
    )
      await ctx.runMutation(noticeSentRef, { key: args.notice_key })
    else if ((args.attempt ?? 0) < NOTICE_RETRIES)
      await ctx.scheduler.runAfter(60 * 60_000, sendNoticeRef, {
        ...args,
        attempt: (args.attempt ?? 0) + 1,
      })
    else
      await ctx.runMutation(noticeUnsentRef, {
        key: args.notice_key,
        attempts: NOTICE_RETRIES + 1,
      })
    return null
  },
})
