/* The team settings stand-in (store/teamSettingsStandIn.setup.ts) against
 * the real queries (convex/teams.ts settingsPage, get, members and
 * addable) on convex-test, as projectSettingsParity.test.ts holds a
 * project's Settings page to its queries. Over Northstar, with planted
 * people and teams whose names' UTF-8 byte order differs from
 * localeCompare, it compares every read from its start to its end and
 * with searches, cursors compared by where they lead, as the server seals
 * its own, with one figure at its design size a case: the teams figure
 * (50 teams) for an admin's list, a leader of 3 of them, the people
 * figure in one team (1,000 members among 1,000 people) for the member
 * list, and 1,000 people for the Add member picker of an everyday team,
 * beside everyday values of the other figures. It also compares the
 * refusals and `unavailable`. */

import { makeFunctionReference } from 'convex/server'
import { describe, expect, it, vi } from 'vitest'
import { internal } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { nameKey } from '../../convex/lib/nameKey'
import {
  as,
  NOW,
  newT,
  plantLogin,
  type T,
  uuid,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { keyOrg } from '../../convex/tests/nameKeys.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import {
  type TeamSettingsRead,
  type TeamSettingsWorkspace,
  teamSettingsStandIn,
} from './teamSettingsStandIn.setup'

vi.hoisted(() => {
  // cursors are sealed with a key derived from it (lib/archiveCursorSeal.ts)
  process.env.BETTER_AUTH_SECRET ??= 'team-settings-parity-secret-not-a-deployment-key'
})

/* Names whose name keys sort in a different order by UTF-8 bytes, which
   Convex orders strings by, than by localeCompare or UTF-16 code units. */
const PLANTED = ['Zoë Lind', 'Émile Roux', 'Øystein Berg', '😀 Bot Friend', '￮ Ring Holm']
const TEAMS = ['Østfold crew', 'Zulu team', 'Émile squad', '😀 crew', '￮ ring crew']

type Args = Record<string, unknown>
type Answer = { state: string; next?: string | null; rows?: { id: string; name: string }[] }

/** What both answer, with each cursor replaced by whether it is there. */
const shape = (a: unknown) => {
  const answer = a as Answer
  return 'next' in answer ? { ...answer, next: answer.next !== null } : answer
}

/** The query's answer and the stand-in's for read `name` with `args`, each
    following its own cursors through every batch when `all`, as `who` over
    the workspace `ws`. */
async function both(
  t: T,
  who: Doc<'profiles'>,
  ws: TeamSettingsWorkspace,
  name: TeamSettingsRead,
  args: Args,
  all = false,
): Promise<{ server: Answer[]; stand: Answer[] }> {
  const server: Answer[] = []
  const stand: Answer[] = []
  let at: { server?: string; stand?: string } = {}
  for (let round = 0; round < 100; round++) {
    const s = (await as(t, who).query(makeFunctionReference<'query'>(name), {
      ...args,
      ...(at.server === undefined ? {} : { after: at.server }),
    })) as Answer
    const o = teamSettingsStandIn(ws, name, {
      ...args,
      ...(at.stand === undefined ? {} : { after: at.stand }),
    }) as Answer
    server.push(s)
    stand.push(o)
    if (!all || !s.next || !o.next) return { server, stand }
    at = { server: s.next, stand: o.next }
  }
  throw new Error('the list did not end')
}

/** Expects the stand-in to answer read `name` with `args` as the server
    does, through every batch when `all`. Answers both walks. */
async function same(
  t: T,
  who: Doc<'profiles'>,
  ws: TeamSettingsWorkspace,
  name: TeamSettingsRead,
  args: Args,
  all = false,
) {
  const walked = await both(t, who, ws, name, args, all)
  expect(walked.stand.map(shape), `${name} ${JSON.stringify(args)}`).toEqual(
    walked.server.map(shape),
  )
  return walked
}

/* Counts every team of organization `orgId` again, as
   internal/teamCountsBackfill does, so team_counts holds what the planted
   memberships make. */
async function recount(t: T, orgId: string) {
  const teams = await t.run((ctx) =>
    ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
  )
  for (const team of teams) {
    const step = (restart: boolean) =>
      t.mutation(internal.internal.teamCountsBackfill.step, { team_id: team.id, restart })
    let got = await step(true)
    while (got === null) got = await step(false)
  }
}

/** Northstar with the planted people and teams, more teams up to `teams`
    and more people up to `people`, the planted people members of the first
    planted team, keyed and counted, with Nora, its admin. */
async function northstar(o: { teams?: number; people?: number } = {}) {
  const t = newT()
  const { org, profiles } = await plantNorthstar(t)
  const nora = profiles.find((p) => p.name === 'Nora Berg')
  if (!nora) throw new Error('no Nora')
  const planted = await t.run(async (ctx) => {
    const people: Doc<'profiles'>[] = []
    const extra = Math.max(0, (o.people ?? 0) - profiles.length - PLANTED.length)
    const names = [
      ...PLANTED,
      ...Array.from({ length: extra }, (_, i) => `Person ${String(i).padStart(4, '0')} Example`),
    ]
    for (const [i, name] of names.entries()) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: org.id,
        name,
        initials: 'PL',
        color: '#7a7ad0',
        org_role: i === 2 ? 'viewer' : 'user',
        active: i !== 1,
        kind: i === 3 ? 'agent' : 'person',
        ...(i === 4 || i === 3 ? {} : { auth_user_id: `auth_planted_${i}` }),
        plannable_hours: i === 0 ? 32 : undefined,
        created_at: NOW,
      })
      people.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    const existing = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect()
    const more = Math.max(0, (o.teams ?? 0) - existing.length - TEAMS.length)
    const teams: Doc<'teams'>[] = []
    for (const name of [
      ...TEAMS,
      ...Array.from({ length: more }, (_, i) => `Team ${String(i).padStart(2, '0')} Operations`),
    ]) {
      const _id = await ctx.db.insert('teams', {
        id: uuid(),
        org_id: org.id,
        name,
        track_delay_default: false,
        created_at: NOW,
      })
      teams.push((await ctx.db.get(_id)) as Doc<'teams'>)
    }
    // the planted five in the first planted team, the agent leading it
    for (const [i, person] of people.slice(0, PLANTED.length).entries())
      await ctx.db.insert('team_members', {
        team_id: teams[0].id,
        profile_id: person.id,
        is_leader: i === 3,
      })
    return { people, teams }
  })
  await keyOrg(t, org.id)
  await recount(t, org.id)
  const ws = await workspaceOf(as(t, nora))
  if (!ws) throw new Error('no workspace')
  return { t, org, nora, profiles, ...planted, ws }
}

/** The rows of every batch in `walk`, in order. */
const rowsOf = (walk: Answer[]) => walk.flatMap((b) => b.rows ?? [])

describe('the team settings stand-in', () => {
  it("answers an admin's Settings › Teams among 50 teams, a team's page and its picker over Northstar as the server does", async () => {
    const { t, org, nora, teams, ws } = await northstar({ teams: 50 })
    const base = { org_id: org.id }
    const list = await same(t, nora, ws, 'teams:settingsPage', base, true)
    const names = rowsOf(list.server).map((r) => r.name)
    expect(names).toHaveLength(50)
    // the server's order, which neither localeCompare nor `<` gives
    const planted = names.filter((n) => TEAMS.includes(n))
    expect(planted).not.toEqual([...planted].sort((a, b) => nameKey(a).localeCompare(nameKey(b))))
    for (const search of ['crew', 'EMILE', 'operations 4', 'nothing here'])
      await same(t, nora, ws, 'teams:settingsPage', { ...base, search }, true)
    for (const id of [teams[0].id, teams[1].id, 'no-such-team'])
      await same(t, nora, ws, 'teams:get', { ...base, id })
    const team = { ...base, team_id: teams[0].id }
    await same(t, nora, ws, 'teams:members', team, true)
    await same(t, nora, ws, 'teams:members', { ...team, search: 'berg' })
    await same(t, nora, ws, 'teams:members', { ...base, team_id: 'no-such-team' })
    await same(t, nora, ws, 'teams:addable', team, true)
    await same(t, nora, ws, 'teams:addable', { ...team, search: 'emile' })
  })

  it('answers a leader of 3 of 50 teams their list, and refuses as the server does', async () => {
    const { t, org, teams, people } = await northstar({ teams: 50 })
    // the planted Zoë leads three teams
    const [zoe] = people
    await t.run(async (ctx) => {
      for (const team of [teams[10], teams[20], teams[40]])
        await ctx.db.insert('team_members', {
          team_id: team.id,
          profile_id: zoe.id,
          is_leader: true,
          name_key: nameKey(zoe.name),
        })
    })
    await recount(t, org.id)
    const lead = await plantLogin(t, zoe)
    const ws = await workspaceOf(as(t, lead))
    if (!ws) throw new Error('no workspace')
    const base = { org_id: org.id }
    const list = await same(t, lead, ws, 'teams:settingsPage', base, true)
    expect(rowsOf(list.server)).toHaveLength(3)
    await same(t, lead, ws, 'teams:settingsPage', { ...base, search: 'nothing here' })
    await same(t, lead, ws, 'teams:get', { ...base, id: teams[10].id })
    await same(t, lead, ws, 'teams:get', { ...base, id: teams[11].id })
    await same(t, lead, ws, 'teams:addable', { ...base, team_id: teams[10].id })
    await same(t, lead, ws, 'teams:addable', { ...base, team_id: teams[11].id })
    // a Viewer is refused the list and the add, and reads the team's page
    const viewer = await plantLogin(t, people[2])
    const theirs = await workspaceOf(as(t, viewer))
    if (!theirs) throw new Error('no workspace')
    const refused = await same(t, viewer, theirs, 'teams:settingsPage', base)
    expect(refused.server[0].state).toBe('refused')
    await same(t, viewer, theirs, 'teams:addable', { ...base, team_id: teams[0].id })
    await same(t, viewer, theirs, 'teams:get', { ...base, id: teams[0].id })
    await same(t, viewer, theirs, 'teams:members', { ...base, team_id: teams[0].id }, true)
  })

  it('answers the members of a team of 1,000 among 1,000 people, batch by batch, pinned and searched, as the server does', async () => {
    const { t, org, nora, teams, people, profiles } = await northstar({ people: 1000 })
    const [big] = teams
    // everyone of the organization in one team, but its guests
    await t.run(async (ctx) => {
      const held = new Set(people.slice(0, PLANTED.length).map((p) => p.id))
      for (const p of [...profiles, ...people])
        if (!held.has(p.id) && p.org_role !== 'guest')
          await ctx.db.insert('team_members', {
            team_id: big.id,
            profile_id: p.id,
            is_leader: false,
            name_key: nameKey(p.name),
          })
    })
    await recount(t, org.id)
    const ws = await workspaceOf(as(t, nora))
    if (!ws) throw new Error('no workspace')
    const team = { org_id: org.id, team_id: big.id }
    const walk = await both(t, nora, ws, 'teams:members', team, true)
    expect(walk.stand.map(shape)).toEqual(walk.server.map(shape))
    expect(rowsOf(walk.server).length).toBeGreaterThan(950)
    // a pinned later batch, each between its own cursors
    const k = 10
    const pinned = (answers: Answer[]) => ({
      ...team,
      after: answers[k - 1].next ?? '',
      through: answers[k].next ?? '',
    })
    const s = await as(t, nora).query(
      makeFunctionReference<'query'>('teams:members'),
      pinned(walk.server),
    )
    const o = teamSettingsStandIn(ws, 'teams:members', pinned(walk.stand))
    expect(shape(o)).toEqual(shape(s))
    for (const search of ['person 0999', 'zoe', 'nothing here'])
      await same(t, nora, ws, 'teams:members', { ...team, search })
    await same(t, nora, ws, 'teams:get', { org_id: org.id, id: big.id })
  })

  it('answers the Add member picker among 1,000 people for an everyday team as the server does', async () => {
    const { t, org, nora, teams, ws } = await northstar({ people: 1000 })
    const team = { org_id: org.id, team_id: teams[0].id }
    await same(t, nora, ws, 'teams:addable', team, true)
    for (const search of ['person 05', 'emile', 'nothing here'])
      await same(t, nora, ws, 'teams:addable', { ...team, search })
  })

  it("refuses another list's cursor and a search past its limit as the server does", async () => {
    const { t, org, nora, teams, ws } = await northstar({ teams: 50 })
    const base = { org_id: org.id }
    const first = await both(t, nora, ws, 'teams:settingsPage', base)
    const after = { server: first.server[0].next ?? '', stand: first.stand[0].next ?? '' }
    const code = async (read: () => unknown) => {
      try {
        await read()
        return null
      } catch (error) {
        return (error as { data?: { code?: string } }).data?.code ?? 'error'
      }
    }
    const server = (name: TeamSettingsRead, args: Args) =>
      code(() => as(t, nora).query(makeFunctionReference<'query'>(name), args))
    const stand = (name: TeamSettingsRead, args: Args) =>
      code(() => teamSettingsStandIn(ws, name, args))
    expect(await server('teams:settingsPage', { ...base, after: after.server })).toBeNull()
    expect(await stand('teams:settingsPage', { ...base, after: after.stand })).toBeNull()
    for (const [name, extra] of [
      ['teams:members', { team_id: teams[0].id }],
      ['teams:settingsPage', { search: 'crew' }],
    ] as const) {
      expect(await server(name, { ...base, ...extra, after: after.server }), name).toBe(
        'bad_request',
      )
      expect(await stand(name, { ...base, ...extra, after: after.stand }), name).toBe('bad_request')
    }
    const long = 'x'.repeat(201)
    expect(await server('teams:settingsPage', { ...base, search: long })).toBe('rule')
    expect(await stand('teams:settingsPage', { ...base, search: long })).toBe('rule')
  })
})
