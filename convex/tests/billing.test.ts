import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { billingDate, storageSampleLine } from '../../src/lib/billingDisplay'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import {
  CHECKOUT_POLL_GRACE_MS,
  DUNNING_POLL_MS,
  finalizeStorage,
  PAYMENT_POLL_MS,
  PAYMENT_POLL_WINDOW_MS,
  POST_RENEWAL_MS,
  PRE_RENEWAL_MS,
  REMINDER_PAGE,
  RENEWAL_POLL_MS,
  STORAGE_ATTEMPTS,
  STORAGE_FINALIZE_LEAD_MS,
  STORAGE_FINALIZE_PAGE,
  STORAGE_FINALIZE_RETRY_MS,
  STORAGE_RETRY_MS,
  STORAGE_STALL_MS,
  SWEEP_INTERVAL_MS,
  SYNC_PAGE,
  SYNC_SAFETY_MS,
  takeStorageSample,
  WEBHOOK_ATTEMPTS,
  WEBHOOK_LEASE_MS,
  WEBHOOK_PAGE,
} from '../billingSync'
import { billingDueBy, getBillableUsers, markBillingMembershipChanged } from '../lib/billableUsers'
import { addCalendarMonths } from '../lib/billingAccess'
import type {
  AccountNames,
  ApiAccounts,
  BillingDetails,
  BillingPlan,
  BillingUsageFigures,
  StorageProjects,
} from '../lib/billingTypes'
import { LIMITS, PLAN_CURRENCIES, PLAN_CURRENCY } from '../lib/limits'
import { enrollOrganization, nextReminder } from '../model/billing'
import { REMOVAL_BUDGET } from '../model/cascade'
import { deleteOrgStep } from '../model/orgDeletion'
import { newOrgDefaults } from '../model/orgs'
import { runOf, SAMPLE_PAGE, SAMPLE_STALLED_MS } from '../model/storageSamples'
import { addToOrg, addToProject, orgTotalsRow, startOrgTotals } from '../model/storageTotals'
import { as, expectRefusal, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'
import { deleteTask } from './trash.setup'
import { plantTicket } from './uploadTickets.setup'

type PlanInput = Omit<BillingPlan, 'id' | 'archived' | 'created_at'>
const storageProjects = makeFunctionReference<'query', { org_id: string }, StorageProjects>(
  'billing:storageProjects',
)
const details = makeFunctionReference<'query', { org_id: string }, BillingDetails>(
  'billing:details',
)
const usageFigures = makeFunctionReference<'query', { org_id: string }, BillingUsageFigures>(
  'billing:usageFigures',
)
const apiAccounts = makeFunctionReference<'query', { org_id: string; period: string }, ApiAccounts>(
  'billing:apiAccounts',
)
const accountList = makeFunctionReference<
  'query',
  { org_id: string; kind: 'billable' | 'non_billable' },
  AccountNames
>('billing:accountList')
const orgBilling = makeFunctionReference<'query', { org_id: string }, BillingDetails>(
  'adminBilling:orgBilling',
)
const status = makeFunctionReference<'query', { org_id: string }, { writable: boolean }>(
  'billing:status',
)
const checkout = makeFunctionReference<'action', { org_id: string }, { url: string }>(
  'billingActions:checkout',
)
const portal = makeFunctionReference<'action', { org_id: string }, { url: string }>(
  'billingActions:portal',
)
const insertPlan = makeFunctionReference<
  'mutation',
  { plan: PlanInput; actor: string; email: string },
  string
>('adminBilling:insertPlan')
const connectPlan = makeFunctionReference<
  'mutation',
  {
    plan_id: string
    polar_product_id: string
    api_meter_id: string
    storage_meter_id: string
    actor: string
    email: string
  },
  null
>('adminBilling:connectPlan')
const setDefaultPlan = makeFunctionReference<'mutation', { plan_id: string }, null>(
  'adminBilling:setDefaultPlan',
)
const assignPlan = makeFunctionReference<'mutation', { org_id: string; plan_id: string }, null>(
  'adminBilling:assignPlan',
)
const grant = makeFunctionReference<'mutation', { org_id: string; months: number }, null>(
  'adminBilling:grantComplimentary',
)
const apply = makeFunctionReference<'mutation', { payload: string; event_id?: string }, null>(
  'billingSync:apply',
)
const eventResult = makeFunctionReference<'mutation', { id: string; success: boolean }, null>(
  'billingSync:eventResult',
)
const eventReady = makeFunctionReference<'mutation', { id: string }, boolean>(
  'billingSync:eventReady',
)
const reconcile = makeFunctionReference<'action', { org_id: string }, null>('billingSync:reconcile')
const sweep = makeFunctionReference<'mutation', Record<string, never>, null>('billingSync:sweep')
const claim = makeFunctionReference<
  'mutation',
  { org_id: string },
  { token: string; seats: number } | null
>('billingSync:claim')
const release = makeFunctionReference<
  'mutation',
  { org_id: string; token: string; seats?: number; error?: string },
  null
>('billingSync:release')
const reminders = makeFunctionReference<
  'mutation',
  { now: number; lane?: 'due' | 'unset'; threshold?: number; cursor: string | null },
  null
>('billingSync:reminders')
const reserveCheckout = makeFunctionReference<'mutation', { org_id: string }, { token: string }>(
  'billingActions:reserveCheckout',
)
const finishCheckout = makeFunctionReference<
  'mutation',
  { org_id: string; token: string; checkout_id?: string; url?: string; expires_at?: string },
  null
>('billingActions:finishCheckout')
const receiveWebhook = makeFunctionReference<
  'mutation',
  { event_id: string; subscription_id: string },
  null
>('billingSync:receiveWebhook')
const processWebhook = makeFunctionReference<'action', { event_id: string }, null>(
  'billingSync:processWebhook',
)
const claimWebhook = makeFunctionReference<
  'mutation',
  { event_id: string },
  { subscription_id: string; claim: string } | null
>('billingSync:claimWebhook')
const webhookFailed = makeFunctionReference<
  'mutation',
  { event_id: string; claim: string; error: string; refused?: boolean },
  null
>('billingSync:webhookFailed')
const restartStorage = makeFunctionReference<
  'mutation',
  { period: Id<'billing_periods'> },
  boolean
>('billingSync:restartStorage')
const NOW = '2026-09-20T12:00:00.000Z'
const START = '2026-09-01T12:00:00.000Z'
const END = '2026-10-01T12:00:00.000Z'
const providerId = '11111111-1111-4111-8111-111111111111'
const replacementId = '22222222-2222-4222-8222-222222222222'
const customerId = '33333333-3333-4333-8333-333333333333'
const productId = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('BILLING_ENABLED', 'true')
  vi.stubEnv('APP_MODE', '')
  vi.stubEnv('POLAR_ACCESS_TOKEN', 'polar_oat_hermetic_billing_tests')
  vi.stubEnv('POLAR_SERVER', 'sandbox')
})
afterEach(() => {
  Object.assign(REMOVAL_BUDGET, DEFAULT_REMOVAL_BUDGET)
  Object.assign(SYNC_PAGE, DEFAULT_SYNC_PAGE)
  Object.assign(REMINDER_PAGE, DEFAULT_REMINDER_PAGE)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function terms(name = 'Founding', cents = 100): PlanInput {
  return {
    name,
    currency: 'usd',
    seat_price_cents: cents,
    minimum_seats: 5,
    storage_gb_per_seat: 1,
    minimum_storage_gb: 5,
    api_calls_per_seat: 25_000,
    storage_block_price_cents: 100,
    api_block_price_cents: 100,
    api_block_size: 25_000,
    polar_product_id: productId,
    api_meter_id: uuid(),
    storage_meter_id: uuid(),
  }
}
async function fixture(options: Parameters<typeof newT>[0] = {}) {
  const t = newT(options)
  const f = await withOrg(t)
  const operatorId = 'billing-operator'
  await t.run((ctx) =>
    ctx.db.insert('platform_admins', { auth_user_id: operatorId, note: 'test', created_at: NOW }),
  )
  const operator = t.withIdentity({ subject: operatorId })
  const planId = await t.mutation(insertPlan, {
    plan: terms(),
    actor: operatorId,
    email: 'operator@testbed.test',
  })
  await operator.mutation(setDefaultPlan, { plan_id: planId })
  await t.run((ctx) => enrollOrganization(ctx, f.org.id))
  // counted from its start, as every organization is since the totals'
  // backfill; the cases without complete totals say so
  await t.run((ctx) => startOrgTotals(ctx, f.org.id))
  return { t, f, operator, operatorId, planId }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
/* Runs the scheduled work, which holds each period's storage sample. */
const sample = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

/* Adds `bytes` to the organization's stored-byte totals as one file in
 * Firmware, through the writers model/storageTotals.ts keeps exact
 * (addToProject and addToOrg), for the gigabyte figures no attach in a
 * test could store cheaply. */
const storeBytes = (t: T, f: Fixture['f'], bytes: number) =>
  t.run(async (ctx) => {
    await addToProject(ctx, f.org.id, f.sub.id, f.sub.num, { bytes, files: 1 }, f.sub.name)
    const org = await orgTotalsRow(ctx, f.org.id)
    if (org === null) throw new Error('the organization is not counted')
    await addToOrg(ctx, org, { bytes, files: 1 })
  })

/* Runs `write` with billing off, so the fixture's organization, which is
 * read-only until a subscription applies, takes the app's writes. */
async function billingOff<R>(write: () => Promise<R>): Promise<R> {
  vi.stubEnv('BILLING_ENABLED', 'false')
  try {
    return await write()
  } finally {
    vi.stubEnv('BILLING_ENABLED', 'true')
  }
}

/* Attaches a file of `bytes` to a new task in Firmware in the app, as
 * f.user on an upload ticket of their own, so the totals count it, and
 * answers the task and its attachment. */
async function attachFile(t: T, f: Fixture['f'], bytes: number) {
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-files-secret')
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const storage_id = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)])))
  await plantTicket(t, { profile: f.user, issue: task, storageId: storage_id })
  const out = await billingOff(() =>
    as(t, f.user).mutation(api.files.attach, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: task.id,
      storage_id,
      name: 'spec.pdf',
      inline: false,
    }),
  )
  if (!('attachment' in out)) throw new Error(`the attach was refused: ${out.refused.message}`)
  return { task, attachment: out.attachment }
}

/* What one transaction read, from Convex's metrics. */
type Read = { ranges: number; documents: number; bytes: number }

/* Starts a recount of the organization's stored-byte totals and takes it
 * one backfill step at a time (internal/storageTotalsBackfill step), as an
 * operator's `"recount": true` run does. The first step deletes the row. */
function recountOf(t: T, orgId: string) {
  const run = uuid()
  return () =>
    t.mutation(internal.internal.storageTotalsBackfill.step, {
      org_id: orgId,
      recount: true,
      run,
    })
}

/* The organization's billing period starting at `start`. */
const periodAt = (t: T, start: string) =>
  t.run((ctx) =>
    ctx.db
      .query('billing_periods')
      .withIndex('by_subscription_period', (q) =>
        q.eq('subscription_id', providerId).eq('period_start', start),
      )
      .unique(),
  )

const storageEvents = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('billing_events').collect()).filter((e) => e.kind === 'storage'),
  )

/* A provider modification time `n` minutes after NOW. */
const iso = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString()

/* The minutes after a reconciliation at which an interval of `ms` counted
 * from it is stored: a minute short, for the sweep (billingSync.ts after). */
const minutesAfter = (ms: number) => (ms - SWEEP_INTERVAL_MS) / 60_000

const DEFAULT_REMOVAL_BUDGET = { ...REMOVAL_BUDGET }
const DEFAULT_SYNC_PAGE = { ...SYNC_PAGE }
const DEFAULT_REMINDER_PAGE = { ...REMINDER_PAGE }

/* The calls waiting in the scheduler, by function name. */
const queued = (t: T, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (job) => job.name === name && job.state.kind === 'pending',
    ),
  )

/* Sets when the organization is next reconciled, and whether that is only
 * the safety pass. */
const setDue = (t: T, orgId: string, due: string | undefined, safety?: true) =>
  t.run(async (ctx) => {
    const sub = await ctx.db
      .query('billing_subscriptions')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique()
    await ctx.db.patch(sub!._id, { sync_due_at: due, sync_safety: safety })
  })

async function stored(t: T, orgId: string) {
  return await t.run((ctx) =>
    ctx.db
      .query('billing_subscriptions')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique(),
  )
}
function remote(orgId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: providerId,
    customer_id: customerId,
    customer: { id: customerId, external_id: orgId },
    product_id: productId,
    status: 'active',
    seats: 5,
    current_period_start: START,
    current_period_end: END,
    modified_at: NOW,
    cancel_at_period_end: false,
    pending_update: null,
    ...overrides,
  })
}
/* Adds LIMITS.billingSeats.max active standard users, so with withOrg's
 * members the organization is past the online billing ceiling. */
const pastSeatCeiling = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    for (let i = 0; i < LIMITS.billingSeats.max; i += 1) {
      await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: orgId,
        email: `member-${i}@testbed.test`,
        name: `Member ${i}`,
        initials: 'MB',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
    }
  })

async function createTask(t: T, f: Awaited<ReturnType<typeof withOrg>>, title = 'Billable test') {
  return await as(t, f.admin).mutation(api.issues.create, {
    org_id: f.org.id,
    id: uuid(),
    project_id: f.sub.id,
    title,
  })
}

describe('billing authority and plan versions', () => {
  it('keeps billing terms/admin actions fenced while all members can read their write status', async () => {
    const { t, f } = await fixture()
    expect(await as(t, f.admin).query(details, { org_id: f.org.id })).toMatchObject({
      status: 'pending',
      writable: false,
    })
    for (const profile of [f.user, f.viewer, f.guest]) {
      const caller = as(t, profile)
      for (const read of [storageProjects, details, usageFigures])
        await expectRefusal(caller.query(read, { org_id: f.org.id }), 'forbidden', /admin only/)
      await expectRefusal(
        caller.query(apiAccounts, { org_id: f.org.id, period: 'month:2026-01' }),
        'forbidden',
        /admin only/,
      )
      await expectRefusal(
        caller.query(accountList, { org_id: f.org.id, kind: 'billable' }),
        'forbidden',
        /admin only/,
      )
      await expectRefusal(caller.action(checkout, { org_id: f.org.id }), 'forbidden', /admin only/)
      await expectRefusal(caller.action(portal, { org_id: f.org.id }), 'forbidden', /admin only/)
      expect(await caller.query(status, { org_id: f.org.id })).toMatchObject({ writable: false })
    }
    for (const read of [details, usageFigures])
      await expectRefusal(t.query(read, { org_id: f.org.id }), 'forbidden', /not signed in/)
    await expectRefusal(t.action(checkout, { org_id: f.org.id }), 'forbidden', /not signed in/)
    for (const read of [details, usageFigures])
      await expectRefusal(
        as(t, f.otherAdmin).query(read, { org_id: f.org.id }),
        'forbidden',
        /no profile/,
      )
    await expectRefusal(
      as(t, f.otherAdmin).query(apiAccounts, { org_id: f.org.id, period: 'month:2026-01' }),
      'forbidden',
      /no profile/,
    )
    await expectRefusal(
      as(t, f.otherAdmin).query(accountList, { org_id: f.org.id, kind: 'billable' }),
      'forbidden',
      /no profile/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(setDefaultPlan, { plan_id: 'anything' }),
      'forbidden',
      /operator/,
    )
  })

  it('changing the default enrolls a future organization without repricing an existing customer', async () => {
    const { t, f, operator, operatorId, planId } = await fixture()
    const newerId = await t.mutation(insertPlan, {
      plan: { ...terms('Standard 2027', 200), polar_product_id: uuid() },
      actor: operatorId,
      email: 'operator@testbed.test',
    })
    await operator.mutation(setDefaultPlan, { plan_id: newerId })
    await t.run((ctx) => enrollOrganization(ctx, f.otherOrg.id))
    expect(await stored(t, f.org.id)).toMatchObject({ plan_id: planId })
    expect(await stored(t, f.otherOrg.id)).toMatchObject({ plan_id: newerId })
    // the details and the operator console's answer keep the old terms and
    // leave the provider ids out
    for (const shown of [
      await as(t, f.admin).query(details, { org_id: f.org.id }),
      await operator.query(orgBilling, { org_id: f.org.id }),
    ]) {
      expect(shown.plan).toMatchObject({ name: 'Founding', seat_price_cents: 100 })
      for (const id of ['polar_product_id', 'api_meter_id', 'storage_meter_id'])
        expect(shown.plan).not.toHaveProperty(id)
    }
    // the console answers the admin's details, without a name list
    const console = await operator.query(orgBilling, { org_id: f.org.id })
    expect(console).toEqual(await as(t, f.admin).query(details, { org_id: f.org.id }))
    expect(console).not.toHaveProperty('billable_accounts')
    await t.mutation(apply, { payload: remote(f.org.id) })
    await expectRefusal(
      operator.mutation(assignPlan, { org_id: f.org.id, plan_id: newerId }),
      'rule',
      /keeps its assigned plan/,
    )
    expect(await stored(t, f.org.id)).toMatchObject({ plan_id: planId })
  })

  it('refuses stale or foreign cached checkout sessions rather than accepting a different seat count', async () => {
    const { t, f } = await fixture()
    const sub = (await stored(t, f.org.id))!
    const checkoutId = '66666666-6666-4666-8666-666666666666'
    const expires = '2026-09-20T13:00:00.000Z'
    await t.run((ctx) =>
      ctx.db.patch(sub._id, {
        checkout_id: checkoutId,
        checkout_url: 'https://sandbox.polar.sh/checkout/example',
        checkout_expires_at: expires,
      }),
    )
    const base = {
      id: checkoutId,
      url: 'https://sandbox.polar.sh/checkout/example',
      expires_at: expires,
      status: 'open',
      product_id: productId,
      external_customer_id: f.org.id,
      seats: 5,
      min_seats: 5,
      max_seats: 5,
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const response of [
      { ...base, external_customer_id: f.otherOrg.id },
      { ...base, seats: 9, min_seats: 9, max_seats: 9 },
      { ...base, status: 'succeeded' },
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response)))
      await expectRefusal(
        as(t, f.admin).action(checkout, { org_id: f.org.id }),
        response.external_customer_id !== f.org.id ? 'bad_request' : 'rule',
      )
    }
  })

  it('refuses checkout past the online billing ceiling before asking Polar', async () => {
    const { t, f } = await fixture()
    await pastSeatCeiling(t, f.org.id)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // the old code refused with its own sentence, not the registry's
    const refusal = await expectRefusal(
      as(t, f.admin).action(checkout, { org_id: f.org.id }),
      'rule',
    )
    expect(refusal.data.message).toBe(LIMITS.billingSeats.refusal)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['expired', 'failed'])(
    'clears a provider-%s cached checkout before recovering an existing purchase',
    async (terminalStatus) => {
      const { t, f } = await fixture()
      const sub = (await stored(t, f.org.id))!
      const checkoutId = '66666666-6666-4666-8666-666666666666'
      const expires = '2026-09-20T13:00:00.000Z'
      await t.run((ctx) =>
        ctx.db.patch(sub._id, {
          checkout_id: checkoutId,
          checkout_url: 'https://sandbox.polar.sh/checkout/example',
          checkout_expires_at: expires,
        }),
      )
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: checkoutId,
              url: 'https://sandbox.polar.sh/checkout/example',
              expires_at: expires,
              status: terminalStatus,
              product_id: productId,
              external_customer_id: f.org.id,
              seats: 5,
              min_seats: 5,
              max_seats: 5,
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ items: [JSON.parse(remote(f.org.id))], pagination: { max_page: 1 } }),
          ),
        )
      vi.stubGlobal('fetch', fetchMock)
      await t.run((ctx) => ctx.db.patch(sub._id, { sync_due_at: iso(360), sync_safety: true }))
      await expectRefusal(
        as(t, f.admin).action(checkout, { org_id: f.org.id }),
        'rule',
        /already has a subscription/,
      )
      const cleared = await stored(t, f.org.id)
      expect(cleared).not.toHaveProperty('checkout_id')
      expect(cleared).not.toHaveProperty('checkout_url')
      expect(cleared).not.toHaveProperty('checkout_lock')
      // the refusal says to refresh Billing, so the subscription is read now
      expect(cleared).toMatchObject({ sync_due_at: NOW })
      expect(cleared).not.toHaveProperty('sync_safety')
    },
  )
})

describe('the plan writers behind the operator actions', () => {
  /* createPlan and connectPlan refuse demo mode, and the dashboard and
   * deploy keys can run these mutations without them. */
  it('insertPlan and connectPlan refuse a demo deployment and write nothing', async () => {
    const t = newT()
    const planId = await t.mutation(insertPlan, {
      plan: {
        ...terms('Unconnected'),
        polar_product_id: undefined,
        api_meter_id: undefined,
        storage_meter_id: undefined,
      },
      actor: 'billing-operator',
      email: 'operator@testbed.test',
    })
    const rows = () =>
      t.run(async (ctx) => ({
        plans: await ctx.db.query('billing_plans').collect(),
        audit: await ctx.db.query('platform_audit_log').collect(),
      }))
    const before = await rows()
    vi.stubEnv('APP_MODE', 'demo')
    await expectRefusal(
      t.mutation(insertPlan, {
        plan: terms('Demo'),
        actor: 'billing-operator',
        email: 'operator@testbed.test',
      }),
      'forbidden',
      /requires a regular workspace/,
    )
    await expectRefusal(
      t.mutation(connectPlan, {
        plan_id: planId,
        polar_product_id: productId,
        api_meter_id: uuid(),
        storage_meter_id: uuid(),
        actor: 'billing-operator',
        email: 'operator@testbed.test',
      }),
      'forbidden',
      /requires a regular workspace/,
    )
    expect(await rows()).toEqual(before)
  })

  it('takes a plan name of 80 characters, trimmed, and only the listed currencies', async () => {
    const t = newT()
    const write = (plan: PlanInput) =>
      t.mutation(insertPlan, { plan, actor: 'billing-operator', email: 'operator@testbed.test' })
    const name = 'P'.repeat(LIMITS.planName.max)
    const long = await expectRefusal(write(terms(`${name}P`)), 'rule')
    expect(long.data.message).toBe(LIMITS.planName.refusal)
    for (const currency of ['USD', 'xyz', '']) {
      const refused = await expectRefusal(write({ ...terms(), currency }), 'rule')
      expect(refused.data.message, currency).toBe(PLAN_CURRENCY)
    }
    expect(PLAN_CURRENCY).toBe(
      'a billing plan must be priced in USD, EUR, GBP, NOK, SEK, DKK, CAD, AUD, CHF or NZD. Choose one of them.',
    )
    for (const currency of PLAN_CURRENCIES) await write({ ...terms(` ${name} `), currency })
    const plans = await t.run((ctx) => ctx.db.query('billing_plans').collect())
    expect(plans.map((plan) => [plan.name, plan.currency])).toEqual(
      PLAN_CURRENCIES.map((currency) => [name, currency]),
    )
  })
})

describe('complimentary access and paid expiry', () => {
  it('grants six calendar months with month-end clamping and refuses writes exactly at expiry', async () => {
    vi.setSystemTime('2026-08-31T10:30:00.000Z')
    const { t, f, operator } = await fixture()
    await operator.mutation(grant, { org_id: f.org.id, months: 6 })
    const sub = await stored(t, f.org.id)
    expect(sub).toMatchObject({
      complimentary_start: '2026-08-31T10:30:00.000Z',
      complimentary_until: '2027-02-28T10:30:00.000Z',
    })
    await createTask(t, f)
    await expectRefusal(
      as(t, f.admin).action(checkout, { org_id: f.org.id }),
      'rule',
      /free access is still active/,
    )
    vi.setSystemTime('2027-02-28T10:29:59.999Z')
    await createTask(t, f, 'Last millisecond of grant')
    vi.setSystemTime('2027-02-28T10:30:00.000Z')
    await expectRefusal(createTask(t, f, 'Must not write'), 'forbidden', /read-only/)
    expect(await as(t, f.admin).query(details, { org_id: f.org.id })).toMatchObject({
      writable: false,
      checkout_available: true,
    })
    expect(addCalendarMonths('2027-08-31T10:30:00.000Z', 6)).toBe('2028-02-29T10:30:00.000Z')
  })

  it('refuses unauthorized grants and modifications after paid checkout, without dropping existing terms', async () => {
    const { t, f, operator } = await fixture()
    await expectRefusal(
      as(t, f.admin).mutation(grant, { org_id: f.org.id, months: 6 }),
      'forbidden',
      /operator/,
    )
    await expectRefusal(
      operator.mutation(grant, { org_id: f.org.id, months: 0.5 }),
      'bad_request',
      /calendar months/,
    )
    await t.mutation(apply, { payload: remote(f.org.id) })
    await expectRefusal(
      operator.mutation(grant, { org_id: f.org.id, months: 6 }),
      'rule',
      /before checkout/,
    )
  })

  it('honors paid-through cancellation but gives no renewal grace after the cancellation boundary', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id, { cancel_at_period_end: true }) })
    await createTask(t, f)
    vi.setSystemTime(END)
    await expectRefusal(createTask(t, f), 'forbidden', /read-only/)
    await t.mutation(apply, {
      payload: remote(f.org.id, { status: 'canceled', modified_at: END, ended_at: END }),
    })
    await expectRefusal(createTask(t, f), 'forbidden', /read-only/)
  })

  it('an immediate revocation removes paid access even before the paid-through date', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id, { status: 'canceled', ended_at: NOW }) })
    await expectRefusal(createTask(t, f), 'forbidden', /read-only/)
    // the admin still reads Billing's usage
    expect(await as(t, f.admin).query(usageFigures, { org_id: f.org.id })).toHaveProperty(
      'calls',
      0,
    )
  })

  it('an explicit provider end overrides a previous period-end cancellation flag', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id, { cancel_at_period_end: true }) })
    await t.mutation(apply, {
      payload: remote(f.org.id, {
        status: 'canceled',
        ended_at: NOW,
        cancel_at_period_end: true,
        modified_at: '2026-09-20T12:01:00.000Z',
      }),
    })
    await expectRefusal(createTask(t, f), 'forbidden', /read-only/)
  })
})

describe('provider state, retries and billing snapshots', () => {
  it('stores billed rather than pending seats, deduplicates delivery and rejects older state', async () => {
    const { t, f } = await fixture()
    const payload = remote(f.org.id, {
      seats: 8,
      pending_update: { seats: 11, product_id: null, applies_at: END },
    })
    await t.mutation(apply, { payload, event_id: 'delivery-1' })
    await t.mutation(apply, { payload, event_id: 'delivery-1' })
    await t.mutation(apply, {
      payload: remote(f.org.id, {
        status: 'past_due',
        seats: 5,
        modified_at: '2026-09-19T12:00:00.000Z',
      }),
      event_id: 'older',
    })
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'active', billed_seats: 8 })
    const rows = await t.run(async (ctx) => ({
      periods: await ctx.db.query('billing_periods').collect(),
      receipts: await ctx.db.query('billing_webhooks').collect(),
      audits: await ctx.db.query('platform_audit_log').collect(),
    }))
    expect(rows.periods).toHaveLength(1)
    expect(rows.periods[0].seats).toBe(8)
    expect(rows.receipts.filter((row) => row.event_id === 'delivery-1')).toHaveLength(1)
    expect(rows.audits.filter((row) => row.action === 'billing.subscription')).toHaveLength(1)
  })

  it('leaves the subscription row as it is when Polar reports nothing new', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    const before = await stored(t, f.org.id)
    vi.setSystemTime(Date.now() + 60 * 60_000)
    await t.mutation(apply, { payload: remote(f.org.id) })
    expect(await stored(t, f.org.id)).toEqual(before)
  })

  it('writes the subscription row when Polar reports one field changed', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    vi.setSystemTime(Date.now() + 60 * 60_000)
    await t.mutation(apply, {
      payload: remote(f.org.id, { cancel_at_period_end: true, modified_at: iso(60) }),
    })
    expect(await stored(t, f.org.id)).toMatchObject({
      cancel_at_period_end: true,
      updated_at: new Date().toISOString(),
    })
  })

  it('records the ceiling sentence and leaves Polar seats alone past the online billing ceiling', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await pastSeatCeiling(t, f.org.id)
    const fetchMock = vi.fn(async () => new Response(remote(f.org.id)))
    vi.stubGlobal('fetch', fetchMock)
    await t.action(reconcile, { org_id: f.org.id })
    // the old code went on to ask Polar for the seat change, which failed
    // into the generic retry sentence
    expect(await stored(t, f.org.id)).toMatchObject({
      sync_error: LIMITS.billingSeats.refusal,
      billed_seats: 5,
    })
    expect(fetchMock).toHaveBeenCalled()
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method, String(url)).toBe('GET')
    }
  })

  it('a canceled predecessor cannot revoke or rebind a paid replacement', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id, { status: 'canceled' }) })
    const replacement = remote(f.org.id, {
      id: replacementId,
      current_period_start: NOW,
      current_period_end: '2026-10-20T12:00:00.000Z',
      modified_at: '2026-09-20T12:01:00.000Z',
    })
    await t.mutation(apply, { payload: replacement })
    await t.mutation(apply, {
      payload: remote(f.org.id, { status: 'canceled', modified_at: '2026-09-20T12:05:00.000Z' }),
      event_id: 'late-old-cancel',
    })
    expect(await stored(t, f.org.id)).toMatchObject({
      polar_subscription_id: replacementId,
      status: 'active',
      current_period_start: NOW,
    })
  })

  it('refuses missing/foreign org and product bindings and leaves subscriptions untouched', async () => {
    const { t, f } = await fixture()
    await expectRefusal(
      t.mutation(apply, { payload: remote(f.otherOrg.id) }),
      'bad_request',
      /assigned organization plan/,
    )
    await expectRefusal(
      t.mutation(apply, { payload: remote(f.org.id, { product_id: uuid() }) }),
      'bad_request',
      /does not match/,
    )
    await expectRefusal(
      t.mutation(apply, {
        payload: remote(f.org.id, { customer: { id: customerId, external_id: null } }),
      }),
      'bad_request',
      /no Qivo organization/,
    )
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'pending', billed_seats: 0 })
    expect(await stored(t, f.otherOrg.id)).toBeNull()
  })

  it('samples the totals once at the renewal, files in Deleted items included, and retries the same durable charge without duplicating it', async () => {
    const { t, f } = await fixture()
    // 7 GB the totals count, and three files attached in the app: one stays,
    // one goes to Deleted items with its task and still counts, and one is
    // deleted for good and counts no more
    await storeBytes(t, f, 7_000_000_000)
    await attachFile(t, f, 100)
    const trashed = await attachFile(t, f, 20)
    const removed = await attachFile(t, f, 3)
    await billingOff(async () => {
      await deleteTask(t, f, trashed.task.id)
      await as(t, f.user).mutation(api.files.removeAttachment, {
        org_id: f.org.id,
        id: removed.attachment.id,
      })
    })
    await sample(t)
    vi.setSystemTime(NOW)
    expect(await t.run((ctx) => orgTotalsRow(ctx, f.org.id))).toMatchObject({
      bytes: 7_000_000_120,
      files: 3,
    })

    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'initial-period' })
    await sample(t)
    // a file attached after the sample changes nothing until the next period
    await attachFile(t, f, 9)
    await t.mutation(apply, {
      payload: remote(f.org.id, { modified_at: '2026-09-20T12:01:00.000Z' }),
      event_id: 'retry-period',
    })
    await sample(t)
    const snapshot = await t.run(async (ctx) => ({
      periods: await ctx.db.query('billing_periods').collect(),
      events: await ctx.db.query('billing_events').collect(),
    }))
    expect(snapshot.periods).toHaveLength(1)
    expect(snapshot.periods[0]).toMatchObject({
      seats: 5,
      storage_bytes: 7_000_000_120,
      storage_blocks: 3,
    })
    expect(snapshot.events).toHaveLength(1)
    const event = snapshot.events[0]
    expect(event).toMatchObject({ kind: 'storage', units: 3, id: `${providerId}:${START}:storage` })
    expect(await t.mutation(eventReady, { id: event.id })).toBe(true)
    await t.mutation(eventResult, { id: event.id, success: true })
    await t.mutation(eventResult, { id: event.id, success: false })
    const sent = await t.run((ctx) =>
      ctx.db
        .query('billing_events')
        .withIndex('by_uuid', (q) => q.eq('id', event.id))
        .unique(),
    )
    expect(sent).toMatchObject({ attempts: 1, sent_at: NOW })

    // the renewal's sample counts the later file
    const next = { start: END, end: '2026-11-01T12:00:00.000Z' }
    await t.mutation(apply, {
      payload: remote(f.org.id, {
        current_period_start: next.start,
        current_period_end: next.end,
        modified_at: next.start,
      }),
      event_id: 'renewal',
    })
    await sample(t)
    expect(await periodAt(t, next.start)).toMatchObject({
      storage_bytes: 7_000_000_129,
      storage_blocks: 3,
    })
    expect(await periodAt(t, START)).toMatchObject({ storage_bytes: 7_000_000_120 })
  })

  it('charges the blocks past the allowance, none at exactly the allowance', async () => {
    const { t, f } = await fixture()
    // the plan includes 5 GB for its five seats
    const periods = [
      { add: 5_000_000_000, bytes: 5_000_000_000, blocks: 0 },
      { add: 1, bytes: 5_000_000_001, blocks: 1 },
      { add: 3_999_999_999, bytes: 9_000_000_000, blocks: 4 },
    ]
    for (const [i, period] of periods.entries()) {
      await storeBytes(t, f, period.add)
      const start = addCalendarMonths(START, i)
      await t.mutation(apply, {
        payload: remote(f.org.id, {
          current_period_start: start,
          current_period_end: addCalendarMonths(start, 1),
          modified_at: new Date(Date.parse(NOW) + i * 1000).toISOString(),
        }),
      })
      await sample(t)
      expect(await periodAt(t, start)).toMatchObject({
        storage_bytes: period.bytes,
        storage_blocks: period.blocks,
      })
    }
    expect((await storageEvents(t)).map((e) => [e.period_start, e.units])).toEqual([
      [addCalendarMonths(START, 1), 1],
      [addCalendarMonths(START, 2), 4],
    ])
  })

  it('waits while a recount leaves the totals not complete, records no 0, and finishes from the totals counted meanwhile', async () => {
    const { t, f } = await fixture()
    await attachFile(t, f, 100)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recount = recountOf(t, f.org.id)
    const totals = () => t.run((ctx) => orgTotalsRow(ctx, f.org.id))
    // the recount's first step deletes the organization's row
    expect(await recount()).toBeNull()
    expect(await totals()).toBeNull()

    await t.mutation(apply, { payload: remote(f.org.id) })
    const started = await periodAt(t, START)
    expect(started?.storage_run).toEqual(expect.any(String))
    await sample(t)
    // the step wrote nothing and the sample keeps its run
    expect(await periodAt(t, START)).toEqual(started)
    expect(warnings).toHaveBeenCalledWith(
      `billing: storage sample of period ${started?._id} waits; its organization's storage totals are being counted`,
    )

    // the next step starts the count, which reads as not complete too
    expect(await recount()).toBeNull()
    expect(await totals()).toMatchObject({ counting: expect.anything() })
    vi.setSystemTime(Date.parse(NOW) + STORAGE_STALL_MS + 1000)
    await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(1) }) })
    const restarted = await periodAt(t, START)
    expect(restarted).toMatchObject({ storage_attempts: 2 })
    expect(restarted?.storage_run).not.toBe(started?.storage_run)
    await sample(t)
    expect(await periodAt(t, START)).toEqual(restarted)
    expect(await storageEvents(t)).toEqual([])

    // the count ends, and the next start finishes from its totals
    let counted = await recount()
    while (counted === null) counted = await recount()
    expect(counted).toEqual({ bytes: 100, files: 1 })
    vi.setSystemTime(Date.parse(NOW) + 2 * (STORAGE_STALL_MS + 1000))
    await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(2) }) })
    await sample(t)
    const period = await periodAt(t, START)
    expect(period).toMatchObject({ storage_bytes: 100, storage_blocks: 0 })
    for (const field of ['storage_run', 'storage_run_at', 'storage_attempts'])
      expect(period).not.toHaveProperty(field)
    // two waits, each with the restart after it, and no wait once counted
    expect(warnings.mock.calls.filter(([line]) => String(line).includes(' waits; '))).toHaveLength(
      2,
    )
  })

  it('stops a sample whose totals stay not complete through its starts, with no storage, and finishes it on the retry once they are counted', async () => {
    const { t, f } = await fixture()
    await attachFile(t, f, 100)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recount = recountOf(t, f.org.id)
    expect(await recount()).toBeNull()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    // every start's step runs and waits
    for (let n = 1; n <= STORAGE_ATTEMPTS; n++) {
      vi.setSystemTime(Date.parse(NOW) + n * (STORAGE_STALL_MS + 1000))
      await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(n) }) })
      await sample(t)
    }
    const stopped = await periodAt(t, START)
    expect(stopped?.storage_failed_at).toEqual(expect.any(String))
    for (const field of ['storage_run', 'storage_bytes', 'storage_blocks'])
      expect(stopped).not.toHaveProperty(field)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(await sampleAudits(t)).toMatchObject([
      { action: 'billing.storage_sample_failed', detail: { attempts: STORAGE_ATTEMPTS } },
    ])
    expect(await storageEvents(t)).toEqual([])

    // counted meanwhile, the six-hourly retry finishes it
    let counted = await recount()
    while (counted === null) counted = await recount()
    vi.setSystemTime(Date.parse(stopped?.storage_failed_at ?? '') + STORAGE_RETRY_MS + 1000)
    await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(100) }) })
    await sample(t)
    expect(await periodAt(t, START)).toMatchObject({ storage_bytes: 100, storage_blocks: 0 })
  })

  it('measures a sample that waited when it is taken, files stored during the wait included, and Billing names its date', async () => {
    const { t, f } = await fixture()
    await attachFile(t, f, 100)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // a period that started an hour ago, while a recount leaves the totals
    // not complete
    const start = new Date(Date.parse(NOW) - 60 * 60_000).toISOString()
    const end = addCalendarMonths(start, 1)
    const recount = recountOf(t, f.org.id)
    expect(await recount()).toBeNull()
    await t.mutation(apply, {
      payload: remote(f.org.id, { current_period_start: start, current_period_end: end }),
    })
    await sample(t)
    const waiting = await periodAt(t, start)
    if (waiting?.storage_run === undefined) throw new Error('expected a waiting sample')
    expect(waiting).not.toHaveProperty('storage_sampled_at')

    // a file stored during the wait, which the recount counts
    await attachFile(t, f, 20)
    let counted = await recount()
    while (counted === null) counted = await recount()
    expect(counted).toEqual({ bytes: 120, files: 2 })
    // an operator starts the sample again two days into the period
    const later = Date.parse(NOW) + 2 * 24 * 60 * 60_000
    vi.setSystemTime(later)
    expect(await t.mutation(restartStorage, { period: waiting._id })).toBe(true)
    await sample(t)
    const taken = await periodAt(t, start)
    expect(taken).toMatchObject({ storage_bytes: 120, storage_blocks: 0 })
    const at = taken?.storage_sampled_at ?? ''
    expect(Date.parse(at)).toBeGreaterThanOrEqual(later)
    expect(Date.parse(at)).toBeLessThan(later + 60_000)
    vi.setSystemTime(later + 60_000)
    const usage = await as(t, f.admin).query(usageFigures, { org_id: f.org.id })
    expect(usage).toMatchObject({
      period_kind: 'paid',
      period_start: start,
      sampled_storage_bytes: 120,
      sampled_storage_at: at,
    })
    expect(storageSampleLine(usage, 'active')).toBe(`120 B measured on ${billingDate(at)}.`)

    // the next period's sample, taken at its renewal, reads as its start
    const renewal = Date.parse(end) + 60_000
    vi.setSystemTime(renewal)
    await t.mutation(apply, {
      payload: remote(f.org.id, {
        current_period_start: end,
        current_period_end: addCalendarMonths(end, 1),
        modified_at: new Date(renewal).toISOString(),
      }),
      event_id: 'renewal',
    })
    await sample(t)
    vi.setSystemTime(renewal + 60_000)
    const renewed = await as(t, f.admin).query(usageFigures, { org_id: f.org.id })
    expect(renewed).toMatchObject({
      period_start: end,
      sampled_storage_bytes: 120,
      sampled_storage_at: expect.any(String),
    })
    expect(storageSampleLine(renewed, 'active')).toBe('120 B measured at the start of this period.')
  })

  it('reads the same documents for an organization with 1,500 project totals rows as for one with one file', async () => {
    /* The period, its organization's 1,500 sub-projects (500 live and 1,000
     * archived, summed as one read of the totals would cover them) or one,
     * and the read of its sample, which stays under the allowance. */
    async function measure(projects: number): Promise<Read> {
      const { t, f } = await fixture()
      for (let from = 0; from < projects; from += 500)
        await t.run(async (ctx) => {
          for (let i = from; i < Math.min(projects, from + 500); i++)
            await addToProject(ctx, f.org.id, uuid(), i + 100, { bytes: 1000, files: 1 }, `P ${i}`)
          const org = await orgTotalsRow(ctx, f.org.id)
          if (org === null) throw new Error('the organization is not counted')
          const n = Math.min(projects, from + 500) - from
          await addToOrg(ctx, org, { bytes: n * 1000, files: n })
        })
      await t.mutation(apply, { payload: remote(f.org.id) })
      const period = await periodAt(t, START)
      if (period?.storage_run === undefined) throw new Error('expected a running sample')
      const run = period.storage_run
      const read = await t.run(async (ctx) => {
        await takeStorageSample(ctx, period._id, run)
        const m = await ctx.meta.getTransactionMetrics()
        return {
          ranges: m.databaseQueries.used,
          documents: m.documentsRead.used,
          bytes: m.bytesRead.used,
        }
      })
      expect(await periodAt(t, START)).toMatchObject({ storage_bytes: projects * 1000 })
      return read
    }
    const one = await measure(1)
    const many = await measure(1500)
    console.log('period sample reads', JSON.stringify({ one, many }))
    expect(many.documents).toBe(one.documents)
    expect(many.ranges).toBe(one.ranges)
  })

  it.each([
    { phase: 'own', cursor: 'a-page-cursor', size: 3, bytes: 123 },
    { phase: 'unscoped', bytes: 7_000_000_000 },
    { phase: 'tasks', bytes: 7_000_000_000 },
    { bytes: 0 },
  ])('finishes from the totals a step an earlier release queued (%o)', async (queued) => {
    const { t, f } = await fixture()
    await storeBytes(t, f, 6_000_000_000)
    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'queued-period' })
    const pending = await periodAt(t, START)
    if (pending?.storage_run === undefined) throw new Error('expected a running sample')
    // the step the earlier release scheduled, with what its scan carried
    await t.mutation(
      makeFunctionReference<'mutation', Record<string, unknown>, null>('billingSync:storageStep'),
      { period: pending._id, run: pending.storage_run, ...queued },
    )
    expect(await periodAt(t, START)).toMatchObject({
      storage_bytes: 6_000_000_000,
      storage_blocks: 1,
    })
    // the step this release queued then finds its run gone
    await sample(t)
    expect(await storageEvents(t)).toMatchObject([{ units: 1 }])
  })

  it('starts a stalled sample again, and the earlier run stops', async () => {
    const { t, f } = await fixture()
    await storeBytes(t, f, 6_000_000_000)
    await t.mutation(apply, { payload: remote(f.org.id) })
    const first = (await periodAt(t, START))?.storage_run
    expect(first).toEqual(expect.any(String))

    // a sample that ran recently is left alone
    vi.setSystemTime(Date.parse(NOW) + STORAGE_STALL_MS - 1000)
    await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(1) }) })
    expect((await periodAt(t, START))?.storage_run).toBe(first)

    vi.setSystemTime(Date.parse(NOW) + STORAGE_STALL_MS + 1000)
    await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(2) }) })
    const second = (await periodAt(t, START))?.storage_run
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)

    // both runs' first steps run; only the second records the sample
    await sample(t)
    const period = await periodAt(t, START)
    expect(period).toMatchObject({ storage_bytes: 6_000_000_000, storage_blocks: 1 })
    expect(period).not.toHaveProperty('storage_run')
    expect(await storageEvents(t)).toHaveLength(1)
  })

  it('stops a sample that stalls STORAGE_ATTEMPTS times, says so, and starts it again on request', async () => {
    const { t, f } = await fixture()
    await storeBytes(t, f, 6_000_000_000)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await t.mutation(apply, { payload: remote(f.org.id) })
    expect(await periodAt(t, START)).toMatchObject({ storage_attempts: 1 })
    // no step ever runs, so every run stalls
    const stall = async (n: number) => {
      vi.setSystemTime(Date.parse(NOW) + n * (STORAGE_STALL_MS + 1000))
      await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(n) }) })
    }
    for (let n = 1; n < STORAGE_ATTEMPTS; n++) await stall(n)
    expect(await periodAt(t, START)).toMatchObject({ storage_attempts: STORAGE_ATTEMPTS })
    expect(errors).not.toHaveBeenCalled()

    await stall(STORAGE_ATTEMPTS)
    const stopped = await periodAt(t, START)
    expect(stopped?.storage_failed_at).toEqual(expect.any(String))
    expect(stopped).not.toHaveProperty('storage_run')
    expect(stopped).not.toHaveProperty('storage_bytes')
    expect(errors).toHaveBeenCalledTimes(1)
    const failures = await t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter(
        (row) => row.action === 'billing.storage_sample_failed',
      ),
    )
    expect(failures).toMatchObject([
      {
        target_org_id: f.org.id,
        detail: { period: stopped?._id, period_start: START, attempts: STORAGE_ATTEMPTS },
      },
    ])
    // a stopped sample stays stopped until STORAGE_RETRY_MS has passed, and
    // the earlier runs' steps do nothing
    await stall(STORAGE_ATTEMPTS + 1)
    await sample(t)
    expect(await periodAt(t, START)).toMatchObject({
      storage_failed_at: stopped?.storage_failed_at,
    })
    expect(await periodAt(t, START)).not.toHaveProperty('storage_bytes')
    expect(errors).toHaveBeenCalledTimes(1)

    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { sync_due_at: iso(100_000), sync_safety: true })
    })
    expect(await t.mutation(restartStorage, { period: stopped!._id })).toBe(true)
    // a reconciliation starts the sample again if it stalls once more
    expect(await stored(t, f.org.id)).toMatchObject({
      sync_due_at: new Date(Date.now() + STORAGE_STALL_MS + 60_000).toISOString(),
    })
    expect(await stored(t, f.org.id)).not.toHaveProperty('sync_safety')
    const restarts = await t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter(
        (row) => row.action === 'billing.storage_sample_restarted',
      ),
    )
    expect(restarts).toMatchObject([
      { actor_email: 'cli', target_org_id: f.org.id, detail: { period: stopped?._id } },
    ])
    await sample(t)
    const period = await periodAt(t, START)
    expect(period).toMatchObject({ storage_bytes: 6_000_000_000, storage_blocks: 1 })
    for (const field of ['storage_run', 'storage_attempts', 'storage_failed_at'])
      expect(period).not.toHaveProperty(field)
    // a finished sample is left alone
    expect(await t.mutation(restartStorage, { period: stopped!._id })).toBe(false)
  })

  /* A period of a 6 GB organization whose sample stalls STORAGE_ATTEMPTS
   * times and stops, and the time it stopped. */
  async function stoppedSample() {
    vi.setSystemTime(NOW)
    const { t, f } = await fixture()
    await storeBytes(t, f, 6_000_000_000)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await t.mutation(apply, { payload: remote(f.org.id) })
    const stall = (at: number, minute: number) => {
      vi.setSystemTime(at)
      return t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(minute) }) })
    }
    // no step runs while the outage lasts, so every run stalls
    for (let n = 1; n <= STORAGE_ATTEMPTS; n++)
      await stall(Date.parse(NOW) + n * (STORAGE_STALL_MS + 1000), n)
    const stopped = await periodAt(t, START)
    expect(stopped).not.toHaveProperty('storage_run')
    return { t, f, stall, stoppedAt: Date.parse(stopped?.storage_failed_at ?? '') }
  }

  const sampleAudits = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter((row) =>
        row.action.startsWith('billing.storage_sample_'),
      ),
    )

  it('starts a stopped sample again on its own STORAGE_RETRY_MS after it stopped', async () => {
    const { t, stall, stoppedAt } = await stoppedSample()
    const stoppedRow = await periodAt(t, START)
    await stall(stoppedAt + STORAGE_RETRY_MS - 1000, 100)
    expect(await periodAt(t, START)).not.toHaveProperty('storage_run')

    await stall(stoppedAt + STORAGE_RETRY_MS + 1000, 101)
    // the stop stays on the period and in the audit log while the retry runs
    expect(await periodAt(t, START)).toMatchObject({
      storage_run: expect.any(String),
      storage_attempts: 1,
      storage_failed_at: stoppedRow?.storage_failed_at,
    })
    expect(await sampleAudits(t)).toMatchObject([
      { action: 'billing.storage_sample_failed', detail: { period: stoppedRow?._id } },
    ])

    // the outage is over: the sample finishes and the period is charged
    await sample(t)
    const period = await periodAt(t, START)
    expect(period).toMatchObject({ storage_bytes: 6_000_000_000, storage_blocks: 1 })
    for (const field of ['storage_run', 'storage_attempts', 'storage_failed_at'])
      expect(period).not.toHaveProperty(field)
    expect(await storageEvents(t)).toHaveLength(1)
  })

  it('stops a retry that keeps failing again without another audit row', async () => {
    const { t, stall, stoppedAt } = await stoppedSample()
    const retried = stoppedAt + STORAGE_RETRY_MS + 1000
    await stall(retried, 100)
    for (let n = 1; n <= STORAGE_ATTEMPTS; n++)
      await stall(retried + n * (STORAGE_STALL_MS + 1000), 100 + n)
    const again = await periodAt(t, START)
    expect(again).not.toHaveProperty('storage_run')
    expect(Date.parse(again?.storage_failed_at ?? '')).toBeGreaterThan(stoppedAt)
    expect(await sampleAudits(t)).toHaveLength(1)
  })

  it('leaves a stopped sample alone once its charge could no longer land', async () => {
    const { t, f, stoppedAt } = await stoppedSample()
    vi.setSystemTime(stoppedAt + STORAGE_RETRY_MS + 1000)
    await t.mutation(apply, {
      payload: remote(f.org.id, { status: 'canceled', ended_at: NOW, modified_at: iso(100) }),
    })
    expect(await periodAt(t, START)).not.toHaveProperty('storage_run')
    // nor after the period ends, whatever the subscription says
    const late = await stoppedSample()
    vi.setSystemTime(Date.parse(END) + 1000)
    await late.t.mutation(apply, { payload: remote(late.f.org.id, { modified_at: iso(100) }) })
    expect(await periodAt(late.t, START)).not.toHaveProperty('storage_run')
  })

  it('records the storage of a complimentary period without charging it', async () => {
    const { t, f } = await fixture()
    await storeBytes(t, f, 6_000_000_000)
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { complimentary_until: END })
    })
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    expect(await periodAt(t, START)).toMatchObject({
      storage_bytes: 6_000_000_000,
      storage_blocks: 1,
    })
    expect(await storageEvents(t)).toEqual([])
  })

  it.each([0, 1])(
    'abandons stale usage with %i prior attempts so it cannot enter a replacement invoice',
    async (attempts) => {
      const { t, f } = await fixture()
      await t.mutation(apply, { payload: remote(f.org.id) })
      const eventId = 'old-cycle-api'
      await t.run((ctx) =>
        ctx.db.insert('billing_events', {
          id: eventId,
          org_id: f.org.id,
          kind: 'api',
          period_start: '2026-08-01T12:00:00.000Z',
          units: 1,
          attempts,
          next_attempt_at: NOW,
          created_at: '2026-08-31T12:00:00.000Z',
        }),
      )
      expect(await t.mutation(eventReady, { id: eventId })).toBe(false)
      expect(await t.mutation(eventReady, { id: eventId })).toBe(false)
      const result = await t.run(async (ctx) => ({
        event: await ctx.db
          .query('billing_events')
          .withIndex('by_uuid', (q) => q.eq('id', eventId))
          .unique(),
        audit: await ctx.db.query('platform_audit_log').collect(),
      }))
      expect(result.event).toMatchObject({ abandoned_at: NOW, finished_at: NOW, attempts })
      expect(result.event).not.toHaveProperty('sent_at')
      const notices = result.audit.filter((row) => row.action === 'billing.usage_delivery_stopped')
      expect(notices).toHaveLength(1)
      expect(notices[0].detail).toMatchObject({ outcome: attempts ? 'unconfirmed' : 'not_sent' })
    },
  )

  it.each([30_001, 30_000, 0])(
    'stops usage submission at the invoice cutoff (%i milliseconds remaining)',
    async (remaining) => {
      const { t, f } = await fixture()
      await t.mutation(apply, { payload: remote(f.org.id) })
      await t.run((ctx) =>
        ctx.db.insert('billing_events', {
          id: 'cutoff',
          org_id: f.org.id,
          kind: 'api',
          period_start: START,
          units: 1,
          attempts: 0,
          next_attempt_at: NOW,
          created_at: NOW,
        }),
      )
      vi.setSystemTime(Date.parse(END) - remaining)
      expect(await t.mutation(eventReady, { id: 'cutoff' })).toBe(remaining > 30_000)
    },
  )

  it('retries an open-cycle event with its existing ID and guards against concurrent submissions', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await t.run((ctx) =>
      ctx.db.insert('billing_events', {
        id: 'retryable',
        org_id: f.org.id,
        kind: 'api',
        period_start: START,
        units: 1,
        attempts: 0,
        next_attempt_at: NOW,
        created_at: NOW,
      }),
    )
    expect(await t.mutation(eventReady, { id: 'retryable' })).toBe(true)
    expect(await t.mutation(eventReady, { id: 'retryable' })).toBe(false)
    await t.mutation(eventResult, { id: 'retryable', success: false })
    vi.setSystemTime(Date.parse(NOW) + 60_000)
    expect(await t.mutation(eventReady, { id: 'retryable' })).toBe(true)
    await t.mutation(eventResult, { id: 'retryable', success: true })
    expect(await t.mutation(eventReady, { id: 'retryable' })).toBe(false)
    const result = await t.run((ctx) => ctx.db.query('billing_events').collect())
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'retryable',
      attempts: 2,
      sent_at: '2026-09-20T12:01:00.000Z',
      finished_at: '2026-09-20T12:01:00.000Z',
    })
  })
})

describe('when organizations are reconciled', () => {
  const dueAt = async (t: T, orgId: string) => (await stored(t, orgId))?.sync_due_at
  const notices = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('billing_notices').collect()).map((n) => [n.profile_id, n.kind]),
    )
  /* Gives the organization a free period until `until`, enrolling it first,
   * with its next reminder as if the sweep had sent every reminder up to an
   * hour ago. */
  const grantUntil = (t: T, orgId: string, until: string, updated = NOW) =>
    t.run(async (ctx) => {
      const sub = await enrollOrganization(ctx, orgId)
      await ctx.db.patch(sub!._id, {
        complimentary_until: until,
        updated_at: updated,
        remind_at: nextReminder(until, Date.now() - 60 * 60_000),
      })
    })
  /* Takes the lock and frees it again, as a reconciliation that finds
   * nothing to change does, and answers the due time it leaves. */
  const settle = async (t: T, orgId: string, release_: { seats?: number; error?: string } = {}) => {
    const work = await t.mutation(claim, { org_id: orgId })
    await t.mutation(release, { org_id: orgId, token: work!.token, ...release_ })
    return await dueAt(t, orgId)
  }

  it('writes and schedules nothing in a minute when no organization is due', async () => {
    const { t, f } = await fixture()
    await setDue(t, f.org.id, iso(1))
    // a free period between its reminder times
    await grantUntil(t, f.otherOrg.id, iso(3 * 24 * 60))
    await setDue(t, f.otherOrg.id, iso(1))
    const before = await stored(t, f.org.id)
    await t.mutation(sweep, {})
    // the old sweep scheduled a reconciliation for every organization each minute
    expect(await queued(t, 'billingSync:reconcile')).toEqual([])
    expect(await queued(t, 'billingSync:pump')).toEqual([])
    expect(await queued(t, 'billingSync:reminders')).toEqual([])
    expect(await stored(t, f.org.id)).toEqual(before)
  })

  it('starts due organizations a page at a time, the safety pass its share, then targeted times, then those without one', async () => {
    const { t, f } = await fixture()
    SYNC_PAGE.size = 3
    SYNC_PAGE.safety = 1
    const [late, early, safe, safer] = [uuid(), uuid(), uuid(), uuid()]
    await t.run(async (ctx) => {
      for (const id of [late, early, safe, safer]) await enrollOrganization(ctx, id)
    })
    // f.org has no due time, as for an organization enrolled before due times
    await setDue(t, f.org.id, undefined)
    await setDue(t, late, iso(-1))
    await setDue(t, early, iso(-2))
    await setDue(t, safe, iso(-30), true)
    await setDue(t, safer, iso(-40), true)
    await t.mutation(sweep, {})
    const first = await queued(t, 'billingSync:reconcile')
    expect(first.map((job) => job.args[0].org_id)).toEqual([early, late, safer])
    expect(first[1].scheduledTime - first[0].scheduledTime).toBe(SYNC_PAGE.spacing)
    await t.mutation(sweep, {})
    const second = await queued(t, 'billingSync:reconcile')
    // what the targeted times leave goes to the safety pass too
    expect(second.slice(3).map((job) => job.args[0].org_id)).toEqual([f.org.id, safe])
    await t.mutation(sweep, {})
    expect(await queued(t, 'billingSync:reconcile')).toHaveLength(5)
  })

  it('starts usage delivery once a usage event is due', async () => {
    const { t, f } = await fixture()
    await setDue(t, f.org.id, iso(10))
    await t.run((ctx) =>
      ctx.db.insert('billing_events', {
        id: uuid(),
        org_id: f.org.id,
        kind: 'api',
        period_start: START,
        units: 1,
        attempts: 0,
        next_attempt_at: iso(1),
        created_at: NOW,
      }),
    )
    await t.mutation(sweep, {})
    expect(await queued(t, 'billingSync:pump')).toEqual([])
    vi.setSystemTime(Date.parse(iso(1)))
    await t.mutation(sweep, {})
    expect(await queued(t, 'billingSync:pump')).toHaveLength(1)
  })

  it('reconciles a paid organization again by its storage sample, its renewal or the safety pass', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    // the renewal started a storage sample, which apply starts again if it stalls
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(iso(STORAGE_STALL_MS / 60_000 + 1))
    // it finished, so that check is dropped and no reconciliation comes of it
    await sample(t)
    expect(await dueAt(t, f.org.id)).toBe(iso(minutesAfter(SYNC_SAFETY_MS)))
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(iso(minutesAfter(SYNC_SAFETY_MS)))
    const end = Date.parse(END)
    vi.setSystemTime(end - 60 * 60_000)
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(end - PRE_RENEWAL_MS).toISOString(),
    )
    vi.setSystemTime(end - 60_000)
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(end + POST_RENEWAL_MS).toISOString(),
    )
    // No renewal arrived: poll within the day of access after the period,
    // faster than any organization can pass an allowance of 125,000 calls
    // in the waived pending bucket. The old poll every 30 minutes could.
    vi.setSystemTime(end + 10 * 60_000)
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(end + 10 * 60_000 + RENEWAL_POLL_MS - SWEEP_INTERVAL_MS).toISOString(),
    )
    expect(RENEWAL_POLL_MS).toBeLessThan((5 * 25_000 * 60_000) / 6_000)
    vi.setSystemTime(end + 25 * 60 * 60_000)
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(end + 25 * 60 * 60_000 + SYNC_SAFETY_MS - SWEEP_INTERVAL_MS).toISOString(),
    )
  })

  it('keeps a sooner time asked for while a storage sample ran', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(iso(STORAGE_STALL_MS / 60_000 + 1))
    // a membership change while the sample runs
    await t.run((ctx) => billingDueBy(ctx, f.org.id, NOW))
    await sample(t)
    expect(await dueAt(t, f.org.id)).toBe(NOW)
  })

  it('reconciles an organization polled every PAYMENT_POLL_MS at that pace under the minute sweep', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id, { status: 'past_due' }) })
    await sample(t)
    // The sweep runs every minute from NOW, and each reconciliation it
    // starts ends half a second later. Stored from that end, the old due
    // time was half a second after the sweep two minutes on, so the poll
    // landed every three minutes.
    const started: number[] = []
    for (let minute = 0; minute <= 6; minute++) {
      vi.setSystemTime(Date.parse(iso(minute)))
      await t.mutation(sweep, {})
      for (const job of await queued(t, 'billingSync:reconcile')) {
        await t.run((ctx) => ctx.scheduler.cancel(job._id))
        if (job.args[0].org_id !== f.org.id) continue
        started.push(minute)
        vi.setSystemTime(Date.parse(iso(minute)) + 500)
        await settle(t, f.org.id, { seats: 5 })
      }
    }
    expect(PAYMENT_POLL_MS).toBe(2 * SWEEP_INTERVAL_MS)
    expect(started).toEqual([0, 2, 4, 6])
  })

  it('polls a pending checkout and leaves an unconnected plan for the safety pass', async () => {
    const { t, f, planId } = await fixture()
    const expires = iso(60)
    // saving the checkout moves the organization off the safety pass
    await setDue(t, f.org.id, iso(SYNC_SAFETY_MS / 60_000), true)
    const { token } = await t.mutation(reserveCheckout, { org_id: f.org.id })
    await t.mutation(finishCheckout, {
      org_id: f.org.id,
      token,
      checkout_id: uuid(),
      url: 'https://sandbox.polar.sh/checkout/example',
      expires_at: expires,
    })
    expect(await stored(t, f.org.id)).toMatchObject({ sync_due_at: iso(PAYMENT_POLL_MS / 60_000) })
    expect(await stored(t, f.org.id)).not.toHaveProperty('sync_safety')
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { checkout_id: uuid(), checkout_expires_at: expires })
    })
    expect(await settle(t, f.org.id)).toBe(iso(minutesAfter(PAYMENT_POLL_MS)))
    // a checkout Polar never ends stops being polled an hour after its expiry
    const late = Date.parse(expires) + CHECKOUT_POLL_GRACE_MS
    vi.setSystemTime(late)
    expect(await settle(t, f.org.id)).toBe(
      new Date(late + SYNC_SAFETY_MS - SWEEP_INTERVAL_MS).toISOString(),
    )
    vi.setSystemTime(NOW)
    await t.run(async (ctx) => {
      const plan = await ctx.db
        .query('billing_plans')
        .withIndex('by_uuid', (q) => q.eq('id', planId))
        .unique()
      await ctx.db.patch(plan!._id, { polar_product_id: undefined })
    })
    await setDue(t, f.org.id, undefined)
    // the sweep's fence comes first, as in every minute's run
    await t.mutation(sweep, {})
    expect(await t.mutation(claim, { org_id: f.org.id })).toBeNull()
    expect(await stored(t, f.org.id)).toMatchObject({
      sync_due_at: iso(minutesAfter(SYNC_SAFETY_MS)),
      sync_safety: true,
    })
  })

  it('keeps a change asked for while another reconciliation runs', async () => {
    const { t, f } = await fixture()
    const work = await t.mutation(claim, { org_id: f.org.id })
    // a membership change's reconciliation meets the lock
    expect(await t.mutation(claim, { org_id: f.org.id })).toBeNull()
    await t.mutation(release, { org_id: f.org.id, token: work!.token, seats: 5 })
    expect(await dueAt(t, f.org.id)).toBe(NOW)
    await t.mutation(sweep, {})
    expect((await queued(t, 'billingSync:reconcile')).map((job) => job.args[0].org_id)).toEqual([
      f.org.id,
    ])
  })

  it('retries a failed reconciliation after 1, 2 and 4 minutes, then returns to its schedule', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    )
    for (const minutes of [1, 2, 4]) {
      await t.action(reconcile, { org_id: f.org.id })
      expect(await stored(t, f.org.id)).toMatchObject({
        sync_error: expect.stringMatching(/Automatic retries/),
        sync_due_at: iso(minutesAfter(minutes * 60_000)),
      })
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(remote(f.org.id))),
    )
    await t.action(reconcile, { org_id: f.org.id })
    const sub = await stored(t, f.org.id)
    expect([sub?.sync_error, sub?.sync_attempts, sub?.sync_due_at]).toEqual([
      undefined,
      undefined,
      iso(minutesAfter(SYNC_SAFETY_MS)),
    ])
  })

  it('lets no failure push the check before a renewal past it', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    const end = Date.parse(END)
    // five failures in a row, the last 20 minutes before the renewal
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { sync_attempts: 5 })
    })
    vi.setSystemTime(end - 20 * 60_000)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    )
    await t.action(reconcile, { org_id: f.org.id })
    // the 32-minute backoff alone would retry 11 minutes after the renewal
    expect(await stored(t, f.org.id)).toMatchObject({
      sync_attempts: 6,
      sync_due_at: new Date(end - PRE_RENEWAL_MS).toISOString(),
    })
  })

  it('retries every minute when the check before a renewal fails, until the renewal', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    const end = Date.parse(END)
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { sync_attempts: 6 })
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    )
    // the 60-minute backoff and the check after the end would both miss it;
    // the next sweep, a minute after the one that started it, retries
    for (const before of [PRE_RENEWAL_MS, PRE_RENEWAL_MS - 60_000, 60_000]) {
      vi.setSystemTime(end - before)
      await t.action(reconcile, { org_id: f.org.id })
      expect(await dueAt(t, f.org.id)).toBe(
        new Date(end - before + 60_000 - SWEEP_INTERVAL_MS).toISOString(),
      )
    }
    vi.setSystemTime(end + 60_000)
    await t.action(reconcile, { org_id: f.org.id })
    expect(await dueAt(t, f.org.id)).toBe(new Date(end + POST_RENEWAL_MS).toISOString())
  })

  it('keeps a replacement checkout and its poll while the canceled subscription is read again', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, {
      payload: remote(f.org.id, { status: 'canceled', ended_at: NOW }),
    })
    const checkoutId = '66666666-6666-4666-8666-666666666666'
    const expires = iso(60)
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { checkout_id: checkoutId, checkout_expires_at: expires })
    })
    const session = (status: string) => ({
      id: checkoutId,
      url: 'https://sandbox.polar.sh/checkout/example',
      expires_at: expires,
      status,
      product_id: productId,
      external_customer_id: f.org.id,
      seats: 5,
      min_seats: 5,
      max_seats: 5,
    })
    let checkoutStatus = 'open'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('external_customer_id')
          ? new Response(JSON.stringify({ items: [], pagination: { max_page: 1 } }))
          : url.includes('/checkouts/')
            ? new Response(JSON.stringify(session(checkoutStatus)))
            : new Response(remote(f.org.id, { status: 'canceled', ended_at: NOW })),
      ),
    )
    // no replacement subscription yet: the checkout is still open
    await t.action(reconcile, { org_id: f.org.id })
    expect(await stored(t, f.org.id)).toMatchObject({
      checkout_id: checkoutId,
      sync_due_at: iso(minutesAfter(PAYMENT_POLL_MS)),
    })
    checkoutStatus = 'expired'
    vi.setSystemTime(Date.parse(iso(PAYMENT_POLL_MS / 60_000)))
    await t.action(reconcile, { org_id: f.org.id })
    expect((await stored(t, f.org.id))?.checkout_id).toBeUndefined()
    // A checkout that succeeded without a live subscription is kept while it
    // is polled, then the canceled subscription read again clears it, so it
    // cannot hold off the organization's deletion for ever.
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { checkout_id: checkoutId, checkout_expires_at: expires })
    })
    checkoutStatus = 'succeeded'
    await t.action(reconcile, { org_id: f.org.id })
    expect((await stored(t, f.org.id))?.checkout_id).toBe(checkoutId)
    vi.setSystemTime(Date.parse(expires) + CHECKOUT_POLL_GRACE_MS)
    await t.action(reconcile, { org_id: f.org.id })
    expect((await stored(t, f.org.id))?.checkout_id).toBeUndefined()
  })

  it('asks a guest organization to reconcile when a deletion removes the guest home profile', async () => {
    const { t, f } = await fixture()
    // otherAdmin is also a guest in f.org, exempt while the home profile lives
    const email = 'visitor@testbed.test'
    await t.run(async (ctx) => {
      await ctx.db.patch(f.otherAdmin._id, { email })
      await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.org.id,
        email,
        name: 'Visiting admin',
        initials: 'VA',
        color: '#7a7ad0',
        org_role: 'guest',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      await ctx.db.insert('org_removals', {
        org_id: f.otherOrg.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      })
    })
    await setDue(t, f.org.id, iso(SYNC_SAFETY_MS / 60_000))
    await t.run(async (ctx) => {
      const removal = await ctx.db
        .query('org_removals')
        .withIndex('by_org', (q) => q.eq('org_id', f.otherOrg.id))
        .unique()
      await deleteOrgStep(ctx, removal!)
    })
    expect(await dueAt(t, f.org.id)).toBe(NOW)
    // the next minute's sweep starts it; the deletion step schedules nothing
    expect(await queued(t, 'billingSync:reconcile')).toEqual([])
    await t.mutation(sweep, {})
    expect((await queued(t, 'billingSync:reconcile')).map((job) => job.args[0].org_id)).toEqual([
      f.org.id,
    ])
  })

  /* otherAdmin, a home profile of otherOrg under deletion, with an email
   * that holds a guest profile in each of `count` other organizations, each
   * of them due only for the safety pass, and a second home profile deleted
   * after it. The guest profiles are inserted with the clock at `at` when
   * given. */
  /* One more guest organization of `email`, its profile created at `at`,
   * due later, as guestInMany's are. */
  async function guestAt(t: T, email: string, at: number) {
    const orgId = uuid()
    vi.setSystemTime(at)
    await t.run(async (ctx) => {
      await enrollOrganization(ctx, orgId)
      await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: orgId,
        email,
        name: 'Consultant',
        initials: 'CO',
        color: '#7a7ad0',
        org_role: 'guest',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
    })
    vi.setSystemTime(NOW)
    await setDue(t, orgId, iso(SYNC_SAFETY_MS / 60_000), true)
    return orgId
  }

  async function guestInMany(count: number, at?: number) {
    const { t, f } = await fixture()
    const email = 'consultant@testbed.test'
    const guestOrgs = Array.from({ length: count }, () => uuid())
    await t.run(async (ctx) => {
      await ctx.db.patch(f.otherAdmin._id, { email })
      for (const org_id of guestOrgs) await enrollOrganization(ctx, org_id)
    })
    if (at !== undefined) vi.setSystemTime(at)
    await t.run(async (ctx) => {
      for (const org_id of guestOrgs)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id,
          email,
          name: 'Consultant',
          initials: 'CO',
          color: '#7a7ad0',
          org_role: 'guest',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    vi.setSystemTime(NOW)
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: f.otherOrg.id,
        email: 'colleague@testbed.test',
        name: 'Colleague',
        initials: 'CL',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      await ctx.db.insert('org_removals', {
        org_id: f.otherOrg.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      })
    })
    for (const org_id of guestOrgs) await setDue(t, org_id, iso(SYNC_SAFETY_MS / 60_000), true)
    const removal = () =>
      t.run((ctx) =>
        ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.otherOrg.id))
          .unique(),
      )
    const step = () =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query('org_removals')
          .withIndex('by_org', (q) => q.eq('org_id', f.otherOrg.id))
          .unique()
        if (row) await deleteOrgStep(ctx, row)
      })
    const left = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query('profiles')
            .withIndex('by_org', (q) => q.eq('org_id', f.otherOrg.id))
            .collect(),
        )
      ).map((p) => p.email)
    const marked = async () =>
      (await Promise.all(guestOrgs.map((id) => dueAt(t, id)))).filter((due) => due === NOW).length
    // the billable guests of each guest organization, as a reconciliation counts them
    const guests = () =>
      t.run((ctx) =>
        Promise.all(guestOrgs.map(async (id) => (await getBillableUsers(ctx, id)).guests)),
      )
    return { t, f, email, guestOrgs, removal, step, left, marked, guests }
  }

  it('marks the guest organizations of a deleted profile due over several steps, each within its budget', async () => {
    REMOVAL_BUDGET.rows = 32
    const { t, f, email, guestOrgs, removal, step, left, marked, guests } = await guestInMany(40)
    // Each step reads a profile with the email and marks its organization
    // due as two of its rows. Before, the first step read 81 profiles and
    // marked all 40, more than twice its budget.
    const perStep: number[] = []
    while ((await marked()) < guestOrgs.length && perStep.length < 10) {
      const before = await marked()
      await step()
      perStep.push((await marked()) - before)
      // the profile stays, with where its marking stopped, until its last
      // guest organization is marked, but no longer exempts the guest: a
      // reconciliation between the steps counts it in every organization
      if ((await marked()) < guestOrgs.length) {
        expect(await left()).toContain(email)
        expect((await removal())?.guest_marking?.profile_id).toBe(f.otherAdmin.id)
        expect(await guests()).toEqual(guestOrgs.map(() => 1))
      }
    }
    expect(perStep.length).toBeGreaterThan(1)
    for (const count of perStep) expect(count).toBeLessThanOrEqual(REMOVAL_BUDGET.rows / 2)
    expect(await queued(t, 'billingSync:reconcile')).toEqual([])
    expect((await removal())?.guest_marking).toBeUndefined()
    await step()
    expect(await left()).toEqual([])
    expect(await guests()).toEqual(guestOrgs.map(() => 1))
  })

  it('bills the guest seat of a deleted person when a reconciliation runs between the deletion steps', async () => {
    const { t, email, guestOrgs, step, left } = await guestInMany(300)
    // The first guest organization has five people of its own, the plan's
    // minimum, so the deleted person's guest seat makes it six.
    const [first] = guestOrgs
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: first,
          email: `member${i}@testbed.test`,
          name: `Member ${i}`,
          initials: 'ME',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    await step()
    expect(await dueAt(t, first)).toBe(NOW)
    expect(await left()).toContain(email)
    // The sweep reconciles it before the next step and uses up its mark.
    // Before, the home profile was still active, so this sent five seats and
    // the later steps never marked the organization again.
    const work = await t.mutation(claim, { org_id: first })
    expect(work?.seats).toBe(6)
  })

  it('finishes marking guest organizations whose profiles share one creation time, a budget at a time', async () => {
    // convex-test gives an insert 0.001 ms after the one before, which
    // rounds away above 2^52 ms, so there the inserts share a time, as an
    // import can leave them
    const TIED = 2 ** 52
    REMOVAL_BUDGET.rows = 32
    const { t, f, email, guestOrgs, step, left, marked, removal } = await guestInMany(40, TIED)
    // one more guest organization, its profile a millisecond after the group
    const lastOrg = await guestAt(t, email, TIED + 1)
    const group = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('profiles')
          .withIndex('by_email', (q) => q.eq('email', email))
          .collect()
      ).filter((p) => guestOrgs.includes(p.org_id)),
    )
    expect(new Set(group.map((p) => p._creationTime))).toEqual(new Set([TIED]))

    // Each step stops inside the group once its budget is spent, at the _id
    // of the last profile it read, and the next goes on after it. Before, the
    // first step read the whole group past its budget, as a group of a few
    // thousand would in every step, and stopped only after it.
    const perStep: number[] = []
    while ((await marked()) < guestOrgs.length && perStep.length < 10) {
      const before = await marked()
      await step()
      perStep.push((await marked()) - before)
      const stopped = (await removal())?.guest_marking
      if ((await marked()) < guestOrgs.length) {
        expect(stopped).toMatchObject({ profile_id: f.otherAdmin.id, through: TIED })
        expect(group.map((p) => p._id)).toContain(stopped?.through_id)
      }
    }
    expect(perStep.length).toBeGreaterThan(1)
    for (const count of perStep) expect(count).toBeLessThanOrEqual(REMOVAL_BUDGET.rows / 2)
    expect(perStep.reduce((sum, count) => sum + count, 0)).toBe(guestOrgs.length)
    for (let i = 0; i < 3 && (await left()).length > 0; i++) await step()
    expect(await dueAt(t, lastOrg)).toBe(NOW)
    expect((await removal())?.guest_marking).toBeUndefined()
    expect(await left()).toEqual([])
  })

  it('goes on after the whole creation time a marking stored before it kept the _id', async () => {
    const TIED = 2 ** 52
    const { t, f, email, step, marked, removal } = await guestInMany(3, TIED)
    // a guest organization after the group, which the marking still owes
    const lastOrg = await guestAt(t, email, TIED + 1)
    // a position the earlier code stored after reading the group in full
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('org_removals')
        .withIndex('by_org', (q) => q.eq('org_id', f.otherOrg.id))
        .unique()
      await ctx.db.patch(row!._id, {
        guest_marking: { profile_id: f.otherAdmin.id, through: TIED },
      })
      await ctx.db.patch(f.otherAdmin._id, { active: false })
    })
    await step()
    // the group is not read again, the organization after it is marked, and
    // the marking ends
    expect(await marked()).toBe(0)
    expect(await dueAt(t, lastOrg)).toBe(NOW)
    expect((await removal())?.guest_marking).toBeUndefined()
  })

  it('polls a subscription that is past due, unpaid or incomplete, often in its first day', async () => {
    const { t, f } = await fixture()
    for (const status of ['past_due', 'unpaid']) {
      await t.mutation(apply, { payload: remote(f.org.id, { status, modified_at: iso(1) }) })
      vi.setSystemTime(Date.parse(iso(1)))
      expect(await settle(t, f.org.id, { seats: 5 })).toBe(iso(1 + minutesAfter(PAYMENT_POLL_MS)))
      // unpaid has no end of its own, so after the first day every half hour
      const later = Date.parse(iso(1)) + PAYMENT_POLL_WINDOW_MS
      vi.setSystemTime(later)
      expect(await settle(t, f.org.id, { seats: 5 })).toBe(
        new Date(later + DUNNING_POLL_MS - SWEEP_INTERVAL_MS).toISOString(),
      )
      vi.setSystemTime(NOW)
    }
    // Polar reports an incomplete payment, stored as pending, and ends it
    // within about a day, after which the safety pass reads it.
    await t.mutation(apply, {
      payload: remote(f.org.id, { status: 'incomplete', modified_at: iso(2) }),
    })
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'pending' })
    vi.setSystemTime(Date.parse(iso(2)))
    expect(await settle(t, f.org.id)).toBe(iso(2 + minutesAfter(PAYMENT_POLL_MS)))
    const later = Date.parse(iso(2)) + PAYMENT_POLL_WINDOW_MS
    vi.setSystemTime(later)
    expect(await settle(t, f.org.id)).toBe(
      new Date(later + SYNC_SAFETY_MS - SWEEP_INTERVAL_MS).toISOString(),
    )
  })

  it('follows a renewal that Polar moved', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    const end = Date.parse(END)
    vi.setSystemTime(end - PRE_RENEWAL_MS)
    // the check before the old end reads the end Polar moved two days later
    const moved = new Date(end + 2 * 24 * 60 * 60_000).toISOString()
    await t.mutation(apply, {
      payload: remote(f.org.id, { current_period_end: moved, modified_at: iso(60) }),
    })
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(end - PRE_RENEWAL_MS + SYNC_SAFETY_MS - SWEEP_INTERVAL_MS).toISOString(),
    )
    vi.setSystemTime(Date.parse(moved) - 60 * 60_000)
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(Date.parse(moved) - PRE_RENEWAL_MS).toISOString(),
    )
  })

  it('marks a membership change and a webhook due, so a reconciliation that never runs still happens', async () => {
    const { t, f } = await fixture()
    await setDue(t, f.org.id, iso(SYNC_SAFETY_MS / 60_000))
    await t.run((ctx) => markBillingMembershipChanged(ctx, f.org.id))
    expect(await stored(t, f.org.id)).toMatchObject({ sync_due_at: NOW })
    // the scheduled reconciliation dies before it claims; the sweep runs it
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect())
        await ctx.scheduler.cancel(job._id)
    })
    await t.mutation(sweep, {})
    expect((await queued(t, 'billingSync:reconcile')).map((job) => job.args[0].org_id)).toEqual([
      f.org.id,
    ])

    await setDue(t, f.org.id, iso(SYNC_SAFETY_MS / 60_000))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(remote(f.org.id))),
    )
    await t.mutation(receiveWebhook, { event_id: 'renewal-1', subscription_id: providerId })
    await t.action(processWebhook, { event_id: 'renewal-1' })
    expect(await stored(t, f.org.id)).toMatchObject({ sync_due_at: NOW })
  })

  it('keeps the safety pass on time while unpaid organizations fill every page', async () => {
    const { t } = await fixture()
    // 120 organizations in their first unpaid day are polled every
    // PAYMENT_POLL_MS: 60 due each minute, a full page, which before left
    // the safety pass nothing at all
    const unpaid = Array.from({ length: 120 }, () => uuid())
    const safety = Array.from({ length: 40 }, () => uuid())
    await t.run(async (ctx) => {
      for (const id of [...unpaid, ...safety]) await enrollOrganization(ctx, id)
    })
    for (const id of unpaid) await setDue(t, id, iso(-1))
    for (const id of safety) await setDue(t, id, iso(-5), true)
    const started = async () =>
      new Set((await queued(t, 'billingSync:reconcile')).map((job) => job.args[0].org_id))
    await t.mutation(sweep, {})
    const first = await started()
    expect(first.size).toBe(SYNC_PAGE.size)
    expect(safety.filter((id) => first.has(id))).toHaveLength(SYNC_PAGE.safety)
    expect(unpaid.filter((id) => first.has(id))).toHaveLength(SYNC_PAGE.size - SYNC_PAGE.safety)
    // the next minute starts the other 10, a minute late at most
    vi.setSystemTime(Date.parse(NOW) + 60_000)
    await t.mutation(sweep, {})
    const second = await started()
    expect(safety.filter((id) => second.has(id))).toHaveLength(40)
    expect(second.size).toBe(2 * SYNC_PAGE.size)
  })

  /* Runs the sweep at `at` and every reminders and remindAdmins step it
   * queues, and answers the errors of the steps that failed. */
  const remindAt = async (t: T, at: string) => {
    vi.setSystemTime(Date.parse(at))
    await t.mutation(sweep, {})
    const failed: string[] = []
    for (;;) {
      const [job] = [
        ...(await queued(t, 'billingSync:reminders')),
        ...(await queued(t, 'billingSync:remindAdmins')),
      ]
      if (!job) return failed
      await t.run((ctx) => ctx.scheduler.cancel(job._id))
      const step = makeFunctionReference<'mutation', Record<string, unknown>, null>(job.name)
      await t.mutation(step, job.args[0]).catch((error: Error) => failed.push(error.message))
    }
  }

  it('reminds the admins of free periods at each reminder time, a page at a time', async () => {
    const { t, f } = await fixture()
    REMINDER_PAGE.size = 1
    await grantUntil(t, f.org.id, iso(7 * 24 * 60 - 30))
    // ended half an hour ago, and its members' pages have not refreshed since
    await grantUntil(t, f.otherOrg.id, iso(-30), iso(-60))
    // between its reminder times; the old code reminded it every minute
    const quiet = uuid()
    await grantUntil(t, quiet, iso(3 * 24 * 60))
    await t.mutation(sweep, {})
    // the reminders run apart from the sweep, so their failure cannot undo
    // the reconciliations the sweep started
    expect(await notices(t)).toEqual([])
    expect((await queued(t, 'billingSync:reconcile')).length).toBeGreaterThan(0)
    const [job] = await queued(t, 'billingSync:reminders')
    expect(job.args[0]).toEqual({ now: Date.parse(NOW), lane: 'due', cursor: null })
    await remindAt(t, NOW)
    expect(await notices(t)).toEqual([
      [f.admin.id, 'seven_days'],
      [f.otherAdmin.id, 'expired'],
    ])
    // the end touches the row once, so members' pages read the expiry
    expect((await stored(t, f.otherOrg.id))?.updated_at).toBe(NOW)
    expect((await stored(t, f.otherOrg.id))?.remind_at).toBeNull()
    expect((await stored(t, f.org.id))?.remind_at).toBe(iso(6 * 24 * 60 - 30))
    expect((await stored(t, quiet))?.remind_at).toBe(iso(2 * 24 * 60))
    // nothing more is due, and nothing goes out twice
    await remindAt(t, iso(1))
    expect(await notices(t)).toHaveLength(2)
  })

  it.each([
    ['two hours', iso(6 * 24 * 60 - 60), iso(6 * 24 * 60 + 60), ['one_day']],
    ['two days', iso(-60), iso(2 * 24 * 60 - 60), ['seven_days']],
    // only the latest reminder that came due goes out
    ['two days, past the end', iso(6 * 24 * 60 - 60), iso(8 * 24 * 60 - 60), ['expired']],
  ])('sends a reminder late after a sweep outage of %s, and once', async (_, stop, back, kinds) => {
    const { t, f } = await fixture()
    await grantUntil(t, f.org.id, iso(7 * 24 * 60))
    await remindAt(t, stop)
    const before = (await notices(t)).length
    await remindAt(t, back)
    expect((await notices(t)).slice(before)).toEqual(kinds.map((kind) => [f.admin.id, kind]))
    await remindAt(t, new Date(Date.parse(back) + 60_000).toISOString())
    expect(await notices(t)).toHaveLength(before + kinds.length)
  })

  it('fills in the next reminder of a free period granted before reminder times were stored, a page at a time', async () => {
    const { t, f } = await fixture()
    REMINDER_PAGE.size = 1
    // an end that came half an hour ago still sends, as the release before did
    await grantUntil(t, f.org.id, iso(-30))
    await grantUntil(t, f.otherOrg.id, iso(3 * 24 * 60))
    const paid = uuid()
    await t.run((ctx) => enrollOrganization(ctx, paid))
    await t.run(async (ctx) => {
      for (const sub of await ctx.db.query('billing_subscriptions').collect())
        await ctx.db.patch(sub._id, { remind_at: undefined })
    })
    await remindAt(t, NOW)
    expect((await stored(t, f.org.id))?.remind_at).toBe(iso(-30))
    expect((await stored(t, f.otherOrg.id))?.remind_at).toBe(iso(2 * 24 * 60))
    expect((await stored(t, paid))?.remind_at).toBeNull()
    await remindAt(t, iso(1))
    expect(await notices(t)).toEqual([[f.admin.id, 'expired']])
  })

  it('sends the other reminders when the notices of one organization fail', async () => {
    // 21 more admins, whose notices pass the 20 calls one transaction may
    // schedule here, as 1,001 pass Convex's 1,000; before, the page that
    // held them failed every minute
    const { t, f } = await fixture({ transactionLimits: { functionsScheduled: 20 } })
    await t.run(async (ctx) => {
      for (let i = 0; i < 21; i += 1)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.otherOrg.id,
          email: `admin-${i}@testbed.test`,
          name: `Admin ${i}`,
          initials: 'AD',
          color: '#7a7ad0',
          org_role: 'admin',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    await grantUntil(t, f.otherOrg.id, iso(7 * 24 * 60 - 30))
    await grantUntil(t, f.org.id, iso(7 * 24 * 60 - 30))
    // a row written before reminder times were stored
    const legacy = uuid()
    await grantUntil(t, legacy, iso(3 * 24 * 60))
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', legacy))
        .unique()
      await ctx.db.patch(sub!._id, { remind_at: undefined })
    })
    const failed = await remindAt(t, NOW)
    expect(failed).toEqual([expect.stringMatching(/Scheduled too many functions/)])
    // the failing organization loses only this reminder
    expect(await notices(t)).toEqual([[f.admin.id, 'seven_days']])
    expect((await stored(t, f.otherOrg.id))?.remind_at).toBe(iso(6 * 24 * 60 - 30))
    expect((await stored(t, legacy))?.remind_at).toBe(iso(2 * 24 * 60))
  })

  it('stores the next reminder when an operator grants or extends a free period', async () => {
    const { t, f, operator } = await fixture()
    const week = 7 * 24 * 60 * 60_000
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    const first = addCalendarMonths(NOW, 1)
    expect((await stored(t, f.org.id))?.remind_at).toBe(
      new Date(Date.parse(first) - week).toISOString(),
    )
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    const extended = addCalendarMonths(first, 1)
    const reminder = new Date(Date.parse(extended) - week).toISOString()
    expect((await stored(t, f.org.id))?.remind_at).toBe(reminder)
    // the first period's reminder time passes without a reminder
    await remindAt(t, new Date(Date.parse(first) - week).toISOString())
    expect(await notices(t)).toEqual([])
    await remindAt(t, reminder)
    expect(await notices(t)).toEqual([[f.admin.id, 'seven_days']])
  })

  it('sends no reminder once Polar bills an organization during its free period', async () => {
    const { t, f, operator } = await fixture()
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    await t.mutation(apply, { payload: remote(f.org.id) })
    expect((await stored(t, f.org.id))?.remind_at).toBeNull()
    const until = Date.parse(addCalendarMonths(NOW, 1))
    for (const at of [until - 7 * 24 * 60 * 60_000, until - 24 * 60 * 60_000, until])
      await remindAt(t, new Date(at).toISOString())
    expect(await notices(t)).toEqual([])
  })

  it('leaves a free period extended without moving its reminder time to that time', async () => {
    const { t, f } = await fixture()
    await grantUntil(t, f.org.id, iso(10 * 24 * 60))
    // remind_at still holds an earlier end's reminder, which has come
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { remind_at: iso(-1) })
    })
    await remindAt(t, NOW)
    expect(await notices(t)).toEqual([])
    expect((await stored(t, f.org.id))?.remind_at).toBe(iso(3 * 24 * 60))
  })

  it('stops a reminders step that an earlier release queued', async () => {
    const { t, f } = await fixture()
    await grantUntil(t, f.org.id, iso(-30))
    await t.mutation(reminders, { now: Date.parse(NOW), threshold: 0, cursor: null })
    expect(await notices(t)).toEqual([])
  })
})

describe('Polar webhook deliveries', () => {
  // a Standard Webhooks secret of 32 bytes, as Polar issues one
  const SECRET = `whsec_${btoa('qivo-hermetic-webhook-key-000032')}`
  const site = (t: T) =>
    t as unknown as { fetch(path: string, init: RequestInit): Promise<Response> }
  /* Delivers Polar's subscription event `id`, signed as Polar signs it
   * unless `signature` replaces it, and answers the route's answer. */
  async function deliver(t: T, id: string, signature?: string) {
    const body = JSON.stringify({ type: 'subscription.updated', data: { id: providerId } })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(SECRET.slice(6)), (c) => c.charCodeAt(0)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
    )
    return await site(t).fetch('/billing/polar/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature ?? btoa(String.fromCharCode(...mac))}`,
      },
      body,
    })
  }
  const receipts = (t: T) => t.run((ctx) => ctx.db.query('billing_webhooks').collect())
  /* The deliveries whose processing attempt waits in the scheduler. */
  const attemptsFor = async (t: T) =>
    (await queued(t, 'billingSync:processWebhook')).map((job) => job.args[0].event_id)
  const attemptsQueued = async (t: T) => (await attemptsFor(t)).length
  const failedRows = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter(
        (row) => row.action === 'billing.webhook_failed',
      ),
    )
  const failures = async (t: T) => (await failedRows(t)).map((row) => row.detail)
  /* A Polar API that answers nothing until the request gives up. */
  const stalled = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The request was aborted', 'AbortError')),
      ),
    )
  /* Starts the attempt the sweep finds due at the receipt's next time, and
   * runs it. */
  async function nextAttempt(t: T) {
    const [receipt] = await receipts(t)
    vi.setSystemTime(Date.parse(receipt.next_attempt_at as string))
    await t.mutation(sweep, {})
    await sample(t)
  }

  beforeEach(() => {
    vi.stubEnv('POLAR_WEBHOOK_SECRET', SECRET)
    vi.stubEnv('SITE_URL', 'http://localhost:5199')
    vi.stubEnv('BETTER_AUTH_SECRET', 'billing-webhook-hermetic-secret')
  })

  it('answers at once while Polar does not answer, and applies the delivery once it does', async () => {
    const { t, f } = await fixture()
    const polar = vi.fn(stalled)
    vi.stubGlobal('fetch', polar)
    expect((await deliver(t, 'evt_slow')).status).toBe(202)
    // the answer did not wait for Polar
    expect(polar).not.toHaveBeenCalled()
    expect(await receipts(t)).toMatchObject([
      { event_id: 'evt_slow', subscription_id: providerId, pending: true, attempts: 0 },
    ])
    expect(await attemptsQueued(t)).toBe(1)
    // the scheduled attempt gives Polar the adapter's 15 seconds
    await sample(t)
    expect(polar).toHaveBeenCalledOnce()
    const [failed] = await receipts(t)
    expect(failed).toMatchObject({ pending: true, attempts: 1 })
    expect(Date.parse(failed.next_attempt_at as string) - Date.now()).toBe(30_000)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(remote(f.org.id))),
    )
    await nextAttempt(t)
    const [done] = await receipts(t)
    expect(done).toMatchObject({ attempts: 2, processed_at: expect.any(String) })
    expect(done.pending).toBeUndefined()
    expect(await stored(t, f.org.id)).toMatchObject({
      status: 'active',
      polar_subscription_id: providerId,
    })
  })

  it('tries a failing Polar again with growing waits, then gives the delivery up', async () => {
    const { t, f } = await fixture()
    const polar = vi.fn(async (_url: string) => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', polar)
    expect((await deliver(t, 'evt_down')).status).toBe(202)
    await sample(t)
    const waits: number[] = []
    for (let attempt = 1; attempt < WEBHOOK_ATTEMPTS; attempt += 1) {
      const [receipt] = await receipts(t)
      expect(receipt).toMatchObject({ pending: true, attempts: attempt })
      waits.push((Date.parse(receipt.next_attempt_at as string) - Date.now()) / 1000)
      await nextAttempt(t)
    }
    expect(waits).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600])
    // one read of the subscription an attempt; the sweep's reconciliations
    // list the organization's subscriptions instead
    const reads = polar.mock.calls.filter(([url]) =>
      String(url).endsWith(`/subscriptions/${providerId}`),
    )
    expect(reads).toHaveLength(WEBHOOK_ATTEMPTS)
    const [given] = await receipts(t)
    expect(given).toMatchObject({ attempts: WEBHOOK_ATTEMPTS, failed_at: expect.any(String) })
    expect(given.pending).toBeUndefined()
    expect(await failures(t)).toEqual([
      {
        event_id: 'evt_down',
        subscription_id: providerId,
        attempts: WEBHOOK_ATTEMPTS,
        error: 'polar unavailable 503',
      },
    ])
    // the sweep starts nothing more, and the subscription waits for the
    // reconciliation
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000)
    await t.mutation(sweep, {})
    expect(await attemptsQueued(t)).toBe(0)
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'pending' })
  })

  it('gives a delivery up at once when applying refuses it, and reconciles its organization', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await setDue(t, f.org.id, iso(60))
    // Polar now reports fewer seats than the plan's minimum, which every
    // attempt would refuse again
    const polar = vi.fn(
      async () => new Response(remote(f.org.id, { seats: 3, modified_at: iso(1) })),
    )
    vi.stubGlobal('fetch', polar)
    expect((await deliver(t, 'evt_refused')).status).toBe(202)
    await t.action(processWebhook, { event_id: 'evt_refused' })
    expect(polar).toHaveBeenCalledOnce()
    const [given] = await receipts(t)
    expect(given).toMatchObject({ attempts: 1, failed_at: expect.any(String) })
    expect(given.pending).toBeUndefined()
    expect(await failedRows(t)).toMatchObject([
      {
        target_org_id: f.org.id,
        detail: {
          event_id: 'evt_refused',
          subscription_id: providerId,
          attempts: 1,
          error: 'Subscription quantity is invalid.',
        },
      },
    ])
    // the organization keeps its state, and its reconciliation is asked for
    expect(await stored(t, f.org.id)).toMatchObject({ billed_seats: 5, sync_due_at: NOW })
    expect((await queued(t, 'billingSync:reconcile')).map((job) => job.args[0])).toEqual([
      { org_id: f.org.id },
    ])
  })

  it('gives up a delivery whose attempts all started without ending', async () => {
    const { t } = await fixture()
    vi.stubGlobal('fetch', vi.fn(stalled))
    expect((await deliver(t, 'evt_lost')).status).toBe(202)
    // every attempt so far died before it could record its end
    await t.run(async (ctx) => {
      const [receipt] = await ctx.db.query('billing_webhooks').collect()
      await ctx.db.patch(receipt._id, {
        attempts: WEBHOOK_ATTEMPTS,
        next_attempt_at: new Date(Date.now() - 1).toISOString(),
      })
    })
    await t.action(processWebhook, { event_id: 'evt_lost' })
    expect((await receipts(t))[0].pending).toBeUndefined()
    expect(await failures(t)).toMatchObject([{ error: 'the last attempt did not finish' }])
  })

  it('ignores a failure from an attempt that outlived its lease once the next one started', async () => {
    const { t, f } = await fixture()
    vi.stubGlobal('fetch', vi.fn(stalled))
    expect((await deliver(t, 'evt_late')).status).toBe(202)
    // the second to last attempt starts, and its lease passes while it waits
    await t.run(async (ctx) => {
      const [receipt] = await ctx.db.query('billing_webhooks').collect()
      await ctx.db.patch(receipt._id, {
        attempts: WEBHOOK_ATTEMPTS - 2,
        next_attempt_at: new Date(Date.now() - 1).toISOString(),
      })
    })
    const late = await t.mutation(claimWebhook, { event_id: 'evt_late' })
    expect(late).not.toBeNull()
    vi.setSystemTime(Date.now() + WEBHOOK_LEASE_MS)
    const last = await t.mutation(claimWebhook, { event_id: 'evt_late' })
    expect(last).toEqual({ subscription_id: providerId, claim: expect.any(String) })
    expect(last?.claim).not.toBe(late?.claim)
    const held = await receipts(t)
    expect(held).toMatchObject([{ pending: true, attempts: WEBHOOK_ATTEMPTS }])
    await t.mutation(webhookFailed, {
      event_id: 'evt_late',
      claim: late?.claim ?? '',
      error: 'polar unavailable',
    })
    expect(await receipts(t)).toEqual(held)
    expect(await failures(t)).toEqual([])
    // so the last attempt still applies what it read
    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'evt_late' })
    expect(await receipts(t)).toMatchObject([{ processed_at: expect.any(String) }])
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'active' })
  })

  it('starts no second attempt while one holds the delivery', async () => {
    const { t } = await fixture()
    const polar = vi.fn(stalled)
    vi.stubGlobal('fetch', polar)
    expect((await deliver(t, 'evt_held')).status).toBe(202)
    expect(await t.mutation(claimWebhook, { event_id: 'evt_held' })).not.toBeNull()
    vi.setSystemTime(Date.now() + WEBHOOK_LEASE_MS - 1)
    await t.action(processWebhook, { event_id: 'evt_held' })
    expect(polar).not.toHaveBeenCalled()
    expect(await receipts(t)).toMatchObject([{ pending: true, attempts: 1 }])
  })

  it('uses no attempt while billing is off or Polar is not configured', async () => {
    const { t, f } = await fixture()
    const polar = vi.fn(async () => new Response(remote(f.org.id)))
    vi.stubGlobal('fetch', polar)
    expect((await deliver(t, 'evt_off')).status).toBe(202)
    vi.stubEnv('BILLING_ENABLED', 'false')
    await t.action(processWebhook, { event_id: 'evt_off' })
    vi.stubEnv('BILLING_ENABLED', 'true')
    vi.stubEnv('POLAR_ACCESS_TOKEN', '')
    await t.action(processWebhook, { event_id: 'evt_off' })
    expect(polar).not.toHaveBeenCalled()
    expect(await receipts(t)).toMatchObject([{ pending: true, attempts: 0 }])
    // once both are back, it gets all its attempts
    vi.stubEnv('POLAR_ACCESS_TOKEN', 'polar_oat_hermetic_billing_tests')
    await t.action(processWebhook, { event_id: 'evt_off' })
    expect(await receipts(t)).toMatchObject([{ attempts: 1, processed_at: expect.any(String) }])
  })

  it('stores a repeated delivery once and reads Polar for it once', async () => {
    const { t, f } = await fixture()
    const polar = vi.fn(async () => new Response(remote(f.org.id)))
    vi.stubGlobal('fetch', polar)
    // Polar sends an event again when it did not get the answer
    expect((await deliver(t, 'evt_twice')).status).toBe(202)
    expect((await deliver(t, 'evt_twice')).status).toBe(202)
    expect(await receipts(t)).toHaveLength(1)
    expect(await attemptsQueued(t)).toBe(1)
    await t.action(processWebhook, { event_id: 'evt_twice' })
    expect(polar).toHaveBeenCalledOnce()
    // and again after it was processed
    expect((await deliver(t, 'evt_twice')).status).toBe(202)
    await t.action(processWebhook, { event_id: 'evt_twice' })
    expect(polar).toHaveBeenCalledOnce()
    expect(await receipts(t)).toMatchObject([{ attempts: 1, processed_at: expect.any(String) }])
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'active' })
  })

  it('starts a delivery given up again when Polar sends it again', async () => {
    const { t, f } = await fixture()
    // as an operator redelivers it from Polar's dashboard, with its event id
    await t.run((ctx) =>
      ctx.db.insert('billing_webhooks', {
        event_id: 'evt_again',
        subscription_id: providerId,
        received_at: iso(-60),
        attempts: 1,
        failed_at: iso(-60),
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(remote(f.org.id))),
    )
    expect((await deliver(t, 'evt_again')).status).toBe(202)
    const [again] = await receipts(t)
    expect(again).toMatchObject({ pending: true, attempts: 0, received_at: NOW })
    expect(again.failed_at).toBeUndefined()
    expect(await attemptsFor(t)).toEqual(['evt_again'])
    await t.action(processWebhook, { event_id: 'evt_again' })
    expect(await receipts(t)).toMatchObject([{ attempts: 1, processed_at: expect.any(String) }])
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'active' })
  })

  it('ignores a refusal from an attempt from before a redelivery started the delivery again', async () => {
    const { t, f } = await fixture()
    vi.stubGlobal('fetch', vi.fn(stalled))
    const refusal = { error: 'Subscription has no assigned organization plan.', refused: true }
    expect((await deliver(t, 'evt_restarted')).status).toBe(202)
    // the first attempt outlives its lease, and the second is refused
    const first = await t.mutation(claimWebhook, { event_id: 'evt_restarted' })
    vi.setSystemTime(Date.now() + WEBHOOK_LEASE_MS)
    const second = await t.mutation(claimWebhook, { event_id: 'evt_restarted' })
    await t.mutation(webhookFailed, {
      event_id: 'evt_restarted',
      claim: second?.claim ?? '',
      ...refusal,
    })
    expect(await receipts(t)).toMatchObject([{ failed_at: expect.any(String) }])
    // the cause is fixed and the event redelivered, which starts it again
    expect((await deliver(t, 'evt_restarted')).status).toBe(202)
    expect(await t.mutation(claimWebhook, { event_id: 'evt_restarted' })).not.toBeNull()
    const restarted = await receipts(t)
    expect(restarted).toMatchObject([{ pending: true, attempts: 1 }])
    // the first attempt's refusal comes in late
    await t.mutation(webhookFailed, {
      event_id: 'evt_restarted',
      claim: first?.claim ?? '',
      ...refusal,
    })
    expect(await receipts(t)).toEqual(restarted)
    expect(await failedRows(t)).toHaveLength(1)
    // so the restarted attempt applies what it reads
    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'evt_restarted' })
    expect(await receipts(t)).toMatchObject([{ processed_at: expect.any(String) }])
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'active' })
  })

  it('answers 503 when the delivery cannot be stored, for Polar to send it again', async () => {
    const { t } = await fixture()
    vi.stubGlobal('fetch', vi.fn(stalled))
    // two receipts of one event make reading its receipt throw
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i += 1)
        await ctx.db.insert('billing_webhooks', {
          event_id: 'evt_unstored',
          subscription_id: providerId,
          received_at: NOW,
          processed_at: NOW,
        })
    })
    expect((await deliver(t, 'evt_unstored')).status).toBe(503)
    expect(await attemptsQueued(t)).toBe(0)
  })

  it('refuses a delivery whose signature does not match, and stores nothing', async () => {
    const { t } = await fixture()
    vi.stubGlobal('fetch', vi.fn(stalled))
    const forged = btoa(String.fromCharCode(...new Uint8Array(32)))
    expect((await deliver(t, 'evt_forged', forged)).status).toBe(400)
    expect(await receipts(t)).toEqual([])
    expect(await attemptsQueued(t)).toBe(0)
  })

  it('deletes receipts past their retention as new ones arrive', async () => {
    const { t } = await fixture()
    vi.stubGlobal('fetch', vi.fn(stalled))
    const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
    await t.run(async (ctx) => {
      for (const [event_id, days] of [
        ['evt_old_1', 40],
        ['evt_old_2', 31],
        ['evt_old_3', 30.5],
        ['evt_kept', 29],
      ] as const)
        await ctx.db.insert('billing_webhooks', {
          event_id,
          subscription_id: providerId,
          received_at: at(days),
          processed_at: at(days),
        })
    })
    expect((await deliver(t, 'evt_new')).status).toBe(202)
    // two at a time, the oldest first
    expect((await receipts(t)).map((row) => row.event_id).sort()).toEqual(
      ['evt_kept', 'evt_new', 'evt_old_3'].sort(),
    )
  })

  it('starts at most WEBHOOK_PAGE due deliveries a minute, those due longest first', async () => {
    const { t } = await fixture()
    const late = `evt_due_${WEBHOOK_PAGE.size}`
    await t.run(async (ctx) => {
      for (let i = 0; i <= WEBHOOK_PAGE.size; i += 1)
        await ctx.db.insert('billing_webhooks', {
          event_id: `evt_due_${i}`,
          subscription_id: providerId,
          received_at: NOW,
          pending: true,
          attempts: 1,
          next_attempt_at: new Date(Date.now() - (WEBHOOK_PAGE.size + 1 - i) * 1000).toISOString(),
        })
    })
    await t.mutation(sweep, {})
    const started = await attemptsFor(t)
    expect(started).toHaveLength(WEBHOOK_PAGE.size)
    expect(started).not.toContain(late)
  })
})

/* Storage charged on a period's average of its daily samples
 * (billingSync.ts finalizeStorage), with DAILY_STORAGE_BILLING true unless a
 * case says otherwise. Samples come only from the job, a tick and the calls
 * it schedules, with the clock moved; a day goes missing by a skipped
 * tick, a recount over its run or a run that has not reached the
 * organization yet. Most cases use a period of three days, since the rules
 * do not depend on its length, and one goes through a whole month. */
describe('storage charged on the daily average', () => {
  const DEFAULT_FINALIZE_PAGE = { ...STORAGE_FINALIZE_PAGE }
  const DEFAULT_SAMPLE_PAGE = { ...SAMPLE_PAGE }
  beforeEach(() => {
    vi.stubEnv('DAILY_STORAGE_BILLING', 'true')
  })
  afterEach(() => {
    Object.assign(STORAGE_FINALIZE_PAGE, DEFAULT_FINALIZE_PAGE)
    Object.assign(SAMPLE_PAGE, DEFAULT_SAMPLE_PAGE)
  })

  /* A period of three days, 28 to 30 September, ending at noon. */
  const S = '2026-09-28T12:00:00.000Z'
  const E = '2026-10-01T12:00:00.000Z'
  const GB = 1_000_000_000
  const finalizeRef = internal.billingSync.finalizeStorage
  const storageStepRef = makeFunctionReference<'mutation', Record<string, unknown>, null>(
    'billingSync:storageStep',
  )

  /* `time` (HH:MM) of UTC day `day`, epoch milliseconds, and as ISO. */
  const at = (day: string, time = '00:20') => Date.parse(`${day}T${time}:00.000Z`)
  const isoAt = (day: string, time = '00:20') => new Date(at(day, time)).toISOString()

  /* Moves the clock to `time` of `day` and runs the hourly tick of the
   * daily samples with every call it schedules. Those are the day's run
   * when the day has none yet, whose last step starts the finalize of the
   * periods whose last day it reached, and the finalize of the periods
   * within two hours of their end. */
  async function tickAt(t: T, day: string, time = '00:20') {
    vi.setSystemTime(at(day, time))
    await t.mutation(internal.storageSamples.tick, {})
    await sample(t)
  }

  /* Records organization `orgId`'s paid period from `start` to `end`
   * through apply, as a renewal does, with `extra` in Polar's answer. */
  async function record(t: T, orgId: string, start = S, end = E, extra = {}) {
    await t.mutation(apply, {
      payload: remote(orgId, {
        current_period_start: start,
        current_period_end: end,
        modified_at: new Date(Date.now()).toISOString(),
        ...extra,
      }),
    })
    const period = await t.run((ctx) =>
      ctx.db
        .query('billing_periods')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    )
    const recorded = period.find((p) => p.period_start === start)
    if (recorded === undefined) throw new Error('apply recorded no period')
    return recorded
  }

  /* The calls of `name` scheduled so far, in any state. */
  const scheduledOf = (t: T, name: string) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name === name,
      ),
    )
  /* The audit rows of `action`. */
  const auditsOf = (t: T, action: string) =>
    t.run(async (ctx) =>
      (await ctx.db.query('platform_audit_log').collect()).filter((row) => row.action === action),
    )
  /* Runs the next scheduled call only. */
  async function nextCall(t: T) {
    vi.advanceTimersToNextTimer()
    await t.finishInProgressScheduledFunctions()
  }

  /* Plants a counted organization, enrolled on `planId` or the default
   * plan, holding `bytes` in one file of one project. */
  async function payingOrg(t: T, bytes: number, planId?: string, id = uuid()) {
    await t.run(async (ctx) => {
      await ctx.db.insert('organizations', {
        id,
        name: `Paying ${id.slice(0, 8)}`,
        slug: `paying-${id.slice(0, 8)}`,
        ...newOrgDefaults(NOW),
      })
      await enrollOrganization(ctx, id, planId)
      await startOrgTotals(ctx, id)
      await addToProject(ctx, id, uuid(), 1, { bytes, files: 1 }, 'Files')
      const org = await orgTotalsRow(ctx, id)
      if (org === null) throw new Error('the organization is not counted')
      await addToOrg(ctx, org, { bytes, files: 1 })
    })
    return id
  }

  /* Removes plan `planId`, so a finalize of a period on it throws, and
   * answers a function that puts it back. */
  async function removePlan(t: T, planId: string) {
    const row = await t.run(async (ctx) => {
      const plan = await ctx.db
        .query('billing_plans')
        .withIndex('by_uuid', (q) => q.eq('id', planId))
        .unique()
      if (plan === null) throw new Error('no such plan')
      await ctx.db.delete(plan._id)
      const { _id, _creationTime, ...fields } = plan
      return fields
    })
    return () => t.run(async (ctx) => void (await ctx.db.insert('billing_plans', row)))
  }

  describe('the basis and the paths of the sample at the start', () => {
    it('records a period on the daily basis only while DAILY_STORAGE_BILLING is exactly true, and starts no sample for it', async () => {
      for (const value of ['TRUE', '1', 'false', ' true', '']) {
        vi.stubEnv('DAILY_STORAGE_BILLING', value)
        const { t, f } = await fixture()
        await t.mutation(apply, { payload: remote(f.org.id) })
        const period = await periodAt(t, START)
        expect(period).not.toHaveProperty('storage_basis')
        expect(period?.storage_run).toEqual(expect.any(String))
        expect(await queued(t, 'billingSync:storageStep')).toHaveLength(1)
      }
      vi.stubEnv('DAILY_STORAGE_BILLING', 'true')
      const { t, f } = await fixture()
      await t.mutation(apply, { payload: remote(f.org.id) })
      const period = await periodAt(t, START)
      expect(period).toMatchObject({ storage_basis: 'daily', seats: 5 })
      for (const field of [
        'storage_run',
        'storage_run_at',
        'storage_attempts',
        'storage_bytes',
        'storage_finalized_at',
      ])
        expect(period).not.toHaveProperty(field)
      expect(await queued(t, 'billingSync:storageStep')).toEqual([])
    })

    it('never samples a daily period at its start, whatever apply, restartStorage or a step queued for it does', async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 6 * GB)
      await t.mutation(apply, { payload: remote(f.org.id) })
      const recorded = await periodAt(t, START)
      if (recorded === null) throw new Error('no period')
      // apply again once a sample would count as stalled, and once a
      // stopped one would be retried
      for (const [n, ms] of [
        [1, STORAGE_STALL_MS + 1000],
        [2, STORAGE_RETRY_MS + 1000],
      ] as const) {
        vi.setSystemTime(Date.parse(NOW) + ms)
        await t.mutation(apply, { payload: remote(f.org.id, { modified_at: iso(n) }) })
      }
      await sample(t)
      expect(await periodAt(t, START)).toEqual(recorded)
      expect(await t.mutation(restartStorage, { period: recorded._id })).toBe(false)
      expect(await periodAt(t, START)).toEqual(recorded)
      expect(await auditsOf(t, 'billing.storage_sample_restarted')).toEqual([])
      // a step an earlier backend queued for it, after starting a sample of
      // it across a rollback
      await t.run((ctx) =>
        ctx.db.patch(recorded._id, { storage_run: 'earlier', storage_run_at: NOW }),
      )
      await t.mutation(storageStepRef, { period: recorded._id, run: 'earlier', bytes: 0 })
      expect(await periodAt(t, START)).not.toHaveProperty('storage_bytes')
      expect(await storageEvents(t)).toEqual([])
    })

    it('keeps each period on the basis it was recorded with when the switch changes', async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 6 * GB)
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      expect(await record(t, f.org.id)).toMatchObject({ storage_basis: 'daily' })
      // switched off with the daily period open, it stays daily and is
      // recorded by the run of its last day
      vi.stubEnv('DAILY_STORAGE_BILLING', 'false')
      vi.setSystemTime(Date.parse(S) + STORAGE_STALL_MS + 1000)
      expect(await record(t, f.org.id)).not.toHaveProperty('storage_run')
      await tickAt(t, '2026-09-29')
      await tickAt(t, '2026-09-30')
      expect(await periodAt(t, S)).toMatchObject({
        storage_basis: 'daily',
        storage_bytes: 6 * GB,
        storage_blocks: 1,
        storage_finalized_at: isoAt('2026-09-30'),
      })
      // the renewal recorded while it is off is sampled at its start, and
      // stays so when it is switched on again
      vi.setSystemTime(Date.parse(E))
      const NEXT = '2026-11-01T12:00:00.000Z'
      expect(await record(t, f.org.id, E, NEXT)).not.toHaveProperty('storage_basis')
      vi.stubEnv('DAILY_STORAGE_BILLING', 'true')
      vi.setSystemTime(Date.parse(E) + 1000)
      await record(t, f.org.id, E, NEXT)
      await sample(t)
      const next = await periodAt(t, E)
      expect(next).toMatchObject({ storage_bytes: 6 * GB, storage_blocks: 1 })
      expect(next).not.toHaveProperty('storage_basis')
      expect((await storageEvents(t)).map((e) => e.period_start)).toEqual([S, E])
    })
  })

  describe('the finalize', () => {
    it("averages a whole month's days as the job sampled them and records its charge once, a day or more before the end", async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 4 * GB)
      const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
      for (const [i, day] of days.entries()) {
        // 4 GB for the first 15 days, 7 GB and a byte for the last 15
        if (i === 15) await storeBytes(t, f, 3 * GB + 1)
        await tickAt(t, day)
        if (i === 0) {
          vi.setSystemTime(Date.parse(START))
          await t.mutation(apply, { payload: remote(f.org.id) })
        }
        if (i === 14) {
          // half way, a finalize waits for the last day and writes nothing
          const open = await periodAt(t, START)
          if (open === null) throw new Error('no period')
          expect(await t.mutation(finalizeRef, { period: open._id })).toBe('waiting')
          expect(await periodAt(t, START)).toEqual(open)
        }
        // no run before the period's last day lists it
        if (i === 28) expect(await scheduledOf(t, 'billingSync:finalizeDue')).toEqual([])
      }
      const period = await periodAt(t, START)
      // (15 × 4 GB + 15 × (7 GB + 1)) / 30 = 5.5 GB and half a byte, rounded
      // up once, and a block for the 0.5 GB over the 5 GB included
      expect(period).toMatchObject({
        storage_basis: 'daily',
        storage_bytes: 5_500_000_001,
        storage_blocks: 1,
        storage_finalized_at: isoAt('2026-09-30'),
        storage_sampled_at: isoAt('2026-09-30'),
      })
      expect(period?.storage_days).toEqual(
        days.map((day, i) => ({ day, bytes: i < 15 ? 4 * GB : 7 * GB + 1 })),
      )
      const events = await storageEvents(t)
      expect(events).toMatchObject([
        { id: `${providerId}:${START}:storage`, units: 1, period_start: START },
      ])
      expect(Date.parse(END) - at('2026-09-30')).toBeGreaterThan(STORAGE_FINALIZE_LEAD_MS)
      expect(await t.mutation(eventReady, { id: events[0].id })).toBe(true)
    })

    it('records a period whose last day has no sample at the first tick within two hours of its end, from the last measured day', async () => {
      const { t, f } = await fixture()
      // it ends at 01:00, so its deadline falls on its last day
      const start = '2026-09-28T01:00:00.000Z'
      const end = '2026-10-01T01:00:00.000Z'
      await storeBytes(t, f, 6 * GB)
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(start))
      await record(t, f.org.id, start, end)
      await storeBytes(t, f, 2 * GB)
      await tickAt(t, '2026-09-29')
      // a recount over the last day's run, which skips the organization
      expect(await recountOf(t, f.org.id)()).toBeNull()
      await tickAt(t, '2026-09-30')
      const open = await periodAt(t, start)
      expect(open).not.toHaveProperty('storage_finalized_at')
      // that run's finalize waited, writing nothing
      expect(await scheduledOf(t, 'billingSync:finalizeStorage')).toHaveLength(1)
      // 2 hours and 1 minute before the end, the tick lists nothing
      await tickAt(t, '2026-09-30', '22:59')
      expect(await periodAt(t, start)).toEqual(open)
      expect(await scheduledOf(t, 'billingSync:finalizeDue')).toHaveLength(1)
      // 1 hour and 59 minutes before, it records the period, the last day
      // from the last measured one
      await tickAt(t, '2026-09-30', '23:01')
      const period = await periodAt(t, start)
      expect(period?.storage_days).toEqual([
        { day: '2026-09-28', bytes: 6 * GB },
        { day: '2026-09-29', bytes: 8 * GB },
        { day: '2026-09-30', bytes: 8 * GB, from: '2026-09-29' },
      ])
      // (6 + 8 + 8) / 3 GB rounded up to a byte, and 3 blocks over 5 GB
      expect(period).toMatchObject({
        storage_bytes: 7_333_333_334,
        storage_blocks: 3,
        storage_finalized_at: isoAt('2026-09-30', '23:01'),
      })
      const events = await storageEvents(t)
      expect(events).toMatchObject([{ units: 3 }])
      expect(await t.mutation(eventReady, { id: events[0].id })).toBe(true)
    })

    it("records a period whose last day has no sample from the next day's sample, at that day's run, before its deadline", async () => {
      const { t, f } = await fixture()
      await attachFile(t, f, 100)
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      await record(t, f.org.id)
      await attachFile(t, f, 20)
      await tickAt(t, '2026-09-29')
      const recount = recountOf(t, f.org.id)
      expect(await recount()).toBeNull()
      await tickAt(t, '2026-09-30')
      // the count ends, and a file is attached before the next day's run
      let counted = await recount()
      while (counted === null) counted = await recount()
      expect(counted).toEqual({ bytes: 120, files: 2 })
      await attachFile(t, f, 3)
      await tickAt(t, '2026-10-01')
      const period = await periodAt(t, S)
      expect(period?.storage_days).toEqual([
        { day: '2026-09-28', bytes: 100 },
        { day: '2026-09-29', bytes: 120 },
        { day: '2026-09-30', bytes: 123, from: '2026-10-01' },
      ])
      // (100 + 120 + 123) / 3 rounded up, at the run 11 hours 40 minutes
      // before the end
      expect(period).toMatchObject({
        storage_bytes: 115,
        storage_blocks: 0,
        storage_finalized_at: isoAt('2026-10-01'),
      })
    })

    it("waits while the last day's run can still sample it, and counts a reading that run takes after midnight for that day", async () => {
      SAMPLE_PAGE.orgs = 1
      const { t, f } = await fixture()
      // an organization each run samples before any of withOrg's
      await payingOrg(t, 10, undefined, '00000000-0000-4000-8000-000000000000')
      await storeBytes(t, f, 100)
      const start = '2026-09-29T12:00:00.000Z'
      await tickAt(t, '2026-09-29')
      vi.setSystemTime(Date.parse(start))
      await record(t, f.org.id, start, E)
      await storeBytes(t, f, 20)
      // the last day's run starts late, and its first step samples the
      // other organization only
      vi.setSystemTime(at('2026-09-30', '23:58'))
      await t.mutation(internal.storageSamples.tick, {})
      await nextCall(t)
      // after midnight, the next day's run reaches f.org first, its steps
      // taken here one by one
      vi.setSystemTime(at('2026-10-01', '00:05'))
      await storeBytes(t, f, 3)
      await t.mutation(internal.storageSamples.tick, {})
      const nextRun = () => t.run((ctx) => runOf(ctx, '2026-10-01'))
      const run = (await nextRun())?.run ?? ''
      while ((await nextRun())?.finished_at === undefined)
        await t.mutation(internal.storageSamples.step, { day: '2026-10-01', run })
      const open = await periodAt(t, start)
      if (open === null) throw new Error('no period')
      expect(await t.mutation(finalizeRef, { period: open._id })).toBe('waiting')
      expect(await periodAt(t, start)).toEqual(open)
      // the last day's run goes on, samples f.org for its own day, and the
      // period is recorded from that reading
      await sample(t)
      const period = await periodAt(t, start)
      expect(period?.storage_days).toEqual([
        { day: '2026-09-29', bytes: 100 },
        { day: '2026-09-30', bytes: 123 },
      ])
      expect(period).toMatchObject({ storage_bytes: 112, storage_blocks: 0 })
      const late = await t.run((ctx) =>
        ctx.db
          .query('storage_daily_samples')
          .withIndex('by_org_day', (q) => q.eq('org_id', f.org.id).eq('day', '2026-09-30'))
          .unique(),
      )
      expect(late?.at).toBe(at('2026-10-01', '00:05'))
    })

    it("records a period at its deadline from the next day's sample while the last day's run can still sample it", async () => {
      SAMPLE_PAGE.orgs = 1
      const { t, f } = await fixture()
      // an organization each run samples before any of withOrg's
      await payingOrg(t, 10, undefined, '00000000-0000-4000-8000-000000000000')
      await storeBytes(t, f, 100)
      // it ends at 01:00, so its deadline is 23:00 on its last day
      const start = '2026-09-29T01:00:00.000Z'
      const end = '2026-10-01T01:00:00.000Z'
      await tickAt(t, '2026-09-29')
      vi.setSystemTime(Date.parse(start))
      await record(t, f.org.id, start, end)
      await storeBytes(t, f, 20)
      // the last day's run starts late, and its first step samples the
      // other organization only. These ticks also start the finalize of
      // this period, so their scheduled calls wait and the steps are taken
      // here by hand.
      vi.setSystemTime(at('2026-09-30', '23:58'))
      await t.mutation(internal.storageSamples.tick, {})
      const lastRun = (await t.run((ctx) => runOf(ctx, '2026-09-30')))?.run ?? ''
      await t.mutation(internal.storageSamples.step, { day: '2026-09-30', run: lastRun })
      // after midnight, the next day's run samples f.org
      vi.setSystemTime(at('2026-10-01', '00:05'))
      await storeBytes(t, f, 3)
      await t.mutation(internal.storageSamples.tick, {})
      const nextRun = () => t.run((ctx) => runOf(ctx, '2026-10-01'))
      const run = (await nextRun())?.run ?? ''
      while ((await nextRun())?.finished_at === undefined)
        await t.mutation(internal.storageSamples.step, { day: '2026-10-01', run })
      // past the deadline, with the last day's run open and not stalled, so
      // before the deadline the finalize would wait for it
      vi.setSystemTime(at('2026-10-01', '00:06'))
      const lastDay = await t.run((ctx) => runOf(ctx, '2026-09-30'))
      expect(lastDay).not.toHaveProperty('finished_at')
      expect(Date.now() - (lastDay?.step_at ?? 0)).toBeLessThan(SAMPLE_STALLED_MS)
      const open = await periodAt(t, start)
      if (open === null) throw new Error('no period')
      expect(await t.mutation(finalizeRef, { period: open._id })).toBe('recorded')
      const period = await periodAt(t, start)
      // the last day from the next day's sample, never from the earlier one
      expect(period?.storage_days).toEqual([
        { day: '2026-09-29', bytes: 100 },
        { day: '2026-09-30', bytes: 123, from: '2026-10-01' },
      ])
      // (100 + 123) / 2 rounded up
      expect(period).toMatchObject({
        storage_bytes: 112,
        storage_blocks: 0,
        storage_finalized_at: isoAt('2026-10-01', '00:06'),
      })
      // the reading the last day's run then takes for its own day, and the
      // finalize calls the ticks started, revise nothing
      await sample(t)
      expect(await periodAt(t, start)).toEqual(period)
    })

    it('records a period without any sample of its organization as unavailable, with no storage charge and an audit row, never 0', async () => {
      const { t, f } = await fixture()
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // a recount that never ends, so no run samples the organization
      expect(await recountOf(t, f.org.id)()).toBeNull()
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      const open = await record(t, f.org.id)
      await tickAt(t, '2026-09-29')
      await tickAt(t, '2026-09-30')
      await tickAt(t, '2026-10-01')
      expect(await periodAt(t, S)).toEqual(open)
      await tickAt(t, '2026-10-01', '10:01')
      const period = await periodAt(t, S)
      expect(period).toMatchObject({
        storage_unavailable: true,
        storage_finalized_at: isoAt('2026-10-01', '10:01'),
      })
      expect(period?.storage_days).toEqual([
        { day: '2026-09-28' },
        { day: '2026-09-29' },
        { day: '2026-09-30' },
      ])
      for (const field of ['storage_bytes', 'storage_blocks', 'storage_sampled_at'])
        expect(period).not.toHaveProperty(field)
      expect(await storageEvents(t)).toEqual([])
      expect(await auditsOf(t, 'billing.storage_unavailable')).toMatchObject([
        {
          actor_email: 'system',
          target_org_id: f.org.id,
          detail: { period: open._id, subscription_id: providerId, period_start: S, days: 3 },
        },
      ])
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining('it is recorded with no storage charge'),
      )
    })

    it("fills every day of a period without a sample from an earlier period's, at the cutoff", async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 6 * GB)
      await tickAt(t, '2026-09-20')
      expect(await recountOf(t, f.org.id)()).toBeNull()
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      await record(t, f.org.id)
      await tickAt(t, '2026-09-29')
      await tickAt(t, '2026-09-30')
      await tickAt(t, '2026-10-01', '10:01')
      const period = await periodAt(t, S)
      expect(period?.storage_days).toEqual(
        ['2026-09-28', '2026-09-29', '2026-09-30'].map((day) => ({
          day,
          bytes: 6 * GB,
          from: '2026-09-20',
        })),
      )
      expect(period).toMatchObject({ storage_bytes: 6 * GB, storage_blocks: 1 })
      expect(period).not.toHaveProperty('storage_unavailable')
      expect(await storageEvents(t)).toMatchObject([{ units: 1 }])
    })

    it('records the average of a complimentary period without charging it', async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 6 * GB)
      await t.run(async (ctx) => {
        const sub = await ctx.db
          .query('billing_subscriptions')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique()
        await ctx.db.patch(sub!._id, { complimentary_until: E })
      })
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      await record(t, f.org.id)
      await tickAt(t, '2026-09-29')
      await tickAt(t, '2026-09-30')
      expect(await periodAt(t, S)).toMatchObject({ storage_bytes: 6 * GB, storage_blocks: 1 })
      expect(await storageEvents(t)).toEqual([])
    })

    it('records a period once, with one event, when the run of its last day and the deadline find it together and an operator runs it again', async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 6 * GB)
      const start = '2026-09-28T01:00:00.000Z'
      const end = '2026-10-01T01:00:00.000Z'
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(start))
      const open = await record(t, f.org.id, start, end)
      await tickAt(t, '2026-09-29')
      // the last day's run starts late, at a tick that also finds the
      // period within two hours of its end
      await tickAt(t, '2026-09-30', '23:20')
      expect(await scheduledOf(t, 'billingSync:finalizeDue')).toHaveLength(2)
      const period = await periodAt(t, start)
      expect(period).toMatchObject({ storage_bytes: 6 * GB, storage_blocks: 1 })
      expect(await storageEvents(t)).toHaveLength(1)
      expect(await t.mutation(finalizeRef, { period: open._id })).toBeNull()
      expect(await t.mutation(finalizeRef, { period: open._id })).toBeNull()
      expect(await periodAt(t, start)).toEqual(period)
      expect(await storageEvents(t)).toHaveLength(1)
    })

    it('finalizes every due period a page at a time, and one whose finalize throws fails alone and is tried again', async () => {
      STORAGE_FINALIZE_PAGE.periods = 2
      const { t, operatorId } = await fixture()
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const broken = await t.mutation(insertPlan, {
        plan: terms('Broken'),
        actor: operatorId,
        email: 'operator@testbed.test',
      })
      // five organizations, 6 to 10 GB, the third on a plan of its own
      const orgs: string[] = []
      for (let i = 0; i < 5; i++)
        orgs.push(await payingOrg(t, (6 + i) * GB, i === 2 ? broken : undefined))
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      const periods: Doc<'billing_periods'>[] = []
      for (const orgId of orgs) periods.push(await record(t, orgId, S, E, { id: uuid() }))
      await tickAt(t, '2026-09-29')
      const restore = await removePlan(t, broken)
      await tickAt(t, '2026-09-30')
      const rows = () => t.run(async (ctx) => Promise.all(periods.map((p) => ctx.db.get(p._id))))
      // three pages of 2, 2 and 1, and a finalize each, of which one threw
      expect(await scheduledOf(t, 'billingSync:finalizeDue')).toHaveLength(3)
      const finalizes = await scheduledOf(t, 'billingSync:finalizeStorage')
      expect(finalizes.map((job) => job.state.kind).sort()).toEqual([
        'failed',
        'success',
        'success',
        'success',
        'success',
      ])
      expect((await rows()).map((row) => row?.storage_blocks)).toEqual([1, 2, undefined, 4, 5])
      expect(errors).toHaveBeenCalled()
      // the next trigger tries it again once its plan is back
      await restore()
      await tickAt(t, '2026-10-01')
      expect((await rows()).map((row) => row?.storage_blocks)).toEqual([1, 2, 3, 4, 5])
      expect((await storageEvents(t)).map((e) => e.units).sort()).toEqual([1, 2, 3, 4, 5])
    })

    it('records a period found after its end, whose charge delivery then stops at the closed period', async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 6 * GB)
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      await record(t, f.org.id)
      // billing is off over the last days, so the job samples and nothing
      // finalizes
      vi.stubEnv('BILLING_ENABLED', 'false')
      await tickAt(t, '2026-09-29')
      await tickAt(t, '2026-09-30')
      expect(await periodAt(t, S)).not.toHaveProperty('storage_finalized_at')
      vi.stubEnv('BILLING_ENABLED', 'true')
      await tickAt(t, '2026-10-01', '13:00')
      expect(await periodAt(t, S)).toMatchObject({
        storage_bytes: 6 * GB,
        storage_blocks: 1,
        storage_finalized_at: isoAt('2026-10-01', '13:00'),
      })
      const [event] = await storageEvents(t)
      expect(await t.mutation(eventReady, { id: event.id })).toBe(false)
      expect((await storageEvents(t))[0]).toMatchObject({
        abandoned_at: isoAt('2026-10-01', '13:00'),
      })
      expect(await auditsOf(t, 'billing.usage_delivery_stopped')).toMatchObject([
        { detail: { event_id: event.id, kind: 'storage', outcome: 'not_sent' } },
      ])
    })

    it('drops an open daily period with its organization, and a finalize queued for it does nothing', async () => {
      const { t, f } = await fixture()
      await storeBytes(t, f, 6 * GB)
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      const open = await record(t, f.org.id)
      await t.run((ctx) =>
        ctx.db.insert('org_removals', {
          org_id: f.org.id,
          reason: 'requested',
          ended_at: S,
          delete_after: S,
          phase: 'profiles',
          created_at: S,
        }),
      )
      for (let done = false; !done; )
        done = await t.run(async (ctx) => {
          const removal = await ctx.db
            .query('org_removals')
            .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
            .unique()
          return removal === null || (await deleteOrgStep(ctx, removal))
        })
      expect(await t.run((ctx) => ctx.db.get(open._id))).toBeNull()
      expect(await t.mutation(finalizeRef, { period: open._id })).toBeNull()
      await tickAt(t, '2026-10-01', '10:01')
      expect(await scheduledOf(t, 'billingSync:finalizeDue')).toEqual([])
      expect(await storageEvents(t)).toEqual([])
    })

    it('stops trying a period still not recorded STORAGE_FINALIZE_RETRY_MS after its end, says so, and an operator can record it', async () => {
      const { t, f, planId } = await fixture()
      await storeBytes(t, f, 6 * GB)
      await tickAt(t, '2026-09-28')
      vi.setSystemTime(Date.parse(S))
      const open = await record(t, f.org.id)
      await tickAt(t, '2026-09-29')
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const restore = await removePlan(t, planId)
      await tickAt(t, '2026-09-30')
      // every run and tick tries it again up to the end of the window
      const edge = Date.parse(E) + STORAGE_FINALIZE_RETRY_MS
      vi.setSystemTime(edge - 60_000)
      await t.mutation(internal.storageSamples.tick, {})
      await sample(t)
      const tried = (await scheduledOf(t, 'billingSync:finalizeStorage')).length
      expect(tried).toBeGreaterThanOrEqual(3)
      expect(await periodAt(t, S)).toEqual(open)
      // past it, the next tick stops trying it, with an error and an audit row
      vi.setSystemTime(edge + 60_000)
      await t.mutation(internal.storageSamples.tick, {})
      await sample(t)
      expect(await scheduledOf(t, 'billingSync:finalizeStorage')).toHaveLength(tried)
      const stopped = await periodAt(t, S)
      expect(stopped).toMatchObject({ storage_failed_at: new Date(edge + 60_000).toISOString() })
      expect(stopped).not.toHaveProperty('storage_finalized_at')
      expect(await auditsOf(t, 'billing.storage_finalize_stopped')).toMatchObject([
        { detail: { period: open._id, period_start: S, period_end: E } },
      ])
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('it is no longer tried'))
      // no trigger lists it again, and it asks for no reconciliation of its own
      const listed = (await scheduledOf(t, 'billingSync:finalizeDue')).length
      vi.setSystemTime(edge + 61 * 60_000)
      await t.mutation(internal.storageSamples.tick, {})
      await sample(t)
      expect(await scheduledOf(t, 'billingSync:finalizeDue')).toHaveLength(listed)
      expect(await auditsOf(t, 'billing.storage_finalize_stopped')).toHaveLength(1)
      // once its plan is back, a reconciliation leaves the organization to
      // the safety pass, as a stopped sample at the start would not
      await restore()
      const work = await t.mutation(claim, { org_id: f.org.id })
      await t.mutation(release, { org_id: f.org.id, token: work!.token, seats: 5 })
      expect(await stored(t, f.org.id)).toMatchObject({ sync_safety: true })
      // and an operator records it
      expect(await t.mutation(finalizeRef, { period: open._id })).toBe('recorded')
      const period = await periodAt(t, S)
      expect(period).toMatchObject({ storage_bytes: 6 * GB, storage_blocks: 1 })
      expect(period).not.toHaveProperty('storage_failed_at')
    })

    it('reads the period, its days and a few documents more in its largest call, for an organization of 1,000 people', async () => {
      const { t, f } = await fixture()
      // 1,000 people with withOrg's, each billed
      const people = await t.run(
        async (ctx) =>
          (
            await ctx.db
              .query('profiles')
              .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
              .collect()
          ).length,
      )
      for (let from = people; from < 1000; from += 250)
        await t.run(async (ctx) => {
          for (let i = from; i < Math.min(1000, from + 250); i++)
            await ctx.db.insert('profiles', {
              id: uuid(),
              org_id: f.org.id,
              email: `member-${i}@testbed.test`,
              name: `Member ${i}`,
              initials: 'MB',
              color: '#7a7ad0',
              org_role: 'user',
              active: true,
              kind: 'person',
              created_at: NOW,
            })
        })
      // a period of 31 days, 1 to 31 August, with 1,500 GB stored
      const start = '2026-08-01T12:00:00.000Z'
      const end = '2026-09-01T12:00:00.000Z'
      await storeBytes(t, f, 1_500 * GB)
      await tickAt(t, '2026-08-01')
      vi.setSystemTime(Date.parse(start))
      const open = await record(t, f.org.id, start, end, { seats: 1000 })
      expect(open.profile_ids.length).toBeGreaterThanOrEqual(995)
      for (let d = 2; d <= 30; d++) await tickAt(t, `2026-08-${String(d).padStart(2, '0')}`)
      // the last day missing, under a recount that ends before the next
      // day's run, which then samples the organization while billing is off
      const recount = recountOf(t, f.org.id)
      expect(await recount()).toBeNull()
      await tickAt(t, '2026-08-31')
      let counted = await recount()
      while (counted === null) counted = await recount()
      vi.stubEnv('BILLING_ENABLED', 'false')
      await tickAt(t, '2026-09-01')
      vi.stubEnv('BILLING_ENABLED', 'true')
      // so the finalize before the deadline reads the period's 30 samples,
      // the next day's and the last day's run row, and writes the charge
      vi.setSystemTime(at('2026-09-01', '00:30'))
      const read = await t.run(async (ctx) => {
        const out = await (
          finalizeStorage as unknown as {
            _handler: (ctx: unknown, args: { period: Id<'billing_periods'> }) => Promise<unknown>
          }
        )._handler(ctx, { period: open._id })
        const m = await ctx.meta.getTransactionMetrics()
        return {
          out,
          ranges: m.databaseQueries.used,
          documents: m.documentsRead.used,
          bytes: m.bytesRead.used,
          written: m.documentsWritten.used,
          written_bytes: m.bytesWritten.used,
        }
      })
      console.log('daily finalize reads', JSON.stringify(read))
      expect(read.out).toBe('recorded')
      expect(await storageEvents(t)).toMatchObject([{ units: 452 }])
      // the period, 30 samples, the next one and the run row, then the
      // plan, the subscription and the charge's id, and the period again
      // for the next reconciliation
      expect(read.documents).toBeLessThanOrEqual(31 + 8)
      // the period and the charge, and at most the subscription's next
      // reconciliation
      expect(read.written).toBeLessThanOrEqual(3)
    })
  })
})
