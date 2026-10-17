/* Deleted items: storage, reservations, the step machine, moving and purging
 * (model/deletedItems.ts, deletedItems.ts).
 *
 * Deleting moves rows out of the live tables into deleted_rows, so a test
 * reads both sides: the live tables must no longer hold what was deleted,
 * and the trash must hold every original document unchanged. Fake timers
 * keep every scheduled step from running until a test releases it, so the
 * bounded steps can be driven one at a time. Budgets are lowered so that
 * many-step paths run on small data. */
/// <reference types="vite/client" />

import { describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { PURGE_ORG } from '../deletedItems'
import { byId } from '../lib/db'
import type { EventOwner } from '../lib/taskEvents'
import { storageIdInUse } from '../model/attachments'
import { storageUsage } from '../model/billing'
import { deleteOrgDeep } from '../model/cascade'
import {
  EXPIRY,
  moveTasksToTrash,
  restoreBlock,
  STALLED_MS,
  STORED_ROW_MAX_BYTES,
  sameReference,
  startPurge,
  TRASH_BUDGET,
  TRASH_DAYS,
  whereIsTask,
} from '../model/deletedItems'
import { estimateDocumentBytes } from '../model/demoMetrics'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'
import {
  attach,
  blobExists,
  comment,
  DAY,
  DEFAULT_BUDGET,
  deleteProject,
  deleteTask,
  expectedRow,
  HOUR,
  installTrashTimers,
  itemById,
  itemFor,
  jobFor,
  liveTask,
  plantRows,
  runSteps,
  START,
  step,
  storedIssue,
  storedRows,
  storedTasks,
} from './trash.setup'

declare class Blob {
  constructor(parts: string[])
}

installTrashTimers()

/** Whether deleted_rows holds the comment `id`. */
const commentStored = async (t: T, id: string) =>
  (await t.run((ctx) =>
    ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'comments').eq('row_id', id))
      .unique(),
  )) !== null

describe('moving a task to Deleted items', () => {
  it('stores the task with every row that travels with it and deletes its messages', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id, title: 'Battery level' })
    const to = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const from = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const planted = await plantRows(t, f, task, { to, from })

    await deleteTask(t, f, task.id, { reason: '  Duplicate of the charger task  ' })

    const item = await itemFor(t, task.id)
    expect(item).toMatchObject({
      org_id,
      kind: 'task',
      num: task.num,
      name: 'Battery level',
      status: 'todo',
      archived: false,
      project_id: f.sub.id,
      parent_project_id: f.meta.id,
      path: ['Testbed platform', 'Firmware'],
      projects: [
        { id: f.sub.id, name: 'Firmware', key: 'FW', type: 'project', tasks: 1, archived_tasks: 0 },
      ],
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
      deleted_at: new Date(START).toISOString(),
      deleted_by: f.user.id,
      reason: 'Duplicate of the charger task',
      state: 'ready',
    })
    expect(item.purge_after).toBe(START + TRASH_DAYS * DAY)
    expect(await jobFor(t, item.id)).toBeNull()

    // every original document, unchanged, travels with the task
    const stored = await storedRows(t, item.id)
    const expected = [
      expectedRow({ table: 'issues', doc: task }, task.id),
      ...planted.rows.map((row) => expectedRow(row, task.id)),
    ]
    expect(stored).toHaveLength(expected.length)
    for (const row of expected) expect(stored).toContainEqual(expect.objectContaining(row))
    for (const row of stored) {
      const { _id, _creationTime, ...doc } = row
      expect(estimateDocumentBytes(doc)).toBeLessThanOrEqual(STORED_ROW_MAX_BYTES)
    }
    expect(await storedTasks(t, item.id)).toEqual([
      expect.objectContaining({
        org_id,
        task_id: task.id,
        num: task.num,
        title: 'Battery level',
        project_id: f.sub.id,
        archived: false,
      }),
    ])

    // the live tables no longer hold any of it, and the message is gone
    await t.run(async (ctx) => {
      expect(await byId(ctx, 'issues', task.id)).toBeNull()
      for (const row of planted.rows) expect(await ctx.db.get(row.doc._id)).toBeNull()
      expect(await ctx.db.get(planted.message)).toBeNull()
      // the other ends and the label stay
      expect(await byId(ctx, 'issues', to.id)).not.toBeNull()
      expect(await byId(ctx, 'labels', planted.labelId)).not.toBeNull()
    })
    expect(await blobExists(t, planted.attachment.storage_id)).toBe(true)
    const activity = await t.run((ctx) => ctx.db.query('activity_events').collect())
    expect(activity.map((e) => [e.verb, e.target_id, e.project_id])).toEqual([
      ['deleted', task.id, f.sub.id],
    ])
    await assertNoDanglingRefs(t, 'after a task moved to Deleted items')
  })

  it('keeps a chosen subtask under its parent and detaches the children left behind', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const a = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    const aa = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: a.id })
    const kept = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id })
    await plantSubscription(t, { issue_id: kept.id, profile_id: f.guest.id })

    await deleteTask(t, f, root.id, { subtask_ids: [a.id, aa.id] })

    const item = await itemFor(t, root.id)
    expect(item.counts).toEqual({ tasks: 3, archived_tasks: 0, subtasks: 2, sub_projects: 0 })
    expect(item.projects.map((p) => [p.id, p.tasks])).toEqual([
      [f.sub.id, 2],
      [f.sub2.id, 1],
    ])
    expect((await storedIssue(t, root.id))?.parent_id).toBeUndefined()
    expect((await storedIssue(t, a.id))?.parent_id).toBe(root.id)
    expect((await storedIssue(t, aa.id))?.parent_id).toBe(a.id)
    expect(await storedTasks(t, item.id)).toHaveLength(3)
    // the child left behind is detached, touched and announced
    const left = await liveTask(t, kept.id)
    expect(left?.parent_id).toBeUndefined()
    expect(left?.updated_at).toBe(new Date(START).toISOString())
    const notices = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', f.guest.id).eq('issue_id', kept.id),
        )
        .collect(),
    )
    expect(notices.map((m) => [m.detail, m.actor_id])).toEqual([
      ['Detached from its parent', f.user.id],
    ])
  })

  it('refuses a reason longer than 500 characters and stores a blank one as none', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await expectRefusal(
      deleteTask(t, f, task.id, { reason: 'é'.repeat(501) }),
      'rule',
      /a reason can be at most 500 characters/,
    )
    expect(await liveTask(t, task.id)).not.toBeNull()
    await deleteTask(t, f, task.id, { reason: 'é'.repeat(500) })
    expect((await itemFor(t, task.id)).reason).toHaveLength(500)
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f, other.id, { reason: '   ' })
    expect((await itemFor(t, other.id)).reason).toBeUndefined()
  })

  it('deletes a row too large to store instead, and counts it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    // the wrapped comment adds a few hundred bytes to its body
    const fits = await comment(t, task, 'x'.repeat(STORED_ROW_MAX_BYTES - 1000))
    const tooLarge = await comment(t, task, 'x'.repeat(STORED_ROW_MAX_BYTES))
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    expect(item.state).toBe('ready')
    expect(item.dropped_rows).toBe(1)
    expect(item.counts.tasks).toBe(1)
    expect(await commentStored(t, fits.id)).toBe(true)
    expect(await commentStored(t, tooLarge.id)).toBe(false)
    expect(await t.run((ctx) => ctx.db.get(tooLarge._id))).toBeNull()
    for (const row of await storedRows(t, item.id)) {
      const { _id, _creationTime, ...doc } = row
      expect(estimateDocumentBytes(doc)).toBeLessThanOrEqual(STORED_ROW_MAX_BYTES)
    }
    expect(error).toHaveBeenCalledWith(
      'A deleted item dropped a row too large to store',
      expect.objectContaining({ item_id: item.id, table: 'comments' }),
    )

    // a task too large to store goes for good with its rows, as before
    const huge = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      description: 'x'.repeat(STORED_ROW_MAX_BYTES),
    })
    const note = await comment(t, huge)
    const file = await attach(t, huge)
    await deleteTask(t, f, huge.id)
    const hugeItem = await itemFor(t, huge.id)
    expect(hugeItem).toMatchObject({ state: 'ready', dropped_rows: 1 })
    expect(hugeItem.counts.tasks).toBe(0)
    expect(await storedRows(t, hugeItem.id)).toEqual([])
    expect(await liveTask(t, huge.id)).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(note._id))).toBeNull()
    expect(await blobExists(t, file.storage_id)).toBe(false)
    await assertNoDanglingRefs(t, 'after rows too large to store')
  })

  it('counts and lists only the subtasks it stores, so a dropped one gates no restore', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const huge = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: root.id,
      description: 'x'.repeat(STORED_ROW_MAX_BYTES),
    })
    await deleteTask(t, f, root.id, { subtask_ids: [huge.id] })
    const item = await itemFor(t, root.id)
    expect(item).toMatchObject({
      state: 'ready',
      dropped_rows: 1,
      counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
    })
    expect(item.projects.map((p) => p.id)).toEqual([f.sub.id])
    expect((await storedTasks(t, item.id)).map((x) => x.task_id)).toEqual([root.id])
    expect(await liveTask(t, huge.id)).toBeNull()
    // someone who edits Firmware alone can restore it: nothing goes back to Board rev
    const rita = await t.run(async (ctx) => {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id,
        name: 'Rita',
        initials: 'RI',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      const profile = (await ctx.db.get(_id)) as Doc<'profiles'>
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: profile.id,
        level: 'user',
      })
      return profile
    })
    expect(await t.run((ctx) => restoreBlock(ctx, rita, item))).toBeNull()
  })

  it("checks a task item's stored tasks before it is ready within the step budget", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT({ transactionLimits: { databaseQueries: 400 } })
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const subtasks: string[] = []
    for (let i = 0; i < 40; i++)
      subtasks.push((await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id })).id)
    // the user's delete leaves the rows of most tasks for the steps
    TRASH_BUDGET.ranges = 40
    await deleteTask(t, f, root.id, { subtask_ids: subtasks })
    const item = await itemFor(t, root.id)
    expect(item.state).toBe('moving')
    // a step drains every task, a few ranges each, and the check that
    // follows reads as many again, so it must stop on what the step has left
    TRASH_BUDGET.ranges = 300
    let steps = 0
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(20)
    }
    expect(steps).toBeGreaterThan(1)
    expect(await itemFor(t, root.id)).toMatchObject({ state: 'ready', counts: { tasks: 41 } })
  })
})

describe('webhook events', () => {
  async function subscribe(t: T, f: OrgFixture) {
    const owner = await t.run(async (ctx): Promise<EventOwner> => {
      const id = uuid()
      const row = await ctx.db.insert('mcp_tokens', {
        id,
        profile_id: f.admin.id,
        name: 'Trash events',
        token_prefix: 'qvt_test',
        token_hash: uuid(),
        access: 'read',
        created_at: NOW,
      })
      return {
        profile_id: f.admin.id,
        credential_table: 'mcp_tokens',
        credential_id: id,
        credential_row_id: row,
      }
    })
    for (const name of ['task.updated', 'task.deleted'] as const)
      await t.mutation(internal.webhooks.save, {
        owner,
        id: uuid(),
        name,
        filters: {},
        url: 'https://receiver.example/events',
        encrypted_secret: 'test-only',
      })
  }
  const events = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('webhook_events').collect()).map((e) => [e.name, e.task_id]),
    )

  it('sends task.deleted for the tasks of a task item and none for those of a project item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await subscribe(t, f)
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    expect(await events(t)).toEqual([
      ['task.deleted', sub.id],
      ['task.deleted', root.id],
    ])
    await t.run(async (ctx) => {
      for (const e of await ctx.db.query('webhook_events').collect()) await ctx.db.delete(e._id)
    })

    const inside = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const outside = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: inside.id })
    await deleteProject(t, f, f.sub2.id)
    expect((await itemFor(t, f.sub2.id)).state).toBe('ready')
    // the detached child outside is the only news
    expect(await events(t)).toEqual([['task.updated', outside.id]])
  })
})

describe('moving a project to Deleted items', () => {
  it('hides the projects at once, moves the tasks people see first, and finishes in bounded steps', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT({ transactionLimits: { databaseQueries: 150 } })
    const f = await withOrg(t)
    const org_id = f.org.id
    const hiddenSub = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: f.meta.id,
        name: 'EVT',
        week: '2026-05-04',
        created_at: NOW,
      })
    })
    // inside: tasks across both sub-projects, a third archived, each with a comment
    const inside: Doc<'issues'>[] = []
    for (let i = 0; i < 30; i++) {
      const task = await plantIssue(t, {
        org_id,
        project_id: i % 2 ? f.sub2.id : f.sub.id,
        archived_at: i % 3 === 0 ? NOW : undefined,
      })
      await comment(t, task)
      inside.push(task)
    }
    const group = await plantIssue(t, { org_id, project_id: f.sub.id })
    const member = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: group.id })
    const chatty = await plantIssue(t, { org_id, project_id: f.sub.id })
    for (let i = 0; i < 7; i++) await comment(t, chatty)
    const file = await attach(t, chatty)
    // planted last, so a move in index order would reach them last
    const outsideParent = await plantIssue(t, { org_id, project_id: hiddenSub.id })
    const inChild = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: outsideParent.id,
    })
    const inParent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const outChild = await plantIssue(t, {
      org_id,
      project_id: hiddenSub.id,
      parent_id: inParent.id,
    })
    await plantSubscription(t, { issue_id: outChild.id, profile_id: f.admin.id })
    const edges = [inChild, inParent]
    const others = [...inside, group, member, chatty]
    const all = [...others, ...edges]

    Object.assign(TRASH_BUDGET, { rows: 6, tasks: 4, ranges: 50 })
    await deleteProject(t, f, f.meta.id)

    // the projects are hidden at once, with their milestone and grants
    const item = await itemFor(t, f.meta.id)
    expect(item).toMatchObject({ kind: 'project', state: 'moving', key: 'TBED', path: [] })
    await t.run(async (ctx) => {
      for (const p of [f.meta, f.sub, f.sub2]) expect(await byId(ctx, 'projects', p.id)).toBeNull()
      expect(await ctx.db.query('milestones').collect()).toEqual([])
      expect(await ctx.db.query('project_access').collect()).toEqual([])
    })
    expect(await jobFor(t, item.id)).not.toBeNull()

    // a step without a range budget passes the limit; with one it fits
    Object.assign(TRASH_BUDGET, { rows: 1000, tasks: 1000, ranges: 1_000_000 })
    await expect(step(t, item.id)).rejects.toThrow(/Too many index ranges/)
    Object.assign(TRASH_BUDGET, { rows: 6, tasks: 4, ranges: 50 })

    const stillLive = async (tasks: Doc<'issues'>[]) =>
      (await Promise.all(tasks.map((task) => liveTask(t, task.id)))).filter((x) => x !== null)
        .length
    /* No other task moves before both edge tasks have: checked after the
     * user's transaction and after every step. */
    const edgesFirst = async () => {
      if ((await stillLive(others)) < others.length) expect(await stillLive(edges)).toBe(0)
    }
    await edgesFirst()
    let steps = 0
    let sawSplit = false
    let sawTasksPhase = false
    for (;;) {
      const before = (await storedRows(t, item.id)).length
      await step(t, item.id)
      steps++
      const moved = (await storedRows(t, item.id)).length - before
      expect(moved, `step ${steps}`).toBeLessThanOrEqual(TRASH_BUDGET.rows + 1)
      await edgesFirst()
      const job = await jobFor(t, item.id)
      if (job === null) break
      if (job.phase === 'move_tasks' && !sawTasksPhase) {
        // the edges phase ended: the edge task's child outside is detached
        expect(await stillLive(edges)).toBe(0)
        expect((await liveTask(t, outChild.id))?.parent_id).toBeUndefined()
        expect(await stillLive(others)).toBeGreaterThan(0)
        sawTasksPhase = true
      }
      const chattyStored = (await storedRows(t, item.id)).filter(
        (r) => r.owner_id === chatty.id && r.table === 'comments',
      ).length
      if ((await liveTask(t, chatty.id)) !== null && chattyStored > 0 && chattyStored < 7)
        sawSplit = true
      expect(steps).toBeLessThan(200)
    }
    expect(sawTasksPhase).toBe(true)
    expect(sawSplit).toBe(true)
    expect(steps).toBeGreaterThan(5)

    const ready = await itemFor(t, f.meta.id)
    const archived = inside.filter((task) => task.archived_at !== undefined).length
    expect(ready).toMatchObject({
      state: 'ready',
      counts: { tasks: all.length, archived_tasks: archived, subtasks: 0, sub_projects: 2 },
    })
    expect(ready.projects.map((p) => [p.id, p.tasks + p.archived_tasks > 0])).toEqual([
      [f.meta.id, false],
      [f.sub.id, true],
      [f.sub2.id, true],
    ])
    expect(ready.projects.reduce((n, p) => n + p.tasks, 0)).toBe(all.length)
    expect(await storedTasks(t, item.id)).toHaveLength(all.length)
    expect(await stillLive(all)).toBe(0)
    // the hierarchy inside is kept, and so is a parent outside
    expect((await storedIssue(t, member.id))?.parent_id).toBe(group.id)
    expect((await storedIssue(t, inChild.id))?.parent_id).toBe(outsideParent.id)
    expect(await blobExists(t, file.storage_id)).toBe(true)
    const notices = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', f.admin.id).eq('issue_id', outChild.id),
        )
        .collect(),
    )
    expect(notices.map((m) => m.detail)).toEqual(['Detached from its parent'])
    await assertNoDanglingRefs(t, 'after a project moved in steps')
  }, 120_000)

  it('stops a step on its range budget, which every read it makes spends', async () => {
    // each bare task costs one row but about eight index ranges to move
    const t = newT({ transactionLimits: { databaseQueries: 150 } })
    const f = await withOrg(t)
    for (let i = 0; i < 40; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 300, tasks: 100, ranges: 60 })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    expect(item.state).toBe('moving')
    // the row and task budgets alone would let one step take every task
    TRASH_BUDGET.ranges = 1_000_000
    await expect(step(t, item.id)).rejects.toThrow(/Too many index ranges/)
    TRASH_BUDGET.ranges = 60
    let steps = 0
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(50)
    }
    expect(steps).toBeGreaterThan(2)
    expect(await storedTasks(t, item.id)).toHaveLength(40)
  })

  it('stops a step on its byte budget, which the tasks it reads and passes over spend too', async () => {
    // none of these tasks has a parent or a child outside, so the first phase
    // reads each of them and moves none
    const t = newT({ transactionLimits: { bytesRead: 600_000 } })
    const f = await withOrg(t)
    const description = 'Spec line. '.repeat(1_500) // about 16 KB
    for (let i = 0; i < 60; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, description })
    TRASH_BUDGET.bytes = 100_000
    // the user's own delete runs the first step
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    expect(item.state).toBe('moving')
    let steps = 0
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(60)
    }
    expect(await itemFor(t, f.sub2.id)).toMatchObject({ state: 'ready', counts: { tasks: 60 } })
  })

  it('detaches without an actor once the deleter is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id, project_id: f.sub2.id })
    const parent = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await plantSubscription(t, { issue_id: child.id, profile_id: f.admin.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    expect(await liveTask(t, parent.id)).not.toBeNull()
    await t.run((ctx) => ctx.db.delete(f.user._id))
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await runSteps(t)
    expect((await itemFor(t, f.sub2.id)).state).toBe('ready')
    expect((await liveTask(t, child.id))?.parent_id).toBeUndefined()
    const notices = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', f.admin.id).eq('issue_id', child.id),
        )
        .collect(),
    )
    expect(notices.map((m) => [m.detail, m.actor_id])).toEqual([
      ['Detached from its parent', undefined],
    ])
  })
})

describe('reservations while items are in Deleted items', () => {
  it('keeps the uuids of stored rows taken, with the sentences of a live duplicate', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    const caller = as(t, f.user)
    await caller.mutation(api.issues.create, {
      org_id: f.org.id,
      id,
      project_id: f.sub.id,
      title: 'Short-lived',
    })
    const commentId = uuid()
    await caller.mutation(api.comments.create, {
      org_id: f.org.id,
      id: commentId,
      issue_id: id,
      body: 'first',
    })
    await deleteTask(t, f, id)
    await expectRefusal(
      caller.mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title: 'Squatter',
      }),
      'bad_request',
      /^a task with this id already exists$/,
    )
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await expectRefusal(
      caller.mutation(api.comments.create, {
        org_id: f.org.id,
        id: commentId,
        issue_id: other.id,
        body: 'squatter',
      }),
      'bad_request',
      /^a comment with this id already exists$/,
    )
    // a fresh id is fine
    await caller.mutation(api.issues.create, {
      org_id: f.org.id,
      id: uuid(),
      project_id: f.sub.id,
      title: 'New',
    })
  })

  it('keeps a deleted project key and uuid reserved until the project is purged', async () => {
    const t = newT()
    const f = await withOrg(t)
    await deleteProject(t, f, f.sub2.id)
    const create = (key: string, id = uuid()) =>
      as(t, f.admin).mutation(api.projects.create, {
        org_id: f.org.id,
        id,
        type: 'project',
        parent_id: f.meta.id,
        key,
        name: 'Board rev 2',
        sort_order: 9,
      })
    // a new project previewing the key gets another one
    expect((await create('PCB')).key).not.toBe('PCB')
    await expectRefusal(
      create('PCB2', f.sub2.id),
      'bad_request',
      /^a project with this id already exists$/,
    )
    const rekey = (who: Doc<'profiles'>) =>
      as(t, who).mutation(api.projects.update, {
        org_id: f.org.id,
        id: f.sub.id,
        patch: { key: 'PCB' },
      })
    await expectRefusal(
      rekey(f.admin),
      'bad_request',
      /^A project in Deleted items has that key\.$/,
    )
    // anyone else reads the sentence of a live holder, which discloses nothing
    await expectRefusal(
      rekey(f.user),
      'bad_request',
      /^a project with that key already exists in this organization$/,
    )
    await t.run(async (ctx) => {
      const item = await ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', f.sub2.id))
        .unique()
      await startPurge(ctx, item as Doc<'deleted_items'>, { inline: true })
    })
    await rekey(f.user)
    expect((await t.run((ctx) => byId(ctx, 'projects', f.sub.id)))?.key).toBe('PCB')
  })
})

describe('bytes in Deleted items', () => {
  it('fences trashed bytes from the orphan sweep and bills only live projects', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const live = await plantIssue(t, { org_id, project_id: f.sub.id })
    await attach(t, live, 5)
    const trashed = await plantIssue(t, { org_id, project_id: f.sub.id })
    const trashedFile = await attach(t, trashed, 11)
    await deleteTask(t, f, trashed.id)
    expect(await t.run((ctx) => storageIdInUse(ctx, trashedFile.storage_id))).toBe(true)
    // a project still moving: its tasks are stranded under the absent project
    for (let i = 0; i < 2; i++) {
      const stranded = await plantIssue(t, { org_id, project_id: f.sub2.id })
      await attach(t, stranded, 7)
    }
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    expect((await itemFor(t, f.sub2.id)).state).toBe('moving')
    const usage = await t.run((ctx) => storageUsage(ctx, org_id))
    expect(usage).toEqual({
      bytes: 5,
      projects: [{ project_id: f.sub.id, name: 'Firmware', storage_bytes: 5 }],
    })

    const orphan = await t.run((ctx) => ctx.storage.store(new Blob(['orphan']) as never))
    vi.setSystemTime(START + 2 * HOUR)
    await t.mutation(internal.files.reapOrphans, {})
    expect(await blobExists(t, orphan)).toBe(false)
    expect(await blobExists(t, trashedFile.storage_id)).toBe(true)
  })
})

describe('purging', () => {
  it('deletes every stored row with its bytes in bounded steps, then the item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    const to = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const from = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const planted = await plantRows(t, f, task, { to, from })
    for (let i = 0; i < 5; i++) await comment(t, task)
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    const rows = (await storedRows(t, item.id)).length

    TRASH_BUDGET.rows = 2
    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    expect((await itemById(t, item.id))?.state).toBe('purging')
    let steps = 0
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(50)
    }
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(rows / 2))
    expect(await itemById(t, item.id)).toBeNull()
    expect(await storedRows(t, item.id)).toEqual([])
    expect(await storedTasks(t, item.id)).toEqual([])
    expect(await blobExists(t, planted.attachment.storage_id)).toBe(false)
    await t.run(async (ctx) => {
      expect(await byId(ctx, 'labels', planted.labelId)).not.toBeNull()
      expect(await byId(ctx, 'issues', to.id)).not.toBeNull()
    })
    await assertNoDanglingRefs(t, 'after a purge')
  })

  it('purges a project item with the items that need it to come back, and clears its activity', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const early = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f, early.id)
    const earlyItem = await itemFor(t, early.id)
    const hiddenSub = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    const elsewhere = await plantIssue(t, { org_id, project_id: hiddenSub.id })
    await deleteTask(t, f, elsewhere.id)
    const kept = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const keptFile = await attach(t, kept)
    // a sub-project deleted before its parent is an item of its own
    await deleteProject(t, f, f.sub2.id)
    const subItem = await itemFor(t, f.sub2.id)
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    expect(item.projects.map((p) => p.id)).toEqual([f.meta.id, f.sub.id])
    const filedUnder = () =>
      t.run(async (ctx) =>
        (await ctx.db.query('activity_events').collect()).filter((e) => e.project_id === f.sub.id),
      )
    // the activity keeps the trashed project's id until the purge
    expect(await filedUnder()).toHaveLength(1)
    await assertNoDanglingRefs(t, 'while a project is in Deleted items')

    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    // the task item whose project was in it, and the sub-project item whose
    // parent was, could never come back
    expect(await itemById(t, earlyItem.id)).toBeNull()
    expect(await storedRows(t, earlyItem.id)).toEqual([])
    expect(await itemById(t, subItem.id)).toBeNull()
    expect(await blobExists(t, keptFile.storage_id)).toBe(false)
    // a task item from another project stays
    expect((await itemFor(t, elsewhere.id)).state).toBe('ready')
    expect(await filedUnder()).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('deleted_rows').collect())).toHaveLength(1)
    await assertNoDanglingRefs(t, 'after a project purge')
  })

  it('expires ready items after 30 days in bounded batches that chain', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const old = [
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
    ]
    for (const task of old) await deleteTask(t, f, task.id)
    const oldItems = await Promise.all(old.map((task) => itemFor(t, task.id)))
    vi.setSystemTime(START + 20 * DAY)
    const recent = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f, recent.id)

    EXPIRY.batch = 1
    vi.setSystemTime(START + TRASH_DAYS * DAY - 1)
    await t.mutation(internal.deletedItems.expire, {})
    await runSteps(t)
    for (const item of oldItems) expect((await itemById(t, item.id))?.state).toBe('ready')

    vi.setSystemTime(START + TRASH_DAYS * DAY)
    await t.mutation(internal.deletedItems.expire, {})
    await runSteps(t)
    for (const item of oldItems) expect(await itemById(t, item.id)).toBeNull()
    expect((await itemFor(t, recent.id)).state).toBe('ready')
    const runs = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter((job) =>
        job.name.includes('deletedItems:expire'),
      ),
    )
    // two due items, one per batch: each full batch chains the next run
    expect(runs.length).toBeGreaterThanOrEqual(2)
  })

  it('purges a stuck project item with the tasks it left in the live tables', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const stranded = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const strandedFile = await attach(t, stranded)
    await comment(t, stranded)
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: stranded.id })
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // its job gave up: the item is stuck with live rows left behind
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job?.scheduled_id !== undefined) await ctx.scheduler.cancel(job.scheduled_id)
      if (job !== null) await ctx.db.delete(job._id)
      await ctx.db.patch(item._id, { state: 'stuck' })
    })
    expect(await liveTask(t, stranded.id)).not.toBeNull()

    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query('issues')
          .withIndex('by_project', (q) => q.eq('project_id', f.sub2.id))
          .collect(),
      ).toEqual([])
      expect(await ctx.db.query('comments').collect()).toEqual([])
      expect(await ctx.db.query('deleted_rows').collect()).toEqual([])
    })
    expect(await blobExists(t, strandedFile.storage_id)).toBe(false)
    expect((await liveTask(t, child.id))?.parent_id).toBeUndefined()
    await assertNoDanglingRefs(t, 'after a stuck item was purged')
  })
})

describe('recovery', () => {
  it('restarts a stalled job at half the budget each time and makes the item stuck after its last retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // a step that failed leaves its job at the last committed progress
    const fail = async () => {
      const job = (await jobFor(t, item.id))!
      await t.run((ctx) => ctx.scheduler.cancel(job.scheduled_id!))
      return job
    }
    let job = await fail()
    expect(job).toMatchObject({ attempts: 0, budget_scale: 1 })
    let now = START
    await t.mutation(internal.deletedItems.recover, {})
    expect(await jobFor(t, item.id)).toEqual(job)
    const scales: number[] = []
    for (;;) {
      now += STALLED_MS + 1
      vi.setSystemTime(now)
      await t.mutation(internal.deletedItems.recover, {})
      const next = await jobFor(t, item.id)
      if (next === null) break
      expect(next.attempts).toBe(job.attempts + 1)
      expect(next.scheduled_id).not.toBe(job.scheduled_id)
      scales.push(next.budget_scale)
      job = await fail()
      expect(scales.length).toBeLessThan(20)
    }
    expect(scales).toEqual([1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 16, 1 / 16, 1 / 16, 1 / 16, 1 / 16])
    expect((await itemById(t, item.id))?.state).toBe('stuck')
    expect(error).toHaveBeenCalledWith(
      'A deleted item is stuck',
      expect.objectContaining({ item_id: item.id }),
    )
    // a stuck item can still be purged
    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
  })

  it('lets a step that fails at full budget finish at half, and a committed step resets the retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT({ transactionLimits: { documentsWritten: 60 } })
    const f = await withOrg(t)
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 40; i++)
      tasks.push(await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id }))
    TRASH_BUDGET.rows = 4
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // each moved task writes three documents, so 30 of them pass the limit
    TRASH_BUDGET.rows = 30
    const seen: number[] = []
    let now = START
    for (let round = 0; round < 20; round++) {
      await runSteps(t)
      const job = await jobFor(t, item.id)
      if (job === null) break
      now += STALLED_MS + 1
      vi.setSystemTime(now)
      await t.mutation(internal.deletedItems.recover, {})
      const resumed = await jobFor(t, item.id)
      if (resumed !== null) seen.push(resumed.budget_scale)
    }
    expect(seen).toContain(1 / 2)
    expect(seen).not.toContain(1 / 4)
    expect((await itemFor(t, f.sub2.id)).state).toBe('ready')
    expect(await storedTasks(t, item.id)).toHaveLength(tasks.length)
  }, 60_000)

  it('does nothing for an item that is gone, and leaves a deleting demo organization alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    const before = await storedRows(t, item.id)

    // a demo organization being deleted: its cleanup owns the rows
    vi.stubEnv('APP_MODE', 'demo')
    await t.run(async (ctx) => {
      await ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: 'demo-visitor',
        org_id: f.org.id,
        created_at: START,
        expires_at: START,
        status: 'deleting',
      })
    })
    const job = await jobFor(t, item.id)
    await step(t, item.id)
    expect(await jobFor(t, item.id)).toEqual(job)
    expect(await storedRows(t, item.id)).toEqual(before)
    vi.unstubAllEnvs()

    // an item deleted under its job: the step deletes the job and stops
    await t.run(async (ctx) => ctx.db.delete(item._id))
    await step(t, item.id)
    expect(await jobFor(t, item.id)).toBeNull()
    expect(await storedRows(t, item.id)).toEqual(before)
    await step(t, uuid())
  })
})

describe('references and liveness', () => {
  it('a stored reference holds only for the same row', () => {
    const item = { org_id: 'org', deleted_at: '2026-05-04T10:00:00.000Z' }
    const before = '2026-05-01T00:00:00.000Z'
    const after = '2026-05-05T00:00:00.000Z'
    expect(sameReference({ org_id: 'org', created_at: before }, item)).toBe(true)
    expect(sameReference({ org_id: 'org', created_at: item.deleted_at }, item)).toBe(true)
    expect(sameReference(null, item)).toBe(false)
    expect(sameReference({ org_id: 'elsewhere', created_at: before }, item)).toBe(false)
    // a uuid reused after the deletion names something else
    expect(sameReference({ org_id: 'org', created_at: after }, item)).toBe(false)
    const project = (type: 'meta' | 'project') => ({ org_id: 'org', created_at: before, type })
    expect(sameReference(project('project'), item, 'project')).toBe(true)
    expect(sameReference(project('meta'), item, 'project')).toBe(false)
    expect(sameReference(project('meta'), item, 'meta')).toBe(true)
  })

  it('tells live, trashed and gone tasks apart', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const live = await plantIssue(t, { org_id, project_id: f.sub.id })
    const deleted = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f, deleted.id)
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id, project_id: f.sub2.id })
    const stranded = await plantIssue(t, { org_id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    const where = (id: string) => t.run(async (ctx) => (await whereIsTask(ctx, id)).where)
    expect(await where(live.id)).toBe('live')
    expect(await where(deleted.id)).toBe('trash')
    // still in issues, but under a project that moved to Deleted items
    expect(await where(stranded.id)).toBe('trash')
    expect(await where(uuid())).toBe('gone')
    const item = await itemFor(t, deleted.id)
    await t.run((ctx) => ctx.db.patch(item._id, { state: 'purging' }))
    expect(await where(deleted.id)).toBe('gone')
  })
})

/* --------------------------------------------------------------- teardown */

/* Deleted items in each state a teardown can meet in `f`'s organization: a
 * ready task item with an attachment's bytes, a task item whose rows are
 * still draining, and a project item still moving, with tasks left in the
 * live tables under its absent project. The other organization holds one
 * ready item, the control. */
async function trashInFlight(t: T, f: OrgFixture) {
  const org_id = f.org.id
  const ready = await plantIssue(t, { org_id, project_id: f.sub.id })
  const readyFile = await attach(t, ready)
  await deleteTask(t, f, ready.id)
  const draining = await plantIssue(t, { org_id, project_id: f.sub.id })
  const drainingFile = await attach(t, draining)
  for (let i = 0; i < 3; i++) await comment(t, draining)
  const stranded: Doc<'issues'>[] = []
  for (let i = 0; i < 3; i++) stranded.push(await plantIssue(t, { org_id, project_id: f.sub2.id }))
  await comment(t, stranded[2])
  const strandedFile = await attach(t, stranded[2])
  Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
  await deleteTask(t, f, draining.id)
  await deleteProject(t, f, f.sub2.id)
  Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
  const elsewhere = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
  const elsewhereFile = await attach(t, elsewhere)
  await t.run((ctx) =>
    moveTasksToTrash(ctx, { actor: f.otherAdmin, root: elsewhere, subtasks: [], now: NOW }),
  )

  expect((await itemFor(t, ready.id)).state).toBe('ready')
  expect((await itemFor(t, draining.id)).state).toBe('moving')
  expect((await itemFor(t, f.sub2.id)).state).toBe('moving')
  expect(await liveRowsOf(t, draining.id)).toBeGreaterThan(0)
  const left = await t.run((ctx) =>
    ctx.db
      .query('issues')
      .withIndex('by_project', (q) => q.eq('project_id', f.sub2.id))
      .collect(),
  )
  expect(left.length).toBeGreaterThan(0)
  return {
    files: [readyFile, drainingFile, strandedFile].map((file) => file.storage_id),
    elsewhere: { item: await itemFor(t, elsewhere.id), file: elsewhereFile.storage_id },
  }
}

/** The comments and attachments task `id` still has in the live tables. */
const liveRowsOf = (t: T, id: string) =>
  t.run(async (ctx) => {
    const comments = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect()
    const files = await ctx.db
      .query('issue_attachments')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect()
    return comments.length + files.length
  })

/** What organization `orgId` keeps in Deleted items, by table. */
const trashOf = (t: T, orgId: string) =>
  t.run(async (ctx) => ({
    items: (await ctx.db.query('deleted_items').collect()).filter((r) => r.org_id === orgId),
    rows: (await ctx.db.query('deleted_rows').collect()).filter((r) => r.org_id === orgId),
    tasks: (await ctx.db.query('deleted_tasks').collect()).filter((r) => r.org_id === orgId),
  }))

describe('organization teardown', () => {
  it('deleteOrgDeep deletes every item, stored row, leftover live row and byte of the organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { files, elsewhere } = await trashInFlight(t, f)

    await t.run(async (ctx) => deleteOrgDeep(ctx, (await ctx.db.get(f.org._id))!))

    expect(await trashOf(t, f.org.id)).toEqual({ items: [], rows: [], tasks: [] })
    expect(await t.run((ctx) => ctx.db.query('deleted_item_jobs').collect())).toEqual([])
    for (const table of ['issues', 'comments', 'issue_attachments'] as const)
      expect(await t.run((ctx) => ctx.db.query(table).collect()), table).toEqual([])
    for (const file of files) expect(await blobExists(t, file)).toBe(false)
    // the other organization keeps its item and its bytes
    expect(await itemById(t, elsewhere.item.id)).toEqual(elsewhere.item)
    expect(await blobExists(t, elsewhere.file)).toBe(true)
    // a step scheduled before the teardown finds nothing to do
    await runSteps(t)
    expect(await trashOf(t, f.org.id)).toEqual({ items: [], rows: [], tasks: [] })
    await assertNoDanglingRefs(t, 'after deleteOrgDeep with Deleted items')
  })

  it('purgeOrg empties Deleted items in bounded batches whatever their state, and refuses production', async () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
    vi.stubEnv('SITE_URL', 'https://preview.qivo.io')
    const t = newT()
    const f = await withOrg(t)
    const { files, elsewhere } = await trashInFlight(t, f)
    const live = await t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_project', (q) => q.eq('project_id', f.sub.id))
        .collect(),
    )
    PURGE_ORG.batch = 3

    vi.stubEnv('QIVO_ENVIRONMENT', 'production')
    await expect(t.mutation(internal.deletedItems.purgeOrg, { org_id: f.org.id })).rejects.toThrow(
      /cannot run on a production/,
    )
    expect((await trashOf(t, f.org.id)).items).toHaveLength(3)
    vi.stubEnv('QIVO_ENVIRONMENT', 'staging')

    let calls = 0
    for (;;) {
      calls++
      expect(calls).toBeLessThan(100)
      const { done } = await t.mutation(internal.deletedItems.purgeOrg, { org_id: f.org.id })
      if (done) break
    }
    expect(calls).toBeGreaterThan(3)
    await runSteps(t)
    expect(await trashOf(t, f.org.id)).toEqual({ items: [], rows: [], tasks: [] })
    // the tasks the moving project left behind went with it, and every byte
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('issues')
          .withIndex('by_project', (q) => q.eq('project_id', f.sub2.id))
          .collect(),
      ),
    ).toEqual([])
    for (const file of files) expect(await blobExists(t, file)).toBe(false)
    // live work and the other organization stay
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('issues')
          .withIndex('by_project', (q) => q.eq('project_id', f.sub.id))
          .collect(),
      ),
    ).toEqual(live)
    expect(await itemById(t, elsewhere.item.id)).toEqual(elsewhere.item)
    expect(await blobExists(t, elsewhere.file)).toBe(true)
  })

  it("purgeTasks deletes a drive's own tasks for good, and nothing else", async () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'development')
    vi.stubEnv('SITE_URL', 'https://dev.qivo.test')
    const t = newT()
    const f = await withOrg(t)
    const temporary = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const file = await attach(t, temporary)
    const kept = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f, temporary.id)
    await deleteTask(t, f, kept.id)
    const keptItem = await itemFor(t, kept.id)

    vi.stubEnv('APP_MODE', 'demo')
    await expect(
      t.mutation(internal.deletedItems.purgeTasks, { task_ids: [temporary.id] }),
    ).rejects.toThrow(/public demo/)
    vi.stubEnv('APP_MODE', '')

    expect(
      await t.mutation(internal.deletedItems.purgeTasks, { task_ids: [temporary.id, uuid()] }),
    ).toEqual({ purged: 1, waiting: 0 })
    await runSteps(t)
    expect(await storedIssue(t, temporary.id)).toBeUndefined()
    expect(await blobExists(t, file.storage_id)).toBe(false)
    expect(await itemById(t, keptItem.id)).toEqual(keptItem)
  })
})
