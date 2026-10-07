import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import { subscriptionFor } from '../lib/billingAccess'
import { billingSummary, enrollOrganization } from '../model/billing'
import { deleteOrgDeep, removeProfile } from '../model/cascade'
import { as, expectRefusal, newT, plantIssue, uuid, withOrg } from './helpers.setup'

const NOW = '2026-09-20T12:00:00.000Z'
const EXPIRED = '2026-09-20T11:59:59.000Z'
const FUTURE = '2026-09-20T13:00:00.000Z'
const UNTIL = '2026-09-25T12:00:00.000Z'
const grant = makeFunctionReference<'mutation', { org_id: string; months: number }, null>(
  'adminBilling:grantComplimentary',
)
const assign = makeFunctionReference<'mutation', { org_id: string; plan_id: string }, null>(
  'adminBilling:assignPlan',
)
const clearEndedCheckout = makeFunctionReference<
  'mutation',
  { org_id: string; checkout_id: string },
  null
>('billingActions:clearEndedCheckout')
const ready = makeFunctionReference<
  'query',
  { key: string },
  { to: string; url: string; until: string } | null
>('billingMail:ready')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('BILLING_ENABLED', 'true')
  vi.stubEnv('APP_MODE', '')
  vi.stubEnv('SITE_URL', 'https://qivo.test')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function fixture() {
  const t = newT()
  const f = await withOrg(t)
  const operatorId = 'recovery-operator'
  const { sub, newerPlanId } = await t.run(async (ctx) => {
    await ctx.db.insert('platform_admins', {
      auth_user_id: operatorId,
      note: 'test recovery',
      created_at: NOW,
    })
    const terms = {
      name: 'Founding',
      currency: 'usd',
      seat_price_cents: 100,
      minimum_seats: 5,
      storage_gb_per_seat: 1,
      minimum_storage_gb: 5,
      api_calls_per_seat: 25_000,
      api_block_size: 25_000,
      api_block_price_cents: 100,
      storage_block_price_cents: 100,
      archived: false,
      created_at: NOW,
    }
    const planId = uuid()
    const newerPlanId = uuid()
    await ctx.db.insert('billing_plans', { id: planId, ...terms })
    await ctx.db.insert('billing_plans', {
      id: newerPlanId,
      ...terms,
      name: 'Standard',
      seat_price_cents: 200,
    })
    return { sub: (await enrollOrganization(ctx, f.org.id, planId))!, newerPlanId }
  })
  return { t, f, sub, newerPlanId, operator: t.withIdentity({ subject: operatorId }) }
}

describe('billing recovery', () => {
  it('cleans unpaid organization billing rows without deleting shared or foreign accounting', async () => {
    const { t, f, sub } = await fixture()
    await t.run(async (ctx) => {
      await enrollOrganization(ctx, f.otherOrg.id, sub.plan_id)
      await ctx.db.insert('billing_settings', { key: 'default', default_plan_id: sub.plan_id })
      await ctx.db.insert('machine_rate_limits', { key: 'ingress', window_start: 0, count: 1 })
      for (const profile of [f.agent, f.otherAdmin]) {
        await ctx.db.insert('machine_rate_limits', {
          key: `profile:${profile.id}`,
          window_start: 0,
          count: 1,
        })
        await ctx.db.insert('billing_periods', {
          org_id: profile.org_id,
          subscription_id: `fixture:${profile.org_id}`,
          plan_id: sub.plan_id,
          period_start: NOW,
          period_end: FUTURE,
          seats: 5,
          profile_ids: [profile.id],
          storage_bytes: 0,
          storage_blocks: 0,
          created_at: NOW,
        })
        await ctx.db.insert('billing_usage', {
          org_id: profile.org_id,
          profile_id: profile.id,
          credential_id: uuid(),
          credential_name: 'Fixture',
          period_start: NOW,
          calls: 1,
        })
        await ctx.db.insert('billing_usage_totals', {
          org_id: profile.org_id,
          period_start: NOW,
          calls: 1,
          reported_api_blocks: 0,
        })
        await ctx.db.insert('billing_events', {
          id: uuid(),
          org_id: profile.org_id,
          kind: 'api',
          period_start: NOW,
          units: 1,
          attempts: 0,
          next_attempt_at: NOW,
          created_at: NOW,
        })
        await ctx.db.insert('billing_notices', {
          key: uuid(),
          org_id: profile.org_id,
          profile_id: profile.id,
          kind: 'expired',
          created_at: NOW,
        })
      }
      await ctx.db.insert('billing_webhooks', {
        event_id: uuid(),
        subscription_id: 'foreign-provider',
        received_at: NOW,
      })
      await deleteOrgDeep(ctx, f.org)
    })
    const remaining = await t.run(async (ctx) => {
      for (const table of [
        'billing_subscriptions',
        'billing_periods',
        'billing_usage',
        'billing_usage_totals',
        'billing_events',
        'billing_notices',
      ] as const) {
        const rows = await ctx.db.query(table).collect()
        expect(rows).toHaveLength(1)
        expect(rows[0].org_id).toBe(f.otherOrg.id)
      }
      return {
        org: await ctx.db.get(f.org._id),
        plans: await ctx.db.query('billing_plans').collect(),
        settings: await ctx.db.query('billing_settings').collect(),
        webhooks: await ctx.db.query('billing_webhooks').collect(),
        rateKeys: (await ctx.db.query('machine_rate_limits').collect()).map((row) => row.key),
      }
    })
    expect(remaining.org).toBeNull()
    expect(remaining.plans).toHaveLength(2)
    expect(remaining.settings).toHaveLength(1)
    expect(remaining.webhooks).toHaveLength(1)
    expect(remaining.rateKeys.sort()).toEqual(['ingress', `profile:${f.otherAdmin.id}`].sort())
  })

  it('refuses org deletion with provider accounting or an unresolved checkout', async () => {
    const { t, f, sub } = await fixture()
    for (const state of [
      { polar_subscription_id: uuid() },
      { checkout_id: uuid(), checkout_expires_at: EXPIRED },
      { checkout_lock: uuid(), checkout_lock_until: FUTURE },
    ]) {
      await t.run((ctx) =>
        ctx.db.patch(sub._id, {
          polar_subscription_id: undefined,
          checkout_id: undefined,
          checkout_lock: undefined,
          checkout_lock_until: undefined,
          ...state,
        }),
      )
      await expectRefusal(
        t.run((ctx) => deleteOrgDeep(ctx, f.org)),
        'rule',
      )
      expect(await t.run((ctx) => ctx.db.get(f.org._id))).not.toBeNull()
      expect(await t.run((ctx) => ctx.db.get(sub._id))).not.toBeNull()
    }
  })

  it('removes a departed profile rate window while preserving usage owed by its organization', async () => {
    const { t, f } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.insert('machine_rate_limits', {
        key: `profile:${f.agent.id}`,
        window_start: 0,
        count: 1,
      })
      await ctx.db.insert('billing_usage', {
        org_id: f.org.id,
        profile_id: f.agent.id,
        credential_id: uuid(),
        credential_name: 'Departed agent',
        period_start: NOW,
        calls: 30_000,
      })
      await removeProfile(ctx, { profile: f.agent, now: NOW })
    })
    expect(await t.run((ctx) => ctx.db.query('machine_rate_limits').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('billing_usage').collect())).toMatchObject([
      { org_id: f.org.id, profile_id: f.agent.id, calls: 30_000 },
    ])
  })

  it('refuses roadmap edits and undo after the organization becomes read-only', async () => {
    const { t, f, sub } = await fixture()
    const admin = as(t, f.admin)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const milestoneId = uuid()
    const sessionId = uuid()
    await t.run((ctx) => ctx.db.patch(sub._id, { complimentary_until: FUTURE }))
    await admin.mutation(api.roadmap.change, {
      session_id: sessionId,
      operations: [
        {
          kind: 'task',
          id: task.id,
          patch: { start_week: '2026-09-21', end_week: '2026-09-21' },
        },
        {
          kind: 'milestone_create',
          id: milestoneId,
          project_id: f.sub.id,
          name: 'Paid milestone',
          week: '2026-09-21',
        },
      ],
    })
    await t.run((ctx) => ctx.db.patch(sub._id, { complimentary_until: NOW }))
    await expectRefusal(
      admin.mutation(api.roadmap.change, {
        session_id: sessionId,
        operations: [{ kind: 'task', id: task.id, patch: { end_week: '2026-09-28' } }],
      }),
      'forbidden',
      /read-only/,
    )
    await expectRefusal(
      admin.mutation(api.roadmap.change, {
        session_id: sessionId,
        operations: [{ kind: 'milestone_remove', id: milestoneId }],
      }),
      'forbidden',
      /read-only/,
    )
    for (const all of [false, true])
      await expectRefusal(
        admin.mutation(api.roadmap.undo, { session_id: sessionId, all }),
        'forbidden',
        /read-only/,
      )
    expect(await t.run((ctx) => ctx.db.get(task._id))).toMatchObject({
      start_week: '2026-09-21',
      end_week: '2026-09-21',
    })
    expect(await t.run((ctx) => ctx.db.query('milestones').collect())).toMatchObject([
      { id: milestoneId },
    ])
  })

  it('unlocks abandoned preparation leases for operator recovery', async () => {
    const { t, f, sub, newerPlanId, operator } = await fixture()
    const abandoned = {
      checkout_lock: uuid(),
      checkout_lock_until: EXPIRED,
    }
    await t.run((ctx) => ctx.db.patch(sub._id, abandoned))
    expect(await t.run((ctx) => billingSummary(ctx, f.org.id))).toMatchObject({
      can_assign_plan: true,
      can_grant_complimentary: true,
    })
    await operator.mutation(assign, { org_id: f.org.id, plan_id: newerPlanId })
    let current = await t.run((ctx) => subscriptionFor(ctx, f.org.id))
    expect(current?.plan_id).toBe(newerPlanId)
    expect(current).not.toHaveProperty('checkout_id')
    expect(current).not.toHaveProperty('checkout_lock')

    await t.run((ctx) => ctx.db.patch(sub._id, abandoned))
    await operator.mutation(grant, { org_id: f.org.id, months: 6 })
    current = await t.run((ctx) => subscriptionFor(ctx, f.org.id))
    expect(current?.complimentary_until).toBe('2027-03-20T12:00:00.000Z')
    expect(current).not.toHaveProperty('checkout_id')
    expect(current).not.toHaveProperty('checkout_lock')
  })

  it('retains cached checkout fences after local expiry and keeps live or undated leases locked', async () => {
    const { t, f, sub, newerPlanId, operator } = await fixture()
    for (const state of [
      { checkout_id: uuid(), checkout_expires_at: FUTURE },
      { checkout_id: uuid(), checkout_expires_at: EXPIRED },
      { checkout_id: uuid(), checkout_expires_at: undefined },
      { checkout_lock: uuid(), checkout_lock_until: FUTURE },
      { checkout_lock: uuid(), checkout_lock_until: undefined },
    ]) {
      await t.run((ctx) =>
        ctx.db.patch(sub._id, {
          checkout_id: undefined,
          checkout_expires_at: undefined,
          checkout_lock: undefined,
          checkout_lock_until: undefined,
          ...state,
        }),
      )
      expect(await t.run((ctx) => billingSummary(ctx, f.org.id))).toMatchObject({
        can_assign_plan: false,
        can_grant_complimentary: false,
      })
      await expectRefusal(
        operator.mutation(assign, { org_id: f.org.id, plan_id: newerPlanId }),
        'rule',
        /keeps its assigned plan/,
      )
      await expectRefusal(
        operator.mutation(grant, { org_id: f.org.id, months: 6 }),
        'rule',
        /before checkout/,
      )
    }
  })

  it('allows a free grant only after provider verification clears the same ended checkout', async () => {
    const { t, f, sub, operator } = await fixture()
    const checkoutId = uuid()
    await t.run((ctx) =>
      ctx.db.patch(sub._id, {
        checkout_id: checkoutId,
        checkout_url: 'https://sandbox.polar.sh/checkout/ended',
        checkout_expires_at: EXPIRED,
      }),
    )
    // A stale provider response cannot clear a replacement checkout session.
    await t.mutation(clearEndedCheckout, { org_id: f.org.id, checkout_id: uuid() })
    await expectRefusal(
      operator.mutation(grant, { org_id: f.org.id, months: 6 }),
      'rule',
      /before checkout/,
    )
    await t.mutation(clearEndedCheckout, { org_id: f.org.id, checkout_id: checkoutId })
    expect(await t.run((ctx) => billingSummary(ctx, f.org.id))).toMatchObject({
      can_assign_plan: true,
      can_grant_complimentary: true,
    })
    await operator.mutation(grant, { org_id: f.org.id, months: 6 })
    expect((await t.run((ctx) => subscriptionFor(ctx, f.org.id)))?.complimentary_until).toBe(
      '2027-03-20T12:00:00.000Z',
    )
  })

  it('rebuilds reminder delivery from current identity and invalidates extended or paid grants', async () => {
    const { t, f, sub } = await fixture()
    const key = `${sub.id}:${UNTIL}:${f.admin.id}:seven_days`
    await t.run(async (ctx) => {
      await ctx.db.patch(sub._id, { complimentary_until: UNTIL })
      await ctx.db.insert('billing_notices', {
        key,
        org_id: f.org.id,
        profile_id: f.admin.id,
        kind: 'seven_days',
        created_at: NOW,
      })
      await ctx.db.patch(f.admin._id, { email: 'current-admin@testbed.test' })
      await ctx.db.patch(f.org._id, { slug: 'renamed-org' })
    })
    expect(await t.query(ready, { key })).toEqual({
      to: 'current-admin@testbed.test',
      until: UNTIL,
      url: 'https://qivo.test/app/renamed-org/settings/org-billing',
    })
    await t.run((ctx) => ctx.db.patch(sub._id, { complimentary_until: '2027-03-25T12:00:00.000Z' }))
    expect(await t.query(ready, { key })).toBeNull()
    await t.run((ctx) =>
      ctx.db.patch(sub._id, { complimentary_until: UNTIL, polar_subscription_id: uuid() }),
    )
    expect(await t.query(ready, { key })).toBeNull()
  })

  it('discards obsolete reminder thresholds and revoked recipients', async () => {
    const { t, f, sub } = await fixture()
    const key = `${sub.id}:${UNTIL}:${f.admin.id}:seven_days`
    await t.run(async (ctx) => {
      await ctx.db.patch(sub._id, { complimentary_until: UNTIL })
      await ctx.db.insert('billing_notices', {
        key,
        org_id: f.org.id,
        profile_id: f.admin.id,
        kind: 'seven_days',
        created_at: NOW,
      })
    })
    vi.setSystemTime('2026-09-25T00:00:00.000Z')
    expect(await t.query(ready, { key })).toBeNull()
    vi.setSystemTime(NOW)
    await t.run((ctx) => ctx.db.patch(f.admin._id, { org_role: 'user' }))
    expect(await t.query(ready, { key })).toBeNull()
  })

  it('blocks org avatar administration during read-only access and preserves personal recovery', async () => {
    const { t, f } = await fixture()
    const admin = as(t, f.admin)
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob() as never))
    await expectRefusal(
      admin.mutation(api.files.avatarUploadUrl, { profile_id: f.agent.id }),
      'forbidden',
      /read-only/,
    )
    await expectRefusal(
      admin.mutation(api.files.setAvatar, { profile_id: f.agent.id, storage_id: storageId }),
      'forbidden',
      /read-only/,
    )
    await expectRefusal(
      admin.mutation(api.files.clearAvatar, { profile_id: f.agent.id }),
      'forbidden',
      /read-only/,
    )
    await expect(
      admin.mutation(api.files.clearAvatar, { profile_id: f.admin.id }),
    ).resolves.toBeNull()
    await expect(
      as(t, f.user).mutation(api.files.clearAvatar, { profile_id: f.user.id }),
    ).resolves.toBeNull()
  })
})
