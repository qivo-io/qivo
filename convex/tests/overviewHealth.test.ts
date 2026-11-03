/* The Overview's health table (overview.health, lib/overview.ts readHealth):
 * its arguments, the scopes it refuses, its rows and figures, its order,
 * name fallback, search, cut and cap, which rows it judges, how its owner
 * reads stay independent of row order, what hidden data may move, and the
 * reads at the design size under Convex's transaction limits.
 * src/store/overviewParity.test.ts compares its rows with the app's. */

import { compareValues, type Value } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OWN_READS } from '../lib/access'
import { LIMITS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import {
  type HealthAnswer,
  type HealthRow,
  type HealthSort,
  OVERVIEW,
  type OverviewScope,
  readHealth,
} from '../lib/overview'
import { OWNER_LOADS } from '../lib/ownerLoads'
import { plantTasks } from './board.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import {
  BEFORE_RULE,
  DAY,
  measured,
  mixOf,
  plantPeople,
  plantShared,
  shift,
  type Took,
  weeksOf,
} from './overview.setup'
import { countOrg } from './overviewCounts.setup'
import { withReach } from './projectReach.setup'

process.env.BETTER_AUTH_SECRET ??= 'overview-health-test-secret-not-a-deployment-key'

const DEFAULT_OVERVIEW = structuredClone(OVERVIEW)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_OWNER_LOADS = structuredClone(OWNER_LOADS)
afterEach(() => {
  Object.assign(OVERVIEW, structuredClone(DEFAULT_OVERVIEW))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(OWNER_LOADS, structuredClone(DEFAULT_OWNER_LOADS))
})

const WEEKS = weeksOf(DAY)

/** What overview.health takes besides the scope. */
type Ask = {
  day: string
  week: string
  week_starts: number[]
  week_end: number
  sort: HealthSort
  dir: 'asc' | 'desc'
  search?: string
  limit: number
}

/** The table's defaults: the client's clock on DAY, most Delayed first, the
 * first 10 rows. */
const ASK: Ask = { ...WEEKS, sort: 'late', dir: 'desc', limit: 10 }

const scopeOf = (me: Doc<'profiles'>, p: Doc<'projects'>): OverviewScope => ({
  kind: 'project',
  org_id: me.org_id,
  project_id: p.id,
})
const MINE: OverviewScope = { kind: 'mine' }

/** overview.health for `me` over `scope`, with `over` over ASK. */
const health = (t: T, me: Doc<'profiles'>, scope: OverviewScope, over: Partial<Ask> = {}) =>
  as(t, me).query(api.overview.health, { scope, ...ASK, ...over })

/** `answer` when it is ok, else a failure naming it. */
function okOf(answer: HealthAnswer): Extract<HealthAnswer, { state: 'ok' }> {
  if (answer.state !== 'ok') throw new Error(JSON.stringify(answer))
  return answer
}

/** The rows' names, in order. */
const names = (answer: HealthAnswer) => okOf(answer).rows.map((r) => r.name)

/** The row named `name`. */
function rowOf(answer: HealthAnswer, name: string): HealthRow {
  const row = okOf(answer).rows.find((r) => r.name === name)
  if (row === undefined) throw new Error(`no row ${name} in ${JSON.stringify(answer)}`)
  return row
}

/** A row's leaves, whatever their status. */
const leavesOf = (row: HealthRow) =>
  row.counts.state === 'ok' ? Object.values(row.counts.leaves).reduce((n, c) => n + c, 0) : null

/** A sub-project of `top` that tracks delay, named `name`. */
const subOf = (
  t: T,
  top: Doc<'projects'>,
  name: string,
  over: Partial<Doc<'projects'>> = {},
): Promise<Doc<'projects'>> =>
  plantProject(t, {
    org_id: top.org_id,
    type: 'project',
    parent_id: top.id,
    name,
    name_key: nameKey(name),
    track_delay: true,
    archive_state: 'live',
    ...over,
  })

/** A task of `owner` in `project` that its load projects late: 200 hours
 * at 40 a week from DAY's week, due in ten days. */
const projectedLate = (t: T, project: Doc<'projects'>, owner: Doc<'profiles'>, title: string) =>
  plantIssue(t, {
    org_id: project.org_id,
    project_id: project.id,
    title,
    assignee_id: owner.id,
    start_week: DAY,
    end_week: shift(DAY, 7),
    due_date: shift(DAY, 10),
    remaining_hours: 200,
    remaining_set_at: `${DAY}T12:00:00.000Z`,
  })

/** `profiles` in owner id order, as the verdicts read them. */
const byIdOrder = (profiles: Doc<'profiles'>[]) =>
  [...profiles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

// ----------------------------------------------------------------- arguments

describe('arguments', () => {
  it('refuses a malformed clock, an unknown column or direction, a limit outside 1 to 200 and a search past its limit', async () => {
    const t = newT()
    const f = await withOrg(t)
    await countOrg(t, f.org.id)
    const scope = scopeOf(f.user, f.meta)
    await expectRefusal(health(t, f.user, scope, { day: '2026-11-31' }), 'bad_request', /day/)
    await expectRefusal(health(t, f.user, scope, { week: shift(DAY, -7) }), 'bad_request', /week/)
    await expectRefusal(
      health(t, f.user, scope, { week_starts: WEEKS.week_starts.slice(1) }),
      'bad_request',
      /week_starts/,
    )
    await expect(health(t, f.user, scope, { sort: 'title' as HealthSort })).rejects.toThrow(
      /Validator error.*"title"/,
    )
    await expect(health(t, f.user, scope, { dir: 'up' as 'asc' })).rejects.toThrow(
      /Validator error.*"up"/,
    )
    for (const limit of [0, -1, 201, 1.5, Number.NaN])
      await expectRefusal(health(t, f.user, scope, { limit }), 'bad_request', /limit/)
    for (const limit of [1, 200])
      expect((await health(t, f.user, scope, { limit })).state).toBe('ok')
    const refusal = await expectRefusal(
      health(t, f.user, scope, { search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    expect(refusal.data.message).toBe(LIMITS.search.refusal)
    expect((await health(t, f.user, scope, { search: 'x'.repeat(LIMITS.search.max) })).state).toBe(
      'ok',
    )
    // a blank search matches every row
    expect(
      names(await health(t, f.user, scope, { search: '  ', sort: 'name', dir: 'asc' })),
    ).toEqual(['Board rev', 'Firmware'])
  })
})

// --------------------------------------------------------------------- access

describe('access', () => {
  it('answers unavailable alike for every scope the caller does not hold', async () => {
    const t = newT()
    const f = await withOrg(t)
    const other = await withOrg(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
    })
    const archived = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const loose = await plantProject(t, { org_id: f.org.id, type: 'project' })
    await countOrg(t, f.org.id)
    for (const [label, who, scope] of [
      ['no such project', me, { kind: 'project', org_id: f.org.id, project_id: uuid() }],
      [
        "another organization's",
        me,
        { kind: 'project', org_id: f.org.id, project_id: other.sub.id },
      ],
      ['a hidden project', me, scopeOf(me, f.sub)],
      ['a hidden top-level project', me, scopeOf(me, f.meta)],
      ['an archived sub-project', f.admin, scopeOf(f.admin, archived)],
      ['a top-level project that is not a meta', f.admin, scopeOf(f.admin, loose)],
      ['no seat', f.admin, { kind: 'project', org_id: other.org.id, project_id: other.sub.id }],
    ] as [string, Doc<'profiles'>, OverviewScope][])
      for (const sort of ['late', 'name', 'lead'] as const)
        expect(await health(t, who, scope, { sort }), `${label}, ${sort}`).toEqual({
          state: 'unavailable',
        })
  })

  it("answers unavailable with access_unchecked where a bound of the caller's own reads stopped a check", async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      accepted_at: NOW,
      auth_user_id: `auth_${uuid()}`,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: me.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, assignee_id: me.id })
    await countOrg(t, f.org.id)
    expect((await health(t, me, scopeOf(me, f.meta))).state).toBe('ok')
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0, navRows: 0 })
    for (const scope of [scopeOf(me, f.meta), scopeOf(me, f.sub2), MINE])
      expect(await health(t, me, scope)).toEqual({
        state: 'unavailable',
        reason: 'access_unchecked',
        message: expect.stringContaining('could not finish checking which projects you can see'),
      })
  })

  it('gives a hidden or archived sub-project no row, no count and no search match', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a member who sees FW only
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', { project_id: f.sub.id, profile_id: me.id, level: 'user' }),
    )
    const archived = await subOf(t, f.meta, 'Archived workstream', {
      archived_at: NOW,
      archive_state: 'listed',
    })
    for (const project of [f.sub, f.sub2, archived])
      await plantIssue(t, { org_id: f.org.id, project_id: project.id, assignee_id: me.id })
    await countOrg(t, f.org.id)
    const mine = okOf(await health(t, me, scopeOf(me, f.meta), { sort: 'name', dir: 'asc' }))
    expect(mine.rows.map((r) => r.name)).toEqual(['Firmware'])
    expect(mine.total).toBe(1)
    expect(leavesOf(rowOf(mine, 'Firmware'))).toBe(1)
    for (const search of ['board', 'archived', 'rev'])
      expect(await health(t, me, scopeOf(me, f.meta), { search })).toMatchObject({
        state: 'ok',
        rows: [],
        total: 0,
      })
    // My view counts the person's own tasks only where they can see them
    const view = okOf(await health(t, me, MINE))
    expect(view.rows.map((r) => [r.name, leavesOf(r)])).toEqual([['Testbed platform', 1]])
    // the admin sees PCB, never the archived sub-project
    expect(
      names(await health(t, f.admin, scopeOf(f.admin, f.meta), { sort: 'name', dir: 'asc' })),
    ).toEqual(['Board rev', 'Firmware'])
  })

  it("keeps an admin's My view to their own tasks, never a whole project's", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, assignee_id: f.admin.id })
    // a project with only other people's tasks, which the admin sees whole
    const others = await plantProject(t, { org_id: f.org.id, name: 'Others', lead_id: f.user.id })
    const otherSub = await subOf(t, others, 'Their work')
    await plantIssue(t, { org_id: f.org.id, project_id: otherSub.id, assignee_id: f.user.id })
    await countOrg(t, f.org.id)
    const view = okOf(await health(t, f.admin, MINE, { sort: 'name', dir: 'asc' }))
    expect(view.rows.map((r) => [r.name, leavesOf(r)])).toEqual([['Testbed platform', 1]])
    expect(view.total).toBe(1)
    const theirs = okOf(await health(t, f.user, MINE, { sort: 'name', dir: 'asc' }))
    expect(theirs.rows.map((r) => [r.name, leavesOf(r)])).toEqual([
      ['Others', 1],
      ['Testbed platform', 2],
    ])
  })

  it("gives a guest and a Viewer the rows their summary counts, and their own work's figures", async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const [i, project] of [f.sub, f.sub2].entries())
      for (let k = 0; k <= i; k++)
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: project.id,
          status: k ? 'done' : 'todo',
        })
    await countOrg(t, f.org.id)
    for (const me of [f.guest, f.viewer]) {
      const scope = scopeOf(me, f.meta)
      const table = okOf(await health(t, me, scope, { sort: 'name', dir: 'asc' }))
      const summary = await as(t, me).query(api.overview.summary, { scope, day: DAY })
      if (summary.state !== 'ok' || summary.counts.state !== 'ok')
        throw new Error(JSON.stringify(summary))
      expect(table.rows.map((r) => r.project_id).sort()).toEqual(
        [...(summary.sub_projects ?? [])].sort(),
      )
      expect(table.rows.reduce((n, r) => n + (leavesOf(r) ?? 0), 0)).toBe(
        Object.values(summary.counts.leaves).reduce((n, c) => n + c, 0),
      )
      expect(table.rows.every((r) => r.delays.state === 'ok')).toBe(true)
    }
  })
})

// ----------------------------------------------------------------------- rows

describe('rows', () => {
  it("answers every visible live sub-project of a project, an empty one included, and My view's projects with the person's tasks, a group-only one included", async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.admin.id })
    // a project where the admin holds only a group, whose subtask is the user's
    const groups = await plantProject(t, { org_id: f.org.id, name: 'Groups only' })
    const groupSub = await subOf(t, groups, 'Group work')
    const group = await plantIssue(t, {
      org_id: f.org.id,
      project_id: groupSub.id,
      title: 'A group of mine',
      assignee_id: f.admin.id,
    })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: groupSub.id,
      parent_id: group.id,
      assignee_id: f.user.id,
    })
    // a project with only other people's work
    const theirs = await plantProject(t, { org_id: f.org.id, name: 'Not mine' })
    const theirSub = await subOf(t, theirs, 'Their work')
    await plantIssue(t, { org_id: f.org.id, project_id: theirSub.id, assignee_id: f.user.id })
    await countOrg(t, f.org.id)
    // PCB holds no task and is a row all the same
    const project = okOf(
      await health(t, f.admin, scopeOf(f.admin, f.meta), { sort: 'name', dir: 'asc' }),
    )
    expect(project.rows.map((r) => [r.name, leavesOf(r)])).toEqual([
      ['Board rev', 0],
      ['Firmware', 1],
    ])
    expect(project.rows.map((r) => r.lead_id)).toEqual([f.user.id, f.user.id])
    const view = okOf(await health(t, f.admin, MINE, { sort: 'name', dir: 'asc' }))
    expect(view.rows.map((r) => [r.name, leavesOf(r)])).toEqual([
      ['Groups only', 0],
      ['Testbed platform', 1],
    ])
    // a sub-project scope answers its one row
    expect(names(await health(t, f.admin, scopeOf(f.admin, f.sub)))).toEqual(['Firmware'])
    expect(rowOf(await health(t, f.admin, scopeOf(f.admin, f.sub)), 'Firmware').lead_id).toBe(
      f.user.id,
    )
  })
})

// -------------------------------------------------------------------- figures

describe('figures', () => {
  it("counts each row's leaves, paused leaves, Left, Delayed and Slipping from its tasks", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
    const task = (fields: Partial<Doc<'issues'>>, project = f.sub) =>
      plantIssue(t, {
        org_id: f.org.id,
        project_id: project.id,
        created_at: BEFORE_RULE,
        ...fields,
      })
    await task({ title: 'Overdue', due_date: shift(DAY, -3) })
    await task({ title: 'Behind', start_week: shift(DAY, -14), end_week: shift(DAY, -7) })
    await task({ title: 'Paused leaf', paused: true })
    const pausedGroup = await task({ title: 'Paused group', paused: true })
    await task({ title: 'Under the paused group', parent_id: pausedGroup.id })
    await task({ title: 'Done', status: 'done', done_at: NOW })
    await task({ title: 'Done past due', status: 'done', done_at: NOW, due_date: shift(DAY, -5) })
    await task({ title: 'A tenth', remaining_hours: 0.1 })
    await task({ title: 'Two tenths', status: 'progress', remaining_hours: 0.2 })
    const lateGroup = await task({ title: 'Late group', due_date: shift(DAY, -2) })
    await task({ title: 'Under the late group', parent_id: lateGroup.id })
    await task({ title: 'Overdue, no tracking', due_date: shift(DAY, -3) }, f.sub2)
    await countOrg(t, f.org.id)
    const answer = await health(t, f.admin, scopeOf(f.admin, f.meta))
    expect(rowOf(answer, 'Firmware')).toMatchObject({
      counts: {
        state: 'ok',
        leaves: { backlog: 0, todo: 6, progress: 1, review: 0, done: 2 },
        paused: 1,
        left_tenths: 3,
      },
      delays: { state: 'ok', late: 2, behind: 1 },
    })
    expect(rowOf(answer, 'Board rev')).toMatchObject({
      counts: { state: 'ok', leaves: { todo: 1 }, paused: 0, left_tenths: 0 },
      delays: { state: 'ok', late: 0, behind: 0 },
    })
    // most Delayed first
    expect(names(answer)).toEqual(['Firmware', 'Board rev'])
  })

  it("answers My view's own figures, Left added up in tenths across sub-projects", async () => {
    const t = newT()
    const f = await withOrg(t)
    const mine = { assignee_id: f.user.id }
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, remaining_hours: 0.1, ...mine })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, remaining_hours: 0.2, ...mine })
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      remaining_hours: 5,
      assignee_id: f.admin.id,
    })
    await countOrg(t, f.org.id)
    const row = rowOf(await health(t, f.user, MINE), 'Testbed platform')
    expect(row.counts).toMatchObject({ state: 'ok', left_tenths: 3, leaves: { todo: 2 } })
    // the page shows 0.3 h; hours added up per sub-project would not
    expect(row.counts.state === 'ok' && row.counts.left_tenths / 10).toBe(0.3)
    expect(0.1 + 0.2).not.toBe(0.3)
  })
})

// ---------------------------------------------------------------------- order

/** A top-level project without a lead whose sub-projects differ in every
 * column, two of them of one name, one led by a profile that is gone, one
 * whose name sorts after the others by its bytes but before them by the
 * browser's localeCompare, read by the admin. */
async function orderCase() {
  const t = newT()
  const f = await withOrg(t)
  const zed = await plantSeat(t, { org_id: f.org.id, name: 'Zed', accepted_at: BEFORE_RULE })
  const top = await plantProject(t, { org_id: f.org.id, name: 'Ordered' })
  const plan = [
    {
      name: 'Pilot',
      lead: f.admin.id,
      done: 2,
      todo: 1,
      hours: 1.5,
      late: 1,
      behind: 0,
      paused: 0,
    },
    { name: 'Ørsted', lead: f.user.id, done: 1, todo: 3, hours: 0, late: 2, behind: 0, paused: 1 },
    { name: 'Same', lead: undefined, done: 0, todo: 0, hours: 0, late: 0, behind: 0, paused: 0 },
    { name: 'Same', lead: zed.id, done: 0, todo: 1, hours: 0, late: 0, behind: 1, paused: 0 },
    { name: 'alpha', lead: f.admin.id, done: 4, todo: 0, hours: 0, late: 0, behind: 0, paused: 0 },
    { name: 'Beta', lead: uuid(), done: 0, todo: 1, hours: 0.5, late: 0, behind: 0, paused: 0 },
  ]
  for (const p of plan) {
    const sub = await subOf(t, top, p.name, p.lead === undefined ? {} : { lead_id: p.lead })
    const task = (fields: Partial<Doc<'issues'>>) =>
      plantIssue(t, { org_id: f.org.id, project_id: sub.id, ...fields })
    for (let i = 0; i < p.done; i++) await task({ status: 'done', done_at: NOW })
    for (let i = 0; i < p.todo; i++)
      await task({
        ...(i < p.late ? { due_date: shift(DAY, -1 - i) } : {}),
        ...(i < p.behind ? { start_week: shift(DAY, -14), end_week: shift(DAY, -7) } : {}),
        ...(i < p.paused ? { paused: true } : {}),
        ...(i === 0 && p.hours > 0 ? { remaining_hours: p.hours } : {}),
      })
  }
  await countOrg(t, f.org.id)
  const leads = new Map([f.admin, f.user, zed].map((p) => [p.id, nameKey(p.name)]))
  return { t, f, top, leads, scope: scopeOf(f.admin, top) }
}

/** The order the server documents, worked out from `rows`' own figures:
 * the column's value in `dir`, then the name key and the id ascending, as
 * Convex orders values; for the name, the key in `dir` and then the id. */
function documentedOrder(
  rows: readonly HealthRow[],
  key: HealthSort,
  dir: 'asc' | 'desc',
  leads: ReadonlyMap<string, string>,
): string[] {
  const value = (r: HealthRow): Value => {
    const c = r.counts.state === 'ok' ? r.counts : null
    const all = c === null ? 0 : Object.values(c.leaves).reduce((n, x) => n + x, 0)
    const d = r.delays.state === 'ok' ? r.delays : null
    switch (key) {
      case 'name':
        return nameKey(r.name)
      case 'lead': {
        const name = r.lead_id === null ? undefined : leads.get(r.lead_id)
        return name === undefined ? [1] : [0, name]
      }
      case 'progress':
        return c && all ? Math.round((c.leaves.done / all) * 100) : 0
      case 'done':
        return c && all ? c.leaves.done / all : 0
      case 'left':
        return c?.left_tenths ?? 0
      case 'paused':
        return c?.paused ?? 0
      case 'late':
        return d?.late ?? 0
      case 'behind':
        return d?.behind ?? 0
    }
  }
  return [...rows]
    .sort((a, b) => {
      const d = compareValues(value(a), value(b))
      const asked = dir === 'asc' ? d : -d
      if (asked) return asked
      const byName = key === 'name' ? 0 : compareValues(nameKey(a.name), nameKey(b.name))
      return byName || compareValues(a.project_id, b.project_id)
    })
    .map((r) => r.project_id)
}

const SORTS: HealthSort[] = ['name', 'lead', 'progress', 'done', 'left', 'late', 'behind', 'paused']

describe('order', () => {
  it('orders the whole table by every column both ways, ties by name key and then id', async () => {
    const { t, f, leads, scope } = await orderCase()
    const all = okOf(await health(t, f.admin, scope, { sort: 'name', dir: 'asc', limit: 200 }))
    expect(all.total).toBe(6)
    for (const sort of SORTS)
      for (const dir of ['asc', 'desc'] as const) {
        const got = okOf(await health(t, f.admin, scope, { sort, dir, limit: 200 }))
        expect(got.sort, `${sort} ${dir}`).toEqual({ key: sort, dir })
        expect(
          got.rows.map((r) => r.project_id),
          `${sort} ${dir}`,
        ).toEqual(documentedOrder(all.rows, sort, dir, leads))
        // the first rows of a cut are the first rows of the whole order
        const cut = okOf(await health(t, f.admin, scope, { sort, dir, limit: 2 }))
        expect(
          cut.rows.map((r) => r.project_id),
          `${sort} ${dir}, cut`,
        ).toEqual(got.rows.slice(0, 2).map((r) => r.project_id))
      }
  })

  it("orders names by their key's bytes, where the browser's localeCompare differs", async () => {
    const { t, f, scope } = await orderCase()
    const asc = okOf(await health(t, f.admin, scope, { sort: 'name', dir: 'asc' }))
    expect(asc.rows.map((r) => r.name)).toEqual([
      'alpha',
      'Beta',
      'Pilot',
      'Same',
      'Same',
      'Ørsted',
    ])
    // the two rows of one name in id order, whichever way the names go
    const same = asc.rows.filter((r) => r.name === 'Same').map((r) => r.project_id)
    expect(same).toEqual([...same].sort())
    const desc = okOf(await health(t, f.admin, scope, { sort: 'name', dir: 'desc' }))
    expect(desc.rows.filter((r) => r.name === 'Same').map((r) => r.project_id)).toEqual(same)
    // a drifted rule: the browser's localeCompare puts Ørsted before Pilot
    const local = asc.rows.map((r) => r.name).sort((a, b) => a.localeCompare(b))
    expect(local).not.toEqual(asc.rows.map((r) => r.name))
  })

  it('puts a row without a lead, or whose lead is gone, after every lead ascending and first descending', async () => {
    const { t, f, scope } = await orderCase()
    expect(names(await health(t, f.admin, scope, { sort: 'lead', dir: 'asc' }))).toEqual([
      'alpha',
      'Pilot',
      'Ørsted',
      'Same',
      'Beta',
      'Same',
    ])
    expect(names(await health(t, f.admin, scope, { sort: 'lead', dir: 'desc' }))).toEqual([
      'Beta',
      'Same',
      'Same',
      'Ørsted',
      'alpha',
      'Pilot',
    ])
  })
})

// ---------------------------------------------------------------- the fallback

/** withOrg with FW and PCB tracking delay, counted, and in FW a task of
 * the lower of the user's and the admin's ids that its load projects late,
 * in PCB one of the higher. */
async function twoOwners() {
  const t = newT()
  const f = await withOrg(t)
  for (const p of [f.sub, f.sub2]) await t.run((ctx) => ctx.db.patch(p._id, { track_delay: true }))
  const [low, high] = byIdOrder([f.user, f.admin]) as [Doc<'profiles'>, Doc<'profiles'>]
  await projectedLate(t, f.sub, low, 'The lower owner’s')
  await projectedLate(t, f.sub2, high, 'The higher owner’s')
  await countOrg(t, f.org.id)
  return { t, f, low, high }
}

describe('the name fallback', () => {
  it("sorts a guest's table by name where a row's Delayed needs a second owner, and keeps a sort by Progress", async () => {
    const { t, f } = await twoOwners()
    const scope = scopeOf(f.guest, f.meta)
    for (const sort of ['late', 'behind'] as const) {
      const got = okOf(await health(t, f.guest, scope, { sort }))
      expect(got.sort).toEqual({ key: 'name', dir: 'asc', by_name: 'delays' })
      expect(got.rows.map((r) => r.name)).toEqual(['Board rev', 'Firmware'])
      // the row that needs the lower owner's load is judged, the other not
      expect(rowOf(got, 'Firmware').delays).toEqual({ state: 'ok', late: 1, behind: 0 })
      expect(rowOf(got, 'Board rev').delays).toEqual({ state: 'unavailable', reason: 'loads' })
    }
    const progress = okOf(await health(t, f.guest, scope, { sort: 'progress', dir: 'asc' }))
    expect(progress.sort).toEqual({ key: 'progress', dir: 'asc' })
    expect(rowOf(progress, 'Board rev').delays).toEqual({ state: 'unavailable', reason: 'loads' })
    // staff read both owners
    const staff = okOf(await health(t, f.user, scopeOf(f.user, f.meta)))
    expect(staff.sort).toEqual({ key: 'late', dir: 'desc' })
    expect(staff.rows.map((r) => r.delays)).toEqual([
      { state: 'ok', late: 1, behind: 0 },
      { state: 'ok', late: 1, behind: 0 },
    ])
  })

  it("sorts staff's table by name where an owner's load passes the owner reader's bounds", async () => {
    const { t, f, low } = await twoOwners()
    await projectedLate(t, f.sub, low, 'More of the lower owner’s')
    Object.assign(OWNER_LOADS, { open: 1 })
    const got = okOf(await health(t, f.admin, scopeOf(f.admin, f.meta)))
    expect(got.sort).toEqual({ key: 'name', dir: 'asc', by_name: 'delays' })
    expect(got.rows.map((r) => r.delays.state)).toEqual(['unavailable', 'unavailable'])
  })

  it('sorts the count columns by name while the counts are counting, and keeps the others', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, due_date: shift(DAY, -2) })
    // not counted: the counts answer counting
    const scope = scopeOf(f.admin, f.meta)
    for (const sort of ['progress', 'done', 'left', 'paused'] as const) {
      const got = okOf(await health(t, f.admin, scope, { sort }))
      expect(got.sort, sort).toEqual({ key: 'name', dir: 'asc', by_name: 'counts' })
      expect(got.rows.map((r) => r.counts)).toEqual([
        { state: 'unavailable', reason: 'counting' },
        { state: 'unavailable', reason: 'counting' },
      ])
    }
    for (const sort of ['name', 'lead', 'late', 'behind'] as const)
      expect(okOf(await health(t, f.admin, scope, { sort, dir: 'desc' })).sort, sort).toEqual({
        key: sort,
        dir: 'desc',
      })
  })

  it("answers My view's counts counting while one of the login's organizations is not counted", async () => {
    const t = newT()
    const f = await withOrg(t)
    const other = await withOrg(t)
    const there = await plantSeat(t, {
      org_id: other.org.id,
      org_role: 'admin',
      auth_user_id: f.user.auth_user_id,
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id })
    await plantIssue(t, { org_id: other.org.id, project_id: other.sub.id, assignee_id: there.id })
    await countOrg(t, f.org.id)
    const ask = () => health(t, f.user, MINE, { sort: 'progress' })
    const counting = okOf(await ask())
    expect(counting.rows).toHaveLength(2)
    expect(counting.sort).toEqual({ key: 'name', dir: 'asc', by_name: 'counts' })
    expect(counting.rows.map((r) => r.counts)).toEqual([
      { state: 'unavailable', reason: 'counting' },
      { state: 'unavailable', reason: 'counting' },
    ])
    await countOrg(t, other.org.id)
    const counted = okOf(await ask())
    expect(counted.sort).toEqual({ key: 'progress', dir: 'desc' })
    expect(counted.rows.map(leavesOf)).toEqual([1, 1])
  })

  it("answers every judged row's delays unavailable past the budget, and sorts by name", async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run((ctx) => ctx.db.patch(f.sub._id, { track_delay: true }))
    await plantTasks(t, f.sub, 30, (i) => ({ title: `Task ${i}`, due_date: shift(DAY, i - 15) }))
    await countOrg(t, f.org.id)
    const profiles = new Map([[f.admin.org_id, f.admin]])
    const scope = scopeOf(f.admin, f.meta)
    const read = () => measured(t, (ctx) => readHealth(ctx, profiles, { scope, ...ASK }))
    const whole = await read()
    expect(okOf(whole.answer).sort).toEqual({ key: 'late', dir: 'desc' })
    // a budget that holds the rows and the counts but not the delays
    Object.assign(OVERVIEW.reads, { ranges: whole.took.ranges - 20 })
    const got = okOf((await read()).answer)
    expect(got.sort).toEqual({ key: 'name', dir: 'asc', by_name: 'delays' })
    expect(got.rows.map((r) => [r.counts.state, r.delays])).toEqual([
      ['ok', { state: 'unavailable', reason: 'budget' }],
      ['ok', { state: 'unavailable', reason: 'budget' }],
    ])
  })
})

// --------------------------------------------------------------------- search

describe('search', () => {
  it('finds every word anywhere in the name key, accents ignored, past the first 10 rows, and counts the matches', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 1; i <= 12; i++) await subOf(t, f.meta, `Workstream ${String(i).padStart(2, '0')}`)
    await subOf(t, f.meta, 'Café Renovation')
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await countOrg(t, f.org.id)
    const scope = scopeOf(f.admin, f.meta)
    const ask = (search: string) => health(t, f.admin, scope, { search, sort: 'name', dir: 'asc' })
    expect(await ask('renov CAFE')).toMatchObject({ total: 1, rows: [{ name: 'Café Renovation' }] })
    expect(await ask('rénovation')).toMatchObject({ total: 1 })
    const unsearched = okOf(await ask(''))
    expect(unsearched.total).toBe(15)
    expect(unsearched.rows.map((r) => r.name)).not.toContain('Workstream 12')
    expect(await ask('12 workstream')).toMatchObject({
      total: 1,
      rows: [{ name: 'Workstream 12' }],
    })
    const many = okOf(await ask('workstream'))
    expect(many.total).toBe(12)
    expect(many.rows).toHaveLength(10)
    expect(await ask('nothing like it')).toMatchObject({ state: 'ok', rows: [], total: 0 })
    // the summary's figures do not follow the table's search
    const summary = await as(t, f.admin).query(api.overview.summary, { scope, day: DAY })
    expect(summary).toMatchObject({ counts: { state: 'ok', leaves: { todo: 1 } } })
  })
})

// ------------------------------------------------------------ the cut and cap

describe('the cut and the cap', () => {
  it('answers the first rows of the order asked, at most OVERVIEW.healthRows, and says how many it holds', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 28; i++) await subOf(t, f.meta, `Part ${String(i).padStart(2, '0')}`)
    await countOrg(t, f.org.id)
    const scope = scopeOf(f.admin, f.meta)
    const all = okOf(await health(t, f.admin, scope, { sort: 'name', dir: 'desc', limit: 30 }))
    expect(all).toMatchObject({ total: 30, most: OVERVIEW.healthRows })
    const first = okOf(await health(t, f.admin, scope, { sort: 'name', dir: 'desc' }))
    expect(first.rows.map((r) => r.project_id)).toEqual(
      all.rows.slice(0, 10).map((r) => r.project_id),
    )
    expect(first.total).toBe(30)
    // the cap lowered: the most rows an answer holds, past which a search
    // finds the rest
    Object.assign(OVERVIEW, { healthRows: 5 })
    await expectRefusal(health(t, f.admin, scope, { limit: 6 }), 'bad_request', /limit/)
    expect(await health(t, f.admin, scope, { limit: 5 })).toMatchObject({ total: 30, most: 5 })
    expect(okOf(await health(t, f.admin, scope, { limit: 5 })).rows).toHaveLength(5)
  })
})

// ---------------------------------------------------------- which rows judged

describe('which rows are judged', () => {
  it('reads no task of a row outside the answer sorted by Progress, and every row sorted by Delayed', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subs: Doc<'projects'>[] = []
    for (let i = 0; i < 28; i++)
      subs.push(await subOf(t, f.meta, `Part ${String(i).padStart(2, '0')}`))
    // the first ten parts are partly done, so Progress puts them first
    for (const [i, sub] of subs.entries())
      await plantTasks(t, sub, 20, (k) => ({
        status: i < 10 && k < 5 ? 'done' : 'todo',
        due_date: shift(DAY, k - 10),
      }))
    await countOrg(t, f.org.id)
    const profiles = new Map([[f.admin.org_id, f.admin]])
    const scope = scopeOf(f.admin, f.meta)
    const read = (sort: HealthSort) =>
      measured(t, (ctx) => readHealth(ctx, profiles, { scope, ...ASK, sort }))
    const progress = await read('progress')
    expect(names(progress.answer)).toEqual(subs.slice(0, 10).map((p) => p.name))
    const late = await read('late')
    // 20 more tasks in a part the answer sorted by Progress leaves out
    await plantTasks(t, subs[20] as Doc<'projects'>, 20, () => ({ due_date: shift(DAY, -3) }))
    const progressAfter = await read('progress')
    const lateAfter = await read('late')
    expect(progressAfter.took).toEqual(progress.took)
    expect(lateAfter.took.documents).toBeGreaterThanOrEqual(late.took.documents + 20)
    expect(rowOf(lateAfter.answer, 'Part 20').delays).toMatchObject({ late: 30 })
  })
})

// --------------------------------------------------------------- continuation

describe('continuation', () => {
  it('moves a row whose Delayed changed in the next answer, with no row twice', async () => {
    const t = newT()
    const f = await withOrg(t)
    const third = await subOf(t, f.meta, 'Third')
    for (const p of [f.sub, f.sub2])
      await t.run((ctx) => ctx.db.patch(p._id, { track_delay: true }))
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, due_date: shift(DAY, -1) })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, due_date: shift(DAY, -2) })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, due_date: shift(DAY, -1) })
    const later: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++)
      later.push(
        await plantIssue(t, { org_id: f.org.id, project_id: third.id, due_date: shift(DAY, 30) }),
      )
    await countOrg(t, f.org.id)
    const scope = scopeOf(f.admin, f.meta)
    expect(names(await health(t, f.admin, scope, { limit: 2 }))).toEqual(['Firmware', 'Board rev'])
    for (const task of later)
      await t.run((ctx) => ctx.db.patch(task._id, { due_date: shift(DAY, -4) }))
    const next = okOf(await health(t, f.admin, scope, { limit: 2 }))
    expect(next.rows.map((r) => [r.name, r.delays])).toEqual([
      ['Third', { state: 'ok', late: 3, behind: 0 }],
      ['Firmware', { state: 'ok', late: 2, behind: 0 }],
    ])
    const all = okOf(await health(t, f.admin, scope, { limit: 3 }))
    expect(new Set(all.rows.map((r) => r.project_id)).size).toBe(3)
    expect(all.total).toBe(3)
  })
})

// ------------------------------------------------------------- owner reads

describe('owner reads', () => {
  /** Three owners in owner id order, each with a task their load projects
   * late in a sub-project of their own, created in `order`, the middle
   * owner with a second one, so with OWNER_LOADS.open lowered to 1 their
   * load passes the owner reader's bounds. */
  async function ownersCase(order: 'forwards' | 'backwards') {
    const t = newT()
    const f = await withOrg(t)
    const people = byIdOrder(await plantPeople(t, f.org.id, 3))
    const made = order === 'forwards' ? people : [...people].reverse()
    const subs = new Map<string, Doc<'projects'>>()
    for (const p of made) subs.set(p.id, await subOf(t, f.meta, `Of ${people.indexOf(p)}`))
    for (const p of people) await projectedLate(t, subs.get(p.id) as Doc<'projects'>, p, 'Late')
    await projectedLate(
      t,
      subs.get(people[1]?.id ?? '') as Doc<'projects'>,
      people[1] as Doc<'profiles'>,
      'Also late',
    )
    await countOrg(t, f.org.id)
    Object.assign(OWNER_LOADS, { open: 1 })
    return { t, f, scope: scopeOf(f.admin, f.meta) }
  }

  it('reads owners in id order and none past the first it could not read, whatever order the rows come in', async () => {
    const answers: unknown[] = []
    for (const order of ['forwards', 'backwards'] as const) {
      const { t, f, scope } = await ownersCase(order)
      const got = okOf(await health(t, f.admin, scope, { sort: 'name', dir: 'asc' }))
      const delays = Object.fromEntries(got.rows.map((r) => [r.name, r.delays]))
      expect(delays, order).toEqual({
        'Board rev': { state: 'ok', late: 0, behind: 0 },
        Firmware: { state: 'ok', late: 0, behind: 0 },
        'Of 0': { state: 'ok', late: 1, behind: 0 },
        'Of 1': { state: 'unavailable', reason: 'loads' },
        'Of 2': { state: 'unavailable', reason: 'loads' },
      })
      answers.push(delays)
      // the last owner's load is readable alone, so a rule that read it
      // after the stop would answer it
      const alone = okOf(await health(t, f.admin, scope, { search: 'of 2' }))
      expect(rowOf(alone, 'Of 2').delays, order).toEqual({ state: 'ok', late: 1, behind: 0 })
    }
    expect(answers[0]).toEqual(answers[1])
  })

  it("can turn a row's Delayed unknown as Load more judges more rows: a guest's by the owner order, staff's by the budget", async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const p of [f.sub, f.sub2])
      await t.run((ctx) => ctx.db.patch(p._id, { track_delay: true }))
    const [low, high] = byIdOrder([f.user, f.admin]) as [Doc<'profiles'>, Doc<'profiles'>]
    // FW is further along, so Progress puts it first; its late task is the
    // higher owner's
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'done', done_at: NOW })
    await projectedLate(t, f.sub, high, 'The higher owner’s')
    await projectedLate(t, f.sub2, low, 'The lower owner’s')
    await countOrg(t, f.org.id)
    const scope = scopeOf(f.guest, f.meta)
    const ask = (limit: number) => health(t, f.guest, scope, { sort: 'progress', limit })
    expect(rowOf(await ask(1), 'Firmware').delays).toEqual({ state: 'ok', late: 1, behind: 0 })
    expect(rowOf(await ask(2), 'Firmware').delays).toEqual({
      state: 'unavailable',
      reason: 'loads',
    })
    expect(rowOf(await ask(2), 'Board rev').delays).toEqual({ state: 'ok', late: 1, behind: 0 })
    // staff: a budget that holds one row's delays but not two. The owners'
    // loads are read in a room built from the query's own budget (loadRoom),
    // so the higher owner's, read second, is what no longer fits: `loads`
    const profiles = new Map([[f.admin.org_id, f.admin]])
    const read = (limit: number) =>
      measured(t, (ctx) =>
        readHealth(ctx, profiles, {
          scope: scopeOf(f.admin, f.meta),
          ...ASK,
          sort: 'progress',
          limit,
        }),
      )
    const one = await read(1)
    const two = await read(2)
    expect(two.took.ranges).toBeGreaterThan(one.took.ranges)
    let flipped: HealthRow | undefined
    for (let ranges = two.took.ranges; ranges >= one.took.ranges && !flipped; ranges--) {
      Object.assign(OVERVIEW.reads, { ranges })
      const a = okOf((await read(1)).answer)
      const b = okOf((await read(2)).answer)
      if (rowOf(a, 'Firmware').delays.state === 'ok' && rowOf(b, 'Firmware').delays.state !== 'ok')
        flipped = rowOf(b, 'Firmware')
    }
    expect(flipped?.delays).toEqual({ state: 'unavailable', reason: 'loads' })
  })
})

// ---------------------------------------------------------------- hidden data

/** withOrg as a member who sees FW only, with an overdue group of theirs
 * in FW whose subtask is in PCB, which they cannot see, holding `title`,
 * and a task of theirs in PCB of that title. */
async function hiddenCase(title: string) {
  const t = newT()
  const f = await withOrg(t)
  const me = await plantSeat(t, {
    org_id: f.org.id,
    org_role: 'user',
    auth_user_id: `auth_${uuid()}`,
  })
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.sub.id,
      profile_id: me.id,
      level: 'user',
    })
    await ctx.db.patch(f.sub._id, { track_delay: true })
  })
  const group = await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    title: 'Overdue group',
    due_date: shift(DAY, -3),
    assignee_id: me.id,
  })
  await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub2.id,
    title,
    parent_id: group.id,
    status: 'done',
    done_at: NOW,
  })
  await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, title, assignee_id: me.id })
  await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Mine', assignee_id: me.id })
  await countOrg(t, f.org.id)
  return { t, f, me }
}

/* An answer without its ids, which differ between two deployments. */
const shapeOf = (answer: unknown): unknown =>
  JSON.parse(
    JSON.stringify(answer, (key, value) =>
      ['project_id', 'lead_id'].includes(key) ? undefined : value,
    ),
  )

describe('hidden data', () => {
  it("answers alike whatever a hidden subtask's or own task's title, and keeps a group with a hidden Done subtask delayed", async () => {
    const short = await hiddenCase('x')
    const long = await hiddenCase('漢'.repeat(255))
    for (const sort of ['late', 'name', 'lead'] as const)
      for (const pick of [(c: typeof short) => scopeOf(c.me, c.f.meta), () => MINE]) {
        const a = await health(short.t, short.me, pick(short), { sort })
        const b = await health(long.t, long.me, pick(long), { sort })
        expect(shapeOf(b), sort).toEqual(shapeOf(a))
      }
    // the group's hidden subtask keeps it not done, so it stays delayed
    expect(
      rowOf(await health(short.t, short.me, scopeOf(short.me, short.f.meta)), 'Firmware').delays,
    ).toEqual({ state: 'ok', late: 1, behind: 0 })
    // at a budget the visible reads just fit, both answer the same
    const read = (c: typeof short) =>
      measured(c.t, (ctx) =>
        readHealth(ctx, new Map([[c.me.org_id, c.me]]), { scope: MINE, ...ASK }),
      )
    const { took } = await read(short)
    for (const ranges of [took.ranges, took.ranges - 5]) {
      Object.assign(OVERVIEW.reads, { ranges })
      expect(shapeOf((await read(long)).answer), `${ranges} ranges`).toEqual(
        shapeOf((await read(short)).answer),
      )
    }
  })
})

// --------------------------------------------------------------- real limits

/** mixOf with every leaf open: Done leaves become To do with their
 * remaining hours, Done parents In progress. */
function openMix(...args: Parameters<typeof mixOf>): ReturnType<typeof mixOf> {
  const fields = mixOf(...args)
  if (fields.status !== 'done') return fields
  const { done_at: _done, ...rest } = fields
  const [i, , kind] = args
  return {
    ...rest,
    status: kind === 'parent' ? 'progress' : 'todo',
    ...(rest.start_week !== undefined ? { remaining_hours: ((i % 16) + 1) / 2 } : {}),
  }
}

/** `n` open tasks of the fixture mix (openMix) in `project`: per ten, one
 * parent, two subtasks under parents of the same set and seven plain
 * tasks, owned in turn by `owners`. */
async function plantOpen(
  t: T,
  project: Doc<'projects'>,
  n: number,
  owners: readonly Doc<'profiles'>[],
): Promise<void> {
  const parents = await plantTasks(t, project, Math.round(n / 10), (i) =>
    openMix(i, owners, 'parent', BEFORE_RULE),
  )
  await plantTasks(t, project, n - 3 * parents.length, (i) =>
    openMix(i, owners, 'plain', BEFORE_RULE),
  )
  await plantTasks(t, project, 2 * parents.length, (i) => ({
    ...openMix(i + 3, owners, 'subtask', BEFORE_RULE),
    parent_id: (parents[Math.floor(i / 2)] as Doc<'issues'>).id,
  }))
}

/* What one health read took, logged for the stage's report. */
const record = (label: string, took: Took, answer: HealthAnswer) =>
  console.log(
    `health reads, ${label}: ${JSON.stringify(took)} ${JSON.stringify(
      answer.state === 'ok'
        ? {
            sort: answer.sort,
            total: answer.total,
            counts: [...new Set(answer.rows.map((r) => r.counts.state))],
            delays: [
              ...new Set(
                answer.rows.map((r) => (r.delays.state === 'ok' ? 'ok' : r.delays.reason)),
              ),
            ],
          }
        : answer,
    )}`,
  )

/** Reads the health table of `scope` for `profiles` sorted by Delayed and
 * by Name, logs what each took and answers them. */
async function readSorts(
  t: T,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  label: string,
  scope: OverviewScope,
) {
  const out: Record<string, { took: Took; answer: HealthAnswer }> = {}
  for (const [sort, dir] of [
    ['late', 'desc'],
    ['name', 'asc'],
  ] as const) {
    const got = await measured(t, (ctx) => readHealth(ctx, profiles, { scope, ...ASK, sort, dir }))
    record(`${label}, sorted by ${sort}`, got.took, got.answer)
    out[sort] = got
  }
  return out as Record<'late' | 'name', { took: Took; answer: HealthAnswer }>
}

/** Checks that every row of `answer` holds its counts and delays, and that
 * the order is the one asked. */
function expectWhole(answer: HealthAnswer, sort: HealthSort) {
  const ok = okOf(answer)
  expect(ok.sort.key).toBe(sort)
  expect(ok.rows.every((r) => r.counts.state === 'ok' && r.delays.state === 'ok')).toBe(true)
}

/** withOrg with a staff member who reads `tops` top-level projects of
 * `subs` sub-projects through their teams' shares, and nine more owners. */
async function sharedCase(o: { tops: number; subs: number | ((top: number) => number) }) {
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  const me = await plantSeat(t, {
    org_id: f.org.id,
    org_role: 'user',
    auth_user_id: `auth_${uuid()}`,
    accepted_at: BEFORE_RULE,
  })
  const owners = [me, ...(await plantPeople(t, f.org.id, 9))]
  const planted = await plantShared(t, f.org.id, f.user, me, o)
  return { t, f, me, owners, ...planted, profiles: new Map([[me.org_id, me]]) }
}

describe('real limits', () => {
  it('reads 600 tasks over a project of 30 sub-projects a team of the reader shares', async () => {
    const c = await sharedCase({ tops: 1, subs: 30 })
    for (const sub of c.subs) await plantOpen(c.t, sub, 20, c.owners)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const got = await readSorts(
      c.t,
      c.profiles,
      '30 sub-projects, 600 tasks',
      scopeOf(c.me, c.tops[0] as Doc<'projects'>),
    )
    expectWhole(got.late.answer, 'late')
    expectWhole(got.name.answer, 'name')
    expect(okOf(got.late.answer).total).toBe(30)
  })

  it('reads a project of 3 sub-projects with 800 open tasks', async () => {
    const c = await sharedCase({ tops: 1, subs: 3 })
    for (const [i, sub] of c.subs.entries())
      await plantOpen(c.t, sub, i === 2 ? 266 : 267, c.owners)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const got = await readSorts(
      c.t,
      c.profiles,
      '3 sub-projects, 800 open tasks',
      scopeOf(c.me, c.tops[0] as Doc<'projects'>),
    )
    expectWhole(got.late.answer, 'late')
    expectWhole(got.name.answer, 'name')
  })

  it('reads a sub-project of 300 open tasks beside two everyday ones', async () => {
    const c = await sharedCase({ tops: 1, subs: 3 })
    for (const [i, sub] of c.subs.entries()) await plantOpen(c.t, sub, i === 0 ? 300 : 30, c.owners)
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const got = await readSorts(
      c.t,
      c.profiles,
      'a sub-project of 300 open tasks',
      scopeOf(c.me, c.tops[0] as Doc<'projects'>),
    )
    expectWhole(got.late.answer, 'late')
    expectWhole(got.name.answer, 'name')
  })

  it('reads a project with 200 Done tasks not yet archived beside everyday open ones', async () => {
    const c = await sharedCase({ tops: 1, subs: 3 })
    for (const [i, sub] of c.subs.entries()) {
      await plantOpen(c.t, sub, 30, c.owners)
      await plantTasks(c.t, sub, i === 2 ? 66 : 67, (k) => ({
        ...mixOf(k, c.owners, 'plain', BEFORE_RULE),
        status: 'done',
        done_at: BEFORE_RULE,
        remaining_hours: 0,
      }))
    }
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const got = await readSorts(
      c.t,
      c.profiles,
      '200 Done tasks beside everyday open ones',
      scopeOf(c.me, c.tops[0] as Doc<'projects'>),
    )
    expectWhole(got.late.answer, 'late')
    expectWhole(got.name.answer, 'name')
  })

  it("reads My view of 400 of the reader's tasks over the 200 sub-projects their teams share, in projects of 3", async () => {
    // 66 projects of three sub-projects and one of two
    const c = await sharedCase({ tops: 67, subs: (i) => (i === 66 ? 2 : 3) })
    expect(c.subs).toHaveLength(200)
    for (const sub of c.subs) await plantOpen(c.t, sub, 2, [c.me])
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const got = await readSorts(c.t, c.profiles, "My view, 400 of the reader's tasks", MINE)
    expectWhole(got.late.answer, 'late')
    expectWhole(got.name.answer, 'name')
    expect(okOf(got.late.answer).total).toBe(67)
  })

  it('reads an everyday project whose tasks a roster of 1,000 people owns', async () => {
    const c = await sharedCase({ tops: 1, subs: 3 })
    // withOrg's five, the reader and the nine owners make 15; 985 more
    const roster = [...c.owners]
    await c.t.run(async (ctx) => {
      for (let i = 0; i < 985; i++) {
        const _id = await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: c.f.org.id,
          name: `Person ${i}`,
          initials: 'PP',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          accepted_at: BEFORE_RULE,
          created_at: NOW,
        })
        roster.push((await ctx.db.get(_id)) as Doc<'profiles'>)
      }
    })
    // owners in turn across the roster: every task another person's
    for (const [i, sub] of c.subs.entries())
      await plantOpen(c.t, sub, 30, roster.slice(1 + i * 30, 1 + (i + 1) * 30))
    await withReach(c.t)
    await countOrg(c.t, c.f.org.id)
    const got = await readSorts(
      c.t,
      c.profiles,
      'a roster of 1,000 owning everyday tasks',
      scopeOf(c.me, c.tops[0] as Doc<'projects'>),
    )
    expectWhole(got.late.answer, 'late')
    expectWhole(got.name.answer, 'name')
  })
})

/* The organization's open tasks held by the scope's owners, outside the
 * normal suite: planting up to 10,000 tasks takes minutes in convex-test.
 * Run on demand with QIVO_HEALTH_ORG_OPEN=1. Each case keeps an everyday
 * project (3 sub-projects of 30 open tasks, 10 owners, read through a
 * team's share) and raises one figure, the organization's open tasks, all
 * held by those 10 owners, half of them scheduled, in projects the reader
 * is not shared. It logs what the table read sorted by Delayed and by
 * Name, and whether Delayed was given, for the size OVERVIEW documents. */
describe.runIf(process.env.QIVO_HEALTH_ORG_OPEN === '1')(
  "the organization's open tasks, on demand",
  () => {
    for (const each of [300, 500, 600, 700, 800, 900, 1000])
      it(`reads an everyday project whose 10 owners hold ${each * 10} open tasks`, {
        timeout: 900_000,
      }, async () => {
        const c = await sharedCase({ tops: 1, subs: 3 })
        for (const sub of c.subs) await plantOpen(c.t, sub, 30, c.owners)
        await withReach(c.t)
        await countOrg(c.t, c.f.org.id)
        // the owners' other open work, planted after the count, as it moves
        // no count of the scope: sub-projects of at most 236 tasks, three to
        // a project, each owner's tasks half scheduled
        let left = each * 10 - 90
        for (let i = 0; left > 0; i++) {
          const top = await plantProject(c.t, { org_id: c.f.org.id, name: `Elsewhere ${i}` })
          for (let k = 0; k < 3 && left > 0; k++) {
            const n = Math.min(236, left)
            left -= n
            await plantTasks(c.t, await subOf(c.t, top, `Elsewhere ${i}-${k}`), n, (j) => ({
              ...openMix(j, c.owners, 'plain', BEFORE_RULE),
              assignee_id: (c.owners[Math.floor(j / 2) % c.owners.length] as Doc<'profiles'>).id,
            }))
          }
        }
        const got = await readSorts(
          c.t,
          c.profiles,
          `the scope's 10 owners holding ${each * 10} open tasks`,
          scopeOf(c.me, c.tops[0] as Doc<'projects'>),
        )
        for (const [sort, { answer }] of Object.entries(got)) {
          const ok = okOf(answer)
          expect(ok.rows.every((r) => r.counts.state === 'ok')).toBe(true)
          // never a partial order: a row without its delays sorts by name
          if (sort === 'late' && ok.rows.some((r) => r.delays.state !== 'ok'))
            expect(ok.sort).toEqual({ key: 'name', dir: 'asc', by_name: 'delays' })
        }
      })
  },
)
