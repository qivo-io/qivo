/* Teams over REST and MCP (machine/teams.ts) and the shared team rules the
 * app runs too (model/teams.ts, model/projectAccess.ts removeAndSettle).
 *
 *   1. Listing teams with their members and who leads them.
 *   2. Creating teams (organization admins) and renaming them (admins and
 *      the team's leaders), with names trimmed and never blank.
 *   3. Adding members and making or unmaking leaders: people only, a leader
 *      is a person with a staff role, and a refused leader change adds
 *      nobody.
 *   4. Removing a member settles the open tasks they can no longer see
 *      (leave, keep_as_viewer, reassign_to) in one transaction, for REST,
 *      MCP and the app alike.
 *   5. The routes over HTTP with a personal token. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACCESS_NEEDS_A_PERSON } from '../lib/access'
import type { Refusal, RefusalCode } from '../lib/functions'
import { sha256hex } from '../machine/auth'
import { HELD_TASKS_SHAPE } from '../model/projectAccess'
import { TEAM_RUNS_RULE, teamsJson } from '../model/teams'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const VIA_REST = 'via the REST API (drive)'

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

type Json = Record<string, unknown>
const parsed = async (p: Promise<string>): Promise<Json> => JSON.parse(await p) as Json

/* MCP and REST internal calls as a profile, with a credential that writes. */
const as_ = (p: Doc<'profiles'>) => ({ callerId: p.id, access: 'write' as const })
const rest = (p: Doc<'profiles'>) => ({ ...as_(p), keyName: 'drive' })

type Fx = OrgFixture & {
  t: T
  emil: Doc<'profiles'>
  pia: Doc<'profiles'>
  open: Doc<'issues'>
  reviewing: Doc<'issues'>
  done: Doc<'issues'>
}

/* withOrg plus Hardware shared with User on TBED. Emil is a member who sees
 * TBED only through the team: he is assigned an open task in FW, reviews
 * another and was assigned a Done one. Pia, outside the team, holds User on
 * FW. The fixture's user leads both Hardware and TBED; the admin is a plain
 * member. */
async function setup(): Promise<Fx> {
  const t = newT()
  const f = await withOrg(t)
  const person = (name: string) =>
    plantSeat(t, {
      org_id: f.org.id,
      name,
      email: `${name}@testbed.test`,
      auth_user_id: `auth_${name}_${f.org.id}`,
      accepted_at: NOW,
    })
  const emil = await person('emil')
  const pia = await person('pia')
  await t.run(async (ctx) => {
    await ctx.db.insert('team_members', {
      team_id: f.team.id,
      profile_id: emil.id,
      is_leader: false,
    })
    await ctx.db.insert('project_team_access', {
      project_id: f.meta.id,
      team_id: f.team.id,
      level: 'user',
    })
    await ctx.db.insert('project_access', {
      project_id: f.sub.id,
      profile_id: pia.id,
      level: 'user',
    })
  })
  const task = (extra: Partial<Doc<'issues'>>) =>
    plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...extra })
  const open = await task({ title: 'Open', assignee_id: emil.id })
  const reviewing = await task({
    title: 'Reviewing',
    status: 'review',
    assignee_id: pia.id,
    reviewer_id: emil.id,
  })
  const done = await task({ title: 'Done', status: 'done', assignee_id: emil.id })
  return { ...f, t, emil, pia, open, reviewing, done }
}

const membership = (t: T, teamId: string, profileId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('team_members')
      .withIndex('by_team_profile', (q) => q.eq('team_id', teamId).eq('profile_id', profileId))
      .unique(),
  )

const grantsOf = (t: T, profileId: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
        .collect()
    ).map((g) => [g.project_id, g.level]),
  )

const taskRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('issues')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

const teamRow = (t: T, id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('teams')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique(),
  )

/* A leader row written straight to the table, as an older rule allowed. */
const plantLeaderRow = (fx: Fx, profileId: string) =>
  fx.t.run(async (ctx) => {
    await ctx.db.insert('team_members', {
      team_id: fx.team.id,
      profile_id: profileId,
      is_leader: true,
    })
  })

/* A second team row in `orgId`. */
const plantTeam = (fx: Fx, orgId: string, name: string) =>
  fx.t.run(async (ctx) => {
    const id = uuid()
    await ctx.db.insert('teams', {
      id,
      org_id: orgId,
      name,
      stale_days: 120,
      archive_days: 30,
      track_delay_default: true,
      created_at: NOW,
    })
    return id
  })

/* ------------------------------------------------------------- 1. lists */

describe('listing teams', () => {
  it('lists each team with its members and who leads it, alike on both surfaces', async () => {
    const fx = await setup()
    // an agent's leader row from before agents were refused grants nothing,
    // and a guest's old row is no membership at all, as on Team settings
    await plantLeaderRow(fx, fx.agent.id)
    await plantLeaderRow(fx, fx.guest.id)
    const assembly = await plantTeam(fx, fx.org.id, 'Assembly')
    const hardware = {
      id: fx.team.id,
      name: 'Hardware',
      members: [
        { id: fx.admin.id, name: 'admin', leader: false },
        { id: fx.emil.id, name: 'emil', leader: false },
        { id: fx.agent.id, name: 'Relay', leader: false },
        { id: fx.user.id, name: 'user', leader: true },
      ],
    }
    const expected = [{ id: assembly, name: 'Assembly', members: [] }, hardware]
    // a Viewer reads them like anyone in the organization
    const read = { callerId: fx.viewer.id, access: 'read' as const }
    const mcp = JSON.parse(await fx.t.query(internal.machine.mcp.listTeams, read))
    expect(mcp).toEqual(expected)
    expect(Object.keys(mcp[1])).toEqual(['id', 'name', 'members'])
    expect(await fx.t.query(internal.machine.teams.restListTeams, read)).toEqual(expected)
    expect(
      await fx.t.query(internal.machine.teams.restGetTeam, { ...read, ref: fx.team.id }),
    ).toEqual(hardware)
  })

  it('reads the organization profiles once, however many members the teams have', async () => {
    const fx = await setup()
    const assembly = await plantTeam(fx, fx.org.id, 'Assembly')
    await fx.t.run(async (ctx) => {
      for (const who of [fx.pia, fx.emil, fx.viewer]) {
        await ctx.db.insert('team_members', {
          team_id: assembly,
          profile_id: who.id,
          is_leader: false,
        })
      }
    })
    const tables: string[] = []
    const teams = await fx.t.run(async (ctx) => {
      const db = new Proxy(ctx.db, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop)
          if (prop === 'query') {
            return (table: 'profiles') => {
              tables.push(table)
              return target.query(table)
            }
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return await teamsJson({ ...ctx, db } as QueryCtx, fx.viewer)
    })
    expect(teams.map((t) => t.members.length)).toEqual([3, 3])
    expect(tables.filter((t) => t === 'profiles')).toEqual(['profiles'])
  })

  it('answers a team outside the organization like a missing one', async () => {
    const fx = await setup()
    const foreign = await plantTeam(fx, fx.otherOrg.id, 'Elsewhere')
    for (const ref of [foreign, uuid(), 'Hardware']) {
      await refused(
        fx.t.query(internal.machine.teams.restGetTeam, { ...as_(fx.user), ref }),
        'not_found',
        'team not found',
      )
    }
  })
})

/* -------------------------------------------------- 2. create and rename */

describe('creating and renaming teams', () => {
  it('lets an organization admin create a team on both surfaces, without narration', async () => {
    const fx = await setup()
    const mcp = await parsed(
      fx.t.mutation(internal.machine.teams.mcpSetTeam, { ...as_(fx.admin), name: '  Optics ' }),
    )
    expect(mcp).toMatchObject({ name: 'Optics', members: [], created: true })
    expect(await teamRow(fx.t, mcp.id as string)).toMatchObject({
      org_id: fx.org.id,
      name: 'Optics',
      stale_days: 120,
      archive_days: 30,
      track_delay_default: true,
    })
    const restOut = await fx.t.mutation(internal.machine.teams.restCreateTeam, {
      ...as_(fx.admin),
      body: JSON.stringify({ name: 'Firmware' }),
    })
    expect(restOut).toMatchObject({ name: 'Firmware', members: [] })
    expect(await activityFor(fx.t, fx.org.id)).toEqual([])
  })

  it('refuses everyone else, and a blank name', async () => {
    const fx = await setup()
    for (const who of [fx.user, fx.agent, fx.viewer]) {
      await refused(
        fx.t.mutation(internal.machine.teams.mcpSetTeam, { ...as_(who), name: 'Coup' }),
        'forbidden',
        'only organization admins can create teams',
      )
    }
    await refused(
      fx.t.mutation(internal.machine.teams.mcpSetTeam, { ...as_(fx.admin), name: '   ' }),
      'bad_request',
      'a team name cannot be blank',
    )
    const post = (body: unknown) =>
      fx.t.mutation(internal.machine.teams.restCreateTeam, {
        ...as_(fx.admin),
        body: JSON.stringify(body),
      })
    await refused(post({}), 'bad_request', 'name is required')
    await refused(post({ name: 7 }), 'bad_request', 'name must be a string')
    // the app's create follows the same name rule
    await refused(
      as(fx.t, fx.admin).mutation(api.teams.create, { org_id: fx.org.id, id: uuid(), name: ' ' }),
      'bad_request',
      'a team name cannot be blank',
    )
  })

  it('lets an admin or a leader of the team rename it; others are refused', async () => {
    const fx = await setup()
    const rename = (name: string) =>
      fx.t.mutation(internal.machine.teams.mcpSetTeam, {
        ...as_(fx.user),
        team_id: fx.team.id.toUpperCase(),
        name,
      })
    const renamed = await parsed(rename(' HW '))
    expect(renamed).toMatchObject({ id: fx.team.id, name: 'HW', created: false })
    await refused(rename('  '), 'bad_request', 'a team name cannot be blank')
    const patch = (who: Doc<'profiles'>, body: unknown, ref = fx.team.id) =>
      fx.t.mutation(internal.machine.teams.restUpdateTeam, {
        ...as_(who),
        ref,
        body: JSON.stringify(body),
      })
    await refused(patch(fx.admin, { name: ' ' }), 'bad_request', 'a team name cannot be blank')
    expect((await teamRow(fx.t, fx.team.id))?.name).toBe('HW')
    // names are trimmed, and fields REST does not change are ignored
    expect(await patch(fx.admin, { name: ' Hardware ', icon: 'zap' })).toMatchObject({
      name: 'Hardware',
    })
    expect((await teamRow(fx.t, fx.team.id))?.icon).toBeUndefined()
    // an agent's leader row grants nothing, so the agent does not lead
    await plantLeaderRow(fx, fx.agent.id)
    for (const who of [fx.emil, fx.agent]) {
      await refused(patch(who, { name: 'Mine' }), 'forbidden', TEAM_RUNS_RULE)
    }
    await refused(patch(fx.admin, { icon: 'x' }), 'bad_request', 'no recognized fields to update')
    await refused(patch(fx.admin, { name: 'X' }, uuid()), 'not_found', 'team not found')
    const missing = uuid()
    await refused(
      fx.t.mutation(internal.machine.teams.mcpSetTeam, {
        ...as_(fx.admin),
        team_id: missing,
        name: 'X',
      }),
      'not_found',
      `team "${missing}" not found in your organization`,
    )
    expect((await teamRow(fx.t, fx.team.id))?.name).toBe('Hardware')
    expect(await activityFor(fx.t, fx.org.id)).toEqual([])
  })
})

/* ------------------------------------------------ 3. members and leaders */

describe('adding members and leaders', () => {
  it('adds a member and makes them a leader in one call, signed by the surface', async () => {
    const fx = await setup()
    const put = (body: unknown) =>
      fx.t.mutation(internal.machine.teams.restPutMember, {
        ...rest(fx.user),
        ref: fx.team.id,
        user: fx.pia.id,
        body: body === undefined ? '' : JSON.stringify(body),
      })
    const user = { id: fx.pia.id, name: 'pia' }
    expect(await put(undefined)).toEqual({
      team_id: fx.team.id,
      user,
      leader: false,
      changed: true,
    })
    expect(await put({})).toMatchObject({ leader: false, changed: false })
    expect(await put({ leader: true })).toMatchObject({ leader: true, changed: true })
    const out = await parsed(
      fx.t.mutation(internal.machine.teams.mcpSetTeamMember, {
        ...as_(fx.admin),
        team_id: fx.team.id,
        user_id: fx.pia.id,
        member: true,
        leader: false,
      }),
    )
    expect(out).toEqual({
      team: { id: fx.team.id, name: 'Hardware' },
      user,
      member: true,
      leader: false,
      changed: true,
    })
    const events = await activityFor(fx.t, fx.org.id)
    expect(events.map((e) => [e.verb, e.target_id, e.detail, e.team_id])).toEqual([
      ['added', fx.pia.id, `to Hardware — ${VIA_REST}`, fx.team.id],
      ['made', fx.pia.id, `a leader of Hardware — ${VIA_REST}`, fx.team.id],
      ['demoted', fx.pia.id, 'from leader of Hardware — via MCP', fx.team.id],
    ])
  })

  it('never makes an agent, a viewer or a guest a leader, and then adds nobody', async () => {
    const fx = await setup()
    const put = (who: Doc<'profiles'>, body: unknown) =>
      fx.t.mutation(internal.machine.teams.restPutMember, {
        ...rest(fx.admin),
        ref: fx.team.id,
        user: who.id,
        body: JSON.stringify(body),
      })
    await refused(put(fx.agent, { leader: true }), 'rule', 'an agent cannot lead a team')
    await refused(put(fx.viewer, { leader: true }), 'forbidden', 'a viewer is never a team leader')
    await refused(put(fx.guest, {}), 'forbidden', 'a guest is never a team member')
    for (const who of [fx.agent, fx.viewer, fx.guest]) {
      expect(await membership(fx.t, fx.team.id, who.id)).toBeNull()
    }
    // as plain members, the agent and the viewer join
    for (const who of [fx.agent, fx.viewer]) {
      expect(await put(who, {})).toMatchObject({ leader: false, changed: true })
    }
    expect(await activityFor(fx.t, fx.org.id)).toHaveLength(2)
  })

  it('answers whether the user leads afterwards, so an old agent leader row reads false', async () => {
    const fx = await setup()
    await plantLeaderRow(fx, fx.agent.id)
    const put = (who: Doc<'profiles'>) =>
      fx.t.mutation(internal.machine.teams.restPutMember, {
        ...rest(fx.admin),
        ref: fx.team.id,
        user: who.id,
        body: '{}',
      })
    expect(await put(fx.agent)).toMatchObject({ leader: false, changed: false })
    expect(await put(fx.user)).toMatchObject({ leader: true, changed: false })
    const set = await parsed(
      fx.t.mutation(internal.machine.teams.mcpSetTeamMember, {
        ...as_(fx.admin),
        team_id: fx.team.id,
        user_id: fx.agent.id,
        member: true,
      }),
    )
    expect(set).toMatchObject({ member: true, leader: false, changed: false })
  })

  it('lets only a person who runs the team change its members', async () => {
    const fx = await setup()
    // an agent with an older leader row is refused as an agent, like any agent
    await plantLeaderRow(fx, fx.agent.id)
    const set = (who: Doc<'profiles'>, args: { member: boolean; leader?: boolean }) =>
      fx.t.mutation(internal.machine.teams.mcpSetTeamMember, {
        ...as_(who),
        team_id: fx.team.id,
        user_id: fx.pia.id,
        ...args,
      })
    for (const args of [{ member: true }, { member: true, leader: true }, { member: false }]) {
      await refused(set(fx.agent, args), 'forbidden', ACCESS_NEEDS_A_PERSON)
      await refused(set(fx.emil, args), 'forbidden', TEAM_RUNS_RULE)
    }
    await refused(
      fx.t.mutation(internal.machine.teams.restDeleteMember, {
        ...rest(fx.agent),
        ref: fx.team.id,
        user: fx.emil.id,
        body: '',
      }),
      'forbidden',
      ACCESS_NEEDS_A_PERSON,
    )
    expect(await membership(fx.t, fx.team.id, fx.pia.id)).toBeNull()
    expect(await membership(fx.t, fx.team.id, fx.emil.id)).not.toBeNull()
  })

  it('refuses arguments that do not fit the change, and people outside the organization', async () => {
    const fx = await setup()
    const set = (args: Json) =>
      fx.t.mutation(internal.machine.teams.mcpSetTeamMember, {
        ...as_(fx.admin),
        team_id: fx.team.id,
        user_id: fx.pia.id,
        member: true,
        ...args,
      })
    await refused(
      set({ member: false, leader: true }),
      'bad_request',
      'leader applies only when member is true',
    )
    await refused(
      set({ on_held_tasks: 'leave' }),
      'bad_request',
      'on_held_tasks applies only when member is false',
    )
    await refused(
      set({ user_id: fx.otherAdmin.id }),
      'bad_request',
      `user "${fx.otherAdmin.id}" not found in your organization`,
    )
    const put = (user: string, body: string) =>
      fx.t.mutation(internal.machine.teams.restPutMember, {
        ...rest(fx.admin),
        ref: fx.team.id,
        user,
        body,
      })
    await refused(put(fx.otherAdmin.id, ''), 'not_found', 'user not found')
    await refused(put(fx.pia.id, '{"leader":"yes"}'), 'bad_request', 'leader must be a boolean')
    expect(await membership(fx.t, fx.team.id, fx.pia.id)).toBeNull()
  })
})

/* -------------------------------------------- 4. removing settles tasks */

const del = (fx: Fx, who: Doc<'profiles'>, body: unknown) =>
  fx.t.mutation(internal.machine.teams.restDeleteMember, {
    ...rest(who),
    ref: fx.team.id,
    user: fx.emil.id,
    body: body === undefined ? '' : JSON.stringify(body),
  })

const holding = (task: Doc<'issues'>, userId: string, role: 'assignee' | 'reviewer') => ({
  id: task.id,
  key: `QN-${task.num}`,
  title: task.title,
  user_id: userId,
  role,
})

describe('removing a member settles their open tasks', () => {
  it('leaves the tasks by default and lists them, and Done work is not listed', async () => {
    const fx = await setup()
    expect(await del(fx, fx.user, undefined)).toEqual({
      team_id: fx.team.id,
      user: { id: fx.emil.id, name: 'emil' },
      removed: true,
      stranded: [
        holding(fx.open, fx.emil.id, 'assignee'),
        holding(fx.reviewing, fx.emil.id, 'reviewer'),
      ],
      kept_as_viewer: [],
      reassigned: [],
    })
    expect(await membership(fx.t, fx.team.id, fx.emil.id)).toBeNull()
    expect((await taskRow(fx.t, fx.open.id))?.assignee_id).toBe(fx.emil.id)
    expect((await activityFor(fx.t, fx.org.id)).map((e) => [e.verb, e.detail])).toEqual([
      ['removed', `from Hardware — ${VIA_REST}`],
    ])
    // removing them again changes nothing
    expect(await del(fx, fx.user, undefined)).toMatchObject({ removed: false, stranded: [] })
  })

  it('keeps them as a Viewer of the project the team shared', async () => {
    const fx = await setup()
    const out = await parsed(
      fx.t.mutation(internal.machine.teams.mcpSetTeamMember, {
        ...as_(fx.admin),
        team_id: fx.team.id,
        user_id: fx.emil.id,
        member: false,
        on_held_tasks: 'keep_as_viewer',
      }),
    )
    expect(out).toMatchObject({
      member: false,
      leader: false,
      changed: true,
      stranded: [],
      kept_as_viewer: [fx.emil.id],
      reassigned: [],
    })
    // the team shared TBED, which showed the FW tasks
    expect(await grantsOf(fx.t, fx.emil.id)).toEqual([[fx.meta.id, 'viewer']])
    expect(
      (await activityFor(fx.t, fx.org.id)).map((e) => [e.verb, e.target_id, e.detail]),
    ).toEqual([
      ['changed access on', fx.meta.id, 'via MCP'],
      ['removed', fx.emil.id, 'from Hardware — via MCP'],
    ])
  })

  it('keeps the Viewer grant on a sub-project the team shared itself', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('project_team_access', {
        project_id: fx.sub2.id,
        team_id: fx.team.id,
        level: 'user',
      })
      // the TBED share goes, so only PCB stays in the team's reach
      const share = await ctx.db
        .query('project_team_access')
        .withIndex('by_project_team', (q) =>
          q.eq('project_id', fx.meta.id).eq('team_id', fx.team.id),
        )
        .unique()
      if (share !== null) await ctx.db.delete(share._id)
    })
    const there = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub2.id,
      assignee_id: fx.emil.id,
    })
    expect(await del(fx, fx.user, { on_held_tasks: 'keep_as_viewer' })).toMatchObject({
      kept_as_viewer: [fx.emil.id],
      stranded: [],
    })
    expect(await grantsOf(fx.t, fx.emil.id)).toEqual([[fx.sub2.id, 'viewer']])
    expect((await taskRow(fx.t, there.id))?.assignee_id).toBe(fx.emil.id)
  })

  it('hands the tasks over, or changes nothing when one cannot be handed over', async () => {
    const fx = await setup()
    await refused(
      del(fx, fx.user, { on_held_tasks: { reassign_to: fx.viewer.id } }),
      'rule',
      'a task can only be assigned to an active user with Edit permission or higher on its project',
    )
    // nor to the member who loses sight of them
    await refused(
      del(fx, fx.user, { on_held_tasks: { reassign_to: fx.emil.id } }),
      'rule',
      'a task can only be assigned to an active user with Edit permission or higher on its project',
    )
    expect(await membership(fx.t, fx.team.id, fx.emil.id)).not.toBeNull()
    expect((await taskRow(fx.t, fx.open.id))?.assignee_id).toBe(fx.emil.id)
    expect((await taskRow(fx.t, fx.reviewing.id))?.reviewer_id).toBe(fx.emil.id)
    const out = await del(fx, fx.user, { on_held_tasks: { reassign_to: fx.pia.id.toUpperCase() } })
    expect(out).toMatchObject({ removed: true, stranded: [], kept_as_viewer: [] })
    expect((out.reassigned as Json[]).map((h) => [h.id, h.role])).toEqual([
      [fx.open.id, 'assignee'],
      [fx.reviewing.id, 'reviewer'],
    ])
    expect((await taskRow(fx.t, fx.open.id))?.assignee_id).toBe(fx.pia.id)
    expect((await taskRow(fx.t, fx.reviewing.id))?.reviewer_id).toBe(fx.pia.id)
    expect((await taskRow(fx.t, fx.done.id))?.assignee_id).toBe(fx.emil.id)
  })

  it('refuses to keep a Viewer on a project the leader cannot share, and changes nothing', async () => {
    const fx = await setup()
    // Pia leads Hardware but not TBED, where the Viewer grant would go
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: fx.team.id,
        profile_id: fx.pia.id,
        is_leader: true,
      })
    })
    await refused(
      del(fx, fx.pia, { on_held_tasks: 'keep_as_viewer' }),
      'forbidden',
      'no permission to manage users on this project',
    )
    expect(await membership(fx.t, fx.team.id, fx.emil.id)).not.toBeNull()
    expect(await grantsOf(fx.t, fx.emil.id)).toEqual([])
    // leaving the tasks needs no project authority, as in the app
    expect(await del(fx, fx.pia, undefined)).toMatchObject({ removed: true })
  })

  it('lists nothing for a member who keeps sight through their own grant', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: fx.meta.id,
        profile_id: fx.emil.id,
        level: 'user',
      })
    })
    expect(await del(fx, fx.user, { on_held_tasks: 'keep_as_viewer' })).toMatchObject({
      removed: true,
      stranded: [],
      kept_as_viewer: [],
    })
    expect(await grantsOf(fx.t, fx.emil.id)).toEqual([[fx.meta.id, 'user']])
  })

  it("runs the app's removal through the same rule, leaving the tasks by default", async () => {
    const fx = await setup()
    const remove = (on_held_tasks?: 'keep_as_viewer') =>
      as(fx.t, fx.user).mutation(api.teams.removeMember, {
        org_id: fx.org.id,
        team_id: fx.team.id,
        profile_id: fx.emil.id,
        ...(on_held_tasks === undefined ? {} : { on_held_tasks }),
      })
    await remove('keep_as_viewer')
    expect(await grantsOf(fx.t, fx.emil.id)).toEqual([[fx.meta.id, 'viewer']])
    expect((await activityFor(fx.t, fx.org.id)).map((e) => [e.verb, e.detail])).toEqual([
      ['changed access on', undefined],
      ['removed', 'from Hardware'],
    ])
    // back in the team without the Viewer grant, then removed with no choice
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: fx.team.id,
        profile_id: fx.emil.id,
        is_leader: false,
      })
      for (const g of await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', fx.emil.id))
        .collect()) {
        await ctx.db.delete(g._id)
      }
    })
    await remove()
    expect(await membership(fx.t, fx.team.id, fx.emil.id)).toBeNull()
    expect(await grantsOf(fx.t, fx.emil.id)).toEqual([])
    expect((await taskRow(fx.t, fx.open.id))?.assignee_id).toBe(fx.emil.id)
  })
})

/* ------------------------------------------------------- 5. over HTTP */

describe('team routes over HTTP', () => {
  it('serves the list, PUT and DELETE with their bodies to a personal token', async () => {
    const fx = await setup()
    const token = `qvt_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
    const token_hash = await sha256hex(token)
    await fx.t.run((ctx) =>
      ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: fx.user.id,
        name: 'Leader token',
        token_prefix: token.slice(0, 11),
        token_hash,
        access: 'write',
        created_at: NOW,
      }),
    )
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await (
        fx.t as unknown as {
          fetch(
            path: string,
            init: { method: string; headers: Record<string, string>; body?: string },
          ): Promise<{ status: number; text(): Promise<string> }>
        }
      ).fetch(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: JSON.parse(await res.text()) as unknown }
    }
    const listed = await call('GET', '/v1/teams')
    expect(listed.status).toBe(200)
    expect((listed.body as Json[]).map((t) => t.name)).toEqual(['Hardware'])
    const members = `/v1/teams/${fx.team.id}/members`
    expect(await call('PUT', `${members}/${fx.pia.id}`, { leader: true })).toMatchObject({
      status: 200,
      body: { leader: true, changed: true },
    })
    expect(
      await call('DELETE', `${members}/${fx.emil.id}`, { on_held_tasks: 'keep_as_viewer' }),
    ).toMatchObject({ status: 200, body: { removed: true, kept_as_viewer: [fx.emil.id] } })
    expect(await call('DELETE', `${members}/${fx.pia.id}`, { on_held_tasks: 'later' })).toEqual({
      status: 400,
      body: { error: HELD_TASKS_SHAPE },
    })
    expect(await call('POST', '/v1/teams', { name: 'Optics' })).toEqual({
      status: 403,
      body: { error: 'only organization admins can create teams' },
    })
    expect(await call('GET', `/v1/teams/${uuid()}`)).toEqual({
      status: 404,
      body: { error: 'team not found' },
    })
    // a person's REST writes are signed without a token name
    expect((await activityFor(fx.t, fx.org.id)).at(-1)).toMatchObject({
      verb: 'removed',
      detail: 'from Hardware — via the REST API',
    })
  })
})
