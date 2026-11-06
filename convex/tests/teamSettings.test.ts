/* Settings › Teams, a team's page and its Add member picker read from the
 * server (teams.ts settingsPage, get, members and addable, through
 * model/teams.ts):
 *
 *   1. settingsPage: who reads which teams, name order, search, cursors,
 *      `through`, counts, the number of teams and readiness.
 *   2. get: the team, its count and the caller's rights, each its write's
 *      rule, and `unavailable` alike for every team the caller's
 *      organization does not hold.
 *   3. members: the members REST and MCP list, with their fields, the
 *      search against the copy, readiness and the audience.
 *   4. addable: the people who may join, members left out however their
 *      copy stands, and the refusals of the add.
 *   5. Reads at the design size, one figure a case, logged for the
 *      coordinator's timing and recorded in the report. */

import { ConvexError, compareValues } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACCESS_NEEDS_A_PERSON } from '../lib/access'
import { LIST_BATCH } from '../lib/limits'
import { type ListBatch, NAMED_READ } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { UNKEYED_MOST } from '../model/projectSettings'
import { insertTeamCount } from '../model/teamCounts'
import {
  addableOf,
  NOT_TEAM_CURSOR,
  settingsMembersOf,
  settingsTeamsOf,
  TEAM_LIST_REFUSAL,
  TEAM_RUNS_RULE,
  teamSettingsOf,
} from '../model/teams'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantLogin,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import { teamJson } from './teamMembers.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'team-settings-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_UNKEYED = { ...UNKEYED_MOST }
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(UNKEYED_MOST, DEFAULT_UNKEYED)
})

/* ------------------------------------------------------------- fixture */

type Fx = OrgFixture & { t: T }

/* withOrg with both organizations keyed, as on a deployment, and Hardware
 * counted with its two members: the user, who leads it, and the admin. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) => insertTeamCount(ctx, f.team, 2))
  await keyOrg(t, f.org.id)
  await keyOrg(t, f.otherOrg.id)
  return { t, ...f }
}

/* Teams of organization `orgId` with these names, keyed and counted with
 * no members, in one transaction. */
const plantTeams = (t: T, orgId: string, names: readonly string[]): Promise<Doc<'teams'>[]> =>
  t.run(async (ctx) => {
    const out: Doc<'teams'>[] = []
    for (const name of names) {
      const _id = await ctx.db.insert('teams', {
        id: uuid(),
        org_id: orgId,
        name,
        name_key: nameKey(name),
        track_delay_default: true,
        created_at: NOW,
      })
      const team = (await ctx.db.get(_id)) as Doc<'teams'>
      await insertTeamCount(ctx, team, 0)
      out.push(team)
    }
    return out
  })

/* People of organization `orgId`, keyed, in one transaction. */
const plantPeople = (
  t: T,
  orgId: string,
  people: (Partial<Doc<'profiles'>> & { name: string })[],
): Promise<Doc<'profiles'>[]> =>
  t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (const p of people) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: orgId,
        initials: 'PP',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        auth_user_id: 'planted-login',
        plannable_hours: 40,
        created_at: NOW,
        name_key: nameKey(p.name),
        ...p,
      })
      out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    return out
  })

/* An ordinary name of about 20 characters for person `n`. */
const personName = (n: number) => `Person ${String(n).padStart(4, '0')} Example`

/* `count` people named personName(from) and on. */
const plantMany = (t: T, orgId: string, count: number, from = 0) =>
  plantPeople(
    t,
    orgId,
    Array.from({ length: count }, (_, i) => ({ name: personName(from + i) })),
  )

/* Memberships of `team` for `profiles`, each with its copy of the person's
 * name key unless `over` says otherwise, planted raw without moving the
 * count. */
const plantMembers = (
  t: T,
  team: Doc<'teams'>,
  profiles: readonly Doc<'profiles'>[],
  over: Partial<Doc<'team_members'>> = {},
) =>
  t.run(async (ctx) => {
    for (const profile of profiles)
      await ctx.db.insert('team_members', {
        team_id: team.id,
        profile_id: profile.id,
        is_leader: false,
        name_key: nameKey(profile.name),
        ...over,
      })
  })

/* Sets team `team`'s count row to `members`. */
const setCount = (t: T, team: Doc<'teams'>, members: number) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('team_counts')
      .withIndex('by_team', (q) => q.eq('team_id', team.id))
      .unique()
    if (row === null) await insertTeamCount(ctx, team, members)
    else await ctx.db.patch(row._id, { members })
  })

/* The reads, through the public queries for a caller with a login. */
const read = {
  teams: (
    t: T,
    me: Doc<'profiles'>,
    a: { search?: string; after?: string; through?: string } = {},
  ) => as(t, me).query(api.teams.settingsPage, { org_id: me.org_id, ...a }),
  get: (t: T, me: Doc<'profiles'>, id: string) =>
    as(t, me).query(api.teams.get, { org_id: me.org_id, id }),
  members: (
    t: T,
    me: Doc<'profiles'>,
    team_id: string,
    a: { search?: string; after?: string; through?: string } = {},
  ) => as(t, me).query(api.teams.members, { org_id: me.org_id, team_id, ...a }),
  addable: (
    t: T,
    me: Doc<'profiles'>,
    team_id: string,
    a: { search?: string; after?: string } = {},
  ) => as(t, me).query(api.teams.addable, { org_id: me.org_id, team_id, ...a }),
}

/* `answer` as a ready batch, failing the test for any other state. */
function ready<A extends { state: string }>(answer: A): Extract<A, { state: 'ready' }> {
  if (answer.state !== 'ready') throw new Error(`expected a ready batch, got ${answer.state}`)
  return answer as Extract<A, { state: 'ready' }>
}

/* Every batch of a list from its start, `after` the last's next. */
async function walk<B extends { state: string }>(
  batch: (after?: string) => Promise<B>,
): Promise<Extract<B, { state: 'ready' }>[]> {
  const out: Extract<B, { state: 'ready' }>[] = []
  let after: string | undefined
  for (let n = 0; n < 100; n++) {
    const one = ready(await batch(after))
    out.push(one)
    const next = (one as unknown as ListBatch<unknown>).next
    if (next === null) return out
    after = next
  }
  throw new Error('the list did not end')
}

/* The server's order of rows with `name` and `id`: the name key in
 * Convex's byte order, then the id. */
const byKey = (rows: { name: string; id: string }[]) =>
  [...rows].sort((a, b) => compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id]))

/* Names whose byte order differs from localeCompare and from JavaScript's
 * `<`: a private use character (U+E000) sorts before an emoji past U+FFFF
 * in UTF-8, after it in UTF-16. */
const PLANTED = ['Zulu crew', 'alpha crew', 'Émile crew', ' crew', '😀 crew']

/* ----------------------------------------------------- 1. settingsPage */

describe('teams.settingsPage', () => {
  it("lists every team for an admin in the name key's byte order, with counts from team_counts", async () => {
    const fx = await setup()
    const planted = await plantTeams(fx.t, fx.org.id, PLANTED)
    await plantTeams(fx.t, fx.otherOrg.id, ['Elsewhere crew'])
    const all = [fx.team, ...planted]
    const want = byKey(all)
    // the planted names put the server's order apart from the browser's
    expect(want.map((r) => r.name)).not.toEqual(
      [...all].sort((a, b) => a.name.localeCompare(b.name)).map((r) => r.name),
    )
    const batch = ready(await read.teams(fx.t, fx.admin))
    expect(batch.rows.map((r) => r.id)).toEqual(want.map((r) => r.id))
    expect(batch).toMatchObject({ next: null, stopped: false, teams: 3 })
    expect(batch.rows.find((r) => r.id === fx.team.id)).toEqual({
      id: fx.team.id,
      name: 'Hardware',
      member_count: 2,
    })
    expect(batch.rows.filter((r) => r.id !== fx.team.id).map((r) => r.member_count)).toEqual(
      Array(PLANTED.length).fill(0),
    )
  })

  it('lists for anyone else who may lead only the teams their own leader row leads, and refuses who cannot lead', async () => {
    const fx = await setup()
    const [a, b, c, d] = await plantTeams(fx.t, fx.org.id, ['Alpha', 'Beta', 'Gamma', 'Delta'])
    const lead = await plantLogin(fx.t, await plantSeat(fx.t, { org_id: fx.org.id, name: 'Lee' }))
    await keyOrg(fx.t, fx.org.id)
    await plantMembers(fx.t, a, [lead], { is_leader: true })
    await plantMembers(fx.t, c, [lead], { is_leader: true })
    // a membership that is not a leader's row grants nothing
    await plantMembers(fx.t, b, [lead])
    expect(ready(await read.teams(fx.t, lead)).rows.map((r) => r.name)).toEqual(['Alpha', 'Gamma'])
    // the user leads Hardware alone; a member who leads none reads an end
    expect(ready(await read.teams(fx.t, fx.user)).rows.map((r) => r.id)).toEqual([fx.team.id])
    const none = await plantLogin(fx.t, await plantSeat(fx.t, { org_id: fx.org.id, name: 'Nia' }))
    await plantMembers(fx.t, d, [none])
    expect(ready(await read.teams(fx.t, none))).toMatchObject({ rows: [], next: null })
    // a viewer's leader row, a guest's and an agent's grant nothing: each
    // is refused before anything is read
    await plantMembers(fx.t, a, [fx.viewer, fx.guest, fx.agent], { is_leader: true })
    expect(await read.teams(fx.t, fx.viewer)).toEqual({
      state: 'refused',
      message: TEAM_LIST_REFUSAL,
    })
    expect(await read.teams(fx.t, fx.guest)).toEqual({
      state: 'refused',
      message: TEAM_LIST_REFUSAL,
    })
    expect(await fx.t.run((ctx) => settingsTeamsOf(ctx, fx.agent, {}))).toEqual({
      state: 'refused',
      message: TEAM_LIST_REFUSAL,
    })
  })

  it('searches every team before the batch is cut, and continues a search with Load more', async () => {
    const fx = await setup()
    const names = Array.from({ length: 30 }, (_, i) => `Team ${String(i).padStart(2, '0')} Ops`)
    await plantTeams(fx.t, fx.org.id, [...names, 'Zebra Ops', 'Zeta Ops'])
    const zed = ready(await read.teams(fx.t, fx.admin, { search: 'z OPS' }))
    expect(zed.rows.map((r) => r.name)).toEqual(['Zebra Ops', 'Zeta Ops'])
    expect(zed.next).toBeNull()
    const ops = await walk((after) => read.teams(fx.t, fx.admin, { search: 'ops', after }))
    expect(ops.map((b) => b.rows.length)).toEqual([LIST_BATCH, 32 - LIST_BATCH])
    expect(ready(await read.teams(fx.t, fx.admin, { search: 'nothing' }))).toMatchObject({
      rows: [],
      next: null,
      stopped: false,
    })
  })

  it("refuses a cursor of another organization, caller, search or list with the list's sentence", async () => {
    const fx = await setup()
    await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 30 }, (_, i) => `Team ${i}`),
    )
    await plantTeams(
      fx.t,
      fx.otherOrg.id,
      Array.from({ length: 30 }, (_, i) => `Team ${i}`),
    )
    await plantMembers(fx.t, fx.team, await plantMany(fx.t, fx.org.id, 30))
    const first = ready(await read.teams(fx.t, fx.admin))
    const next = first.next ?? ''
    const foreign = ready(await read.teams(fx.t, fx.otherAdmin)).next ?? ''
    const members = ready(await read.members(fx.t, fx.admin, fx.team.id)).next ?? ''
    expect([next, foreign, members]).not.toContain('')
    const refusal = new RegExp(`^${NOT_TEAM_CURSOR.replace(/[.;]/g, '\\$&')}$`)
    await expectRefusal(read.teams(fx.t, fx.admin, { after: foreign }), 'bad_request', refusal)
    await expectRefusal(
      read.teams(fx.t, fx.admin, { after: next, search: 'team' }),
      'bad_request',
      refusal,
    )
    // a leader's cursor is sealed with the leader
    const lead = await plantLogin(fx.t, await plantSeat(fx.t, { org_id: fx.org.id, name: 'Lee' }))
    await expectRefusal(read.teams(fx.t, lead, { after: next }), 'bad_request', refusal)
    // a cursor of the members list, and text that is no cursor
    await expectRefusal(read.teams(fx.t, fx.admin, { after: members }), 'bad_request', refusal)
    await expectRefusal(
      read.teams(fx.t, fx.admin, { through: 'not a cursor' }),
      'bad_request',
      refusal,
    )
    // a cursor of another team's member list
    await expectRefusal(
      read.members(fx.t, fx.admin, (await plantTeams(fx.t, fx.org.id, ['Other']))[0].id, {
        after: members,
      }),
      'bad_request',
      refusal,
    )
    // the same search under another spelling shares the cursor
    const upper = ready(await read.teams(fx.t, fx.admin, { search: 'TEAM' }))
    expect(
      ready(await read.teams(fx.t, fx.admin, { search: 'team', after: upper.next ?? '' })).rows,
    ).toHaveLength(30 - LIST_BATCH)
  })

  it('keeps a pinned batch live as a team lands inside it', async () => {
    const fx = await setup()
    await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 30 }, (_, i) => `Team ${String(i).padStart(2, '0')}`),
    )
    const first = ready(await read.teams(fx.t, fx.admin))
    expect(first.rows).toHaveLength(LIST_BATCH)
    const through = first.next ?? ''
    const pinned = () => read.teams(fx.t, fx.admin, { through })
    expect(ready(await pinned()).rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id))
    const [landed] = await plantTeams(fx.t, fx.org.id, ['Team 05 and a half'])
    const grown = ready(await pinned())
    expect(grown.rows).toHaveLength(LIST_BATCH + 1)
    expect(grown.rows.map((r) => r.id)).toContain(landed.id)
    // the batch ends where it did, so the next one starts where it did
    expect(grown).toMatchObject({ next: through, stopped: false })
  })

  it('answers a missing count, one being counted and one of another organization as null, never 0', async () => {
    const fx = await setup()
    const [counted, missing, counting, foreign] = await plantTeams(fx.t, fx.org.id, [
      'A counted',
      'B missing',
      'C counting',
      'D foreign row',
    ])
    await setCount(fx.t, counted, 7)
    await fx.t.run(async (ctx) => {
      const rowOf = (team: Doc<'teams'>) =>
        ctx.db
          .query('team_counts')
          .withIndex('by_team', (q) => q.eq('team_id', team.id))
          .unique()
      const gone = await rowOf(missing)
      if (gone) await ctx.db.delete(gone._id)
      const run = await rowOf(counting)
      if (run) await ctx.db.patch(run._id, { through: 1 })
      const other = await rowOf(foreign)
      if (other) await ctx.db.patch(other._id, { org_id: fx.otherOrg.id })
    })
    const rows = ready(await read.teams(fx.t, fx.admin)).rows
    const count = (team: Doc<'teams'>) => rows.find((r) => r.id === team.id)?.member_count
    expect([counted, missing, counting, foreign].map(count)).toEqual([7, null, null, null])
  })

  it('says how many teams the organization holds, up to three, whatever the search or the batch', async () => {
    const fx = await setup()
    expect(ready(await read.teams(fx.t, fx.admin)).teams).toBe(1)
    expect(ready(await read.teams(fx.t, fx.admin, { search: 'nothing' })).teams).toBe(1)
    await plantTeams(fx.t, fx.org.id, ['Second'])
    expect(ready(await read.teams(fx.t, fx.admin, { search: 'second' })).teams).toBe(2)
    expect(ready(await read.teams(fx.t, fx.user)).teams).toBe(2)
    await plantTeams(fx.t, fx.org.id, ['Third', 'Fourth'])
    expect(ready(await read.teams(fx.t, fx.admin)).teams).toBe(3)
  })

  it('answers not_ready until the name keys are written, and a stopped batch with a cursor where the budget ends', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await read.teams(t, f.admin)).toEqual({ state: 'not_ready' })
    await keyOrg(t, f.org.id)
    await plantTeams(
      t,
      f.org.id,
      Array.from({ length: 20 }, (_, i) => `Team ${i}`),
    )
    Object.assign(NAMED_READ, { ranges: 3, documents: 6, bytes: 4 * 1024 * 1024 })
    const batch = ready(await read.teams(t, f.admin, { search: 'nothing' }))
    expect(batch.stopped).toBe(true)
    expect(batch.next).not.toBeNull()
    expect(batch.rows).toEqual([])
  })
})

/* --------------------------------------------------------------- 2. get */

describe('teams.get', () => {
  it("answers the team, its count and each right by its write's rule, for every seat", async () => {
    const fx = await setup()
    const get = (me: Doc<'profiles'>) => fx.t.run((ctx) => teamSettingsOf(ctx, me, fx.team.id))
    const ok = (can: boolean) => ({
      state: 'ok',
      team: { id: fx.team.id, name: 'Hardware' },
      member_count: 2,
      can_manage: can,
      can_manage_members: can,
    })
    expect(await read.get(fx.t, fx.admin, fx.team.id)).toEqual(ok(true))
    expect(await read.get(fx.t, fx.user, fx.team.id)).toEqual(ok(true))
    // a member who does not lead, a Viewer with an old leader row, a guest
    // and an agent with a leader row read the team and may change nothing
    const member = await plantLogin(fx.t, await plantSeat(fx.t, { org_id: fx.org.id, name: 'Mo' }))
    await plantMembers(fx.t, fx.team, [member])
    await plantMembers(fx.t, fx.team, [fx.viewer, fx.agent], { is_leader: true })
    expect(await read.get(fx.t, member, fx.team.id)).toEqual(ok(false))
    expect(await read.get(fx.t, fx.viewer, fx.team.id)).toEqual(ok(false))
    expect(await read.get(fx.t, fx.guest, fx.team.id)).toEqual(ok(false))
    expect(await get(fx.agent)).toEqual(ok(false))
    // a count the server does not have reads null
    await fx.t.run(async (ctx) => {
      const row = await ctx.db
        .query('team_counts')
        .withIndex('by_team', (q) => q.eq('team_id', fx.team.id))
        .unique()
      if (row) await ctx.db.patch(row._id, { through: 1 })
    })
    expect(await read.get(fx.t, fx.admin, fx.team.id)).toMatchObject({ member_count: null })
  })

  it('needs a person for the membership rights, as the membership writes do', async () => {
    const fx = await setup()
    // an agent with the admin role, which no write makes today
    const admin = await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.agent._id, { org_role: 'admin' })
      return (await ctx.db.get(fx.agent._id)) as Doc<'profiles'>
    })
    expect(await fx.t.run((ctx) => teamSettingsOf(ctx, admin, fx.team.id))).toMatchObject({
      state: 'ok',
      can_manage: true,
      can_manage_members: false,
    })
  })

  it('answers unavailable alike for an unknown id, a team of another organization and a deleted one', async () => {
    const fx = await setup()
    const [foreign] = await plantTeams(fx.t, fx.otherOrg.id, ['Elsewhere'])
    const [gone] = await plantTeams(fx.t, fx.org.id, ['Gone'])
    await fx.t.run((ctx) => ctx.db.delete(gone._id))
    for (const id of [uuid(), foreign.id, gone.id, ''])
      expect(await read.get(fx.t, fx.admin, id), id).toEqual({ state: 'unavailable' })
    expect(await read.members(fx.t, fx.admin, foreign.id)).toEqual({ state: 'unavailable' })
    expect(await read.addable(fx.t, fx.admin, foreign.id)).toEqual({ state: 'unavailable' })
  })
})

/* ----------------------------------------------------------- 3. members */

describe('teams.members', () => {
  it('lists the members REST and MCP list, in the order of their copies, with the fields the rows need', async () => {
    const fx = await setup()
    const people = await plantPeople(fx.t, fx.org.id, [
      ...PLANTED.map((name) => ({ name })),
      { name: 'Ina invited', auth_user_id: undefined },
      { name: 'Oli off', active: false, plannable_hours: undefined },
    ])
    await plantMembers(fx.t, fx.team, people)
    // a Viewer's and an agent's old leader rows show, and cannot lead
    await plantMembers(fx.t, fx.team, [fx.viewer, fx.agent], { is_leader: true })
    // a guest's stale membership and a profile of another organization
    await plantMembers(fx.t, fx.team, [fx.guest, fx.otherAdmin])
    const rows = (
      await walk((after) => read.members(fx.t, fx.admin, fx.team.id, { after }))
    ).flatMap((b) => b.rows)
    const oracle = await fx.t.run((ctx) => teamJson(ctx, fx.team))
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(oracle.members.map((m) => m.id)))
    expect(rows.map((r) => r.id)).toEqual(byKey(rows).map((r) => r.id))
    expect(rows.map((r) => r.id)).not.toContain(fx.guest.id)
    expect(rows.map((r) => r.id)).not.toContain(fx.otherAdmin.id)
    const row = (id: string) => rows.find((r) => r.id === id)
    expect(row(fx.user.id)).toEqual({
      id: fx.user.id,
      name: 'user',
      org_role: 'user',
      kind: 'person',
      active: true,
      pending: false,
      is_leader: true,
      can_lead: true,
      plannable_hours: 40,
    })
    expect(row(fx.viewer.id)).toMatchObject({ is_leader: true, can_lead: false })
    expect(row(fx.agent.id)).toMatchObject({ is_leader: true, can_lead: false, kind: 'agent' })
    expect(row(people[5].id)).toMatchObject({ pending: true, active: true })
    expect(row(people[6].id)).toMatchObject({ active: false, plannable_hours: null })
  })

  it('matches the search against the copy before the profile is read', async () => {
    const fx = await setup()
    const [ren] = await plantPeople(fx.t, fx.org.id, [{ name: 'Renamed person' }])
    // the copy trails a rename to "Renamed person"
    await plantMembers(fx.t, fx.team, [ren], { name_key: nameKey('Earlier name') })
    expect(
      ready(await read.members(fx.t, fx.admin, fx.team.id, { search: 'earlier' })).rows,
    ).toEqual([expect.objectContaining({ id: ren.id, name: 'Renamed person' })])
    expect(
      ready(await read.members(fx.t, fx.admin, fx.team.id, { search: 'renamed' })).rows,
    ).toEqual([])
  })

  it('answers every seat of the organization, as REST and MCP do', async () => {
    const fx = await setup()
    const ids = async (me: Doc<'profiles'>) =>
      ready(await fx.t.run((ctx) => settingsMembersOf(ctx, me, { team_id: fx.team.id }))).rows.map(
        (r) => r.id,
      )
    const all = await ids(fx.admin)
    expect(all).toHaveLength(2)
    for (const me of [fx.user, fx.viewer, fx.guest, fx.agent]) expect(await ids(me)).toEqual(all)
    expect(ready(await read.members(fx.t, fx.guest, fx.team.id)).rows).toHaveLength(2)
  })

  it('answers not_ready without name keys, for an unkeyed membership of a member and past UNKEYED_MOST', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await read.members(t, f.admin, f.team.id)).toEqual({ state: 'not_ready' })
    await keyOrg(t, f.org.id)
    expect(ready(await read.members(t, f.admin, f.team.id)).rows).toHaveLength(2)
    // a membership without a copy, of a person of the organization
    const [late] = await plantPeople(t, f.org.id, [{ name: 'Late copy' }])
    await t.run((ctx) =>
      ctx.db.insert('team_members', { team_id: f.team.id, profile_id: late.id, is_leader: false }),
    )
    expect(await read.members(t, f.admin, f.team.id)).toEqual({ state: 'not_ready' })
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('team_members')
        .withIndex('by_team_profile', (q) => q.eq('team_id', f.team.id).eq('profile_id', late.id))
        .unique()
      if (row) await ctx.db.delete(row._id)
    })
    // unkeyed memberships whose profiles are gone are left out, up to the bound
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++)
        await ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: uuid(),
          is_leader: false,
        })
    })
    expect(ready(await read.members(t, f.admin, f.team.id)).rows).toHaveLength(2)
    UNKEYED_MOST.rows = 2
    expect(await read.members(t, f.admin, f.team.id)).toEqual({ state: 'not_ready' })
  })

  it('stops a pinned batch that would hold more than four batches, for the app to split', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 30)
    await plantMembers(fx.t, fx.team, people)
    const first = ready(await read.members(fx.t, fx.admin, fx.team.id))
    const through = first.next ?? ''
    // 90 people who sort inside the first batch
    const inside = await plantPeople(
      fx.t,
      fx.org.id,
      Array.from({ length: 90 }, (_, i) => ({ name: `Admin ${String(i).padStart(2, '0')}` })),
    )
    await plantMembers(fx.t, fx.team, inside)
    const wide = ready(await read.members(fx.t, fx.admin, fx.team.id, { through }))
    expect(wide.rows).toHaveLength(4 * LIST_BATCH)
    expect(wide.stopped).toBe(true)
    const rest = ready(
      await read.members(fx.t, fx.admin, fx.team.id, { after: wide.next ?? '', through }),
    )
    expect(rest).toMatchObject({ stopped: false, next: through })
    expect(wide.rows.length + rest.rows.length).toBe(LIST_BATCH + 90)
  })
})

/* ----------------------------------------------------------- 4. addable */

describe('teams.addable', () => {
  it("offers the organization's people who are not members, switched-off and invited ones included, never guests", async () => {
    const fx = await setup()
    const [off, invited, trailing, uncopied, joiner] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Oli off', active: false },
      { name: 'Ina invited', auth_user_id: undefined },
      { name: 'Trailing copy' },
      { name: 'Unkeyed copy' },
      { name: 'Jo joiner' },
    ])
    // members whose copy trails a rename or is missing are left out too
    await plantMembers(fx.t, fx.team, [trailing], { name_key: nameKey('Zzz earlier name') })
    await plantMembers(fx.t, fx.team, [uncopied], { name_key: undefined })
    await plantPeople(fx.t, fx.otherOrg.id, [{ name: 'Foreign person' }])
    const rows = ready(await read.addable(fx.t, fx.admin, fx.team.id)).rows
    const ids = rows.map((r) => r.id)
    expect(ids).toEqual(byKey([fx.viewer, fx.agent, off, invited, joiner]).map((r) => r.id))
    // admin and user are members (withOrg), the guest is never offered
    for (const out of [fx.admin, fx.user, fx.guest, trailing, uncopied, fx.otherAdmin])
      expect(ids).not.toContain(out.id)
    expect(rows.find((r) => r.id === off.id)).toMatchObject({ active: false, pending: false })
    expect(rows.find((r) => r.id === invited.id)).toMatchObject({ active: true, pending: true })
    expect(rows.find((r) => r.id === fx.agent.id)).toMatchObject({ kind: 'agent' })
    // a search over the whole list, and a member's old name finds nobody
    expect(ready(await read.addable(fx.t, fx.admin, fx.team.id, { search: 'jo' })).rows).toEqual([
      expect.objectContaining({ id: joiner.id }),
    ])
    expect(ready(await read.addable(fx.t, fx.admin, fx.team.id, { search: 'zzz' })).rows).toEqual(
      [],
    )
  })

  it('refuses as the add refuses, and answers a leader and an admin', async () => {
    const fx = await setup()
    const member = await plantLogin(fx.t, await plantSeat(fx.t, { org_id: fx.org.id, name: 'Mo' }))
    await keyOrg(fx.t, fx.org.id)
    await plantMembers(fx.t, fx.team, [member])
    expect(await fx.t.run((ctx) => addableOf(ctx, fx.agent, { team_id: fx.team.id }))).toEqual({
      state: 'refused',
      message: ACCESS_NEEDS_A_PERSON,
    })
    for (const me of [member, fx.viewer, fx.guest])
      expect(await read.addable(fx.t, me, fx.team.id)).toEqual({
        state: 'refused',
        message: TEAM_RUNS_RULE,
      })
    expect(ready(await read.addable(fx.t, fx.user, fx.team.id)).rows.length).toBeGreaterThan(0)
    expect(ready(await read.addable(fx.t, fx.admin, fx.team.id)).rows.length).toBeGreaterThan(0)
    // the add checks again: a person offered who joined meanwhile changes nothing
    const [late] = await plantPeople(fx.t, fx.org.id, [{ name: 'Late joiner' }])
    expect(
      ready(await read.addable(fx.t, fx.admin, fx.team.id, { search: 'late' })).rows,
    ).toHaveLength(1)
    await as(fx.t, fx.admin).mutation(api.teams.addMember, {
      org_id: fx.org.id,
      team_id: fx.team.id,
      profile_id: late.id,
    })
    expect(ready(await read.addable(fx.t, fx.admin, fx.team.id, { search: 'late' })).rows).toEqual(
      [],
    )
  })

  it('answers not_ready without name keys', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await read.addable(t, f.admin, f.team.id)).toEqual({ state: 'not_ready' })
  })
})

/* ------------------------------------------------- 5. the design size */

/** What one transaction read, from Convex's metrics. */
type Read = { ranges: number; documents: number; bytes: number }

/** `run` in its own transaction, with what that transaction read. */
async function measured<R>(
  t: T,
  run: (ctx: QueryCtx) => Promise<R>,
): Promise<{ out: R; read: Read }> {
  return await t.run(async (ctx) => {
    const out = await run(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      out,
      read: {
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        bytes: m.bytesRead.used,
      },
    }
  })
}

/* Logs `read` under `name` and checks it inside one call's share. */
function logged(name: string, read: Read, rows: number) {
  console.log(
    `[team settings at the design size] ${name}: ${rows} rows, ${read.ranges} ranges, ` +
      `${read.documents} documents, ${(read.bytes / 1e6).toFixed(2)} MB`,
  )
  expect(read.ranges).toBeLessThanOrEqual(NAMED_READ.ranges + 16)
  expect(read.documents).toBeLessThanOrEqual(NAMED_READ.documents + 64)
  expect(read.bytes).toBeLessThan(NAMED_READ.bytes + 64 * 1024)
}

/* The teams figure: 50 teams, Hardware and 49 more with 3 to 10 members,
 * in an organization of 300 people, about one team a person. */
async function plantTeamsFigure(fx: Fx) {
  const people = await plantMany(fx.t, fx.org.id, 295)
  const teams = await plantTeams(
    fx.t,
    fx.org.id,
    Array.from({ length: 49 }, (_, i) => `Team ${String(i).padStart(2, '0')} Operations`),
  )
  for (const [i, team] of teams.entries()) {
    const size = 3 + (i % 8)
    await plantMembers(
      fx.t,
      team,
      Array.from({ length: size }, (_, k) => people[(i * 6 + k) % people.length]),
    )
    await setCount(fx.t, team, size)
  }
  return teams
}

/* The people figure in one team: Hardware with every person of an
 * organization of 1,000 people (withOrg's guest taken out, since a guest
 * is never a member). */
async function plantBigTeam(fx: Fx) {
  await fx.t.run((ctx) => ctx.db.delete(fx.guest._id))
  const people = await plantMany(fx.t, fx.org.id, 996)
  await plantMembers(fx.t, fx.team, [...people, fx.viewer, fx.agent])
  await setCount(fx.t, fx.team, 1000)
  return people
}

describe('at the design size', () => {
  it('reads Settings › Teams among 50 teams, as an admin and as a leader of 3', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const teams = await plantTeamsFigure(fx)
    const admin = (a: { search?: string; after?: string; through?: string } = {}) =>
      measured(fx.t, (ctx) => settingsTeamsOf(ctx, fx.admin, a))
    const first = await admin()
    logged('settingsPage, admin, first batch of 50 teams', first.read, ready(first.out).rows.length)
    expect(ready(first.out).rows).toHaveLength(LIST_BATCH)
    const second = await admin({ after: ready(first.out).next ?? '' })
    logged('settingsPage, admin, second batch', second.read, ready(second.out).rows.length)
    expect(ready(second.out)).toMatchObject({ next: null })
    expect(ready(second.out).rows).toHaveLength(50 - LIST_BATCH)
    const pinned = await admin({ through: ready(first.out).next ?? '' })
    logged('settingsPage, admin, pinned first batch', pinned.read, ready(pinned.out).rows.length)
    const none = await admin({ search: 'nothing matches' })
    logged('settingsPage, admin, a search that matches none', none.read, 0)
    expect(ready(none.out)).toMatchObject({ rows: [], next: null, stopped: false })
    // a leader of 3 of the 50 teams, in 3 teams, the everyday value
    const lead = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Lee Leader' })
    await keyOrg(fx.t, fx.org.id)
    for (const team of [teams[10], teams[30], teams[48]])
      await plantMembers(fx.t, team, [lead], { is_leader: true })
    const leader = (a: { search?: string } = {}) =>
      measured(fx.t, (ctx) => settingsTeamsOf(ctx, lead, a))
    const leads = await leader()
    logged('settingsPage, leader of 3, first batch', leads.read, ready(leads.out).rows.length)
    expect(ready(leads.out).rows.map((r) => r.id)).toEqual([
      teams[10].id,
      teams[30].id,
      teams[48].id,
    ])
    const leadNone = await leader({ search: 'nothing matches' })
    logged('settingsPage, leader of 3, a search that matches none', leadNone.read, 0)
  })

  it("reads a team of 1,000 members among 1,000 people, and its page's get", async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    await plantBigTeam(fx)
    const members = (a: { search?: string; after?: string; through?: string } = {}) =>
      measured(fx.t, (ctx) => settingsMembersOf(ctx, fx.admin, { team_id: fx.team.id, ...a }))
    const first = await members()
    logged('members, first batch of 1,000', first.read, ready(first.out).rows.length)
    expect(ready(first.out).rows).toHaveLength(LIST_BATCH)
    let after = ready(first.out).next ?? ''
    for (let i = 0; i < 18; i++) after = ready((await members({ after })).out).next ?? ''
    const later = await members({ after })
    logged('members, the 20th batch', later.read, ready(later.out).rows.length)
    expect(ready(later.out).rows).toHaveLength(LIST_BATCH)
    const pinned = await members({ after, through: ready(later.out).next ?? '' })
    logged('members, the 20th batch pinned', pinned.read, ready(pinned.out).rows.length)
    expect(ready(pinned.out).rows).toHaveLength(LIST_BATCH)
    const none = await members({ search: 'nothing matches' })
    logged('members, a search that matches none of 1,000', none.read, 0)
    expect(ready(none.out)).toMatchObject({ rows: [], next: null, stopped: false })
    const get = await measured(fx.t, (ctx) => teamSettingsOf(ctx, fx.admin, fx.team.id))
    logged('get, a team of 1,000 members', get.read, 1)
    expect(get.out).toMatchObject({ state: 'ok', member_count: 1000 })
  })

  it('reads Add member among 1,000 people, for an everyday team and for a team of 995 members', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const people = await plantMany(fx.t, fx.org.id, 995)
    // an everyday team: Hardware's two members and 28 more
    await plantMembers(fx.t, fx.team, people.slice(500, 528))
    const choices = (team: Doc<'teams'>, a: { search?: string } = {}) =>
      measured(fx.t, (ctx) => addableOf(ctx, fx.admin, { team_id: team.id, ...a }))
    const first = await choices(fx.team)
    logged('addable, everyday team, first batch', first.read, ready(first.out).rows.length)
    expect(ready(first.out).rows).toHaveLength(LIST_BATCH)
    const none = await choices(fx.team, { search: 'nothing matches' })
    logged('addable, everyday team, a search that matches none', none.read, 0)
    expect(ready(none.out)).toMatchObject({ rows: [], next: null })
    // a team of 995 members that sort first: the first batch walks past them
    const [crowd] = await plantTeams(fx.t, fx.org.id, ['Crowd'])
    await plantMembers(fx.t, crowd, people)
    const past = await choices(crowd)
    logged('addable, a team of 995 members, first batch', past.read, ready(past.out).rows.length)
    // the only people outside the crowd are withOrg's, the guest left out
    expect(ready(past.out)).toMatchObject({ next: null, stopped: false })
    expect(ready(past.out).rows.map((r) => r.id)).toEqual(
      byKey([fx.admin, fx.agent, fx.user, fx.viewer]).map((r) => r.id),
    )
  })
})

/* -------------------------------------------------- the error contract */

it('refuses a search past LIMITS.search and a through before after as bad requests', async () => {
  const fx = await setup()
  await plantTeams(
    fx.t,
    fx.org.id,
    Array.from({ length: 60 }, (_, i) => `Team ${i}`),
  )
  const one = ready(await read.teams(fx.t, fx.admin))
  const two = ready(await read.teams(fx.t, fx.admin, { after: one.next ?? '' }))
  const e = await expectRefusal(
    read.teams(fx.t, fx.admin, { after: two.next ?? '', through: one.next ?? '' }),
    'bad_request',
    /through must be a cursor after/,
  )
  expect(e).toBeInstanceOf(ConvexError)
  await expectRefusal(read.teams(fx.t, fx.admin, { search: 'x'.repeat(201) }), 'rule')
})
