/* The fields that let the workspace parts read in one range (schema.ts: a
 * membership's and a team share's org_id, a subtask's parent_key): every
 * writer and fixture sets them (helpers.setup.ts assertRangeKeys), a people
 * window reads its memberships, a task window its subtasks and a person in
 * many teams their organization's shares in one range each, every part
 * reads as before for rows without them, and internal/rangeKeysBackfill
 * fills them while the parts keep answering the same. */

import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { BACKFILL_PAGE } from '../internal/rangeKeysBackfill'
import { OWN_READS, projectLevel, projectLevelsOf } from '../lib/access'
import { newWindowKey } from '../lib/db'
import { halve, type IdWindow } from '../lib/idWindows'
import { PAGE, readPeople, readProjects, readTasks } from '../lib/workspaceParts'
import {
  allowUnkeyedRows,
  as,
  assertRangeKeys,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'

const DEFAULT_PAGE = structuredClone(PAGE)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
const DEFAULT_BACKFILL = structuredClone(BACKFILL_PAGE)
afterEach(() => {
  Object.assign(PAGE, structuredClone(DEFAULT_PAGE))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  Object.assign(BACKFILL_PAGE, structuredClone(DEFAULT_BACKFILL))
})

const whole = { from: '', to: null }

/** `ctx` with a db that counts the index ranges it opens, by table and
 * index, in `counts`. */
function counting(ctx: QueryCtx) {
  const counts: Record<string, number> = {}
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      if (prop !== 'query') {
        const value: unknown = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (table: Parameters<QueryCtx['db']['query']>[0]) => {
        const query = target.query(table)
        return new Proxy(query, {
          get(q, name) {
            const value: unknown = Reflect.get(q, name)
            if (name === 'withIndex' && typeof value === 'function')
              return (index: string, range?: unknown) => {
                counts[`${table}:${index}`] = (counts[`${table}:${index}`] ?? 0) + 1
                return value.call(q, index, range)
              }
            return typeof value === 'function' ? value.bind(q) : value
          },
        })
      }
    },
  })
  return { ctx: { ...ctx, db }, counts }
}

/* A team of the fixture's organization. */
async function plantTeam(t: T, f: OrgFixture, name: string) {
  const id = uuid()
  await t.run((ctx) =>
    ctx.db.insert('teams', {
      id,
      org_id: f.org.id,
      name,
      track_delay_default: false,
      created_at: NOW,
    }),
  )
  return id
}

/* Takes org_id off memberships and shares, and parent_key off tasks, as
 * rows stored before them. */
const unkey = (
  t: T,
  rows: {
    members?: readonly Doc<'team_members'>[]
    shares?: readonly Doc<'project_team_access'>[]
    tasks?: readonly Doc<'issues'>[]
  },
) =>
  t.run(async (ctx) => {
    for (const m of rows.members ?? []) await ctx.db.patch(m._id, { org_id: undefined })
    for (const s of rows.shares ?? []) await ctx.db.patch(s._id, { org_id: undefined })
    for (const task of rows.tasks ?? []) await ctx.db.patch(task._id, { parent_key: undefined })
  })

describe('a people window', () => {
  it("reads its people's memberships in one range, and person by person while one lacks org_id or past PAGE.memberships", async () => {
    const t = newT()
    const f = await withOrg(t)
    const teams = [
      await plantTeam(t, f, 'A'),
      await plantTeam(t, f, 'B'),
      await plantTeam(t, f, 'C'),
    ]
    for (let i = 0; i < 30; i++) {
      const p = await plantSeat(t, { org_id: f.org.id, name: `P${i}` })
      await t.run(async (ctx) => {
        for (const team_id of [teams[i % 3], teams[(i + 1) % 3]])
          await ctx.db.insert('team_members', {
            team_id,
            profile_id: p.id,
            is_leader: false,
            org_id: f.org.id,
          })
      })
    }
    // a removed person's membership, waiting for its cleanup
    await t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: teams[0],
        profile_id: uuid(),
        is_leader: false,
        org_id: f.org.id,
      }),
    )
    /* every person's memberships, read person by person, in people order */
    const expected = await t.run(async (ctx) => {
      const people = (await ctx.db.query('profiles').collect())
        .filter((p) => p.org_id === f.org.id)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
      const out: Omit<Doc<'team_members'>, '_id' | '_creationTime' | 'org_id'>[] = []
      for (const p of people)
        for (const m of await ctx.db
          .query('team_members')
          .withIndex('by_profile', (q) => q.eq('profile_id', p.id))
          .collect()) {
          const { _id, _creationTime, org_id, ...row } = m
          out.push(row)
        }
      return out
    })
    expect(expected.length).toBe(62)
    const read = () =>
      t.run(async (ctx) => {
        const { ctx: counted, counts } = counting(ctx)
        const answer = await readPeople(counted, f.admin, whole)
        if (answer.state !== 'ok') throw new Error(answer.state)
        return { members: answer.teamMembers, counts }
      })
    const keyed = await read()
    expect(keyed.members).toEqual(expected)
    expect(keyed.counts['team_members:by_org_profile']).toBe(2)
    expect(keyed.counts['team_members:by_profile']).toBeUndefined()
    // past PAGE.memberships, person by person
    PAGE.memberships = 10
    const many = await read()
    expect(many.members).toEqual(expected)
    expect(many.counts['team_members:by_profile']).toBeGreaterThan(30)
    PAGE.memberships = DEFAULT_PAGE.memberships
    // one membership stored before org_id: person by person, the same
    allowUnkeyedRows(t)
    const one = await t.run((ctx) =>
      ctx.db
        .query('team_members')
        .withIndex('by_profile', (q) => q.eq('profile_id', f.user.id))
        .collect(),
    )
    await unkey(t, { members: one })
    const unkeyed = await read()
    expect(unkeyed.members).toEqual(expected)
    expect(unkeyed.counts['team_members:by_profile']).toBeGreaterThan(30)
  })
})

describe('a tasks window', () => {
  /* 24 tasks, every third with two subtasks, one of those in a sub-project
   * the guest cannot see, and one archived subtask */
  async function family(t: T, f: OrgFixture) {
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const parents: Doc<'issues'>[] = []
    for (let i = 0; i < 24; i++) {
      const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      parents.push(parent)
      if (i % 3 !== 0) continue
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id })
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: i % 2 === 0 ? hiddenSub.id : f.sub2.id,
        parent_id: parent.id,
      })
    }
    await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parents[1].id,
      archived_at: NOW,
    })
    return parents
  }

  /* what windows `ws` answer as `who` about each task, whether it is a
   * group and has hidden subtasks, each window in its own transaction */
  const answers = async (t: T, who: Doc<'profiles'>, ws: readonly IdWindow[] = [whole]) => {
    const out: Record<string, [boolean | undefined, boolean]> = {}
    const counts: Record<string, number> = {}
    for (const w of ws) {
      const one = await t.run(async (ctx) => {
        const counted = counting(ctx)
        const answer = await readTasks(counted.ctx, who, w)
        if (answer.state !== 'ok') throw new Error(answer.state)
        return { answer, counts: counted.counts }
      })
      for (const task of one.answer.issues)
        out[task.id] = [task.has_subtasks, task.has_hidden_subtasks]
      for (const [k, n] of Object.entries(one.counts)) counts[k] = (counts[k] ?? 0) + n
    }
    return { out, counts }
  }

  it('reads the active subtasks of its tasks in one range, across windows, and task by task while one lacks parent_key', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parents = await family(t, f)
    for (const who of [f.admin, f.guest]) {
      const keyed = await answers(t, who)
      expect(keyed.counts['issues:by_parent_archived']).toBeUndefined()
      expect(keyed.counts['issues:by_org_archived_parent_key']).toBe(2)
      // every third task is a group; the guest sees half of them hide one
      for (const [i, p] of parents.entries()) {
        const [group, hidden] = keyed.out[p.id]
        expect(group, `task ${i}`).toBe(i % 3 === 0)
        expect(hidden, `task ${i}`).toBe(who === f.guest && i % 6 === 0)
      }
      // a subtask in another window than its parent counts in the parent's
      const halves = halve(whole)
      if (halves === null) throw new Error('whole window cannot be cut')
      expect((await answers(t, who, halves)).out).toEqual(keyed.out)
    }
    // one active subtask stored before parent_key: task by task, the same
    allowUnkeyedRows(t)
    const before = await answers(t, f.guest)
    const kid = await t.run(
      async (ctx) =>
        (await ctx.db
          .query('issues')
          .withIndex('by_parent_archived', (q) =>
            q.eq('parent_id', parents[3].id).eq('archived_at', undefined),
          )
          .first())!,
    )
    await unkey(t, { tasks: [kid] })
    const unkeyed = await answers(t, f.guest)
    expect(unkeyed.out).toEqual(before.out)
    expect(unkeyed.counts['issues:by_parent_archived']).toBeGreaterThanOrEqual(24)
  })
})

describe('a person in many teams', () => {
  /* `me` in 20 teams, and 40 sub-projects with a task each, shared with
   * one of 30 teams, half of them the person's */
  async function teamsAndShares(t: T, f: OrgFixture) {
    const me = await plantSeat(t, { org_id: f.org.id, org_role: 'user', name: 'Many' })
    const teams: string[] = []
    for (let i = 0; i < 30; i++) teams.push(await plantTeam(t, f, `T${i}`))
    await t.run(async (ctx) => {
      for (const team_id of teams.slice(0, 20))
        await ctx.db.insert('team_members', {
          team_id,
          profile_id: me.id,
          is_leader: false,
          org_id: f.org.id,
        })
    })
    const subs: Doc<'projects'>[] = []
    for (let i = 0; i < 40; i++) {
      const sub = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.hidden.id,
      })
      subs.push(sub)
      await plantIssue(t, { org_id: f.org.id, project_id: sub.id })
      await t.run((ctx) =>
        ctx.db.insert('project_team_access', {
          project_id: sub.id,
          team_id: teams[i % 2 === 0 ? i % 20 : 20 + (i % 10)],
          level: 'user',
          org_id: f.org.id,
        }),
      )
    }
    return { me, subs }
  }

  it("reads the organization's shares in one range instead of one range a project or a team, and as before while one lacks org_id", async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await teamsAndShares(t, f)
    OWN_READS.steps = [1]
    const read = () =>
      t.run(async (ctx) => {
        const { ctx: counted, counts } = counting(ctx)
        const answer = await readTasks(counted, me, whole)
        if (answer.state !== 'ok') throw new Error(answer.state)
        const levels = []
        for (const p of subs) levels.push(await projectLevel(ctx, me, p))
        return { shown: answer.issues.map((i) => i.project_id).sort(), counts, levels }
      })
    const keyed = await read()
    // the person's teams share every other project
    expect(keyed.shown).toEqual(
      subs
        .filter((_, i) => i % 2 === 0)
        .map((p) => p.id)
        .sort(),
    )
    expect(keyed.counts['project_team_access:by_org']).toBe(2)
    expect(keyed.counts['project_team_access:by_project']).toBeUndefined()
    expect(keyed.counts['project_team_access:by_team']).toBeUndefined()
    // a share stored before org_id: project by project, the same
    allowUnkeyedRows(t)
    const share = await t.run(
      async (ctx) =>
        (await ctx.db
          .query('project_team_access')
          .withIndex('by_project', (q) => q.eq('project_id', subs[5].id))
          .first())!,
    )
    await unkey(t, { shares: [share] })
    const unkeyed = await read()
    expect(unkeyed.shown).toEqual(keyed.shown)
    expect(unkeyed.levels).toEqual(keyed.levels)
    expect(unkeyed.counts['project_team_access:by_project']).toBeGreaterThanOrEqual(39)
  })

  it("shows a parent for navigation from the organization's shares, without reading team by team", async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await teamsAndShares(t, f)
    const answer = await t.run(async (ctx) => {
      const { ctx: counted, counts } = counting(ctx)
      const levels = projectLevelsOf(counted, me)
      const level = await levels.level(f.hidden.id)
      const projects = await readProjects(counted, me, whole)
      return { level, counts, projects }
    })
    expect(answer.level).toBe('viewer')
    expect(answer.counts['project_team_access:by_team']).toBeUndefined()
    if (answer.projects.state !== 'ok') throw new Error(answer.projects.state)
    expect(answer.projects.projects.map((p) => p.id)).toContain(f.hidden.id)
    expect(answer.projects.projects.map((p) => p.id)).toContain(subs[0].id)
  })
})

describe('the range keys check', () => {
  type Ctx = Parameters<Parameters<T['run']>[0]>[0]
  type Planted = { f: OrgFixture; parent: Doc<'issues'>; kid: Doc<'issues'> }
  // each wrong write, on a fresh fixture
  const cases: [string, (ctx: Ctx, p: Planted) => Promise<unknown>][] = [
    [
      'membership',
      (ctx, { f }) =>
        ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: f.viewer.id,
          is_leader: false,
        }),
    ],
    [
      'membership',
      (ctx, { f }) =>
        ctx.db.insert('team_members', {
          team_id: f.team.id,
          profile_id: f.viewer.id,
          is_leader: false,
          org_id: f.otherOrg.id,
        }),
    ],
    [
      'share',
      (ctx, { f }) =>
        ctx.db.insert('project_team_access', {
          project_id: f.sub.id,
          team_id: f.team.id,
          level: 'user',
        }),
    ],
    ['subtask', (ctx, { kid }) => ctx.db.patch(kid._id, { parent_key: undefined })],
    ['subtask', (ctx, { kid }) => ctx.db.patch(kid._id, { parent_key: newWindowKey() })],
    ['top-level', (ctx, { parent }) => ctx.db.patch(parent._id, { parent_key: newWindowKey() })],
  ]

  it('refuses a membership, a share or a subtask written without its field, or with a wrong one', async () => {
    for (const [what, write] of cases) {
      const t = newT()
      const f = await withOrg(t)
      allowUnkeyedRows(t)
      const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      const kid = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        parent_id: parent.id,
      })
      expect(kid.parent_key).toBe(parent.window_key)
      await assertRangeKeys(t)
      await t.run((ctx) => write(ctx, { f, parent, kid }))
      await expect(assertRangeKeys(t), what).rejects.toThrow(what)
    }
  })
})

describe('internal/rangeKeysBackfill', () => {
  /* What every part of the workspace sends each person. */
  const everything = async (t: T, f: OrgFixture) =>
    await Promise.all([f.admin, f.user, f.viewer, f.guest].map((p) => workspaceOf(as(t, p))))

  it('asks for fewer rows when the parents of a page would pass the real limits', async () => {
    const t = newT({
      transactionLimits: {
        bytesRead: 16 * 1024 * 1024,
        documentsRead: 32_000,
        databaseQueries: 4096,
      },
    })
    const f = await withOrg(t)
    // 20 parents of 900 KiB, a description from before the 20,000-character
    // cap, then a subtask of each stored before parent_key, all in one page:
    // about 18 MiB of parents
    const parents: Doc<'issues'>[] = []
    for (let i = 0; i < 20; i++)
      parents.push(
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: f.sub.id,
          description: 'Field note. '.repeat(76_800),
        }),
      )
    const kids: Doc<'issues'>[] = []
    for (const parent of parents)
      kids.push(
        await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id }),
      )
    await unkey(t, { tasks: kids })
    // a page of subtasks reads too much and asks for fewer rows, which fit
    let rows = 0
    let fewer = 0
    let from: { cursor: string | null; rows?: number } = { cursor: null }
    for (;;) {
      const page = await t.query(internal.internal.rangeKeysBackfill.remaining, {
        table: 'issues',
        ...from,
      })
      rows += page.rows
      if (page.fewer !== undefined) {
        fewer++
        expect(page.rows).toBe(0)
        from = { cursor: from.cursor, rows: page.fewer }
      } else if (page.done) break
      else from = { cursor: page.cursor }
    }
    expect(fewer).toBeGreaterThan(0)
    expect(rows).toBe(20)
    const result = await t.action(internal.internal.rangeKeysBackfill.run, { dry_run: false })
    expect(result.issues).toEqual({ rows: 20, orphans: 0 })
    expect(result.next).toBeNull()
    const keys = await t.run(async (ctx) =>
      Promise.all(kids.map(async (kid) => (await ctx.db.get(kid._id))?.parent_key)),
    )
    expect(keys).toEqual(parents.map((p) => p.window_key))
  }, 120_000)

  it('fills every field, repairs wrong ones and counts orphans, while every part keeps answering the same', async () => {
    const t = newT()
    const f = await withOrg(t)
    allowUnkeyedRows(t)
    const teams = [await plantTeam(t, f, 'A'), await plantTeam(t, f, 'B')]
    await t.run(async (ctx) => {
      for (const team_id of teams) {
        for (const p of [f.viewer, f.user])
          await ctx.db.insert('team_members', {
            team_id,
            profile_id: p.id,
            is_leader: false,
            org_id: f.org.id,
          })
        await ctx.db.insert('project_team_access', {
          project_id: f.sub2.id,
          team_id,
          level: 'viewer',
          org_id: f.org.id,
        })
      }
    })
    const parents: Doc<'issues'>[] = []
    for (let i = 0; i < 6; i++) {
      const parent = await plantIssue(t, {
        org_id: f.org.id,
        project_id: i < 3 ? f.sub.id : f.sub2.id,
      })
      parents.push(parent)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, parent_id: parent.id })
    }
    const shown = await everything(t, f)
    // every row as stored before the fields
    const stored = await t.run(async (ctx) => ({
      members: await ctx.db.query('team_members').collect(),
      shares: await ctx.db.query('project_team_access').collect(),
      kids: (await ctx.db.query('issues').collect()).filter((task) => task.parent_id !== undefined),
    }))
    await unkey(t, { members: stored.members, shares: stored.shares, tasks: stored.kids })
    expect(await everything(t, f)).toEqual(shown)
    // a wrong one, a top-level task with one, and rows it cannot place: a
    // membership of a gone person and team, a subtask under a parent without
    // a window key
    const keyless = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      await ctx.db.patch(stored.shares[0]._id, { org_id: f.otherOrg.id })
      await ctx.db.patch(parents[0]._id, { parent_key: 'stray' })
      await ctx.db.insert('team_members', { team_id: uuid(), profile_id: uuid(), is_leader: false })
      await ctx.db.patch(keyless._id, { window_key: undefined })
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: keyless.id })
    const after = await everything(t, f)
    /* every page of `remaining` for each table, summed */
    const remaining = async () => {
      const out: Record<string, { rows: number; orphans: number }> = {}
      for (const table of ['team_members', 'project_team_access', 'issues'] as const) {
        out[table] = { rows: 0, orphans: 0 }
        let cursor: string | null = null
        for (;;) {
          const page: { rows: number; orphans: number; cursor: string | null; done: boolean } =
            await t.query(internal.internal.rangeKeysBackfill.remaining, { table, cursor })
          out[table].rows += page.rows
          out[table].orphans += page.orphans
          if (page.done) break
          cursor = page.cursor
        }
      }
      return out
    }
    BACKFILL_PAGE.rows = { team_members: 2, project_team_access: 2, issues: 2 }
    const before = {
      team_members: { rows: stored.members.length, orphans: 1 },
      project_team_access: { rows: stored.shares.length, orphans: 0 },
      // the six subtasks, the stray key; the subtask under the keyless parent
      issues: { rows: 7, orphans: 1 },
    }
    expect(await remaining()).toEqual(before)
    expect(await t.action(internal.internal.rangeKeysBackfill.run, { dry_run: true })).toEqual({
      dry_run: true,
      ...before,
      next: null,
    })
    // a run that stops at its time goes on from where it stopped
    BACKFILL_PAGE.runMs = 0
    let from:
      | { table: 'team_members' | 'project_team_access' | 'issues'; cursor: string | null }
      | undefined
    const pieces: { rows: number; orphans: number }[] = []
    for (let runs = 0; runs < 100; runs++) {
      const part = await t.action(internal.internal.rangeKeysBackfill.run, { dry_run: true, from })
      pieces.push(part.team_members, part.project_team_access, part.issues)
      if (part.next === null) break
      from = part.next
    }
    expect(pieces.length / 3).toBeGreaterThan(3)
    expect(pieces.reduce((n, c) => n + c.rows + c.orphans, 0)).toBe(
      Object.values(before).reduce((n, c) => n + c.rows + c.orphans, 0),
    )
    BACKFILL_PAGE.runMs = DEFAULT_BACKFILL.runMs
    expect(await remaining()).toEqual(before)
    // page by page, every part answers the same after each
    for (const table of ['team_members', 'project_team_access', 'issues'] as const) {
      let cursor: string | null = null
      for (;;) {
        const page: { cursor: string | null; done: boolean } = await t.mutation(
          internal.internal.rangeKeysBackfill.page,
          { table, dry_run: false, cursor },
        )
        expect(await everything(t, f)).toEqual(after)
        if (page.done) break
        cursor = page.cursor
      }
    }
    const left = {
      team_members: { rows: 0, orphans: 1 },
      project_team_access: { rows: 0, orphans: 0 },
      issues: { rows: 0, orphans: 1 },
    }
    expect(await remaining()).toEqual(left)
    expect(await t.action(internal.internal.rangeKeysBackfill.run, { dry_run: false })).toEqual({
      dry_run: false,
      ...left,
      next: null,
    })
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit.map((row) => [row.action, row.actor_email])).toEqual([
      ['range_keys_backfill', 'system'],
    ])
    // the orphaned membership is the only row left without its field
    const members = await t.run((ctx) => ctx.db.query('team_members').collect())
    expect(members.filter((m) => m.org_id === undefined)).toHaveLength(1)
    const share = await t.run((ctx) => ctx.db.get(stored.shares[0]._id))
    expect(share?.org_id).toBe(f.org.id)
  })
})
