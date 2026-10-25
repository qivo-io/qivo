import { makeFunctionReference } from 'convex/server'
import { type Infer, type ObjectType, v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import { billingDueBy, getBillableUsers, requestBillingSync } from './lib/billableUsers'
import { billingEnabled, subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import { badRequest, notFound, require, rule } from './lib/functions'
import { LIMITS } from './lib/limits'
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
import { GB, isoNow, nextReminder, storagePage } from './model/billing'
import { DAY_MS, retentionDue, syncOrgRemoval } from './model/orgRetention'
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
const requestSyncRef = makeFunctionReference<'mutation', { org_id: string }, null>(
  'billingSync:requestSync',
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
const noticesRef = makeFunctionReference<
  'mutation',
  { now: number; lane: 'due' | 'unset'; cursor: string | null },
  null
>('billingSync:reminders')
const reminderKind = v.union(v.literal('seven_days'), v.literal('one_day'), v.literal('expired'))
const remindAdminsRef = makeFunctionReference<
  'mutation',
  { subscription: Id<'billing_subscriptions'>; until: string; kind: Infer<typeof reminderKind> },
  null
>('billingSync:remindAdmins')
const pumpRef = makeFunctionReference<'action', Record<string, never>, null>('billingSync:pump')

const storageStepArgs = {
  period: v.id('billing_periods'),
  run: v.string(),
  // The phase a step queued by an earlier release still carries. 'own' was
  // this paging; the other two read rows without org_id, of which none are
  // left, so such a step only finishes the sample (storageStep).
  phase: v.optional(v.union(v.literal('own'), v.literal('unscoped'), v.literal('tasks'))),
  cursor: v.optional(v.string()),
  // the page size after a step split its page, else STORAGE_PAGE.rows
  size: v.optional(v.number()),
  bytes: v.number(),
}
type StorageStep = ObjectType<typeof storageStepArgs>
const storageStepRef = makeFunctionReference<'mutation', StorageStep, null>(
  'billingSync:storageStep',
)

/** How long a storage sample may go without a step before apply starts it
 * again. A step runs in well under a second, so only a sample whose step
 * failed waits this long. */
export const STORAGE_STALL_MS = 15 * 60_000

/** How many times a period's storage sample starts before apply stops
 * it. A sample that stalls this often has a step that keeps failing, so
 * apply stops it, logs an error and writes a billing.storage_sample_failed
 * audit row instead of starting it again at once. */
export const STORAGE_ATTEMPTS = 5

/** How long a stopped storage sample waits before apply starts it again on
 * its own, for another STORAGE_ATTEMPTS starts. A step that failed for a
 * while, as in an outage, then still records the period's storage before
 * the period ends, without an operator. Only a period whose charge can
 * still land is retried: its subscription is active or past due and has not
 * ended, and the period has not ended either. */
export const STORAGE_RETRY_MS = 6 * 60 * 60_000

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

/** How long an organization goes without a reconciliation when nothing
 * asks for one sooner. Membership changes and webhooks reconcile at once, a
 * pending checkout, an unpaid subscription, a period's end and a storage
 * sample have their own times (nextSyncDue), and a failure retries sooner.
 * This pass catches what those miss: a webhook Polar gave up on after its 10
 * retries, or a change made in Polar without one, such as a revocation.
 * Four reads a day per organization keep Polar calls far below its 500 a
 * minute. */
export const SYNC_SAFETY_MS = 6 * 60 * 60_000

/** How many reconciliations one sweep starts, SYNC_PAGE.spacing apart, so
 * they reach Polar at about one a second: 86,400 a day. A reconciliation
 * that changes no seats makes one to three Polar requests, so a usual sweep
 * stays under 180 a minute and leaves Polar's other 320 to checkouts,
 * webhooks and the reconciliations that membership changes start. One that
 * changes seats also checks the product and its meters, six or seven
 * requests, so a page of only seat changes, as after a Polar outage, can
 * reach about 420; requests Polar then refuses fail into the retry delay.
 * The safety pass keeps `safety` of each page whenever that many are due,
 * so it holds its six hours up to 10,800 organizations however many
 * targeted times are due, and up to 21,600 when they leave it room. Past
 * that it stretches. Targeted times always keep the other 30: 60
 * organizations polled every PAYMENT_POLL_MS, or 900 every DUNNING_POLL_MS,
 * before their polls stretch. Tests lower `size` and `safety`. */
export const SYNC_PAGE = { size: 60, spacing: 1_000, safety: 30 }

/** How often a pending checkout is reconciled, and a subscription in its
 * first PAYMENT_POLL_WINDOW_MS past due, unpaid or incomplete, so a payment
 * whose webhook is lost still restores access within minutes. */
export const PAYMENT_POLL_MS = 2 * 60_000

/** How long after Polar reports a subscription past due, unpaid or
 * incomplete it is polled every PAYMENT_POLL_MS. Polar ends an incomplete
 * subscription within about a day, so after that window an incomplete one
 * waits for the safety pass. */
export const PAYMENT_POLL_WINDOW_MS = DAY_MS

/** How often a subscription that stays past due or unpaid after
 * PAYMENT_POLL_WINDOW_MS is reconciled. Unpaid has no end of its own
 * (model/orgRetention.ts), so this bounds what one such organization costs
 * while its access still returns soon after a late payment. */
export const DUNNING_POLL_MS = 30 * 60_000

/** How long after a saved checkout's expiry it is still polled. Polar
 * clears an expired checkout (reconcile), so only one that succeeded
 * without a live subscription, which needs an operator, lasts this long and
 * then waits for the safety pass. */
export const CHECKOUT_POLL_GRACE_MS = 60 * 60_000

/** A reconciliation runs this long before a period ends, so the renewal
 * uses the current seats. A retry after a lost run (SWEEP_FENCE_MS) still
 * lands before the end, and a failure from here to the end retries at the
 * next sweep (release). */
export const PRE_RENEWAL_MS = 15 * 60_000

/** A reconciliation runs this long after a period ends, so a lost renewal
 * webhook is caught. */
export const POST_RENEWAL_MS = 5 * 60_000

/** How often a period that has ended without a renewal is reconciled,
 * within the 24 hours of access subscriptionWritable allows after it.
 * Calls made before the renewal is known count in a waived pending bucket
 * (billingUsage.ts usagePeriod). At the 6,000 calls a minute every
 * organization shares (MACHINE_INGRESS_LIMIT), the smallest allowance,
 * 5 seats of 25,000 calls, takes about 21 minutes to pass, so no block can
 * be waived between two of these. */
export const RENEWAL_POLL_MS = 5 * 60_000

/** How long the sweep keeps an organization it scheduled out of its next
 * pages, so a reconciliation still waiting to start is not scheduled twice.
 * A reconciliation that never starts runs again after it. */
const SWEEP_FENCE_MS = 5 * 60_000

/** How long a reconciliation holds its lock. */
const SYNC_LEASE_MS = 120_000

/** How often the sweep runs (crons.ts). */
export const SWEEP_INTERVAL_MS = 60_000

/** The due time `ms` after a reconciliation that ends at `now`, for the
 * times counted from it: its polls, its retries and the safety pass. The
 * sweep meets a due time at its first run at or after it, and a
 * reconciliation it started ends within the minute after that run, so the
 * time is stored one SWEEP_INTERVAL_MS sooner. The run `ms` after the one
 * that started the reconciliation then meets it, rather than the run after
 * that, which made a 2-minute poll land every 3 minutes. After a
 * reconciliation that a request started between two runs, the time comes
 * up to a minute before `ms` has passed. */
const after = (now: number, ms: number) => now + ms - SWEEP_INTERVAL_MS

/** The sentence a failed reconciliation leaves in Billing. Only this error
 * retries early: the seat ceiling's sentence waits for a membership change. */
const SYNC_RETRY_ERROR = 'Billing synchronization needs attention. Automatic retries are scheduled.'

const iso = (ms: number) => new Date(ms).toISOString()

/** Whether the saved checkout is still polled: until CHECKOUT_POLL_GRACE_MS
 * after its expiry. */
const checkoutPolled = (sub: Doc<'billing_subscriptions'>, now: number) =>
  !!sub.checkout_id &&
  !!sub.checkout_expires_at &&
  now < Date.parse(sub.checkout_expires_at) + CHECKOUT_POLL_GRACE_MS

/** When the organization next needs a reconciliation, and whether that is
 * only the safety pass: SYNC_SAFETY_MS from now, or sooner for a pending
 * checkout, a payment Polar waits for, a period's end or a storage sample that
 * apply must start again if it stalls or stopped. Intervals count from
 * `now` (after); times already past are left out, because the
 * reconciliation that reads them has just run. Every
 * reconciliation applies the period Polar reports, so when Polar moves a
 * renewal the next times follow the new end; one it moves without a
 * webhook after the check before the old end is read at the check after
 * it, and then every RENEWAL_POLL_MS until the renewal is known. A sample
 * that finishes computes the time again without its stall check
 * (dropStallCheck). */
async function nextSyncDue(
  ctx: QueryCtx,
  sub: Doc<'billing_subscriptions'>,
  now: number,
): Promise<{ due: string; safety: boolean }> {
  const safetyDue = after(now, SYNC_SAFETY_MS)
  let due = safetyDue
  const by = (at: number) => {
    if (at > now) due = Math.min(due, at)
  }
  if (checkoutPolled(sub, now)) by(after(now, PAYMENT_POLL_MS))
  // past due, unpaid, or incomplete (stored as pending with its subscription)
  const dunning = sub.status === 'past_due' || sub.status === 'unpaid'
  if (dunning || (sub.status === 'pending' && sub.polar_subscription_id)) {
    const since = Date.parse(sub.past_due_at ?? sub.provider_modified_at ?? '')
    if (now - since < PAYMENT_POLL_WINDOW_MS) by(after(now, PAYMENT_POLL_MS))
    else if (dunning) by(after(now, DUNNING_POLL_MS))
  }
  if (sub.current_period_end && !sub.ended_at) {
    const end = Date.parse(sub.current_period_end)
    if (now < end - PRE_RENEWAL_MS) by(end - PRE_RENEWAL_MS)
    else if (now < end + POST_RENEWAL_MS) by(end + POST_RENEWAL_MS)
    else if (now < end + 24 * 60 * 60_000) by(after(now, RENEWAL_POLL_MS))
  }
  const subscriptionId = sub.polar_subscription_id
  const start = sub.current_period_start
  if (subscriptionId && start) {
    const period = await ctx.db
      .query('billing_periods')
      .withIndex('by_subscription_period', (q) =>
        q.eq('subscription_id', subscriptionId).eq('period_start', start),
      )
      .unique()
    if (period && period.storage_bytes === undefined) {
      if (period.storage_run_at) by(Date.parse(period.storage_run_at) + STORAGE_STALL_MS + 60_000)
      else if (period.storage_failed_at)
        by(Date.parse(period.storage_failed_at) + STORAGE_RETRY_MS + 60_000)
    }
  }
  return { due: iso(due), safety: due === safetyDue }
}

/** Takes the organization's reconciliation lock and returns what the
 * reconciliation needs, or null when there is nothing to reconcile. While
 * another reconciliation holds the lock, it marks the organization due, so
 * the sweep runs it again once the lock is free and the change that asked
 * for it is not lost. */
export const claim = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<SyncWork | null> => {
    if (!billingEnabled() || !polarConfigured()) return null
    const sub = await subscriptionFor(ctx, org_id)
    if (!sub) return null
    const now = Date.now()
    const plan = await byId(ctx, 'billing_plans', sub.plan_id)
    if (!plan?.polar_product_id) {
      // Nothing to reconcile until the plan connects, so it waits for the
      // safety pass, also after the sweep's fence or a request set a sooner time.
      if (!sub.sync_safety || sub.sync_due_at === undefined || sub.sync_due_at <= iso(now))
        await ctx.db.patch(sub._id, {
          sync_due_at: iso(after(now, SYNC_SAFETY_MS)),
          sync_safety: true,
        })
      return null
    }
    if (sub.sync_lock_until && sub.sync_lock_until > iso(now)) {
      if (sub.sync_due_at === undefined || sub.sync_due_at > iso(now) || sub.sync_safety)
        await ctx.db.patch(sub._id, { sync_due_at: iso(now), sync_safety: undefined })
      return null
    }
    const token = newUuid()
    const seats = Math.max(plan.minimum_seats, (await getBillableUsers(ctx, org_id)).total)
    const until = iso(now + SYNC_LEASE_MS)
    // The due time equals the lock's end while nothing else asks, so a
    // reconciliation that dies runs again once its lock has expired.
    await ctx.db.patch(sub._id, {
      sync_lock: token,
      sync_lock_until: until,
      sync_due_at: until,
      sync_safety: undefined,
    })
    return { token, sub, product_id: plan.polar_product_id, plan, seats }
  },
})

/** Ends a reconciliation: frees its lock, records the seats it sent or its
 * error, and sets when the organization is next due. A failure retries
 * after 1, 2, 4 and up to 60 minutes (after), or at its next time
 * (nextSyncDue) when that is sooner, so failures cannot push a check past a
 * renewal, and a minute after each failure in the PRE_RENEWAL_MS before a
 * period ends, so the renewal still gets the seats once Polar answers
 * again. A due time set while the lock was held (claim) is kept when it is
 * sooner. */
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
    const now = Date.now()
    const attempts = error === SYNC_RETRY_ERROR ? (sub.sync_attempts ?? 0) + 1 : undefined
    let { due, safety } = await nextSyncDue(ctx, sub, now)
    const sooner = (at: string) => {
      if (at < due) [due, safety] = [at, false]
    }
    if (attempts) {
      sooner(iso(after(now, Math.min(60, 2 ** (attempts - 1)) * 60_000)))
      const end = sub.current_period_end && !sub.ended_at ? Date.parse(sub.current_period_end) : 0
      if (now >= end - PRE_RENEWAL_MS && now < end) sooner(iso(after(now, 60_000)))
    }
    if (sub.sync_due_at !== undefined && sub.sync_due_at !== sub.sync_lock_until)
      sooner(sub.sync_due_at)
    await ctx.db.patch(sub._id, {
      sync_lock: undefined,
      sync_lock_until: undefined,
      sync_error: error,
      sync_due_at: due,
      sync_safety: safety || undefined,
      sync_attempts: attempts,
      ...(seats !== undefined ? { next_seats: seats, synced_at: isoNow() } : {}),
    })
    return null
  },
})

/** Asks for the organization's reconciliation now, for the actions that
 * need one (lib/billableUsers.ts requestBillingSync). */
export const requestSync = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<null> => {
    await requestBillingSync(ctx, org_id)
    return null
  },
})

/** Applies a Polar subscription, from a webhook or reconciliation, to the
 * organization's billing row. Stale or out-of-order events are ignored. It
 * opens the paid period's record when a new period starts and starts the
 * period's storage sample (storageStep), or starts a sample again that has
 * gone STORAGE_STALL_MS without a step, up to STORAGE_ATTEMPTS starts, and a
 * stopped one again STORAGE_RETRY_MS after it stopped. Then it starts or
 * stops the read-only period before deletion (model/orgRetention.ts). */
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
    // The canceled subscription a checkout replaces cannot be that
    // checkout's outcome (reserveCheckout opens one only after the end), so
    // reading it again keeps the checkout while it is polled (nextSyncDue).
    // A checkout past that has no live subscription to wait for any more.
    const predecessor =
      sub.polar_subscription_id === incomingId &&
      sub.status === 'canceled' &&
      status === 'canceled' &&
      checkoutPolled(sub, Date.now())
    const fields = {
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
      ...(predecessor
        ? {}
        : { checkout_id: undefined, checkout_url: undefined, checkout_expires_at: undefined }),
      updated_at: now,
    } satisfies Partial<Doc<'billing_subscriptions'>>
    await ctx.db.patch(sub._id, {
      ...fields,
      retention_at: retentionDue({ ...sub, ...fields }),
      // a free period that Polar now bills gets no more reminders (reminders)
      remind_at: null,
    })
    const period = await ctx.db
      .query('billing_periods')
      .withIndex('by_subscription_period', (q) =>
        q.eq('subscription_id', incomingId).eq('period_start', start),
      )
      .unique()
    if (!period && (status === 'active' || status === 'past_due')) {
      const periodId = await ctx.db.insert('billing_periods', {
        org_id: sub.org_id,
        subscription_id: incomingId,
        plan_id: plan.id,
        period_start: start,
        period_end: end,
        seats: remote.seats,
        profile_ids: counts.users.map((p) => p.profile_id),
        created_at: now,
      })
      await startStorageSample(ctx, periodId)
    } else if (period && period.storage_bytes === undefined) {
      const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
      // A stopped sample has no run until its retry starts one.
      const stopped = period.storage_failed_at !== undefined && period.storage_run === undefined
      if (stopped) {
        // eventReady sends a storage charge only for a current period of a
        // live subscription, so a retry outside one could charge nothing
        const chargeable =
          (status === 'active' || status === 'past_due') &&
          remote.endedAt === undefined &&
          period.period_end > ago(-STORAGE_STALL_MS)
        if (chargeable && (period.storage_failed_at ?? '') < ago(STORAGE_RETRY_MS))
          await retryStoppedSample(ctx, period)
      } else if ((period.storage_run_at ?? '') < ago(STORAGE_STALL_MS)) {
        await restartStorageSample(ctx, period)
      }
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
    // An ended subscription starts the read-only period before deletion; a
    // new one stops a deletion that billing started.
    await syncOrgRemoval(ctx, sub.org_id)
    return null
  },
})

/* Starts a period's storage sample, or starts it again, and counts the
 * start. A new run id stops any earlier run at its next step. */
async function startStorageSample(
  ctx: MutationCtx,
  period: Id<'billing_periods'>,
  attempts = 1,
): Promise<void> {
  const run = newUuid()
  await ctx.db.patch(period, {
    storage_run: run,
    storage_run_at: isoNow(),
    storage_attempts: attempts,
  })
  await ctx.scheduler.runAfter(0, storageStepRef, { period, run, bytes: 0 })
}

/* Starts a stalled sample again, or stops it once it has started
 * STORAGE_ATTEMPTS times. A stopped sample records no storage until apply
 * starts it again after STORAGE_RETRY_MS (retryStoppedSample), so a period
 * whose sample never finishes charges none. Each stop logs an error, and the
 * period's first stop also writes an audit row, so a step that keeps failing
 * through the retries does not fill the audit log. They tell an operator,
 * who can start it again at once with restartStorage once the cause is
 * fixed. */
async function restartStorageSample(
  ctx: MutationCtx,
  period: Doc<'billing_periods'>,
): Promise<void> {
  const attempts = period.storage_attempts ?? 1
  if (attempts < STORAGE_ATTEMPTS) {
    console.warn(
      `billing: storage sample of period ${period._id} stalled; starting it again (start ${attempts + 1} of ${STORAGE_ATTEMPTS})`,
    )
    await startStorageSample(ctx, period._id, attempts + 1)
    return
  }
  console.error(
    `billing: storage sample of period ${period._id} stalled after ${attempts} starts; it is stopped and the period records no storage`,
  )
  await ctx.db.patch(period._id, {
    storage_run: undefined,
    storage_run_at: undefined,
    storage_failed_at: isoNow(),
  })
  // a retry keeps the earlier stop's time until the sample finishes
  if (period.storage_failed_at !== undefined) return
  await audit(ctx, {
    actor_email: 'system',
    action: 'billing.storage_sample_failed',
    target_org_id: period.org_id,
    detail: {
      period: period._id,
      subscription_id: period.subscription_id,
      period_start: period.period_start,
      attempts,
    },
  })
}

/* Starts a stopped sample again, STORAGE_RETRY_MS after it stopped, with
 * its starts counted from one, and logs it. The period keeps
 * storage_failed_at, the time of its last stop, until the sample finishes,
 * and the audit row of its first stop stays. */
async function retryStoppedSample(ctx: MutationCtx, period: Doc<'billing_periods'>): Promise<void> {
  console.warn(
    `billing: storage sample of period ${period._id} stopped at ${period.storage_failed_at}; starting it again`,
  )
  await startStorageSample(ctx, period._id)
}

/** Starts a period's storage sample again after it stopped
 * (billing.storage_sample_failed, whose detail names the period) or while it
 * runs, with its starts counted from one, and writes a
 * billing.storage_sample_restarted audit row. An operator runs it once the
 * failing step is fixed:
 *   "${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment" \
 *     TARGET npx convex run billingSync:restartStorage '{"period":"…"}'
 * A period whose sample finished is left alone. The storage charge a
 * finished sample records is sent only while the period is still the
 * subscription's current one and more than 30 seconds from its end
 * (eventReady), so a restart after that records the bytes but charges
 * nothing. */
export const restartStorage = internalMutation({
  args: { period: v.id('billing_periods') },
  handler: async (ctx, { period }): Promise<boolean> => {
    const row = await ctx.db.get(period)
    require(row !== null, notFound('billing period not found'))
    if (row.storage_bytes !== undefined) return false
    await ctx.db.patch(row._id, { storage_failed_at: undefined })
    await startStorageSample(ctx, row._id)
    // a reconciliation then starts the sample again if it stalls (apply)
    await billingDueBy(ctx, row.org_id, iso(Date.now() + STORAGE_STALL_MS + 60_000))
    await audit(ctx, {
      actor_email: 'cli',
      action: 'billing.storage_sample_restarted',
      target_org_id: row.org_id,
      detail: {
        period: row._id,
        subscription_id: row.subscription_id,
        period_start: row.period_start,
      },
    })
    return true
  },
})

/** One step of a period's storage sample. The renewal (apply) records the
 * period at once and starts the sample, so the renewal never reads the
 * organization's attachment rows. Each step counts one page of them
 * (model/billing.ts storagePage) and schedules the next step with the
 * running total. It counts the rows stored before the
 * renewal recorded the period, so a file stored later, or a restore's rows
 * written back, waits for the next period. The last step records the bytes and the
 * blocks over the plan's allowance for the period's seats. When there are
 * blocks and the period starts after any complimentary grant, it also adds
 * the storage charge, which is collected with the period's metered usage on
 * its closing invoice and never recurs. A step whose period is gone, or
 * whose run was started again, does nothing. */
export const storageStep = internalMutation({
  args: storageStepArgs,
  handler: async (ctx, a): Promise<null> => {
    const period = await ctx.db.get(a.period)
    if (period === null || period.storage_run !== a.run) return null
    if (a.phase === 'unscoped' || a.phase === 'tasks') {
      return await finishStorageSample(ctx, period, a.bytes)
    }
    const page = await storagePage(ctx, period.org_id, {
      cursor: a.cursor ?? null,
      size: a.size,
      before: period._creationTime,
    })
    let next: StorageStep | undefined
    if ('split' in page) next = { ...a, size: page.split }
    else {
      const bytes = a.bytes + page.bytes
      if (page.next !== null) next = { ...a, cursor: page.next, size: undefined, bytes }
      else return await finishStorageSample(ctx, period, bytes)
    }
    await ctx.db.patch(period._id, { storage_run_at: isoNow() })
    await ctx.scheduler.runAfter(0, storageStepRef, next)
    return null
  },
})

/* After a storage sample finishes, computes the organization's next
 * reconciliation again (nextSyncDue), now without the sample's stall check.
 * The release of the reconciliation whose apply started the sample usually
 * runs before the sample ends and sets that check, so without this a sample
 * that finished on time still cost a reconciliation STORAGE_STALL_MS later.
 * Only a time that nextSyncDue alone sets moves, and only later: one
 * further out than the sweep's fence and not the safety pass, while no
 * retry is pending and no reconciliation holds the lock. A request, a
 * retry, and a reconciliation the sweep has started or that runs keep
 * their time; the release of one that runs computes it again itself. */
async function dropStallCheck(ctx: MutationCtx, sub: Doc<'billing_subscriptions'>) {
  const now = Date.now()
  if (
    sub.sync_due_at === undefined ||
    sub.sync_due_at <= iso(now + SWEEP_FENCE_MS) ||
    sub.sync_safety ||
    sub.sync_attempts ||
    (sub.sync_lock_until !== undefined && sub.sync_lock_until > iso(now))
  )
    return
  const { due, safety } = await nextSyncDue(ctx, sub, now)
  if (due > sub.sync_due_at)
    await ctx.db.patch(sub._id, { sync_due_at: due, sync_safety: safety || undefined })
}

/* A storage sample's last step. It records the bytes and the blocks over
 * the allowance, adds the period's storage charge when one is due and
 * drops the organization's stall check (dropStallCheck). */
async function finishStorageSample(
  ctx: MutationCtx,
  period: Doc<'billing_periods'>,
  bytes: number,
): Promise<null> {
  const plan = await byId(ctx, 'billing_plans', period.plan_id)
  require(plan, notFound('billing plan not found'))
  const allowance = Math.max(plan.minimum_storage_gb, period.seats * plan.storage_gb_per_seat) * GB
  const blocks = Math.ceil(Math.max(0, bytes - allowance) / GB)
  await ctx.db.patch(period._id, {
    storage_bytes: bytes,
    storage_blocks: blocks,
    storage_run: undefined,
    storage_run_at: undefined,
    storage_attempts: undefined,
    storage_failed_at: undefined,
  })
  const sub = await subscriptionFor(ctx, period.org_id)
  const id = `${period.subscription_id}:${period.period_start}:storage`
  if (
    blocks > 0 &&
    sub !== null &&
    (!sub.complimentary_until || sub.complimentary_until <= period.period_start) &&
    (await ctx.db
      .query('billing_events')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()) === null
  ) {
    const now = isoNow()
    await ctx.db.insert('billing_events', {
      id,
      org_id: period.org_id,
      kind: 'storage',
      period_start: period.period_start,
      units: blocks,
      attempts: 0,
      next_attempt_at: now,
      created_at: now,
    })
  }
  if (sub !== null) await dropStallCheck(ctx, sub)
  return null
}

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
      // Without a live subscription, a saved checkout's own end clears it.
      if (work.sub.checkout_id && (!remote || ['canceled', 'unpaid'].includes(remote.status))) {
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
      if (!remote) {
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
        if (expected !== work.seats && work.seats > LIMITS.billingSeats.max) {
          // Polar takes no larger quantity, so this is no failure to retry:
          // the sentence stays until the count is back within the ceiling,
          // and each reconcile checks again without asking Polar
          await ctx.runMutation(releaseRef, {
            org_id,
            token: work.token,
            error: LIMITS.billingSeats.refusal,
          })
          return null
        }
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
      await ctx.runMutation(releaseRef, { org_id, token: work.token, error: SYNC_RETRY_ERROR })
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
      await ctx.runMutation(requestSyncRef, { org_id: remote.externalCustomerId })
    return null
  },
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

/** The billing job, every minute (crons.ts). It starts the reconciliations
 * that are due, SYNC_PAGE at a time and oldest first, delivers usage events
 * that are due (pump) and sends the free-period reminders that are due
 * (reminders). The safety pass keeps up to SYNC_PAGE.safety of each page,
 * targeted times take the rest, organizations enrolled before due times
 * existed count as targeted, and the safety pass also gets what they leave.
 * A due time waits for the first sweep at or after it, so a time here is
 * met up to a minute late, except an interval a reconciliation counts from
 * its own end (after), which the sweep that many minutes after the one
 * that started it meets. A minute with nothing due reads six index ranges
 * and writes nothing. Pump and the reminders run in their own
 * transactions, so a failure in either cannot undo the reconciliations
 * this one starts. The reminders that are due and the rows without a
 * reminder time each start their own chain of steps, so neither waits for
 * the other. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (!billingEnabled() || !polarConfigured()) return null
    const now = Date.now()
    const subs = () => ctx.db.query('billing_subscriptions')
    const safety = await subs()
      .withIndex('by_sync_due', (q) => q.eq('sync_safety', true).lte('sync_due_at', iso(now)))
      .take(SYNC_PAGE.size)
    const targeted = [
      // every string sorts after an absent due time
      () =>
        subs().withIndex('by_sync_due', (q) =>
          q.eq('sync_safety', undefined).gte('sync_due_at', '').lte('sync_due_at', iso(now)),
        ),
      () =>
        subs().withIndex('by_sync_due', (q) =>
          q.eq('sync_safety', undefined).eq('sync_due_at', undefined),
        ),
    ]
    const room = SYNC_PAGE.size - Math.min(safety.length, SYNC_PAGE.safety)
    const due: Doc<'billing_subscriptions'>[] = []
    for (const lane of targeted) {
      if (due.length === room) break
      due.push(...(await lane().take(room - due.length)))
    }
    due.push(...safety.slice(0, SYNC_PAGE.size - due.length))
    for (const [i, sub] of due.entries()) {
      await ctx.db.patch(sub._id, {
        sync_due_at: iso(now + SWEEP_FENCE_MS),
        sync_safety: undefined,
      })
      await ctx.scheduler.runAfter(i * SYNC_PAGE.spacing, reconcileRef, { org_id: sub.org_id })
    }
    const event = await ctx.db
      .query('billing_events')
      .withIndex('by_pending', (q) =>
        q.eq('finished_at', undefined).lte('next_attempt_at', iso(now)),
      )
      .first()
    if (event) await ctx.scheduler.runAfter(0, pumpRef, {})
    for (const lane of ['due', 'unset'] as const)
      if (await reminded(ctx, lane, now).first())
        await ctx.scheduler.runAfter(0, noticesRef, { now, lane, cursor: null })
    return null
  },
})

/** Free periods one reminders step reads, moves and schedules a
 * remindAdmins step for. A step reads only these rows, so it cannot fail on
 * what an organization holds. Tests lower it. */
export const REMINDER_PAGE = { size: 16 }

/* The subscriptions the reminders read: those whose remind_at has passed
 * (every string sorts after null and an absent value), and those written
 * before remind_at existed. */
const reminded = (ctx: QueryCtx, lane: 'due' | 'unset', now: number) =>
  ctx.db
    .query('billing_subscriptions')
    .withIndex('by_remind', (q) =>
      lane === 'due'
        ? q.gte('remind_at', '').lte('remind_at', iso(now))
        : q.eq('remind_at', undefined),
    )

/** One page of the free-period reminders that are due, at the sweep's time.
 * Each later page runs as its own step. A reminder goes out at its time
 * (model/billing.ts REMINDER_THRESHOLDS) or, after a sweep outage, late, and
 * only the latest one that came due: a period with a day left gets the
 * one-day reminder, not the seven-day one as well. The step moves remind_at
 * to the next reminder's time, or null after the end, and schedules one
 * remindAdmins step for each reminder, so an organization whose notices
 * fail loses only its own reminder of this time and holds back no other.
 * The unset lane fills in remind_at on rows written before it existed. */
export const reminders = internalMutation({
  args: {
    now: v.number(),
    lane: v.optional(v.union(v.literal('due'), v.literal('unset'))),
    cursor: v.union(v.string(), v.null()),
    // A step an earlier release queued for one reminder time. It stops, and
    // the next sweep reads what is due.
    threshold: v.optional(v.number()),
  },
  handler: async (ctx, { now, lane = 'due', cursor, threshold }) => {
    if (!billingEnabled() || threshold !== undefined) return null
    const page = await reminded(ctx, lane, now).paginate({ cursor, numItems: REMINDER_PAGE.size })
    for (const sub of page.page) {
      const until = sub.polar_subscription_id ? undefined : sub.complimentary_until
      if (lane === 'unset') {
        // a reminder whose time came within the last hour, which the release
        // before remind_at would still send, is still sent
        await ctx.db.patch(sub._id, {
          remind_at: until ? nextReminder(until, now - REMINDER_WINDOW_MS) : null,
        })
        continue
      }
      await ctx.db.patch(sub._id, { remind_at: until ? nextReminder(until, now) : null })
      if (!until) continue
      const remaining = Date.parse(until) - now
      // a period extended without moving remind_at waits for its own time
      if (remaining > 7 * DAY_MS) continue
      // Convex subscriptions invalidate on data changes, not the wall clock.
      // Touch once at expiry to refresh both summary and member entitlement UI.
      if (remaining <= 0 && sub.updated_at < until)
        await ctx.db.patch(sub._id, { updated_at: isoNow() })
      const kind = remaining <= 0 ? 'expired' : remaining <= DAY_MS ? 'one_day' : 'seven_days'
      await ctx.scheduler.runAfter(0, remindAdminsRef, { subscription: sub._id, until, kind })
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, noticesRef, { now, lane, cursor: page.continueCursor })
    return null
  },
})

/** Sends one free period's reminder to its organization's active admins
 * with an email, as a reminders step asked. Notices are keyed by grant end
 * + recipient + reminder, so a retry cannot send one twice. Actual delivery
 * records success separately. A period that changed since, extended or
 * billed in Polar, gets nothing: the write that changed it stored its next
 * reminder time. */
export const remindAdmins = internalMutation({
  args: { subscription: v.id('billing_subscriptions'), until: v.string(), kind: reminderKind },
  handler: async (ctx, { subscription, until, kind }) => {
    if (!billingEnabled()) return null
    const sub = await ctx.db.get(subscription)
    if (!sub || sub.polar_subscription_id || sub.complimentary_until !== until) return null
    const org = await byId(ctx, 'organizations', sub.org_id)
    if (!org) return null
    const profiles = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', sub.org_id))
      .collect()
    for (const profile of profiles) {
      if (!profile.active || profile.org_role !== 'admin' || !profile.email) continue
      const key = `${sub.id}:${until}:${profile.id}:${kind}`
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
          until,
          notice_key: key,
        },
      )
    }
    return null
  },
})

/** How long after a reminder's time a row written before remind_at existed
 * still gets it, once the unset lane fills it in: the release before read
 * each reminder time for an hour. */
const REMINDER_WINDOW_MS = 60 * 60_000
