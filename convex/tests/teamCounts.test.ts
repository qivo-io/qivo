/* Team member counts (schema.ts team_counts): every write keeps each
 * team's count equal to the members model/teams.ts teamJson lists
 * (model/teamCounts.ts), apart from the memberships a profile removal
 * leaves to its steps, a team's count goes with the team, and the backfill
 * (internal/teamCountsBackfill.ts) counts a team exactly while writes go on
 * between its steps. */

import {
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
} from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import { COUNT_PAGE, dryCount, RUN } from '../internal/teamCountsBackfill'
import { ACCESS_FIRST_PASS } from '../model/cascade'
import { wipeWorkStep } from '../model/orgDeletion'
import { memberCount, teamCountRow } from '../model/teamCounts'
import { teamJson } from '../model/teams'
import {
  as,
  expectListCounts,
  NOW,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'
import { assertNoDanglingRefs } from './refs.setup'
import { installTrashTimers, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULT_COUNT_PAGE = { ...COUNT_PAGE }
const DEFAULT_RUN = { ...RUN }
const DEFAULT_FIRST_PASS = { ...ACCESS_FIRST_PASS }
afterEach(() => {
  Object.assign(COUNT_PAGE, DEFAULT_COUNT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
  Object.assign(ACCESS_FIRST_PASS, DEFAULT_FIRST_PASS)
})

/** Each team of the organization with the members teamJson lists. */
const truth = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const out: Record<string, number> = {}
    const teams = ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', orgId))
    for await (const team of teams) out[team.id] = (await teamJson(ctx, team)).members.length
    return out
  })

/** Each team of the organization with the count a reader may show. */
const shown = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const out: Record<string, number | null> = {}
    const teams = ctx.db.query('teams').withIndex('by_org', (q) => q.eq('org_id', orgId))
    for await (const team of teams) out[team.id] = await memberCount(ctx, team)
    return out
  })

/** The count a reader may show for team `teamId`, and the members teamJson
 * lists for it. */
const both = (t: T, teamId: string) =>
  t.run(async (ctx) => {
    const team = (await ctx.db
      .query('teams')
      .withIndex('by_uuid', (q) => q.eq('id', teamId))
      .unique()) as Doc<'teams'>
    return {
      shown: await memberCount(ctx, team),
      truth: (await teamJson(ctx, team)).members.length,
    }
  })

/** Expects team `teamId` counted with `members`, as teamJson lists them. */
async function expectMembers(t: T, teamId: string, members: number): Promise<void> {
  expect(await both(t, teamId)).toEqual({ shown: members, truth: members })
}

const newTeam = async (t: T, f: OrgFixture, name: string): Promise<string> => {
  const id = uuid()
  await as(t, f.admin).mutation(api.teams.create, { org_id: f.org.id, id, name })
  return id
}

/** Creates a team with id `id` in the fixture's organization. */
const newTeamWithId = (t: T, f: OrgFixture, id: string) =>
  as(t, f.admin).mutation(api.teams.create, { org_id: f.org.id, id, name: 'Reused' })

const add = (t: T, f: OrgFixture, team_id: string, profile_id: string) =>
  as(t, f.admin).mutation(api.teams.addMember, { org_id: f.org.id, team_id, profile_id })

const remove = (t: T, f: OrgFixture, team_id: string, profile_id: string) =>
  as(t, f.admin).mutation(api.teams.removeMember, { org_id: f.org.id, team_id, profile_id })

const update = (t: T, f: OrgFixture, id: string, patch: Record<string, unknown>) =>
  as(t, f.admin).mutation(api.profiles.update, { org_id: f.org.id, id, patch })

/** A team planted raw, as stored before this release: without a row. */
const plantTeam = (t: T, org_id: string, name: string) =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('teams', {
      id: uuid(),
      org_id,
      name,
      track_delay_default: true,
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'teams'>
  })

/** Memberships planted raw, without counting, in the order given. */
const plantMembers = (t: T, team_id: string, profileIds: readonly string[]) =>
  t.run(async (ctx) => {
    const rows: Doc<'team_members'>[] = []
    for (const profile_id of profileIds) {
      const _id = await ctx.db.insert('team_members', { team_id, profile_id, is_leader: false })
      rows.push((await ctx.db.get(_id)) as Doc<'team_members'>)
    }
    return rows
  })

const backfill = (t: T, args: { dry_run: boolean; recount?: boolean }) =>
  t.action(internal.internal.teamCountsBackfill.run, args)

const step = (t: T, team_id: string, restart = false) =>
  t.mutation(internal.internal.teamCountsBackfill.step, { team_id, restart })

type RunArgs = FunctionArgs<typeof internal.internal.teamCountsBackfill.run>
type RunAnswer = FunctionReturnType<typeof internal.internal.teamCountsBackfill.run>

/** Every call of a run, each from the cursor the one before answered,
 * until one answers done. */
async function calls(t: T, args: Omit<RunArgs, 'cursor'>): Promise<RunAnswer[]> {
  const got: RunAnswer[] = []
  let cursor: RunArgs['cursor']
  for (let n = 0; n < 40; n++) {
    const last = await t.action(internal.internal.teamCountsBackfill.run, { ...args, cursor })
    got.push(last)
    if (last.cursor === null) return got
    cursor = last.cursor
  }
  throw new Error('the run did not end')
}

describe('team counts', () => {
  it('every membership write keeps the count equal to the members a team lists', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // a team stored before this release has no count to show
    expect(await shown(t, org_id)).toEqual({ [f.team.id]: null })
    const team = await newTeam(t, f, 'Firmware')
    await expectMembers(t, team, 0)

    // people, an agent and a viewer count; a guest never joins
    for (const p of [f.user, f.viewer, f.agent, f.admin]) await add(t, f, team, p.id)
    await add(t, f, team, f.user.id)
    await expectMembers(t, team, 4)
    // an inactive member still counts, and leadership changes nothing
    await as(t, f.admin).mutation(api.profiles.deactivate, { org_id, id: f.viewer.id })
    await as(t, f.admin).mutation(api.teams.setLeader, {
      org_id,
      team_id: team,
      profile_id: f.user.id,
      is_leader: true,
    })
    await expectMembers(t, team, 4)
    await remove(t, f, team, f.viewer.id)
    await expectMembers(t, team, 3)

    // a seat created into the team, then moved out and back by its teams
    const seat = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id,
      id: seat,
      name: 'Nadia',
      email: 'nadia@testbed.test',
      org_role: 'user',
      kind: 'person',
      color: '#7a7ad0',
      teams: [team],
    })
    await expectMembers(t, team, 4)
    await update(t, f, seat, { teams: [] })
    await expectMembers(t, team, 3)
    await update(t, f, seat, { teams: [team] })
    await expectMembers(t, team, 4)
    // becoming a guest drops the seat's memberships with their count
    await update(t, f, seat, { org_role: 'guest', teams: [] })
    await expectMembers(t, team, 3)

    // a guest's membership from before the guest rule stays stored and
    // does not count; leaving the guest role replaces it with a counted one
    await t.run((ctx) =>
      ctx.db.insert('team_members', { team_id: team, profile_id: f.guest.id, is_leader: false }),
    )
    await expectMembers(t, team, 3)
    await update(t, f, f.guest.id, { org_role: 'user', teams: [team] })
    await expectMembers(t, team, 4)

    // a login with a home seat elsewhere claims an invitation as a guest,
    // which leaves its teams
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id,
      id: uuid(),
      name: 'Other',
      email: 'otheradmin@testbed.test',
      org_role: 'user',
      kind: 'person',
      color: '#7a7ad0',
      teams: [team],
    })
    await expectMembers(t, team, 5)
    await t.mutation(internal.identity.claimSeatsInternal, {
      userId: f.otherAdmin.auth_user_id as string,
      email: 'otheradmin@testbed.test',
      emailVerified: true,
    })
    await expectMembers(t, team, 4)

    // a team's count goes with it, and a new team in another organization
    // that takes its id starts from its own members
    await as(t, f.admin).mutation(api.teams.deleteDeep, { org_id, id: team })
    expect(await t.run((ctx) => teamCountRow(ctx, team))).toBeNull()
    await as(t, f.otherAdmin).mutation(api.teams.create, {
      org_id: f.otherOrg.id,
      id: team,
      name: 'Again',
    })
    await expectMembers(t, team, 0)
    // a row an earlier release left never passes to a new team with its id
    const reused = uuid()
    await t.run((ctx) =>
      ctx.db.insert('team_counts', { team_id: reused, org_id, members: 7, revision: 2 }),
    )
    await newTeamWithId(t, f, reused)
    await expectMembers(t, reused, 0)
    await assertNoDanglingRefs(t, 'team counts')
  }, 60_000)

  it('a removal counts the memberships it leaves until its steps delete them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    ACCESS_FIRST_PASS.rows = 2
    const person = await plantSeat(t, { org_id, name: 'Busy', email: 'busy@testbed.test' })
    const teams: string[] = []
    for (let n = 0; n < 4; n++) {
      const team = await newTeam(t, f, `Team ${n}`)
      await add(t, f, team, person.id)
      teams.push(team)
    }
    // a guest's stale memberships, which a removal never counts
    for (const team of teams.slice(0, 2))
      await t.run((ctx) =>
        ctx.db.insert('team_members', { team_id: team, profile_id: f.guest.id, is_leader: false }),
      )
    for (const team of teams) await expectMembers(t, team, 1)

    await as(t, f.admin).mutation(api.profiles.remove, { org_id, id: person.id })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id, id: f.guest.id })
    const removal = await t.run((ctx) =>
      ctx.db
        .query('profile_removals')
        .withIndex('by_profile', (q) => q.eq('profile_id', person.id))
        .unique(),
    )
    expect(removal?.counted_org_id).toBe(org_id)
    // the first pass took two off; the two left still count, though no
    // member list shows them
    const window = await Promise.all(teams.map((team) => both(t, team)))
    expect(window).toEqual([
      { shown: 0, truth: 0 },
      { shown: 0, truth: 0 },
      { shown: 1, truth: 0 },
      { shown: 1, truth: 0 },
    ])
    // a recount meanwhile counts them the same way
    let got = await step(t, teams[3], true)
    while (got === null) got = await step(t, teams[3])
    expect(got).toBe(1)

    await runSteps(t)
    for (const team of teams) await expectMembers(t, team, 0)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('team_members')
          .withIndex('by_profile', (q) => q.eq('profile_id', f.guest.id))
          .collect(),
      ),
    ).toEqual([])
  }, 60_000)

  it('counts a team exactly while its memberships change between the steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    Object.assign(COUNT_PAGE, { members: 2 })
    const team = await plantTeam(t, org_id, 'Planted')
    // a stale guest membership and one of another organization's person
    // never count
    await plantMembers(t, team.id, [
      f.user.id,
      f.viewer.id,
      f.guest.id,
      f.agent.id,
      f.otherAdmin.id,
      f.admin.id,
    ])
    expect(await step(t, team.id)).toBeNull()
    expect((await t.run((ctx) => teamCountRow(ctx, team.id)))?.members).toBe(2)
    // no count shows while it counts
    expect((await both(t, team.id)).shown).toBeNull()

    // writes below and past where it counted: two removals past it and an
    // addition, which a write moving the count there would get wrong
    await remove(t, f, team.id, f.user.id)
    await remove(t, f, team.id, f.admin.id)
    await remove(t, f, team.id, f.agent.id)
    const seat = await plantSeat(t, { org_id, name: 'Late', email: 'late@testbed.test' })
    await add(t, f, team.id, seat.id)
    await update(t, f, f.viewer.id, { org_role: 'guest', teams: [] })

    let done = null
    for (let n = 0; done === null && n < 20; n++) done = await step(t, team.id)
    await expectMembers(t, team.id, 1)
  })

  it('a dry run writes nothing; a run counts what it lists, recount mends a drift and orphans go', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a count an earlier release left after deleting its team
    await t.run((ctx) =>
      ctx.db.insert('team_counts', { team_id: uuid(), org_id: f.org.id, members: 3, revision: 0 }),
    )
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({ dry_run: true, counted: 1, members: 2, orphans: 1 })
    expect(dry.to_count).toEqual([{ team_id: f.team.id, org_id: f.org.id, members: 2 }])
    expect(await t.run((ctx) => teamCountRow(ctx, f.team.id))).toBeNull()

    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 1, orphans: 1 })
    await expectMembers(t, f.team.id, 2)
    expect(await t.run((ctx) => ctx.db.query('team_counts').collect())).toHaveLength(1)
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 0, orphans: 0 })

    const row = await t.run((ctx) => teamCountRow(ctx, f.team.id))
    await t.run((ctx) => ctx.db.patch(row?._id ?? ('' as never), { members: 9 }))
    const found = await backfill(t, { dry_run: true })
    expect(found).toMatchObject({ counted: 0, differing: 1, unsettled: 0 })
    expect(found.differ).toEqual([{ team_id: f.team.id, org_id: f.org.id, members: 2, stored: 9 }])
    await backfill(t, { dry_run: false, recount: true })
    await expectMembers(t, f.team.id, 2)
    const written = await t.run((ctx) =>
      ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'team_counts_backfill'))
        .collect(),
    )
    expect(written.map((r) => r.detail)).toEqual([
      { counted: 1, members: 2, orphans: 1, cursor: null },
      { counted: 0, members: 0, orphans: 0, cursor: null },
      { counted: 1, members: 2, orphans: 0, cursor: null },
    ])
  })

  it('a dry run compares a count only with a state no write moved while it counted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const team = await newTeam(t, f, 'Busy')
    const state = () => t.query(internal.internal.teamCountsBackfill.state, { team_id: team })
    let member = false
    // the reads of the state a dry count made, one a try
    let reads = 0
    /** An action context whose queries `t` answers, with a member added or
     * removed, or added and removed again with `undone`, before each of its
     * first `writes` reads of the state. */
    const racing = (writes: number, undone = false): Pick<ActionCtx, 'runQuery'> => {
      reads = 0
      return {
        runQuery: async (query, ...args) => {
          const name = getFunctionName(query)
          if (name === 'internal/teamCountsBackfill:state') reads++
          if (name === 'internal/teamCountsBackfill:state' && writes-- > 0) {
            member = !member
            await (member ? add : remove)(t, f, team, f.user.id)
            if (undone) {
              member = !member
              await (member ? add : remove)(t, f, team, f.user.id)
            }
          }
          return await t.query(makeFunctionReference<'query'>(name), args[0])
        },
      }
    }
    const fresh = async () => {
      const now = await state()
      if (now === null) throw new Error('the team is gone')
      return now
    }
    const once = await dryCount(racing(1), await fresh())
    expect(once.settled).toBe(true)
    expect(reads).toBe(2)
    expect(once.members).toBe(once.state?.stored)
    // a change undone before the read leaves the count where it was, and
    // the row's revision still makes it count again
    const undone = await dryCount(racing(1, true), await fresh())
    expect(undone.settled).toBe(true)
    expect(reads).toBe(2)
    expect((await dryCount(racing(Number.POSITIVE_INFINITY), await fresh())).settled).toBe(false)
    expect((await dryCount(racing(Number.POSITIVE_INFINITY, true), await fresh())).settled).toBe(
      false,
    )
    // a call out of time does not count again
    const late = await dryCount(racing(Number.POSITIVE_INFINITY), await fresh(), () => true)
    expect(late.settled).toBe(false)
    expect(reads).toBe(1)
  })

  it('a call past its time answers a cursor, inside a team too, and the calls from it go through every team once', async () => {
    const t = newT()
    const f = await withOrg(t)
    Object.assign(COUNT_PAGE, { members: 1 })
    Object.assign(RUN, { rows: 1, ms: 0 })
    const other = await plantTeam(t, f.otherOrg.id, 'Elsewhere')
    await plantMembers(t, other.id, [f.otherAdmin.id])
    for (const dry_run of [true, false]) {
      const got = await calls(t, { dry_run })
      expect(got.length).toBeGreaterThan(2)
      expect(got.reduce((n, call) => n + call.counted, 0)).toBe(2)
      expect(got.reduce((n, call) => n + call.teams, 0)).toBe(2)
      const stops = got.flatMap((call) =>
        call.cursor?.table === 'teams' && call.cursor.team !== undefined ? [call.cursor.team] : [],
      )
      // a dry run stops between teams, a run inside a team's count too
      if (dry_run) expect(stops).toEqual([{ id: other.id }])
      else expect(stops).toContainEqual({ id: f.team.id, started: true })
    }
    await expectMembers(t, f.team.id, 2)
    await expectMembers(t, other.id, 1)
  })

  it('a recount after a rollback starts an unfinished count again and ends exact', async () => {
    const t = newT()
    const f = await withOrg(t)
    Object.assign(COUNT_PAGE, { members: 1 })
    const team = await plantTeam(t, f.org.id, 'Planted')
    const [first] = await plantMembers(t, team.id, [f.user.id, f.viewer.id, f.admin.id])
    expect(await step(t, team.id)).toBeNull()
    expect(await step(t, team.id)).toBeNull()
    // an earlier release removes a member the count has read, and moves no
    // count
    await t.run((ctx) => ctx.db.delete(first._id))
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({ running: 1, running_teams: [team.id], differing: 0 })
    // the documented procedure: a recount until done
    await calls(t, { dry_run: false, recount: true })
    await expectMembers(t, team.id, 2)
    expect((await backfill(t, { dry_run: true })).differing).toBe(0)
  })

  it('a call a step ends with an error leaves its audit row, with where it stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
    Object.assign(RUN, { teams: 1 })
    const broken = await plantTeam(t, f.otherOrg.id, 'Broken')
    // two rows of one team, which no write makes: the read of its page
    // refuses
    await t.run(async (ctx) => {
      for (let n = 0; n < 2; n++)
        await ctx.db.insert('team_counts', {
          team_id: broken.id,
          org_id: f.otherOrg.id,
          members: 0,
          revision: 0,
        })
    })
    await expect(backfill(t, { dry_run: false })).rejects.toThrow()
    const [row] = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('platform_audit_log')
          .filter((q) => q.eq(q.field('action'), 'team_counts_backfill'))
          .collect()
      ).map((r) => r.detail),
    )
    expect(row).toMatchObject({ counted: 1, members: 2, orphans: 0, cursor: { table: 'teams' } })
    expect(row?.cursor?.cursor).toEqual(expect.any(String))
    expect(row?.error).toEqual(expect.any(String))
    await expectMembers(t, f.team.id, 2)
  })

  it('the seeds count their teams, and the Northstar wipe takes the counts with the teams', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    const counts = await truth(t, org.id)
    expect(await shown(t, org.id)).toEqual(counts)
    expect(Object.values(counts).every((n) => n > 0)).toBe(true)
    // small steps, with a count step for each team between two, as a
    // backfill run meanwhile would take
    let done = false
    for (let n = 0; n < 200 && !done; n++) {
      done = await t.run((ctx) =>
        wipeWorkStep(
          ctx,
          org.id,
          profiles.map((p) => p.id),
          { rows: 16, bytes: 4 * 1024 * 1024 },
        ),
      )
      await expectListCounts(t, org.id)
      for (const id of Object.keys(await truth(t, org.id)))
        await t.mutation(internal.internal.teamCountsBackfill.step, { team_id: id })
      await expectListCounts(t, org.id)
    }
    expect(done).toBe(true)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('team_counts')
          .withIndex('by_org', (q) => q.eq('org_id', org.id))
          .collect(),
      ),
    ).toEqual([])

    const { org_id } = await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    expect(Object.values(await shown(t, org_id))).toEqual([0])
    const made = await t.mutation(internal.adminOrgs.insertOrganization, {
      name: 'Starter Labs',
      people: [{ name: 'Ada', email: 'ada@starter.test', role: 'admin' }],
      actor: { auth_user_id: 'operator', email: 'operator@qivo.test' },
    })
    // the starter team's leader counts from the start
    expect(Object.values(await shown(t, made.org_id))).toEqual([1])
    expect(await shown(t, made.org_id)).toEqual(await truth(t, made.org_id))
  }, 60_000)
})
