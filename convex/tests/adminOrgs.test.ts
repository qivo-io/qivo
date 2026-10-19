/* Operator organization creation and invitations (adminOrgs.ts). Covers the
 * fail-closed gate on every public door, the demo refusal in the internal
 * writers behind them, the one-transaction create with its address, starter
 * team, billing plan and months free, the admin-first and home-organization
 * rules, invitation email delivery and its audit record, resend, cancel and
 * role changes, and how the invited roles survive the first sign-in. Runs
 * against the local Better Auth component so logins, operator emails and the
 * sign-in or sign-up link choice are real. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import * as adminOrgsModule from '../adminOrgs'
import authSchema from '../betterAuth/schema'
import { as, expectRefusal, NOW, newT, plantSeat, type T, uuid, withOrg } from './helpers.setup'

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
  vi.stubEnv('LETTERMINT_API_KEY', 'test-only-provider-token')
  vi.stubEnv('MAIL_FROM', 'no-reply@qivo.io')
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'm' }) })
  vi.stubGlobal('fetch', fetch)
  return () =>
    fetch.mock.calls.map(
      ([url, init]) =>
        ({ url, ...JSON.parse(init.body) }) as {
          url: string
          from: string
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
    editInvite: (c) =>
      c.action(api.adminOrgs.editInvite, { profile_id: 'x', name: 'X', email: 'x@x.test' }),
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

/* The internal mutations behind createOrganization, invitePeople and
 * editInvite. The dashboard and deploy keys can run them without a door, so
 * each refuses a demo deployment itself. */
describe('the internal writers behind the doors', () => {
  const actor = { auth_user_id: 'operator-login', email: 'operator@platform.test' }
  type Fixture = { t: T; orgId: string; pending: Doc<'profiles'> }
  /* Every internal export, so a new one cannot skip the demo refusal unnoticed. */
  const WRITERS: Record<string, { audit: string; run: (f: Fixture) => Promise<unknown> }> = {
    insertOrganization: {
      audit: 'create_org',
      run: ({ t }) =>
        t.mutation(internal.adminOrgs.insertOrganization, {
          name: 'Probe Co',
          people: [{ name: 'Elin Strand', email: 'elin@probe.test', role: 'admin' }],
          actor,
        }),
    },
    insertPeople: {
      audit: 'invite_member',
      run: ({ t, orgId }) =>
        t.mutation(internal.adminOrgs.insertPeople, {
          org_id: orgId,
          people: [{ name: 'Nils Holm', email: 'nils@testbed.test', role: 'user' }],
          actor,
        }),
    },
    updateInvite: {
      audit: 'edit_invite',
      run: ({ t, pending }) =>
        t.mutation(internal.adminOrgs.updateInvite, {
          profile_id: pending.id,
          name: 'Pending Seat',
          email: 'pending.seat@testbed.test',
          actor,
        }),
    },
  }

  /* An organization with an active org admin and one pending seat. */
  async function fixture(): Promise<Fixture> {
    const t = newAuthT()
    const f = await withOrg(t)
    const pending = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Pending',
      email: 'pending@testbed.test',
    })
    return { t, orgId: f.org.id, pending }
  }

  const rows = (t: T) =>
    t.run(async (ctx) => ({
      organizations: await ctx.db.query('organizations').collect(),
      profiles: await ctx.db.query('profiles').collect(),
    }))

  it('lists every internal export', () => {
    const internalExports = Object.entries(adminOrgsModule)
      .filter(([, value]) => (value as { isInternal?: boolean }).isInternal === true)
      .map(([name]) => name)
      .sort()
    expect(internalExports).toEqual(Object.keys(WRITERS).sort())
  })

  it.each(Object.keys(WRITERS))('%s refuses a demo deployment and writes nothing', async (name) => {
    const f = await fixture()
    const before = await rows(f.t)
    vi.stubEnv('APP_MODE', 'demo')
    await expectRefusal(WRITERS[name].run(f), 'forbidden', /requires a regular workspace/)
    expect(await rows(f.t)).toEqual(before)
    expect(await auditFor(f.t, WRITERS[name].audit)).toEqual([])
  })

  it.each(Object.keys(WRITERS))('%s writes on a regular deployment', async (name) => {
    const f = await fixture()
    const before = await rows(f.t)
    await WRITERS[name].run(f)
    expect(await rows(f.t)).not.toEqual(before)
    expect(await auditFor(f.t, WRITERS[name].audit)).toHaveLength(1)
  })
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
    expect((await auditFor(t, 'invite_email')).map((r) => [r.actor_email, r.detail.sent])).toEqual([
      ['operator@platform.test', false],
      ['operator@platform.test', false],
      ['operator@platform.test', false],
    ])
    expect((await auditFor(t, 'invite_email')).every((r) => r.actor_auth_id !== undefined)).toBe(
      true,
    )
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

  it('refuses any role for an address whose home organization is elsewhere', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const homed = f.user.email ?? ''
    const count = await orgCount(t)
    for (const role of ['admin', 'user', 'viewer'] as const) {
      await expectRefusal(
        op.action(api.adminOrgs.createOrganization, {
          name: 'Second Home',
          people: [
            { name: 'Elin Strand', email: 'elin@example.test', role: 'admin' as const },
            { name: 'User', email: homed, role },
          ].slice(role === 'admin' ? 1 : 0),
        }),
        'rule',
        /already belongs to Testbed Labs, so they can only join as a guest/,
      )
    }
    expect(await orgCount(t)).toBe(count)
    // A guest seat elsewhere is no home, so its address can be invited.
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Guest Home',
      people: [{ name: 'Guest', email: f.guest.email ?? '', role: 'admin' }],
    })
    expect(
      await op.query(api.adminOrgs.checkPeople, {
        org_id: out.org_id,
        emails: [homed, f.guest.email ?? '', 'NEW@example.test'],
      }),
    ).toEqual([
      { email: homed, home_org_name: 'Testbed Labs', in_org: false },
      { email: f.guest.email, home_org_name: null, in_org: true },
      { email: 'new@example.test', home_org_name: null, in_org: false },
    ])
  })

  it('emails each invitation from the configured sender, linking to sign-up or sign-in', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    await plantLogin(t, 'aisha@brightwater.studio')
    const letters = stubMail()
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Bright <b>water</b>',
      people: BRIGHTWATER,
    })
    expect(out.invites.map((i) => [i.email, i.sent])).toEqual([
      ['elin@brightwater.studio', true],
      ['tomas@brightwater.studio', true],
      ['aisha@brightwater.studio', true],
    ])
    // letters go out a few at a time, so they may arrive in any order
    const sent = letters()
    const to = (email: string) => sent.find((l) => l.to[0] === email)
    expect(sent.map((l) => l.to[0]).sort()).toEqual([
      'aisha@brightwater.studio',
      'elin@brightwater.studio',
      'tomas@brightwater.studio',
    ])
    const elin = to('elin@brightwater.studio')
    expect(elin?.url).toBe('https://api.lettermint.co/v1/send')
    expect(sent.every((l) => l.from === 'Qivo <no-reply@qivo.io>')).toBe(true)
    expect(sent.every((l) => l.subject === 'You are invited to Qivo')).toBe(true)
    expect(elin?.text).toContain(`${process.env.SITE_URL}/app#signup`)
    expect(to('aisha@brightwater.studio')?.text.endsWith(`${process.env.SITE_URL}/app`)).toBe(true)
    expect(elin?.text).toContain(
      'Bright <b>water</b> has invited you to join their organization. Sign in',
    )
    expect(elin?.html).toContain('Bright &lt;b&gt;water&lt;/b&gt;')
    expect(elin?.html).not.toContain('<b>water</b>')
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
    let detail = await op.action(api.adminPeople.orgDetail, { org_id: out.org_id })
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
    detail = await op.action(api.adminPeople.orgDetail, { org_id: out.org_id })
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
    const detail = await op.action(api.adminPeople.orgDetail, { org_id: out.org_id })
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
    const detail = await op.action(api.adminPeople.orgDetail, { org_id: f.org.id })
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
      /Add another org admin before cancelling this invite/,
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

  it('clears the right to create projects only when the role changes', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.user._id, { can_create_projects: true }))
    const set = (role: 'admin' | 'user' | 'viewer') =>
      op.mutation(api.adminOrgs.setMemberRole, { profile_id: f.user.id, role })
    const right = async () => (await t.run((ctx) => ctx.db.get(f.user._id)))?.can_create_projects
    // a refused change and an unchanged role keep it
    await expectRefusal(set('viewer'), 'rule', /leads 2 project\(s\)/)
    await set('user')
    expect(await right()).toBe(true)
    await set('admin')
    expect(await right()).toBeUndefined()
  })

  it('refuses to make an invited person org admin when their home organization is elsewhere', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Promote Co',
      people: [{ name: 'Elin', email: 'elin@example.test', role: 'admin' }],
    })
    // an org admin added this address in the app
    const user = await plantSeat(t, { org_id: out.org_id, email: f.user.email, name: 'User' })
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
    const second = await op.action(api.adminOrgs.createOrganization, {
      name: 'Second Co',
      people: [{ name: 'Noah', email: 'noah@example.test', role: 'admin' }],
    })
    // a later in-app invitation for the same address in another organization
    await plantSeat(t, {
      org_id: second.org_id,
      email: 'alice@example.test',
      created_at: '2099-01-01T00:00:00.000Z',
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
      ).map((p) => [p.org_id === first.org_id ? 'first' : 'second', p.org_role]),
    )
    expect(roles.sort()).toEqual([
      ['first', 'admin'],
      ['second', 'guest'],
    ])
  })

  it('applies to Make org admin for a pending seat, but not a signed-in one', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Rescue Co',
      people: [{ name: 'Elin', email: 'elin@example.test', role: 'admin' }],
    })
    const user = await plantSeat(t, { org_id: out.org_id, email: f.user.email, name: 'User' })
    await expectRefusal(
      op.mutation(api.admin.promoteOrgAdmin, { profile_id: user.id }),
      'rule',
      /already belongs to Testbed Labs/,
    )
    await op.mutation(api.admin.promoteOrgAdmin, { profile_id: f.viewer.id })
  })
})

describe('editInvite', () => {
  it('corrects a pending invitation and emails the new address', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Edit Co',
      people: BRIGHTWATER.slice(0, 2),
    })
    const [elin, tomas] = await seatsOf(t, out.org_id)
    const letters = stubMail()
    expect(
      await op.action(api.adminOrgs.editInvite, {
        profile_id: elin.id,
        name: 'Elin  Strand-Berg',
        email: elin.email ?? '',
      }),
    ).toEqual({ sent: null })
    expect(letters()).toEqual([])
    expect(
      await op.action(api.adminOrgs.editInvite, {
        profile_id: elin.id,
        name: 'Elin Strand-Berg',
        email: ' Elin.Strand@Brightwater.Studio',
      }),
    ).toEqual({ sent: true })
    expect(letters().map((l) => l.to)).toEqual([['elin.strand@brightwater.studio']])
    const [after] = await seatsOf(t, out.org_id)
    expect([after.name, after.initials, after.email]).toEqual([
      'Elin Strand-Berg',
      'ES',
      'elin.strand@brightwater.studio',
    ])
    expect((await auditFor(t, 'edit_invite')).map((r) => r.detail.to)).toEqual([
      { name: 'Elin Strand-Berg', email: 'elin@brightwater.studio' },
      { name: 'Elin Strand-Berg', email: 'elin.strand@brightwater.studio' },
    ])
    const detail = await op.action(api.adminPeople.orgDetail, { org_id: out.org_id })
    expect(detail.members.find((m) => m.profile_id === elin.id)?.invite).toMatchObject({
      sent: true,
    })
    await expectRefusal(
      op.action(api.adminOrgs.editInvite, {
        profile_id: elin.id,
        name: 'Elin',
        email: tomas.email ?? '',
      }),
      'rule',
      /already has a seat in this organization/,
    )
  })

  it('judges a new address like a new invitation, and refuses an inactive seat', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const alpha = await op.action(api.adminOrgs.createOrganization, {
      name: 'Alpha Co',
      people: [{ name: 'Typo', email: 'typo@alpha.test', role: 'admin' }],
    })
    // Beta's only admin is invited after Alpha's seat was created
    await op.action(api.adminOrgs.createOrganization, {
      name: 'Beta Co',
      people: [{ name: 'Noah', email: 'noah@beta.test', role: 'admin' }],
    })
    const [typo] = await seatsOf(t, alpha.org_id)
    await expectRefusal(
      op.action(api.adminOrgs.editInvite, {
        profile_id: typo.id,
        name: 'Noah',
        email: 'noah@beta.test',
      }),
      'rule',
      /already belongs to Beta Co/,
    )
    await t.run((ctx) => ctx.db.patch(typo._id, { active: false }))
    await expectRefusal(
      op.action(api.adminOrgs.editInvite, {
        profile_id: typo.id,
        name: 'Elin',
        email: 'elin@alpha.test',
      }),
      'not_found',
      /invitation not found/,
    )
    const [after] = await seatsOf(t, alpha.org_id)
    expect(after.email).toBe('typo@alpha.test')
    expect(await auditFor(t, 'edit_invite')).toEqual([])
  })

  it('refuses an address with a home elsewhere, a claimed seat and a guest seat', async () => {
    const t = newAuthT()
    const op = await withOperator(t)
    const f = await withOrg(t)
    const out = await op.action(api.adminOrgs.createOrganization, {
      name: 'Edit Rules Co',
      people: [BRIGHTWATER[0]],
    })
    const [elin] = await seatsOf(t, out.org_id)
    const edit = (profile_id: string, email: string) =>
      op.action(api.adminOrgs.editInvite, { profile_id, name: 'Someone', email })
    await expectRefusal(edit(elin.id, f.user.email ?? ''), 'rule', /only join as a guest/)
    await expectRefusal(edit(f.user.id, 'x@example.test'), 'not_found', /invitation not found/)
    const guest = await plantSeat(t, {
      org_id: out.org_id,
      email: 'guest@example.test',
      org_role: 'guest',
    })
    await expectRefusal(edit(guest.id, 'y@example.test'), 'not_found', /invitation not found/)
    await expectRefusal(
      op.mutation(api.adminOrgs.cancelInvite, { profile_id: guest.id }),
      'not_found',
      /invitation not found/,
    )
    await expectRefusal(
      op.action(api.adminOrgs.resendInvite, { profile_id: guest.id }),
      'not_found',
      /invitation not found/,
    )
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
    const detail = await op.action(api.adminPeople.orgDetail, { org_id: out.org_id })
    expect(detail.members.find((m) => m.name === 'Tomas Lind')).toMatchObject({
      has_login: true,
      invite: null,
    })
  })
})
