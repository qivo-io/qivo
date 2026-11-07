/* The Overview's counts (schema.ts overview_counts, model/overviewCounts.ts):
 * after every writer, each sub-project's and each owner's rows equal a
 * recount of the tasks, and overview_tasks marks as groups exactly the
 * active tasks with an active subtask in a live project. Project archives, restores and
 * moves to Deleted items reconcile in background steps (overviewRegroup.ts)
 * while the counts answer `counting`; the backfill
 * (internal/overviewCountsBackfill.ts) counts an organization exactly while
 * writes go on between its steps; seeds and teardowns leave counted
 * organizations or none of their rows. */

import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import { COUNT_PAGE, RUN } from '../internal/overviewCountsBackfill'
import { byId } from '../lib/db'
import { REMOVAL_BUDGET } from '../model/cascade'
import { writeNorthstarWork } from '../model/demoSeed'
import { wipeWorkStep } from '../model/orgDeletion'
import { DEFAULT_ARCHIVE_DAYS } from '../model/orgs'
import {
  CountMoves,
  countsOfRows,
  countsReady,
  countWhole,
  noCounts,
  OVERVIEW_SHARDS,
  OVERVIEW_TABLES,
  overviewCountRun,
  overviewRegroupOf,
  ownerRows,
  reconcileTask,
  stampOverview,
  subProjectCounts,
  taskPage,
} from '../model/overviewCounts'
import { removeProjectGrantCore } from '../model/projectAccess'
import { OVERVIEW_REGROUP, STALLED_MS } from '../overviewRegroup'
import { plantTasks } from './board.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { NORTHSTAR, northstarId, plantNorthstar } from './northstar.setup'
import {
  type CountPosition,
  countOrg,
  countStep,
  expectCountsExact,
  stored,
  truth,
} from './overviewCounts.setup'
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
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const exact = (label: string) => expectCountsExact(t, org_id, label)

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

    // the Roadmap and its undo, which write a task's dates only
    const session_id = uuid()
    await as(t, f.user).mutation(api.roadmap.change, {
      session_id,
      operations: [
        { kind: 'task', id: b.id, patch: { start_week: '2026-01-05', end_week: '2026-01-12' } },
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
  })

  it("an access removal's handover moves many tasks' owners in one transaction", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    await expectCountsExact(t, org_id, 'before the handover')
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
    await expectCountsExact(t, org_id, 'after the handover')
  }, 60_000)

  it('a project archive, restore and move reconcile in background steps, whatever lands first', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const ready = () => t.run((ctx) => countsReady(ctx.db, org_id))
    const parent = await w.create({
      status: 'progress',
      assignee_id: f.user.id,
      remaining_hours: 2,
    })
    await w.create({ project_id: f.sub2.id, parent_id: parent.id, assignee_id: f.user.id })
    await expectCountsExact(t, org_id, 'a subtask in the sibling')

    // the sibling archived: until the step runs its project's counts are
    // not whole, and a write meanwhile reconciles the parent first
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    expect(await ready()).toBe(false)
    expect(await t.run((ctx) => subProjectCounts(ctx.db, f.sub))).toBeNull()
    const second = await w.create({ parent_id: parent.id })
    await runSteps(t)
    expect(await ready()).toBe(true)
    await expectCountsExact(t, org_id, 'archived, with a second subtask meanwhile')
    await w.archive(second.id)
    await expectCountsExact(t, org_id, 'its only live subtask archived')

    // restored, archived and restored again before any step runs: the
    // project waits once, read as it is when its step comes
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.sub2.id })
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.sub2.id })
    expect((await t.run((ctx) => overviewRegroupOf(ctx.db, f.meta.id)))?.projects).toEqual([
      f.sub2.id,
    ])
    await runSteps(t)
    await expectCountsExact(t, org_id, 'restored, archived and restored again')

    // the top-level project with its sub-projects, and back
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.meta.id })
    await runSteps(t)
    await expectCountsExact(t, org_id, 'the top-level project archived')
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.meta.id })
    await runSteps(t)
    await expectCountsExact(t, org_id, 'the top-level project restored')

    // steps that stop on their room after one task each
    Object.assign(OVERVIEW_REGROUP, { tasks: 2, room: 0 })
    for (let n = 0; n < 5; n++) {
      const p = await w.create({ assignee_id: f.admin.id, remaining_hours: n })
      await w.create({ project_id: f.sub2.id, parent_id: p.id })
    }
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    await runSteps(t)
    expect(await ready()).toBe(true)
    await expectCountsExact(t, org_id, 'archived in small steps')
  }, 60_000)

  it('readers answer counting, never zero, and a row that goes negative says so', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const w = writers(t, f)
    const read = () => t.run((ctx) => subProjectCounts(ctx.db, f.sub))
    // not counted yet: a create moves nothing and the counts read as none
    const task = await w.create({ status: 'todo', remaining_hours: 1 })
    expect(await read()).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('overview_counts').collect())).toEqual([])
    await countOrg(t, org_id)
    await expectCountsExact(t, org_id, 'counted by the backfill')
    expect((await read())?.leaves.todo).toBe(1)

    // a run or a regroup under way
    const run = await t.run((ctx) =>
      ctx.db.insert('overview_count_runs', { org_id, counting: true, generation: uuid() }),
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

  it("a person's leaves split over the shards, and an edit writes only its own shard's rows", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const create = () => w.create({ status: 'todo', assignee_id: f.user.id, remaining_hours: 1 })
    const first = await create()
    for (let i = 0; i < OVERVIEW_SHARDS; i++) await create()
    await expectCountsExact(t, org_id, 'one person over every shard')
    const mine = () =>
      t.run(async (ctx) =>
        (await ownerRows(ctx.db, f.user.id).collect()).filter((r) => r.project_id === f.sub.id),
      )
    const before = await mine()
    // a row a shard, read in one range, adding up to the person's leaves
    expect(before.map((r) => r.shard).sort()).toEqual([0, 1, 2, 3])
    expect(countsOfRows(before, f.sub)?.leaves.todo).toBe(OVERVIEW_SHARDS + 1)

    const edited = (await t.run((ctx) => byId(ctx, 'issues', first.id))) as Doc<'issues'>
    await w.update(edited.id, { status: 'progress' })
    const after = await mine()
    expect(after.map((r) => r._id).sort()).toEqual(before.map((r) => r._id).sort())
    for (const row of after) {
      const was = before.find((r) => r._id === row._id) as Doc<'overview_counts'>
      expect(row.revision > was.revision, `the person's row of shard ${row.shard}`).toBe(
        row.shard === edited.num % OVERVIEW_SHARDS,
      )
    }
    await expectCountsExact(t, org_id, 'after the edit')
  })

  it('a row of an earlier sub-project or task with the same id counts for nothing', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    await expectCountsExact(t, org_id, 'rows of an earlier generation')
    expect((await t.run((ctx) => subProjectCounts(ctx.db, f.sub)))?.leaves).toMatchObject({
      done: 1,
      progress: 1,
    })
  })

  it('counts an organization exactly while tasks change between its steps', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    await countOrg(t, org_id)
    await runSteps(t)
    expect(await t.run((ctx) => overviewCountRun(ctx.db, org_id))).toBeNull()
    await expectCountsExact(t, org_id, 'counted while it changed')
  }, 60_000)

  it('a dry run writes nothing; a run counts what it lists, a recount mends a drift, orphans go', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    await expectCountsExact(t, org_id, 'counted')
    expect(await t.run((ctx) => ctx.db.query('overview_count_runs').collect())).toEqual([])

    // rows an earlier state left: a zero row of a gone project, one of an
    // earlier project with a live one's id, a task row of a gone task, and
    // a run of a deleted organization
    await t.run(async (ctx) => {
      const base = { org_id, shard: 0, ...noCounts(), revision: 0 }
      await ctx.db.insert('overview_counts', { ...base, project_id: uuid(), project_at: 1 })
      await ctx.db.insert('overview_counts', { ...base, project_id: f.sub.id, project_at: 1 })
      await ctx.db.insert('overview_tasks', { org_id, task_id: uuid(), task_at: 1, group: true })
      await ctx.db.insert('overview_count_runs', {
        org_id: uuid(),
        counting: true,
        generation: uuid(),
      })
    })
    expect(await backfill(t, { dry_run: true })).toMatchObject({ counted: 0, orphans: 4 })
    // a second run leaves the counted organizations alone and takes them
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 0, orphans: 4 })
    await expectCountsExact(t, org_id, 'orphans gone')
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
    await expectCountsExact(t, org_id, 'recounted')
    expect((await backfill(t, { dry_run: true })).differing).toBe(0)
  })

  it('a call past its time answers a cursor, and the calls from it count every organization once', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const w = writers(t, f)
    for (let n = 0; n < 4; n++) await w.create({ status: 'todo', remaining_hours: n })
    Object.assign(COUNT_PAGE, { tasks: 1 })
    Object.assign(RUN, { ms: 0 })
    const got = await calls(t, { dry_run: false })
    expect(got.length).toBeGreaterThan(2)
    expect(got.some((call) => call.cursor?.table === 'organizations' && call.cursor.org)).toBe(true)
    await expectCountsExact(t, f.org.id, 'counted over many calls')
  })

  it('the Northstar seed, the guest fixture and a new organization start counted', async () => {
    const t = newT()
    const { org } = await plantNorthstar(t)
    expect(await t.run((ctx) => countsReady(ctx.db, org.id))).toBe(true)
    await expectCountsExact(t, org.id, 'Northstar')
    expect(Object.keys((await truth(t, org.id)).rows).length).toBeGreaterThan(0)
    const { org_id } = await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    await expectCountsExact(t, org_id, 'the guest fixture')
    expect(Object.keys((await truth(t, org_id)).rows).length).toBeGreaterThan(0)
    expect((await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})).torn_down).toBe(true)
    await expectCountsExact(t, org_id, 'the guest fixture again')
    const made = await t.mutation(internal.adminOrgs.insertOrganization, {
      name: 'Starter Labs',
      people: [{ name: 'Ada', email: 'ada@starter.test', role: 'admin' }],
      actor: { auth_user_id: 'operator', email: 'operator@qivo.test' },
    })
    expect(await t.run((ctx) => countsReady(ctx.db, made.org_id))).toBe(true)
  }, 60_000)

  it("the Northstar wipe takes the counts, and its seed counts again with the projects' new rows", async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    await expectCountsExact(t, org.id, 'seeded')
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
    expect(await t.run((ctx) => countsReady(ctx.db, org.id))).toBe(false)
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
    await expectCountsExact(t, org.id, 'seeded again')
    expect(await t.run((ctx) => countsReady(ctx.db, org.id))).toBe(true)
    expect(await northstarId('org')).toBe(org.id)
  }, 60_000)

  it("an organization's deletion in steps takes every overview row with it", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    // a backfill step between two deletion steps, going on where the one
    // before counted through, as a run meanwhile would
    let at: CountPosition = {}
    for (let n = 0; n < 400 && !(await gone()); n++) {
      await t.mutation(internal.orgRemovals.step, { org_id })
      at = await countStep(t, org_id, at)
    }
    expect(await gone()).toBe(true)
    for (const table of OVERVIEW_TABLES)
      expect(
        (await t.run((ctx) => ctx.db.query(table).collect())).filter((r) => r.org_id === org_id),
        table,
      ).toEqual([])
    await assertNoDanglingRefs(t, 'organization deletion')
  })

  it('a parent whose only subtask leaves with its project is read again, whatever lands first', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    // its only subtask in a sibling sub-project that goes to Deleted items,
    // which deletes the project row before it moves the subtask
    const parent = await w.create({
      status: 'progress',
      assignee_id: f.user.id,
      remaining_hours: 2,
    })
    await w.create({ project_id: f.sub2.id, parent_id: parent.id })
    await expectCountsExact(t, org_id, 'a group through a sibling subtask')
    await deleteProject(t, f, f.sub2.id)
    // the move read the parent again in its own transaction; the readers
    // answer counting until the regroup ends
    expect(await stored(t, org_id), 'its sibling sub-project in Deleted items').toEqual(
      await truth(t, org_id),
    )
    await runSteps(t)
    await expectCountsExact(t, org_id, 'after the regroup')

    // its only subtask in a sibling archived, then archived itself before
    // the regroup's step reads that sibling
    const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const other = await w.create({ status: 'todo', remaining_hours: 1 })
    const kid = await w.create({ project_id: sibling.id, parent_id: other.id })
    await expectCountsExact(t, org_id, 'a second group')
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: sibling.id })
    await w.archive(kid.id)
    expect(await stored(t, org_id), 'its subtask archived before the step').toEqual(
      await truth(t, org_id),
    )
    await runSteps(t)
    await expectCountsExact(t, org_id, 'after that regroup')
  })

  it('a regroup that a project change starts while the backfill counts goes on after the count', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const w = writers(t, f)
    // written while the organization is not counted
    const parent = await w.create({ status: 'todo', remaining_hours: 1 })
    await w.create({ project_id: f.sub2.id, parent_id: parent.id })
    await w.create({ status: 'progress' })
    Object.assign(COUNT_PAGE, { tasks: 1 })
    const step = (at?: CountPosition) => countStep(t, org_id, at)
    // the reset, then a count step through the parent, which it counts as
    // a group
    expect(await step()).toMatchObject({ done: false, tasks: 0 })
    const run = await t.run((ctx) => overviewCountRun(ctx.db, org_id))
    expect(run).toMatchObject({ counting: true })
    let got = await step()
    expect(got).toMatchObject({ done: false, tasks: 1 })
    // count steps leave the run row, which every task write reads, as it is
    expect(await t.run((ctx) => overviewCountRun(ctx.db, org_id))).toEqual(run)
    // the subtask's project archived while the count goes on
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    for (let n = 0; n < 20 && !got.done; n++) got = await step(got)
    expect(got.done).toBe(true)
    // the regroup it started stays, and its project reads as counting
    expect(await t.run((ctx) => overviewRegroupOf(ctx.db, f.meta.id))).not.toBeNull()
    expect(await t.run((ctx) => countsReady(ctx.db, org_id))).toBe(false)
    await runSteps(t)
    expect(await t.run((ctx) => countsReady(ctx.db, org_id))).toBe(true)
    await expectCountsExact(t, org_id, 'counted, then regrouped')
  })

  it('a count page whose subtasks fill their project in 7 archived sub-projects stays inside the limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    // 100 parents created together, each with a subtask in each of 7
    // archived sibling sub-projects: the project's 800 open tasks
    const parents = await plantTasks(t, f.sub, 100)
    for (let n = 0; n < 7; n++) {
      const sibling = await plantProject(t, {
        org_id,
        type: 'project',
        parent_id: f.meta.id,
        archived_at: NOW,
      })
      await plantTasks(t, sibling, 100, (i) => ({ parent_id: parents[i].id }))
    }
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({ unchecked: 0, unsettled: 0 })
    expect(dry.to_count).toContainEqual({ org_id, tasks: 800, rows: expect.any(Number) })
    await countOrg(t, org_id)
    // the parents count as leaves, as their subtasks are in archived projects
    expect((await t.run((ctx) => subProjectCounts(ctx.db, f.sub)))?.leaves.todo).toBe(100)
    // what one count step's page reads, the parents' subtasks with it
    const took = await t.run(async (ctx) => {
      const page = await taskPage(ctx.db, org_id, Number.MIN_SAFE_INTEGER, COUNT_PAGE)
      const live = new Map<string, boolean>()
      for (const task of page?.tasks ?? [])
        await reconcileTask(ctx.db, org_id, task.id, task, 'read', live)
      const m = await ctx.meta.getTransactionMetrics()
      return { ranges: m.databaseQueries.used, documents: m.documentsRead.used }
    })
    // 373 ranges and 1,040 documents when measured; reading each
    // subtask's project, not each project once, would take about 700 more
    console.log('one count page over 7 archived sub-projects:', took)
    expect(took.ranges).toBeLessThan(500)
  })

  it('a project changed again while its regroup is partway through it is read again whole', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    // three parents in FW, each with its only subtask in PCB
    for (let n = 0; n < 3; n++) {
      const parent = await w.create({ status: 'todo' })
      await w.create({ project_id: f.sub2.id, parent_id: parent.id })
    }
    await expectCountsExact(t, org_id, 'groups through PCB')
    Object.assign(OVERVIEW_REGROUP, { tasks: 1 })
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    // one step reads PCB's first page as archived, then PCB is restored
    // before the next
    await t.mutation(internal.overviewRegroup.step, { family_id: f.meta.id })
    expect((await t.run((ctx) => overviewRegroupOf(ctx.db, f.meta.id)))?.cursor).toBeDefined()
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.sub2.id })
    expect((await t.run((ctx) => overviewRegroupOf(ctx.db, f.meta.id)))?.projects).toEqual([
      f.sub2.id,
      f.sub2.id,
    ])
    await runSteps(t)
    await expectCountsExact(t, org_id, 'restored between two steps')
  })

  it('a replayed continuation and one a recount overtook count the organization from its start', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const w = writers(t, f)
    for (let n = 0; n < 4; n++) await w.create({ status: 'todo', remaining_hours: n })
    Object.assign(COUNT_PAGE, { tasks: 1 })
    Object.assign(RUN, { ms: 0 })
    /* Calls of run from `cursor` until one stops inside this organization's
     * count past a count step, and that call's cursor. */
    const inside = async (args: Omit<RunArgs, 'cursor'>, cursor?: RunArgs['cursor']) => {
      for (let n = 0; n < 100; n++) {
        const got: RunAnswer = await backfill(t, { ...args, ...(cursor ? { cursor } : {}) })
        const at = got.cursor
        if (at === null) throw new Error('the run ended before it stopped inside')
        if (at.table === 'organizations' && at.org?.id === org_id && at.org.through !== undefined)
          return at
        cursor = at
      }
      throw new Error('the run did not stop inside')
    }
    // a call that stopped inside the count, and the calls from it to the end
    const saved = await inside({ dry_run: false })
    await callsFrom(t, { dry_run: false }, saved)
    await expectCountsExact(t, org_id, 'counted')
    // the same continuation again, after the organization is counted
    await callsFrom(t, { dry_run: false }, saved)
    await expectCountsExact(t, org_id, 'a replayed continuation')

    // a recount stopped inside the count, a second recount that resets the
    // run and counts past it, then the first going on, then the second
    const first = await inside({ dry_run: false, recount: true })
    const second = await inside({ dry_run: false, recount: true })
    await callsFrom(t, { dry_run: false, recount: true }, first)
    await expectCountsExact(t, org_id, 'the overtaken recount ended')
    await callsFrom(t, { dry_run: false, recount: true }, second)
    await expectCountsExact(t, org_id, 'the second recount ended')
  })

  it('recovery restarts a regroup whose step stopped', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    const parent = await w.create({ status: 'todo' })
    await w.create({ project_id: f.sub2.id, parent_id: parent.id })
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    const row = await t.run((ctx) => overviewRegroupOf(ctx.db, f.meta.id))
    if (row?.scheduled_id === undefined) throw new Error('no regroup step')
    // a step waits: recovery leaves the row alone, however old its progress
    const old = new Date(Date.now() - STALLED_MS - 1).toISOString()
    await t.run((ctx) => ctx.db.patch(row._id, { progress_at: old }))
    await t.mutation(internal.overviewRegroup.recover, {})
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.scheduled_id).toBe(row.scheduled_id)
    // its step lost, as a failed step leaves it: recovery starts another
    await t.run((ctx) => ctx.scheduler.cancel(row.scheduled_id as Id<'_scheduled_functions'>))
    await t.mutation(internal.overviewRegroup.recover, {})
    await runSteps(t)
    expect(await t.run((ctx) => overviewRegroupOf(ctx.db, f.meta.id))).toBeNull()
    await expectCountsExact(t, org_id, 'regrouped after recovery')
  })

  it('a regroup deletes every empty row of a project gone to Deleted items, a page a step', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    for (const assignee_id of [f.user.id, f.admin.id, undefined])
      for (let n = 0; n < 4; n++)
        await w.create({
          project_id: f.sub2.id,
          ...(assignee_id === undefined ? {} : { assignee_id }),
        })
    const rows = () =>
      t.run(async (ctx) =>
        (await ctx.db.query('overview_counts').collect()).filter((r) => r.project_id === f.sub2.id),
      )
    expect((await rows()).length).toBeGreaterThan(4)
    Object.assign(OVERVIEW_REGROUP, { rows: 2 })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    expect(await rows()).toEqual([])
    await expectCountsExact(t, org_id, 'its rows gone')
  })

  it('a move of a dead project generation does not touch the current row', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await stamp(t, org_id)
    const w = writers(t, f)
    await w.create({ status: 'todo' })
    const before = await t.run((ctx) => ctx.db.query('overview_counts').collect())
    expect(before).toHaveLength(1)
    await t.run(async (ctx) => {
      const moves = new CountMoves()
      const counts = noCounts()
      counts.leaves.todo = 1
      moves.addRow(
        { project_id: f.sub.id, owner_id: undefined, shard: before[0].shard },
        { org_id, project_at: f.sub._creationTime - 1 },
        counts,
        -1,
      )
      await moves.apply(ctx.db)
    })
    expect(await t.run((ctx) => ctx.db.query('overview_counts').collect())).toEqual(before)
  })

  it('a call stopped before an organization comes to it fresh, not inside its run', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const w = writers(t, f)
    await w.create({ status: 'todo' })
    await calls(t, { dry_run: false })
    await expectCountsExact(t, f.org.id, 'counted')
    // a cursor that stopped before the counted organization
    const got = await backfill(t, {
      dry_run: false,
      cursor: {
        table: 'organizations',
        cursor: null,
        org: { id: f.org.id, before: true },
      },
    })
    expect(got).toMatchObject({ counted: 0 })
    expect(await t.run((ctx) => overviewCountRun(ctx.db, f.org.id))).toBeNull()
    expect(await t.run((ctx) => countsReady(ctx.db, f.org.id))).toBe(true)
  })
})

const backfill = (t: T, args: Omit<RunArgs, never>) =>
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

/** Every call of a run from `cursor`, each from the cursor the one before
 * answered, until one answers done. */
async function callsFrom(
  t: T,
  args: Omit<RunArgs, 'cursor'>,
  cursor: NonNullable<RunArgs['cursor']>,
): Promise<RunAnswer[]> {
  const got: RunAnswer[] = []
  let at: RunArgs['cursor'] = cursor
  for (let n = 0; n < 100; n++) {
    const last = await backfill(t, { ...args, cursor: at })
    got.push(last)
    if (last.cursor === null) return got
    at = last.cursor
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
