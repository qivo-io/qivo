import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { BillingPlan } from '../lib/billingTypes'
import { asMachineCaller } from '../lib/core'
import type { EventOwner } from '../lib/taskEvents'
import { sha256hex, touchCredential } from '../machine/auth'
import { enrollOrganization } from '../model/billing'
import { REMOVAL_BUDGET } from '../model/cascade'
import { noCheckoutDue, retentionDue, serviceEndedAt } from '../model/orgRetention'
import { STALLED_MS, SWEEP_PAGES } from '../orgRemovals'
import {
  as,
  expectRefusal,
  fileState,
  keepHeldFiles,
  newT,
  plantIssue,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'
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

keepHeldFiles()
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

  it('refuses an overdue payment Qivo has not heard of yet, before cancelling', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id))
    // Polar marked it past due, and its webhook has not arrived
    const fetchMock = polar({
      list: () => [remote(f.org.id, { status: 'past_due' })],
      cancel: () => remote(f.org.id, { status: 'past_due', cancel_at_period_end: true }),
    })
    await expectRefusal(
      as(t, f.admin).action(api.billingActions.cancelSubscription, { org_id: f.org.id }),
      'rule',
      /payment is overdue/,
    )
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET'])
    expect(await summary(t, f)).toMatchObject({ writable: true, cancel_at_period_end: false })

    // one already set to end, in Polar's portal, is recorded, and editing
    // pauses at once, as the guide says
    polar({
      list: () => [
        remote(f.org.id, { status: 'past_due', cancel_at_period_end: true, modified_at: at(0.01) }),
      ],
    })
    const result = await as(t, f.admin).action(api.billingActions.cancelSubscription, {
      org_id: f.org.id,
    })
    expect(result.ends_at).toBe(END)
    expect(await summary(t, f)).toMatchObject({
      status: 'past_due',
      cancel_at_period_end: true,
      writable: false,
    })
  })

  it.each([
    ['an unpaid subscription', [{ status: 'unpaid' }]],
    // the renewing one is listed first, so nothing may be cancelled before the check
    ['a paused one beside a renewing one', [{}, { id: replacementId, status: 'paused' }]],
  ] as const)(
    'refuses %s, which Polar cannot end at period end, before cancelling anything',
    async (_, subscriptions) => {
      const { t, f } = await billed()
      await applied(t, remote(f.org.id))
      const fetchMock = polar({
        list: () => subscriptions.map((fields) => remote(f.org.id, fields)),
        cancel: () => remote(f.org.id, { cancel_at_period_end: true, modified_at: at(0.01) }),
      })
      await expectRefusal(
        as(t, f.admin).action(api.billingActions.cancelSubscription, { org_id: f.org.id }),
        'rule',
        /cannot be cancelled here/,
      )
      expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET'])
      expect(await summary(t, f)).toMatchObject({ cancel_at_period_end: false })
    },
  )

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

  it('records a deletion notice still unsent after its last hourly attempt for the operator', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, { cancel_at_period_end: true }))
    vi.setSystemTime(ended - 8 * DAY)
    await exportNow(t, f)
    await periodOver(t, f.org.id)
    const [notice] = await deletionNotices(t)
    vi.stubEnv('LETTERMINT_API_KEY', '')
    const unsent = () =>
      t.run(async (ctx) =>
        (await ctx.db.query('platform_audit_log').collect()).filter(
          (row) => row.action === 'notice_email_unsent',
        ),
      )
    await t.action(internal.orgRemovals.sendNotice, { notice_key: notice.key, attempt: 23 })
    expect(await unsent()).toEqual([])
    await t.action(internal.orgRemovals.sendNotice, { notice_key: notice.key, attempt: 24 })
    expect(
      (await unsent()).map((row) => [row.target_org_id, row.target_profile_id, row.detail]),
    ).toEqual([
      [f.org.id, f.admin.id, { kind: notice.kind, attempts: 25, reason: 'out_of_attempts' }],
    ])
  })

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

  it('stops the deletion when complimentary access is granted again', async () => {
    const { t, f, operator } = await billed()
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    const until = (await as(t, f.admin).query(api.billing.summary, { org_id: f.org.id }))
      .complimentary_until!
    vi.setSystemTime(Date.parse(until) + 60_000)
    await exportNow(t, f)
    await t.mutation(internal.orgRemovals.sweep, {})
    await runSteps(t)
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'service_ended', ended_at: until })
    await expectRefusal(createTask(t, f.admin, f.org.id, f.sub.id), 'forbidden')

    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    expect(await removalOf(t, f.org.id)).toBeNull()
    await createTask(t, f.admin, f.org.id, f.sub.id)
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
      // read-message sweep rows, one of the other organization's
      for (const profile_id of [f.admin.id, f.user.id, f.otherAdmin.id])
        await ctx.db.insert('message_sweeps', { profile_id, due_at: NOW })
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
    expect(await fileState(t, storage)).toBe('held')
    expect(await orgRows(t, f.otherOrg.id)).toEqual(others)
    const sweeps = await t.run((ctx) => ctx.db.query('message_sweeps').collect())
    expect(sweeps.map((row) => row.profile_id)).toEqual([f.otherAdmin.id])
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

  const hourlySweep = (t: T) => t.mutation(internal.orgRemovals.sweep, {})
  it.each([
    // the sweep reads every waiting removal while billing is off
    ['the hourly sweep before the date', 1, hourlySweep],
    ['the hourly sweep after the date', 30, hourlySweep],
    [
      'the start of deletion',
      30,
      (t: T, orgId: string) => t.action(internal.orgRemovals.begin, { org_id: orgId }),
    ],
  ])('stops a billing deletion when billing is switched off, seen by %s', async (_, day, run) => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'service_ended' })
    vi.setSystemTime(Date.parse(at(day)) + 60_000)
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

  /* Moves the organization to the safety pass at `due`, runs `check`, and
   * answers its due time and the reconciliations waiting to run. */
  const marksDue = async (t: T, orgId: string, due: string, check: () => Promise<unknown>) => {
    const row = () =>
      t.run((ctx) =>
        ctx.db
          .query('billing_subscriptions')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .unique(),
      )
    const id = (await row())!._id
    await t.run((ctx) => ctx.db.patch(id, { sync_due_at: due, sync_safety: true }))
    await check()
    const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    return {
      due: (await row())?.sync_due_at,
      queued: jobs.filter(
        (job) => job.name === 'billingSync:reconcile' && job.state.kind === 'pending',
      ).length,
    }
  }

  it('asks to reconcile a live Polar subscription Qivo has not applied at the checkout deadline', async () => {
    const { t, f } = await billed()
    polar({ list: () => [remote(f.org.id)] })
    vi.setSystemTime(Date.parse(at(3)) + 60_000)
    expect(
      await marksDue(t, f.org.id, at(9), () =>
        t.action(internal.orgRemovals.verifyNoCheckout, { org_id: f.org.id }),
      ),
    ).toEqual({ due: new Date(Date.now()).toISOString(), queued: 1 })
  })

  it('asks to reconcile a live Polar subscription Qivo has not applied on the deletion date', async () => {
    const { t, f } = await billed()
    await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    polar({ list: () => [remote(f.org.id, { id: replacementId, current_period_end: at(59) })] })
    expect(
      await marksDue(t, f.org.id, at(40), () =>
        t.action(internal.orgRemovals.begin, { org_id: f.org.id }),
      ),
    ).toEqual({ due: new Date(Date.now()).toISOString(), queued: 1 })
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
    const snapshot = await workspaceOf(as(t, f.admin))
    expect(snapshot?.orgs.map((org) => org.id)).toEqual([f.otherOrg.id])
    await expectRefusal(
      as(t, f.admin).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /being deleted/,
    )
  })
})

describe('calls through access a running deletion has deleted', () => {
  type Http = { fetch(path: string, init: object): Promise<Response> }
  const call = (
    t: T,
    path: string,
    secret: string,
    init: { method?: string; body?: string } = {},
  ) =>
    (t as unknown as Http).fetch(path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: init.body,
    })
  const answer = async (response: Response) => [response.status, JSON.parse(await response.text())]
  const toolsList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  const DELETING = { error: 'this organization is being deleted' }

  /* Creates an organization as `profile`'s login, through a session of its
   * own, which createOrganization reads (authComponent.getAuthUser). */
  async function createOrg(t: T, profile: Doc<'profiles'>) {
    const subject = profile.auth_user_id as string
    const now = Date.now()
    const session = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'session',
        data: {
          token: uuid(),
          userId: subject,
          expiresAt: now + 3_600_000,
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    return t
      .withIdentity({ subject, sessionId: session._id as string })
      .mutation(api.identity.createOrganization, { name: 'Next' })
  }

  /* An organization whose deletion has begun, with a working personal token
   * of `user`, a revoked one, and a working key of its agent. */
  async function deleting() {
    const { t, f } = await unbilled()
    const secrets = {
      token: `qvt_${'live'.repeat(10)}`,
      revoked: `qvt_${'gone'.repeat(10)}`,
      key: `qva_${'live'.repeat(10)}`,
    }
    let keyOwner: EventOwner | undefined
    await t.run(async (ctx) => {
      for (const [name, revoked_at] of [
        ['token', undefined],
        ['revoked', NOW],
      ] as const)
        await ctx.db.insert('mcp_tokens', {
          id: uuid(),
          profile_id: f.user.id,
          name,
          token_prefix: secrets[name].slice(0, 11),
          token_hash: await sha256hex(secrets[name]),
          access: 'write',
          created_at: NOW,
          revoked_at,
        })
      const keyId = uuid()
      const keyRow = await ctx.db.insert('agent_keys', {
        id: keyId,
        profile_id: f.agent.id,
        name: 'Relay key',
        key_prefix: secrets.key.slice(0, 11),
        key_hash: await sha256hex(secrets.key),
        created_at: NOW,
      })
      keyOwner = {
        profile_id: f.agent.id,
        credential_table: 'agent_keys',
        credential_id: keyId,
        credential_row_id: keyRow,
      }
      await ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      })
    })
    const step = () => t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
    const profileGone = (profile: Doc<'profiles'>) =>
      t.run(async (ctx) => (await ctx.db.get(profile._id)) === null)
    if (!keyOwner) throw new Error('the agent key was not planted')
    return { t, f, secrets, keyOwner, step, profileGone }
  }

  it('tell a deleted member, token and key that the organization is being deleted, until it is gone', async () => {
    const { t, f, secrets, keyOwner, step, profileGone } = await deleting()
    // webhook management refuses as every other call, before the deletion
    // reaches anyone
    expect(await answer(await call(t, '/v1/webhooks', secrets.token))).toEqual([403, DELETING])
    // small steps, so the deletion stops between the profiles it deletes
    REMOVAL_BUDGET.rows = 4
    for (let i = 0; i < 100 && !((await profileGone(f.user)) && (await profileGone(f.agent))); i++)
      await step()
    expect(await profileGone(f.user)).toBe(true)
    expect(await profileGone(f.agent)).toBe(true)
    expect(await removalOf(t, f.org.id)).not.toBeNull()

    // the app: the deleted member learns why, a stranger learns nothing
    await expectRefusal(
      as(t, f.user).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /^this organization is being deleted$/,
    )
    await expectRefusal(
      as(t, f.otherAdmin).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /^no profile in this organization$/,
    )
    // REST and MCP refuse the deleted token and key as every call into the
    // organization; a token revoked before is no more than unknown
    expect(await answer(await call(t, '/v1/me', secrets.token))).toEqual([403, DELETING])
    expect(await answer(await call(t, '/v1/me', secrets.key))).toEqual([403, DELETING])
    const mcp = (secret: string) => call(t, '/mcp', secret, { method: 'POST', body: toolsList })
    expect(await answer(await mcp(secrets.token))).toEqual([403, DELETING])
    expect(await answer(await mcp(secrets.key))).toEqual([403, DELETING])
    expect(await answer(await call(t, '/v1/me', secrets.revoked))).toEqual([
      401,
      { error: 'unknown personal access token' },
    ])
    // a call whose lookup the deletion overtook, before its dispatch, and
    // the deleted key's webhooks
    await expectRefusal(
      t.run((ctx) => asMachineCaller(ctx, f.agent.id, 'read')),
      'forbidden',
      /^this organization is being deleted$/,
    )
    await expectRefusal(
      t.query(internal.webhooks.list, { owner: keyOwner }),
      'forbidden',
      /^this organization is being deleted$/,
    )

    // the deletion's last step deletes what it recorded with the organization
    REMOVAL_BUDGET.rows = 256
    await runSteps(t)
    expect(await removalOf(t, f.org.id)).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('removed_access').collect())).toEqual([])
    await expectRefusal(
      as(t, f.user).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /^no profile in this organization$/,
    )
    expect(await answer(await call(t, '/v1/me', secrets.token))).toEqual([
      401,
      { error: 'unknown personal access token' },
    ])
  })

  it('keep telling them until the organization is gone, also when its last steps take several', async () => {
    const { t, f, secrets, step, profileGone } = await deleting()
    REMOVAL_BUDGET.rows = 4
    for (let i = 0; i < 100 && !((await profileGone(f.user)) && (await profileGone(f.agent))); i++)
      await step()
    const orgThere = () =>
      t.run(
        async (ctx) =>
          (await ctx.db
            .query('organizations')
            .withIndex('by_uuid', (q) => q.eq('id', f.org.id))
            .unique()) !== null,
      )
    const answers = async () => ({
      token: await answer(await call(t, '/v1/me', secrets.token)),
      key: await answer(await call(t, '/v1/me', secrets.key)),
      app: await as(t, f.user)
        .query(api.billing.status, { org_id: f.org.id })
        .then(
          () => 'answered',
          (error: unknown) => (error as { data?: { message?: string } }).data?.message,
        ),
    })
    const refused = {
      token: [403, DELETING],
      key: [403, DELETING],
      app: 'this organization is being deleted',
    }
    const after = {
      token: [401, { error: 'unknown personal access token' }],
      key: [401, { error: 'unknown agent key' }],
      app: 'no profile in this organization',
    }
    // two rows a step, so the recorded access outlasts several steps
    REMOVAL_BUDGET.rows = 2
    let steps = 0
    while ((await removalOf(t, f.org.id)) !== null && steps < 500) {
      await step()
      steps += 1
      expect(await answers()).toEqual((await orgThere()) ? refused : after)
    }
    expect(await removalOf(t, f.org.id)).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('removed_access').collect())).toEqual([])
  })

  it('tell a call whose credential the deletion deleted between its lookup and its stamp', async () => {
    const handler = touchCredential as unknown as {
      _handler: (ctx: MutationCtx, args: { table: string }) => Promise<unknown>
    }
    const original = handler._handler
    // the deletion's step runs between the two and deletes the credential,
    // recording it, or it went another way, unrecorded, as at a revocation
    let recorded: string[] = []
    vi.spyOn(handler, '_handler').mockImplementation(async (ctx, args) => {
      const agent = args.table === 'agent_keys'
      // every fixture of deleting() plants the same secrets
      const hash = await sha256hex(agent ? `qva_${'live'.repeat(10)}` : `qvt_${'live'.repeat(10)}`)
      const row = agent
        ? await ctx.db
            .query('agent_keys')
            .withIndex('by_hash', (q) => q.eq('key_hash', hash))
            .first()
        : await ctx.db
            .query('mcp_tokens')
            .withIndex('by_hash', (q) => q.eq('token_hash', hash))
            .first()
      if (row) {
        await ctx.db.delete(row._id)
        const owner = await ctx.db
          .query('profiles')
          .withIndex('by_uuid', (q) => q.eq('id', row.profile_id))
          .unique()
        if (recorded.includes(args.table) && owner)
          await ctx.db.insert('removed_access', {
            org_id: owner.org_id,
            kind: agent ? 'agent_keys' : 'mcp_tokens',
            key: hash,
          })
      }
      return original(ctx, args)
    })
    const mcp = (t: T, secret: string) =>
      call(t, '/mcp', secret, { method: 'POST', body: toolsList })
    recorded = ['agent_keys', 'mcp_tokens']
    const one = await deleting()
    expect(await answer(await call(one.t, '/v1/me', one.secrets.token))).toEqual([403, DELETING])
    expect(await answer(await mcp(one.t, one.secrets.key))).toEqual([403, DELETING])
    // the webhook routes stamp the same way; without the deletion's record,
    // a credential gone meanwhile stays gone
    recorded = ['agent_keys']
    const two = await deleting()
    expect(await answer(await call(two.t, '/v1/webhooks', two.secrets.key))).toEqual([
      403,
      DELETING,
    ])
    expect(await answer(await call(two.t, '/v1/webhooks', two.secrets.token))).toEqual([
      401,
      { error: 'Webhook credential is no longer valid' },
    ])
  })

  it("leave a banned login's personal token unknown once the deletion deletes it", async () => {
    const { t, f, secrets, step, profileGone } = await deleting()
    await t.mutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'user',
        where: [{ field: '_id', value: f.user.auth_user_id as string }],
        update: { banned: true },
      },
    })
    expect(await answer(await call(t, '/v1/me', secrets.token))).toEqual([
      401,
      { error: 'this account has been deactivated' },
    ])
    REMOVAL_BUDGET.rows = 4
    for (let i = 0; i < 100 && !(await profileGone(f.user)); i++) await step()
    expect(await removalOf(t, f.org.id)).not.toBeNull()
    expect(await answer(await call(t, '/v1/me', secrets.token))).toEqual([
      401,
      { error: 'unknown personal access token' },
    ])
  })

  it("tell the app's root part why a login has no seat while the deletion holds it", async () => {
    const { t, f, step, profileGone } = await deleting()
    const root = () => as(t, f.user).query(api.workspace.root, {})
    const create = () => createOrg(t, f.user)
    // the home seat still stands, so no new organization yet
    expect(await root()).toEqual({ deleting: true, create: 'after_deletion' })
    await expectRefusal(create(), 'rule', /^you already belong to an organization$/)
    REMOVAL_BUDGET.rows = 4
    for (let i = 0; i < 100 && !(await profileGone(f.user)); i++) await step()
    expect(await removalOf(t, f.org.id)).not.toBeNull()
    // then the deletion's record of it, and a new organization may follow
    expect(await root()).toEqual({ deleting: true, create: 'now' })
    // a member of another organization still gets that one
    expect(await as(t, f.otherAdmin).query(api.workspace.root, {})).toMatchObject({
      orgs: [expect.objectContaining({ id: expect.not.stringMatching(f.org.id) })],
    })
    REMOVAL_BUDGET.rows = 256
    await runSteps(t)
    expect(await removalOf(t, f.org.id)).toBeNull()
    expect(await root()).toBeNull()
  })

  /* The other organization's admin, deactivated there, holds a seat in the
   * organization being deleted: a guest's, or a home seat of its own that
   * an admin's promotion of the guest made, newer than the first. */
  for (const role of ['guest', 'user'] as const) {
    it(`offer no new organization to a ${role} whose home seat another organization holds`, async () => {
      const { t, f } = await deleting()
      const { _id, _creationTime, ...home } = f.otherAdmin
      await t.run(async (ctx) => {
        await ctx.db.patch(_id, { active: false })
        await ctx.db.insert('profiles', {
          ...home,
          id: uuid(),
          org_id: f.org.id,
          org_role: role,
          active: true,
        })
      })
      expect(await as(t, f.otherAdmin).query(api.workspace.root, {})).toEqual({
        deleting: true,
        create: 'blocked',
      })
      await expectRefusal(
        createOrg(t, f.otherAdmin),
        'rule',
        /^you already belong to an organization$/,
      )
    })
  }

  it('let a guest whose only seat is in the organization being deleted create one at once', async () => {
    const { t, f } = await deleting()
    expect(await as(t, f.guest).query(api.workspace.root, {})).toEqual({
      deleting: true,
      create: 'now',
    })
    expect(typeof (await createOrg(t, f.guest))).toBe('string')
  })

  it('tell a deactivated member and their token the same before the deletion reaches them', async () => {
    const { t, f, secrets } = await deleting()
    await t.run((ctx) => ctx.db.patch(f.user._id, { active: false }))
    await expectRefusal(
      as(t, f.user).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /^this organization is being deleted$/,
    )
    expect(await answer(await call(t, '/v1/me', secrets.token))).toEqual([403, DELETING])
    // without the deletion they stay a deactivated member and token
    await t.run(async (ctx) => {
      const removal = await ctx.db
        .query('org_removals')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      await ctx.db.delete(removal!._id)
    })
    await expectRefusal(
      as(t, f.user).query(api.billing.status, { org_id: f.org.id }),
      'forbidden',
      /^no profile in this organization$/,
    )
    expect(await answer(await call(t, '/v1/me', secrets.token))).toEqual([
      401,
      { error: 'this account has been deactivated' },
    ])
  })
})

describe('when the hourly sweep next reads a subscription', () => {
  /* A small fixed-seed generator, so a failure names the same case again. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }

  it('falls due exactly when the service ends or the checkout deadline passes', () => {
    const next = rng(7)
    const pick = <V>(values: readonly V[]): V => values[Math.floor(next() * values.length)]
    const times = [undefined, at(-40), at(-8), at(-1), at(0), at(0.5), at(1), at(6), at(30)]
    const statuses = ['pending', 'active', 'trialing', 'past_due', 'canceled', 'unpaid'] as const
    for (let i = 0; i < 2_000; i++) {
      const sub = subscription({
        status: pick(statuses),
        ended_at: pick(times),
        current_period_end: pick(times),
        cancel_at_period_end: next() < 0.3,
        past_due_at: pick(times),
        complimentary_until: pick(times),
        checkout_due_at: pick(times),
        polar_subscription_id: next() < 0.3 ? providerId : undefined,
        updated_at: at(-2),
        created_at: at(-50),
      })
      const due = retentionDue(sub)
      const probes = [at(-60), at(60), ...times.filter((time) => time !== undefined)].flatMap(
        (time) => [-1, 0, 1].map((ms) => Date.parse(time) + ms),
      )
      // a row has no due time before it was written
      const after = probes.filter((now) => now >= Date.parse(sub.created_at))
      for (const now of [...after, ...[DAY, 7 * DAY].map((ms) => Date.parse(at(30)) + ms)])
        expect(
          serviceEndedAt(sub, now) !== null || noCheckoutDue(sub, now),
          JSON.stringify({ sub, now: new Date(now).toISOString(), due }),
        ).toBe(due !== null && now >= Date.parse(due))
    }
  })

  it('is never later than a checkout deadline that waits for a checkout being prepared', () => {
    const sub = subscription({ checkout_due_at: at(-1), checkout_lock_until: at(0.001) })
    expect(noCheckoutDue(sub)).toBe(false)
    expect(retentionDue(sub)).toBe(at(-1))
  })

  it('is stored by every write that can end a service or a checkout deadline', async () => {
    const { t, f, operator } = await billed()
    await t.run((ctx) => enrollOrganization(ctx, f.otherOrg.id))
    const inStep = async (orgId: string) => {
      const sub = await t.run((ctx) =>
        ctx.db
          .query('billing_subscriptions')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .unique(),
      )
      expect(sub?.retention_at).toBe(retentionDue(sub!))
      return sub?.retention_at
    }
    expect(await inStep(f.org.id)).toBe(at(3))
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    expect(await inStep(f.org.id)).toBe(at(30))

    const other = f.otherOrg.id
    expect(await inStep(other)).toBe(at(3))
    // a paid period that lapses waits for Polar to say the subscription ended
    await applied(t, remote(other))
    expect(await inStep(other)).toBeNull()
    const cancelled = { status: 'canceled', cancel_at_period_end: true }
    await applied(t, remote(other, { ...cancelled, modified_at: at(1) }))
    expect(await inStep(other)).toBe(END)
    await applied(t, remote(other, { ...cancelled, ended_at: at(2), modified_at: at(2) }))
    expect(await inStep(other)).toBe(at(2))
  })
})

describe('the hourly sweep', () => {
  /* How many sweep legs have run so far: the one a test starts and those
   * each leg scheduled. With SWEEP_PAGES at 1 a leg reads at most one row of
   * its lane. */
  const legs = async (t: T, run: () => Promise<unknown>) => {
    const scheduled = () =>
      t.run(
        async (ctx) =>
          (await ctx.db.system.query('_scheduled_functions').collect()).filter(
            (job) => job.name === 'orgRemovals:sweep',
          ).length,
      )
    const before = await scheduled()
    await run()
    await runSteps(t)
    return 1 + (await scheduled()) - before
  }
  const sweepRun = (t: T) => () => t.mutation(internal.orgRemovals.sweep, {})

  it('reads only the organizations that are due, one page at a time', async () => {
    const { t, f, operator } = await billed()
    // complimentary access that runs out, and a cancellation at the period
    // end, both without any webhook
    await operator.mutation(grant, { org_id: f.org.id, months: 1 })
    await t.run((ctx) => enrollOrganization(ctx, f.otherOrg.id))
    await applied(
      t,
      remote(f.otherOrg.id, {
        status: 'canceled',
        cancel_at_period_end: true,
        current_period_end: at(20),
      }),
    )
    // 30 organizations with nothing due, enrolled before billing started
    vi.stubEnv('BILLING_ENABLED', 'false')
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        const org_id = uuid()
        await ctx.db.insert('organizations', {
          ...f.org,
          _id: undefined,
          _creationTime: undefined,
          id: org_id,
          slug: `quiet-${i}`,
        } as never)
        await enrollOrganization(ctx, org_id)
      }
    })
    vi.stubEnv('BILLING_ENABLED', 'true')
    await t.run(async (ctx) => {
      for (const org of await ctx.db.query('organizations').collect())
        await ctx.db.patch(org._id, { last_export_at: NOW })
    })
    SWEEP_PAGES.removals = 1
    SWEEP_PAGES.subscriptions = 1

    vi.setSystemTime(Date.parse(at(20)) - 60_000)
    expect(await legs(t, sweepRun(t))).toBe(1)
    expect(await removalOf(t, f.otherOrg.id)).toBeNull()

    vi.setSystemTime(Date.parse(at(30)) + 59 * 60_000)
    // the empty removals lane, then one leg for each due subscription
    expect(await legs(t, sweepRun(t))).toBe(3)
    expect(await removalOf(t, f.org.id)).toMatchObject({
      reason: 'service_ended',
      ended_at: at(30),
    })
    expect(await removalOf(t, f.otherOrg.id)).toMatchObject({ reason: 'service_ended' })
    // an hour with nothing due is one call
    expect(await legs(t, sweepRun(t))).toBe(1)

    polar({ list: () => [] })
    const date = (await removalOf(t, f.otherOrg.id))!.delete_after
    vi.setSystemTime(Date.parse(date) + 60 * 60_000)
    await legs(t, sweepRun(t))
    for (const org of [f.org, f.otherOrg]) {
      expect(await removalOf(t, org.id)).toBeNull()
      expect((await orgRows(t, org.id)).profiles).toBe(0)
    }
    expect(await t.run((ctx) => ctx.db.query('billing_subscriptions').collect())).toHaveLength(30)
  })

  it('reads and fills in the rows written before the due time existed', async () => {
    const { t, f } = await billed()
    await t.run(async (ctx) => {
      await enrollOrganization(ctx, f.otherOrg.id)
      for (const sub of await ctx.db.query('billing_subscriptions').collect())
        await ctx.db.patch(sub._id, {
          retention_at: undefined,
          ...(sub.org_id === f.org.id ? { complimentary_until: at(-1) } : {}),
        })
      for (const org of await ctx.db.query('organizations').collect())
        await ctx.db.patch(org._id, { last_export_at: NOW })
    })
    SWEEP_PAGES.subscriptions = 1
    expect(await legs(t, sweepRun(t))).toBeGreaterThanOrEqual(3)
    expect(await removalOf(t, f.org.id)).toMatchObject({
      reason: 'service_ended',
      ended_at: at(-1),
    })
    expect(await removalOf(t, f.otherOrg.id)).toBeNull()
    const rows = await t.run((ctx) => ctx.db.query('billing_subscriptions').collect())
    expect(Object.fromEntries(rows.map((sub) => [sub.org_id, sub.retention_at]))).toEqual({
      [f.org.id]: at(30),
      [f.otherOrg.id]: at(3),
    })
    expect(await legs(t, sweepRun(t))).toBe(1)
  })

  it('reads a subscription again once its removal stops', async () => {
    const { t, f } = await billed()
    await exportNow(t, f)
    await applied(t, remote(f.org.id, { status: 'canceled', ended_at: NOW }))
    await legs(t, sweepRun(t))
    const sub = () =>
      t.run((ctx) =>
        ctx.db
          .query('billing_subscriptions')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .unique(),
      )
    expect((await sub())?.retention_at).toBe(at(30))
    // Polar shows a live subscription on the date that Qivo has not applied
    vi.setSystemTime(Date.parse(at(30)) + 60_000)
    polar({ list: () => [remote(f.org.id, { id: replacementId, current_period_end: at(59) })] })
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    expect(await removalOf(t, f.org.id)).toBeNull()
    expect((await sub())?.retention_at).toBe(NOW)
    // while Polar cannot answer the reconciliation, the next run starts the
    // period again, as before due times existed
    polar({})
    await legs(t, sweepRun(t))
    expect(await removalOf(t, f.org.id)).toMatchObject({ reason: 'service_ended' })
  })

  it('stops a leg that an earlier release queued', async () => {
    const { t } = await billed()
    await t.mutation(internal.orgRemovals.sweep, { phase: 'subscriptions', cursor: 'old' })
    expect(await legs(t, async () => {})).toBe(1)
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
