/* The Overview's counts (schema.ts overview_counts, model/overviewCounts.ts):
 * after every writer, each sub-project's and each owner's rows equal a
 * recount of the tasks, and overview_groups holds exactly the active tasks
 * with an active subtask in a live project. Project archives, restores and
 * moves to Deleted items reconcile in background steps (overviewRegroup.ts)
 * while the counts answer `counting`; the backfill
 * (internal/overviewCountsBackfill.ts) counts an organization exactly while
 * writes go on between its steps; seeds and teardowns leave counted
 * organizations or none of their rows. */

import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { COUNT_PAGE, RUN } from '../internal/overviewCountsBackfill'
import { byId } from '../lib/db'
import { ISSUE_STATUSES } from '../lib/enums'
import { taskOwnerId } from '../lib/review'
import { REMOVAL_BUDGET } from '../model/cascade'
import { writeNorthstarWork } from '../model/demoSeed'
import { wipeWorkStep } from '../model/orgDeletion'
import { DEFAULT_ARCHIVE_DAYS } from '../model/orgs'
import {
  addCounts,
  countsReady,
  countWhole,
  type LeafCounts,
  noCounts,
  OVERVIEW_SHARDS,
  OVERVIEW_TABLES,
  overviewCountRun,
  overviewRegroupOf,
  stampOverview,
  subProjectCounts,
} from '../model/overviewCounts'
import { removeProjectGrantCore } from '../model/projectAccess'
import { OVERVIEW_REGROUP } from '../overviewRegroup'
import { as, NOW, newT, type OrgFixture, plantSeat, type T, uuid, withOrg } from './helpers.setup'
import { NORTHSTAR, northstarId, plantNorthstar } from './northstar.setup'
import { assertNoDanglingRefs } from './refs.setup'
import { deleteProject, deleteTask, installTrashTimers, itemFor, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULT_COUNT_PAGE = { ...COUNT_PAGE }
const DEFAULT_RUN = { ...RUN }
const DEFAULT_REGROUP = { ...OVERVIEW_REGROUP }
const DEFAULT_REMOVAL = { ...REMOVAL_BUDGET }
afterEach(() => {
  Object.assign(COUNT_PAGE, DEFAULT_COUNT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
  Object.assign(OVERVIEW_REGROUP, DEFAULT_REGROUP)
  Object.assign(REMOVAL_BUDGET, DEFAULT_REMOVAL)
  vi.restoreAllMocks()
})

/** Count rows as a test compares them: by sub-project, owner and shard,
 * all-zero rows left out. */
type Rows = Record<string, LeafCounts>

const isZero = (c: LeafCounts) =>
  c.paused === 0 && c.left_tenths === 0 && ISSUE_STATUSES.every((s) => c.leaves[s] === 0)

/** What the organization's tasks give, counted from the rows themselves
 * by lib/liveTasks.ts countsAsSubtask and lib/review.ts taskOwnerId: the
 * rows of every sub-project (live or archived) and owner, and the active
 * tasks with an active subtask in a live project. */
const truth = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const projects = new Map(
      (
        await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', orgId))
          .collect()
      ).map((p) => [p.id, p]),
    )
    const tasks = await ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) => q.eq('org_id', orgId).eq('archived_at', undefined))
      .collect()
    const live = (id: string) => projects.get(id)?.archived_at === undefined && projects.has(id)
    const active = new Set(tasks.map((task) => task.id))
    const groups = new Set<string>()
    for (const kid of tasks)
      if (kid.parent_id !== undefined && live(kid.project_id) && active.has(kid.parent_id))
        groups.add(kid.parent_id)
    const rows: Rows = {}
    const add = (key: string, task: Doc<'issues'>) => {
      const c = noCounts()
      c.leaves[task.status] = 1
      c.paused = task.paused ? 1 : 0
      c.left_tenths = task.status === 'done' ? 0 : Math.round((task.remaining_hours ?? 0) * 10)
      rows[key] = addCounts(rows[key] ?? noCounts(), c)
    }
    for (const task of tasks) {
      const project = projects.get(task.project_id)
      if (groups.has(task.id) || project === undefined || project.parent_id === undefined) continue
      add(`${project.id}||${task.num % OVERVIEW_SHARDS}`, task)
      const owner = taskOwnerId(task, false)
      if (owner !== undefined) add(`${project.id}|${owner}|0`, task)
    }
    for (const key of Object.keys(rows)) if (isZero(rows[key])) delete rows[key]
    return { rows, groups: [...groups].sort() }
  })

/** What the organization's count rows hold, and the tasks its task rows
 * hold as groups, those of an earlier project or task with the same id left
 * out. */
const stored = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const rows: Rows = {}
    for (const row of await ctx.db
      .query('overview_counts')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()) {
      const project = await byId(ctx, 'projects', row.project_id)
      if (project === null || project._creationTime !== row.project_at) continue
      const key = `${row.project_id}|${row.owner_id ?? ''}|${row.shard}`
      expect(rows[key], `two rows for ${key}`).toBeUndefined()
      const counts = { leaves: row.leaves, paused: row.paused, left_tenths: row.left_tenths }
      if (!isZero(counts)) rows[key] = counts
    }
    const groups: string[] = []
    for (const row of await ctx.db
      .query('overview_tasks')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()) {
      const task = await byId(ctx, 'issues', row.task_id)
      // a row holds only an active task's state
      expect(task?.archived_at, `the task row of ${row.task_id}`).toBeUndefined()
      if (task !== null && task._creationTime === row.task_at && row.group) groups.push(row.task_id)
    }
    return { rows, groups: groups.sort() }
  })

/** Expects the organization's rows to equal a recount, and every live
 * sub-project's counts to read whole and as the recount gives. */
async function expectExact(t: T, orgId: string, label = ''): Promise<void> {
  const want = await truth(t, orgId)
  expect(await stored(t, orgId), label).toEqual(want)
  const read = await t.run(async (ctx) => {
    const out: Record<string, LeafCounts | null> = {}
    for (const p of await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect())
      if (p.parent_id !== undefined && p.archived_at === undefined)
        out[p.id] = await subProjectCounts(ctx.db, p)
    return out
  })
  for (const [projectId, counts] of Object.entries(read)) {
    let sum = noCounts()
    for (const [key, c] of Object.entries(want.rows))
      if (key.startsWith(`${projectId}||`)) sum = addCounts(sum, c)
    expect(counts, `${label} ${projectId}`).toEqual(sum)
  }
}

/** Stamps an organization with no task counted, as insertOrgRows does. */
const stamp = (t: T, orgId: string) => t.run((ctx) => stampOverview(ctx.db, orgId, NOW))

/** The fixture's writers, as a lead of the fixture's project uses them. */
function writers(t: T, f: OrgFixture) {
  const org_id = f.org.id
  return {
    create: (extra: Record<string, unknown> = {}) =>
      as(t, f.user).mutation(api.issues.create, {
        org_id,
        id: uuid(),
        project_id: f.sub.id,
        title: 'Counted task',
        ...extra,
      }),
    update: (id: string, patch: Record<string, unknown>) =>
      as(t, f.user).mutation(api.issues.update, { org_id, id, patch }),
    move: (id: string, project_id: string) =>
      as(t, f.user).mutation(api.issues.move, { org_id, id, project_id }),
    archive: (id: string) => as(t, f.user).mutation(api.issues.archive, { org_id, id }),
    unarchive: (id: string) => as(t, f.user).mutation(api.issues.unarchive, { org_id, id }),
  }
}

describe('overview counts', () => {
  it('every writer keeps the rows equal to a recount, by sub-project and by owner', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const exact = (label: string) => expectExact(t, org_id, label)

    const a = await w.create({ status: 'progress', assignee_id: f.user.id, remaining_hours: 3.5 })
    const b = await w.create({
      status: 'todo',
      assignee_id: f.admin.id,
      paused: true,
      remaining_hours: 1.2,
    })
    const c = await w.create({ project_id: f.sub2.id, status: 'done', assignee_id: f.user.id })
    await exact('creates')
    // the review hand-off gives the leaf to its reviewer
    await w.update(a.id, { status: 'review', reviewer_id: f.admin.id })
    await w.update(b.id, { paused: false, remaining_hours: 0.3 })
    await w.update(b.id, { assignee_id: null })
    await exact('edits')

    // a subtask in the sibling sub-project makes its parent a group, and
    // its moves, detach and archive take it back and forth
    const kid = await w.create({
      project_id: f.sub2.id,
      parent_id: a.id,
      status: 'todo',
      assignee_id: f.user.id,
      remaining_hours: 2,
    })
    await exact('a subtask in the sibling sub-project')
    await w.move(kid.id, f.sub.id)
    await exact('the subtask moved')
    await w.update(kid.id, { parent_id: null })
    await exact('the subtask detached')
    await w.update(kid.id, { parent_id: a.id })
    await exact('the subtask attached again')
    await w.archive(kid.id)
    await exact('the subtask archived')
    await w.unarchive(kid.id)
    await exact('the subtask restored')
    // the parent's archive takes the subtask, whose restore brings it back
    await w.archive(a.id)
    await exact('the parent archived')
    await w.unarchive(kid.id)
    await exact('the subtask restored with its parent')
    // a move carries the subtask
    await w.move(a.id, f.sub2.id)
    await exact('the parent moved with its subtask')

    // a machine update
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'user',
      }),
    )
    const machine = (ref: number, args: Record<string, unknown>) =>
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        ref: `QN-${ref}`,
        ...args,
      })
    await machine(b.num, { status: 'progress' })
    await machine(b.num, { archived: true })
    await exact('a machine archive')
    await machine(b.num, { archived: false })
    await exact('a machine restore')

    // the Roadmap and its undo
    const session_id = uuid()
    await as(t, f.user).mutation(api.roadmap.change, {
      session_id,
      operations: [
        {
          kind: 'task',
          id: b.id,
          patch: { start_week: '2026-01-05', end_week: '2026-01-12', remaining_hours: 7.5 },
        },
      ],
    })
    await exact('a Roadmap change')
    await as(t, f.user).mutation(api.roadmap.undo, { session_id, all: true })
    await exact('a Roadmap undo')

    // the nightly archive takes a Done task past the threshold
    await t.run(async (ctx) => {
      const row = (await byId(ctx, 'issues', c.id)) as Doc<'issues'>
      // done_at is no counted field
      await ctx.db.patch(row._id, {
        done_at: new Date(Date.parse(NOW) - (DEFAULT_ARCHIVE_DAYS + 1) * 86_400_000).toISOString(),
      })
    })
    await t.mutation(internal.jobs.archiveDoneIssues, { now: NOW })
    await runSteps(t)
    expect((await t.run((ctx) => byId(ctx, 'issues', c.id)))?.archived_at).toBe(NOW)
    await exact('the nightly archive')

    // a task to Deleted items, its subtask left behind, and back
    await deleteTask(t, f, a.id)
    await runSteps(t)
    await exact('a parent to Deleted items')
    await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id,
      ids: [(await itemFor(t, a.id)).id],
    })
    await runSteps(t)
    await exact('the parent back from Deleted items')

    // a project with its tasks to Deleted items, back, and out for good
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    await exact('a sub-project to Deleted items')
    await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id,
      ids: [(await itemFor(t, f.sub2.id)).id],
    })
    await runSteps(t)
    await exact('the sub-project back from Deleted items')
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    await as(t, f.admin).mutation(api.deletedItems.purge, {
      org_id,
      ids: [(await itemFor(t, f.sub2.id)).id],
    })
    await runSteps(t)
    await exact('the sub-project purged')
    // nobody reads a gone sub-project's rows, and its regroup deleted them
    expect(
      (await t.run((ctx) => ctx.db.query('overview_counts').collect())).filter(
        (r) => r.project_id === f.sub2.id,
      ),
    ).toEqual([])

    // a person removed: their leaves leave their rows
    const leaver = await plantSeat(t, { org_id, name: 'Leaver', accepted_at: NOW })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: leaver.id,
        level: 'user',
      }),
    )
    const held = await w.create({ assignee_id: leaver.id, remaining_hours: 4 })
    await w.create({ status: 'review', assignee_id: f.user.id, reviewer_id: leaver.id })
    await exact('the leaver holds tasks')
    await as(t, f.admin).mutation(api.profiles.remove, { org_id, id: leaver.id })
    await runSteps(t)
    expect((await t.run((ctx) => byId(ctx, 'issues', held.id)))?.assignee_id).toBeUndefined()
    await exact('the leaver removed')
    // their rows went with the removal's steps
    expect(
      (await t.run((ctx) => ctx.db.query('overview_counts').collect())).filter(
        (r) => r.owner_id === leaver.id,
      ),
    ).toEqual([])

    // the operator repair of hours past the cap, on a row stored over it
    const over = await w.create({ remaining_hours: 5 })
    await t.run(async (ctx) => {
      const row = (await byId(ctx, 'issues', over.id)) as Doc<'issues'>
      await ctx.db.patch(row._id, { remaining_hours: 250_000 })
      await countWhole(ctx.db, org_id, NOW)
    })
    await exact('a row stored over the cap')
    await t.mutation(internal.internal.overCapRows.page, {
      phase: 'issues',
      dry_run: false,
      cursor: null,
    })
    expect((await t.run((ctx) => byId(ctx, 'issues', over.id)))?.remaining_hours).toBe(99_999.9)
    await exact('the over-cap repair')
    await assertNoDanglingRefs(t, 'overview counts')
  }, 120_000)

  it("an access removal's handover moves many tasks' owners in one transaction", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const holder = await plantSeat(t, { org_id, name: 'Holder', accepted_at: NOW })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: holder.id,
        level: 'user',
      }),
    )
    for (let i = 0; i < 30; i++)
      await w.create({
        project_id: i % 2 === 0 ? f.sub.id : f.sub2.id,
        status: i % 3 === 0 ? 'review' : 'progress',
        assignee_id: holder.id,
        ...(i % 3 === 0 ? { reviewer_id: f.user.id } : {}),
        remaining_hours: i / 10,
      })
    await expectExact(t, org_id, 'before the handover')
    await t.run(async (ctx) =>
      removeProjectGrantCore(ctx, {
        me: (await byId(ctx, 'profiles', f.user.id)) as Doc<'profiles'>,
        project: (await byId(ctx, 'projects', f.meta.id)) as Doc<'projects'>,
        subject: { profile: (await byId(ctx, 'profiles', holder.id)) as Doc<'profiles'> },
        held: { reassign_to: f.admin.id },
        now: NOW,
      }),
    )
    const rows = (await truth(t, org_id)).rows
    expect(Object.keys(rows).some((key) => key.includes(holder.id))).toBe(false)
    await expectExact(t, org_id, 'after the handover')
  }, 60_000)

  it('a project archive, restore and move reconcile in background steps, whatever lands first', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const ready = () => t.run((ctx) => countsReady(ctx.db, org_id, f.meta.id))
    const parent = await w.create({
      status: 'progress',
      assignee_id: f.user.id,
      remaining_hours: 2,
    })
    await w.create({ project_id: f.sub2.id, parent_id: parent.id, assignee_id: f.user.id })
    await expectExact(t, org_id, 'a subtask in the sibling')

    // the sibling archived: until the step runs its project's counts are
    // not whole, and a write meanwhile reconciles the parent first
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    expect(await ready()).toBe(false)
    expect(await t.run((ctx) => subProjectCounts(ctx.db, f.sub))).toBeNull()
    const second = await w.create({ parent_id: parent.id })
    await runSteps(t)
    expect(await ready()).toBe(true)
    await expectExact(t, org_id, 'archived, with a second subtask meanwhile')
    await w.archive(second.id)
    await expectExact(t, org_id, 'its only live subtask archived')

    // restored, archived and restored again before any step runs
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.sub2.id })
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.sub2.id })
    expect((await t.run((ctx) => overviewRegroupOf(ctx.db, f.meta.id)))?.projects).toEqual([
      f.sub2.id,
      f.sub2.id,
      f.sub2.id,
    ])
    await runSteps(t)
    await expectExact(t, org_id, 'restored, archived and restored again')

    // the top-level project with its sub-projects, and back
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.meta.id })
    await runSteps(t)
    await expectExact(t, org_id, 'the top-level project archived')
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.meta.id })
    await runSteps(t)
    await expectExact(t, org_id, 'the top-level project restored')

    // steps that stop on their room after one task each
    Object.assign(OVERVIEW_REGROUP, { tasks: 2, room: 0 })
    for (let n = 0; n < 5; n++) {
      const p = await w.create({ assignee_id: f.admin.id, remaining_hours: n })
      await w.create({ project_id: f.sub2.id, parent_id: p.id })
    }
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    await runSteps(t)
    expect(await ready()).toBe(true)
    await expectExact(t, org_id, 'archived in small steps')
  }, 60_000)

  it('readers answer counting, never zero, and a row that goes negative says so', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const w = writers(t, f)
    const read = () => t.run((ctx) => subProjectCounts(ctx.db, f.sub))
    // not counted yet: a create moves nothing and the counts read as none
    const task = await w.create({ status: 'todo', remaining_hours: 1 })
    expect(await read()).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('overview_counts').collect())).toEqual([])
    await countAll(t, org_id)
    await expectExact(t, org_id, 'counted by the backfill')
    expect((await read())?.leaves.todo).toBe(1)

    // a run or a regroup under way
    const run = await t.run((ctx) =>
      ctx.db.insert('overview_count_runs', { org_id, counting: true, through: 0 }),
    )
    expect(await read()).toBeNull()
    await t.run((ctx) => ctx.db.delete(run))
    const regroup = await t.run((ctx) =>
      ctx.db.insert('overview_regroups', {
        org_id,
        family_id: f.meta.id,
        projects: [],
        at: 0,
        progress_at: NOW,
      }),
    )
    expect(await read()).toBeNull()
    await t.run((ctx) => ctx.db.delete(regroup))
    expect((await read())?.leaves.todo).toBe(1)

    // rows a fault deleted: the next write takes the leaf out of nothing,
    // logs it and leaves the row below zero, which reads as counting
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('overview_counts').collect())
        await ctx.db.delete(row._id)
    })
    await w.archive(task.id)
    expect(logged).toHaveBeenCalledWith('An overview count went below zero', expect.anything())
    expect(await read()).toBeNull()
  })

  it('a row of an earlier sub-project or task with the same id counts for nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const id = uuid()
    const counts = noCounts()
    counts.leaves.done = 40
    // what a sub-project and a task with these ids left before them
    await t.run(async (ctx) => {
      for (let shard = 0; shard < OVERVIEW_SHARDS; shard++)
        await ctx.db.insert('overview_counts', {
          org_id,
          project_id: f.sub.id,
          project_at: 1,
          shard,
          ...counts,
          revision: 0,
        })
      await ctx.db.insert('overview_tasks', {
        org_id,
        task_id: id,
        task_at: 1,
        group: true,
      })
    })
    expect((await t.run((ctx) => subProjectCounts(ctx.db, f.sub)))?.leaves.done).toBe(0)
    // a create with that id is a leaf, and its row starts from zero
    await w.create({ id, status: 'progress', remaining_hours: 3 })
    await w.create({ status: 'done' })
    await expectExact(t, org_id, 'rows of an earlier generation')
    expect((await t.run((ctx) => subProjectCounts(ctx.db, f.sub)))?.leaves).toMatchObject({
      done: 1,
      progress: 1,
    })
  })

  it('counts an organization exactly while tasks change between its steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const w = writers(t, f)
    Object.assign(COUNT_PAGE, { tasks: 2, rows: 1 })
    // tasks and a stray row, all written while it was not counted
    const tasks: { id: string }[] = []
    for (let n = 0; n < 6; n++)
      tasks.push(
        await w.create({
          project_id: n % 2 === 0 ? f.sub.id : f.sub2.id,
          status: (['todo', 'progress', 'review', 'done'] as const)[n % 4],
          assignee_id: n % 3 === 0 ? f.admin.id : f.user.id,
          ...(n % 4 === 2 ? { reviewer_id: f.admin.id } : {}),
          remaining_hours: n / 2,
        }),
      )
    const kid = await w.create({ project_id: f.sub2.id, parent_id: tasks[0].id })
    await t.run(async (ctx) => {
      for (let shard = 0; shard < 2; shard++)
        await ctx.db.insert('overview_counts', {
          org_id,
          project_id: f.sub.id,
          project_at: f.sub._creationTime,
          shard,
          ...noCounts(),
          paused: 3,
          revision: 0,
        })
    })
    const step = () => t.mutation(internal.internal.overviewCountsBackfill.step, { org_id })
    // the reset takes the stray rows a step at a time; a write meanwhile
    // moves nothing, and no count shows
    expect(await step()).toMatchObject({ done: false, deleted: 1 })
    await w.update(tasks[1].id, { paused: true })
    expect(await t.run((ctx) => subProjectCounts(ctx.db, f.sub))).toBeNull()
    expect(await step()).toMatchObject({ done: false, deleted: 1 })
    expect(await step()).toMatchObject({ done: false, deleted: 0 })
    expect(await t.run((ctx) => overviewCountRun(ctx.db, org_id))).toMatchObject({
      counting: true,
    })
    // the first count step reads the two oldest tasks; writes on both
    // sides of where it reached
    expect(await step()).toMatchObject({ done: false, tasks: 2 })
    await w.update(tasks[4].id, { status: 'done' })
    await w.update(tasks[5].id, { assignee_id: f.admin.id })
    await w.archive(kid.id)
    await w.create({ project_id: f.sub.id, parent_id: tasks[5].id })
    await w.archive(tasks[3].id)
    await deleteTask(t, f, tasks[2].id)
    await runSteps(t)
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    await w.create({ status: 'review', assignee_id: f.admin.id })
    await countAll(t, org_id)
    await runSteps(t)
    expect(await t.run((ctx) => overviewCountRun(ctx.db, org_id))).toBeNull()
    await expectExact(t, org_id, 'counted while it changed')
  }, 60_000)

  it('a dry run writes nothing; a run counts what it lists, a recount mends a drift, orphans go', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const w = writers(t, f)
    const a = await w.create({ status: 'progress', assignee_id: f.user.id, remaining_hours: 2 })
    await w.create({ project_id: f.sub2.id, status: 'todo' })
    // neither the fixture's organization nor its other one is counted
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({ dry_run: true, counted: 2, tasks: 2, orphans: 0 })
    expect(dry.to_count).toContainEqual({ org_id, tasks: 2, rows: 3 })
    expect(await t.run((ctx) => ctx.db.query('overview_counts').collect())).toEqual([])
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 2, orphans: 0 })
    await expectExact(t, org_id, 'counted')
    expect(await t.run((ctx) => ctx.db.query('overview_count_runs').collect())).toEqual([])

    // rows an earlier state left: a zero row of a gone project, one of an
    // earlier project with a live one's id, a task row of a gone task, and
    // a run of a deleted organization
    await t.run(async (ctx) => {
      const base = { org_id, shard: 0, ...noCounts(), revision: 0 }
      await ctx.db.insert('overview_counts', { ...base, project_id: uuid(), project_at: 1 })
      await ctx.db.insert('overview_counts', { ...base, project_id: f.sub.id, project_at: 1 })
      await ctx.db.insert('overview_tasks', { org_id, task_id: uuid(), task_at: 1, group: true })
      await ctx.db.insert('overview_count_runs', { org_id: uuid(), counting: true, through: 0 })
    })
    expect(await backfill(t, { dry_run: true })).toMatchObject({ counted: 0, orphans: 4 })
    // a second run leaves the counted organizations alone and takes them
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 0, orphans: 4 })
    await expectExact(t, org_id, 'orphans gone')
    expect(await audits(t)).toEqual([
      { counted: 2, deleted: 0, tasks: 2, rows: 2, orphans: 0, cursor: null },
      { counted: 0, deleted: 0, tasks: 0, rows: 0, orphans: 4, cursor: null },
    ])

    // a release before this one changes a task and moves no count
    await t.run(async (ctx) => {
      const row = (await byId(ctx, 'issues', a.id)) as Doc<'issues'>
      await ctx.db.patch(row._id, { status: 'done' })
    })
    const found = await backfill(t, { dry_run: true })
    expect(found).toMatchObject({ counted: 0, differing: 2, unsettled: 0 })
    await calls(t, { dry_run: false, recount: true })
    await expectExact(t, org_id, 'recounted')
    expect((await backfill(t, { dry_run: true })).differing).toBe(0)
  })

  it('a call past its time answers a cursor, and the calls from it count every organization once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = writers(t, f)
    for (let n = 0; n < 4; n++) await w.create({ status: 'todo', remaining_hours: n })
    Object.assign(COUNT_PAGE, { tasks: 1 })
    Object.assign(RUN, { ms: 0 })
    const got = await calls(t, { dry_run: false })
    expect(got.length).toBeGreaterThan(2)
    expect(got.some((call) => call.cursor?.table === 'organizations' && call.cursor.org)).toBe(true)
    await expectExact(t, f.org.id, 'counted over many calls')
  })

  it('the Northstar seed, the guest fixture and a new organization start counted', async () => {
    const t = newT()
    const { org } = await plantNorthstar(t)
    expect(await t.run((ctx) => countsReady(ctx.db, org.id, org.id))).toBe(true)
    await expectExact(t, org.id, 'Northstar')
    expect(Object.keys((await truth(t, org.id)).rows).length).toBeGreaterThan(0)
    const { org_id } = await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    await expectExact(t, org_id, 'the guest fixture')
    expect(Object.keys((await truth(t, org_id)).rows).length).toBeGreaterThan(0)
    expect((await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})).torn_down).toBe(true)
    await expectExact(t, org_id, 'the guest fixture again')
    const made = await t.mutation(internal.adminOrgs.insertOrganization, {
      name: 'Starter Labs',
      people: [{ name: 'Ada', email: 'ada@starter.test', role: 'admin' }],
      actor: { auth_user_id: 'operator', email: 'operator@qivo.test' },
    })
    expect(await t.run((ctx) => countsReady(ctx.db, made.org_id, uuid()))).toBe(true)
  }, 60_000)

  it("the Northstar wipe takes the counts, and its seed counts again with the projects' new rows", async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    await expectExact(t, org.id, 'seeded')
    let done = false
    for (let n = 0; n < 400 && !done; n++)
      done = await t.run((ctx) =>
        wipeWorkStep(
          ctx,
          org.id,
          profiles.map((p) => p.id),
          { rows: 64, bytes: 4 * 1024 * 1024 },
        ),
      )
    expect(done).toBe(true)
    expect(await t.run((ctx) => countsReady(ctx.db, org.id, org.id))).toBe(false)
    for (const table of OVERVIEW_TABLES)
      expect(
        (await t.run((ctx) => ctx.db.query(table).collect())).filter((r) => r.org_id === org.id),
        table,
      ).toEqual([])
    // the seed writes the same ids again, the projects as new rows
    await t.run(async (ctx) => {
      const fresh = (await byId(ctx, 'organizations', org.id)) as Doc<'organizations'>
      await writeNorthstarWork(ctx, {
        org: fresh,
        profiles,
        namespace: NORTHSTAR,
        anchor: '2026-09-07',
        now: NOW,
      })
    })
    await expectExact(t, org.id, 'seeded again')
    expect(await t.run((ctx) => countsReady(ctx.db, org.id, org.id))).toBe(true)
    expect(await northstarId('org')).toBe(org.id)
  }, 60_000)

  it("an organization's deletion in steps takes every overview row with it", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    for (let n = 0; n < 6; n++) {
      const p = await w.create({ assignee_id: f.user.id, remaining_hours: n })
      await w.create({ project_id: f.sub2.id, parent_id: p.id })
    }
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      }),
    )
    REMOVAL_BUDGET.rows = 4
    const gone = () =>
      t.run(
        async (ctx) =>
          (await ctx.db
            .query('org_removals')
            .withIndex('by_org', (q) => q.eq('org_id', org_id))
            .first()) === null,
      )
    // a backfill step between two deletion steps, as a run meanwhile would
    for (let n = 0; n < 400 && !(await gone()); n++) {
      await t.mutation(internal.orgRemovals.step, { org_id })
      await t.mutation(internal.internal.overviewCountsBackfill.step, { org_id })
    }
    expect(await gone()).toBe(true)
    for (const table of OVERVIEW_TABLES)
      expect(
        (await t.run((ctx) => ctx.db.query(table).collect())).filter((r) => r.org_id === org_id),
        table,
      ).toEqual([])
    await assertNoDanglingRefs(t, 'organization deletion')
  }, 120_000)
})

const backfill = (t: T, args: { dry_run: boolean; recount?: boolean }) =>
  t.action(internal.internal.overviewCountsBackfill.run, args)

type RunArgs = FunctionArgs<typeof internal.internal.overviewCountsBackfill.run>
type RunAnswer = FunctionReturnType<typeof internal.internal.overviewCountsBackfill.run>

/** Every call of a run, each from the cursor the one before answered,
 * until one answers done. */
async function calls(t: T, args: Omit<RunArgs, 'cursor'>): Promise<RunAnswer[]> {
  const got: RunAnswer[] = []
  let cursor: RunArgs['cursor']
  for (let n = 0; n < 60; n++) {
    const last = await t.action(internal.internal.overviewCountsBackfill.run, { ...args, cursor })
    got.push(last)
    if (last.cursor === null) return got
    cursor = last.cursor
  }
  throw new Error('the run did not end')
}

/** The audit rows of the overview backfill, oldest first. */
const audits = (t: T) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'overview_counts_backfill'))
        .collect()
    ).map((row) => row.detail),
  )

/** Runs the organization's count steps until it is counted. */
async function countAll(t: T, org_id: string): Promise<void> {
  for (let n = 0; n < 200; n++) {
    const got = await t.mutation(internal.internal.overviewCountsBackfill.step, { org_id })
    if (got.done) return
  }
  throw new Error('the count did not end')
}
