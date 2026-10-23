/* The operator console's Users page and organization page (adminPeople.ts).
 * Every action refuses every caller but an operator, and refuses a demo
 * deployment. The suite checks the Users page rows (userPage) against the
 * fields Users.tsx destructures,
 * including the banned_until mapping from Better Auth's
 * { banned, banExpires } and the newest-session last_sign_in_at, through the
 * real local component. It writes out orgDetail on a small fixture, and
 * checks both answers again at the smallest page sizes. It also covers a
 * pending seat whose invitation is older than a page of its audit rows, a
 * team counted on its own, a login with many sessions, and a deployment too
 * large for the old single query. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, components } from '../_generated/api'
import * as peopleModule from '../adminPeople'
import { type AdminUserPage, PEOPLE_PAGE } from '../adminPeople'
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
const DAY = 86_400_000

afterEach(() => {
  Object.assign(PEOPLE_PAGE, DEFAULT_PEOPLE)
  vi.unstubAllEnvs()
})

/* The smallest page of every kind. */
const ONE = {
  profiles: 1,
  users: 1,
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
      track_delay_default: false,
      created_at: NOW,
    })
    await ctx.db.patch(f.sub2._id, { team_id: f.team.id })
  })
  return { f, pending, empty, banExpires, sessionCreated }
}

type PublicName = 'userPage' | 'orgDetail'
const CALLS: Record<PublicName, (caller: Pick<T, 'action'>, f: OrgFixture) => Promise<unknown>> = {
  userPage: (caller) => caller.action(api.adminPeople.userPage, { search: '', cursor: null }),
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

/* -------------------------------------------------------------------- the Users page */

type Operator = Awaited<ReturnType<typeof operator>>

/** Every userPage page for `search`, in order. */
async function userPages(asOp: Operator, search: string) {
  const pages: AdminUserPage[] = []
  let cursor: string | null = null
  do {
    const page: AdminUserPage = await asOp.action(api.adminPeople.userPage, { search, cursor })
    pages.push(page)
    cursor = page.next
  } while (cursor !== null)
  return pages
}

/** Every Users page row for `search`, by organization name and then name,
 * so answers read at different page sizes compare equal. */
async function allUsers(asOp: Operator, search: string) {
  const rows = (await userPages(asOp, search)).flatMap((page) => page.rows)
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return rows.sort((a, b) => cmp(a.org_name, b.org_name) || cmp(a.name, b.name))
}

describe('the Users page', () => {
  it('returns every profile with the Users.tsx fields, maps the auth columns, and narrows on search', async () => {
    const t = newT()
    const { f, pending, banExpires, sessionCreated } = await peopleFixture(t)
    const asOp = await operator(t)

    const rows = await allUsers(asOp, '')
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

    const narrowed = await allUsers(asOp, 'viewer')
    expect(narrowed.map((r) => r.profile_id)).toEqual([f.viewer.id])
    // Fragments can appear in reverse order, and across name, email and
    // organization name.
    for (const [search, ids] of [
      ['LABS VIEW', [f.viewer.id]],
      ['  lay\ttestbed ', [f.agent.id]],
      ['testbed missing', []],
    ] as const) {
      const matches = await allUsers(asOp, search)
      expect(matches.map((r) => r.profile_id)).toEqual(ids)
    }
  })

  it('returns fewer than twice PEOPLE_PAGE.users rows a page, and every row once', async () => {
    const t = newT()
    await peopleFixture(t)
    const asOp = await operator(t)
    const expected = await allUsers(asOp, '')
    expect((await userPages(asOp, '')).map((page) => page.rows.length)).toEqual([7])

    Object.assign(PEOPLE_PAGE, { users: 2 })
    const pages = await userPages(asOp, '')
    expect(pages.map((page) => page.rows.length)).toEqual([2, 2, 2, 1])
    expect(await allUsers(asOp, '')).toEqual(expected)
    // a narrow search reads past the profiles it leaves out
    const narrowed = await userPages(asOp, 'labs')
    expect(narrowed.flatMap((page) => page.rows).map((r) => r.org_name)).toEqual(
      Array(6).fill('Testbed Labs'),
    )
    expect(narrowed.every((page) => page.rows.length < 4)).toBe(true)
  })

  it('reads full pages of profiles however few rows a page still needs', async () => {
    const t = newT()
    const f = await withOrg(t)
    const asOp = await operator(t)
    // Reads of three profiles: profiles that do not match up to a read's
    // start, then two matches and seven that do not, then two more matches.
    await t.run(async (ctx) => {
      const before = (await ctx.db.query('profiles').collect()).length
      const pad = Array((3 - (before % 3)) % 3).fill('Hay')
      const hay = Array(7).fill('Hay')
      for (const name of [...pad, 'Needle 1', 'Needle 2', ...hay, 'Needle 3', 'Needle 4'])
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name,
          initials: 'NH',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
    })
    Object.assign(PEOPLE_PAGE, { users: 3 })
    // The fourth read takes the last two matches together. Reads shrunk to
    // the one row still needed would stop after the third match.
    const pages = await userPages(asOp, 'needle')
    expect(pages.map((page) => page.rows.map((row) => row.name))).toEqual([
      ['Needle 1', 'Needle 2', 'Needle 3', 'Needle 4'],
    ])
  })

  it('reads one session of a login that holds many, the newest', async () => {
    const t = newT({ transactionLimits: { documentsRead: 1500 } })
    const { f } = await peopleFixture(t)
    const asOp = await operator(t)
    const now = Date.now()
    for (let batch = 0; batch < 2; batch++) {
      for (let i = 0; i < 800; i++) {
        const createdAt = now - 10 * DAY + batch * 800 + i
        await t.mutation(components.betterAuth.adapter.create, {
          input: {
            model: 'session',
            data: {
              token: uuid(),
              userId: f.user.auth_user_id!,
              expiresAt: now + DAY,
              createdAt,
              updatedAt: createdAt,
            },
          },
        })
      }
    }
    const rows = await allUsers(asOp, '')
    expect(rows.find((r) => r.profile_id === f.user.id)?.last_sign_in_at).toBe(
      new Date(now - 10 * DAY + 1599).toISOString(),
    )
  })

  it('leaves out a profile whose organization is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const asOp = await operator(t)
    await t.run(async (ctx) => {
      await ctx.db.delete(f.otherOrg._id)
    })
    const rows = await allUsers(asOp, '')
    expect(rows.map((r) => r.profile_id)).not.toContain(f.otherAdmin.id)
    expect(rows).toHaveLength(5)
  })

  it('gives the same rows when every page holds one row or one byte', async () => {
    const t = newT()
    await peopleFixture(t)
    const asOp = await operator(t)
    const expected = await allUsers(asOp, '')

    Object.assign(PEOPLE_PAGE, ONE)
    expect(await allUsers(asOp, '')).toEqual(expected)
    Object.assign(PEOPLE_PAGE, { ...DEFAULT_PEOPLE, bytes: 1 })
    expect(await allUsers(asOp, '')).toEqual(expected)
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

    const pages = await userPages(asOp, '')
    expect(pages.map((page) => page.rows.length)).toEqual([1000, 1000, 1000, 6])

    // One page for the whole deployment reads every profile, as the old
    // single query did, and fails under the same limit.
    Object.assign(PEOPLE_PAGE, { profiles: 4000, users: 4000 })
    await expect(
      asOp.action(api.adminPeople.userPage, { search: '', cursor: null }),
    ).rejects.toThrow(/Scanned too many documents/)
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
            org_id: f.org.id,
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
