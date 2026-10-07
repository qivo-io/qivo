import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import { addCalendarMonths } from '../lib/billingAccess'
import type { BillingPlan, BillingSummary, BillingUsage } from '../lib/billingTypes'
import { enrollOrganization } from '../model/billing'
import { as, expectRefusal, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'

type PlanInput = Omit<BillingPlan, 'id' | 'archived' | 'created_at'>
const summary = makeFunctionReference<'query', { org_id: string }, BillingSummary>(
  'billing:summary',
)
const usage = makeFunctionReference<'query', { org_id: string }, BillingUsage>('billing:usage')
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
async function fixture() {
  const t = newT()
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
      await expectRefusal(caller.query(usage, { org_id: f.org.id }), 'forbidden', /admin only/)
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
      await expectRefusal(
        as(t, f.admin).action(checkout, { org_id: f.org.id }),
        'rule',
        /already has a subscription/,
      )
      const cleared = await stored(t, f.org.id)
      expect(cleared).not.toHaveProperty('checkout_id')
      expect(cleared).not.toHaveProperty('checkout_url')
      expect(cleared).not.toHaveProperty('checkout_lock')
    },
  )
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
    expect(await as(t, f.admin).query(usage, { org_id: f.org.id })).toHaveProperty('calls', 0)
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
      const storage_id = await ctx.storage.store(new Blob())
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
    await t.run((ctx) => ctx.db.patch(attachment, { size_bytes: 12_000_000_000 }))
    await t.mutation(apply, {
      payload: remote(f.org.id, { modified_at: '2026-09-20T12:01:00.000Z' }),
      event_id: 'retry-period',
    })
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
