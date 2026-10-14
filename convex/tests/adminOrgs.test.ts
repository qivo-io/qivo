/* Operator organization creation and invitations (adminOrgs.ts). Covers the
 * fail-closed gate on every public door, the one-transaction create with its
 * address, starter team, billing plan and months free, the admin-first and
 * home-organization rules, invitation email delivery and its audit record,
 * resend, cancel and role changes, and how the invited roles survive the
 * first sign-in. Runs against the local Better Auth component so logins,
 * operator emails and the sign-in or sign-up link choice are real. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import * as adminOrgsModule from '../adminOrgs'
import authSchema from '../betterAuth/schema'
import { as, expectRefusal, NOW, newT, type T, uuid, withOrg } from './helpers.setup'

declare const process: { env: Record<string, string | undefined> }

const newAuthT = (): T => {
  const t = newT()
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.ts'))
  return t
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function plantLogin(t: T, email: string): Promise<string> {
  const now = Date.now()
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: email.split('@')[0],
        email,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })
  return user._id as string
}

/* A real platform operator, with a component login (so audit rows carry its
 * email) and the platform_admins row the wrappers gate on. */
async function withOperator(t: T) {
  const userId = await plantLogin(t, 'operator@platform.test')
  await t.run((ctx) =>
    ctx.db.insert('platform_admins', { auth_user_id: userId, note: 'test', created_at: NOW }),
  )
  return t.withIdentity({ subject: userId })
}

/* A billing plan, made the default for new customers unless told not to. */
async function withPlan(t: T, opts: { default?: boolean; name?: string } = {}): Promise<string> {
  const id = uuid()
  await t.run(async (ctx) => {
    await ctx.db.insert('billing_plans', {
      id,
      name: opts.name ?? 'Standard 2026',
      currency: 'usd',
      seat_price_cents: 100,
      minimum_seats: 5,
      storage_gb_per_seat: 1,
      minimum_storage_gb: 5,
      api_calls_per_seat: 25_000,
      storage_block_price_cents: 100,
      api_block_price_cents: 100,
      api_block_size: 25_000,
      archived: false,
      created_at: NOW,
    })
    if (opts.default !== false) {
      await ctx.db.insert('billing_settings', { key: 'default', default_plan_id: id })
    }
  })
  return id
}

const subscriptionOf = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('billing_subscriptions')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique(),
  )

const BRIGHTWATER = [
  { name: 'Elin Strand', email: 'elin@brightwater.studio', role: 'admin' as const },
  { name: 'Tomas Lind', email: 'Tomas@Brightwater.Studio ', role: 'user' as const },
  { name: 'Aisha  Karim', email: 'aisha@brightwater.studio', role: 'viewer' as const },
]

const seatsOf = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
  )

const auditFor = (t: T, action: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query('platform_audit_log').collect()).filter((r) => r.action === action),
  )

const orgCount = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('organizations').collect()).length)

/* Captures every letter the transport posts, with mail configured. */
function stubMail() {
  vi.stubEnv('AGENTMAIL_API_KEY', 'test-only-provider-key')
  vi.stubEnv('AGENTMAIL_INBOX', 'no-reply@qivo.io')
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
  vi.stubGlobal('fetch', fetch)
  return () =>
    fetch.mock.calls.map(
      ([url, init]) =>
        ({ url, ...JSON.parse(init.body) }) as {
          url: string
          to: string[]
          subject: string
          text: string
          html: string
        },
    )
}

describe('the operator gate', () => {
  /* Every public door, so a new one cannot ship ungated unnoticed. */
  const DOORS: Record<string, (c: ReturnType<T['withIdentity']>) => Promise<unknown>> = {
    suggestAddress: (c) => c.query(api.adminOrgs.suggestAddress, { name: 'X' }),
    checkAddress: (c) => c.query(api.adminOrgs.checkAddress, { slug: 'x' }),
    checkPeople: (c) => c.query(api.adminOrgs.checkPeople, { emails: [] }),
    createOrganization: (c) =>
      c.action(api.adminOrgs.createOrganization, { name: 'X', people: [] }),
    invitePeople: (c) => c.action(api.adminOrgs.invitePeople, { org_id: 'x', people: [] }),
    resendInvite: (c) => c.action(api.adminOrgs.resendInvite, { profile_id: 'x' }),
    cancelInvite: (c) => c.mutation(api.adminOrgs.cancelInvite, { profile_id: 'x' }),
    setMemberRole: (c) =>
      c.mutation(api.adminOrgs.setMemberRole, { profile_id: 'x', role: 'user' }),
  }

  it('lists every public export', () => {
    const publicExports = Object.entries(adminOrgsModule)
      .filter(([, value]) => (value as { isPublic?: boolean }).isPublic === true)
      .map(([name]) => name)
      .sort()
    expect(publicExports).toEqual(Object.keys(DOORS).sort())
  })

  it.each(Object.keys(DOORS))(
    '%s refuses an organization admin who is not an operator',
    async (door) => {
      const t = newAuthT()
      const f = await withOrg(t)
      await expectRefusal(DOORS[door](as(t, f.admin)), 'forbidden')
    },
  )
})

describe('createOrganization', () => {
  it('creates the organization, its people, starter team, labels and billing in one go', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const planId = await withPlan(t)
    const before = Date.now()
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: '  Brightwater Studio ',
      plan_id: planId,
      complimentary_months: 6,
      people: BRIGHTWATER,
    })

    const org = await t.run((ctx) =>
      ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', out.org_id))
        .unique(),
    )
    expect(org).toMatchObject({ name: 'Brightwater Studio', slug: 'brightwater-studio' })

    const seats = await seatsOf(t, out.org_id)
    expect(
      seats.map((s) => [s.name, s.email, s.org_role, s.kind, s.active, s.auth_user_id]),
    ).toEqual([
      ['Elin Strand', 'elin@brightwater.studio', 'admin', 'person', true, undefined],
      ['Tomas Lind', 'tomas@brightwater.studio', 'user', 'person', true, undefined],
      ['Aisha Karim', 'aisha@brightwater.studio', 'viewer', 'person', true, undefined],
    ])
    expect(seats.every((s) => s.accepted_at === undefined && s.message_retention_days === 7)).toBe(
      true,
    )
    expect(out.invites.map((i) => [i.email, i.sent])).toEqual([
      ['elin@brightwater.studio', false],
      ['tomas@brightwater.studio', false],
      ['aisha@brightwater.studio', false],
    ])

    const { team, members, labels, sub } = await t.run(async (ctx) => {
      const team = await ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', out.org_id))
        .unique()
      return {
        team,
        members: team
          ? await ctx.db
              .query('team_members')
              .withIndex('by_team', (q) => q.eq('team_id', team.id))
              .collect()
          : [],
        labels: await ctx.db
          .query('labels')
          .withIndex('by_org', (q) => q.eq('org_id', out.org_id))
          .collect(),
        sub: await ctx.db
          .query('billing_subscriptions')
          .withIndex('by_org', (q) => q.eq('org_id', out.org_id))
          .unique(),
      }
    })
    expect(team?.name).toBe('Brightwater Studio')
    expect(members.map((m) => [m.profile_id, m.is_leader])).toEqual([[seats[0].id, true]])
    expect(labels.length).toBeGreaterThan(0)
    expect(sub?.plan_id).toBe(planId)
    const until = Date.parse(sub?.complimentary_until ?? '')
    expect(until - before).toBeGreaterThan(180 * 86_400_000)
    expect(until - before).toBeLessThan(185 * 86_400_000)

    expect((await auditFor(t, 'create_org'))[0]).toMatchObject({
      actor_email: 'operator@platform.test',
      target_org_id: out.org_id,
      detail: { name: 'Brightwater Studio', slug: 'brightwater-studio', plan_id: planId },
    })
    expect((await auditFor(t, 'invite_member')).map((r) => r.detail.role)).toEqual([
      'admin',
      'user',
      'viewer',
    ])
    expect(await auditFor(t, 'billing.grant_complimentary')).toHaveLength(1)
    expect((await auditFor(t, 'invite_email')).map((r) => r.detail.sent)).toEqual([
      false,
      false,
      false,
    ])
  })

  it('enrolls the chosen plan rather than the default, with or without months free', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    await withPlan(t)
    const chosen = await withPlan(t, { default: false, name: 'Founding' })
    for (const complimentary_months of [6, undefined]) {
      const out = await op.action(api.adminOrgs.createOrganization, {
        name: `Plan Co ${complimentary_months ?? 'paid'}`,
        plan_id: chosen,
        ...(complimentary_months === undefined ? {} : { complimentary_months }),
        people: [],
      })
      const sub = await subscriptionOf(t, out.org_id)
      expect(sub?.plan_id).toBe(chosen)
      expect(sub?.complimentary_until === undefined).toBe(complimentary_months === undefined)
    }
  })

  it('uses a chosen address and refuses an unusable one without creating anything', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const made = await op.action(api.adminOrgs.createOrganization, {
      name: 'Brightwater Studio',
      slug: 'Brightwater',
      people: [],
    })
    expect(
      (await t.run((ctx) => ctx.db.query('organizations').collect())).map((o) => o.slug),
    ).toContain('brightwater')
    const count = await orgCount(t)
    for (const [slug, reason] of [
      [f.org.slug, /taken/],
      ['admin', /reserved/],
      ['Bad slug!', /lowercase letters/],
    ] as const) {
      await expectRefusal(
        op.action(api.adminOrgs.createOrganization, { name: 'Other', slug, people: [] }),
        'conflict',
        reason,
      )
    }
    expect(await orgCount(t)).toBe(count)
    expect(made.invites).toEqual([])
  })

  it('creates an organization without people, with a leaderless starter team', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const out = await op.action(api.adminOrgs.createOrganization, { name: 'Empty Co', people: [] })
    const { team, members } = await t.run(async (ctx) => {
      const team = await ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', out.org_id))
        .unique()
      const members = await ctx.db
        .query('team_members')
        .withIndex('by_team', (q) => q.eq('team_id', team?.id ?? ''))
        .collect()
      return { team, members }
    })
    expect(team?.name).toBe('Empty Co')
    expect(members).toEqual([])
    expect(await seatsOf(t, out.org_id)).toEqual([])
  })

  it('refuses people who break the rules, and leaves nothing behind', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const count = await orgCount(t)
    const create = (
      people: Array<{ name: string; email: string; role: 'admin' | 'user' | 'viewer' }>,
    ) => op.action(api.adminOrgs.createOrganization, { name: 'Rules Co', people })
    await expectRefusal(
      create([{ name: 'Tomas Lind', email: 'tomas@example.test', role: 'user' }]),
      'rule',
      /first person must be an org admin/,
    )
    await expectRefusal(
      create([
        { name: 'Elin', email: 'elin@example.test', role: 'admin' },
        { name: 'Elin again', email: 'ELIN@example.test', role: 'user' },
      ]),
      'rule',
      /listed twice/,
    )
    await expectRefusal(
      create([{ name: 'Elin', email: 'elin', role: 'admin' }]),
      'rule',
      /not an email address/,
    )
    await expectRefusal(
      create([{ name: 'Elin', email: ' ', role: 'admin' }]),
      'rule',
      /Elin needs an email address/,
    )
    await expectRefusal(
      create([{ name: '  ', email: 'elin@example.test', role: 'admin' }]),
      'rule',
      /name cannot be blank/,
    )
    await expectRefusal(
      op.action(api.adminOrgs.createOrganization, { name: ' ', people: [] }),
      'rule',
      /needs a name/,
    )
    await expectRefusal(
      op.action(api.adminOrgs.createOrganization, {
        name: 'Rules Co',
        complimentary_months: 6,
        people: [],
      }),
      'rule',
      /default billing plan/,
    )
    expect(await orgCount(t)).toBe(count)
  })

  it('refuses an org admin whose address already has a home organization, and allows other roles', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const homed = f.user.email ?? ''
    await expectRefusal(
      op.action(api.adminOrgs.createOrganization, {
        name: 'Second Home',
        people: [{ name: 'User', email: homed, role: 'admin' }],
      }),
      'rule',
      /already belongs to Testbed Labs, so they would join as a guest/,
    )
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Second Home',
      people: [
        { name: 'Elin Strand', email: 'elin@example.test', role: 'admin' },
        { name: 'User', email: homed, role: 'user' },
      ],
    })
    expect((await seatsOf(t, out.org_id)).map((s) => s.org_role)).toEqual(['admin', 'user'])
    expect(
      await op.query(api.adminOrgs.checkPeople, {
        org_id: out.org_id,
        emails: [homed, 'ELIN@example.test', 'new@example.test'],
      }),
    ).toEqual([
      { email: homed, home_org_name: 'Testbed Labs', in_org: true },
      { email: 'elin@example.test', home_org_name: null, in_org: true },
      { email: 'new@example.test', home_org_name: null, in_org: false },
    ])
  })

  it('emails each invitation from the configured inbox, linking to sign-up or sign-in', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    await plantLogin(t, 'aisha@brightwater.studio')
    const letters = stubMail()
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Bright <b>water</b>',
      people: BRIGHTWATER,
    })
    expect(out.invites.every((i) => i.sent)).toBe(true)
    const sent = letters()
    expect(sent.map((l) => l.to)).toEqual([
      ['elin@brightwater.studio'],
      ['tomas@brightwater.studio'],
      ['aisha@brightwater.studio'],
    ])
    expect(sent[0].url).toBe('https://api.agentmail.to/v0/inboxes/no-reply%40qivo.io/messages/send')
    expect(sent.every((l) => l.subject === 'You are invited to Qivo')).toBe(true)
    expect(sent[0].text).toContain(`${process.env.SITE_URL}/app#signup`)
    expect(sent[2].text.endsWith(`${process.env.SITE_URL}/app`)).toBe(true)
    expect(sent[0].text).toContain('Bright <b>water</b>')
    expect(sent[0].html).toContain('Bright &lt;b&gt;water&lt;/b&gt;')
    expect(sent[0].html).not.toContain('<b>water</b>')
    expect((await auditFor(t, 'invite_email')).map((r) => r.detail.sent)).toEqual([
      true,
      true,
      true,
    ])
  })
})

describe('invitePeople', () => {
  it('requires an org admin first in an organization that has none', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const { org_id } = await op.action(api.adminOrgs.createOrganization, {
      name: 'Later Co',
      people: [],
    })
    await expectRefusal(
      op.action(api.adminOrgs.invitePeople, {
        org_id,
        people: [{ name: 'Tomas', email: 'tomas@example.test', role: 'viewer' }],
      }),
      'rule',
      /first person must be an org admin/,
    )
    await op.action(api.adminOrgs.invitePeople, {
      org_id,
      people: [{ name: 'Elin', email: 'elin@example.test', role: 'admin' }],
    })
    await op.action(api.adminOrgs.invitePeople, {
      org_id,
      people: [{ name: 'Tomas', email: 'tomas@example.test', role: 'viewer' }],
    })
    expect((await seatsOf(t, org_id)).map((s) => s.org_role)).toEqual(['admin', 'viewer'])
  })

  it('refuses an address that already has a seat in the organization', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    await expectRefusal(
      op.action(api.adminOrgs.invitePeople, {
        org_id: f.org.id,
        people: [{ name: 'Viewer', email: f.viewer.email ?? '', role: 'user' }],
      }),
      'rule',
      /already has a seat in this organization/,
    )
    await expectRefusal(
      op.action(api.adminOrgs.invitePeople, { org_id: f.org.id, people: [] }),
      'rule',
      /at least one person/,
    )
  })
})

describe('resendInvite and orgDetail', () => {
  it('sends another email for a pending seat and shows the newest attempt', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Resend Co',
      people: [BRIGHTWATER[0]],
    })
    const [elin] = await seatsOf(t, out.org_id)
    let detail = await op.query(api.admin.orgDetail, { org_id: out.org_id })
    expect(detail.members[0]).toMatchObject({
      kind: 'person',
      active: true,
      has_login: false,
      invite: { sent: false },
    })

    const letters = stubMail()
    expect(await op.action(api.adminOrgs.resendInvite, { profile_id: elin.id })).toMatchObject({
      sent: true,
    })
    expect(letters()).toHaveLength(1)
    detail = await op.query(api.admin.orgDetail, { org_id: out.org_id })
    expect(detail.members[0].invite).toMatchObject({ sent: true })
    expect((await auditFor(t, 'invite_email')).map((r) => r.detail.resend)).toEqual([false, true])
  })

  it('refuses an inactive seat, and drops a status that went to an earlier address', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Status Co',
      people: [BRIGHTWATER[0]],
    })
    const [elin] = await seatsOf(t, out.org_id)
    await t.run((ctx) => ctx.db.patch(elin._id, { email: 'elin.strand@brightwater.studio' }))
    const detail = await op.query(api.admin.orgDetail, { org_id: out.org_id })
    expect(detail.members[0]).toMatchObject({
      email: 'elin.strand@brightwater.studio',
      invite: null,
    })
    await t.run((ctx) => ctx.db.patch(elin._id, { active: false }))
    await expectRefusal(
      op.action(api.adminOrgs.resendInvite, { profile_id: elin.id }),
      'not_found',
      /invitation not found/,
    )
  })

  it('refuses a seat that is already claimed, and shows no invite for it', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    await expectRefusal(
      op.action(api.adminOrgs.resendInvite, { profile_id: f.user.id }),
      'not_found',
      /invitation not found/,
    )
    const detail = await op.query(api.admin.orgDetail, { org_id: f.org.id })
    const agent = detail.members.find((m) => m.profile_id === f.agent.id)
    expect(agent).toMatchObject({ kind: 'agent', invite: null })
    expect(detail.members.find((m) => m.profile_id === f.user.id)?.invite).toBeNull()
  })
})

describe('cancelInvite', () => {
  it('removes a pending seat and audits it', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Cancel Co',
      people: BRIGHTWATER,
    })
    const [, tomas] = await seatsOf(t, out.org_id)
    await op.mutation(api.adminOrgs.cancelInvite, { profile_id: tomas.id })
    expect((await seatsOf(t, out.org_id)).map((s) => s.name)).toEqual([
      'Elin Strand',
      'Aisha Karim',
    ])
    expect((await auditFor(t, 'cancel_invite'))[0]).toMatchObject({
      actor_email: 'operator@platform.test',
      target_profile_id: tomas.id,
      detail: { email: 'tomas@brightwater.studio', role: 'user' },
    })
  })

  it('keeps the only org admin while others are invited, and lets it go when alone', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Admin Co',
      people: BRIGHTWATER.slice(0, 2),
    })
    const [elin, tomas] = await seatsOf(t, out.org_id)
    await expectRefusal(
      op.mutation(api.adminOrgs.cancelInvite, { profile_id: elin.id }),
      'rule',
      /Invite another org admin before cancelling the only one/,
    )
    await op.mutation(api.adminOrgs.cancelInvite, { profile_id: tomas.id })
    await op.mutation(api.adminOrgs.cancelInvite, { profile_id: elin.id })
    expect(await seatsOf(t, out.org_id)).toEqual([])
  })

  it('refuses a claimed seat', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    await expectRefusal(
      op.mutation(api.adminOrgs.cancelInvite, { profile_id: f.user.id }),
      'not_found',
      /invitation not found/,
    )
  })
})

describe('setMemberRole', () => {
  it('changes a role with the in-app guards', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const set = (p: Doc<'profiles'>, role: 'admin' | 'user' | 'viewer') =>
      op.mutation(api.adminOrgs.setMemberRole, { profile_id: p.id, role })
    await expectRefusal(set(f.admin, 'user'), 'rule', /cannot demote the last admin/)
    await expectRefusal(set(f.user, 'viewer'), 'rule', /leads 2 project\(s\)/)
    await expectRefusal(set(f.agent, 'admin'), 'rule', /agent cannot be an organization admin/)
    await expectRefusal(set(f.guest, 'user'), 'rule', /guest gets access from project settings/)
    await set(f.viewer, 'admin')
    await set(f.admin, 'user')
    const roles = await t.run(async (ctx) => {
      const get = async (id: string) =>
        (
          await ctx.db
            .query('profiles')
            .withIndex('by_uuid', (q) => q.eq('id', id))
            .unique()
        )?.org_role
      return [await get(f.viewer.id), await get(f.admin.id)]
    })
    expect(roles).toEqual(['admin', 'user'])
    expect((await auditFor(t, 'set_member_role')).map((r) => [r.detail.from, r.detail.to])).toEqual(
      [
        ['viewer', 'admin'],
        ['admin', 'user'],
      ],
    )
  })

  it('refuses to make an invited person org admin when their home organization is elsewhere', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Promote Co',
      people: [
        { name: 'Elin', email: 'elin@example.test', role: 'admin' },
        { name: 'User', email: f.user.email ?? '', role: 'user' },
      ],
    })
    const [, user] = await seatsOf(t, out.org_id)
    await expectRefusal(
      op.mutation(api.adminOrgs.setMemberRole, { profile_id: user.id, role: 'admin' }),
      'rule',
      /already belongs to Testbed Labs/,
    )
  })
})

describe('the home organization fence follows claim order', () => {
  it('lets an older invitation become org admin despite a newer one elsewhere', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const first = await op.action(api.adminOrgs.createOrganization, {
      name: 'First Co',
      people: [
        { name: 'Elin', email: 'elin@example.test', role: 'admin' },
        { name: 'Alice', email: 'alice@example.test', role: 'user' },
      ],
    })
    await op.action(api.adminOrgs.createOrganization, {
      name: 'Second Co',
      people: [
        { name: 'Noah', email: 'noah@example.test', role: 'admin' },
        { name: 'Alice', email: 'alice@example.test', role: 'user' },
      ],
    })
    const [, alice] = await seatsOf(t, first.org_id)
    await op.mutation(api.adminOrgs.setMemberRole, { profile_id: alice.id, role: 'admin' })
    await t.mutation(internal.identity.claimSeatsInternal, {
      userId: 'alice-login',
      email: 'alice@example.test',
      emailVerified: true,
    })
    const roles = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('profiles')
          .withIndex('by_email', (q) => q.eq('email', 'alice@example.test'))
          .collect()
      ).map((p) => p.org_role),
    )
    expect(roles).toEqual(['admin', 'guest'])
  })

  it('applies to Make org admin for a pending seat, but not a signed-in one', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Rescue Co',
      people: [
        { name: 'Elin', email: 'elin@example.test', role: 'admin' },
        { name: 'User', email: f.user.email ?? '', role: 'user' },
      ],
    })
    const [, user] = await seatsOf(t, out.org_id)
    await expectRefusal(
      op.mutation(api.admin.promoteOrgAdmin, { profile_id: user.id }),
      'rule',
      /already belongs to Testbed Labs/,
    )
    await op.mutation(api.admin.promoteOrgAdmin, { profile_id: f.viewer.id })
  })
})

describe('address checks', () => {
  it('suggests the generated address and reports why one cannot be used', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    expect(await op.query(api.adminOrgs.suggestAddress, { name: 'Testbed' })).toBe('testbed-2')
    expect(await op.query(api.adminOrgs.checkAddress, { slug: 'fresh-name' })).toEqual({ ok: true })
    expect(await op.query(api.adminOrgs.checkAddress, { slug: f.org.slug })).toEqual({
      ok: false,
      reason: 'slug_taken',
    })
    expect(await op.query(api.adminOrgs.checkAddress, { slug: 'admin' })).toEqual({
      ok: false,
      reason: 'slug_reserved',
    })
    expect(await op.query(api.adminOrgs.checkAddress, { slug: '-bad-' })).toEqual({
      ok: false,
      reason: 'slug_shape',
    })
  })
})

describe('signing in after an operator invitation', () => {
  it('keeps the invited role when a standard user signs in before the org admin', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Claim Co',
      people: BRIGHTWATER,
    })
    await t.mutation(internal.identity.claimSeatsInternal, {
      userId: 'tomas-login',
      email: 'tomas@brightwater.studio',
      emailVerified: true,
    })
    const seats = await seatsOf(t, out.org_id)
    expect(seats.map((s) => [s.name, s.org_role, s.auth_user_id])).toEqual([
      ['Elin Strand', 'admin', undefined],
      ['Tomas Lind', 'user', 'tomas-login'],
      ['Aisha Karim', 'viewer', undefined],
    ])
    const detail = await op.query(api.admin.orgDetail, { org_id: out.org_id })
    expect(detail.members.find((m) => m.name === 'Tomas Lind')).toMatchObject({
      has_login: true,
      invite: null,
    })
  })
})
