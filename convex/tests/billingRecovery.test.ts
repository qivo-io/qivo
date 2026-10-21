import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import { BILLING_READ_ONLY, subscriptionFor } from '../lib/billingAccess'
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

  it('records a reminder still unsent after its last hourly attempt for the operator', async () => {
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
    vi.stubEnv('LETTERMINT_API_KEY', '')
    const unsent = () =>
      t.run(async (ctx) =>
        (await ctx.db.query('platform_audit_log').collect()).filter(
          (row) => row.action === 'notice_email_unsent',
        ),
      )
    const input = { to: 'x', url: 'x', until: UNTIL, notice_key: key }
    await t.action(internal.billingMail.send, { ...input, attempt: 23 })
    expect(await unsent()).toEqual([])
    await t.action(internal.billingMail.send, { ...input, attempt: 24 })
    expect(
      (await unsent()).map((row) => [row.target_org_id, row.target_profile_id, row.detail]),
    ).toEqual([
      [f.org.id, f.admin.id, { kind: 'seven_days', attempts: 25, reason: 'out_of_attempts' }],
    ])
    // a notice delivered meanwhile is not reported
    await t.mutation(internal.billingMail.sent, { key })
    await t.mutation(internal.billingMail.unsent, { key, attempts: 3 })
    expect(await unsent()).toHaveLength(1)
  })

  it('records a reminder that failed and then stopped being due, but not one never tried', async () => {
    const { t, f, sub } = await fixture()
    const key = `${sub.id}:${UNTIL}:${f.admin.id}:one_day`
    await t.run(async (ctx) => {
      await ctx.db.patch(sub._id, { complimentary_until: UNTIL })
      await ctx.db.insert('billing_notices', {
        key,
        org_id: f.org.id,
        profile_id: f.admin.id,
        kind: 'one_day',
        created_at: NOW,
      })
    })
    vi.stubEnv('LETTERMINT_API_KEY', '')
    const unsent = () =>
      t.run(async (ctx) =>
        (await ctx.db.query('platform_audit_log').collect()).filter(
          (row) => row.action === 'notice_email_unsent',
        ),
      )
    const input = { to: 'x', url: 'x', until: UNTIL, notice_key: key }
    // the grant has expired by the time the retries run, so the expired
    // reminder takes over and this one is no longer due
    vi.setSystemTime('2026-09-25T13:00:00.000Z')
    await t.action(internal.billingMail.send, { ...input, attempt: 0 })
    expect(await unsent()).toEqual([])
    await t.action(internal.billingMail.send, { ...input, attempt: 7 })
    expect((await unsent()).map((row) => row.detail)).toEqual([
      { kind: 'one_day', attempts: 7, reason: 'no_longer_due' },
    ])
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

describe('admin actions that take access away during read-only access', () => {
  const REVOKED_HASH = 'a1'.repeat(32)
  const DELETED_HASH = 'b2'.repeat(32)

  /* Two keys for the fixture's agent and a personal token for the user,
   * planted raw because creating them is refused while read-only. */
  async function pausedFixture() {
    const { t, f } = await fixture()
    const ids = { revoked: uuid(), deleted: uuid(), token: uuid() }
    await t.run(async (ctx) => {
      for (const [id, key_hash] of [
        [ids.revoked, REVOKED_HASH],
        [ids.deleted, DELETED_HASH],
      ]) {
        await ctx.db.insert('agent_keys', {
          id,
          profile_id: f.agent.id,
          name: 'Relay key',
          key_prefix: 'qva_0...00000',
          key_hash,
          created_at: NOW,
        })
      }
      await ctx.db.insert('mcp_tokens', {
        id: ids.token,
        profile_id: f.user.id,
        name: 'Laptop',
        token_prefix: 'qvt_0123456',
        token_hash: 'c3'.repeat(32),
        access: 'write',
        created_at: NOW,
      })
    })
    const lookup = (hash: string) =>
      t.query(internal.machine.auth.lookupCredential, { hash, isAgent: true, now: NOW })
    return { t, f, ids, lookup }
  }

  it('lets an admin revoke and delete agent keys, deactivate and remove users', async () => {
    const { t, f, ids, lookup } = await pausedFixture()
    const admin = as(t, f.admin)
    const org_id = f.org.id
    // Reading with the key still works until the admin acts.
    expect(await lookup(REVOKED_HASH)).toMatchObject({ ok: true })
    expect(await admin.mutation(api.tokens.revokeAgentKey, { org_id, id: ids.revoked })).toBe(true)
    expect(await lookup(REVOKED_HASH)).toMatchObject({ ok: false, why: 'revoked' })
    expect(await admin.mutation(api.tokens.deleteAgentKey, { org_id, id: ids.deleted })).toBe(true)
    expect(await lookup(DELETED_HASH)).toMatchObject({ ok: false, why: 'unknown' })
    await admin.mutation(api.profiles.deactivate, { org_id, id: f.agent.id })
    await admin.mutation(api.profiles.remove, { org_id, id: f.viewer.id })
    // A person revokes their own token through a door the pause never gated.
    expect(await as(t, f.user).mutation(api.tokens.revokeMcpToken, { id: ids.token })).toBe(true)
    const after = await t.run(async (ctx) => ({
      agent: await ctx.db.get(f.agent._id),
      viewer: await ctx.db.get(f.viewer._id),
      token: await ctx.db.query('mcp_tokens').first(),
    }))
    expect(after.agent).toMatchObject({ active: false })
    expect(after.viewer).toBeNull()
    expect(after.token?.revoked_at).toBeDefined()
  })

  it('keeps reactivation, other user changes and new keys refused', async () => {
    const { t, f, ids } = await pausedFixture()
    const admin = as(t, f.admin)
    const user = as(t, f.user)
    const org_id = f.org.id
    await admin.mutation(api.profiles.deactivate, { org_id, id: f.agent.id })
    const refused: (() => Promise<unknown>)[] = [
      () =>
        admin.mutation(api.profiles.update, { org_id, id: f.agent.id, patch: { active: true } }),
      () =>
        admin.mutation(api.profiles.update, {
          org_id,
          id: f.user.id,
          patch: { org_role: 'viewer' },
        }),
      // the update door stays gated even for a deactivation
      () =>
        admin.mutation(api.profiles.update, { org_id, id: f.user.id, patch: { active: false } }),
      () =>
        admin.mutation(api.profiles.create, {
          org_id,
          id: uuid(),
          name: 'New Person',
          email: 'new.person@testbed.test',
          org_role: 'user',
          kind: 'person',
          color: '#335577',
        }),
      () =>
        admin.mutation(api.tokens.createAgentKey, {
          org_id,
          id: uuid(),
          agent_id: f.agent.id,
          name: 'Another key',
          key_prefix: 'qva_1...11111',
          key_hash: 'd4'.repeat(32),
        }),
      // a non-admin still meets the billing gate on the protective doors
      () => user.mutation(api.tokens.revokeAgentKey, { org_id, id: ids.revoked }),
      () => user.mutation(api.tokens.deleteAgentKey, { org_id, id: ids.revoked }),
      () => user.mutation(api.profiles.deactivate, { org_id, id: f.viewer.id }),
      () => user.mutation(api.profiles.remove, { org_id, id: f.viewer.id }),
    ]
    for (const call of refused) await expectRefusal(call(), 'forbidden', /read-only/)
    const after = await t.run(async (ctx) => ({
      agent: await ctx.db.get(f.agent._id),
      user: await ctx.db.get(f.user._id),
      viewer: await ctx.db.get(f.viewer._id),
      keys: await ctx.db.query('agent_keys').collect(),
    }))
    expect(after.agent).toMatchObject({ active: false })
    expect(after.user).toMatchObject({ active: true, org_role: 'user' })
    expect(after.viewer).toMatchObject({ active: true })
    expect(after.keys.map((k) => k.revoked_at)).toEqual([undefined, undefined])
  })

  it('lets an admin remove team members but refuses a team leader who is not an admin', async () => {
    const { t, f } = await fixture()
    const org_id = f.org.id
    const team_id = f.team.id
    // The fixture's user leads the team; the viewer and the agent join it raw.
    await t.run(async (ctx) => {
      for (const profile_id of [f.viewer.id, f.agent.id]) {
        await ctx.db.insert('team_members', { team_id, profile_id, is_leader: false })
      }
    })
    // keeping a member as a Viewer or reassigning their tasks writes more
    // than a removal, so it stays behind the gate, even for an admin
    for (const on_held_tasks of ['keep_as_viewer', { reassign_to: null }] as const) {
      await expectRefusal(
        as(t, f.admin).mutation(api.teams.removeMember, {
          org_id,
          team_id,
          profile_id: f.viewer.id,
          on_held_tasks,
        }),
        'forbidden',
        /read-only/,
      )
    }
    await expect(
      as(t, f.admin).mutation(api.teams.removeMember, {
        org_id,
        team_id,
        profile_id: f.viewer.id,
        on_held_tasks: 'leave',
      }),
    ).resolves.toBeNull()
    await expectRefusal(
      as(t, f.user).mutation(api.teams.removeMember, { org_id, team_id, profile_id: f.agent.id }),
      'forbidden',
      /read-only/,
    )
    // adding a member back stays behind the billing gate, even for an admin
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.addMember, { org_id, team_id, profile_id: f.viewer.id }),
      'forbidden',
      /read-only/,
    )
    // and so does keeping as a Viewer when there is no membership left to remove
    await expectRefusal(
      as(t, f.admin).mutation(api.teams.removeMember, {
        org_id,
        team_id,
        profile_id: f.viewer.id,
        on_held_tasks: 'keep_as_viewer',
      }),
      'forbidden',
      /read-only/,
    )
    const members = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('team_members')
          .withIndex('by_team', (q) => q.eq('team_id', team_id))
          .collect()
      ).map((m) => m.profile_id),
    )
    expect(members.sort()).toEqual([f.user.id, f.admin.id, f.agent.id].sort())
  })

  it('lets an admin remove project access by leaving the tasks but refuses a lead who is not an admin', async () => {
    const { t, f } = await fixture()
    const org_id = f.org.id
    const remove = (
      who: typeof f.admin,
      on_held_tasks: 'leave' | 'keep_as_viewer' | { reassign_to: null },
    ) =>
      as(t, who).mutation(api.projects.removeAccess, {
        org_id,
        id: f.meta.id,
        user_id: f.viewer.id,
        on_held_tasks,
      })
    // keeping the person as a Viewer or reassigning their tasks writes more
    // than a removal, so it stays behind the gate, even for an admin
    for (const held of ['keep_as_viewer', { reassign_to: null }] as const) {
      await expectRefusal(remove(f.admin, held), 'forbidden', /read-only/)
    }
    // the user leads TBED but is not an admin
    await expectRefusal(remove(f.user, 'leave'), 'forbidden', /read-only/)
    expect(await tbedGrant(t, f, f.viewer.id)).toMatchObject({ level: 'user' })
    expect(await remove(f.admin, 'leave')).toEqual({ removed: true, stranded: 0 })
    expect(await tbedGrant(t, f, f.viewer.id)).toBeNull()
    // the gate comes first, so a grant that is gone gets the same answer
    await expectRefusal(remove(f.admin, 'keep_as_viewer'), 'forbidden', /read-only/)
  })

  it('lets an admin remove project access and team members over REST and MCP by leaving the tasks', async () => {
    const { t, f } = await fixture()
    const admin = { callerId: f.admin.id, access: 'write' as const }
    const lead = { callerId: f.user.id, access: 'write' as const }
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: f.viewer.id,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.viewer.id,
        is_leader: false,
      })
    })
    const restRemove = (caller: typeof admin, body: string) =>
      t.mutation(internal.machine.projects.restRemoveUserAccess, {
        ...caller,
        keyName: null,
        ref: 'TBED',
        subject: f.viewer.id,
        body,
      })
    const mcpAccess = (args: { level: 'viewer' | null; on_held_tasks?: 'keep_as_viewer' }) =>
      t.mutation(internal.machine.projects.mcpSetProjectAccess, {
        ...admin,
        project: 'TBED',
        user_id: f.guest.id,
        ...args,
      })
    const restLeave = (caller: typeof admin, body: string) =>
      t.mutation(internal.machine.teams.restDeleteMember, {
        ...caller,
        keyName: null,
        ref: f.team.id,
        user: f.viewer.id,
        body,
      })
    const mcpMember = (
      caller: typeof admin,
      args: { user_id: string; member: boolean; on_held_tasks?: 'keep_as_viewer' },
    ) =>
      t.mutation(internal.machine.teams.mcpSetTeamMember, {
        ...caller,
        team_id: f.team.id,
        ...args,
      })

    // Giving or changing access, keeping people as Viewers, reassigning
    // their tasks and a lead or team leader who is not an admin all meet
    // the gate.
    const refused = [
      () => restRemove(admin, '{"on_held_tasks":"keep_as_viewer"}'),
      () => restRemove(admin, '{"on_held_tasks":{"reassign_to":null}}'),
      () => restRemove(lead, ''),
      () => mcpAccess({ level: null, on_held_tasks: 'keep_as_viewer' }),
      () => mcpAccess({ level: 'viewer' }),
      () => restLeave(admin, '{"on_held_tasks":"keep_as_viewer"}'),
      () => restLeave(lead, '{"on_held_tasks":"leave"}'),
      () =>
        mcpMember(admin, { user_id: f.viewer.id, member: false, on_held_tasks: 'keep_as_viewer' }),
      () => mcpMember(admin, { user_id: f.guest.id, member: true }),
      () => mcpMember(lead, { user_id: f.viewer.id, member: false }),
    ]
    for (const call of refused) {
      const e = await expectRefusal(call(), 'forbidden')
      expect(e.data).toMatchObject({ reason: 'billing_required', message: BILLING_READ_ONLY })
    }
    expect(await tbedGrant(t, f, f.viewer.id)).toMatchObject({ level: 'user' })
    expect(await tbedGrant(t, f, f.guest.id)).toMatchObject({ level: 'user' })
    expect(await teamMemberIds(t, f)).toEqual([f.user.id, f.admin.id, f.viewer.id].sort())

    // The removal leaves the viewer's FW task out of their sight and says so.
    expect(await restRemove(admin, '')).toMatchObject({
      removed: true,
      stranded: [{ id: task.id, user_id: f.viewer.id, role: 'assignee' }],
      kept_as_viewer: [],
      reassigned: [],
    })
    expect(JSON.parse(await mcpAccess({ level: null }))).toMatchObject({
      level: null,
      changed: true,
    })
    expect(await restLeave(admin, '{"on_held_tasks":"leave"}')).toMatchObject({ removed: true })
    expect(JSON.parse(await mcpMember(admin, { user_id: f.user.id, member: false }))).toMatchObject(
      { member: false, changed: true },
    )
    expect(await tbedGrant(t, f, f.viewer.id)).toBeNull()
    expect(await tbedGrant(t, f, f.guest.id)).toBeNull()
    expect(await teamMemberIds(t, f)).toEqual([f.admin.id])

    // The gate comes first, so a grant or membership that is gone gets the
    // same refusal instead of an answer that nothing changed.
    for (const call of [
      () => restRemove(admin, '{"on_held_tasks":"keep_as_viewer"}'),
      () => mcpAccess({ level: null, on_held_tasks: 'keep_as_viewer' }),
      () => restLeave(admin, '{"on_held_tasks":"keep_as_viewer"}'),
      () =>
        mcpMember(admin, { user_id: f.viewer.id, member: false, on_held_tasks: 'keep_as_viewer' }),
    ]) {
      const e = await expectRefusal(call(), 'forbidden')
      expect(e.data).toMatchObject({ reason: 'billing_required', message: BILLING_READ_ONLY })
    }
  })

  it('lets an admin remove access over REST while the organization waits for deletion', async () => {
    const { t, f } = await fixture()
    await t.run(async (ctx) => {
      await ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: UNTIL,
        created_at: NOW,
      })
    })
    const remove = (callerId: string, body: string) =>
      t.mutation(internal.machine.projects.restRemoveUserAccess, {
        callerId,
        access: 'write',
        keyName: null,
        ref: 'TBED',
        subject: f.viewer.id,
        body,
      })
    for (const [callerId, body] of [
      [f.user.id, ''],
      [f.admin.id, '{"on_held_tasks":"keep_as_viewer"}'],
    ]) {
      const e = await expectRefusal(remove(callerId, body), 'forbidden', /deleted on 2026-09-25/)
      expect(e.data).toMatchObject({ reason: 'deletion_scheduled' })
    }
    expect(await remove(f.admin.id, '')).toMatchObject({ removed: true, stranded: [] })
    expect(await tbedGrant(t, f, f.viewer.id)).toBeNull()
  })
})

/* The person's direct grant on the fixture's TBED, or null. */
const tbedGrant = (t: Recovery['t'], f: Recovery['f'], profileId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('project_access')
      .withIndex('by_project_profile', (q) =>
        q.eq('project_id', f.meta.id).eq('profile_id', profileId),
      )
      .unique(),
  )

/* The fixture team's member ids, sorted. */
const teamMemberIds = (t: Recovery['t'], f: Recovery['f']) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', f.team.id))
        .collect()
    )
      .map((m) => m.profile_id)
      .sort(),
  )

type Recovery = Awaited<ReturnType<typeof fixture>>
