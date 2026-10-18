/* The operator console's Users page and organization page (adminPeople.ts).
 * Both actions refuse every caller but an operator, and refuse a demo
 * deployment. The suite checks listUsers against the fields Users.tsx
 * destructures, including the banned_until mapping from Better Auth's
 * { banned, banExpires } and the newest-session last_sign_in_at, through the
 * real local component. It writes out orgDetail on a small fixture, and
 * checks both answers again at the smallest page sizes. It also covers a
 * pending seat whose invitation is older than a page of its audit rows, a
 * team counted on its own, and a deployment too large for the old single
 * query. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, components } from '../_generated/api'
import * as peopleModule from '../adminPeople'
import { PEOPLE_PAGE } from '../adminPeople'
import { STATS_PAGE } from '../adminStats'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const DEFAULT_PEOPLE = { ...PEOPLE_PAGE }
const DEFAULT_STATS = { ...STATS_PAGE }
const DAY = 86_400_000

afterEach(() => {
  Object.assign(PEOPLE_PAGE, DEFAULT_PEOPLE)
  Object.assign(STATS_PAGE, DEFAULT_STATS)
  vi.unstubAllEnvs()
})

/* The smallest page of every kind. */
const ONE = {
  profiles: 1,
  members: 1,
  invites: 0,
  audit: 1,
  teams: 1,
  children: 0,
  rows: 1,
  logins: 1,
}

/** A platform operator, which is a Better Auth user with a platform_admins
 * row. */
async function operator(t: T) {
  const now = Date.now()
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'user',
      data: {
        name: 'operator',
        email: 'operator@platform.test',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })
  const userId = user._id as string
  await t.run(async (ctx) => {
    await ctx.db.insert('platform_admins', { auth_user_id: userId, note: 'test', created_at: NOW })
  })
  return t.withIdentity({ subject: userId })
}

/* An invite_email audit row for a seat. */
const inviteRow = (seatId: string, orgId: string, email: string, ts: string, sent: boolean) => ({
  ts,
  actor_email: 'operator@platform.test',
  action: 'invite_email',
  target_org_id: orgId,
  target_profile_id: seatId,
  detail: { email, sent },
})

/* withOrg, with the viewer banned until tomorrow and holding one session, a
 * pending seat with an invitation email and a newer role change, a second
 * team with no members, and a project that keeps the first team. */
async function peopleFixture(t: T) {
  const f = await withOrg(t)
  const now = Date.now()
  const banExpires = now + DAY
  const sessionCreated = now - 1000
  await t.mutation(components.betterAuth.adapter.updateOne, {
    input: {
      model: 'user',
      where: [{ field: '_id', value: f.viewer.auth_user_id! }],
      update: { banned: true, banExpires },
    },
  })
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: 'session',
      data: {
        token: uuid(),
        userId: f.viewer.auth_user_id!,
        expiresAt: now + 60 * 60 * 1000,
        createdAt: sessionCreated,
        updatedAt: sessionCreated,
      },
    },
  })
  const pending = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Pending',
    email: 'pending@testbed.test',
  })
  const empty = uuid()
  await t.run(async (ctx) => {
    await ctx.db.insert(
      'platform_audit_log',
      inviteRow(pending.id, f.org.id, 'pending@testbed.test', '2026-01-02T00:00:00.000Z', true),
    )
    await ctx.db.insert('platform_audit_log', {
      ts: '2026-01-03T00:00:00.000Z',
      actor_email: 'operator@platform.test',
      action: 'set_member_role',
      target_org_id: f.org.id,
      target_profile_id: pending.id,
      detail: {},
    })
    await ctx.db.insert('teams', {
      id: empty,
      org_id: f.org.id,
      name: 'Analog',
      stale_days: 14,
      archive_days: 30,
      track_delay_default: false,
      created_at: NOW,
    })
    await ctx.db.patch(f.sub2._id, { team_id: f.team.id })
  })
  return { f, pending, empty, banExpires, sessionCreated }
}

type PublicName = 'listUsers' | 'orgDetail'
const CALLS: Record<PublicName, (caller: Pick<T, 'action'>, f: OrgFixture) => Promise<unknown>> = {
  listUsers: (caller) => caller.action(api.adminPeople.listUsers, { search: '' }),
  orgDetail: (caller, f) => caller.action(api.adminPeople.orgDetail, { org_id: f.org.id }),
}

/* ---------------------------------------------------------- the fail-closed gate */

describe('fail-closed: every action refuses everyone but an operator', () => {
  it('names every public function of adminPeople.ts', () => {
    const exported = Object.entries(peopleModule).filter(
      ([, value]) => (value as { isPublic?: true }).isPublic === true,
    )
    expect(exported.map(([name]) => name).sort()).toEqual(Object.keys(CALLS).sort())
    for (const [, value] of exported) expect((value as { isAction?: true }).isAction).toBe(true)
  })

  for (const name of Object.keys(CALLS) as PublicName[]) {
    it(`${name}: a signed-in org admin and an anonymous caller are refused`, async () => {
      const t = newT()
      const f = await withOrg(t)
      await expectRefusal(CALLS[name](as(t, f.admin), f), 'forbidden', /platform admins only/)
      await expectRefusal(CALLS[name](t, f), 'forbidden', /platform admins only/)
    })

    it(`${name}: an operator on a demo deployment is refused`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const asOp = await operator(t)
      vi.stubEnv('APP_MODE', 'demo')
      await expectRefusal(CALLS[name](asOp, f), 'forbidden', /requires a regular workspace/)
    })
  }
})

/* -------------------------------------------------------------------- listUsers */

describe('listUsers', () => {
  it('returns every profile with the Users.tsx fields, maps the auth columns, and narrows on search', async () => {
    const t = newT()
    const { f, pending, banExpires, sessionCreated } = await peopleFixture(t)
    const asOp = await operator(t)

    const rows = await asOp.action(api.adminPeople.listUsers, { search: '' })
    // withOrg's admin, user, viewer, guest and agent, the pending seat, and
    // Other's admin. The operator holds no profile.
    expect(rows).toHaveLength(7)
    // ordered by organization name, then profile name
    expect(rows[0].org_name).toBe('Other')
    expect(rows.slice(1).map((r) => r.name)).toEqual([
      'Pending',
      'Relay',
      'admin',
      'guest',
      'user',
      'viewer',
    ])
    expect(rows.find((r) => r.profile_id === f.viewer.id)).toEqual({
      profile_id: f.viewer.id,
      name: 'viewer',
      email: 'viewer@testbed.test',
      org_id: f.org.id,
      org_name: 'Testbed Labs',
      org_role: 'viewer',
      has_login: true,
      last_sign_in_at: new Date(sessionCreated).toISOString(),
      banned_until: new Date(banExpires).toISOString(),
      created_at: NOW,
    })
    // a profile with no login has no auth columns
    for (const id of [f.agent.id, pending.id]) {
      expect(rows.find((r) => r.profile_id === id)).toMatchObject({
        has_login: false,
        last_sign_in_at: null,
        banned_until: null,
      })
    }

    const narrowed = await asOp.action(api.adminPeople.listUsers, { search: 'viewer' })
    expect(narrowed.map((r) => r.profile_id)).toEqual([f.viewer.id])
    // Fragments can appear in reverse order, and across name, email and
    // organization name.
    for (const [search, ids] of [
      ['LABS VIEW', [f.viewer.id]],
      ['  lay\ttestbed ', [f.agent.id]],
      ['testbed missing', []],
    ] as const) {
      const matches = await asOp.action(api.adminPeople.listUsers, { search })
      expect(matches.map((r) => r.profile_id)).toEqual(ids)
    }
  })

  it('leaves out a profile whose organization is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const asOp = await operator(t)
    await t.run(async (ctx) => {
      await ctx.db.delete(f.otherOrg._id)
    })
    const rows = await asOp.action(api.adminPeople.listUsers, { search: '' })
    expect(rows.map((r) => r.profile_id)).not.toContain(f.otherAdmin.id)
    expect(rows).toHaveLength(5)
  })

  it('gives the same rows when every page holds one row or one byte', async () => {
    const t = newT()
    await peopleFixture(t)
    const asOp = await operator(t)
    const expected = await asOp.action(api.adminPeople.listUsers, { search: '' })

    Object.assign(PEOPLE_PAGE, ONE)
    Object.assign(STATS_PAGE, { orgs: 1 })
    expect(await asOp.action(api.adminPeople.listUsers, { search: '' })).toEqual(expected)
    Object.assign(PEOPLE_PAGE, { ...DEFAULT_PEOPLE, bytes: 1 })
    Object.assign(STATS_PAGE, { bytes: 1 })
    expect(await asOp.action(api.adminPeople.listUsers, { search: '' })).toEqual(expected)
  })

  it('lists 3,000 profiles under 1,500 documents a read', async () => {
    const t = newT({ transactionLimits: { documentsRead: 1500 } })
    const f = await withOrg(t)
    const asOp = await operator(t)
    for (let batch = 0; batch < 3; batch++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 1000; i++) {
          await ctx.db.insert('profiles', {
            id: uuid(),
            org_id: f.org.id,
            name: `Seat ${batch}-${i}`,
            initials: 'ST',
            color: '#7a7ad0',
            org_role: 'user',
            active: true,
            kind: 'person',
            created_at: NOW,
          })
        }
      })
    }
    Object.assign(PEOPLE_PAGE, { profiles: 1000 })

    expect(await asOp.action(api.adminPeople.listUsers, { search: '' })).toHaveLength(3006)

    // One page for the whole deployment reads every profile, as the old
    // single query did, and fails under the same limit.
    Object.assign(PEOPLE_PAGE, { profiles: 4000 })
    await expect(asOp.action(api.adminPeople.listUsers, { search: '' })).rejects.toThrow(
      /Scanned too many documents/,
    )
  })
})

/* -------------------------------------------------------------------- orgDetail */

describe('orgDetail', () => {
  it('shows the organization, its billing, members and teams, ordered by name', async () => {
    const t = newT()
    const { f, pending, empty, banExpires, sessionCreated } = await peopleFixture(t)
    const asOp = await operator(t)

    const detail = await asOp.action(api.adminPeople.orgDetail, { org_id: f.org.id })

    expect(detail.org).toEqual({ id: f.org.id, name: 'Testbed Labs', created_at: NOW })
    expect(detail.billing).toEqual({ plan: 'team', seats: 5, renewal_date: null })
    expect(detail.members.map((m) => m.name)).toEqual([
      'Pending',
      'Relay',
      'admin',
      'guest',
      'user',
      'viewer',
    ])
    expect(detail.members.find((m) => m.profile_id === f.viewer.id)).toEqual({
      profile_id: f.viewer.id,
      name: 'viewer',
      email: 'viewer@testbed.test',
      org_role: 'viewer',
      kind: 'person',
      active: true,
      has_login: true,
      last_sign_in_at: new Date(sessionCreated).toISOString(),
      banned_until: new Date(banExpires).toISOString(),
      created_at: NOW,
      invite: null,
    })
    // the newest invitation email, past the newer role change
    expect(detail.members.find((m) => m.profile_id === pending.id)?.invite).toEqual({
      sent: true,
      at: '2026-01-02T00:00:00.000Z',
    })
    expect(detail.members.find((m) => m.profile_id === f.agent.id)?.invite).toBeNull()
    expect(detail.teams).toEqual([
      { id: empty, name: 'Analog', member_count: 0, project_count: 0 },
      { id: f.team.id, name: 'Hardware', member_count: 2, project_count: 1 },
    ])
  })

  it('refuses an organization that does not exist', async () => {
    const t = newT()
    const asOp = await operator(t)
    await expectRefusal(
      asOp.action(api.adminPeople.orgDetail, { org_id: uuid() }),
      'not_found',
      /organization not found/,
    )
  })

  it('gives the same answer when every page holds one row or one byte', async () => {
    const t = newT()
    const { f } = await peopleFixture(t)
    const asOp = await operator(t)
    const expected = await asOp.action(api.adminPeople.orgDetail, { org_id: f.org.id })

    // every invitation and every team count is read on its own
    Object.assign(PEOPLE_PAGE, ONE)
    expect(await asOp.action(api.adminPeople.orgDetail, { org_id: f.org.id })).toEqual(expected)
    Object.assign(PEOPLE_PAGE, { ...DEFAULT_PEOPLE, bytes: 1 })
    expect(await asOp.action(api.adminPeople.orgDetail, { org_id: f.org.id })).toEqual(expected)
  })

  it('finds an invitation older than a page of the seat audit rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const asOp = await operator(t)
    const seat = await plantSeat(t, { org_id: f.org.id, name: 'Long', email: 'long@testbed.test' })
    await t.run(async (ctx) => {
      await ctx.db.insert(
        'platform_audit_log',
        inviteRow(seat.id, f.org.id, 'long@testbed.test', '2026-01-02T00:00:00.000Z', false),
      )
      // newer letters to an earlier address say nothing about this one
      for (let i = 0; i < 30; i++) {
        const ts = new Date(Date.parse('2026-01-03T00:00:00.000Z') + i * 1000).toISOString()
        await ctx.db.insert(
          'platform_audit_log',
          inviteRow(seat.id, f.org.id, 'old@testbed.test', ts, true),
        )
      }
    })
    Object.assign(PEOPLE_PAGE, { invites: 5, audit: 7 })

    const detail = await asOp.action(api.adminPeople.orgDetail, { org_id: f.org.id })

    expect(detail.members.find((m) => m.profile_id === seat.id)?.invite).toEqual({
      sent: false,
      at: '2026-01-02T00:00:00.000Z',
    })
  })

  it('counts a team of 3,000 members on its own, under 2,500 documents a read', async () => {
    const t = newT({ transactionLimits: { documentsRead: 2500 } })
    const f = await withOrg(t)
    const asOp = await operator(t)
    for (let batch = 0; batch < 3; batch++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 1000; i++) {
          await ctx.db.insert('team_members', {
            team_id: f.team.id,
            profile_id: uuid(),
            is_leader: false,
          })
        }
      })
    }

    const detail = await asOp.action(api.adminPeople.orgDetail, { org_id: f.org.id })
    expect(detail.teams).toEqual([
      { id: f.team.id, name: 'Hardware', member_count: 3002, project_count: 0 },
    ])

    // Counted with its team, the list passes the limit, as in the old query.
    Object.assign(PEOPLE_PAGE, { children: 5000 })
    await expect(asOp.action(api.adminPeople.orgDetail, { org_id: f.org.id })).rejects.toThrow(
      /Scanned too many documents/,
    )
  })
})
