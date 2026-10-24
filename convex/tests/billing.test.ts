import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import {
  CHECKOUT_POLL_GRACE_MS,
  DUNNING_POLL_MS,
  PAYMENT_POLL_MS,
  PAYMENT_POLL_WINDOW_MS,
  POST_RENEWAL_MS,
  PRE_RENEWAL_MS,
  REMINDER_PAGE,
  RENEWAL_POLL_MS,
  STORAGE_ATTEMPTS,
  STORAGE_RETRY_MS,
  STORAGE_STALL_MS,
  SYNC_PAGE,
  SYNC_SAFETY_MS,
} from '../billingSync'
import { markBillingMembershipChanged } from '../lib/billableUsers'
import { addCalendarMonths } from '../lib/billingAccess'
import type { BillingPlan, BillingSummary, BillingUsage } from '../lib/billingTypes'
import { LIMITS, PLAN_CURRENCIES, PLAN_CURRENCY } from '../lib/limits'
import { enrollOrganization, STORAGE_PAGE, storageUsage } from '../model/billing'
import { deleteOrgStep } from '../model/orgDeletion'
import {
  as,
  expectRefusal,
  newT,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

type PlanInput = Omit<BillingPlan, 'id' | 'archived' | 'created_at'>
const summary = makeFunctionReference<'query', { org_id: string }, BillingSummary>(
  'billing:summary',
)
const usageReport = makeFunctionReference<'action', { org_id: string }, BillingUsage>(
  'billing:usageReport',
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
const claim = makeFunctionReference<'mutation', { org_id: string }, { token: string } | null>(
  'billingSync:claim',
)
const release = makeFunctionReference<
  'mutation',
  { org_id: string; token: string; seats?: number; error?: string },
  null
>('billingSync:release')
const reminders = makeFunctionReference<
  'mutation',
  { now: number; threshold: number; cursor: string | null },
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
const webhook = makeFunctionReference<
  'action',
  { event_id: string; subscription_id: string },
  null
>('billingSync:webhook')
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
  Object.assign(STORAGE_PAGE, DEFAULT_STORAGE_PAGE)
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
  return { t, f, operator, operatorId, planId }
}
/* Runs the scheduled work, which holds each period's storage sample. */
const sample = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

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

const DEFAULT_STORAGE_PAGE = { ...STORAGE_PAGE }
const DEFAULT_SYNC_PAGE = { ...SYNC_PAGE }
const DEFAULT_REMINDER_PAGE = { ...REMINDER_PAGE }

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
    expect(await as(t, f.admin).query(summary, { org_id: f.org.id })).toMatchObject({
      status: 'pending',
      writable: false,
    })
    for (const profile of [f.user, f.viewer, f.guest]) {
      const caller = as(t, profile)
      await expectRefusal(caller.query(summary, { org_id: f.org.id }), 'forbidden', /admin only/)
      await expectRefusal(
        caller.action(usageReport, { org_id: f.org.id }),
        'forbidden',
        /admin only/,
      )
      await expectRefusal(caller.action(checkout, { org_id: f.org.id }), 'forbidden', /admin only/)
      await expectRefusal(caller.action(portal, { org_id: f.org.id }), 'forbidden', /admin only/)
      expect(await caller.query(status, { org_id: f.org.id })).toMatchObject({ writable: false })
    }
    await expectRefusal(t.query(summary, { org_id: f.org.id }), 'forbidden', /not signed in/)
    await expectRefusal(t.action(checkout, { org_id: f.org.id }), 'forbidden', /not signed in/)
    await expectRefusal(
      as(t, f.otherAdmin).query(summary, { org_id: f.org.id }),
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
    const oldSummary = await as(t, f.admin).query(summary, { org_id: f.org.id })
    expect(oldSummary.plan).toMatchObject({ name: 'Founding', seat_price_cents: 100 })
    expect(oldSummary.plan).not.toHaveProperty('polar_product_id')
    expect(oldSummary.plan).not.toHaveProperty('api_meter_id')
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
    expect(await as(t, f.admin).query(summary, { org_id: f.org.id })).toMatchObject({
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
    expect(await as(t, f.admin).action(usageReport, { org_id: f.org.id })).toHaveProperty(
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

  it('takes the storage snapshot once and retries the same durable charge without duplicating it', async () => {
    const { t, f } = await fixture()
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.meta.id })
    const attachment = await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob([]))
      return await ctx.db.insert('issue_attachments', {
        org_id: task.org_id,
        id: uuid(),
        issue_id: task.id,
        storage_id,
        name: 'synthetic-storage-fixture',
        size_bytes: 7_000_000_001,
        inline: false,
        created_at: NOW,
      })
    })
    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'initial-period' })
    await sample(t)
    await t.run((ctx) => ctx.db.patch(attachment, { size_bytes: 12_000_000_000 }))
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
      storage_bytes: 7_000_000_001,
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
  })

  it('reads and records the storage of an organization with 5,000 tasks within the transaction limits', async () => {
    const { t, f } = await fixture({ transactionLimits: true })
    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'first-period' })
    // 5,000 tasks, 4,500 of them with a 2 MB file, a third of those in PCB.
    // The rows share one stored file; only their size_bytes count.
    const storage_id = await t.run((ctx) => ctx.storage.store(new Blob([])))
    for (let from = 0; from < 5000; from += 1000) {
      await t.run(async (ctx) => {
        for (let i = from; i < from + 1000; i++) {
          const project_id = i % 3 === 0 ? f.sub2.id : f.sub.id
          const id = uuid()
          await ctx.db.insert('issues', {
            id,
            org_id: f.org.id,
            project_id,
            num: i + 1,
            title: `Task ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
          if (i < 4500)
            await ctx.db.insert('issue_attachments', {
              org_id: f.org.id,
              id: uuid(),
              issue_id: id,
              storage_id,
              name: `file-${i}.bin`,
              size_bytes: 2_000_000,
              inline: false,
              created_at: NOW,
            })
        }
      })
    }

    // a row whose task is gone costs one lookup and counts nowhere
    await t.run((ctx) =>
      ctx.db.insert('issue_attachments', {
        org_id: f.org.id,
        id: uuid(),
        issue_id: uuid(),
        storage_id,
        name: 'old.bin',
        size_bytes: 5,
        inline: false,
        created_at: NOW,
      }),
    )

    // the admin Billing page
    const report = await as(t, f.admin).action(usageReport, { org_id: f.org.id })
    expect(report.storage_bytes).toBe(9_000_000_000)
    expect(report.projects).toEqual([
      { project_id: f.sub.id, name: 'Firmware', storage_bytes: 6_000_000_000 },
      { project_id: f.sub2.id, name: 'Board rev', storage_bytes: 3_000_000_000 },
    ])

    // the renewal into the next period samples the same figure
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
    expect(await stored(t, f.org.id)).toMatchObject({
      current_period_start: next.start,
      current_period_end: next.end,
    })
    const period = await t.run((ctx) =>
      ctx.db
        .query('billing_periods')
        .withIndex('by_subscription_period', (q) =>
          q.eq('subscription_id', providerId).eq('period_start', next.start),
        )
        .unique(),
    )
    // 9 GB against the 5 GB the plan includes for five seats
    expect(period).toMatchObject({ storage_bytes: 9_000_000_000, storage_blocks: 4 })
  }, 120_000)

  it('records a renewal of 6,000 attachment rows at once and samples them under 4,000 documents a read', async () => {
    const { t, f } = await fixture({ transactionLimits: { documentsRead: 4000 } })
    const storage_id = await t.run((ctx) => ctx.storage.store(new Blob([])))
    const tasks = await t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 60; i++) {
        const id = uuid()
        await ctx.db.insert('issues', {
          id,
          org_id: f.org.id,
          project_id: f.sub.id,
          num: i + 1,
          title: `Task ${i}`,
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
        ids.push(id)
      }
      return ids
    })
    for (let from = 0; from < 6000; from += 3000) {
      await t.run(async (ctx) => {
        for (let i = from; i < from + 3000; i++)
          await ctx.db.insert('issue_attachments', {
            org_id: f.org.id,
            id: uuid(),
            issue_id: tasks[i % tasks.length],
            storage_id,
            name: `file-${i}.bin`,
            size_bytes: 1_000_000,
            inline: false,
            created_at: NOW,
          })
      })
    }
    // Measured inside the renewal, as before, the rows pass the limit.
    await expect(t.run((ctx) => storageUsage(ctx, f.org.id))).rejects.toThrow(
      /Scanned too many documents/,
    )

    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'heavy-period' })
    expect(await stored(t, f.org.id)).toMatchObject({ status: 'active', current_period_end: END })
    const pending = await periodAt(t, START)
    expect(pending?.storage_bytes).toBeUndefined()
    expect(pending?.storage_run).toEqual(expect.any(String))

    await sample(t)
    // 6 GB against the 5 GB the plan includes for five seats
    const period = await periodAt(t, START)
    expect(period).toMatchObject({ storage_bytes: 6_000_000_000, storage_blocks: 1 })
    expect(period).not.toHaveProperty('storage_run')
    expect(period).not.toHaveProperty('storage_run_at')
    expect(await storageEvents(t)).toMatchObject([{ units: 1, period_start: START }])
  })

  it('finishes a sample whose step an earlier release queued for rows without org_id', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id), event_id: 'queued-period' })
    const pending = await periodAt(t, START)
    if (pending?.storage_run === undefined) throw new Error('expected a running sample')
    // the step the earlier release scheduled after the organization's rows
    await t.mutation(
      makeFunctionReference<'mutation', Record<string, unknown>, null>('billingSync:storageStep'),
      { period: pending._id, run: pending.storage_run, phase: 'unscoped', bytes: 7_000_000_000 },
    )
    expect(await periodAt(t, START)).toMatchObject({
      storage_bytes: 7_000_000_000,
      storage_blocks: 2,
    })
  })

  it('samples the bytes storageUsage counts, at any page size', async () => {
    const { t, f } = await fixture()
    const storage_id = await t.run((ctx) => ctx.storage.store(new Blob([])))
    const file = (issue_id: string, size_bytes: number, org_id = f.org.id) => ({
      org_id,
      id: uuid(),
      issue_id,
      storage_id,
      name: 'fixture.bin',
      size_bytes,
      inline: false,
      created_at: NOW,
    })
    const fw = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const pcb = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const elsewhere = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    const gone = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const stranded = await plantIssue(t, { org_id: f.org.id, project_id: gone.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_attachments', file(fw.id, 2_000_000_000))
      await ctx.db.insert('issue_attachments', file(pcb.id, 3_000_000_000))
      await ctx.db.insert('issue_attachments', file(fw.id, 4_000_000_000))
      // another organization's row, and a row whose task is gone
      await ctx.db.insert('issue_attachments', file(elsewhere.id, 8_000_000_000, f.otherOrg.id))
      await ctx.db.insert('issue_attachments', file(uuid(), 16_000_000_000))
      // a row whose task's project is gone counts nowhere
      await ctx.db.insert('issue_attachments', file(stranded.id, 32_000_000_000))
      await ctx.db.delete(gone._id)
    })
    const live = await t.run((ctx) => storageUsage(ctx, f.org.id))
    expect(live.bytes).toBe(9_000_000_000)

    const sizes = [{ rows: 1 }, { rows: 1000, taskBytes: 1 }, { rows: 3 }, { rows: 1000 }]
    for (const [i, page] of sizes.entries()) {
      Object.assign(STORAGE_PAGE, DEFAULT_STORAGE_PAGE, page)
      const start = new Date(Date.parse(START) + i * 31 * 86_400_000).toISOString()
      await t.mutation(apply, {
        payload: remote(f.org.id, {
          current_period_start: start,
          current_period_end: addCalendarMonths(start, 1),
          modified_at: new Date(Date.parse(NOW) + i * 1000).toISOString(),
        }),
      })
      await sample(t)
      expect(await periodAt(t, start)).toMatchObject({
        storage_bytes: 9_000_000_000,
        storage_blocks: 4,
      })
    }
  })

  it('counts each row once when tasks are archived, restored or brought back from Deleted items during the sample', async () => {
    const { t, f } = await fixture()
    const storage_id = await t.run((ctx) => ctx.storage.store(new Blob([])))
    const rows: Id<'issue_attachments'>[] = []
    for (const [size_bytes, archived] of [
      [2_000_000_000, false],
      [3_000_000_000, false],
      [4_000_000_000, true],
    ] as const) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      rows.push(
        await t.run((ctx) =>
          ctx.db.insert('issue_attachments', {
            org_id: f.org.id,
            id: uuid(),
            issue_id: task.id,
            storage_id,
            name: 'fixture.bin',
            size_bytes,
            inline: false,
            created_at: NOW,
            ...(archived ? { task_archived: true as const } : {}),
          }),
        ),
      )
    }
    STORAGE_PAGE.rows = 1
    await t.mutation(apply, { payload: remote(f.org.id) })
    // the first step counts the first row
    vi.advanceTimersToNextTimer()
    await t.finishInProgressScheduledFunctions()
    // its task is archived, and the archived one restored
    await t.run(async (ctx) => {
      await ctx.db.patch(rows[0], { task_archived: true })
      await ctx.db.patch(rows[2], { task_archived: undefined })
    })
    // the first task goes to Deleted items and comes back, which writes its
    // row again as a new document
    await t.run(async (ctx) => {
      const row = await ctx.db.get(rows[0])
      if (row === null) throw new Error('fixture row vanished')
      const { _id, _creationTime, ...copy } = row
      await ctx.db.delete(_id)
      await ctx.db.insert('issue_attachments', copy)
    })
    await sample(t)
    expect(await periodAt(t, START)).toMatchObject({
      storage_bytes: 9_000_000_000,
      storage_blocks: 4,
    })
  })

  it('starts a stalled sample again, and the earlier run stops', async () => {
    const { t, f } = await fixture()
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob([]))
      await ctx.db.insert('issue_attachments', {
        org_id: f.org.id,
        id: uuid(),
        issue_id: task.id,
        storage_id,
        name: 'fixture.bin',
        size_bytes: 6_000_000_000,
        inline: false,
        created_at: NOW,
      })
    })
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
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob([]))
      await ctx.db.insert('issue_attachments', {
        org_id: f.org.id,
        id: uuid(),
        issue_id: task.id,
        storage_id,
        name: 'fixture.bin',
        size_bytes: 6_000_000_000,
        inline: false,
        created_at: NOW,
      })
    })
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
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob([]))
      await ctx.db.insert('issue_attachments', {
        org_id: f.org.id,
        id: uuid(),
        issue_id: task.id,
        storage_id,
        name: 'fixture.bin',
        size_bytes: 6_000_000_000,
        inline: false,
        created_at: NOW,
      })
    })
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
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob([]))
      await ctx.db.insert('issue_attachments', {
        org_id: f.org.id,
        id: uuid(),
        issue_id: task.id,
        storage_id,
        name: 'fixture.bin',
        size_bytes: 6_000_000_000,
        inline: false,
        created_at: NOW,
      })
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
  /* The calls waiting in the scheduler, by function name. */
  const queued = (t: T, name: string) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name === name && job.state.kind === 'pending',
      ),
    )
  const dueAt = async (t: T, orgId: string) => (await stored(t, orgId))?.sync_due_at
  const setDue = (t: T, orgId: string, due: string | undefined, safety?: true) =>
    t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .unique()
      await ctx.db.patch(sub!._id, { sync_due_at: due, sync_safety: safety })
    })
  const notices = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('billing_notices').collect()).map((n) => [n.profile_id, n.kind]),
    )
  /* Gives the organization a free period until `until`, enrolling it first. */
  const grantUntil = (t: T, orgId: string, until: string, updated = NOW) =>
    t.run(async (ctx) => {
      const sub = await enrollOrganization(ctx, orgId)
      await ctx.db.patch(sub!._id, { complimentary_until: until, updated_at: updated })
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

  it('starts due organizations a page at a time, targeted times first, then those without one, then the safety pass', async () => {
    const { t, f } = await fixture()
    SYNC_PAGE.size = 2
    const [late, early, safe] = [uuid(), uuid(), uuid()]
    await t.run(async (ctx) => {
      for (const id of [late, early, safe]) await enrollOrganization(ctx, id)
    })
    // f.org has no due time, as for an organization enrolled before due times
    await setDue(t, f.org.id, undefined)
    await setDue(t, late, iso(-1))
    await setDue(t, early, iso(-2))
    await setDue(t, safe, iso(-30), true)
    await t.mutation(sweep, {})
    const first = await queued(t, 'billingSync:reconcile')
    expect(first.map((job) => job.args[0].org_id)).toEqual([early, late])
    expect(first[1].scheduledTime - first[0].scheduledTime).toBe(SYNC_PAGE.spacing)
    await t.mutation(sweep, {})
    const second = await queued(t, 'billingSync:reconcile')
    expect(second.slice(2).map((job) => job.args[0].org_id)).toEqual([f.org.id, safe])
    await t.mutation(sweep, {})
    expect(await queued(t, 'billingSync:reconcile')).toHaveLength(4)
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
    await sample(t)
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(iso(SYNC_SAFETY_MS / 60_000))
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
      new Date(end + 10 * 60_000 + RENEWAL_POLL_MS).toISOString(),
    )
    expect(RENEWAL_POLL_MS).toBeLessThan((5 * 25_000 * 60_000) / 6_000)
    vi.setSystemTime(end + 25 * 60 * 60_000)
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(end + 25 * 60 * 60_000 + SYNC_SAFETY_MS).toISOString(),
    )
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
    expect(await settle(t, f.org.id)).toBe(iso(PAYMENT_POLL_MS / 60_000))
    // a checkout Polar never ends stops being polled an hour after its expiry
    const late = Date.parse(expires) + CHECKOUT_POLL_GRACE_MS
    vi.setSystemTime(late)
    expect(await settle(t, f.org.id)).toBe(new Date(late + SYNC_SAFETY_MS).toISOString())
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
      sync_due_at: iso(SYNC_SAFETY_MS / 60_000),
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
        sync_due_at: iso(minutes),
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
      iso(SYNC_SAFETY_MS / 60_000),
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
    // the 32-minute backoff alone would retry 12 minutes after the renewal
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
    // the 60-minute backoff and the check after the end would both miss it
    for (const before of [PRE_RENEWAL_MS, PRE_RENEWAL_MS - 60_000, 60_000]) {
      vi.setSystemTime(end - before)
      await t.action(reconcile, { org_id: f.org.id })
      expect(await dueAt(t, f.org.id)).toBe(new Date(end - before + 60_000).toISOString())
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
      sync_due_at: iso(PAYMENT_POLL_MS / 60_000),
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

  it('counts the guest organizations a deleted profile marks due against the deletion step', async () => {
    const { t, f } = await fixture()
    const email = 'consultant@testbed.test'
    const guestOrgs = Array.from({ length: 300 }, () => uuid())
    await t.run(async (ctx) => {
      await ctx.db.patch(f.otherAdmin._id, { email })
      for (const org_id of guestOrgs) {
        await enrollOrganization(ctx, org_id)
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
      }
      // a second home profile, deleted after the first
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
    await t.run(async (ctx) => {
      const removal = await ctx.db
        .query('org_removals')
        .withIndex('by_org', (q) => q.eq('org_id', f.otherOrg.id))
        .unique()
      await deleteOrgStep(ctx, removal!)
    })
    expect(await queued(t, 'billingSync:reconcile')).toEqual([])
    expect(new Set(await Promise.all(guestOrgs.map((id) => dueAt(t, id))))).toEqual(new Set([NOW]))
    // the 600 rows it read used up the step, so the other profile waits
    const left = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', f.otherOrg.id))
        .collect(),
    )
    expect(left.map((p) => p.email)).toEqual(['colleague@testbed.test'])
  })

  it('polls a subscription that is past due, unpaid or incomplete, often in its first day', async () => {
    const { t, f } = await fixture()
    for (const status of ['past_due', 'unpaid']) {
      await t.mutation(apply, { payload: remote(f.org.id, { status, modified_at: iso(1) }) })
      vi.setSystemTime(Date.parse(iso(1)))
      expect(await settle(t, f.org.id, { seats: 5 })).toBe(iso(1 + PAYMENT_POLL_MS / 60_000))
      // unpaid has no end of its own, so after the first day every half hour
      const later = Date.parse(iso(1)) + PAYMENT_POLL_WINDOW_MS
      vi.setSystemTime(later)
      expect(await settle(t, f.org.id, { seats: 5 })).toBe(
        new Date(later + DUNNING_POLL_MS).toISOString(),
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
    expect(await settle(t, f.org.id)).toBe(iso(2 + PAYMENT_POLL_MS / 60_000))
    const later = Date.parse(iso(2)) + PAYMENT_POLL_WINDOW_MS
    vi.setSystemTime(later)
    expect(await settle(t, f.org.id)).toBe(new Date(later + SYNC_SAFETY_MS).toISOString())
  })

  it('follows a renewal that Polar moved', async () => {
    const { t, f } = await fixture()
    await t.mutation(apply, { payload: remote(f.org.id) })
    await sample(t)
    const end = Date.parse(END)
    vi.setSystemTime(end - PRE_RENEWAL_MS)
    // the check before the old end reads the end Polar moved a day later
    const moved = new Date(end + 24 * 60 * 60_000).toISOString()
    await t.mutation(apply, {
      payload: remote(f.org.id, { current_period_end: moved, modified_at: iso(60) }),
    })
    expect(await settle(t, f.org.id, { seats: 5 })).toBe(
      new Date(end - PRE_RENEWAL_MS + SYNC_SAFETY_MS).toISOString(),
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
    await t.action(webhook, { event_id: 'renewal-1', subscription_id: providerId })
    expect(await stored(t, f.org.id)).toMatchObject({ sync_due_at: NOW })
  })

  it('starts targeted times before the safety pass when the page is full', async () => {
    const { t, f } = await fixture()
    SYNC_PAGE.size = 1
    const renewing = uuid()
    await t.run((ctx) => enrollOrganization(ctx, renewing))
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      // the older safety pass waits for the renewal check behind it
      await ctx.db.patch(sub!._id, { sync_due_at: iso(-30), sync_safety: true })
    })
    await setDue(t, renewing, iso(-1))
    await t.mutation(sweep, {})
    expect((await queued(t, 'billingSync:reconcile')).map((job) => job.args[0].org_id)).toEqual([
      renewing,
    ])
  })

  it('reminds the admins of free periods within an hour of each reminder time, a page at a time', async () => {
    const { t, f } = await fixture()
    REMINDER_PAGE.size = 1
    await grantUntil(t, f.org.id, iso(7 * 24 * 60 - 30))
    // ended half an hour ago, and its members' pages have not refreshed since
    await grantUntil(t, f.otherOrg.id, iso(-30), iso(-60))
    await grantUntil(t, uuid(), iso(-10))
    // between its reminder times; the old code reminded it every minute
    await grantUntil(t, uuid(), iso(3 * 24 * 60))
    await t.mutation(sweep, {})
    // the reminders run apart from the sweep, so their failure cannot undo
    // the reconciliations the sweep started
    expect(await notices(t)).toEqual([])
    expect((await queued(t, 'billingSync:reconcile')).length).toBeGreaterThan(0)
    const jobs = await queued(t, 'billingSync:reminders')
    expect(jobs.map((job) => job.args[0])).toEqual([
      { now: Date.parse(NOW), threshold: 7 * 86_400_000, cursor: null },
      { now: Date.parse(NOW), threshold: 0, cursor: null },
    ])
    for (const job of jobs) await t.mutation(reminders, job.args[0])
    expect(await notices(t)).toEqual([
      [f.admin.id, 'seven_days'],
      [f.otherAdmin.id, 'expired'],
    ])
    // the end touches the row once, so members' pages read the expiry
    expect((await stored(t, f.otherOrg.id))?.updated_at).toBe(NOW)
    const next = (await queued(t, 'billingSync:reminders')).find(
      (job) => job.args[0].cursor && job.args[0].threshold === 0,
    )
    await t.mutation(reminders, next!.args[0])
    expect(await notices(t)).toHaveLength(2)
    // an hour after their reminder times, the free periods are out of range
    vi.setSystemTime(Date.parse(iso(51)))
    const before = (await queued(t, 'billingSync:reminders')).length
    await t.mutation(sweep, {})
    expect(await queued(t, 'billingSync:reminders')).toHaveLength(before)
  })
})
