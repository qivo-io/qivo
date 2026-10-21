/* Deleted items: restoring (model/deletedItems.ts restoreItems, design 5).
 *
 * A restore writes the stored rows back while what they name is still
 * absent, then reveals the item in one transaction. These tests restore
 * through the model entry the public restore calls (deletedItemsList.test.ts
 * covers its visibility fence), read both the live tables and the trash,
 * and drive the steps one at a time on fake timers, with lowered budgets so
 * that many-step paths run on small data. */
/// <reference types="vite/client" />

import { describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { EventOwner } from '../lib/taskEvents'
import {
  PARENT_FULL,
  PARENT_IS_SUBTASK,
  SUBTASK_MAX,
  SUBTASK_WITH_SUBTASKS,
} from '../lib/taskLimits'
import { storageUsage } from '../model/billing'
import { deleteOrgDeep } from '../model/cascade'
import {
  COUNT_READ,
  type RestoreResult,
  restoreItems,
  SIGHT_READ,
  STALLED_MS,
  startPurge,
  TRASH_BUDGET,
} from '../model/deletedItems'
import { HOLDER_SIGHT_RULE, SUBTASK_PROJECT_RULE } from '../model/issues'
import {
  activityFor,
  as,
  chargeFilteredReads,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  plantSubscription,
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
  HOUR,
  historyOf,
  installTrashTimers,
  itemById,
  itemFor,
  jobFor,
  liveTask,
  plantHistory,
  plantRows,
  runSteps,
  START,
  step,
  storedIssue,
  storedRows,
  storedTasks,
  type Tagged,
} from './trash.setup'

installTrashTimers()

const iso = (ms: number) => new Date(ms).toISOString()
const LATER = iso(START + DAY)

/** Restores the items `ids` for `who`, as deletedItems.restore does after
 * its visibility fence. */
const restore = (t: T, who: Doc<'profiles'>, ids: string[]): Promise<RestoreResult> =>
  t.run(async (ctx) => {
    const me = await byId(ctx, 'profiles', who.id)
    if (me === null) throw new Error('the restorer is gone')
    const items: Doc<'deleted_items'>[] = []
    for (const id of ids) {
      const item = await byId(ctx, 'deleted_items', id)
      if (item !== null) items.push(item)
    }
    return await restoreItems(ctx, { me, items, now: new Date().toISOString() })
  })

const liveProject = (t: T, id: string) => t.run((ctx) => byId(ctx, 'projects', id))
/** Every task that waits for its parent after a project item's reveal. */
const waitingParents = (t: T) => t.run((ctx) => ctx.db.query('deleted_item_parents').collect())
const patch = (t: T, table: 'issues' | 'projects' | 'profiles', id: string, fields: object) =>
  t.run(async (ctx) => {
    const row = await byId(ctx, table, id)
    if (row === null) throw new Error(`no ${table} row ${id}`)
    await ctx.db.patch(row._id, fields)
  })

/** Steps `item` until its job is gone, checking `between` after each. */
async function stepThrough(t: T, itemId: string, between = async () => {}): Promise<number> {
  let steps = 0
  while ((await jobFor(t, itemId)) !== null) {
    await step(t, itemId)
    steps++
    await between()
    expect(steps).toBeLessThan(200)
  }
  return steps
}

/** `n` people with the user role who edit every project of Testbed
 * platform through a grant on it, each a member of each of `teams`. */
const plantPeople = (t: T, f: OrgFixture, n: number, teams: string[] = []) =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const id = uuid()
      await ctx.db.insert('profiles', {
        id,
        org_id: f.org.id,
        email: `person${i}@testbed.test`,
        name: `Person ${i}`,
        initials: 'PE',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        created_at: NOW,
      })
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: id,
        level: 'user',
      })
      for (const team_id of teams)
        await ctx.db.insert('team_members', { team_id, profile_id: id, is_leader: false })
      ids.push(id)
    }
    return ids
  })

/** `n` teams of the organization that share no project. */
const plantTeams = (t: T, f: OrgFixture, n: number) =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const id = uuid()
      await ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name: `Team ${i}`,
        track_delay_default: false,
        created_at: NOW,
      })
      ids.push(id)
    }
    return ids
  })

/** `n` top-level tasks, each in a sub-project of its own under Testbed
 * platform. */
async function oneInEach(t: T, f: OrgFixture, n: number): Promise<Doc<'issues'>[]> {
  const tasks: Doc<'issues'>[] = []
  for (let i = 0; i < n; i++) {
    const project = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
    })
    tasks.push(await plantIssue(t, { org_id: f.org.id, project_id: project.id }))
  }
  return tasks
}

let subtaskNum = 70_000
/** `n` subtasks of Firmware under `parentId` in one transaction, the first
 * `archived` of them archived. */
const plantSubtasks = (t: T, f: OrgFixture, parentId: string, n: number, archived = 0) =>
  t.run(async (ctx) => {
    for (let i = 0; i < n; i++)
      await ctx.db.insert('issues', {
        id: uuid(),
        org_id: f.org.id,
        num: subtaskNum++,
        project_id: f.sub.id,
        parent_id: parentId,
        title: 'Planted subtask',
        description: '',
        status: 'todo',
        priority: 'medium',
        paused: false,
        ...(i < archived ? { archived_at: NOW } : {}),
        created_at: NOW,
        updated_at: NOW,
      })
  })

let assignedNum = 60_000
/** One subtask of Board rev under `parentId` for each of `people`, assigned
 * to them and reviewed by the one at the same place in `reviewers`, in one
 * transaction. Answers their ids in the same order. */
const plantAssigned = (
  t: T,
  f: OrgFixture,
  parentId: string,
  people: string[],
  reviewers: string[] = [],
) =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (const [i, assignee_id] of people.entries()) {
      const id = uuid()
      await ctx.db.insert('issues', {
        id,
        org_id: f.org.id,
        num: assignedNum++,
        project_id: f.sub2.id,
        parent_id: parentId,
        assignee_id,
        reviewer_id: reviewers[i],
        title: 'Planted task',
        description: '',
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
      })
      ids.push(id)
    }
    return ids
  })

/** The live subtasks of `parentId`, as [id, assignee] pairs in id order. */
const assignedUnder = (t: T, parentId: string) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', parentId))
        .collect()
    )
      .map((task): [string, string | undefined] => [task.id, task.assignee_id])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  )

/** How many live subtasks `parentId` has, archived ones included. */
const subtaskCount = (t: T, parentId: string) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('issues')
          .withIndex('by_parent', (q) => q.eq('parent_id', parentId))
          .collect()
      ).length,
  )

/** `ids` paired with `people`, as assignedUnder answers them. */
const pairs = (ids: string[], people: string[]) =>
  ids
    .map((id, i): [string, string | undefined] => [id, people[i]])
    .sort(([a], [b]) => (a < b ? -1 : 1))

/** Every live row that travels with `task`, without system fields, by table. */
const liveRowsOf = (t: T, taskId: string) =>
  t.run(async (ctx) => {
    const strip = <D extends { _id: unknown; _creationTime: number }>({
      _id,
      _creationTime,
      ...doc
    }: D) => doc
    return {
      comments: (
        await ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
          .collect()
      ).map(strip),
      issue_labels: (
        await ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
          .collect()
      ).map(strip),
      issue_subscriptions: (
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', taskId))
          .collect()
      ).map(strip),
      issue_attachments: (
        await ctx.db
          .query('issue_attachments')
          .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
          .collect()
      ).map(strip),
      issue_links: [
        ...(await ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) => q.eq('source_id', taskId))
          .collect()),
        ...(await ctx.db
          .query('issue_links')
          .withIndex('by_target', (q) => q.eq('target_id', taskId))
          .collect()),
      ].map(strip),
    }
  })

/** `planted` grouped as liveRowsOf groups the live rows. */
function byTable(planted: Tagged[]) {
  const grouped: Record<string, unknown[]> = {
    comments: [],
    issue_labels: [],
    issue_subscriptions: [],
    issue_attachments: [],
    issue_links: [],
  }
  for (const { table, doc } of planted) {
    const { _id, _creationTime, ...rest } = doc as Tagged['doc'] & Record<string, unknown>
    grouped[table].push(rest)
  }
  return grouped
}

describe('restoring a task item', () => {
  it('brings the task back with every row, the same uuids and number, and its bytes', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      title: 'Battery level',
      assignee_id: f.guest.id,
      reporter_id: f.admin.id,
      created_by: f.admin.id,
    })
    const to = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const from = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const planted = await plantRows(t, f, task, { to, from })
    await deleteTask(t, f, task.id)
    const item = await itemFor(t, task.id)
    expect(await liveTask(t, task.id)).toBeNull()

    vi.setSystemTime(START + HOUR)
    expect(await restore(t, f.user, [item.id])).toEqual({
      restored: [item.id],
      refused: [],
      deferred: [],
    })

    const { _id, _creationTime, ...same } = task
    expect(await liveTask(t, task.id)).toMatchObject({ ...same, updated_at: iso(START + HOUR) })
    expect(await liveRowsOf(t, task.id)).toEqual(byTable(planted.rows))
    expect(await blobExists(t, planted.attachment.storage_id)).toBe(true)
    // nothing of the item is left
    expect(await itemById(t, item.id)).toBeNull()
    expect(await jobFor(t, item.id)).toBeNull()
    expect(await storedRows(t, item.id)).toEqual([])
    expect(await storedTasks(t, item.id)).toEqual([])
    const activity = await activityFor(t, org_id)
    expect(activity.map((e) => [e.verb, e.target_id, e.detail, e.project_id])).toEqual([
      ['deleted', task.id, undefined, f.sub.id],
      ['restored', task.id, 'from Deleted items', f.sub.id],
    ])
    await assertNoDanglingRefs(t, 'after a task came back from Deleted items')
  })

  it('keeps or clears each parent by the parent table', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const plant = (extra: Partial<Doc<'issues'>> = {}) =>
      plantIssue(t, { org_id, project_id: f.sub.id, ...extra })
    const restoreTask = async (id: string) => {
      const item = await itemFor(t, id)
      expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
      return (await liveTask(t, id))?.parent_id
    }
    // in the same item: kept
    const root = await plant()
    const chosen = await plant({ parent_id: root.id })
    await deleteTask(t, f, root.id, { subtask_ids: [chosen.id] })
    await restoreTask(root.id)
    expect((await liveTask(t, chosen.id))?.parent_id).toBe(root.id)
    // live and archived, the task archived too: kept
    const archivedParent = await plant({ archived_at: NOW })
    const archivedChild = await plant({ archived_at: NOW, parent_id: archivedParent.id })
    await deleteTask(t, f, archivedChild.id)
    expect(await restoreTask(archivedChild.id)).toBe(archivedParent.id)
    // live and archived with hours of its own, the task archived: kept, and
    // the parent, a group again, loses its hours
    const archivedLeaf = await plant({ archived_at: NOW })
    const archivedSub = await plant({ archived_at: NOW, parent_id: archivedLeaf.id })
    await deleteTask(t, f, archivedSub.id)
    await patch(t, 'issues', archivedLeaf.id, { remaining_hours: 3, remaining_set_at: NOW })
    expect(await restoreTask(archivedSub.id)).toBe(archivedLeaf.id)
    expect((await liveTask(t, archivedLeaf.id))?.remaining_hours).toBeUndefined()
    // live and archived, the task active: cleared
    const laterArchived = await plant()
    const activeChild = await plant({ parent_id: laterArchived.id })
    await deleteTask(t, f, activeChild.id)
    await patch(t, 'issues', laterArchived.id, { archived_at: NOW })
    expect(await restoreTask(activeChild.id)).toBeUndefined()
    // in Deleted items elsewhere: cleared
    const trashedParent = await plant()
    const orphan = await plant({ parent_id: trashedParent.id })
    await deleteTask(t, f, orphan.id)
    await deleteTask(t, f, trashedParent.id)
    expect(await restoreTask(orphan.id)).toBeUndefined()
    // gone for good: cleared
    const purgedParent = await plant()
    const survivor = await plant({ parent_id: purgedParent.id })
    await deleteTask(t, f, survivor.id)
    await deleteTask(t, f, purgedParent.id)
    const purged = await itemFor(t, purgedParent.id)
    await t.run(async (ctx) => startPurge(ctx, purged, { inline: true }))
    expect(await itemById(t, purged.id)).toBeNull()
    expect(await restoreTask(survivor.id)).toBeUndefined()
    await assertNoDanglingRefs(t, 'after the parent table')
  })

  it('brings a subtask deleted alone back under its live parent, which loses its own hours', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await plantSubscription(t, { issue_id: parent.id, profile_id: f.admin.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, child.id)
    // without its only subtask the parent holds hours of its own
    await patch(t, 'issues', parent.id, { remaining_hours: 6, remaining_set_at: NOW })
    await restore(t, f.user, [(await itemFor(t, child.id)).id])
    expect((await liveTask(t, child.id))?.parent_id).toBe(parent.id)
    const after = await liveTask(t, parent.id)
    expect(after?.remaining_hours).toBeUndefined()
    expect(after?.remaining_set_at).toBeUndefined()
    expect(
      (await messagesFor(t, f.admin.id, parent.id)).map((m) => [m.detail, m.actor_id]),
    ).toEqual([['Remaining cleared (was 6 h)', f.user.id]])
  })

  it('brings an archived sub-project back under a live parent, which keeps its own hours', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: parent.id })
    await as(t, f.user).mutation(api.projects.archive, { org_id, id: f.sub2.id })
    // a subtask in an archived sub-project makes it no group, so it holds hours of its own
    await patch(t, 'issues', parent.id, { remaining_hours: 6, remaining_set_at: NOW })
    await deleteProject(t, f, f.sub2.id)
    await restore(t, f.user, [(await itemFor(t, f.sub2.id)).id])
    await runSteps(t)
    expect((await liveProject(t, f.sub2.id))?.archived_at).toBeDefined()
    expect((await liveTask(t, child.id))?.parent_id).toBe(parent.id)
    expect((await liveTask(t, parent.id))?.remaining_hours).toBe(6)
  })

  it('brings a subtask back top-level when the restorer cannot edit its parent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // the guest edits Firmware through a grant of its own, and cannot see
    // the sibling sub-project where the parent is
    const hiddenSub = await plantHiddenSibling(t, f, f.guest)
    const parent = await plantIssue(t, { org_id, project_id: hiddenSub.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, child.id)
    await patch(t, 'issues', parent.id, { remaining_hours: 6, remaining_set_at: NOW })
    const item = await itemFor(t, child.id)
    expect((await restore(t, f.guest, [item.id])).restored).toEqual([item.id])
    expect(await liveTask(t, child.id)).not.toBeNull()
    expect((await liveTask(t, child.id))?.parent_id).toBeUndefined()
    // the restore changed nothing in the project the guest cannot edit
    expect((await liveTask(t, parent.id))?.remaining_hours).toBe(6)

    // an archived parent there that holds hours of its own would lose them
    // to an archived child, so it is cleared too
    const shelved = await plantIssue(t, {
      org_id,
      project_id: hiddenSub.id,
      archived_at: NOW,
      remaining_hours: 2,
      remaining_set_at: NOW,
    })
    const shelvedChild = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      archived_at: NOW,
      parent_id: shelved.id,
    })
    await deleteTask(t, f, shelvedChild.id)
    await restore(t, f.guest, [(await itemFor(t, shelvedChild.id)).id])
    expect((await liveTask(t, shelvedChild.id))?.parent_id).toBeUndefined()
    expect((await liveTask(t, shelved.id))?.remaining_hours).toBe(2)
  })

  it('brings a subtask deleted alone back top-level when its parent moved to another top-level project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, child.id)
    // without its only subtask the parent moves alone, to a sub-project of
    // Skunkworks, which the user leads, and holds hours of its own there
    const elsewhere = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    await as(t, f.user).mutation(api.issues.move, {
      org_id,
      id: parent.id,
      project_id: elsewhere.id,
    })
    await patch(t, 'issues', parent.id, { remaining_hours: 6, remaining_set_at: NOW })

    const item = await itemFor(t, child.id)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    const back = await liveTask(t, child.id)
    expect(back?.project_id).toBe(f.sub.id)
    expect(back?.parent_id).toBeUndefined()
    // the parent did not become a group
    expect((await liveTask(t, parent.id))?.remaining_hours).toBe(6)
    // a reparent refuses that parent for the same reason
    const refused = await expectRefusal(
      as(t, f.user).mutation(api.issues.update, {
        org_id,
        id: child.id,
        patch: { parent_id: parent.id },
      }),
      'rule',
    )
    expect(refused.data.message).toBe(SUBTASK_PROJECT_RULE)
    await assertNoDanglingRefs(t, 'after a subtask came back without a parent elsewhere')
  })

  it('keeps a parent that moved to another sub-project of the same top-level project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, child.id)
    await as(t, f.user).mutation(api.issues.move, { org_id, id: parent.id, project_id: f.sub2.id })

    const item = await itemFor(t, child.id)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    const back = await liveTask(t, child.id)
    expect(back?.project_id).toBe(f.sub.id)
    expect(back?.parent_id).toBe(parent.id)
  })

  it('keeps a parent only while it is a top-level task, as a reparent requires', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const task = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    // a top-level parent: the task comes back under it
    await deleteTask(t, f, task.id)
    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    expect((await liveTask(t, task.id))?.parent_id).toBe(parent.id)
    // the parent became a subtask while the task was in Deleted items, a
    // legacy chain planted as data from before the one level of subtasks,
    // so the task comes back top-level and the chain stays as it is
    await deleteTask(t, f, task.id)
    const top = await plantIssue(t, { org_id, project_id: f.sub.id })
    await patch(t, 'issues', parent.id, { parent_id: top.id })
    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    expect((await liveTask(t, task.id))?.parent_id).toBeUndefined()
    expect((await liveTask(t, parent.id))?.parent_id).toBe(top.id)
    // a reparent refuses that parent for the same reason
    const refused = await expectRefusal(
      as(t, f.user).mutation(api.issues.update, {
        org_id,
        id: task.id,
        patch: { parent_id: parent.id },
      }),
      'rule',
    )
    expect(refused.data.message).toBe(PARENT_IS_SUBTASK)
  })

  it(`keeps a parent with ${SUBTASK_MAX - 1} active subtasks and none with ${SUBTASK_MAX}, archived ones aside`, async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const [first, second] = [
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id }),
    ]
    for (const task of [first, second]) await deleteTask(t, f, task.id)
    // the parent gets 99 active subtasks while they are in Deleted items,
    // and 10 archived ones, which do not count
    await plantSubtasks(t, f, parent.id, SUBTASK_MAX - 1 + 10, 10)
    // the first comes back as the hundredth active one
    await restore(t, f.user, [(await itemFor(t, first.id)).id])
    expect((await liveTask(t, first.id))?.parent_id).toBe(parent.id)
    // the second finds the parent full and comes back top-level
    await restore(t, f.user, [(await itemFor(t, second.id)).id])
    expect((await liveTask(t, second.id))?.parent_id).toBeUndefined()
    const refused = await expectRefusal(
      as(t, f.user).mutation(api.issues.update, {
        org_id,
        id: second.id,
        patch: { parent_id: parent.id },
      }),
      'rule',
    )
    expect(refused.data.message).toBe(PARENT_FULL)

    // two items restored in one call count the reveal before them: only one
    // of them becomes the hundredth active subtask of a parent with 99
    const other = await plantIssue(t, { org_id, project_id: f.sub.id })
    const pair = [
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: other.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: other.id }),
    ]
    for (const task of pair) await deleteTask(t, f, task.id)
    await plantSubtasks(t, f, other.id, SUBTASK_MAX - 1 + 5, 5)
    const items = [await itemFor(t, pair[0].id), await itemFor(t, pair[1].id)]
    expect(
      (
        await restore(
          t,
          f.user,
          items.map((item) => item.id),
        )
      ).restored,
    ).toHaveLength(2)
    const parents = await Promise.all(
      pair.map(async (task) => (await liveTask(t, task.id))?.parent_id),
    )
    expect(parents.toSorted()).toEqual([other.id, undefined])
  })

  it('reads no more for a count of subtasks than COUNT_READ allows, and leaves that task without the parent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const task = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, task.id)
    // three subtasks of about 6 KB each, past a count bound of 10 KB
    for (let i = 0; i < 3; i++)
      await plantIssue(t, {
        org_id,
        project_id: f.sub.id,
        parent_id: parent.id,
        description: 'x'.repeat(6000),
      })
    COUNT_READ.bytes = 10_000
    const item = await itemFor(t, task.id)
    await restore(t, f.user, [item.id])
    expect((await liveTask(t, task.id))?.parent_id).toBeUndefined()
    expect(warn.mock.calls).toEqual([
      [
        'A deleted item restore cannot count the subtasks of a parent',
        { item_id: item.id, parent_id: parent.id },
      ],
    ])
  })

  it('keeps a parent only while its assignee can still see it, as a reparent requires', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // the guest edits Board rev through a grant of its own, and sees the
    // parent's sibling sub-project through another
    const hiddenSub = await plantHiddenSibling(t, f, f.guest)
    const grant = await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: hiddenSub.id,
        profile_id: f.guest.id,
        level: 'user',
      }),
    )
    const parent = await plantIssue(t, { org_id, project_id: hiddenSub.id })
    const child = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: parent.id,
      assignee_id: f.guest.id,
    })
    const deleteAndRestore = async () => {
      await deleteTask(t, f, child.id)
      const item = await itemFor(t, child.id)
      expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
      return await liveTask(t, child.id)
    }
    // the guest sees the whole chain, so the parent stays
    expect(await deleteAndRestore()).toMatchObject({
      parent_id: parent.id,
      assignee_id: f.guest.id,
    })

    // the guest loses the sibling and keeps Board rev, so the task comes
    // back without the parent and keeps its assignee
    await t.run((ctx) => ctx.db.delete(grant))
    const back = await deleteAndRestore()
    expect(back?.parent_id).toBeUndefined()
    expect(back?.assignee_id).toBe(f.guest.id)
    // an edit refuses that parent for the same reason
    const refused = await expectRefusal(
      as(t, f.user).mutation(api.issues.update, {
        org_id,
        id: child.id,
        patch: { parent_id: parent.id },
      }),
      'rule',
    )
    expect(refused.data.message).toBe(HOLDER_SIGHT_RULE)
  })

  it('keeps no parent that someone working on a subtask that comes back with it cannot see', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const hiddenSub = await plantHiddenSibling(t, f, f.guest)
    const parent = await plantIssue(t, { org_id, project_id: hiddenSub.id })
    // the admin, who sees every project, works on the task; the guest, who
    // cannot see the parent's sub-project, works on its subtask
    const task = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: parent.id,
      assignee_id: f.admin.id,
    })
    const subtask = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: task.id,
      assignee_id: f.guest.id,
    })
    await deleteTask(t, f, task.id, { subtask_ids: [subtask.id] })
    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    expect((await liveTask(t, task.id))?.parent_id).toBeUndefined()
    expect(await liveTask(t, subtask.id)).toMatchObject({
      parent_id: task.id,
      assignee_id: f.guest.id,
    })
  })

  it(`brings a task back with its ${SUBTASK_MAX} subtasks and their people, within the real limits`, async () => {
    // the most active subtasks a task can have, each with a person of its
    // own whose sight the reveal checks
    const t = newT({ transactionLimits: true })
    chargeFilteredReads()
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    const root = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const people = await plantPeople(t, f, SUBTASK_MAX)
    const subtasks = await plantAssigned(t, f, root.id, people)
    await deleteTask(t, f, root.id, { subtask_ids: subtasks })
    await runSteps(t)
    const item = await itemFor(t, root.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: SUBTASK_MAX + 1 } })

    const result = await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id,
      ids: [item.id],
    })
    expect(result.restored).toEqual([item.id])
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect((await liveTask(t, root.id))?.parent_id).toBeUndefined()
    expect(await assignedUnder(t, root.id)).toEqual(pairs(subtasks, people))
    // a task with subtasks takes no parent
    const refused = await expectRefusal(
      as(t, f.user).mutation(api.issues.update, {
        org_id,
        id: root.id,
        patch: { parent_id: epic.id },
      }),
      'rule',
    )
    expect(refused.data.message).toBe(SUBTASK_WITH_SUBTASKS)
  }, 300_000)

  it('reveals in a step of its own when checking who sees its parent runs out of what the restore call has left', async () => {
    // the assignee and the reviewer are each in 60 teams, so reading what
    // they see costs more than the reveal's estimate for one task
    // (REVEAL_RANGES_PER_TASK), about 120 ranges each
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    const [assignee, reviewer] = await plantPeople(t, f, 2, await plantTeams(t, f, 60))
    const plantRoot = async () => {
      const root = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: epic.id })
      // restoring the comment moves a row before the reveal, so the call
      // asks whether the reveal fits in what it has left (revealFits)
      await comment(t, root)
      return root
    }
    const alone = await plantRoot()
    const root = await plantRoot()
    await patch(t, 'issues', root.id, { assignee_id: assignee, reviewer_id: reviewer })
    for (const task of [alone, root]) await deleteTask(t, f, task.id)
    // what the call has left after the fill holds the reveal's estimate for
    // one task, 20 ranges, and not the check of both people
    TRASH_BUDGET.ranges = 100

    // without people to check, the reveal fits in the call
    const aloneItem = await itemFor(t, alone.id)
    expect((await restore(t, f.user, [aloneItem.id])).restored).toEqual([aloneItem.id])
    expect(await itemById(t, aloneItem.id)).toBeNull()
    expect((await liveTask(t, alone.id))?.parent_id).toBe(epic.id)

    const item = await itemFor(t, root.id)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_reveal' })
    expect(await liveTask(t, root.id)).toBeNull()
    await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await liveTask(t, root.id)).toMatchObject({
      parent_id: epic.id,
      assignee_id: assignee,
      reviewer_id: reviewer,
    })
  })

  it('drops references whose uuid now names something created after the delete', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const person = await t.run(async (ctx) => {
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
        project_id: f.meta.id,
        profile_id: profile.id,
        level: 'user',
      })
      return profile
    })
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const task = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      parent_id: parent.id,
      assignee_id: person.id,
      reviewer_id: f.guest.id,
    })
    const labelId = uuid()
    const note = await t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id: labelId,
        org_id,
        name: 'Field',
        name_lower: 'field',
        color: '#ffcc00',
        created_at: NOW,
      })
      await ctx.db.insert('issue_labels', { org_id, issue_id: task.id, label_id: labelId })
      await ctx.db.insert('issue_subscriptions', {
        issue_id: task.id,
        profile_id: person.id,
        created_at: NOW,
      })
      const _id = await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        author: person.id,
        body: 'On it',
        created_at: NOW,
      })
      return (await ctx.db.get(_id)) as Doc<'comments'>
    })
    await deleteTask(t, f, task.id)
    // the parent, the label and the person are deleted for good, and new
    // rows reuse their uuids
    await t.run(async (ctx) => {
      for (const [table, id] of [
        ['issues', parent.id],
        ['labels', labelId],
        ['profiles', person.id],
      ] as const) {
        const row = await byId(ctx, table, id)
        if (row !== null) await ctx.db.delete(row._id)
      }
      const { _id: _parentRow, _creationTime: _parentTime, ...parentRow } = parent
      await ctx.db.insert('issues', { ...parentRow, created_at: LATER })
      await ctx.db.insert('labels', {
        id: labelId,
        org_id,
        name: 'Other',
        name_lower: 'other',
        color: '#00ccff',
        created_at: LATER,
      })
      const { _id: _personRow, _creationTime: _personTime, ...personRow } = person
      await ctx.db.insert('profiles', { ...personRow, created_at: LATER })
    })
    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    const back = await liveTask(t, task.id)
    expect(back?.parent_id).toBeUndefined()
    expect(back?.assignee_id).toBeUndefined()
    // a reviewer who is still the same person stays
    expect(back?.reviewer_id).toBe(f.guest.id)
    const rows = await liveRowsOf(t, task.id)
    expect(rows.issue_labels).toEqual([])
    expect(rows.issue_subscriptions).toEqual([])
    expect(rows.comments).toEqual([
      { id: note.id, issue_id: task.id, body: 'On it', created_at: NOW },
    ])

    // a project whose uuid now names a newer project blocks the restore
    const short = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const inside = await plantIssue(t, { org_id, project_id: short.id })
    await deleteTask(t, f, inside.id)
    await t.run(async (ctx) => {
      await ctx.db.delete(short._id)
      const { _id, _creationTime, ...row } = short
      await ctx.db.insert('projects', { ...row, created_at: LATER })
    })
    const item = await itemFor(t, inside.id)
    expect(await restore(t, f.user, [item.id])).toEqual({
      restored: [],
      refused: [{ id: item.id, reason: 'project_deleted' }],
      deferred: [],
    })
    expect((await itemById(t, item.id))?.state).toBe('ready')
  })

  it('restores a task linked to 30 legacy tasks of 950 KiB in steps, within the real limits', async () => {
    const t = newT({ transactionLimits: true })
    chargeFilteredReads()
    const f = await withOrg(t)
    const org_id = f.org.id
    // descriptions from before the 20,000-character cap
    const description = 'Old notes. '.repeat(90_000).slice(0, 950 * 1024)
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    const ends: string[] = []
    for (let i = 0; i < 30; i++)
      ends.push((await plantIssue(t, { org_id, project_id: f.sub.id, description })).id)
    await t.run(async (ctx) => {
      for (const end of ends)
        await ctx.db.insert('issue_links', {
          org_id,
          id: uuid(),
          source_id: task.id,
          target_id: end,
          type: 'blocks',
          pair_key: [task.id, end].sort().join(':'),
          created_at: NOW,
        })
    })
    await deleteTask(t, f, task.id)

    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    await runSteps(t)
    expect(await liveTask(t, task.id)).not.toBeNull()
    expect((await liveRowsOf(t, task.id)).issue_links).toHaveLength(30)
  }, 120_000)

  it('moves a link to the item that holds its other end, and drops one whose end is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const [a, b, c] = [
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
    ]
    const link = (source: Doc<'issues'>, target: Doc<'issues'>) =>
      t.run(async (ctx) => {
        const _id = await ctx.db.insert('issue_links', {
          org_id,
          id: uuid(),
          source_id: source.id,
          target_id: target.id,
          type: 'blocks',
          pair_key: [source.id, target.id].sort().join(':'),
          created_at: NOW,
        })
        return (await ctx.db.get(_id)) as Doc<'issue_links'>
      })
    const toB = await link(a, b)
    const toC = await link(a, c)
    await deleteTask(t, f, a.id)
    await deleteTask(t, f, b.id)
    await deleteTask(t, f, c.id)
    const cItem = await itemFor(t, c.id)
    await t.run(async (ctx) => startPurge(ctx, cItem, { inline: true }))
    const bItem = await itemFor(t, b.id)

    await restore(t, f.user, [(await itemFor(t, a.id)).id])
    expect(await liveTask(t, a.id)).not.toBeNull()
    const storedLink = (id: string) =>
      t.run((ctx) =>
        ctx.db
          .query('deleted_rows')
          .withIndex('by_row', (q) => q.eq('table', 'issue_links').eq('row_id', id))
          .unique(),
      )
    // the link to B now travels with B, and the one to the purged C is gone
    expect(await storedLink(toB.id)).toMatchObject({ item_id: bItem.id, owner_id: b.id })
    expect(await storedLink(toC.id)).toBeNull()
    expect((await liveRowsOf(t, a.id)).issue_links).toEqual([])

    await restore(t, f.user, [bItem.id])
    const { _id, _creationTime, ...doc } = toB
    expect((await liveRowsOf(t, a.id)).issue_links).toEqual([doc])
    await assertNoDanglingRefs(t, 'after links came back')
  })

  /** Task `a` in Firmware with a link to `b` and to `b`'s subtask, which
   * travel with `a`, deleted first, and `b` deleted with its subtask. */
  async function linkedItems() {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const a = await plantIssue(t, { org_id, project_id: f.sub.id })
    const b = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const below = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: b.id })
    const links: Doc<'issue_links'>[] = []
    for (const end of [b, below])
      links.push(
        await t.run(async (ctx) => {
          const _id = await ctx.db.insert('issue_links', {
            org_id,
            id: uuid(),
            source_id: a.id,
            target_id: end.id,
            type: 'blocks',
            pair_key: [a.id, end.id].sort().join(':'),
            created_at: NOW,
          })
          return (await ctx.db.get(_id)) as Doc<'issue_links'>
        }),
      )
    await deleteTask(t, f, a.id)
    await deleteTask(t, f, b.id, { subtask_ids: [below.id] })
    const items = [await itemFor(t, a.id), await itemFor(t, b.id)]
    const strip = ({ _id, _creationTime, ...doc }: Doc<'issue_links'>) => doc
    const byLinkId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : 1)
    return { t, f, a, b, items, links: links.map(strip).sort(byLinkId), byLinkId }
  }

  it('restores two items whose tasks link to each other, in steps that take turns', async () => {
    // one link a step stands for TRASH_BUDGET.rows of them: two items with
    // that many links between them, restored together, traded them for ever
    const { t, f, a, items, links, byLinkId } = await linkedItems()
    TRASH_BUDGET.rows = 1
    const result = await restore(
      t,
      f.user,
      items.map((item) => item.id),
    )
    expect(result.restored).toEqual(items.map((item) => item.id))
    // the steps of the two items take turns, as steps scheduled at once do
    let turns = 0
    for (;;) {
      const left = []
      for (const item of items) if ((await jobFor(t, item.id)) !== null) left.push(item)
      if (left.length === 0) break
      for (const item of left) await step(t, item.id)
      expect(++turns).toBeLessThan(30)
    }
    for (const item of items) expect(await itemById(t, item.id)).toBeNull()
    expect((await liveRowsOf(t, a.id)).issue_links.sort(byLinkId)).toEqual(links)
    await assertNoDanglingRefs(t, 'after two linked items came back')
  })

  it('takes back the links another restore wrote for it when its own restore fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { t, f, a, b, items, links, byLinkId } = await linkedItems()
    const [aItem, bItem] = items
    // b's restore stops in its fill, and a's comes back whole meanwhile
    TRASH_BUDGET.rows = 1
    await restore(t, f.user, [bItem.id])
    expect((await itemById(t, bItem.id))?.state).toBe('restoring')
    TRASH_BUDGET.rows = DEFAULT_BUDGET.rows
    await restore(t, f.user, [aItem.id])
    expect(await itemById(t, aItem.id)).toBeNull()
    expect((await liveRowsOf(t, a.id)).issue_links.sort(byLinkId)).toEqual(links)
    // b's project is archived before b's reveal, which sends b back
    await patch(t, 'projects', f.sub2.id, { archived_at: NOW })
    await stepThrough(t, bItem.id)
    expect(await itemById(t, bItem.id)).toMatchObject({ state: 'ready' })
    expect(await liveTask(t, b.id)).toBeNull()
    expect((await liveRowsOf(t, a.id)).issue_links).toEqual([])
    expect(
      (await storedRows(t, bItem.id))
        .filter((r) => r.table === 'issue_links')
        .map((r) => r.row_id)
        .sort(),
    ).toEqual(links.map((l) => l.id).sort())
    await assertNoDanglingRefs(t, 'after a failed restore took its links back')
  })

  it('moves a subtask whose project was deleted to that project item, or deletes it when that is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await comment(t, sub)
    await plantHistory(t, sub, { listed: 2, unlisted: 1 })
    const file = await attach(t, sub, 5)
    const neighbour = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    const subHistory = (await historyOf(t, sub.id)).map((e) => e.id)
    expect(subHistory).toHaveLength(4)
    const item = await itemFor(t, root.id)
    expect(item.projects.map((p) => p.id)).toEqual([f.sub.id, f.sub2.id])
    await deleteProject(t, f, f.sub2.id)
    const projectItem = await itemFor(t, f.sub2.id)
    expect(projectItem.counts.tasks).toBe(1)

    await restore(t, f.user, [item.id])
    expect(await liveTask(t, root.id)).not.toBeNull()
    expect(await liveTask(t, sub.id)).toBeNull()
    // the subtask, with its rows, waits in the project's item
    expect((await storedRows(t, projectItem.id)).filter((r) => r.owner_id === sub.id)).toHaveLength(
      3,
    )
    expect((await storedTasks(t, projectItem.id)).map((x) => x.task_id).sort()).toEqual(
      [sub.id, neighbour.id].sort(),
    )
    const counted = await itemFor(t, f.sub2.id)
    expect(counted.counts.tasks).toBe(2)
    expect(counted.projects.find((p) => p.id === f.sub2.id)?.tasks).toBe(2)
    expect(await itemById(t, item.id)).toBeNull()
    // and its history with it
    expect((await historyOf(t, sub.id)).map((e) => e.id)).toEqual(subHistory)

    // the project brings it back under its parent, with its file
    await restore(t, f.user, [projectItem.id])
    expect((await liveTask(t, sub.id))?.parent_id).toBe(root.id)
    expect(await blobExists(t, file.storage_id)).toBe(true)
    expect(await t.run((ctx) => byId(ctx, 'issue_attachments', file.id))).toMatchObject({
      issue_id: sub.id,
    })
    await assertNoDanglingRefs(t, 'after a subtask came back with its project')

    // a project purged for good takes the subtask with it
    const third = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const root2 = await plantIssue(t, { org_id, project_id: f.sub.id })
    const lost = await plantIssue(t, { org_id, project_id: third.id, parent_id: root2.id })
    const lostFile = await attach(t, lost)
    await plantHistory(t, lost, { listed: 2, unlisted: 1 })
    await deleteTask(t, f, root2.id, { subtask_ids: [lost.id] })
    await deleteProject(t, f, third.id)
    const thirdItem = await itemFor(t, third.id)
    await t.run(async (ctx) => startPurge(ctx, thirdItem, { inline: true }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await restore(t, f.user, [(await itemFor(t, root2.id)).id])
    expect(await liveTask(t, root2.id)).not.toBeNull()
    expect(await liveTask(t, lost.id)).toBeNull()
    expect(await storedIssue(t, lost.id)).toBeUndefined()
    expect(await blobExists(t, lostFile.storage_id)).toBe(false)
    // deleted for good, it has no history left
    expect(await historyOf(t, lost.id)).toEqual([])
    expect((await historyOf(t, root2.id)).map((e) => e.verb)).toEqual(['deleted', 'restored'])
    await assertNoDanglingRefs(t, 'after a subtask went with its purged project')
    await assertNoOrphanHistory(t, 'after a subtask went with its purged project')
  })

  it('drops the archive marks, schedules them once, and restarts the done clock', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const other = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const archived = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      status: 'done',
      done_at: NOW,
      archived_at: NOW,
      relations_marked: true,
    })
    const labelId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id: labelId,
        org_id,
        name: 'Field',
        name_lower: 'field',
        color: '#ffcc00',
        created_at: NOW,
      })
      await ctx.db.insert('issue_labels', {
        org_id,
        issue_id: archived.id,
        label_id: labelId,
        task_archived: true,
      })
      await ctx.db.insert('issue_links', {
        org_id,
        id: uuid(),
        source_id: archived.id,
        target_id: other.id,
        type: 'relates',
        pair_key: [archived.id, other.id].sort().join(':'),
        created_at: NOW,
        task_archived: true,
      })
    })
    const done = await plantIssue(t, { org_id, project_id: f.sub.id, status: 'done', done_at: NOW })
    await deleteTask(t, f, archived.id)
    await deleteTask(t, f, done.id)
    // a scheduled function left by the deletes does not count below
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect())
        if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id)
    })

    vi.setSystemTime(START + HOUR)
    const items = [await itemFor(t, archived.id), await itemFor(t, done.id)]
    await restore(
      t,
      f.user,
      items.map((item) => item.id),
    )
    const back = await liveTask(t, archived.id)
    expect(back?.relations_marked).toBeUndefined()
    expect(back?.done_at).toBe(NOW)
    expect((await liveTask(t, done.id))?.done_at).toBe(iso(START + HOUR))
    const rows = await liveRowsOf(t, archived.id)
    expect(rows.issue_labels).toEqual([{ org_id, issue_id: archived.id, label_id: labelId }])
    expect(rows.issue_links.map((l) => l.task_archived)).toEqual([undefined])
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.state.kind === 'pending',
      ),
    )
    const named = (name: string) => scheduled.filter((job) => job.name.includes(name))
    expect(named('readArchivedTasks').map((job) => job.args[0])).toEqual([
      { issues: [archived.id] },
    ])
    expect(named('archiveMarks:markTasks')).toHaveLength(1)
    // the steps mark the archived task's rows again
    await runSteps(t)
    expect((await liveTask(t, archived.id))?.relations_marked).toBe(true)
    expect((await liveRowsOf(t, archived.id)).issue_labels[0]?.task_archived).toBe(true)
  })
})

describe('notices, activity and events', () => {
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
    await t.mutation(internal.webhooks.save, {
      owner,
      id: uuid(),
      name: 'task.restored',
      filters: {},
      url: 'https://receiver.example/events',
      encrypted_secret: 'test-only',
    })
  }
  const events = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('webhook_events').collect()).map((e) => [e.name, e.task_id]),
    )

  it("keeps a task's whole history while other tasks write past 500 rows, and trims nothing", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantHistory(t, root, { listed: 3 })
    await deleteTask(t, f, root.id)
    // 600 rows about two other tasks while the task sits in Deleted items
    const others = [
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.sub2.id }),
    ]
    for (const other of others) await plantHistory(t, other, { listed: 300 })
    await restore(t, f.user, [(await itemFor(t, root.id)).id])
    await runSteps(t)

    const verbs = ['updated', 'updated', 'updated', 'deleted', 'restored']
    expect((await historyOf(t, root.id)).map((e) => e.verb)).toEqual(verbs)
    // the task window reads all of it, in order
    const thread = await as(t, f.admin).query(api.snapshot.commentThread, {
      org_id,
      issue_id: root.id,
    })
    expect(thread.events.map((e) => e.verb)).toEqual(verbs)
    // no row of the organization is gone
    expect(await activityFor(t, org_id)).toHaveLength(3 + 1 + 600 + 1)
    for (const other of others) expect(await historyOf(t, other.id)).toHaveLength(300)
  })

  it('sends the Restored notice only for a task item restored alone, and one activity row per call', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const followed = async (project_id: string) => {
      const task = await plantIssue(t, { org_id, project_id })
      await plantSubscription(t, { issue_id: task.id, profile_id: f.guest.id })
      return task
    }
    const notices = async (task: Doc<'issues'>) =>
      (await messagesFor(t, f.guest.id, task.id)).map((m) => [m.detail, m.actor_id])
    const restoredRows = async () =>
      (await activityFor(t, org_id))
        .filter((e) => e.verb === 'restored')
        .map((e) => [e.target_type, e.label, e.detail, e.project_id])
    const one = await followed(f.sub.id)
    const two = await followed(f.sub.id)
    const inProject = await followed(f.sub2.id)

    await deleteTask(t, f, one.id)
    await restore(t, f.user, [(await itemFor(t, one.id)).id])
    expect(await notices(one)).toEqual([['Restored', f.user.id]])
    expect(await restoredRows()).toEqual([['issue', one.title, 'from Deleted items', f.sub.id]])

    // two items in one call: no notice, one row for both (deleting the task
    // again deleted the earlier notice with its messages)
    await deleteTask(t, f, one.id)
    await deleteTask(t, f, two.id)
    await restore(t, f.user, [(await itemFor(t, one.id)).id, (await itemFor(t, two.id)).id])
    expect(await notices(one)).toEqual([])
    expect(await notices(two)).toEqual([])
    expect((await restoredRows()).at(-1)).toEqual([
      'project',
      '2 tasks',
      'from Deleted items',
      f.sub.id,
    ])

    // a project item: no notice, the project's own row
    await deleteProject(t, f, f.sub2.id)
    await restore(t, f.user, [(await itemFor(t, f.sub2.id)).id])
    expect(await liveTask(t, inProject.id)).not.toBeNull()
    expect(await notices(inProject)).toEqual([])
    expect((await restoredRows()).at(-1)).toEqual([
      'project',
      'Board rev',
      'from Deleted items',
      f.sub2.id,
    ])

    // a task item restored alone that finishes in steps still sends it
    const chatty = await followed(f.sub.id)
    for (let i = 0; i < 5; i++) await comment(t, chatty)
    await deleteTask(t, f, chatty.id)
    TRASH_BUDGET.rows = 2
    const item = await itemFor(t, chatty.id)
    await restore(t, f.user, [item.id])
    expect((await itemById(t, item.id))?.state).toBe('restoring')
    expect(await notices(chatty)).toEqual([])
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await notices(chatty)).toEqual([['Restored', f.user.id]])
    expect((await restoredRows()).at(-1)).toEqual([
      'issue',
      chatty.title,
      'from Deleted items',
      f.sub.id,
    ])
  })

  it('sends no Restored notice for a call of a bulk restore that holds one task item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantSubscription(t, { issue_id: task.id, profile_id: f.guest.id })
    const notices = async () =>
      (await messagesFor(t, f.guest.id, task.id)).map((m) => [m.detail, m.actor_id])
    const restoreOne = async (extra: { bulk?: boolean }) => {
      const id = (await itemFor(t, task.id)).id
      const result = await as(t, f.user).mutation(api.deletedItems.restore, {
        org_id,
        ids: [id],
        ...extra,
      })
      expect(result.restored).toEqual([id])
    }

    // the last call of a 26-item restore, which the client marks bulk
    await deleteTask(t, f, task.id)
    await restoreOne({ bulk: true })
    expect(await liveTask(t, task.id)).not.toBeNull()
    expect(await notices()).toEqual([])
    // the same task restored from its own row
    await deleteTask(t, f, task.id)
    await restoreOne({})
    expect(await notices()).toEqual([['Restored', f.user.id]])
  })

  it('sends task.restored for the tasks of a task item and none for those of a project item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await subscribe(t, f)
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    await restore(t, f.user, [(await itemFor(t, root.id)).id])
    expect(await events(t)).toEqual([
      ['task.restored', root.id],
      ['task.restored', sub.id],
    ])
    await plantIssue(t, { org_id, project_id: f.sub2.id })
    await deleteProject(t, f, f.sub2.id)
    await restore(t, f.user, [(await itemFor(t, f.sub2.id)).id])
    expect(await events(t)).toHaveLength(2)
  })
})

describe('restoring a project item', () => {
  it('brings the project back with its key, number, lead, grants, milestones and tasks', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    await patch(t, 'projects', f.sub2.id, { lead_id: f.admin.id })
    const sub2 = (await liveProject(t, f.sub2.id)) as Doc<'projects'>
    const own = await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: f.viewer.id,
        level: 'viewer',
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: f.sub2.id,
        name: 'EVT',
        week: '2026-05-04',
        created_at: NOW,
      })
      const rows = async (table: 'project_access' | 'project_team_access' | 'milestones') =>
        (
          await ctx.db
            .query(table)
            .withIndex('by_project', (q) => q.eq('project_id', f.sub2.id))
            .collect()
        ).map(({ _id, _creationTime, ...doc }) => doc)
      return {
        project_access: await rows('project_access'),
        project_team_access: await rows('project_team_access'),
        milestones: await rows('milestones'),
      }
    })
    const parent = await plantIssue(t, { org_id, project_id: f.sub2.id, assignee_id: f.guest.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: parent.id })
    const note = await comment(t, child)
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id, id: f.sub2.id })
    const item = await itemFor(t, f.sub2.id)

    // the top-level lead does not lead a sub-project with its own lead
    expect(await restore(t, f.user, [item.id])).toEqual({
      restored: [],
      refused: [{ id: item.id, reason: 'not_lead' }],
      deferred: [],
    })
    expect(await restore(t, f.admin, [item.id])).toEqual({
      restored: [item.id],
      refused: [],
      deferred: [],
    })
    const { _id, _creationTime, ...project } = sub2
    expect(await liveProject(t, f.sub2.id)).toMatchObject(project)
    const back = await t.run(async (ctx) => {
      const rows = async (table: 'project_access' | 'project_team_access' | 'milestones') =>
        (
          await ctx.db
            .query(table)
            .withIndex('by_project', (q) => q.eq('project_id', f.sub2.id))
            .collect()
        ).map(({ _id, _creationTime, ...doc }) => doc)
      return {
        project_access: await rows('project_access'),
        project_team_access: await rows('project_team_access'),
        milestones: await rows('milestones'),
      }
    })
    expect(back).toEqual(own)
    expect((await liveTask(t, parent.id))?.assignee_id).toBe(f.guest.id)
    expect((await liveTask(t, child.id))?.parent_id).toBe(parent.id)
    expect((await liveRowsOf(t, child.id)).comments.map((c) => c.id)).toEqual([note.id])
    expect(await itemById(t, item.id)).toBeNull()
    expect(await storedRows(t, item.id)).toEqual([])
    await assertNoDanglingRefs(t, 'after a project came back from Deleted items')
  })

  it('keeps the hierarchy across steps and reveals the projects only at the end', async () => {
    const t = newT({ transactionLimits: { databaseQueries: 200 } })
    const f = await withOrg(t)
    const org_id = f.org.id
    const hiddenSub = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 12; i++) {
      const task = await plantIssue(t, {
        org_id,
        project_id: i % 2 ? f.sub2.id : f.sub.id,
        archived_at: i % 3 === 0 ? NOW : undefined,
      })
      await comment(t, task)
      tasks.push(task)
    }
    // children planted before their parents, across both sub-projects
    const leaf = await plantIssue(t, { org_id, project_id: f.sub.id })
    const middle = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const top = await plantIssue(t, { org_id, project_id: f.sub.id })
    await patch(t, 'issues', leaf.id, { parent_id: middle.id })
    await patch(t, 'issues', middle.id, { parent_id: top.id })
    // a task under a parent in another top-level project, which only a
    // subtask from before the subtask rule has, and a link out
    const outsideParent = await plantIssue(t, { org_id, project_id: hiddenSub.id })
    const edge = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: outsideParent.id })
    const outsider = await plantIssue(t, { org_id, project_id: hiddenSub.id })
    await t.run(async (ctx) => {
      for (const [source, target] of [
        [top, tasks[1]],
        [tasks[2], outsider],
      ])
        await ctx.db.insert('issue_links', {
          org_id,
          id: uuid(),
          source_id: source.id,
          target_id: target.id,
          type: 'blocks',
          pair_key: [source.id, target.id].sort().join(':'),
          created_at: NOW,
        })
    })
    const all = [...tasks, leaf, middle, top, edge]
    TRASH_BUDGET.ranges = 60
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('ready')
    // without the subtask the parent outside holds hours of its own
    await patch(t, 'issues', outsideParent.id, { remaining_hours: 4, remaining_set_at: NOW })
    const archived = tasks.filter((task) => task.archived_at !== undefined).length

    Object.assign(TRASH_BUDGET, { rows: 3, tasks: 2, ranges: 40 })
    vi.setSystemTime(START + HOUR)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    expect((await itemById(t, item.id))?.state).toBe('restoring')
    const projectsAbsent = async () => {
      for (const p of [f.meta, f.sub, f.sub2]) expect(await liveProject(t, p.id)).toBeNull()
    }
    await projectsAbsent()
    let sawHiddenTasks = false
    let sawHiddenEdge = false
    const steps = await stepThrough(t, item.id, async () => {
      const job = await jobFor(t, item.id)
      if (job === null || job.phase === 'restore_attach') return
      // until the reveal the projects stay absent, even with tasks back
      await projectsAbsent()
      if ((await liveTask(t, top.id)) !== null || (await liveTask(t, tasks[0].id)) !== null)
        sawHiddenTasks = true
      // the edge comes back without its parent outside, which stays a leaf
      // with its hours
      const hiddenEdge = await liveTask(t, edge.id)
      if (hiddenEdge !== null) sawHiddenEdge = true
      expect(hiddenEdge?.parent_id).toBeUndefined()
      expect((await liveTask(t, outsideParent.id))?.remaining_hours).toBe(4)
    })
    expect(steps).toBeGreaterThan(4)
    expect(sawHiddenTasks).toBe(true)
    expect(sawHiddenEdge).toBe(true)

    for (const p of [f.meta, f.sub, f.sub2]) expect(await liveProject(t, p.id)).not.toBeNull()
    for (const task of all) expect(await liveTask(t, task.id)).not.toBeNull()
    expect((await liveTask(t, leaf.id))?.parent_id).toBe(middle.id)
    expect((await liveTask(t, middle.id))?.parent_id).toBe(top.id)
    // a parent in another top-level project stays outside for good
    expect((await liveTask(t, edge.id))?.parent_id).toBeUndefined()
    expect((await liveTask(t, outsideParent.id))?.remaining_hours).toBe(4)
    expect((await liveRowsOf(t, top.id)).issue_links).toHaveLength(1)
    expect((await liveRowsOf(t, outsider.id)).issue_links).toHaveLength(1)
    const live = await Promise.all(all.map((task) => liveTask(t, task.id)))
    expect(live.filter((task) => task?.archived_at !== undefined)).toHaveLength(archived)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('deleted_rows').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('deleted_tasks').collect())).toEqual([])
    expect(await waitingParents(t)).toEqual([])
    await assertNoDanglingRefs(t, 'after a project came back in steps')
  }, 120_000)

  it('places the links before the tasks, so the mark steps of an archived task find them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const shelved = await plantIssue(t, { org_id, project_id: f.sub2.id, archived_at: NOW })
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id, project_id: f.sub2.id })
    const outside = await plantIssue(t, { org_id, project_id: f.sub.id })
    await t.run((ctx) =>
      ctx.db.insert('issue_links', {
        org_id,
        id: uuid(),
        source_id: shelved.id,
        target_id: outside.id,
        type: 'relates',
        pair_key: [shelved.id, outside.id].sort().join(':'),
        created_at: NOW,
      }),
    )
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // one task per step, and every scheduled function runs in order between
    TRASH_BUDGET.tasks = 1
    await restore(t, f.user, [item.id])
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect((await liveTask(t, shelved.id))?.relations_marked).toBe(true)
    expect((await liveRowsOf(t, shelved.id)).issue_links).toMatchObject([{ task_archived: true }])
  })

  it('sends the item back to moving when its parent was archived before the reveal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 6; i++) {
      const task = await plantIssue(t, { org_id, project_id: f.sub2.id })
      await comment(t, task)
      tasks.push(task)
    }
    // a task under a parent outside the project, which the fill writes back
    // without that parent
    const outside = await plantIssue(t, { org_id, project_id: f.sub.id })
    const edge = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: outside.id })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    Object.assign(TRASH_BUDGET, { rows: 3, tasks: 2 })
    await restore(t, f.user, [item.id])
    // step until the first tasks are back in issues, hidden under the absent
    // sub-project, then archive its parent
    while ((await liveTask(t, tasks[0].id)) === null) {
      expect(await jobFor(t, item.id)).not.toBeNull()
      await step(t, item.id)
    }
    expect((await itemById(t, item.id))?.state).toBe('restoring')
    // the move stored the edge first, so the fill wrote it back first
    expect((await liveTask(t, edge.id))?.parent_id).toBeUndefined()
    expect((await waitingParents(t)).map((w) => [w.task_id, w.parent_id])).toEqual([
      [edge.id, outside.id],
    ])
    await patch(t, 'projects', f.meta.id, { archived_at: NOW })

    let sawMoving = false
    await stepThrough(t, item.id, async () => {
      if ((await itemById(t, item.id))?.state === 'moving') sawMoving = true
    })
    expect(sawMoving).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      'A deleted item restore was sent back at its reveal',
      expect.objectContaining({ item_id: item.id, reason: 'parent_archived' }),
    )
    const ready = await itemFor(t, f.sub2.id)
    expect(ready).toMatchObject({ state: 'ready', counts: { tasks: 7, archived_tasks: 0 } })
    expect(ready.restore_by).toBeUndefined()
    expect(await liveProject(t, f.sub2.id)).toBeNull()
    for (const task of [...tasks, edge]) expect(await liveTask(t, task.id)).toBeNull()
    expect(await storedTasks(t, item.id)).toHaveLength(7)
    expect((await storedRows(t, item.id)).filter((row) => row.table === 'comments')).toHaveLength(6)
    expect(await t.run((ctx) => ctx.db.query('comments').collect())).toEqual([])
    // the move stored the edge with the parent the fill took off it
    expect((await storedIssue(t, edge.id))?.parent_id).toBe(outside.id)
    expect(await waitingParents(t)).toEqual([])
    // and it says why when asked again
    expect((await restore(t, f.user, [item.id])).refused).toEqual([
      { id: item.id, reason: 'parent_archived' },
    ])
    await patch(t, 'projects', f.meta.id, { archived_at: undefined })
    TRASH_BUDGET.rows = 300
    await restore(t, f.user, [item.id])
    await runSteps(t)
    for (const task of tasks) expect(await liveTask(t, task.id)).not.toBeNull()
    expect((await liveTask(t, edge.id))?.parent_id).toBe(outside.id)
    await assertNoDanglingRefs(t, 'after a restore that was sent back')
  })

  it('brings back tasks that hang under one parent outside the project in a few reads each', async () => {
    // a transaction writes or attaches many tasks under a parent outside,
    // so it must not read a dozen ranges for each
    const t = newT({ transactionLimits: { databaseQueries: 150 } })
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantSubscription(t, { issue_id: epic.id, profile_id: f.admin.id })
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 40; i++)
      tasks.push(await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: epic.id }))
    TRASH_BUDGET.ranges = 60
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item.state).toBe('ready')
    // without its subtasks the epic holds hours of its own
    await patch(t, 'issues', epic.id, { remaining_hours: 8, remaining_set_at: NOW })

    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    for (const task of tasks) expect((await liveTask(t, task.id))?.parent_id).toBe(epic.id)
    // the epic is a group again and lost its hours once
    expect((await liveTask(t, epic.id))?.remaining_hours).toBeUndefined()
    expect((await messagesFor(t, f.admin.id, epic.id)).map((m) => m.detail)).toEqual([
      'Remaining cleared (was 8 h)',
    ])
    await assertNoDanglingRefs(t, 'after tasks came back under a parent outside')
  })

  it('sends a restore whose steps keep failing back to Deleted items rather than stuck', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
      await comment(t, task)
      tasks.push(task)
    }
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await restore(t, f.user, [item.id])
    expect((await itemById(t, item.id))?.state).toBe('restoring')
    // every step fails: it leaves the job at its last committed progress
    let now = START
    for (let round = 0; round < 20; round++) {
      const job = await jobFor(t, item.id)
      if (job === null || job.phase.startsWith('move')) break
      await t.run((ctx) => ctx.scheduler.cancel(job.scheduled_id!))
      now += STALLED_MS + 1
      vi.setSystemTime(now)
      await t.mutation(internal.deletedItems.recover, {})
    }
    expect(await itemById(t, item.id)).toMatchObject({ state: 'moving', restore_by: f.user.id })
    expect(await jobFor(t, item.id)).toMatchObject({
      phase: 'move_drain',
      attempts: 0,
      budget_scale: 1,
    })
    expect(error).toHaveBeenCalledWith(
      'A deleted item restore could not finish and goes back',
      expect.objectContaining({ item_id: item.id }),
    )
    // the move takes back what the restore wrote, and the item can be
    // restored again
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await runSteps(t)
    const ready = await itemFor(t, f.sub2.id)
    expect(ready).toMatchObject({ state: 'ready', counts: { tasks: 3 } })
    expect(ready.restore_by).toBeUndefined()
    expect(await t.run((ctx) => ctx.db.query('comments').collect())).toEqual([])
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    await runSteps(t)
    for (const task of tasks) expect(await liveTask(t, task.id)).not.toBeNull()
  })
})

describe('parents outside a restored project', () => {
  /** `n` tasks of Board rev under one epic in Firmware, which the user
   * edits as the lead of Testbed platform, with Board rev moved to Deleted
   * items. The epic, a leaf again, holds 8 hours of its own and the admin
   * follows it. */
  async function underEpic(t: T, f: OrgFixture, n: number) {
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantSubscription(t, { issue_id: epic.id, profile_id: f.admin.id })
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < n; i++)
      tasks.push(await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: epic.id }))
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item.state).toBe('ready')
    await patch(t, 'issues', epic.id, { remaining_hours: 8, remaining_set_at: NOW })
    return { epic, tasks, item }
  }

  /** One task of Board rev under each of `parents`, outside it. Waiting
   * tasks attach in uuid order, so each task gets a uuid that sorts by its
   * place in `parents`. */
  async function plantUnder(t: T, f: OrgFixture, parents: Doc<'issues'>[]) {
    const tasks: Doc<'issues'>[] = []
    for (const [i, parent] of parents.entries())
      tasks.push(
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: f.sub2.id,
          parent_id: parent.id,
          id: `${i + 1}0000000-0000-4000-8000-000000000000`,
        }),
      )
    return tasks
  }

  /** plantUnder, then Board rev moved to Deleted items. */
  async function oneUnderEach(t: T, f: OrgFixture, parents: Doc<'issues'>[]) {
    const tasks = await plantUnder(t, f, parents)
    await deleteProject(t, f, f.sub2.id)
    return { tasks, item: await itemFor(t, f.sub2.id) }
  }

  /** Restores `itemId` for the user and steps it until its projects are
   * back and its tasks wait for their parents. */
  async function untilAttach(t: T, f: OrgFixture, itemId: string) {
    expect((await restore(t, f.user, [itemId])).restored).toEqual([itemId])
    for (let i = 0; (await jobFor(t, itemId))?.phase !== 'restore_attach'; i++) {
      expect(i).toBeLessThan(50)
      await step(t, itemId)
    }
    expect(await liveProject(t, f.sub2.id)).not.toBeNull()
  }

  const parentsOf = (t: T, tasks: Doc<'issues'>[]) =>
    Promise.all(tasks.map(async (task) => (await liveTask(t, task.id))?.parent_id))

  /** 19,000 CJK characters, under TEXT_MAX: about 57 KB of UTF-8. */
  const HEAVY = '漢'.repeat(19_000)

  /** A chain of `n` tasks in Firmware, each with `description`, top first.
   * Answers its lowest task. */
  async function chainOf(t: T, f: OrgFixture, n: number, description = '') {
    let low: Doc<'issues'> | undefined
    for (let i = 0; i < n; i++)
      low = await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub.id,
        parent_id: low?.id,
        description,
      })
    if (low === undefined) throw new Error('a chain holds at least one task')
    return low
  }

  it(`brings back 500 tasks of 16 KB under five parents outside the project, ${SUBTASK_MAX} each, within the real limits`, async () => {
    // 8 MiB of tasks under parents outside, which no single transaction
    // can read and write back with their parent
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    const epics: Doc<'issues'>[] = []
    for (let i = 0; i < 5; i++) {
      const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
      await plantSubscription(t, { issue_id: epic.id, profile_id: f.admin.id })
      epics.push(epic)
    }
    const description = 'Spec line. '.repeat(1490)
    // the ids planted under each epic, in the order of `epics`
    const ids = await t.run(async (ctx) => {
      const planted: string[][] = []
      for (const [e, epic] of epics.entries()) {
        planted.push([])
        for (let i = 0; i < SUBTASK_MAX; i++) {
          const id = uuid()
          await ctx.db.insert('issues', {
            id,
            org_id,
            num: 50_000 + e * SUBTASK_MAX + i,
            project_id: f.sub2.id,
            parent_id: epic.id,
            title: 'Planted task',
            description,
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
          planted[e].push(id)
        }
      }
      return planted
    })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: 500 } })
    for (const epic of epics)
      await patch(t, 'issues', epic.id, { remaining_hours: 8, remaining_set_at: NOW })

    const result = await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id,
      ids: [item.id],
    })
    expect(result.restored).toEqual([item.id])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    for (const [e, epic] of epics.entries()) {
      const children = await t.run((ctx) =>
        ctx.db
          .query('issues')
          .withIndex('by_parent', (q) => q.eq('parent_id', epic.id))
          .collect(),
      )
      expect(children.map((c) => c.id).sort()).toEqual([...ids[e]].sort())
      expect(children.every((c) => c.description === description)).toBe(true)
      expect((await liveTask(t, epic.id))?.remaining_hours).toBeUndefined()
      expect((await messagesFor(t, f.admin.id, epic.id)).map((m) => m.detail)).toEqual([
        'Remaining cleared (was 8 h)',
      ])
    }
    expect(await waitingParents(t)).toEqual([])
  }, 300_000)

  it('brings a project back whole when a task that waits has more under it than a step can read', async () => {
    // 100 subtasks of 57 KB right under the middle task, 5.6 MB; the check
    // reads only the first, as one is enough to keep the task from a parent
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    const tasks = await plantUnder(t, f, [epic, epic, epic])
    const [light, heavy] = tasks
    const under = (parent_id: string, description = '') =>
      plantIssue(t, { org_id, project_id: f.sub2.id, parent_id, description })
    await under(light.id)
    for (let i = 0; i < SUBTASK_MAX; i++) await under(heavy.id, HEAVY)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: 3 + 1 + SUBTASK_MAX } })

    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await liveProject(t, f.sub2.id)).not.toBeNull()
    // the tasks with subtasks stay without their parent, with their
    // subtasks under them, and no check stopped short
    expect(await parentsOf(t, tasks)).toEqual([undefined, undefined, epic.id])
    expect(warn.mock.calls).toEqual([])
    expect(await subtaskCount(t, light.id)).toBe(1)
    expect(await subtaskCount(t, heavy.id)).toBe(SUBTASK_MAX)
    expect(await waitingParents(t)).toEqual([])
  }, 300_000)

  it('reads a parent that tasks share once, so they come back whole in the restore call', async () => {
    // 50 tasks under one epic of 900 KiB in Firmware, a description from
    // before the 20,000-character cap. Read once per task, the epic would
    // pass what one transaction can read
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      description: 'Field note. '.repeat(76_800),
    })
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 50; i++)
      tasks.push(await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: epic.id }))
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: 50 } })

    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [item.id] })
    expect(await parentsOf(t, tasks)).toEqual(tasks.map(() => epic.id))
    expect(await waitingParents(t)).toEqual([])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
  }, 300_000)

  it('comes back whole in one transaction when its attaches fit there', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { epic, tasks, item } = await underEpic(t, f, 2)
    // the full budget of the call holds the fill, the reveal and the attach
    await restore(t, f.user, [item.id])
    expect(await itemById(t, item.id)).toBeNull()
    expect(await jobFor(t, item.id)).toBeNull()
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id])

    // after the fill the call has room for one attach, not two, so the
    // reveal waits for a step of its own, which brings the project back whole
    await deleteProject(t, f, f.sub2.id)
    const again = await itemFor(t, f.sub2.id)
    TRASH_BUDGET.tasks = 3
    await restore(t, f.user, [again.id])
    expect(await jobFor(t, again.id)).toMatchObject({ phase: 'restore_reveal' })
    expect(await liveProject(t, f.sub2.id)).toBeNull()
    await step(t, again.id)
    expect(await itemById(t, again.id)).toBeNull()
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id])
  })

  it('attaches them in steps after the reveal, each parent losing its hours once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const epics = [
      await plantIssue(t, { org_id, project_id: sibling.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
    ]
    const tasks: Doc<'issues'>[] = []
    for (const epic of epics) {
      await plantSubscription(t, { issue_id: epic.id, profile_id: f.admin.id })
      for (let i = 0; i < 3; i++)
        tasks.push(await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: epic.id }))
    }
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    await patch(t, 'issues', epics[0].id, { remaining_hours: 8, remaining_set_at: NOW })
    await patch(t, 'issues', epics[1].id, { remaining_hours: 3, remaining_set_at: NOW })

    TRASH_BUDGET.tasks = 2
    await restore(t, f.user, [item.id])
    let attachSteps = 0
    let sawDetached = 0
    await stepThrough(t, item.id, async () => {
      if ((await jobFor(t, item.id))?.phase !== 'restore_attach') return
      attachSteps++
      // the project is back and every task shows, some still without parent
      expect(await liveProject(t, f.sub2.id)).not.toBeNull()
      const parents = await parentsOf(t, tasks)
      const detached = parents.filter((p) => p === undefined).length
      expect(detached).toBe((await waitingParents(t)).length)
      if (detached > 0) sawDetached++
    })
    expect(attachSteps).toBeGreaterThan(1)
    expect(sawDetached).toBeGreaterThan(1)
    expect(await parentsOf(t, tasks)).toEqual(tasks.map((task) => task.parent_id))
    for (const [epic, hours] of [
      [epics[0], 8],
      [epics[1], 3],
    ] as const) {
      expect((await liveTask(t, epic.id))?.remaining_hours).toBeUndefined()
      expect((await messagesFor(t, f.admin.id, epic.id)).map((m) => m.detail)).toEqual([
        `Remaining cleared (was ${hours} h)`,
      ])
    }
    expect(await itemById(t, item.id)).toBeNull()
    expect(await waitingParents(t)).toEqual([])
    await assertNoDanglingRefs(t, 'after tasks were attached in steps')
  })

  it('leaves a task without its parent when that parent fails the table before its turn', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // the user may change each parent, in Firmware and in a sibling
    // sub-project, as the lead of Testbed platform
    const sibling = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const parents = [
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: sibling.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
    ]
    const [first, unreadable, nested, loop, away] = parents
    const {
      tasks: [kept, ...lost],
      item,
    } = await oneUnderEach(t, f, parents)
    for (const parent of [unreadable, away])
      await patch(t, 'issues', parent.id, { remaining_hours: 5, remaining_set_at: NOW })

    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, [kept, ...lost])).toEqual([first.id, ...lost.map(() => undefined)])
    // the user no longer leads Testbed platform and keeps Edit on Firmware
    // and Board rev only, so they cannot see the sibling; the next parent
    // becomes a subtask, so it can have none of its own; the next parent now
    // hangs under the very task that waits for it; the last moves to a
    // sub-project of Skunkworks, another top-level project the user leads
    await patch(t, 'projects', f.meta.id, { lead_id: f.admin.id })
    await t.run(async (ctx) => {
      for (const project_id of [f.sub.id, f.sub2.id])
        await ctx.db.insert('project_access', { project_id, profile_id: f.user.id, level: 'user' })
    })
    const above = await plantIssue(t, { org_id, project_id: f.sub.id })
    await patch(t, 'issues', nested.id, { parent_id: above.id })
    await patch(t, 'issues', loop.id, { parent_id: lost[2].id })
    const elsewhere = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
    await as(t, f.admin).mutation(api.issues.move, {
      org_id,
      id: away.id,
      project_id: elsewhere.id,
    })

    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await parentsOf(t, [kept, ...lost])).toEqual([first.id, ...lost.map(() => undefined)])
    expect((await liveTask(t, loop.id))?.parent_id).toBe(lost[2].id)
    // neither the parent the user can no longer see nor the one in another
    // top-level project became a group
    expect((await liveTask(t, unreadable.id))?.remaining_hours).toBe(5)
    expect((await liveTask(t, away.id))?.remaining_hours).toBe(5)
    expect(await waitingParents(t)).toEqual([])
    await assertNoDanglingRefs(t, 'after an attach left tasks without their parent')
  })

  it('leaves a task that someone changed since the reveal as they left it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    const {
      tasks: [first, reparented, moved],
      item,
    } = await oneUnderEach(t, f, [epic, epic, epic])
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, [first, reparented, moved])).toEqual([epic.id, undefined, undefined])
    // one gets a parent of its own, the other moves to Firmware
    const other = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await patch(t, 'issues', reparented.id, { parent_id: other.id })
    await patch(t, 'issues', moved.id, { project_id: f.sub.id })

    await stepThrough(t, item.id)
    expect(await parentsOf(t, [first, reparented, moved])).toEqual([epic.id, other.id, undefined])
    expect(await waitingParents(t)).toEqual([])
  })

  it('keeps the parent of a task that waits for it when its project goes to Deleted items again', async () => {
    const t = newT()
    const f = await withOrg(t)
    const epic = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const { tasks, item } = await oneUnderEach(t, f, [epic, epic, epic])
    const [, early, late] = tasks
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, undefined, undefined])
    // the lead deletes Board rev again; the call moves the first task and
    // one that waits, and the restore's next step finds the other hidden
    TRASH_BUDGET.tasks = 2
    await deleteProject(t, f, f.sub2.id)
    expect(await liveTask(t, early.id)).toBeNull()
    expect(await liveTask(t, late.id)).not.toBeNull()
    await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()

    TRASH_BUDGET.tasks = 100
    await runSteps(t)
    const again = await itemFor(t, f.sub2.id)
    expect(again.state).toBe('ready')
    expect(await waitingParents(t)).toEqual([])
    expect((await storedIssue(t, late.id))?.parent_id).toBe(epic.id)
    await restore(t, f.user, [again.id])
    await runSteps(t)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id, epic.id])
    await assertNoDanglingRefs(t, 'after a project went to Deleted items again during an attach')
  })

  it('keeps the parent of a task that waits for it when the task goes to Deleted items alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const epic = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const {
      tasks: [first, waiting, moved],
      item,
    } = await oneUnderEach(t, f, [epic, epic, epic])
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    // one still waits; the other moved to Firmware since the reveal, so it
    // stays as it was left
    await patch(t, 'issues', moved.id, { project_id: f.sub.id })
    TRASH_BUDGET.tasks = 100
    for (const task of [waiting, moved]) await deleteTask(t, f, task.id)
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await waitingParents(t)).toEqual([])

    for (const task of [waiting, moved])
      expect((await restore(t, f.user, [(await itemFor(t, task.id)).id])).restored).toHaveLength(1)
    expect(await parentsOf(t, [first, waiting, moved])).toEqual([epic.id, epic.id, undefined])
  })

  it('keeps the parent a task got after the reveal when its project goes and comes back again', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    const { tasks, item } = await oneUnderEach(t, f, [epic, epic, epic])
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    // a task that waits gets another parent in Firmware, then Board rev goes to
    // Deleted items and comes back while the first restore still attaches
    const story = await plantIssue(t, { org_id, project_id: f.sub.id })
    await patch(t, 'issues', tasks[1].id, { parent_id: story.id })
    TRASH_BUDGET.tasks = 100
    await deleteProject(t, f, f.sub2.id)
    const items = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', f.sub2.id))
        .collect(),
    )
    const again = items.find((x) => x.id !== item.id)
    expect(again?.state).toBe('ready')
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, again!.id)
    await step(t, item.id)
    TRASH_BUDGET.tasks = 100
    await runSteps(t)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, story.id, epic.id])
    expect(await waitingParents(t)).toEqual([])
  })

  it('keeps no parent that needs the restorer once they are gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { epic, tasks, item } = await underEpic(t, f, 3)
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect((await parentsOf(t, tasks)).filter((p) => p === epic.id)).toHaveLength(1)
    await patch(t, 'profiles', f.user.id, { active: false })
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect((await parentsOf(t, tasks)).filter((p) => p === epic.id)).toHaveLength(1)
    expect(await waitingParents(t)).toEqual([])
  })

  it('attaches a task only when everyone working under it can see the parent, as a reparent requires', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // the guest edits Board rev through a grant of its own and cannot see
    // the sibling sub-project where the epic is
    const epic = await plantIssue(t, {
      org_id,
      project_id: (await plantHiddenSibling(t, f, f.guest)).id,
    })
    const plant = (extra: Partial<Doc<'issues'>>) =>
      plantIssue(t, { org_id, project_id: f.sub2.id, ...extra })
    // the admin, who sees every project, works on this one
    const kept = await plant({ parent_id: epic.id, assignee_id: f.admin.id })
    // the guest reviews this one
    const lost = await plant({
      parent_id: epic.id,
      assignee_id: f.admin.id,
      reviewer_id: f.guest.id,
    })
    // only the admin works on this one and its subtask, but a task with
    // subtasks cannot become a subtask
    const group = await plant({ parent_id: epic.id, assignee_id: f.admin.id })
    const below = await plant({ parent_id: group.id, assignee_id: f.admin.id })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)

    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect((await liveTask(t, kept.id))?.parent_id).toBe(epic.id)
    // each comes back top-level and keeps its people and its subtasks
    expect(await liveTask(t, lost.id)).toMatchObject({ reviewer_id: f.guest.id })
    expect((await liveTask(t, lost.id))?.parent_id).toBeUndefined()
    expect((await liveTask(t, group.id))?.parent_id).toBeUndefined()
    expect((await liveTask(t, below.id))?.parent_id).toBe(group.id)
    expect(await waitingParents(t)).toEqual([])
  })

  it('counts what the subtask check reads against the step budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    const heavy = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: epic.id,
      id: '10000000-0000-4000-8000-000000000000',
    })
    const description = 'Spec line. '.repeat(1490)
    for (let i = 0; i < 3; i++)
      await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: heavy.id, description })
    const light = await plantIssue(t, {
      org_id,
      project_id: f.sub2.id,
      parent_id: epic.id,
      id: '20000000-0000-4000-8000-000000000000',
    })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // the check reads the first of the three subtasks of 16 KB under the
    // first task, which then comes back without its parent, and it spends
    // the step
    TRASH_BUDGET.bytes = 12_000
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, [heavy, light])).toEqual([undefined, undefined])
    expect((await waitingParents(t)).map((row) => row.task_id)).toEqual([light.id])
    await stepThrough(t, item.id)
    expect(await parentsOf(t, [heavy, light])).toEqual([undefined, epic.id])
  })

  it('counts what the parents hold against the step budget', async () => {
    // six stories in Firmware that grow to 171 KB each while Board rev is
    // in Deleted items, descriptions from before the 20,000-character cap,
    // so a step that read every story would pass the read limit
    const t = newT({ transactionLimits: { bytesRead: 600_000 } })
    const f = await withOrg(t)
    const org_id = f.org.id
    const stories: Doc<'issues'>[] = []
    for (let i = 0; i < 6; i++) stories.push(await plantIssue(t, { org_id, project_id: f.sub.id }))
    const { tasks, item } = await oneUnderEach(t, f, stories)
    for (const story of stories)
      await patch(t, 'issues', story.id, { description: HEAVY.repeat(3) })
    TRASH_BUDGET.bytes = 100_000
    // the fill reads each story once, a step each, and the reveal's step
    // checks the first task whole and stops on the bytes it held
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, tasks)).toEqual([
      stories[0].id,
      ...stories.slice(1).map(() => undefined),
    ])
    // so does each attach step
    await step(t, item.id)
    expect(await parentsOf(t, tasks)).toEqual([
      ...stories.slice(0, 2).map((story) => story.id),
      ...stories.slice(2).map(() => undefined),
    ])
    await stepThrough(t, item.id)
    expect(await parentsOf(t, tasks)).toEqual(stories.map((story) => story.id))
  })

  it(`counts the subtasks of each parent after the attaches before it in its step, up to ${SUBTASK_MAX}`, async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // the epic has 97 subtasks in Firmware, and a fifth task waits for it
    const epic = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantSubtasks(t, f, epic.id, SUBTASK_MAX - 3)
    const tasks = await plantUnder(t, f, [epic, epic, epic, epic])
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // the reveal's step attaches the first task only, the 98th
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, undefined, undefined, undefined])

    // one step reads the epic's 98 subtasks once and counts each attach,
    // so the 99th and the 100th fit and the last does not
    TRASH_BUDGET.tasks = 100
    await step(t, item.id)
    expect(await jobFor(t, item.id)).toBeNull()
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id, epic.id, undefined])
    expect(await subtaskCount(t, epic.id)).toBe(SUBTASK_MAX)
    expect(await waitingParents(t)).toEqual([])
  })

  it('attaches 150 tasks under parents in 10 projects that each of 150 people on them can see, within the real limits', async () => {
    // checked for each person and project, who sees the parents read more
    // than the 4,096 index ranges of one transaction, so every retry failed
    // and the attach gave up on the parents
    const t = newT({ transactionLimits: true })
    chargeFilteredReads()
    const f = await withOrg(t)
    const org_id = f.org.id
    const epics = await oneInEach(t, f, 10)
    const tasks: Doc<'issues'>[] = []
    for (const epic of epics)
      for (let i = 0; i < 15; i++)
        tasks.push(await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: epic.id }))
    const people = await plantPeople(t, f, 150)
    for (const [i, task] of tasks.entries())
      await patch(t, 'issues', task.id, { assignee_id: people[i] })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: 150 } })

    const result = await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id,
      ids: [item.id],
    })
    expect(result.restored).toEqual([item.id])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    for (const epic of epics) {
      const ours = tasks.filter((task) => task.parent_id === epic.id)
      expect(await assignedUnder(t, epic.id)).toEqual(
        pairs(
          ours.map((task) => task.id),
          ours.map((task) => people[tasks.indexOf(task)]),
        ),
      )
    }
    expect(await waitingParents(t)).toEqual([])
  }, 300_000)

  it('reads no more for who sees a parent than SIGHT_READ allows, and leaves that task without it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const epic = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const tasks = await plantUnder(t, f, [epic, epic])
    const [one, two] = tasks
    // one person works on the first task, two on the second
    const people = await plantPeople(t, f, 3)
    await patch(t, 'issues', one.id, { assignee_id: people[0] })
    await patch(t, 'issues', two.id, { assignee_id: people[1], reviewer_id: people[2] })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // what one person costs fits, what two cost does not
    SIGHT_READ.ranges = 5

    await restore(t, f.user, [item.id])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await parentsOf(t, tasks)).toEqual([epic.id, undefined])
    expect(warn.mock.calls).toEqual([
      [
        'A deleted item restore cannot check who sees the parent of a task',
        { item_id: item.id, task_id: two.id },
      ],
    ])
    expect(await waitingParents(t)).toEqual([])
    // the task comes back with its people
    expect(await liveTask(t, two.id)).toMatchObject({
      assignee_id: people[1],
      reviewer_id: people[2],
    })
  })

  it('restores a task and a project under a legacy chain of nineteen tasks of 900 KiB within the real limits, without that parent', async () => {
    // the chain holds 17 MiB, more than one transaction can read, so a
    // restore that read it whole failed, and so did every retry. Its lowest
    // task is a subtask, so it is no parent for a restored task, and the
    // restore reads nothing above it
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT({ transactionLimits: true })
    chargeFilteredReads()
    const f = await withOrg(t)
    const low = await chainOf(t, f, 19, 'Field note. '.repeat(76_800))
    // a task of Firmware deleted alone, and one of Board rev deleted with it
    const root = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: low.id })
    await deleteTask(t, f, root.id)
    const taskItem = await itemFor(t, root.id)
    const {
      tasks: [task],
      item: projectItem,
    } = await oneUnderEach(t, f, [low])
    await runSteps(t)
    expect((await itemById(t, projectItem.id))?.state).toBe('ready')

    for (const item of [taskItem, projectItem]) {
      const result = await as(t, f.user).mutation(api.deletedItems.restore, {
        org_id: f.org.id,
        ids: [item.id],
      })
      expect(result.restored).toEqual([item.id])
      await stepThrough(t, item.id)
      expect(await itemById(t, item.id)).toBeNull()
    }
    expect(await parentsOf(t, [root, task])).toEqual([undefined, undefined])
    expect(warn.mock.calls).toEqual([])
    expect(await waitingParents(t)).toEqual([])
  }, 300_000)

  it('checks a task again in the next step when its step runs out of reads during the check', async () => {
    const t = newT()
    const f = await withOrg(t)
    const epic = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const tasks = await plantUnder(t, f, [epic, epic, epic])
    const [, , busy] = tasks
    // the assignee and the reviewer of the last task are each in 50 teams,
    // so reading what one of them sees costs more than 100 ranges
    const [assignee, reviewer] = await plantPeople(t, f, 2, await plantTeams(t, f, 50))
    await patch(t, 'issues', busy.id, { assignee_id: assignee, reviewer_id: reviewer })
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // the reveal's step attaches the first task only
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, undefined, undefined])

    // the step attaches the second task, and its reads run out while it
    // checks what the two people see
    TRASH_BUDGET.tasks = 100
    TRASH_BUDGET.ranges = 100
    await step(t, item.id)
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_attach' })
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id, undefined])
    expect((await waitingParents(t)).map((row) => row.task_id)).toEqual([busy.id])
    // the next step checks it first, whole, though that passes its budget,
    // and attaches it
    await step(t, item.id)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id, epic.id])
    expect(await waitingParents(t)).toEqual([])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await liveTask(t, busy.id)).toMatchObject({
      assignee_id: assignee,
      reviewer_id: reviewer,
    })
  })

  it('checks a task again in the next step when its step runs out of reads before it counts the subtasks of its parent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const epic = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // a story of 57 KB
    const story = await chainOf(t, f, 1, HEAVY)
    const tasks = await plantUnder(t, f, [epic, epic, story])
    await deleteProject(t, f, f.sub2.id)
    const item = await itemFor(t, f.sub2.id)
    // the reveal's step attaches the first task only
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, undefined, undefined])

    // the step attaches the second task, then reads the story and has no
    // bytes left to count its subtasks
    TRASH_BUDGET.tasks = 100
    TRASH_BUDGET.bytes = 50_000
    await step(t, item.id)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id, undefined])
    expect((await waitingParents(t)).map((row) => row.task_id)).toEqual([tasks[2].id])
    // the next step checks it first, whole, though that passes its budget,
    // and attaches it
    await step(t, item.id)
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id, story.id])
    expect(await waitingParents(t)).toEqual([])
  })

  it('brings back under its parent a subtask that another restore moved into it after its fill', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    // no rows of its own, which would send the reveal back to restore_rows
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    const taskItem = await itemFor(t, root.id)
    for (let i = 0; i < 2; i++) await plantIssue(t, { org_id, project_id: f.sub2.id })
    await deleteProject(t, f, f.sub2.id)
    const projectItem = await itemFor(t, f.sub2.id)
    // the call fills Board rev, and its reveal waits for a step
    TRASH_BUDGET.tasks = 2
    await restore(t, f.user, [projectItem.id])
    expect(await jobFor(t, projectItem.id)).toMatchObject({ phase: 'restore_reveal' })
    // the task's restore hands the subtask to Board rev's item
    TRASH_BUDGET.tasks = 100
    await restore(t, f.user, [taskItem.id])
    expect(await itemById(t, taskItem.id)).toBeNull()
    expect((await storedTasks(t, projectItem.id)).map((x) => x.task_id)).toEqual([sub.id])

    await stepThrough(t, projectItem.id)
    expect(await itemById(t, projectItem.id)).toBeNull()
    expect((await liveTask(t, sub.id))?.parent_id).toBe(root.id)
    expect(await t.run((ctx) => ctx.db.query('deleted_rows').collect())).toEqual([])
    await assertNoDanglingRefs(t, 'after a subtask reached a project item past its fill')
  })

  it('finishes a restore whose item lists a stored task that is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { epic, tasks, item } = await underEpic(t, f, 2)
    await t.run((ctx) =>
      ctx.db.insert('deleted_tasks', {
        org_id: f.org.id,
        item_id: item.id,
        task_id: uuid(),
        num: 90_000,
        title: 'Gone',
        project_id: f.sub2.id,
        archived: false,
      }),
    )
    await restore(t, f.user, [item.id])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await parentsOf(t, tasks)).toEqual([epic.id, epic.id])
    expect(await storedTasks(t, item.id)).toEqual([])
  })

  it('retries a failed attach step and, after its retries, leaves the rest without their parent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const { epic, tasks, item } = await underEpic(t, f, 4)
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    const attached = async () =>
      (await parentsOf(t, tasks)).filter((parent) => parent === epic.id).length
    expect(await attached()).toBe(1)
    // a failed step leaves the job at its last committed progress; the
    // clock starts where the steps above left it
    let now = Date.now()
    const fail = async () => {
      const job = await jobFor(t, item.id)
      if (job?.scheduled_id === undefined) throw new Error('no step to fail')
      await t.run((ctx) => ctx.scheduler.cancel(job.scheduled_id!))
      now += STALLED_MS + 1
      vi.setSystemTime(now)
      await t.mutation(internal.deletedItems.recover, {})
    }
    // recover retries the attach at half the budget; the project stays back
    await fail()
    expect(await jobFor(t, item.id)).toMatchObject({
      phase: 'restore_attach',
      attempts: 1,
      budget_scale: 0.5,
    })
    expect((await itemById(t, item.id))?.state).toBe('restoring')
    await step(t, item.id)
    expect(await jobFor(t, item.id)).toMatchObject({ attempts: 0, budget_scale: 1 })
    expect(await attached()).toBe(2)

    // then every step fails until its retries are spent, and it never goes
    // back to moving
    for (let round = 0; round < 20; round++) {
      const job = await jobFor(t, item.id)
      if (job?.phase !== 'restore_attach') break
      await fail()
    }
    expect(await jobFor(t, item.id)).toMatchObject({
      phase: 'restore_detach',
      attempts: 0,
      budget_scale: 1,
    })
    expect((await itemById(t, item.id))?.state).toBe('restoring')
    expect(error).toHaveBeenCalledWith(
      'A deleted item restore leaves the tasks it could not attach without a parent',
      expect.objectContaining({ item_id: item.id }),
    )
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await jobFor(t, item.id)).toBeNull()
    expect(await waitingParents(t)).toEqual([])
    expect(await liveProject(t, f.sub2.id)).not.toBeNull()
    for (const task of tasks) expect(await liveTask(t, task.id)).not.toBeNull()
    expect(await attached()).toBe(2)
    await assertNoDanglingRefs(t, 'after an attach gave up')
  })

  it('deletes the parents its tasks wait for with the item when the organization goes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { item } = await underEpic(t, f, 3)
    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await waitingParents(t)).toHaveLength(2)
    await t.run(async (ctx) => deleteOrgDeep(ctx, (await ctx.db.get(f.org._id))!))
    expect(await itemById(t, item.id)).toBeNull()
    expect(await waitingParents(t)).toEqual([])
    await runSteps(t)
    await assertNoDanglingRefs(t, 'after deleteOrgDeep during an attach')
  })
})

describe('restore calls', () => {
  it('answers per item, defers a task item whose project item comes back in the same call', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // the guest edits both sub-projects through the top-level grant
    const viewOnly = await plantIssue(t, { org_id, project_id: f.sub.id })
    await deleteTask(t, f, viewOnly.id)
    const archivedHome = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const inArchived = await plantIssue(t, { org_id, project_id: archivedHome.id })
    await deleteTask(t, f, inArchived.id)
    await patch(t, 'projects', archivedHome.id, { archived_at: NOW })
    const early = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await deleteTask(t, f, early.id)
    await deleteProject(t, f, f.sub2.id)
    const ids = {
      viewOnly: (await itemFor(t, viewOnly.id)).id,
      archived: (await itemFor(t, inArchived.id)).id,
      early: (await itemFor(t, early.id)).id,
      project: (await itemFor(t, f.sub2.id)).id,
    }
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant !== null) await ctx.db.patch(grant._id, { level: 'viewer' })
    })
    expect(await restore(t, f.guest, [ids.viewOnly])).toEqual({
      restored: [],
      refused: [{ id: ids.viewOnly, reason: 'view_only' }],
      deferred: [],
    })
    // one call with several problems answers each, and throws for none
    expect(await restore(t, f.user, [ids.early, ids.archived, ids.project])).toEqual({
      restored: [ids.project],
      refused: [{ id: ids.archived, reason: 'project_archived' }],
      deferred: [ids.early],
    })
    expect(await restore(t, f.user, [ids.early])).toEqual({
      restored: [ids.early],
      refused: [],
      deferred: [],
    })

    // billing that pauses editing pauses restoring
    await deleteTask(t, f, early.id)
    vi.stubEnv('BILLING_ENABLED', 'true')
    const again = (await itemFor(t, early.id)).id
    expect((await restore(t, f.user, [again])).refused).toEqual([
      { id: again, reason: 'read_only' },
    ])
  })

  it('refuses a subtask in a project the restorer cannot edit', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
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
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    const item = await itemFor(t, root.id)
    expect((await restore(t, rita, [item.id])).refused).toEqual([
      { id: item.id, reason: 'subtask_project' },
    ])
    // an item still moving is refused with its state
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id, project_id: f.sub2.id })
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.sub2.id)
    const moving = await itemFor(t, f.sub2.id)
    expect((await restore(t, f.user, [moving.id])).refused).toEqual([
      { id: moving.id, reason: 'moving' },
    ])
  })

  it('shares one budget across the items of a call and finishes the rest in steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++) {
      const task = await plantIssue(t, { org_id, project_id: f.sub.id })
      for (let j = 0; j < 3; j++) await comment(t, task)
      await deleteTask(t, f, task.id)
      tasks.push(task)
    }
    const items = await Promise.all(tasks.map((task) => itemFor(t, task.id)))
    TRASH_BUDGET.rows = 4
    const result = await restore(
      t,
      f.user,
      items.map((item) => item.id),
    )
    expect(result.restored).toEqual(items.map((item) => item.id))
    // the first fits in the call; the others go on in steps
    expect(await itemById(t, items[0].id)).toBeNull()
    expect((await itemById(t, items[1].id))?.state).toBe('restoring')
    expect((await itemById(t, items[2].id))?.state).toBe('restoring')
    expect(await jobFor(t, items[2].id)).not.toBeNull()
    await runSteps(t)
    for (const task of tasks) {
      expect(await liveTask(t, task.id)).not.toBeNull()
      expect((await liveRowsOf(t, task.id)).comments).toHaveLength(3)
    }
    // the call's own row names the one it revealed; each step reveal has its own
    const rows = (await activityFor(t, org_id)).filter((e) => e.verb === 'restored')
    expect(rows.map((e) => e.target_id).sort()).toEqual(tasks.map((task) => task.id).sort())
  })

  it('reveals a task item too large for what the call has left in a step of its own', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const subtasks: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++)
      subtasks.push(await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id }))
    await deleteTask(t, f, root.id, { subtask_ids: subtasks.map((s) => s.id) })
    const item = await itemFor(t, root.id)
    TRASH_BUDGET.tasks = 2
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    // the four tasks would pass the two the budget allows, so none is back yet
    expect((await itemById(t, item.id))?.state).toBe('restoring')
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_reveal' })
    for (const task of [root, ...subtasks]) expect(await liveTask(t, task.id)).toBeNull()
    // a step that starts at the reveal runs it whatever its size
    await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    for (const task of subtasks) expect((await liveTask(t, task.id))?.parent_id).toBe(root.id)
  })

  it('splits off a subtask whose project was deleted after the split, at the reveal', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    for (let i = 0; i < 3; i++) await comment(t, root)
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    const item = await itemFor(t, root.id)
    TRASH_BUDGET.rows = 1
    await restore(t, f.user, [item.id])
    // past the split, the subtask's project is still live; then it is deleted
    expect((await jobFor(t, item.id))?.phase).toBe('restore_rows')
    await deleteProject(t, f, f.sub2.id)
    const projectItem = await itemFor(t, f.sub2.id)
    TRASH_BUDGET.rows = 300
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await liveTask(t, root.id)).not.toBeNull()
    expect((await liveRowsOf(t, root.id)).comments).toHaveLength(3)
    expect(await liveTask(t, sub.id)).toBeNull()
    expect((await storedTasks(t, projectItem.id)).map((x) => x.task_id)).toEqual([sub.id])
    expect((await itemFor(t, f.sub2.id)).counts.tasks).toBe(1)
    await assertNoDanglingRefs(t, 'after a late split')
  })

  /** A task in Firmware whose subtask in Board rev has a comment, a file and
   * a link to a live task, deleted together and restored with one row per
   * step, paused once every stored row but the tasks is back in the live
   * tables. Then Board rev is deleted, so the reveal sends the restore back
   * to the split. */
  async function lateSplit() {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await comment(t, sub)
    const file = await attach(t, sub)
    await plantHistory(t, sub, { listed: 2, unlisted: 1 })
    const other = await plantIssue(t, { org_id, project_id: f.sub.id })
    await t.run((ctx) =>
      ctx.db.insert('issue_links', {
        org_id,
        id: uuid(),
        source_id: sub.id,
        target_id: other.id,
        type: 'relates',
        pair_key: [sub.id, other.id].sort().join(':'),
        created_at: NOW,
      }),
    )
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    const item = await itemFor(t, root.id)
    TRASH_BUDGET.rows = 1
    await restore(t, f.user, [item.id])
    for (let i = 0; (await storedRows(t, item.id)).some((r) => r.table !== 'issues'); i++) {
      expect(i).toBeLessThan(20)
      await step(t, item.id)
    }
    expect((await jobFor(t, item.id))?.phase).toBe('restore_links')
    const back = await liveRowsOf(t, sub.id)
    expect([back.comments, back.issue_attachments, back.issue_links].map((r) => r.length)).toEqual([
      1, 1, 1,
    ])
    TRASH_BUDGET.rows = 300
    await deleteProject(t, f, f.sub2.id)
    return { t, f, root, sub, file, item, projectItem: await itemFor(t, f.sub2.id) }
  }

  it('moves the rows a late split finds back in the live tables with the subtask', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { t, root, sub, file, item, projectItem } = await lateSplit()
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await liveTask(t, root.id)).not.toBeNull()
    expect(await liveTask(t, sub.id)).toBeNull()
    // nothing of the subtask stays live; it all waits in its project's item
    expect(await liveRowsOf(t, sub.id)).toEqual({
      comments: [],
      issue_labels: [],
      issue_subscriptions: [],
      issue_attachments: [],
      issue_links: [],
    })
    const owned = (await storedRows(t, projectItem.id)).filter((r) => r.owner_id === sub.id)
    expect(owned.map((r) => r.table).sort()).toEqual([
      'comments',
      'issue_attachments',
      'issue_links',
      'issues',
    ])
    // with its history: the planted rows and its delete
    expect(await historyOf(t, sub.id)).toHaveLength(4)
    await assertNoDanglingRefs(t, 'after a late split moved the rows back')
    // and the project item's purge takes all of it, the bytes included
    await t.run(async (ctx) => startPurge(ctx, (await byId(ctx, 'deleted_items', projectItem.id))!))
    await runSteps(t)
    expect(await itemById(t, projectItem.id)).toBeNull()
    expect(await blobExists(t, file.storage_id)).toBe(false)
    await assertNoDanglingRefs(t, 'after the project item of a late split was purged')
  })

  it('deletes the rows a late split finds back once the subtask is gone for good', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { t, root, sub, file, item, projectItem } = await lateSplit()
    // the project item is purged before the restore reaches its reveal
    await t.run(async (ctx) => startPurge(ctx, projectItem, { inline: true }))
    await runSteps(t)
    expect(await itemById(t, projectItem.id)).toBeNull()
    await stepThrough(t, item.id)
    expect(await liveTask(t, root.id)).not.toBeNull()
    expect(await liveTask(t, sub.id)).toBeNull()
    expect(await liveRowsOf(t, sub.id)).toEqual({
      comments: [],
      issue_labels: [],
      issue_subscriptions: [],
      issue_attachments: [],
      issue_links: [],
    })
    expect(await blobExists(t, file.storage_id)).toBe(false)
    expect(await historyOf(t, sub.id)).toEqual([])
    await assertNoDanglingRefs(t, 'after a late split deleted the subtask for good')
    await assertNoOrphanHistory(t, 'after a late split deleted the subtask for good')
  })

  it('defers what waits for a project item of the same call, whatever the order of the ids', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f, task.id)
    await deleteProject(t, f, f.sub.id)
    await deleteProject(t, f, f.meta.id)
    const ids = {
      task: (await itemFor(t, task.id)).id,
      sub: (await itemFor(t, f.sub.id)).id,
      meta: (await itemFor(t, f.meta.id)).id,
    }
    // Firmware waits for Testbed platform, and the task for Firmware
    expect(await restore(t, f.admin, [ids.task, ids.sub, ids.meta])).toEqual({
      restored: [ids.meta],
      refused: [],
      deferred: [ids.sub, ids.task],
    })
    expect(await restore(t, f.admin, [ids.task, ids.sub])).toEqual({
      restored: [ids.sub],
      refused: [],
      deferred: [ids.task],
    })
    expect((await restore(t, f.admin, [ids.task])).restored).toEqual([ids.task])
    expect(await liveTask(t, task.id)).not.toBeNull()
  })
})

describe('the storage files bill', () => {
  /** The bytes storageUsage bills the organization for, by project id. */
  const billed = async (t: T, orgId: string) => {
    const usage = await t.run((ctx) => storageUsage(ctx, orgId))
    return {
      bytes: usage.bytes,
      projects: Object.fromEntries(usage.projects.map((p) => [p.project_id, p.storage_bytes])),
    }
  }
  /** The size of each live attachment row of `taskId`, smallest first. A
   * row names no project; storageUsage bills it under its task's. */
  const filesOf = (t: T, taskId: string) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('issue_attachments')
          .withIndex('by_issue', (q) => q.eq('issue_id', taskId))
          .collect()
      )
        .map((row) => row.size_bytes)
        .sort((a, b) => a - b),
    )

  it("bills a task's files again under its project once it comes back", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    for (const size of [11, 13, 17]) await attach(t, task, size)
    const other = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await attach(t, other, 5)
    const before = { bytes: 46, projects: { [f.sub.id]: 41, [f.sub2.id]: 5 } }
    expect(await billed(t, org_id)).toEqual(before)

    await deleteTask(t, f, task.id)
    expect(await filesOf(t, task.id)).toEqual([])
    expect(await billed(t, org_id)).toEqual({ bytes: 5, projects: { [f.sub2.id]: 5 } })

    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    expect(await filesOf(t, task.id)).toEqual([11, 13, 17])
    expect(await billed(t, org_id)).toEqual(before)
    await assertNoDanglingRefs(t, 'after the files of a task came back')
  })

  it("bills a project's files nowhere until its reveal, then under each task's project", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const inSub = await plantIssue(t, { org_id, project_id: f.sub.id })
    await attach(t, inSub, 11)
    const inSub2 = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await attach(t, inSub2, 3)
    await attach(t, inSub2, 7)
    const elsewhere = await plantIssue(t, { org_id, project_id: f.hidden.id })
    await attach(t, elsewhere, 5)
    const before = { bytes: 26, projects: { [f.sub.id]: 11, [f.sub2.id]: 10, [f.hidden.id]: 5 } }
    expect(await billed(t, org_id)).toEqual(before)
    const away = { bytes: 5, projects: { [f.hidden.id]: 5 } }

    // the files stop counting with the delete, before the steps move them
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('moving')
    expect((await filesOf(t, inSub2.id)).length).toBeGreaterThan(0)
    expect(await billed(t, org_id)).toEqual(away)
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await runSteps(t)
    expect((await itemFor(t, f.meta.id)).state).toBe('ready')
    expect(await billed(t, org_id)).toEqual(away)

    // written back while the projects are absent, they still count nowhere
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 40 })
    await restore(t, f.user, [item.id])
    let sawFilesBack = false
    await stepThrough(t, item.id, async () => {
      if ((await liveProject(t, f.meta.id)) !== null) return
      if ((await filesOf(t, inSub2.id)).length > 0) sawFilesBack = true
      expect(await billed(t, org_id)).toEqual(away)
    })
    expect(sawFilesBack).toBe(true)
    expect(await filesOf(t, inSub.id)).toEqual([11])
    expect(await filesOf(t, inSub2.id)).toEqual([3, 7])
    expect(await billed(t, org_id)).toEqual(before)
    await assertNoDanglingRefs(t, 'after the files of a project came back')
  })

  it('bills the files of a subtask a split hands over after the fill under its project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await attach(t, sub, 7)
    // more tasks in Board rev, so its item's restore_tasks takes steps
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id, project_id: f.sub2.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    const taskItem = await itemFor(t, root.id)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const projectItem = await itemFor(t, f.sub2.id)

    // Board rev's item stops inside restore_tasks, past its rows
    TRASH_BUDGET.tasks = 1
    await restore(t, f.user, [projectItem.id])
    expect(await jobFor(t, projectItem.id)).toMatchObject({ phase: 'restore_tasks' })
    // the task's restore hands the subtask and its file to that item
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await restore(t, f.user, [taskItem.id])
    expect((await storedTasks(t, projectItem.id)).map((x) => x.task_id)).toContain(sub.id)

    // its fill writes the subtask, then its reveal meets the file late
    TRASH_BUDGET.tasks = 1
    await stepThrough(t, projectItem.id)
    expect((await liveTask(t, sub.id))?.parent_id).toBe(root.id)
    expect(await filesOf(t, sub.id)).toEqual([7])
    expect((await billed(t, org_id)).projects[f.sub2.id]).toBe(7)
    await assertNoDanglingRefs(t, 'after a split subtask and its file came back')
  })
})
