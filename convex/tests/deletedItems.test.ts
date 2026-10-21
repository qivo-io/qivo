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
import { REAP_PAGES } from '../files'
import { byId } from '../lib/db'
import { ORG_REMOVAL_PHASES, type OrgRemovalPhase } from '../lib/enums'
import type { EventOwner } from '../lib/taskEvents'
import { FOLLOWER_MAX, SUBTASK_MAX } from '../lib/taskLimits'
import { TEXT_MAX } from '../lib/textLimits'
import { storageIdInUse } from '../model/attachments'
import { storageUsage } from '../model/billing'
import { deleteOrgDeep, REMOVAL_BUDGET } from '../model/cascade'
import {
  DELETE_REASON_TOO_LONG,
  EXPIRY,
  moveTasksToTrash,
  STALLED_MS,
  STORED_ROW_MAX_BYTES,
  sameReference,
  startPurge,
  TRASH_BUDGET,
  TRASH_DAYS,
  whereIsTask,
} from '../model/deletedItems'
import { estimateDocumentBytes } from '../model/demoMetrics'
import { PARENT_BEING_DELETED, SUBTASK_BEING_DELETED } from '../model/issues'
import { ITEM_UNREAD_CAP } from '../model/messages'
import {
  as,
  chargeFilteredReads,
  countersFor,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantMessage,
  plantProject,
  plantSubscription,
  reap,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'
import {
  assertNoOrphanHistory,
  attach,
  blobExists,
  comment,
  DAY,
  DEFAULT_BUDGET,
  deleteProject,
  deleteTask,
  expectedRow,
  HOUR,
  historyOf,
  installTrashTimers,
  itemById,
  itemFor,
  jobFor,
  liveTask,
  plantCredential,
  plantHistory,
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

/** The uuids of `n` subtasks of `parent` in project `projectId`, each with
 * `description`, planted 100 to a transaction so a large set stays within
 * the write limits, in the order planted. */
async function plantChildren(
  t: T,
  parent: Doc<'issues'>,
  projectId: string,
  n: number,
  description: string,
): Promise<string[]> {
  const ids = Array.from({ length: n }, () => uuid())
  for (let from = 0; from < n; from += 100)
    await t.run(async (ctx) => {
      for (const [i, id] of ids.slice(from, from + 100).entries())
        await ctx.db.insert('issues', {
          id,
          org_id: parent.org_id,
          project_id: projectId,
          parent_id: parent.id,
          num: 10_000 + from + i,
          title: `Subtask ${from + i + 1}`,
          description,
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
    })
  return ids
}

/** `n` task items of Firmware that are moving, restoring and purging in
 * turn, as tasks deleted one by one leave them while their steps run,
 * planted 2,500 to a transaction. */
async function plantBusyItems(t: T, f: OrgFixture, n: number): Promise<void> {
  const states = ['moving', 'restoring', 'purging'] as const
  for (let from = 0; from < n; from += 2500)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 2500); i++)
        await ctx.db.insert('deleted_items', {
          id: uuid(),
          org_id: f.org.id,
          kind: 'task',
          target_id: uuid(),
          num: 20_000 + i,
          name: `Calibrate sensor ${i + 1}`,
          status: 'todo',
          archived: false,
          project_id: f.sub.id,
          parent_project_id: f.meta.id,
          path: [f.meta.name, f.sub.name],
          projects: [
            {
              id: f.sub.id,
              name: f.sub.name,
              key: f.sub.key,
              type: 'project',
              tasks: 1,
              archived_tasks: 0,
            },
          ],
          counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
          deleted_at: NOW,
          deleted_by: f.user.id,
          state: states[i % 3],
          restore_by: states[i % 3] === 'restoring' ? f.user.id : undefined,
          purge_after: START + TRASH_DAYS * DAY,
        })
    })
}

/** How many items of the organization of `f` are in `state`. */
const busyCount = (t: T, f: OrgFixture, state: Doc<'deleted_items'>['state']) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('deleted_items')
          .withIndex('by_org_state', (q) => q.eq('org_id', f.org.id).eq('state', state))
          .collect()
      ).length,
  )

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
    const b = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id })
    const kept = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id })
    await plantSubscription(t, { issue_id: kept.id, profile_id: f.guest.id })

    await deleteTask(t, f, root.id, { subtask_ids: [a.id, b.id] })

    const item = await itemFor(t, root.id)
    expect(item.counts).toEqual({ tasks: 3, archived_tasks: 0, subtasks: 2, sub_projects: 0 })
    expect(item.projects.map((p) => [p.id, p.tasks])).toEqual([
      [f.sub.id, 2],
      [f.sub2.id, 1],
    ])
    expect((await storedIssue(t, root.id))?.parent_id).toBeUndefined()
    expect((await storedIssue(t, a.id))?.parent_id).toBe(root.id)
    expect((await storedIssue(t, b.id))?.parent_id).toBe(root.id)
    expect(await storedTasks(t, item.id)).toHaveLength(3)
    // the child left behind is detached and touched, then announced
    const left = await liveTask(t, kept.id)
    expect(left?.parent_id).toBeUndefined()
    expect(left?.updated_at).toBe(new Date(START).toISOString())
    // its followers hear of it from a background step
    await runSteps(t)
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

  it('refuses a trimmed reason over 500 characters, an emoji counting two, and stores a blank one as none', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const reason of ['é'.repeat(501), `${'😀'.repeat(250)}a`, ` ${'a'.repeat(501)} `]) {
      const e = await expectRefusal(deleteTask(t, f, task.id, { reason }), 'rule')
      expect(e.data.message).toBe(DELETE_REASON_TOO_LONG)
    }
    expect(await liveTask(t, task.id)).not.toBeNull()
    await deleteTask(t, f, task.id, { reason: ` ${'😀'.repeat(250)} ` })
    expect((await itemFor(t, task.id)).reason).toBe('😀'.repeat(250))
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

    // a task too large to store, which only a task stored before the caps
    // can be, goes in cut to the caps with its rows
    const huge = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      description: 'x'.repeat(STORED_ROW_MAX_BYTES),
    })
    const note = await comment(t, huge)
    const file = await attach(t, huge)
    await deleteTask(t, f, huge.id)
    await runSteps(t)
    const hugeItem = await itemFor(t, huge.id)
    expect(hugeItem).toMatchObject({ state: 'ready', counts: { tasks: 1 } })
    expect(hugeItem.dropped_rows).toBeUndefined()
    expect((await storedIssue(t, huge.id))?.description).toBe('x'.repeat(TEXT_MAX))
    expect(await commentStored(t, note.id)).toBe(true)
    expect(await liveTask(t, huge.id)).toBeNull()
    expect(await blobExists(t, file.storage_id)).toBe(true)
    expect(error).toHaveBeenCalledWith(
      'A deleted item cut a task too large to store',
      expect.objectContaining({ item_id: hugeItem.id, task_id: huge.id }),
    )
    await assertNoDanglingRefs(t, 'after rows too large to store')
  })

  it('moves a task too large to store with a long thread within the limits, and restores it cut to the caps', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // convex-test counts no range for a delete, which reads its row first,
    // so the writes stand in for those ranges
    const t = newT({ transactionLimits: { documentsWritten: 4096 } })
    const f = await withOrg(t)
    const org_id = f.org.id
    const huge = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      // the cuts fall inside an emoji, which neither splits
      title: '😀'.repeat(200),
      description: `${'x'.repeat(TEXT_MAX - 1)}😀${'x'.repeat(STORED_ROW_MAX_BYTES)}`,
    })
    // a thread longer than one transaction may delete
    for (let from = 0; from < 4500; from += 1500)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 1500; i++)
          await ctx.db.insert('comments', {
            id: uuid(),
            issue_id: huge.id,
            body: `Note ${i + 1}`,
            created_at: NOW,
          })
      })
    await plantHistory(t, huge, { listed: 3 })

    await deleteTask(t, f, huge.id)
    await runSteps(t)

    const item = await itemFor(t, huge.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: 1 }, name: '😀'.repeat(80) })
    const stored = await storedIssue(t, huge.id)
    expect(stored?.title).toBe('😀'.repeat(80))
    expect(stored?.description).toBe('x'.repeat(TEXT_MAX - 1))
    expect((await storedRows(t, item.id)).filter((row) => row.table === 'comments')).toHaveLength(
      4500,
    )
    // it keeps its history, with the 'deleted' row
    expect(await historyOf(t, huge.id)).toHaveLength(4)

    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    await runSteps(t)
    expect(await liveTask(t, huge.id)).toMatchObject({
      title: '😀'.repeat(80),
      description: 'x'.repeat(TEXT_MAX - 1),
    })
  }, 120_000)

  it("leaves the subtasks' rows to steps once the tasks it read have spent the delete's bytes", async () => {
    const t = newT()
    const f = await withOrg(t)
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // 100 subtasks of 20,000 three-byte characters pass the 4 MiB a step reads
    const ids = await plantChildren(t, root, f.sub.id, SUBTASK_MAX, '中'.repeat(TEXT_MAX))
    const notes = await t.run(async (ctx) => {
      const out: string[] = []
      for (const issue_id of ids) {
        const id = uuid()
        await ctx.db.insert('comments', { id, issue_id, body: 'Checked', created_at: NOW })
        out.push(id)
      }
      return out
    })
    await deleteTask(t, f, root.id, { subtask_ids: ids })
    expect((await itemFor(t, root.id)).state).toBe('moving')
    for (const id of notes) expect(await commentStored(t, id)).toBe(false)
    await runSteps(t)
    expect((await itemFor(t, root.id)).state).toBe('ready')
    for (const id of notes) expect(await commentStored(t, id)).toBe(true)
  }, 120_000)

  it('deletes the history a job of the release before still names in purge_history', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // a task that release deleted for good, whose history its job kept
    const gone = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, gone, { listed: 3 })
    await t.run((ctx) => ctx.db.delete(gone._id))
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    for (let i = 0; i < 3; i++) await comment(t, task)
    TRASH_BUDGET.rows = 1
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job === null) throw new Error('the move left no job')
      await ctx.db.patch(job._id, { purge_history: [gone.id] })
    })
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await runSteps(t)
    expect(await itemFor(t, task.id)).toMatchObject({ state: 'ready' })
    expect(await historyOf(t, gone.id)).toEqual([])
    expect(await jobFor(t, item.id)).toBeNull()
  })

  it('stores a task too large to store cut to the caps when its project is deleted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const huge = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub2.id,
      description: 'x'.repeat(STORED_ROW_MAX_BYTES),
    })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: 1 } })
    expect(item.dropped_rows).toBeUndefined()
    expect((await storedIssue(t, huge.id))?.description).toBe('x'.repeat(TEXT_MAX))
  })

  it('counts and lists a subtask too large to store, which goes in cut to the caps', async () => {
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
      counts: { tasks: 2, archived_tasks: 0, subtasks: 1, sub_projects: 0 },
    })
    expect(item.dropped_rows).toBeUndefined()
    expect(item.projects.map((p) => p.id)).toEqual([f.sub.id, f.sub2.id])
    expect((await storedTasks(t, item.id)).map((x) => x.task_id)).toEqual([huge.id, root.id])
    expect((await storedIssue(t, huge.id))?.parent_id).toBe(root.id)
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

/* A task delete at the caps: the delete's own transaction deletes the
 * messages it has room for and steps delete the rest, and the children it
 * detaches tell their followers from steps. convex-test does not count the
 * index range a backend reads to delete a row, so these suites hold each
 * transaction to 4,096 writes instead, which every delete also spends.
 * Two followers per task keep convex-test fast; FOLLOWER_MAX per task was
 * checked on a local backend. */
describe('a task delete at the caps', () => {
  const LIMITS = { documentsWritten: 4096 }

  /** `n` people who see TBED, the guest first and then readers with their
   * own grant. */
  const plantPeople = (t: T, f: OrgFixture, n: number) =>
    t.run(async (ctx) => {
      const people = [f.guest.id]
      for (let i = 1; i < n; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `Reader ${i}`,
          initials: 'RD',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          accepted_at: NOW,
          created_at: NOW,
        })
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: id,
          level: 'user',
        })
        people.push(id)
      }
      return people
    })

  /** Makes each of `people` follow each of `tasks` with a full inbox item,
   * ITEM_UNREAD_CAP unread rows and one read row, planted 4,000 rows to a
   * transaction. */
  async function plantInbox(
    t: T,
    f: OrgFixture,
    tasks: Doc<'issues'>[],
    people: string[],
  ): Promise<void> {
    await t.run(async (ctx) => {
      for (const task of tasks)
        for (const profile_id of people)
          await ctx.db.insert('issue_subscriptions', {
            issue_id: task.id,
            profile_id,
            created_at: NOW,
          })
    })
    const rows = tasks.flatMap((task) =>
      people.flatMap((recipient_id) =>
        Array.from({ length: ITEM_UNREAD_CAP + 1 }, (_, i) => ({ task, recipient_id, i })),
      ),
    )
    for (let from = 0; from < rows.length; from += 4000)
      await t.run(async (ctx) => {
        for (const { task, recipient_id, i } of rows.slice(from, from + 4000))
          await ctx.db.insert('messages', {
            id: uuid(),
            org_id: f.org.id,
            recipient_id,
            issue_id: task.id,
            issue_title: task.title,
            kind: 'change',
            detail: `Status update ${i + 1}`,
            created_at: NOW,
            read_at: i === ITEM_UNREAD_CAP ? NOW : undefined,
          })
      })
  }

  /** A parent with SUBTASK_MAX subtasks, the parent and each subtask
   * followed by `people` with a full inbox item. */
  async function plantFamily(t: T, f: OrgFixture, people: string[]) {
    const root = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      title: 'Sensor rig',
    })
    const ids = await plantChildren(t, root, f.sub.id, SUBTASK_MAX, '')
    const kids = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await byId(ctx, 'issues', id)) as Doc<'issues'>)),
    )
    await plantInbox(t, f, [root, ...kids], people)
    return { root, kids }
  }

  /** How many messages are stored about each of `ids`, one task to a read. */
  async function messagesAbout(t: T, ids: string[]): Promise<number> {
    let n = 0
    for (const issue_id of ids)
      n += await t.run(
        async (ctx) =>
          (
            await ctx.db
              .query('messages')
              .withIndex('by_issue_read', (q) => q.eq('issue_id', issue_id))
              .collect()
          ).length,
      )
    return n
  }

  /** The tasks the messages in the guest's app are about. */
  const shownToGuest = async (t: T, f: OrgFixture) =>
    new Set(
      ((await as(t, f.guest).query(api.snapshot.forMe, {}))?.messages ?? []).map((m) => m.issue_id),
    )

  it('deletes a parent at SUBTASK_MAX with every follower holding a full item, in the app', async () => {
    const t = newT({ transactionLimits: LIMITS })
    const f = await withOrg(t)
    const { root, kids } = await plantFamily(t, f, await plantPeople(t, f, 2))
    const doomed = [root, ...kids].map((task) => task.id)
    expect(await messagesAbout(t, doomed)).toBe(101 * 2 * (ITEM_UNREAD_CAP + 1))

    await deleteTask(t, f, root.id, { subtask_ids: kids.map((kid) => kid.id) })

    // hidden at once, while steps delete what is left
    expect(await itemFor(t, root.id)).toMatchObject({
      state: 'moving',
      counts: { tasks: 101, subtasks: 100 },
    })
    expect(await messagesAbout(t, doomed)).toBeGreaterThan(0)
    const shown = await shownToGuest(t, f)
    for (const id of doomed) expect(shown.has(id)).toBe(false)

    await runSteps(t)
    expect(await itemFor(t, root.id)).toMatchObject({ state: 'ready' })
    expect(await messagesAbout(t, doomed)).toBe(0)
  }, 120_000)

  it.each(['rest', 'mcp'] as const)(
    'deletes the same parent alone over %s, and the detached subtasks tell their followers from steps',
    async (surface) => {
      const t = newT({ transactionLimits: LIMITS })
      const f = await withOrg(t)
      const { root, kids } = await plantFamily(t, f, await plantPeople(t, f, 2))
      const credential = await plantCredential(t, f.user, 'mcp_tokens', 'Laptop script')
      const args = { callerId: f.user.id, access: 'write' as const, credential, ref: root.id }

      if (surface === 'rest')
        await t.mutation(internal.machine.rest.deleteIssue, { ...args, keyName: null })
      else await t.mutation(internal.machine.mcp.deleteIssue, args)

      expect((await shownToGuest(t, f)).has(root.id)).toBe(false)
      const guestRows = () => messagesFor(t, f.guest.id)
      const detached = (rows: Doc<'messages'>[], id: string) =>
        rows.filter((m) => m.issue_id === id && m.detail === 'Detached from its parent')
      for (const kid of kids) {
        expect((await liveTask(t, kid.id))?.parent_id).toBeUndefined()
        expect(detached(await guestRows(), kid.id)).toEqual([])
      }

      await runSteps(t)
      expect(await itemFor(t, root.id)).toMatchObject({ state: 'ready', counts: { tasks: 1 } })
      expect(await messagesAbout(t, [root.id])).toBe(0)
      // each follower reads the detach once, and its item stays at the cap
      const rows = await guestRows()
      for (const kid of kids) {
        expect(detached(rows, kid.id)).toHaveLength(1)
        const unread = rows.filter((m) => m.issue_id === kid.id && m.read_at === undefined)
        expect(unread.length).toBeLessThanOrEqual(ITEM_UNREAD_CAP)
      }
    },
    300_000,
  )

  it('deletes a single task whose FOLLOWER_MAX followers each hold a full item, in steps', async () => {
    const t = newT({ transactionLimits: LIMITS })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantInbox(t, f, [task], await plantPeople(t, f, FOLLOWER_MAX))
    expect(await messagesAbout(t, [task.id])).toBe(FOLLOWER_MAX * (ITEM_UNREAD_CAP + 1))

    await deleteTask(t, f, task.id)

    expect((await shownToGuest(t, f)).has(task.id)).toBe(false)
    await runSteps(t)
    expect(await itemFor(t, task.id)).toMatchObject({ state: 'ready' })
    expect(await messagesAbout(t, [task.id])).toBe(0)
  }, 120_000)
  it("goes back to the drain when the finish check finds a task item's message left", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const subtasks: string[] = []
    for (let i = 0; i < 40; i++)
      subtasks.push((await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id })).id)
    // the check that follows the drain spans steps
    TRASH_BUDGET.ranges = 40
    await deleteTask(t, f, root.id, { subtask_ids: subtasks })
    const item = await itemFor(t, root.id)
    let steps = 0
    while ((await jobFor(t, item.id))?.phase !== 'move_finish') {
      await step(t, item.id)
      expect(++steps).toBeLessThan(20)
    }
    // a message the drain passed over, as a tie of _creationTime can leave
    // one; the root is the last task the check reads
    await plantMessage(t, { org_id, recipient_id: f.guest.id, issue_id: root.id })
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      expect(++steps).toBeLessThan(60)
    }
    expect(await itemFor(t, root.id)).toMatchObject({ state: 'ready' })
    expect(await messagesFor(t, f.guest.id, root.id)).toEqual([])
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
  it('holds the reason to the cap a task delete has', async () => {
    const t = newT()
    const f = await withOrg(t)
    const e = await expectRefusal(
      deleteProject(t, f, f.sub2.id, { reason: `${'😀'.repeat(250)}a` }),
      'rule',
    )
    expect(e.data.message).toBe(DELETE_REASON_TOO_LONG)
    expect(await t.run((ctx) => byId(ctx, 'projects', f.sub2.id))).not.toBeNull()
    await deleteProject(t, f, f.sub2.id, { reason: 'é'.repeat(500) })
    expect((await itemFor(t, f.sub2.id)).reason).toBe('é'.repeat(500))
  })

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

  it('moves a task with 1,000 subtasks of 20,000 characters in its own project within the real limits', async () => {
    // the subtasks hold about 20 MB, more than one transaction may read, so
    // the move must find the parent's child outside without reading them
    const t = newT({ transactionLimits: true })
    chargeFilteredReads()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const description = 'Spec line. '.repeat(2_000).slice(0, TEXT_MAX)
    const subtasks = await plantChildren(t, parent, f.sub2.id, 1_000, description)
    // planted last, so a scan of the children in index order reaches it last
    const outside = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })

    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)

    expect(await itemFor(t, f.sub2.id)).toMatchObject({ state: 'ready', counts: { tasks: 1_001 } })
    expect((await liveTask(t, outside.id))?.parent_id).toBeUndefined()
    expect((await storedIssue(t, subtasks[999]))?.parent_id).toBe(parent.id)
  }, 300_000)

  it('finds a child outside without reading the children inside, and scans the tasks over steps', async () => {
    // the old scan read every child inside, 60 of 16 KB and more than the
    // transaction may read, before it found the one outside
    const t = newT({ transactionLimits: { bytesRead: 600_000 } })
    chargeFilteredReads()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await plantChildren(t, parent, f.sub2.id, 60, 'Spec line. '.repeat(1_500))
    const outside = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    TRASH_BUDGET.bytes = 100_000

    // the parent has a child outside, so the user's own delete moves it
    // first and detaches that child
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    expect(await liveTask(t, parent.id)).toBeNull()
    expect((await liveTask(t, outside.id))?.parent_id).toBeUndefined()
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'move_edges' })

    // the scan of the other tasks goes on in steps within the byte budget
    let edgeSteps = 0
    let steps = 0
    for (let job = await jobFor(t, item.id); job !== null; job = await jobFor(t, item.id)) {
      if (job.phase === 'move_edges') edgeSteps++
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(60)
    }
    expect(edgeSteps).toBeGreaterThan(2)
    expect(await itemFor(t, f.sub2.id)).toMatchObject({ state: 'ready', counts: { tasks: 61 } })
    expect((await storedIssue(t, parent.id))?.parent_id).toBeUndefined()
  })

  it('refuses a move, archive or restore that would change a task it still holds until it is done, for an admin too', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // PCB holds subtasks of a Firmware task, and the archived parent of another
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const inPcb: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++) {
      inPcb.push(await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: parent.id }))
    }
    const shelved = await plantIssue(t, { org_id, project_id: f.sub2.id, archived_at: NOW })
    const child = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      parent_id: shelved.id,
      archived_at: NOW,
    })
    const away = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    // the project rows are gone, and its first budget left these behind
    expect(await t.run((ctx) => byId(ctx, 'projects', f.sub2.id))).toBeNull()
    expect(await liveTask(t, shelved.id)).not.toBeNull()
    const left = []
    for (const kid of inPcb) if ((await liveTask(t, kid.id)) !== null) left.push(kid)
    expect(left.length).toBeGreaterThan(0)
    const admin = as(t, f.admin)
    const move = () =>
      admin.mutation(api.issues.move, { org_id, id: parent.id, project_id: away.id })
    const archive = () => admin.mutation(api.issues.archive, { org_id, id: parent.id })
    const restore = () => admin.mutation(api.issues.unarchive, { org_id, id: child.id })
    for (const [attempt, sentence] of [
      [move, SUBTASK_BEING_DELETED],
      [archive, SUBTASK_BEING_DELETED],
      [restore, PARENT_BEING_DELETED],
    ] as const) {
      expect((await expectRefusal(attempt(), 'rule')).data.message).toBe(sentence)
    }
    expect(await liveTask(t, parent.id)).toEqual(parent)
    expect(await liveTask(t, child.id)).toEqual(child)
    // once the move finishes, each goes through
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await runSteps(t)
    expect((await itemFor(t, f.sub2.id)).state).toBe('ready')
    await restore()
    const restored = await liveTask(t, child.id)
    expect([restored?.parent_id, restored?.archived_at]).toEqual([undefined, undefined])
    await move()
    await archive()
    const moved = await liveTask(t, parent.id)
    expect(moved?.project_id).toBe(away.id)
    expect(moved?.archived_at).toBeDefined()
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

  it('never hands out the numbers of trashed work again', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // one task, numbered by the fixture's counters
    const first = await plantIssue(t, { org_id, project_id: f.sub.id, num: 1 })
    await deleteTask(t, f, first.id)
    await deleteProject(t, f, f.sub2.id)
    const items = [(await itemFor(t, first.id)).id, (await itemFor(t, f.sub2.id)).id]
    const task = async () =>
      (
        await as(t, f.user).mutation(api.issues.create, {
          org_id,
          id: uuid(),
          project_id: f.sub.id,
          title: 'Numbered',
        })
      ).num
    const project = async (key: string) =>
      (
        await as(t, f.admin).mutation(api.projects.create, {
          org_id,
          id: uuid(),
          type: 'project',
          parent_id: f.meta.id,
          key,
          name: key,
          sort_order: 9,
        })
      ).num
    // the numbers after the deletes go on past the trashed work
    expect(await task()).toBe(2)
    expect(await project('NEW')).toBe(6)
    const result = await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: items })
    expect(result.restored.toSorted()).toEqual(items.toSorted())
    expect((await liveTask(t, first.id))?.num).toBe(1)
    expect((await t.run((ctx) => byId(ctx, 'projects', f.sub2.id)))?.num).toBe(f.sub2.num)
    expect(await task()).toBe(3)
    expect(await project('NEWER')).toBe(7)
    expect(await countersFor(t, org_id)).toEqual({ next_issue_num: 3, next_project_num: 7 })
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
    // one file per leg, so the sweep checks the trashed file in a leg of its own
    const pages = { ...REAP_PAGES }
    REAP_PAGES.files = 1
    try {
      expect(await reap(t)).toMatchObject({ deleted: 1, kept: 4 })
    } finally {
      Object.assign(REAP_PAGES, pages)
    }
    expect(await blobExists(t, orphan)).toBe(false)
    expect(await blobExists(t, trashedFile.storage_id)).toBe(true)
  })
})

describe('purging', () => {
  it('deletes every stored row with its bytes and the history in bounded steps, then the item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    const to = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const from = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const planted = await plantRows(t, f, task, { to, from })
    for (let i = 0; i < 5; i++) await comment(t, task)
    await plantHistory(t, task, { listed: 5, unlisted: 2 })
    await plantHistory(t, to, { listed: 2 })
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    const rows = (await storedRows(t, item.id)).length
    // the planted rows and the delete's own
    const history = (await historyOf(t, task.id)).length
    expect(history).toBe(8)

    TRASH_BUDGET.rows = 2
    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    expect((await itemById(t, item.id))?.state).toBe('purging')
    let steps = 0
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(50)
    }
    expect(await historyOf(t, task.id)).toEqual([])
    // each history row costs the budget a row
    expect(steps).toBeGreaterThanOrEqual(Math.ceil((rows + history) / 2))
    expect(await itemById(t, item.id)).toBeNull()
    expect(await storedRows(t, item.id)).toEqual([])
    expect(await storedTasks(t, item.id)).toEqual([])
    expect(await blobExists(t, planted.attachment.storage_id)).toBe(false)
    await t.run(async (ctx) => {
      expect(await byId(ctx, 'labels', planted.labelId)).not.toBeNull()
      expect(await byId(ctx, 'issues', to.id)).not.toBeNull()
    })
    // another task keeps its history
    expect(await historyOf(t, to.id)).toHaveLength(2)
    await assertNoDanglingRefs(t, 'after a purge')
    await assertNoOrphanHistory(t, 'after a purge')
  })

  it("keeps a purged task's uuid taken until its history is gone", async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantHistory(t, task, { listed: 2, unlisted: 1 })
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    const history = (await historyOf(t, task.id)).length
    const create = () =>
      as(t, f.user).mutation(api.issues.create, {
        org_id: f.org.id,
        id: task.id,
        project_id: f.sub.id,
        title: 'Squatter',
      })

    TRASH_BUDGET.rows = 1
    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    // up to the first step that deletes a history row
    for (let steps = 0; (await historyOf(t, task.id)).length === history; steps++) {
      expect(await jobFor(t, item.id)).not.toBeNull()
      expect(steps).toBeLessThan(10)
      await step(t, item.id)
    }
    expect(await historyOf(t, task.id)).toHaveLength(history - 1)
    // the stored task row still holds the id, so a new task cannot take it
    // and lose its own rows to the rest of the drain
    expect(await storedIssue(t, task.id)).toBeDefined()
    await expectRefusal(create(), 'bad_request', /^a task with this id already exists$/)

    for (let steps = 0; (await jobFor(t, item.id)) !== null; steps++) {
      expect(steps).toBeLessThan(20)
      await step(t, item.id)
    }
    expect(await itemById(t, item.id)).toBeNull()
    expect(await historyOf(t, task.id)).toEqual([])
    await assertNoOrphanHistory(t, 'after a purge one row at a time')
    // then the id is free
    await create()
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
    const own = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, own, { listed: 2, unlisted: 1 })
    // a task with rows filed under Firmware that moved to Skunkworks since
    const movedOut = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, movedOut, { listed: 1, unlisted: 1 })
    await t.run((ctx) => ctx.db.patch(movedOut._id, { project_id: f.hidden.id }))
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
    // the activity keeps the trashed project's id until the purge: the
    // early task's delete, the item's own task and the task that moved out
    expect(await filedUnder()).toHaveLength(1 + 3 + 2)
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
    // the history of the tasks purged with it goes; the task that moved out
    // keeps its rows without the project
    expect(await historyOf(t, own.id)).toEqual([])
    expect(await historyOf(t, early.id)).toEqual([])
    expect((await historyOf(t, movedOut.id)).map((e) => e.project_id)).toEqual([
      undefined,
      undefined,
    ])
    expect(await filedUnder()).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('deleted_rows').collect())).toHaveLength(1)
    await assertNoDanglingRefs(t, 'after a project purge')
    await assertNoOrphanHistory(t, 'after a project purge')
  })

  it('clears the project from every row filed under it, past 500, over several steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // three tasks with 400 rows each stored without a list, filed under
    // Firmware, that moved to Skunkworks since
    const movedOut: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++) {
      const task = await plantIssue(t, { org_id, project_id: f.sub.id })
      await plantHistory(t, task, { listed: 0, unlisted: 400 })
      await t.run((ctx) => ctx.db.patch(task._id, { project_id: f.hidden.id }))
      movedOut.push(task)
    }
    const elsewhere = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await plantHistory(t, elsewhere, { listed: 2 })
    await deleteProject(t, f, f.sub.id)
    const item = await itemFor(t, f.sub.id)
    expect(item.state).toBe('ready')

    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    let steps = 0
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(20)
    }
    expect(await itemById(t, item.id)).toBeNull()
    const kept = (await Promise.all(movedOut.map((task) => historyOf(t, task.id)))).flat()
    expect(kept).toHaveLength(1200)
    expect(kept.filter((e) => e.project_id !== undefined)).toHaveLength(0)
    // 300 rows a step
    expect(steps).toBeGreaterThanOrEqual(4)
    // a row filed under a project the item does not hold keeps it
    expect((await historyOf(t, elsewhere.id)).map((e) => e.project_id)).toEqual([
      f.sub2.id,
      f.sub2.id,
    ])
    await assertNoDanglingRefs(t, 'after a purge cleared 1,200 rows')
    await assertNoOrphanHistory(t, 'after a purge cleared 1,200 rows')
  })

  it('purges a project item that 20,000 items in other states name, in bounded steps within the real limits', async () => {
    // each names Firmware by project_id and Testbed platform by
    // parent_project_id, so a purge that passed over them read 40,000
    // items in one step, past the 32,000 documents and 16 MiB one
    // transaction may read, and every retry failed
    const t = newT({ transactionLimits: true })
    chargeFilteredReads()
    const f = await withOrg(t)
    const org_id = f.org.id
    const early = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f, early.id)
    const earlyItem = await itemFor(t, early.id)
    await deleteProject(t, f, f.sub2.id)
    const subItem = await itemFor(t, f.sub2.id)
    await plantBusyItems(t, f, 20_000)
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('ready')

    const result = await as(t, f.admin).mutation(api.deletedItems.purge, {
      org_id,
      ids: [item.id],
    })
    expect(result.purged).toEqual([item.id])
    let steps = 0
    while ((await jobFor(t, item.id)) !== null) {
      await step(t, item.id)
      steps++
      expect(steps).toBeLessThan(5)
    }
    await runSteps(t)
    // the items that need it are purged with it, and the others stay
    for (const gone of [item, earlyItem, subItem]) expect(await itemById(t, gone.id)).toBeNull()
    expect(await busyCount(t, f, 'moving')).toBe(6667)
    expect(await busyCount(t, f, 'restoring')).toBe(6667)
    expect(await busyCount(t, f, 'purging')).toBe(6666)
  }, 300_000)

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
    // two due items, one per page: the first page chains the next
    expect(runs.length).toBeGreaterThanOrEqual(1)
  })

  it('purges a stuck project item with the tasks it left in the live tables', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const stranded = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const strandedFile = await attach(t, stranded)
    await comment(t, stranded)
    await plantHistory(t, stranded, { listed: 2, unlisted: 1 })
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: stranded.id })
    await plantHistory(t, child, { listed: 1 })
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
    expect(await historyOf(t, stranded.id)).toEqual([])
    expect((await liveTask(t, child.id))?.parent_id).toBeUndefined()
    // the detached child keeps its own history
    expect(await historyOf(t, child.id)).toHaveLength(1)
    await assertNoDanglingRefs(t, 'after a stuck item was purged')
    await assertNoOrphanHistory(t, 'after a stuck item was purged')
  })

  it('purges a stuck task item with the messages its move left', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let i = 0; i < 5; i++)
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.guest.id, issue_id: task.id })
    TRASH_BUDGET.rows = 1
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    // its job gave up before the move drained the messages
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job?.scheduled_id !== undefined) await ctx.scheduler.cancel(job.scheduled_id)
      if (job !== null) await ctx.db.delete(job._id)
      await ctx.db.patch(item._id, { state: 'stuck' })
    })
    expect(await messagesFor(t, f.guest.id, task.id)).not.toEqual([])

    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', item.id))!))
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await messagesFor(t, f.guest.id, task.id)).toEqual([])
  })

  it('drains the history of a purge that the release before left at purge_rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, task, { listed: 3, unlisted: 2 })
    const other = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, other, { listed: 1 })
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    await t.run(async (ctx) => {
      await startPurge(ctx, item)
      // a job saved by the release before, past purge_live
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job === null) throw new Error('the purge saved no job')
      await ctx.db.patch(job._id, { phase: 'purge_rows' })
    })
    expect(await storedTasks(t, item.id)).toHaveLength(1)

    await step(t, item.id)
    expect(await historyOf(t, task.id)).toEqual([])
    expect(await itemById(t, item.id)).toBeNull()
    expect(await historyOf(t, other.id)).toHaveLength(1)
    await assertNoOrphanHistory(t, 'after a purge resumed at purge_rows')
  })

  it("keeps a new task's history when the release before already freed its id", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, task, { listed: 2 })
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    await t.run(async (ctx) => {
      await startPurge(ctx, item)
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job === null) throw new Error('the purge saved no job')
      await ctx.db.patch(job._id, { phase: 'purge_rows' })
      // the release before deleted the stored task row before its marker
      const stored = await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', task.id))
        .unique()
      if (stored === null) throw new Error('the task was not stored')
      await ctx.db.delete(stored._id)
    })
    // so a client can take the id again, later
    vi.setSystemTime(Date.now() + HOUR)
    await as(t, f.user).mutation(api.issues.create, {
      org_id,
      id: task.id,
      project_id: f.sub.id,
      title: 'Same id, new task',
    })
    const before = await historyOf(t, task.id)
    expect(before.map((e) => e.verb)).toEqual(['updated', 'updated', 'deleted', 'created'])

    while ((await jobFor(t, item.id)) !== null) await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    // the deleted task's rows go, written up to its deletion; the new task's stay
    expect(await historyOf(t, task.id)).toEqual(before.slice(3))
    expect(await liveTask(t, task.id)).not.toBeNull()
  })

  it('keeps the history of a new task with a freed id that sits in Deleted items itself', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, task, { listed: 2 })
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    await t.run(async (ctx) => {
      await startPurge(ctx, item)
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job === null) throw new Error('the purge saved no job')
      await ctx.db.patch(job._id, { phase: 'purge_rows' })
      const stored = await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'issues').eq('row_id', task.id))
        .unique()
      if (stored === null) throw new Error('the task was not stored')
      await ctx.db.delete(stored._id)
    })
    vi.setSystemTime(Date.now() + HOUR)
    await as(t, f.user).mutation(api.issues.create, {
      org_id,
      id: task.id,
      project_id: f.sub.id,
      title: 'Same id, deleted too',
    })
    // the new task goes to Deleted items as an item of its own
    await deleteTask(t, f, task.id)
    const kept = (await historyOf(t, task.id)).slice(3)
    expect(kept.map((e) => e.verb)).toEqual(['created', 'deleted'])

    while ((await jobFor(t, item.id)) !== null) await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await historyOf(t, task.id)).toEqual(kept)
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
    items: await Promise.all([ready.id, draining.id, f.sub2.id].map((id) => itemFor(t, id))),
    draining: draining.id,
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

  it('purgeOrg stops on bytes, so stored rows of about 900 KB go in several calls within the real limits', async () => {
    vi.stubEnv('QIVO_ENVIRONMENT', 'staging')
    vi.stubEnv('SITE_URL', 'https://preview.qivo.io')
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // 24 comments of about 900 KB, over 20 MiB together: a batch of 256
    // rows would read them all
    const body = 'Field note. '.repeat(75_000)
    for (let i = 0; i < 24; i++) await comment(t, task, body)
    await deleteTask(t, f, task.id)
    await runSteps(t)
    // every comment is stored, none dropped as too large (reading them back
    // here would pass the read limit too)
    const item = await itemFor(t, task.id)
    expect(item.state).toBe('ready')
    expect(item.dropped_rows).toBeUndefined()

    let calls = 0
    for (;;) {
      calls++
      expect(calls).toBeLessThan(20)
      const { done } = await t.mutation(internal.deletedItems.purgeOrg, { org_id: f.org.id })
      if (done) break
    }
    expect(calls).toBeGreaterThan(3)
    expect(await trashOf(t, f.org.id)).toEqual({ items: [], rows: [], tasks: [] })
  }, 60_000)

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

/* ------------------------------------------- an organization's deletion */

/** Starts `f`'s organization's read-only period as an admin's request does
 * (orgRemovals.ts), after an export, so no deletion email is queued.
 * Returns the deletion date. */
async function requestDeletion(t: T, f: OrgFixture): Promise<number> {
  await as(t, f.admin).mutation(api.orgRemovals.recordExport, { org_id: f.org.id })
  const { delete_after } = await as(t, f.admin).action(api.orgRemovals.request, {
    org_id: f.org.id,
    confirm: f.org.slug,
  })
  return Date.parse(delete_after)
}

const removalOf = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_removals')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique(),
  )

describe("an organization's deletion", () => {
  it('empties Deleted items in bounded steps, with no Deleted items step running, and keeps bytes another row names', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { files, elsewhere, items, draining } = await trashInFlight(t, f)
    const [readyFile, ...trashOnly] = files
    // a live attachment in the other organization names the ready item's
    // stored bytes, which the fence must keep
    const keeper = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await t.run((ctx) =>
      ctx.db.insert('issue_attachments', {
        org_id: f.otherOrg.id,
        id: uuid(),
        issue_id: keeper.id,
        name: 'shared.txt',
        size_bytes: 5,
        storage_id: readyFile,
        inline: false,
        created_at: NOW,
      }),
    )
    vi.setSystemTime((await requestDeletion(t, f)) + 60_000)
    await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
    expect((await removalOf(t, f.org.id))?.phase).toBe('profiles')

    // the steps of the items still moving stand still once deletion begins
    const inFlight = () =>
      t.run(async (ctx) => ({
        jobs: await ctx.db.query('deleted_item_jobs').collect(),
        rows: (await ctx.db.query('deleted_rows').collect()).filter((r) => r.org_id === f.org.id),
        stranded: await ctx.db
          .query('issues')
          .withIndex('by_project', (q) => q.eq('project_id', f.sub2.id))
          .collect(),
      }))
    const before = await inFlight()
    expect(before.jobs.length).toBeGreaterThan(0)
    for (const item of items) await step(t, item.id)
    expect(await inFlight()).toEqual(before)
    expect(await liveRowsOf(t, draining)).toBeGreaterThan(0)

    // one row per step, so the trash phase takes many
    Object.assign(REMOVAL_BUDGET, { rows: 256, bytes: 1 })
    const phases: OrgRemovalPhase[] = []
    for (;;) {
      const removal = await removalOf(t, f.org.id)
      if (removal === null) break
      if (removal.phase === undefined) throw new Error('the deletion lost its phase')
      phases.push(removal.phase)
      expect(phases.length).toBeLessThan(2000)
      await t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
    }
    expect(phases.filter((phase) => phase === 'trash').length).toBeGreaterThan(5)
    const order = phases.map((phase) => ORG_REMOVAL_PHASES.indexOf(phase))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(phases[0]).toBe('profiles')
    // the Deleted items steps scheduled before the deletion find nothing
    await runSteps(t)

    expect(await trashOf(t, f.org.id)).toEqual({ items: [], rows: [], tasks: [] })
    for (const table of ['deleted_item_jobs', 'deleted_item_parents'] as const)
      expect(await t.run((ctx) => ctx.db.query(table).collect()), table).toEqual([])
    expect(await liveRowsOf(t, draining)).toBe(0)
    for (const file of trashOnly) expect(await blobExists(t, file)).toBe(false)
    expect(await blobExists(t, readyFile)).toBe(true)
    expect(await t.run((ctx) => byId(ctx, 'organizations', f.org.id))).toBeNull()
    expect(await itemById(t, elsewhere.item.id)).toEqual(elsewhere.item)
    expect(await blobExists(t, elsewhere.file)).toBe(true)
    await assertNoDanglingRefs(t, "after an organization's deletion with Deleted items")
  })

  it('leaves the items and jobs of an organization being deleted to the deletion, and expires the others', async () => {
    const t = newT()
    const f = await withOrg(t)
    const due = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f, due.id)
    const dueItem = await itemFor(t, due.id)
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    const moving = await itemFor(t, f.sub2.id)
    // its step failed, so the job waits for recovery
    const stalled = (await jobFor(t, moving.id))!
    await t.run((ctx) => ctx.scheduler.cancel(stalled.scheduled_id!))
    // another organization's item, due an hour later
    vi.setSystemTime(START + HOUR)
    const other = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await as(t, f.otherAdmin).mutation(api.issues.deleteDeep, {
      org_id: f.otherOrg.id,
      id: other.id,
    })
    const otherItem = await itemFor(t, other.id)
    // the deletion has begun; its own steps are not part of this test
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: new Date(START).toISOString(),
        delete_after: new Date(START + HOUR).toISOString(),
        phase: 'profiles',
        progress_at: new Date(START + HOUR).toISOString(),
        created_at: new Date(START).toISOString(),
      }),
    )

    vi.setSystemTime(START + TRASH_DAYS * DAY + 2 * HOUR)
    await t.mutation(internal.deletedItems.recover, {})
    expect(await jobFor(t, moving.id)).toEqual(stalled)
    // one item per page: the first page holds only the deleting
    // organization's item, and the run goes on past it
    EXPIRY.batch = 1
    await t.mutation(internal.deletedItems.expire, {})
    await runSteps(t)
    expect(await itemById(t, dueItem.id)).toEqual(dueItem)
    expect(await jobFor(t, dueItem.id)).toBeNull()
    expect(await itemById(t, moving.id)).toEqual(moving)
    expect(await jobFor(t, moving.id)).toEqual(stalled)
    expect(await itemById(t, otherItem.id)).toBeNull()
    expect(await storedRows(t, otherItem.id)).toEqual([])
  })

  it('keeps moving and expiring items while the organization is read-only before its deletion, and refuses restores then', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const file = await attach(t, task)
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    const moving = await itemFor(t, f.sub2.id)
    // its step failed, so the job waits for recovery
    const stalled = (await jobFor(t, moving.id))!
    await t.run((ctx) => ctx.scheduler.cancel(stalled.scheduled_id!))
    vi.setSystemTime(START + DAY)
    await requestDeletion(t, f)
    const rowOf = async (who: Doc<'profiles'>) =>
      (await as(t, who).query(api.deletedItems.list, {})).items.find((row) => row.id === item.id)

    expect(await rowOf(f.user)).toMatchObject({
      can_restore: false,
      blocked: { reason: 'read_only' },
    })
    expect((await rowOf(f.admin))?.can_purge).toBe(false)
    await expectRefusal(
      as(t, f.user).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: [item.id] }),
      'forbidden',
      /will be deleted/,
    )
    await expectRefusal(
      as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [item.id] }),
      'forbidden',
      /will be deleted/,
    )

    // recovery restarts the stalled move, which finishes
    vi.setSystemTime(START + DAY + STALLED_MS + 1)
    await t.mutation(internal.deletedItems.recover, {})
    expect((await jobFor(t, moving.id))?.attempts).toBe(1)
    await runSteps(t)
    expect((await itemById(t, moving.id))?.state).toBe('ready')

    vi.setSystemTime(START + TRASH_DAYS * DAY)
    await t.mutation(internal.deletedItems.expire, {})
    await runSteps(t)
    for (const id of [item.id, moving.id]) {
      expect(await itemById(t, id)).toBeNull()
      expect(await storedRows(t, id)).toEqual([])
    }
    expect(await blobExists(t, file.storage_id)).toBe(false)
    // the organization is still read-only, waiting for its deletion date
    expect((await removalOf(t, f.org.id))?.phase).toBeUndefined()
    expect(await t.run((ctx) => byId(ctx, 'organizations', f.org.id))).not.toBeNull()
  })
})
