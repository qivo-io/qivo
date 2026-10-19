import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { BillingPlan } from '../lib/billingTypes'
import { enrollOrganization } from '../model/billing'
import { REMOVAL_BUDGET } from '../model/cascade'
import { noCheckoutDue, serviceEndedAt } from '../model/orgRetention'
import { STALLED_MS, SWEEP_PAGES } from '../orgRemovals'
import { as, expectRefusal, newT, plantIssue, type T, uuid, withOrg } from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it (same situation as cascade.test.ts) */
declare class Blob {
  constructor(parts: string[])
}

type PlanInput = Omit<BillingPlan, 'id' | 'archived' | 'created_at'>
const insertPlan = makeFunctionReference<
  'mutation',
  { plan: PlanInput; actor: string; email: string },
  string
>('adminBilling:insertPlan')
const setDefaultPlan = makeFunctionReference<'mutation', { plan_id: string }, null>(
  'adminBilling:setDefaultPlan',
)
const grant = makeFunctionReference<'mutation', { org_id: string; months: number }, null>(
  'adminBilling:grantComplimentary',
)

const NOW = '2026-09-20T12:00:00.000Z'
const START = '2026-09-01T12:00:00.000Z'
const END = '2026-10-01T12:00:00.000Z'
const DAY = 86_400_000
const at = (days: number) => new Date(Date.parse(NOW) + days * DAY).toISOString()
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
  REMOVAL_BUDGET.rows = 256
  SWEEP_PAGES.removals = 128
  SWEEP_PAGES.subscriptions = 64
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const terms = (): PlanInput => ({
  name: 'Founding',
  currency: 'usd',
  seat_price_cents: 100,
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
})

/* An organization on a connected plan, enrolled while billing runs. */
async function billed() {
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
  return { t, f, operator }
}

/* An organization on a deployment without billing. */
async function unbilled() {
  vi.stubEnv('BILLING_ENABLED', 'false')
  const t = newT()
  return { t, f: await withOrg(t) }
}

function remote(orgId: string, overrides: Record<string, unknown> = {}) {
  return {
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
  }
}
const checkoutId = '66666666-6666-4666-8666-666666666666'
const checkoutBody = (orgId: string, status: string) => ({
  id: checkoutId,
  status,
  url: 'https://sandbox.polar.sh/checkout/example',
  expires_at: at(40),
  external_customer_id: orgId,
  product_id: productId,
  seats: 5,
  min_seats: 5,
  max_seats: 5,
})
/* Saves a checkout on the organization's subscription row, as
 * billingActions.finishCheckout does. */
const saveCheckout = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const sub = await ctx.db
      .query('billing_subscriptions')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique()
    await ctx.db.patch(sub!._id, { checkout_id: checkoutId })
  })
const applied = (t: T, body: Record<string, unknown>) =>
  t.mutation(internal.billingSync.apply, { payload: JSON.stringify(body) })

/* Answers the Polar calls these flows make: listing an organization's
 * subscriptions, cancelling one at period end, revoking one, and reading a
 * checkout. Anything else fails as Polar being unavailable. */
function polar(routes: {
  list?: () => unknown[]
  cancel?: (id: string) => unknown
  revoke?: (id: string) => unknown
  checkout?: (id: string) => unknown
}) {
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const json = (body: unknown) => new Response(JSON.stringify(body))
    if (url.pathname === '/v1/subscriptions/' && method === 'GET')
      return json({ items: routes.list?.() ?? [], pagination: { max_page: 1 } })
    const sub = /^\/v1\/subscriptions\/([0-9a-f-]+)$/.exec(url.pathname)
    if (sub && method === 'DELETE' && routes.revoke) return json(routes.revoke(sub[1]))
    if (
      sub &&
      method === 'PATCH' &&
      routes.cancel &&
      init?.body === JSON.stringify({ cancel_at_period_end: true })
    )
      return json(routes.cancel(sub[1]))
    const checkout = /^\/v1\/checkouts\/([0-9a-f-]+)$/.exec(url.pathname)
    if (checkout && routes.checkout) return json(routes.checkout(checkout[1]))
    return new Response('unexpected request', { status: 500 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const removalOf = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_removals')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique(),
  )
const deletionNotices = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('billing_notices').collect()).filter((n) => n.kind === 'deletion'),
  )
const createTask = (t: T, profile: Doc<'profiles'>, orgId: string, projectId: string) =>
  as(t, profile).mutation(api.issues.create, {
    org_id: orgId,
    id: uuid(),
    project_id: projectId,
    title: 'After the end',
  })
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())
/* A recent export suppresses the deletion email, so deletion tests do not
 * leave hourly mail retries behind. */
const exportNow = (t: T, f: Awaited<ReturnType<typeof withOrg>>) =>
  as(t, f.admin).mutation(api.orgRemovals.recordExport, { org_id: f.org.id })

const subscription = (overrides: Partial<Doc<'billing_subscriptions'>>) =>
  ({
    id: uuid(),
    org_id: uuid(),
    plan_id: uuid(),
    status: 'pending',
    billed_seats: 0,
    next_seats: 5,
    cancel_at_period_end: false,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }) as Doc<'billing_subscriptions'>

/* Counts of the rows an organization owns, by table. */
const orgRows = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const counts: Record<string, number> = {}
    for (const table of [
      'profiles',
      'issues',
      'projects',
      'teams',
      'labels',
      'activity_events',
      'messages',
      'issue_attachments',
      'org_counters',
      'activity_retention',
    ] as const)
      counts[table] = (await ctx.db.query(table).collect()).filter(
        (row) => (row as { org_id?: string }).org_id === orgId,
      ).length
    return counts
  })

describe('when the service ends', () => {
  it.each([
    ['an active subscription', { status: 'active', current_period_end: END }, null],
    ['a revoked subscription', { status: 'canceled', ended_at: at(-1) }, at(-1)],
    [
      'a cancellation that waits for the period end',
      { status: 'canceled', cancel_at_period_end: true, current_period_end: END },
      null,
    ],
    ['an overdue payment', { status: 'past_due', past_due_at: at(-20) }, null],
    ['ended complimentary access', { complimentary_until: at(-1) }, at(-1)],
    ['a first checkout still awaited', {}, null],
  ] as const)('reads %s', (_, fields, expected) => {
    expect(serviceEndedAt(subscription(fields))).toBe(expected)
  })

  it('never ends a service while billing is off', () => {
    vi.stubEnv('BILLING_ENABLED', 'false')
    expect(serviceEndedAt(subscription({ status: 'canceled', ended_at: at(-1) }))).toBeNull()
  })

  it.each([
    ['is due after its deadline', { checkout_due_at: at(-1) }, true],
    ['waits before its deadline', { checkout_due_at: at(1) }, false],
    ['spares organizations enrolled before billing', {}, false],
    ['spares complimentary access', { checkout_due_at: at(-1), complimentary_until: at(9) }, false],
    [
      'waits while checkout is prepared',
      { checkout_due_at: at(-1), checkout_lock_until: at(0.001) },
      false,
    ],
    [
      'spares a provider subscription',
      { checkout_due_at: at(-1), polar_subscription_id: providerId },
      false,
    ],
  ] as const)('a checkout deadline %s', (_, fields, expected) => {
    expect(noCheckoutDue(subscription(fields))).toBe(expected)
  })
})

describe('cancelling a subscription', () => {
  const summary = (t: T, f: Awaited<ReturnType<typeof withOrg>>) =>
    as(t, f.admin).query(api.billing.summary, { org_id: f.org.id })
  /* Polar ends a subscription cancelled at period end once the period is
   * over, a minute after END here. */
  const ended = Date.parse(END) + 60_000
  const periodOver = (t: T, orgId: string) => {
    vi.setSystemTime(ended)
    return applied(
      t,
      remote(orgId, {
        status: 'canceled',
        cancel_at_period_end: true,
        ended_at: END,
        modified_at: new Date(ended).toISOString(),
      }),
    )
  }

  it('keeps access until the paid period ends, then starts the 30 days', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id))
    const fetchMock = polar({
      list: () => [remote(f.org.id)],
      cancel: () => remote(f.org.id, { cancel_at_period_end: true, modified_at: at(0.001) }),
    })
    const result = await as(t, f.admin).action(api.billingActions.cancelSubscription, {
      org_id: f.org.id,
    })
    expect(result.ends_at).toBe(END)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'PATCH'])
    expect(await summary(t, f)).toMatchObject({
      writable: true,
      cancel_at_period_end: true,
      cancel_available: false,
      deletion: null,
    })
    expect(await removalOf(t, f.org.id)).toBeNull()
    await createTask(t, f.admin, f.org.id, f.sub.id)

    await periodOver(t, f.org.id)
    expect(await removalOf(t, f.org.id)).toMatchObject({
      reason: 'service_ended',
      ended_at: END,
      delete_after: new Date(ended + 30 * DAY).toISOString(),
    })
    const refusal = await expectRefusal(createTask(t, f.admin, f.org.id, f.sub.id), 'forbidden')
    expect(refusal.data).toMatchObject({ reason: 'deletion_scheduled' })
    // the export still works while the organization waits
    await exportNow(t, f)
  })

  it.each([
    ['a renewing subscription', true, {}],
    ['an overdue payment', false, { status: 'past_due' }],
    ['a subscription that already ends', false, { cancel_at_period_end: true }],
  ] as const)('is offered for %s: %s', async (_, offered, fields) => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, fields))
    expect((await summary(t, f)).cancel_available).toBe(offered)
  })

  it('counts a subscription that already ends as cancelled', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id))
    // cancelled in Polar's portal, before its webhook arrived
    const fetchMock = polar({ list: () => [remote(f.org.id, { cancel_at_period_end: true })] })
    const result = await as(t, f.admin).action(api.billingActions.cancelSubscription, {
      org_id: f.org.id,
    })
    expect(result.ends_at).toBe(END)
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET'])
    expect(await summary(t, f)).toMatchObject({ cancel_at_period_end: true, writable: true })
  })

  it('refuses non-admins, a Polar failure and organizations without a subscription', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id))
    await expectRefusal(
      as(t, f.user).action(api.billingActions.cancelSubscription, { org_id: f.org.id }),
      'forbidden',
    )
    polar({ list: () => [remote(f.org.id)] })
    await expectRefusal(
      as(t, f.admin).action(api.billingActions.cancelSubscription, { org_id: f.org.id }),
      'rule',
      /Polar could not cancel/,
    )
    expect(await summary(t, f)).toMatchObject({
      cancel_at_period_end: false,
      cancel_available: true,
    })
    polar({ list: () => [] })
    await expectRefusal(
      as(t, f.admin).action(api.billingActions.cancelSubscription, { org_id: f.org.id }),
      'rule',
      /no subscription to cancel/,
    )
    expect(await removalOf(t, f.org.id)).toBeNull()
  })

  it.each([
    [8, 1],
    [6, 0],
  ])(
    'emails admins when the period ends and the last export is %i days old: %i notices',
    async (age, count) => {
      const { t, f } = await billed()
      await applied(t, remote(f.org.id, { cancel_at_period_end: true }))
      vi.setSystemTime(ended - age * DAY)
      await exportNow(t, f)
      await periodOver(t, f.org.id)
      const notices = await deletionNotices(t)
      expect(notices).toHaveLength(count)
      if (count)
        expect(
          await t.query(internal.orgRemovals.noticeReady, { key: notices[0].key }),
        ).toMatchObject({
          to: f.admin.email,
          delete_after: new Date(ended + 30 * DAY).toISOString(),
          reason: 'service_ended',
        })
    },
  )

  it('stops the deletion when a new subscription starts', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'service_ended' })
    await applied(
      t,
      remote(f.org.id, {
        id: replacementId,
        current_period_start: at(1),
        current_period_end: at(31),
        modified_at: at(1),
      }),
    )
    expect(await removalOf(t, f.org.id)).toBeNull()
  })
})

describe('an admin deleting the organization', () => {
  it('asks for the address, then keeps it read-only until an admin stops it', async () => {
    const { t, f } = await unbilled()
    await expectRefusal(
      as(t, f.admin).action(api.orgRemovals.request, { org_id: f.org.id, confirm: 'other' }),
      'rule',
    )
    await expectRefusal(
      as(t, f.user).action(api.orgRemovals.request, { org_id: f.org.id, confirm: f.org.slug }),
      'forbidden',
    )
    const { delete_after } = await as(t, f.admin).action(api.orgRemovals.request, {
      org_id: f.org.id,
      confirm: ` ${f.org.slug.toUpperCase()} `,
    })
    expect(delete_after).toBe(at(30))
    expect(await as(t, f.admin).query(api.orgRemovals.state, { org_id: f.org.id })).toMatchObject({
      deletion: { reason: 'requested', delete_after: at(30) },
    })
    await expectRefusal(createTask(t, f.user, f.org.id, f.sub.id), 'forbidden')
    await expectRefusal(
      as(t, f.user).mutation(api.orgRemovals.keep, { org_id: f.org.id }),
      'forbidden',
    )
    await as(t, f.admin).mutation(api.orgRemovals.keep, { org_id: f.org.id })
    expect(await removalOf(t, f.org.id)).toBeNull()
    await createTask(t, f.admin, f.org.id, f.sub.id)
  })

  it('ends a paid subscription before the read-only period', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id))
    const fetchMock = polar({
      list: () => [remote(f.org.id)],
      revoke: () => remote(f.org.id, { status: 'canceled', ended_at: NOW }),
    })
    await as(t, f.admin).action(api.orgRemovals.request, {
      org_id: f.org.id,
      confirm: f.org.slug,
    })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'requested' })

    // Keep waits for a subscription, so it cannot restart the period for free
    const state = () => as(t, f.admin).query(api.orgRemovals.state, { org_id: f.org.id })
    expect((await state()).deletion?.keep_available).toBe(false)
    await expectRefusal(
      as(t, f.admin).mutation(api.orgRemovals.keep, { org_id: f.org.id }),
      'rule',
      /Subscribe again/,
    )
    await applied(
      t,
      remote(f.org.id, {
        id: replacementId,
        current_period_start: at(1),
        current_period_end: at(31),
        modified_at: at(1),
      }),
    )
    // a later subscription does not stop a deletion an admin asked for
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'requested' })
    expect((await state()).deletion?.keep_available).toBe(true)
    await as(t, f.admin).mutation(api.orgRemovals.keep, { org_id: f.org.id })
    expect(await removalOf(t, f.org.id)).toBeNull()
    await createTask(t, f.admin, f.org.id, f.sub.id)
  })
})

describe('deleting the organization', () => {
  async function filled() {
    const { t, f } = await unbilled()
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await as(t, f.admin).mutation(api.comments.create, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: issue.id,
      body: 'Ready for review',
    })
    for (let i = 0; i < 3; i++) await createTask(t, f.admin, f.org.id, f.sub.id)
    const storage = await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob(['bytes']) as never)
      await ctx.db.insert('issue_attachments', {
        org_id: f.org.id,
        id: uuid(),
        issue_id: issue.id,
        name: 'planted.txt',
        size_bytes: 5,
        mime: 'text/plain',
        storage_id,
        inline: false,
        created_at: NOW,
      })
      return storage_id
    })
    await exportNow(t, f)
    await as(t, f.admin).action(api.orgRemovals.request, { org_id: f.org.id, confirm: f.org.slug })
    return { t, f, storage }
  }

  it('waits for the date, refuses access once it begins and removes everything', async () => {
    const { t, f, storage } = await filled()
    const before = await orgRows(t, f.org.id)
    expect(before.issues).toBeGreaterThan(0)
    expect(before.activity_events).toBeGreaterThan(0)
    const others = await orgRows(t, f.otherOrg.id)

    vi.setSystemTime(Date.parse(at(30)) - 60_000)
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    const waiting = await removalOf(t, f.org.id)
    expect(waiting).not.toBeNull()
    expect(waiting?.phase).toBeUndefined()

    REMOVAL_BUDGET.rows = 3
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    expect(await removalOf(t, f.org.id)).toMatchObject({ phase: 'profiles' })
    await expectRefusal(
      as(t, f.admin).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /being deleted/,
    )
    await runSteps(t)

    expect(await removalOf(t, f.org.id)).toBeNull()
    expect(Object.values(await orgRows(t, f.org.id)).every((n) => n === 0)).toBe(true)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('organizations')
          .withIndex('by_uuid', (q) => q.eq('id', f.org.id))
          .unique(),
      ),
    ).toBeNull()
    expect(await t.run((ctx) => ctx.db.system.get(storage))).toBeNull()
    expect(await orgRows(t, f.otherOrg.id)).toEqual(others)
    await assertNoDanglingRefs(t, 'organization deletion')
  })

  it('resumes a deletion whose step stopped behind removals still waiting', async () => {
    const { t, f } = await filled()
    // more waiting removals than one recovery scan reads
    await t.run(async (ctx) => {
      for (let i = 0; i < 513; i++)
        await ctx.db.insert('org_removals', {
          org_id: uuid(),
          reason: 'requested',
          ended_at: NOW,
          delete_after: at(31),
          created_at: NOW,
        })
    })
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    const removal = (await removalOf(t, f.org.id))!
    await t.run((ctx) => ctx.scheduler.cancel(removal.scheduled_id as Id<'_scheduled_functions'>))
    vi.setSystemTime(Date.now() + STALLED_MS + 60_000)
    await t.mutation(internal.orgRemovals.recover, {})
    await runSteps(t)
    expect(await removalOf(t, f.org.id)).toBeNull()
    expect((await orgRows(t, f.org.id)).issues).toBe(0)
  })

  it.each([
    ['the hourly sweep', (t: T) => t.mutation(internal.orgRemovals.sweep, {})],
    [
      'the start of deletion',
      (t: T, orgId: string) => t.action(internal.orgRemovals.begin, { org_id: orgId }),
    ],
  ])('stops a billing deletion when billing is switched off, seen by %s', async (_, run) => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'service_ended' })
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    vi.stubEnv('BILLING_ENABLED', 'false')
    await run(t, f.org.id)
    expect(await removalOf(t, f.org.id)).toBeNull()
    expect((await orgRows(t, f.org.id)).profiles).toBeGreaterThan(0)
  })

  it('keeps an organization whose Polar subscription is live on the date', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    polar({
      list: () => [
        remote(f.org.id, {
          id: replacementId,
          current_period_start: at(29),
          current_period_end: at(59),
        }),
      ],
    })
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    expect(await removalOf(t, f.org.id)).toBeNull()
    expect((await orgRows(t, f.org.id)).profiles).toBeGreaterThan(0)
  })

  it('holds a deletion an admin asked for while a subscription is live', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id))
    polar({
      list: () => [remote(f.org.id)],
      revoke: () => remote(f.org.id, { status: 'canceled', ended_at: NOW }),
    })
    await as(t, f.admin).action(api.orgRemovals.request, { org_id: f.org.id, confirm: f.org.slug })
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    polar({ list: () => [remote(f.org.id, { id: replacementId, current_period_end: at(59) })] })
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    const held = await removalOf(t, f.org.id)
    expect(held).toMatchObject({ reason: 'requested' })
    expect(held?.phase).toBeUndefined()
    // a request made after begin read the removal survives its abort too
    await t.mutation(internal.orgRemovals.abort, { org_id: f.org.id })
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'requested' })
  })

  it.each([
    ['open', false],
    ['expired', true],
  ] as const)(
    'reads a %s checkout from Polar on the date: deleting %s',
    async (status, deleting) => {
      const { t, f } = await billed()
      await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
      await saveCheckout(t, f.org.id)
      vi.setSystemTime(Date.parse(at(30)) + 60_000)
      polar({ list: () => [], checkout: () => checkoutBody(f.org.id, status) })
      await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
      expect((await removalOf(t, f.org.id))?.phase).toBe(deleting ? 'profiles' : undefined)
    },
  )

  it('waits while billing runs without Polar credentials', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
    vi.stubEnv('POLAR_ACCESS_TOKEN', '')
    await expectRefusal(
      as(t, f.admin).action(api.orgRemovals.request, { org_id: f.org.id, confirm: f.org.slug }),
      'rule',
    )
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    const waiting = await removalOf(t, f.org.id)
    expect(waiting).toMatchObject({ reason: 'service_ended' })
    expect(waiting?.phase).toBeUndefined()
  })

  it("leaves an organization being deleted out of its members' other reads", async () => {
    const { t, f } = await filled()
    // the admin also belongs to the other organization
    await t.run((ctx) => {
      const { _id, _creationTime, ...admin } = f.admin
      return ctx.db.insert('profiles', { ...admin, id: uuid(), org_id: f.otherOrg.id })
    })
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    const snapshot = await as(t, f.admin).query(api.snapshot.forMe, {})
    expect(snapshot?.orgs.map((org) => org.id)).toEqual([f.otherOrg.id])
    await expectRefusal(
      as(t, f.admin).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /being deleted/,
    )
  })
})

describe('the hourly sweep', () => {
  it('reaches every organization one page at a time', async () => {
    const { t, f } = await billed()
    await t.run(async (ctx) => {
      await enrollOrganization(ctx, f.otherOrg.id)
      // complimentary access that ran out without any webhook, and recent
      // exports, so no deletion email is queued
      for (const sub of await ctx.db.query('billing_subscriptions').collect())
        await ctx.db.patch(sub._id, { complimentary_until: at(-1) })
      for (const org of await ctx.db.query('organizations').collect())
        await ctx.db.patch(org._id, { last_export_at: NOW })
    })
    SWEEP_PAGES.removals = 1
    SWEEP_PAGES.subscriptions = 1
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    for (const org of [f.org, f.otherOrg])
      expect(await removalOf(t, org.id)).toMatchObject({
        reason: 'service_ended',
        delete_after: at(30),
      })

    polar({ list: () => [] })
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    for (const org of [f.org, f.otherOrg]) {
      expect(await removalOf(t, org.id)).toBeNull()
      expect((await orgRows(t, org.id)).profiles).toBe(0)
    }
  })
})

describe('an organization that never completes checkout', () => {
  it('keeps a checkout saved after Polar was asked', async () => {
    const { t, f } = await billed()
    vi.setSystemTime(Date.parse(at(3)) + 60_000)
    await saveCheckout(t, f.org.id)
    await t.mutation(internal.orgRemovals.startNoCheckout, { org_id: f.org.id })
    expect(await removalOf(t, f.org.id)).toBeNull()
  })

  it('shows no checkout deadline once complimentary access was granted', async () => {
    const { t, f, operator } = await billed()
    const status = () => as(t, f.user).query(api.billing.status, { org_id: f.org.id })
    const summary = () => as(t, f.admin).query(api.billing.summary, { org_id: f.org.id })
    expect((await status()).checkout_due_at).toBe(at(3))
    expect((await summary()).checkout_due_at).toBe(at(3))
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    expect((await status()).checkout_due_at).toBeNull()
    expect((await summary()).checkout_due_at).toBeNull()
  })

  it('is deleted 3 days after enrollment once Polar confirms nothing is pending', async () => {
    const { t, f } = await billed()
    const sub = await t.run((ctx) =>
      ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique(),
    )
    expect(sub?.checkout_due_at).toBe(at(3))
    polar({ list: () => [] })

    vi.setSystemTime(Date.parse(at(3)) - 60_000)
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    expect((await orgRows(t, f.org.id)).profiles).toBeGreaterThan(0)

    vi.setSystemTime(Date.parse(at(3)) + 60_000)
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    expect(await orgRows(t, f.org.id)).toMatchObject({ profiles: 0, projects: 0 })
    expect((await orgRows(t, f.otherOrg.id)).profiles).toBeGreaterThan(0)
  })

  it.each([
    ['open', true],
    ['expired', false],
  ] as const)('reads a %s checkout from Polar before deleting: kept %s', async (status, kept) => {
    const { t, f } = await billed()
    const checkoutId = '66666666-6666-4666-8666-666666666666'
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query('billing_subscriptions')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.patch(sub!._id, { checkout_id: checkoutId })
    })
    polar({
      list: () => [],
      checkout: (id) => ({
        id,
        status,
        url: 'https://sandbox.polar.sh/checkout/example',
        expires_at: at(4),
        external_customer_id: f.org.id,
        product_id: productId,
        seats: 5,
        min_seats: 5,
        max_seats: 5,
      }),
    })
    vi.setSystemTime(Date.parse(at(3)) + 60_000)
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    expect((await orgRows(t, f.org.id)).profiles > 0).toBe(kept)
  })

  it('spares complimentary access', async () => {
    const { t, f, operator } = await billed()
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    polar({ list: () => [] })
    vi.setSystemTime(Date.parse(at(3)) + 60_000)
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    expect(await removalOf(t, f.org.id)).toBeNull()
  })
})
