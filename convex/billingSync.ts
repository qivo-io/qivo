import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { getBillableUsers } from './lib/billableUsers'
import { billingEnabled, subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import { badRequest, require, rule } from './lib/functions'
import {
  getPolarCheckout,
  getPolarSubscription,
  ingestPolarEvents,
  listPolarSubscriptions,
  type PolarSubscription,
  parsePolarSubscription,
  polarConfigured,
  updatePolarSeats,
  validatePolarProduct,
} from './lib/polar'
import { audit } from './model/admin'
import { GB, isoNow, storageUsage } from './model/billing'
import { newUuid } from './model/orgs'

type SyncWork = {
  token: string
  sub: Doc<'billing_subscriptions'>
  product_id: string
  plan: Doc<'billing_plans'>
  seats: number
}
const claimRef = makeFunctionReference<'mutation', { org_id: string }, SyncWork | null>(
  'billingSync:claim',
)
const applyRef = makeFunctionReference<'mutation', { payload: string; event_id?: string }, null>(
  'billingSync:apply',
)
const releaseRef = makeFunctionReference<
  'mutation',
  { org_id: string; token: string; seats?: number; error?: string },
  null
>('billingSync:release')
const reconcileRef = makeFunctionReference<'action', { org_id: string }, null>(
  'billingSync:reconcile',
)
const orgsRef = makeFunctionReference<'query', Record<string, never>, string[]>(
  'billingSync:organizations',
)
const eventsRef = makeFunctionReference<'query', Record<string, never>, Doc<'billing_events'>[]>(
  'billingSync:pendingEvents',
)
const eventReadyRef = makeFunctionReference<'mutation', { id: string }, boolean>(
  'billingSync:eventReady',
)
const eventResultRef = makeFunctionReference<'mutation', { id: string; success: boolean }, null>(
  'billingSync:eventResult',
)
const noticesRef = makeFunctionReference<'mutation', Record<string, never>, null>(
  'billingSync:reminders',
)

// API responses are normalized by the adapter; serialize their raw-equivalent
// fields for one shared validator on the write boundary and webhook path.
export function subscriptionPayload(s: PolarSubscription): string {
  return JSON.stringify({
    id: s.id,
    customer_id: s.customerId,
    customer: { id: s.customerId, external_id: s.externalCustomerId },
    product_id: s.productId,
    status: s.status,
    seats: s.seats,
    current_period_start: new Date(s.currentPeriodStart).toISOString(),
    current_period_end: new Date(s.currentPeriodEnd).toISOString(),
    modified_at: new Date(s.modifiedAt ?? s.startedAt ?? s.currentPeriodStart).toISOString(),
    cancel_at_period_end: s.cancelAtPeriodEnd,
    ...(s.endedAt !== undefined ? { ended_at: new Date(s.endedAt).toISOString() } : {}),
    ...(s.trialEnd ? { trial_end: new Date(s.trialEnd).toISOString() } : {}),
  })
}

export const claim = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<SyncWork | null> => {
    if (!billingEnabled() || !polarConfigured()) return null
    const sub = await subscriptionFor(ctx, org_id)
    if (!sub) return null
    const plan = await byId(ctx, 'billing_plans', sub.plan_id)
    if (!plan?.polar_product_id) return null
    if (sub.sync_lock_until && sub.sync_lock_until > isoNow()) return null
    const token = newUuid()
    const seats = Math.max(plan.minimum_seats, (await getBillableUsers(ctx, org_id)).total)
    await ctx.db.patch(sub._id, {
      sync_lock: token,
      sync_lock_until: new Date(Date.now() + 120_000).toISOString(),
    })
    return { token, sub, product_id: plan.polar_product_id, plan, seats }
  },
})

export const release = internalMutation({
  args: {
    org_id: v.string(),
    token: v.string(),
    seats: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { org_id, token, seats, error }) => {
    const sub = await subscriptionFor(ctx, org_id)
    if (!sub || sub.sync_lock !== token) return null
    await ctx.db.patch(sub._id, {
      sync_lock: undefined,
      sync_lock_until: undefined,
      sync_error: error,
      ...(seats !== undefined ? { next_seats: seats, synced_at: isoNow() } : {}),
    })
    return null
  },
})

export const apply = internalMutation({
  args: { payload: v.string(), event_id: v.optional(v.string()) },
  handler: async (ctx, { payload, event_id }) => {
    if (!billingEnabled()) return null
    if (payload.length > 1_048_576) throw badRequest('Invalid billing event.')
    if (
      event_id &&
      (await ctx.db
        .query('billing_webhooks')
        .withIndex('by_event', (q) => q.eq('event_id', event_id))
        .unique())
    )
      return null
    const remote = parsePolarSubscription(JSON.parse(payload))
    require(remote.externalCustomerId, badRequest('Subscription has no Qivo organization.'))
    const sub = await subscriptionFor(ctx, remote.externalCustomerId)
    require(sub, badRequest('Subscription has no assigned organization plan.'))
    const plan = await byId(ctx, 'billing_plans', sub.plan_id)
    require(plan?.polar_product_id === remote.productId, badRequest(
      'Subscription product does not match the assigned plan.',
    ))
    const now = isoNow()
    const modified = new Date(
      remote.modifiedAt ?? remote.startedAt ?? remote.currentPeriodStart,
    ).toISOString()
    require(remote.seats !== undefined && remote.seats >= plan.minimum_seats, badRequest(
      'Subscription quantity is invalid.',
    ))
    const incomingId = remote.id
    // A late notification for an old canceled subscription cannot revoke its
    // paid replacement. One live provider subscription per organization.
    const different = sub.polar_subscription_id && sub.polar_subscription_id !== incomingId
    if (different && !['pending', 'canceled', 'unpaid'].includes(sub.status)) return null
    if (
      different &&
      sub.current_period_start &&
      remote.currentPeriodStart < Date.parse(sub.current_period_start)
    )
      return null
    if (!different && sub.provider_modified_at && modified < sub.provider_modified_at) return null
    if (
      !different &&
      sub.provider_modified_at === modified &&
      sub.status === 'canceled' &&
      remote.status !== 'canceled'
    )
      return null
    const status =
      remote.status === 'incomplete' || remote.status === 'incomplete_expired'
        ? 'pending'
        : remote.status
    const start = new Date(remote.currentPeriodStart).toISOString()
    const end = new Date(remote.currentPeriodEnd).toISOString()
    const counts = await getBillableUsers(ctx, sub.org_id)
    await ctx.db.patch(sub._id, {
      polar_subscription_id: incomingId,
      polar_customer_id: remote.customerId,
      provider_modified_at: modified,
      status,
      current_period_start: start,
      current_period_end: end,
      billed_seats: remote.seats,
      cancel_at_period_end: remote.cancelAtPeriodEnd,
      ended_at: remote.endedAt === undefined ? undefined : new Date(remote.endedAt).toISOString(),
      past_due_at: status === 'past_due' ? (sub.past_due_at ?? now) : undefined,
      checkout_id: undefined,
      checkout_url: undefined,
      checkout_expires_at: undefined,
      updated_at: now,
    })
    const period = await ctx.db
      .query('billing_periods')
      .withIndex('by_subscription_period', (q) =>
        q.eq('subscription_id', incomingId).eq('period_start', start),
      )
      .unique()
    if (!period && (status === 'active' || status === 'past_due')) {
      const storage = await storageUsage(ctx, sub.org_id)
      const allowance =
        Math.max(plan.minimum_storage_gb, remote.seats * plan.storage_gb_per_seat) * GB
      const blocks = Math.ceil(Math.max(0, storage.bytes - allowance) / GB)
      await ctx.db.insert('billing_periods', {
        org_id: sub.org_id,
        subscription_id: incomingId,
        plan_id: plan.id,
        period_start: start,
        period_end: end,
        seats: remote.seats,
        profile_ids: counts.users.map((p) => p.profile_id),
        storage_bytes: storage.bytes,
        storage_blocks: blocks,
        created_at: now,
      })
      // Storage is sampled once at period start, then collected with that
      // period's metered usage on its closing invoice. Never a recurring flow.
      if (blocks > 0 && (!sub.complimentary_until || sub.complimentary_until <= start))
        await ctx.db.insert('billing_events', {
          id: `${incomingId}:${start}:storage`,
          org_id: sub.org_id,
          kind: 'storage',
          period_start: start,
          units: blocks,
          attempts: 0,
          next_attempt_at: now,
          created_at: now,
        })
    }
    if (event_id)
      await ctx.db.insert('billing_webhooks', {
        event_id,
        subscription_id: incomingId,
        received_at: now,
      })
    if (sub.status !== status || sub.current_period_start !== start || different)
      await audit(ctx, {
        actor_email: 'polar',
        action: 'billing.subscription',
        target_org_id: sub.org_id,
        detail: { subscription_id: incomingId, status, period_start: start, seats: remote.seats },
      })
    return null
  },
})

export const reconcile = internalAction({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<null> => {
    const work = await ctx.runMutation(claimRef, { org_id })
    if (!work) return null
    try {
      let remote: PolarSubscription | undefined
      if (work.sub.polar_subscription_id && !['canceled', 'unpaid'].includes(work.sub.status))
        remote = await getPolarSubscription(work.sub.polar_subscription_id)
      if (!remote || ['canceled', 'unpaid'].includes(remote.status)) {
        const matches = (await listPolarSubscriptions(org_id)).filter(
          (s) =>
            s.productId === work.product_id &&
            ['active', 'trialing', 'past_due', 'paused'].includes(s.status),
        )
        require(matches.length <= 1, rule('Multiple subscriptions need operator review.'))
        remote = matches[0] ?? remote
        if (!remote && work.sub.polar_subscription_id)
          remote = await getPolarSubscription(work.sub.polar_subscription_id)
      }
      if (!remote) {
        if (work.sub.checkout_id) {
          const checkout = await getPolarCheckout(work.sub.checkout_id)
          require(checkout.externalCustomerId === org_id &&
            checkout.productId === work.product_id, badRequest('Checkout ownership mismatch.'))
          if (checkout.status === 'expired' || checkout.status === 'failed')
            await ctx.runMutation(
              makeFunctionReference<'mutation', { org_id: string; checkout_id: string }, null>(
                'billingActions:clearEndedCheckout',
              ),
              { org_id, checkout_id: work.sub.checkout_id },
            )
        }
        await ctx.runMutation(releaseRef, { org_id, token: work.token })
        return null
      }
      require(remote.externalCustomerId === org_id &&
        remote.productId === work.product_id, badRequest('Subscription ownership mismatch.'))
      require(!remote.pendingProductId || remote.pendingProductId === work.product_id, rule(
        'A provider plan change needs operator review.',
      ))
      await ctx.runMutation(applyRef, { payload: subscriptionPayload(remote) })
      if (['active', 'trialing'].includes(remote.status) && !remote.cancelAtPeriodEnd) {
        // Replace an earlier pending quantity even when it returns to the
        // current billed quantity (8→11→8). Never retain a stale pending 11.
        const expected = remote.pendingSeats ?? remote.seats
        if (expected !== work.seats) {
          const plan = work.plan
          require(plan.api_meter_id && plan.storage_meter_id, badRequest('Missing usage meters.'))
          // Price changes belong in a new product/version. Refuse a quantity
          // update if someone edited the provider catalog under legacy terms.
          await validatePolarProduct(work.product_id, {
            allowArchived: true,
            unitAmount: plan.seat_price_cents,
            currency: plan.currency,
            minimumSeats: plan.minimum_seats,
            meters: [
              {
                id: plan.api_meter_id,
                unitAmount: plan.api_block_price_cents,
                eventName: 'qivo_api_overage',
              },
              {
                id: plan.storage_meter_id,
                unitAmount: plan.storage_block_price_cents,
                eventName: 'qivo_storage_overage',
              },
            ],
          })
          await updatePolarSeats(remote.id, work.seats)
        }
      }
      await ctx.runMutation(releaseRef, { org_id, token: work.token, seats: work.seats })
    } catch {
      await ctx.runMutation(releaseRef, {
        org_id,
        token: work.token,
        error: 'Billing synchronization needs attention. Automatic retries are scheduled.',
      })
    }
    return null
  },
})

// A verified webhook wakes a fresh provider read. Replaying an old event
// therefore cannot restore canceled access or roll billing periods backward.
export const webhook = internalAction({
  args: { event_id: v.string(), subscription_id: v.string() },
  handler: async (ctx, { event_id, subscription_id }): Promise<null> => {
    const remote = await getPolarSubscription(subscription_id)
    await ctx.runMutation(applyRef, { payload: subscriptionPayload(remote), event_id })
    if (remote.externalCustomerId)
      await ctx.scheduler.runAfter(0, reconcileRef, { org_id: remote.externalCustomerId })
    return null
  },
})

export const organizations = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query('billing_subscriptions').collect()).map((s) => s.org_id),
})

export const pendingEvents = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query('billing_events')
      .withIndex('by_pending', (q) =>
        q.eq('finished_at', undefined).lte('next_attempt_at', isoNow()),
      )
      .take(100),
})

// Polar assigns events to their receipt period. Claim immediately before each
// request and leave a 30-second margin for the adapter's 15-second timeout.
// Closed-period events are never retried into the next customer's invoice.
export const eventReady = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const event = await ctx.db
      .query('billing_events')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    const now = isoNow()
    if (!event || event.finished_at || event.next_attempt_at > now) return false
    const sub = await subscriptionFor(ctx, event.org_id)
    if (
      !sub?.polar_subscription_id ||
      sub.current_period_start !== event.period_start ||
      !sub.current_period_end ||
      Date.parse(sub.current_period_end) - Date.now() <= 30_000 ||
      !['active', 'past_due'].includes(sub.status) ||
      sub.ended_at
    ) {
      await ctx.db.patch(event._id, { abandoned_at: now, finished_at: now })
      await audit(ctx, {
        actor_email: 'billing',
        action: 'billing.usage_delivery_stopped',
        target_org_id: event.org_id,
        detail: {
          event_id: id,
          period_start: event.period_start,
          units: event.units,
          kind: event.kind,
          outcome: event.attempts ? 'unconfirmed' : 'not_sent',
        },
      })
      return false
    }
    await ctx.db.patch(event._id, {
      attempts: event.attempts + 1,
      next_attempt_at: new Date(Date.now() + 120_000).toISOString(),
    })
    return true
  },
})

export const eventResult = internalMutation({
  args: { id: v.string(), success: v.boolean() },
  handler: async (ctx, { id, success }) => {
    const event = await ctx.db
      .query('billing_events')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (!event || event.finished_at) return null
    await ctx.db.patch(
      event._id,
      success
        ? { sent_at: isoNow(), finished_at: isoNow() }
        : {
            next_attempt_at: new Date(
              Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** Math.min(event.attempts, 7)),
            ).toISOString(),
          },
    )
    return null
  },
})

export const pump = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (!billingEnabled() || !polarConfigured()) return null
    const events = await ctx.runQuery(eventsRef, {})
    for (const event of events) {
      if (!(await ctx.runMutation(eventReadyRef, { id: event.id }))) continue
      try {
        await ingestPolarEvents([
          {
            name: event.kind === 'api' ? 'qivo_api_overage' : 'qivo_storage_overage',
            externalCustomerId: event.org_id,
            timestamp: Date.parse(event.created_at),
            metadata: { units: event.units, qivo_period_start: event.period_start },
            idempotencyKey: event.id,
          },
        ])
        await ctx.runMutation(eventResultRef, { id: event.id, success: true })
      } catch {
        await ctx.runMutation(eventResultRef, { id: event.id, success: false })
      }
    }
    return null
  },
})

export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (!billingEnabled() || !polarConfigured()) return null
    for (const org_id of await ctx.runQuery(orgsRef, {}))
      await ctx.scheduler.runAfter(0, reconcileRef, { org_id })
    await ctx.runMutation(noticesRef, {})
    return null
  },
})

// Notices are keyed by grant end + recipient + threshold, so a retry cannot
// send a fresh copy every sweep. Actual delivery records success separately.
export const reminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!billingEnabled()) return null
    const now = Date.now()
    const subs = await ctx.db.query('billing_subscriptions').collect()
    for (const sub of subs) {
      if (!sub.complimentary_until || sub.polar_subscription_id) continue
      const remaining = Date.parse(sub.complimentary_until) - now
      // Convex subscriptions invalidate on data changes, not the wall clock.
      // Touch once at expiry to refresh both summary and member entitlement UI.
      if (remaining <= 0 && sub.updated_at < sub.complimentary_until)
        await ctx.db.patch(sub._id, { updated_at: isoNow() })
      const kind =
        remaining <= 0
          ? 'expired'
          : remaining <= 86_400_000
            ? 'one_day'
            : remaining <= 7 * 86_400_000
              ? 'seven_days'
              : null
      if (!kind) continue
      const org = await byId(ctx, 'organizations', sub.org_id)
      if (!org) continue
      const profiles = await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', sub.org_id))
        .collect()
      for (const profile of profiles) {
        if (!profile.active || profile.org_role !== 'admin' || !profile.email) continue
        const key = `${sub.id}:${sub.complimentary_until}:${profile.id}:${kind}`
        if (
          await ctx.db
            .query('billing_notices')
            .withIndex('by_key', (q) => q.eq('key', key))
            .unique()
        )
          continue
        await ctx.db.insert('billing_notices', {
          key,
          org_id: sub.org_id,
          profile_id: profile.id,
          kind,
          created_at: isoNow(),
        })
        await ctx.scheduler.runAfter(
          0,
          makeFunctionReference<
            'action',
            { to: string; url: string; until: string; notice_key: string },
            null
          >('billingMail:send'),
          {
            to: profile.email,
            url: `${process.env.SITE_URL}/app/${encodeURIComponent(org.slug)}/settings/org-billing`,
            until: sub.complimentary_until,
            notice_key: key,
          },
        )
      }
    }
    return null
  },
})
