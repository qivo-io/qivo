/* Deleted items: restoring (model/deletedItems.ts restoreItems, design 5).
 *
 * A restore writes the stored rows back while what they name is still
 * absent, then reveals the item in one transaction. These tests restore
 * through the model entry the public restore calls (deletedItemsRows.test.ts
 * covers its visibility fence), read both the live tables and the trash,
 * and drive the steps one at a time on fake timers, with lowered budgets so
 * that many-step paths run on small data. */
/// <reference types="vite/client" />

import { describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { projectLevel } from '../lib/access'
import { byId } from '../lib/db'
import { LIMITS, MIB, PARENT_IS_SUBTASK, SUBTASK_WITH_SUBTASKS } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import type { EventOwner } from '../lib/taskEvents'
import {
  CALL,
  COUNT_READ,
  LEGACY_READ,
  newMemo,
  RETRY,
  type RestoreResult,
  restoreItems,
  runStep,
  STALLED_MS,
  startPurge,
  TRASH_BUDGET,
  viewOf,
} from '../model/deletedItems'
import { SUBTASK_PROJECT_RULE } from '../model/issues'
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
  withReadingAdmin,
} from './helpers.setup'
import { liveAttachmentUsage } from './liveAttachments.setup'
import { assertNoDanglingRefs } from './refs.setup'
import {
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

/* The bytes a transaction reads and a step spends at a 48th, for the cases
 * that plant descriptions at the 20,000-character cap (LEGACY_TEXT, about a
 * 48th of 950 KiB) where legacy rows near 1 MiB from before the cap were
 * planted against the real limits. */
const SCALED = { bytesRead: (16 * MIB) / 48, step: DEFAULT_BUDGET.bytes / 48 }
const LEGACY_TEXT = 'Field note. '.repeat(1_666)

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
/** Grants on Board rev for the guest and the admin, which its project
 * item stores, so a restore past its reveal has stored grants to delete. */
const grantsOnSub2 = (t: T, f: OrgFixture) =>
  t.run(async (ctx) => {
    for (const who of [f.guest, f.admin])
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: who.id,
        level: 'user',
      })
  })
const patch = (
  t: T,
  table: 'issues' | 'projects' | 'profiles' | 'deleted_items',
  id: string,
  fields: object,
) =>
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
    const f = await withReadingAdmin(t)
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
      stepping: [],
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
    const f = await withReadingAdmin(t)
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
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
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

  it('brings a subtask deleted alone back top-level when its parent moved to another top-level project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
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

  it('brings a subtask deleted alone back top-level when its parent moved to another sub-project of the same top-level project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const child = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, child.id)
    await as(t, f.user).mutation(api.issues.move, { org_id, id: parent.id, project_id: f.sub2.id })

    const item = await itemFor(t, child.id)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    const back = await liveTask(t, child.id)
    expect(back?.project_id).toBe(f.sub.id)
    expect(back?.parent_id).toBeUndefined()
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
  })

  it('keeps a parent only while it is a top-level task, as a reparent requires', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const task = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    // a top-level parent: the task comes back under it
    await deleteTask(t, f, task.id)
    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    expect((await liveTask(t, task.id))?.parent_id).toBe(parent.id)
    // the parent became a subtask while the task was in Deleted items, which
    // a reparent allows once the task has left it, so the task comes back
    // top-level and the chain stays as it is
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

  it(`keeps a parent with ${LIMITS.subtasks.max - 1} active subtasks and none with ${LIMITS.subtasks.max}, archived ones aside`, async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const [first, second] = [
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id }),
    ]
    for (const task of [first, second]) await deleteTask(t, f, task.id)
    // the parent gets 99 active subtasks while they are in Deleted items,
    // and 10 archived ones, which do not count
    await plantSubtasks(t, f, parent.id, LIMITS.subtasks.max - 1 + 10, 10)
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
    expect(refused.data.message).toBe(LIMITS.subtasks.refusal)

    // two items restored in one call count the reveal before them: only one
    // of them becomes the hundredth active subtask of a parent with 99
    const other = await plantIssue(t, { org_id, project_id: f.sub.id })
    const pair = [
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: other.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: other.id }),
    ]
    for (const task of pair) await deleteTask(t, f, task.id)
    await plantSubtasks(t, f, other.id, LIMITS.subtasks.max - 1 + 5, 5)
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
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const task = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, task.id)
    // three subtasks, past a count bound lowered to 500 bytes
    for (let i = 0; i < 3; i++)
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    COUNT_READ.bytes = 500
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

  it('brings a subtask back under its parent without a person who lost access to the sub-project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    // the guest edits Firmware and Board rev through grants of their own
    await plantHiddenSibling(t, f, f.guest)
    const parent = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const plantSubtask = () =>
      plantIssue(t, {
        org_id,
        project_id: f.sub2.id,
        parent_id: parent.id,
        assignee_id: f.guest.id,
        reviewer_id: f.guest.id,
      })
    const deleteAndRestore = async (task: Doc<'issues'>) => {
      await deleteTask(t, f, task.id)
      const item = await itemFor(t, task.id)
      expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
      return await liveTask(t, task.id)
    }
    // while the guest can see Board rev, the subtask comes back under the
    // parent with them
    expect(await deleteAndRestore(await plantSubtask())).toMatchObject({
      parent_id: parent.id,
      assignee_id: f.guest.id,
      reviewer_id: f.guest.id,
    })
    // the guest is left on a subtask after losing Board rev, planted as
    // rows. The restore drops them from it (keepsHolder) and keeps the
    // parent
    const left = await plantSubtask()
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.sub2.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant === null) throw new Error('the guest holds no grant on Board rev')
      await ctx.db.delete(grant._id)
    })
    const back = await deleteAndRestore(left)
    expect(back?.parent_id).toBe(parent.id)
    expect([back?.assignee_id, back?.reviewer_id]).toEqual([undefined, undefined])
  })

  it(`brings a task back with its ${LIMITS.subtasks.max} subtasks and their people, within the real limits`, async () => {
    // the most active subtasks a task can have, each with a person of its
    // own whose assignment the reveal checks (keepsHolder)
    const t = newT({ transactionLimits: true })
    chargeFilteredReads()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const root = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const people = await plantPeople(t, f, LIMITS.subtasks.max)
    const subtasks = await plantAssigned(t, f, root.id, people)
    await deleteTask(t, f, root.id, { subtask_ids: subtasks })
    await runSteps(t)
    const item = await itemFor(t, root.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: LIMITS.subtasks.max + 1 } })

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
  })

  it('deletes the search rows of a family of LIMITS.subtasks.max subtasks in steps after its reveal, within a lowered step budget', async () => {
    // each deleted_tasks row holds its task's searchable text, which at the
    // description cap in a three-byte script is about 60 KB, so the reveal
    // leaves them to steps; here the rows a step may delete are lowered so a
    // family of ordinary text needs several of them
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const description = 'Check the fixture alignment first. Record the readings in the notebook.'
    const root = await plantIssue(t, { org_id, project_id: f.sub.id, description })
    const subtasks: string[] = []
    for (let i = 0; i < LIMITS.subtasks.max; i++)
      subtasks.push(
        (await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id, description })).id,
      )
    await deleteTask(t, f, root.id, { subtask_ids: subtasks })
    await runSteps(t)
    const item = await itemFor(t, root.id)
    expect(await storedTasks(t, item.id)).toHaveLength(LIMITS.subtasks.max + 1)
    TRASH_BUDGET.rows = 10
    const most = TRASH_BUDGET.rows

    expect((await restore(t, f.user, [item.id])).stepping).toEqual([item.id])
    // each step as deletedItems.step runs it, with the documents it read
    const trail: { live: boolean; left: number; read: number }[] = []
    for (let i = 0; (await itemById(t, item.id)) !== null; i++) {
      expect(i).toBeLessThan(100)
      const read = await t.run(async (ctx) => {
        await runStep(ctx, item.id)
        return (await ctx.meta.getTransactionMetrics()).documentsRead.used
      })
      trail.push({
        live: (await liveTask(t, root.id)) !== null,
        left: (await storedTasks(t, item.id)).length,
        read,
      })
    }
    // the step that brought the family back deleted none of its rows
    const revealed = trail.findIndex((s) => s.live)
    expect(trail[revealed].left).toBe(LIMITS.subtasks.max + 1)
    // each step after it deleted some within the step's budget, reading
    // those rows, each once more to delete it, and a few documents of its own
    const cleared = trail.slice(revealed + 1)
    expect(cleared.length).toBeGreaterThan(5)
    let left = trail[revealed].left
    for (const s of cleared) {
      expect(s.live).toBe(true)
      expect(left - s.left).toBeGreaterThan(0)
      expect(left - s.left).toBeLessThanOrEqual(most)
      expect(s.read).toBeLessThanOrEqual(2 * most + 30)
      left = s.left
    }
    expect(left).toBe(0)
    // the family is back whole, and nothing of it is left in Deleted items
    expect(await jobFor(t, item.id)).toBeNull()
    for (const id of subtasks) expect((await liveTask(t, id))?.parent_id).toBe(root.id)
    expect(await storedRows(t, item.id)).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('deleted_tasks').collect())).toEqual([])
  })

  it('reveals in a step of its own when the restore call runs out of reads before it counts the subtasks of the parent', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    const task = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    // a subtask with a stored row, which the call writes back before its
    // reveal; the next case restores one without
    await comment(t, task)
    await deleteTask(t, f, task.id)
    // the call, a quarter of a step, has bytes left after the fill for the
    // reveal and not for counting the subtasks of the parent
    TRASH_BUDGET.bytes = 8_000

    const item = await itemFor(t, task.id)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_reveal' })
    expect(await liveTask(t, task.id)).toBeNull()
    // the step of its own counts them whole and keeps the parent
    await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect((await liveTask(t, task.id))?.parent_id).toBe(parent.id)
  })

  it('reveals a subtask without rows in a step of its own when the restore call runs out of reads before it counts the subtasks of the parent', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    // a parent with two other active subtasks
    const parent = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantSubtasks(t, f, parent.id, 2)
    const task = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: parent.id })
    await deleteTask(t, f, task.id)
    TRASH_BUDGET.bytes = 8_000

    const item = await itemFor(t, task.id)
    expect(await restore(t, f.user, [item.id])).toMatchObject({
      restored: [item.id],
      stepping: [item.id],
    })
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_reveal' })
    expect(await liveTask(t, task.id)).toBeNull()
    await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect((await liveTask(t, task.id))?.parent_id).toBe(parent.id)
  })

  it('drops references whose uuid now names something created after the delete', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
      stepping: [],
      refused: [{ id: item.id, reason: 'project_deleted' }],
      deferred: [],
    })
    expect((await itemById(t, item.id))?.state).toBe('ready')
  })

  it('restores a task linked to 30 large tasks in steps, within limits a 48th of the real ones', async () => {
    // the bytes a transaction reads and a step spends at a 48th, as 30
    // legacy tasks of 950 KiB were under the real ones
    const t = newT({ transactionLimits: { bytesRead: SCALED.bytesRead } })
    TRASH_BUDGET.bytes = SCALED.step
    chargeFilteredReads()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    // descriptions at the cap, as 950 KiB from before the cap were to the
    // real limits
    const description = LEGACY_TEXT
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
  })

  it('moves a link to the item that holds its other end, and drops one whose end is gone', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
   * travel with `a`, deleted first, and `b` deleted with its subtask.
   * `links` holds the links as they come back. */
  async function linkedItems() {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    const back = links.map(strip)
    return { t, f, a, b, items, links: back.sort(byLinkId), byLinkId }
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

  it('drops the archive marks, schedules them once, and restarts the done clock', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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

describe('project copies', () => {
  it('brings a project item back with every field each project had', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const projects = [f.meta, f.sub, f.sub2]
    // the name keys and archive states a reveal writes, so every other
    // field comes back as it was
    for (const p of projects)
      await patch(t, 'projects', p.id, { name_key: nameKey(p.name), archive_state: 'live' })
    const before = await Promise.all(projects.map((p) => liveProject(t, p.id)))
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    const stored = (await storedRows(t, item.id)).flatMap((row) =>
      row.row.table === 'projects' ? [row.row.doc] : [],
    )
    expect(stored).toHaveLength(3)

    await restore(t, f.user, [item.id])
    await runSteps(t)
    for (const [i, p] of projects.entries()) {
      const back = await liveProject(t, p.id)
      const { _id: _oldId, _creationTime: _oldTime, ...was } = before[i] ?? p
      const { _id: _newId, _creationTime: _newTime, ...now } = back ?? p
      expect(now).toStrictEqual(was)
    }
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
    const f = await withReadingAdmin(t)
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
    const history = await as(t, f.admin).query(api.snapshot.threadHistory, {
      org_id,
      issue_id: root.id,
    })
    expect(history.events.map((e) => e.verb)).toEqual(verbs)
    // no row of the organization is gone
    expect(await activityFor(t, org_id)).toHaveLength(3 + 1 + 600 + 1)
    for (const other of others) expect(await historyOf(t, other.id)).toHaveLength(300)
  })

  it('sends the Restored notice only for a task item restored alone, and one activity row per call', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    const f = await withReadingAdmin(t)
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
    const f = await withReadingAdmin(t)
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

describe('a project item while it moves', () => {
  it('shows the projects a live grant still reaches to the people it reached before', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [lead] = await plantPeople(t, f, 1)
    const third = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    // the person leads Firmware and reaches Board rev only through a grant
    await t.run(async (ctx) => {
      const own = await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', lead))
        .unique()
      if (own !== null) await ctx.db.delete(own._id)
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: lead,
        level: 'user',
      })
    })
    await patch(t, 'projects', f.sub.id, { lead_id: lead })
    // one row a step, so the delete leaves the grant live
    TRASH_BUDGET.rows = 1
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    const seen = () =>
      t.run(async (ctx) => {
        const me = await byId(ctx, 'profiles', lead)
        const now = await byId(ctx, 'deleted_items', item.id)
        if (me === null || now === null) throw new Error('missing')
        const view = await viewOf(ctx, newMemo(), me, now)
        return { state: now.state, projects: view?.projects.map((p) => p.id).sort() ?? null }
      })
    const expected = [f.meta.id, f.sub.id, f.sub2.id].sort()
    const live = await t.run((ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.sub2.id).eq('profile_id', lead),
        )
        .unique(),
    )
    expect(live).not.toBeNull()
    expect(await seen()).toEqual({ state: 'moving', projects: expected })
    expect(expected).not.toContain(third.id)
    await runSteps(t)
    expect(await seen()).toEqual({ state: 'ready', projects: expected })
  })
})

describe('a project item read over grants stored before grantees', () => {
  it('counts them up to LEGACY_READ for an item deleted before GRANTEE_SINCE, and only then', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [lead] = await plantPeople(t, f, 1)
    // the person leads Firmware and reaches Board rev only through a grant
    await t.run(async (ctx) => {
      const own = await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', lead))
        .unique()
      if (own !== null) await ctx.db.delete(own._id)
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: lead,
        level: 'user',
      })
    })
    await patch(t, 'projects', f.sub.id, { lead_id: lead })
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    const seenBy = (id: string) =>
      t.run(async (ctx) => {
        const me = await byId(ctx, 'profiles', id)
        const now = await byId(ctx, 'deleted_items', item.id)
        if (me === null || now === null) throw new Error('missing')
        const view = await viewOf(ctx, newMemo(), me, now)
        return { projects: view?.projects.map((p) => p.id) ?? [] }
      })
    expect((await seenBy(lead)).projects).toContain(f.sub2.id)
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('deleted_rows').collect())
        if (row.grantee !== undefined) await ctx.db.patch(row._id, { grantee: undefined })
    })
    // read without their grantee, as the release before stored them
    expect((await seenBy(lead)).projects).toContain(f.sub2.id)
    // past what one read takes they count for nobody
    LEGACY_READ.max = 1
    expect((await seenBy(lead)).projects).not.toContain(f.sub2.id)
    LEGACY_READ.max = 100
    // an item deleted since GRANTEE_SINCE holds none, so none is read
    await patch(t, 'deleted_items', item.id, { deleted_at: '2026-11-01T00:00:00.000Z' })
    expect((await seenBy(lead)).projects).not.toContain(f.sub2.id)
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('deleted_rows').collect())
        if (row.row.table === 'project_access' || row.row.table === 'project_team_access')
          await ctx.db.patch(row._id, {
            grantee:
              row.row.table === 'project_access' ? row.row.doc.profile_id : row.row.doc.team_id,
          })
    })
    expect((await seenBy(lead)).projects).toContain(f.sub2.id)
  })
})

describe('restoring a project item', () => {
  /** `profileId`'s level on live project `projectId`, or null. */
  const levelOn = (t: T, profileId: string, projectId: string) =>
    t.run(async (ctx) => {
      const profile = await byId(ctx, 'profiles', profileId)
      const project = await byId(ctx, 'projects', projectId)
      return profile === null || project === null ? null : projectLevel(ctx, profile, project)
    })

  it('shows the projects to the people and teams they are shared with as it shows them to their lead', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [team] = await plantTeams(t, f, 1)
    const [person, member] = await plantPeople(t, f, 2)
    // the member's access comes only from a team share on one sub-project
    await t.run(async (ctx) => {
      const own = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', member),
        )
        .unique()
      if (own !== null) await ctx.db.delete(own._id)
      await ctx.db.insert('team_members', { team_id: team, profile_id: member, is_leader: false })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: team,
        level: 'user',
      })
    })
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(await levelOn(t, person, f.meta.id)).toBeNull()

    // one row a step, so the reveal and the steps after it run apart
    TRASH_BUDGET.rows = 1
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    let revealed = false
    await stepThrough(t, item.id, async () => {
      if ((await liveProject(t, f.meta.id)) === null) return
      revealed = true
      expect(await levelOn(t, f.user.id, f.meta.id)).toBe('lead')
      expect(await levelOn(t, person, f.meta.id)).toBe('user')
      expect(await levelOn(t, member, f.sub.id)).toBe('user')
      expect(await levelOn(t, member, f.sub2.id)).toBeNull()
    })
    expect(revealed).toBe(true)
    // each grant and share comes back once
    const rows = await t.run(async (ctx) => ({
      grants: await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', person))
        .collect(),
      shares: await ctx.db
        .query('project_team_access')
        .withIndex('by_team', (q) => q.eq('team_id', team))
        .collect(),
      stored: await ctx.db.query('deleted_rows').collect(),
    }))
    expect(rows.grants).toHaveLength(1)
    expect(rows.shares).toHaveLength(1)
    expect(rows.stored).toEqual([])
  })

  it('keeps the people of deferred items restored as soon as the project shows again', async () => {
    // eight grants, more than one step writes back at three rows a step
    const t = newT()
    const f = await withReadingAdmin(t)
    const people = await plantPeople(t, f, 8)
    const third = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const inThird = await plantIssue(t, {
      org_id: f.org.id,
      project_id: third.id,
      assignee_id: people[0],
    })
    const inSub = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: people[1],
    })
    await deleteProject(t, f, third.id)
    await deleteTask(t, f, inSub.id)
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const [project, sub, task] = await Promise.all(
      [f.meta.id, third.id, inSub.id].map((id) => itemFor(t, id)),
    )
    TRASH_BUDGET.rows = 3
    const first = await restore(t, f.user, [project.id, sub.id, task.id])
    expect(first.deferred.sort()).toEqual([sub.id, task.id].sort())
    // the client sends the deferred items again once the project shows
    for (let i = 0; (await liveProject(t, f.meta.id)) === null; i++) {
      expect(i).toBeLessThan(50)
      await step(t, project.id)
    }
    const again = await restore(t, f.user, [sub.id, task.id])
    expect(again.restored.sort()).toEqual([sub.id, task.id].sort())
    await runSteps(t)
    expect((await liveTask(t, inThird.id))?.assignee_id).toBe(people[0])
    expect((await liveTask(t, inSub.id))?.assignee_id).toBe(people[1])
  })

  it('writes no grant under a project deleted again before its stored grants are gone', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const people = await plantPeople(t, f, 8)
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    TRASH_BUDGET.rows = 3
    await restore(t, f.user, [item.id])
    for (let i = 0; (await liveProject(t, f.meta.id)) === null; i++) {
      expect(i).toBeLessThan(50)
      await step(t, item.id)
    }
    expect((await storedRows(t, item.id)).some((r) => r.table === 'project_access')).toBe(true)
    // a step was lost before the rest went, and the lead deletes it again
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('project_access').collect())
        if (row.profile_id === people[7]) await ctx.db.delete(row._id)
    })
    TRASH_BUDGET.rows = 300
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    const again = await itemFor(t, f.meta.id)
    expect(again.state).toBe('ready')
    const live = await t.run((ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
        .collect(),
    )
    expect(live).toEqual([])
    const stored = (await storedRows(t, again.id))
      .filter((r) => r.table === 'project_access' && r.owner_id === f.meta.id)
      .map((r) => r.grantee)
    expect(new Set(stored).size).toBe(stored.length)
    expect(stored).toEqual(expect.arrayContaining(people.slice(0, 7)))
    expect(stored).not.toContain(people[7])
  })

  it('writes back only the grants and shares whose people and teams pass the restore rules', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [team, gone] = await plantTeams(t, f, 2)
    const [kept, demoted, removed] = await plantPeople(t, f, 3)
    await t.run(async (ctx) => {
      for (const team_id of [team, gone])
        await ctx.db.insert('project_team_access', { project_id: f.sub.id, team_id, level: 'user' })
    })
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    // while it waits in Deleted items, one person becomes a viewer, one is
    // removed and one team is deleted
    await patch(t, 'profiles', demoted, { org_role: 'viewer' })
    await t.run(async (ctx) => {
      const profile = await byId(ctx, 'profiles', removed)
      if (profile !== null) await ctx.db.delete(profile._id)
      const row = await byId(ctx, 'teams', gone)
      if (row !== null) await ctx.db.delete(row._id)
    })
    TRASH_BUDGET.rows = 2
    await restore(t, f.user, [item.id])
    await runSteps(t)
    const access = await t.run(async (ctx) => ({
      grants: (
        await ctx.db
          .query('project_access')
          .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
          .collect()
      ).map((g) => [g.profile_id, g.level]),
      shares: (
        await ctx.db
          .query('project_team_access')
          .withIndex('by_project', (q) => q.eq('project_id', f.sub.id))
          .collect()
      ).map((g) => g.team_id),
    }))
    expect(access.grants).toEqual(
      expect.arrayContaining([
        [kept, 'user'],
        [demoted, 'viewer'],
      ]),
    )
    expect(access.grants.map(([id]) => id)).not.toContain(removed)
    expect(access.shares).toEqual([team])
  })

  it('keeps a grant or share removed between the reveal and the end of its stored grants removed', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [team] = await plantTeams(t, f, 1)
    const people = await plantPeople(t, f, 8)
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', { project_id: f.sub.id, team_id: team, level: 'user' }),
    )
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    TRASH_BUDGET.rows = 3
    await restore(t, f.user, [item.id])
    for (let i = 0; (await liveProject(t, f.meta.id)) === null; i++) {
      expect(i).toBeLessThan(50)
      await step(t, item.id)
    }
    expect((await storedRows(t, item.id)).some((r) => r.table === 'project_access')).toBe(true)
    // an admin removes a grant and the share while the stored copies wait
    await t.run(async (ctx) => {
      for (const g of await ctx.db.query('project_access').collect())
        if (g.profile_id === people[0]) await ctx.db.delete(g._id)
      for (const g of await ctx.db.query('project_team_access').collect())
        if (g.team_id === team) await ctx.db.delete(g._id)
    })
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    const left = await t.run(async (ctx) => ({
      grants: (await ctx.db.query('project_access').collect()).map((g) => g.profile_id),
      shares: (await ctx.db.query('project_team_access').collect()).map((g) => g.team_id),
    }))
    expect(left.grants).not.toContain(people[0])
    expect(left.grants).toContain(people[1])
    expect(left.shares).not.toContain(team)
  })

  it('sets the grantee of more stored grants than one read takes before it checks the people', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [worker] = await plantPeople(t, f, 4)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: worker,
    })
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('deleted_rows').collect())
        if (row.grantee !== undefined) await ctx.db.patch(row._id, { grantee: undefined })
    })
    // six grants without a grantee, past what one read takes, count for
    // nobody until the restore names them
    LEGACY_READ.max = 2
    expect(await restore(t, f.user, [item.id])).toMatchObject({ restored: [item.id] })
    await runSteps(t)
    expect((await liveTask(t, task.id))?.assignee_id).toBe(worker)
  })

  it('writes back the grants of a restore the release before left at its reveal or after it', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [person] = await plantPeople(t, f, 1)
    const grantOf = () =>
      t.run((ctx) =>
        ctx.db
          .query('project_access')
          .withIndex('by_project_profile', (q) =>
            q.eq('project_id', f.meta.id).eq('profile_id', person),
          )
          .unique(),
      )
    const asLeftBefore = (itemId: string, phase: 'restore_reveal' | 'restore_grants') =>
      t.run(async (ctx) => {
        const job = await ctx.db
          .query('deleted_item_jobs')
          .withIndex('by_item', (q) => q.eq('item_id', itemId))
          .unique()
        if (job === null) throw new Error('no job')
        await ctx.db.patch(job._id, { phase, cursor: undefined, granted: undefined })
      })
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    TRASH_BUDGET.rows = 1
    // at its reveal, before restore_access existed
    const first = await itemFor(t, f.meta.id)
    await restore(t, f.user, [first.id])
    await asLeftBefore(first.id, 'restore_reveal')
    for (let i = 0; (await liveProject(t, f.meta.id)) === null; i++) {
      expect(i).toBeLessThan(50)
      await step(t, first.id)
    }
    expect(await grantOf()).not.toBeNull()
    await runSteps(t)
    // past its reveal, with the grants not yet written back
    TRASH_BUDGET.rows = 300
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const second = await itemFor(t, f.meta.id)
    TRASH_BUDGET.rows = 1
    await restore(t, f.user, [second.id])
    for (let i = 0; (await liveProject(t, f.meta.id)) === null; i++) {
      expect(i).toBeLessThan(50)
      await step(t, second.id)
    }
    await t.run(async (ctx) => {
      for (const g of await ctx.db.query('project_access').collect())
        if (g.project_id === f.meta.id) await ctx.db.delete(g._id)
    })
    await asLeftBefore(second.id, 'restore_grants')
    await runSteps(t)
    expect(await itemById(t, second.id)).toBeNull()
    expect(await grantOf()).not.toBeNull()
  })

  it('refuses a restore whose reveal in the call finds a live project holding its key', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    // the reservations should prevent this; the reveal checks it anyway
    await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id, key: 'PCB' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await restore(t, f.user, [item.id])).toMatchObject({
      restored: [],
      refused: [{ id: item.id, reason: 'conflict' }],
    })
    await runSteps(t)
    expect(await itemById(t, item.id)).toMatchObject({ state: 'ready' })
    expect(await liveProject(t, f.sub2.id)).toBeNull()
  })

  it('stores a grant once when a restore that wrote it back goes back to moving', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [person] = await plantPeople(t, f, 1)
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    TRASH_BUDGET.rows = 1
    await restore(t, f.user, [item.id])
    const liveGrants = () =>
      t.run((ctx) =>
        ctx.db
          .query('project_access')
          .withIndex('by_profile', (q) => q.eq('profile_id', person))
          .collect(),
      )
    for (let i = 0; (await liveGrants()).length === 0; i++) {
      expect(i).toBeLessThan(50)
      await step(t, item.id)
    }
    expect(await liveProject(t, f.meta.id)).toBeNull()
    // the grant is back and still stored when the restorer loses the lead
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'projects').eq('row_id', f.meta.id))
        .unique()
      if (row === null || row.row.table !== 'projects') throw new Error('no stored project')
      await ctx.db.patch(row._id, {
        row: { ...row.row, doc: { ...row.row.doc, lead_id: undefined } },
      })
    })
    await runSteps(t)
    expect((await itemById(t, item.id))?.state).toBe('ready')
    const stored = await storedRows(t, item.id)
    expect(stored.filter((r) => r.table === 'project_access' && r.grantee === person)).toHaveLength(
      1,
    )
    expect(await liveGrants()).toEqual([])
  })

  it('brings the project back with its key, number, lead, grants, milestones and tasks', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    await patch(t, 'projects', f.sub2.id, { lead_id: f.admin.id })
    const sub2 = (await liveProject(t, f.sub2.id)) as Doc<'projects'>
    const own = await t.run(async (ctx) => {
      // keyed as their writers key them, which a restore keeps
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: f.viewer.id,
        level: 'viewer',
        name_key: nameKey(f.viewer.name),
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
        name_key: nameKey(f.team.name),
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
      stepping: [],
      refused: [{ id: item.id, reason: 'not_lead' }],
      deferred: [],
    })
    expect(await restore(t, f.admin, [item.id])).toEqual({
      restored: [item.id],
      stepping: [],
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
    const f = await withReadingAdmin(t)
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
    // subtasks planted before their parent, in its sub-project, and a link
    // out to another top-level project
    const first = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const second = await plantIssue(t, { org_id, project_id: f.sub2.id })
    const top = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await patch(t, 'issues', first.id, { parent_id: top.id })
    await patch(t, 'issues', second.id, { parent_id: top.id })
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
    const all = [...tasks, first, second, top]
    TRASH_BUDGET.ranges = 60
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('ready')
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
    const steps = await stepThrough(t, item.id, async () => {
      const job = await jobFor(t, item.id)
      if (job === null || job.phase === 'restore_grants') return
      // until the reveal the projects stay absent, even with tasks back
      await projectsAbsent()
      if ((await liveTask(t, top.id)) !== null || (await liveTask(t, tasks[0].id)) !== null)
        sawHiddenTasks = true
    })
    expect(steps).toBeGreaterThan(4)
    expect(sawHiddenTasks).toBe(true)

    for (const p of [f.meta, f.sub, f.sub2]) expect(await liveProject(t, p.id)).not.toBeNull()
    for (const task of all) expect(await liveTask(t, task.id)).not.toBeNull()
    expect((await liveTask(t, first.id))?.parent_id).toBe(top.id)
    expect((await liveTask(t, second.id))?.parent_id).toBe(top.id)
    expect((await liveRowsOf(t, top.id)).issue_links).toHaveLength(1)
    expect((await liveRowsOf(t, outsider.id)).issue_links).toHaveLength(1)
    const live = await Promise.all(all.map((task) => liveTask(t, task.id)))
    expect(live.filter((task) => task?.archived_at !== undefined)).toHaveLength(archived)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await t.run((ctx) => ctx.db.query('deleted_rows').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('deleted_tasks').collect())).toEqual([])
    await assertNoDanglingRefs(t, 'after a project came back in steps')
  })

  it('places the links before the tasks, so the mark steps of an archived task find them', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 6; i++) {
      const task = await plantIssue(t, { org_id, project_id: f.sub2.id })
      await comment(t, task)
      tasks.push(task)
    }
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
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
    expect(ready).toMatchObject({ state: 'ready', counts: { tasks: 6, archived_tasks: 0 } })
    expect(ready.restore_by).toBeUndefined()
    expect(await liveProject(t, f.sub2.id)).toBeNull()
    for (const task of tasks) expect(await liveTask(t, task.id)).toBeNull()
    expect(await storedTasks(t, item.id)).toHaveLength(6)
    expect((await storedRows(t, item.id)).filter((row) => row.table === 'comments')).toHaveLength(6)
    expect(await t.run((ctx) => ctx.db.query('comments').collect())).toEqual([])
    // and it says why when asked again
    expect((await restore(t, f.user, [item.id])).refused).toEqual([
      { id: item.id, reason: 'parent_archived' },
    ])
    await patch(t, 'projects', f.meta.id, { archived_at: undefined })
    TRASH_BUDGET.rows = 300
    await restore(t, f.user, [item.id])
    await runSteps(t)
    for (const task of tasks) expect(await liveTask(t, task.id)).not.toBeNull()
    await assertNoDanglingRefs(t, 'after a restore that was sent back')
  })

  it('finishes a restore whose item lists a stored task that is gone', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const tasks = [
      await plantIssue(t, { org_id, project_id: f.sub2.id }),
      await plantIssue(t, { org_id, project_id: f.sub2.id }),
    ]
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    // a deleted_tasks row whose stored task has no deleted_rows row
    await t.run((ctx) =>
      ctx.db.insert('deleted_tasks', {
        org_id,
        item_id: item.id,
        task_id: uuid(),
        num: 90_000,
        title: 'Gone',
        project_id: f.sub2.id,
        archived: false,
      }),
    )
    expect(await storedTasks(t, item.id)).toHaveLength(3)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await jobFor(t, item.id)).toBeNull()
    expect(await storedTasks(t, item.id)).toEqual([])
    for (const task of tasks) expect(await liveTask(t, task.id)).not.toBeNull()
    await assertNoDanglingRefs(t, 'after a restore whose item listed a task that is gone')
  })

  it.each(['restore_attach', 'restore_detach'] as const)(
    'ends a project restore an earlier release left in %s, keeping its families',
    async (phase) => {
      const t = newT()
      const f = await withReadingAdmin(t)
      const org_id = f.org.id
      const parent = await plantIssue(t, { org_id, project_id: f.sub2.id })
      const kid = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: parent.id })
      // tasks an earlier release wrote back without their parent, which had
      // gone to Deleted items on its own and stays there
      const away = await plantIssue(t, { org_id, project_id: f.sub2.id })
      const waiting = [
        await plantIssue(t, { org_id, project_id: f.sub2.id }),
        await plantIssue(t, { org_id, project_id: f.sub2.id }),
      ]
      await deleteTask(t, f, away.id)
      const awayItem = await itemFor(t, away.id)
      await grantsOnSub2(t, f)
      await deleteProject(t, f, f.sub2.id)
      await runSteps(t)
      const item = await itemFor(t, f.sub2.id)
      // a row a step, so the job stays past the reveal on the stored grants
      Object.assign(TRASH_BUDGET, { rows: 1, tasks: 1 })
      expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
      while ((await liveProject(t, f.sub2.id)) === null) await step(t, item.id)
      // the job as an earlier release saved it, its stored grants deleted
      await t.run(async (ctx) => {
        const job = await ctx.db
          .query('deleted_item_jobs')
          .withIndex('by_item', (q) => q.eq('item_id', item.id))
          .unique()
        if (job === null) throw new Error('the restore left no step after its reveal')
        const stored = ctx.db
          .query('deleted_rows')
          .withIndex('by_item_owner', (q) => q.eq('item_id', item.id))
        for await (const row of stored) await ctx.db.delete(row._id)
        await ctx.db.patch(job._id, { phase, cursor: undefined })
        for (const task of waiting)
          await ctx.db.insert('deleted_item_parents', {
            item_id: item.id,
            task_id: task.id,
            parent_id: away.id,
          })
      })
      const parentRows = () => t.run((ctx) => ctx.db.query('deleted_item_parents').collect())
      // a row a step: the item stays until its rows are gone
      await step(t, item.id)
      expect(await itemById(t, item.id)).not.toBeNull()
      expect(await parentRows()).toHaveLength(1)
      await runSteps(t)
      expect(await itemById(t, item.id)).toBeNull()
      expect(await jobFor(t, item.id)).toBeNull()
      expect(await parentRows()).toEqual([])
      expect((await liveTask(t, kid.id))?.parent_id).toBe(parent.id)
      expect((await liveTask(t, parent.id))?.parent_id).toBeUndefined()
      // the rows attach nothing, and the parent stays in Deleted items
      for (const task of waiting) expect((await liveTask(t, task.id))?.parent_id).toBeUndefined()
      expect(await liveTask(t, away.id)).toBeNull()
      expect((await itemById(t, awayItem.id))?.state).toBe('ready')
      await assertNoDanglingRefs(t, `after a restore an earlier release left in ${phase}`)
    },
  )

  it('keeps retrying a project restore an earlier release left in restore_attach, never sending it back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await grantsOnSub2(t, f)
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    Object.assign(TRASH_BUDGET, { rows: 1, tasks: 1 })
    await restore(t, f.user, [item.id])
    while ((await liveProject(t, f.sub2.id)) === null) await step(t, item.id)
    // past its retries at the smallest budget, its last step lost
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job === null) throw new Error('the restore left no step after its reveal')
      const stored = ctx.db
        .query('deleted_rows')
        .withIndex('by_item_owner', (q) => q.eq('item_id', item.id))
      for await (const row of stored) await ctx.db.delete(row._id)
      if (job.scheduled_id !== undefined) await ctx.scheduler.cancel(job.scheduled_id)
      await ctx.db.patch(job._id, {
        phase: 'restore_attach',
        budget_scale: RETRY.floor,
        attempts: 99,
      })
    })
    vi.setSystemTime(Date.now() + STALLED_MS + 1)
    await t.mutation(internal.deletedItems.recover, {})
    expect(await itemById(t, item.id)).toMatchObject({ state: 'restoring' })
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_attach' })
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await liveTask(t, task.id)).not.toBeNull()
  })

  it('sends a restore whose steps keep failing back to Deleted items rather than stuck', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withReadingAdmin(t)
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

describe('restore calls', () => {
  it('moves and restores the comments of a task with one read of their range a transaction', async () => {
    // 200 comments: read four at a time from the start, each direction
    // took 50 reads of a range that still held every comment moved before
    const t = newT({ transactionLimits: { databaseQueries: 60 } })
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++)
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: task.id,
          body: 'Checked on the bench.',
          created_at: NOW,
        })
    })
    await deleteTask(t, f, task.id)
    await runSteps(t)
    const item = await itemFor(t, task.id)
    expect(item.state).toBe('ready')
    expect(await liveRowsOf(t, task.id)).toMatchObject({ comments: [] })
    TRASH_BUDGET.rows = 1000
    CALL.scale = 1
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    await runSteps(t)
    expect((await liveRowsOf(t, task.id)).comments).toHaveLength(200)
  })

  it('keeps a call that restores many project items within a bounded number of reads', async () => {
    // six top-level projects of 30 sub-projects each, the design size. The
    // call read two rows per project of each item for conflicts and
    // revealed as many items as a step's budget held, over 1,500 database
    // calls for 40 sub-projects each, each slow on a busy backend; it now
    // leaves conflicts to the reveal and spends a quarter, inside a limit
    // lowered from 1,000 by the same ratio
    const t = newT({ transactionLimits: { databaseQueries: 750 } })
    const f = await withReadingAdmin(t)
    const metas: Doc<'projects'>[] = []
    for (let i = 0; i < 6; i++) {
      const meta = await plantProject(t, { org_id: f.org.id, lead_id: f.user.id })
      await plantSubProjects(t, f, meta.id, 30)
      await deleteProject(t, f, meta.id)
      metas.push(meta)
    }
    await runSteps(t)
    const ids = await Promise.all(metas.map(async (meta) => (await itemFor(t, meta.id)).id))
    const result = await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id: f.org.id,
      ids,
    })
    expect(result.restored.sort()).toEqual([...ids].sort())
    await runSteps(t)
    for (const meta of metas) expect(await liveProject(t, meta.id)).not.toBeNull()
  })

  it('answers per item, defers a task item whose project item comes back in the same call', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
      stepping: [],
      refused: [{ id: ids.viewOnly, reason: 'view_only' }],
      deferred: [],
    })
    // one call with several problems answers each, and throws for none
    expect(await restore(t, f.user, [ids.early, ids.archived, ids.project])).toEqual({
      restored: [ids.project],
      stepping: [],
      refused: [{ id: ids.archived, reason: 'project_archived' }],
      deferred: [ids.early],
    })
    expect(await restore(t, f.user, [ids.early])).toEqual({
      restored: [ids.early],
      stepping: [],
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

  it('shares one budget across the items of a call and finishes the rest in steps', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++) {
      const task = await plantIssue(t, { org_id, project_id: f.sub.id })
      for (let j = 0; j < 3; j++) await comment(t, task)
      await deleteTask(t, f, task.id)
      tasks.push(task)
    }
    const items = await Promise.all(tasks.map((task) => itemFor(t, task.id)))
    // six rows in the call, a quarter of a step, which hold the first
    // item's three comments, its task and, after its reveal, its search
    // row (restore_clear)
    TRASH_BUDGET.rows = 24
    const result = await restore(
      t,
      f.user,
      items.map((item) => item.id),
    )
    expect(result.restored).toEqual(items.map((item) => item.id))
    // the first fits in the call; the others go on in steps, as the answer says
    expect(result.stepping).toEqual([items[1].id, items[2].id])
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
    const f = await withReadingAdmin(t)
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
    // a step that starts at the reveal runs it whatever its size, and the
    // next deletes the search rows of its tasks, which the reveal's own
    // reads left no budget for (restore_clear)
    await step(t, item.id)
    for (const task of subtasks) expect((await liveTask(t, task.id))?.parent_id).toBe(root.id)
    expect(await jobFor(t, item.id)).toMatchObject({ phase: 'restore_clear' })
    expect(await storedTasks(t, item.id)).toHaveLength(4)
    await step(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await storedTasks(t, item.id)).toEqual([])
  })

  /** A task in Firmware with two subtasks, each with a comment, deleted
   * together, whose restore call stops after its first row and leaves the
   * rest to steps. */
  async function restoreStopped() {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const subtasks = [
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: root.id }),
    ]
    const family = [root, ...subtasks]
    for (const task of family) await comment(t, task)
    await deleteTask(t, f, root.id, { subtask_ids: subtasks.map((s) => s.id) })
    await runSteps(t)
    const item = await itemFor(t, root.id)
    TRASH_BUDGET.bytes = 1
    expect((await restore(t, f.user, [item.id])).stepping).toEqual([item.id])
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    return { t, f, root, subtasks, family, item }
  }

  it('keeps a family whole when its sub-project is deleted between two steps of its restore, and brings it back whole after the project', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { t, f, root, subtasks, family, item } = await restoreStopped()
    await deleteProject(t, f, f.sub.id)
    await runSteps(t)
    // the reveal finds Firmware gone and sends the item back, whole
    expect(await itemById(t, item.id)).toMatchObject({ state: 'ready' })
    expect((await storedTasks(t, item.id)).map((x) => x.task_id).sort()).toEqual(
      family.map((task) => task.id).sort(),
    )
    for (const task of subtasks) expect((await storedIssue(t, task.id))?.parent_id).toBe(root.id)
    const projectItem = await itemFor(t, f.sub.id)
    const held = (await storedTasks(t, projectItem.id)).map((x) => x.task_id)
    for (const task of family) {
      expect(await liveTask(t, task.id)).toBeNull()
      expect(held).not.toContain(task.id)
    }
    // Firmware first, then the task with both subtasks under it
    expect((await restore(t, f.user, [projectItem.id])).restored).toEqual([projectItem.id])
    await runSteps(t)
    expect((await restore(t, f.user, [item.id])).restored).toEqual([item.id])
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    for (const task of subtasks) expect((await liveTask(t, task.id))?.parent_id).toBe(root.id)
    for (const task of family) expect((await liveRowsOf(t, task.id)).comments).toHaveLength(1)
    await assertNoDanglingRefs(t, 'after a family waited whole for its sub-project')
  })

  it('goes on with a restore an earlier release left in its split phase', async () => {
    const { t, root, subtasks, family, item } = await restoreStopped()
    const [first] = await storedTasks(t, item.id)
    // the job as an earlier release saved it, its cursor past one task
    await t.run(async (ctx) => {
      const job = await ctx.db
        .query('deleted_item_jobs')
        .withIndex('by_item', (q) => q.eq('item_id', item.id))
        .unique()
      if (job === null) throw new Error('the restore left no step')
      await ctx.db.patch(job._id, {
        phase: 'restore_split',
        cursor: { index: 0, after: first._creationTime },
      })
    })
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await jobFor(t, item.id)).toBeNull()
    for (const task of subtasks) expect((await liveTask(t, task.id))?.parent_id).toBe(root.id)
    for (const task of family) expect((await liveRowsOf(t, task.id)).comments).toHaveLength(1)
    await assertNoDanglingRefs(t, 'after a restore left in its split phase')
  })

  it('defers what waits for a project item of the same call, whatever the order of the ids', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
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
      stepping: [],
      refused: [],
      deferred: [ids.sub, ids.task],
    })
    expect(await restore(t, f.admin, [ids.task, ids.sub])).toEqual({
      restored: [ids.sub],
      stepping: [],
      refused: [],
      deferred: [ids.task],
    })
    expect((await restore(t, f.admin, [ids.task])).restored).toEqual([ids.task])
    expect(await liveTask(t, task.id)).not.toBeNull()
  })
})

describe('where live attachment rows land', () => {
  /** The bytes of the organization's live attachment rows, by project id. */
  const live = async (t: T, orgId: string) => {
    const usage = await t.run((ctx) => liveAttachmentUsage(ctx, orgId))
    return {
      bytes: usage.bytes,
      projects: Object.fromEntries(usage.projects.map((p) => [p.project_id, p.storage_bytes])),
    }
  }
  /** The size of each live attachment row of `taskId`, smallest first. A
   * row names no project; liveAttachmentUsage counts it under its task's. */
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

  it("puts a task's attachment rows back under its project once it comes back", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    for (const size of [11, 13, 17]) await attach(t, task, size)
    const other = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await attach(t, other, 5)
    const before = { bytes: 46, projects: { [f.sub.id]: 41, [f.sub2.id]: 5 } }
    expect(await live(t, org_id)).toEqual(before)

    await deleteTask(t, f, task.id)
    expect(await filesOf(t, task.id)).toEqual([])
    expect(await live(t, org_id)).toEqual({ bytes: 5, projects: { [f.sub2.id]: 5 } })

    await restore(t, f.user, [(await itemFor(t, task.id)).id])
    expect(await filesOf(t, task.id)).toEqual([11, 13, 17])
    expect(await live(t, org_id)).toEqual(before)
    await assertNoDanglingRefs(t, 'after the files of a task came back')
  })

  it("counts a project's attachment rows nowhere until its reveal, then under each task's project", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const org_id = f.org.id
    const inSub = await plantIssue(t, { org_id, project_id: f.sub.id })
    await attach(t, inSub, 11)
    const inSub2 = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await attach(t, inSub2, 3)
    await attach(t, inSub2, 7)
    const elsewhere = await plantIssue(t, { org_id, project_id: f.hidden.id })
    await attach(t, elsewhere, 5)
    const before = { bytes: 26, projects: { [f.sub.id]: 11, [f.sub2.id]: 10, [f.hidden.id]: 5 } }
    expect(await live(t, org_id)).toEqual(before)
    const away = { bytes: 5, projects: { [f.hidden.id]: 5 } }

    // the files stop counting with the delete, before the steps move them
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('moving')
    expect((await filesOf(t, inSub2.id)).length).toBeGreaterThan(0)
    expect(await live(t, org_id)).toEqual(away)
    Object.assign(TRASH_BUDGET, DEFAULT_BUDGET)
    await runSteps(t)
    expect((await itemFor(t, f.meta.id)).state).toBe('ready')
    expect(await live(t, org_id)).toEqual(away)

    // written back while the projects are absent, they still count nowhere
    Object.assign(TRASH_BUDGET, { rows: 1, ranges: 40 })
    await restore(t, f.user, [item.id])
    let sawFilesBack = false
    await stepThrough(t, item.id, async () => {
      if ((await liveProject(t, f.meta.id)) !== null) return
      if ((await filesOf(t, inSub2.id)).length > 0) sawFilesBack = true
      expect(await live(t, org_id)).toEqual(away)
    })
    expect(sawFilesBack).toBe(true)
    expect(await filesOf(t, inSub.id)).toEqual([11])
    expect(await filesOf(t, inSub2.id)).toEqual([3, 7])
    expect(await live(t, org_id)).toEqual(before)
    await assertNoDanglingRefs(t, 'after the files of a project came back')
  })
})

/* `n` more sub-projects of `meta`, each with `rows` milestones and a User
 * grant for each of `people`, the last `archived` of them archived. */
const plantSubProjects = async (
  t: T,
  f: OrgFixture,
  meta: string,
  n: number,
  rows = 0,
  people: string[] = [],
  archived = 0,
) => {
  for (let from = 0; from < n; from += 50)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 50); i++) {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: meta,
          key: `S${meta.slice(0, 4).toUpperCase()}${i}`,
          name: `Sub ${i}`,
          description: '',
          sort_order: i,
          num: 1000 + i,
          track_delay: false,
          created_at: NOW,
          ...(i >= n - archived ? { archived_at: NOW, archive_state: 'listed' as const } : {}),
        })
        for (let m = 0; m < rows; m++)
          await ctx.db.insert('milestones', {
            id: uuid(),
            project_id: id,
            name: `Milestone ${m}`,
            week: '2026-05-04',
            created_at: NOW,
          })
        for (const profile_id of people)
          await ctx.db.insert('project_access', { project_id: id, profile_id, level: 'user' })
      }
    })
}

/* The live rows of `table` on the projects of `meta`'s tree. */
const treeRows = (t: T, meta: string, table: 'milestones' | 'project_access') =>
  t.run(async (ctx) => {
    const ids = [
      meta,
      ...(
        await ctx.db
          .query('projects')
          .withIndex('by_parent', (q) => q.eq('parent_id', meta))
          .collect()
      ).map((p) => p.id),
    ]
    let n = 0
    for (const id of ids)
      n += (
        await ctx.db
          .query(table)
          .withIndex('by_project', (q) => q.eq('project_id', id))
          .collect()
      ).length
    return { projects: ids.length, rows: n }
  })

describe('a project item and the sub-project cap', () => {
  it('refuses to delete a project with more sub-projects than LIMITS.projectDeleteSubProjects, here lowered to 1', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // the fixture's project has two sub-projects, one past the lowered cap
    const cap = LIMITS.projectDeleteSubProjects.max
    Object.assign(LIMITS.projectDeleteSubProjects, { max: 1 })
    try {
      await expectRefusal(
        deleteProject(t, f, f.meta.id),
        'rule',
        new RegExp(`^${LIMITS.projectDeleteSubProjects.refusal.replace(/[.,]/g, '\\$&')}$`),
      )
      expect(await liveProject(t, f.meta.id)).not.toBeNull()
      // one sub-project fewer, and the project goes
      await deleteProject(t, f, f.sub2.id)
      await deleteProject(t, f, f.meta.id)
    } finally {
      Object.assign(LIMITS.projectDeleteSubProjects, { max: cap })
    }
    expect(await liveProject(t, f.meta.id)).toBeNull()
  })

  it('deletes and restores a project of 30 live and 40 archived sub-projects with their milestones and grants within the limits', async () => {
    // convex-test counts no range for a write, which reads its row first,
    // so the writes stand in for those ranges; 700, where the tree's 71
    // projects and their 340 milestones and 348 grants pass it, as the
    // largest tree the cap allows passed 4,096 (the delete's steps need
    // more than 600)
    const t = newT({ transactionLimits: { documentsWritten: 700 } })
    const f = await withReadingAdmin(t)
    const people = await plantPeople(t, f, 5)
    // beside FW and PCB, 28 live and 40 archived, each with 5 milestones and
    // a grant for each of the 5 people
    await plantSubProjects(t, f, f.meta.id, 68, 5, people, 40)
    const milestones = await treeRows(t, f.meta.id, 'milestones')
    const grants = await treeRows(t, f.meta.id, 'project_access')
    expect(milestones).toEqual({ projects: 71, rows: 340 })
    // and withReadingAdmin's guest, viewer and admin grants on TBED
    expect(grants.rows).toBe(340 + 5 + 3)

    // storing every project, milestone and grant at once passed the limit
    await deleteProject(t, f, f.meta.id)
    expect(await liveProject(t, f.meta.id)).toBeNull()
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('ready')
    expect(await treeRows(t, f.meta.id, 'milestones')).toEqual({ projects: 1, rows: 0 })

    // and so did writing them all back in the reveal
    expect(await restore(t, f.user, [item.id])).toMatchObject({ restored: [item.id] })
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await treeRows(t, f.meta.id, 'milestones')).toEqual(milestones)
    expect(await treeRows(t, f.meta.id, 'project_access')).toEqual(grants)
  })

  it('restores many sub-project items for a lead whose other grants it does not read', async () => {
    // 200 grants of the lead's elsewhere, which say nothing about these
    // items, read for each of the 10 items would pass a limit of 1,600
    // documents, as 4,000 grants passed the real 32,000
    const t = newT({ transactionLimits: { documentsRead: 1_600 } })
    const f = await withReadingAdmin(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++)
        await ctx.db.insert('project_access', {
          project_id: uuid(),
          profile_id: f.user.id,
          level: 'user',
        })
    })
    const subs: string[] = []
    for (let i = 0; i < 10; i++) {
      const sub = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.meta.id,
        key: `RST${i}`,
      })
      await deleteProject(t, f, sub.id)
      subs.push(sub.id)
    }
    await runSteps(t)
    const items = await Promise.all(subs.map((id) => itemFor(t, id)))
    const ids = items.map((item) => item.id)
    const result = await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id: f.org.id,
      ids,
    })
    expect(result.restored.sort()).toEqual([...ids].sort())
    await runSteps(t)
    for (const id of subs) expect(await liveProject(t, id)).not.toBeNull()
  })

  it('restores a tree whose grants pass what one transaction may read', async () => {
    // 30 sub-projects shared with 40 people each: 1,200 grants against a
    // limit of 1,000 documents read, with the rows a step moves at a third,
    // standing in for 200 x 200 against 32,000
    const t = newT({ transactionLimits: { documentsRead: 1000 } })
    TRASH_BUDGET.rows = DEFAULT_BUDGET.rows / 3
    const f = await withReadingAdmin(t)
    const people = await plantPeople(t, f, 40)
    await plantSubProjects(t, f, f.meta.id, 28)
    // counted a project at a time, since all of them pass the read limit
    const grantCount = async () => {
      const ids = await t.run(async (ctx) => [
        f.meta.id,
        ...(
          await ctx.db
            .query('projects')
            .withIndex('by_parent', (q) => q.eq('parent_id', f.meta.id))
            .collect()
        ).map((p) => p.id),
      ])
      let n = 0
      for (const id of ids)
        n += await t.run(
          async (ctx) =>
            (
              await ctx.db
                .query('project_access')
                .withIndex('by_project', (q) => q.eq('project_id', id))
                .collect()
            ).length,
        )
      return { projects: ids.length, rows: n }
    }
    const subs = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', f.meta.id))
        .collect(),
    )
    expect(subs).toHaveLength(30)
    for (const p of subs)
      await t.run(async (ctx) => {
        for (const profile_id of people)
          await ctx.db.insert('project_access', { project_id: p.id, profile_id, level: 'user' })
      })
    const grants = await grantCount()
    expect(grants.rows).toBeGreaterThan(1000)

    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('ready')
    // its lead lists it on the page, which reads within its budgets, and
    // restores it, reading only their own grants
    const listed = await as(t, f.user).query(api.deletedItems.page, {
      scope: { org_id: f.org.id, all: true },
      kind: 'project',
    })
    expect(listed.entries).toEqual([{ item_id: item.id }])
    expect(listed).not.toHaveProperty('missing')
    expect(await restore(t, f.user, [item.id])).toMatchObject({ restored: [item.id] })
    await runSteps(t)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await grantCount()).toEqual(grants)
  })

  it.each([
    ['stored now', false],
    ['stored before grantees, without the backfill', true],
  ])('keeps the people of grants and shares %s', async (_, legacy) => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [team] = await plantTeams(t, f, 1)
    // the assignee reaches Firmware through a grant, the reviewer only
    // through their team's share
    const [worker, reviewer] = await plantPeople(t, f, 2, [team])
    await t.run(async (ctx) => {
      const own = await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', reviewer))
        .unique()
      if (own !== null) await ctx.db.delete(own._id)
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: team,
        level: 'user',
      })
    })
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: worker,
      reviewer_id: reviewer,
    })
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    // stored rows as a release before grantees left them
    if (legacy)
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query('deleted_rows').collect())
          if (row.grantee !== undefined) await ctx.db.patch(row._id, { grantee: undefined })
      })
    expect(await restore(t, f.user, [item.id])).toMatchObject({ restored: [item.id] })
    await runSteps(t)
    expect(await liveTask(t, task.id)).toMatchObject({ assignee_id: worker, reviewer_id: reviewer })
  })

  it('keeps an assignee whose grant was stored before grantees, once the backfill ran', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const [worker] = await plantPeople(t, f, 1)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      assignee_id: worker,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      }),
    )
    await deleteProject(t, f, f.meta.id)
    await runSteps(t)
    const item = await itemFor(t, f.meta.id)
    // stored rows as a release before grantees left them
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('deleted_rows').collect())
        if (row.grantee !== undefined) await ctx.db.patch(row._id, { grantee: undefined })
    })
    const backfill = (dry_run: boolean) =>
      t.action(internal.internal.storedGrantees.backfill, { dry_run, page_size: 2 })
    // the grants of the worker, the guest, the viewer and the admin on
    // Testbed platform, and the team's share on Firmware
    expect(await backfill(true)).toEqual({
      project_access: { missing: 4, set: 0 },
      project_team_access: { missing: 1, set: 0 },
    })
    expect(await backfill(false)).toEqual({
      project_access: { missing: 4, set: 4 },
      project_team_access: { missing: 1, set: 1 },
    })
    expect((await backfill(true)).project_access.missing).toBe(0)
    expect(await restore(t, f.user, [item.id])).toMatchObject({ restored: [item.id] })
    await runSteps(t)
    expect((await liveTask(t, task.id))?.assignee_id).toBe(worker)
  })

  it('restores many project items without tasks, each reveal within the limits', async () => {
    // trees of 30 sub-projects, the design size under one project, whose
    // single reveals need about 100 documents written
    const t = newT({ transactionLimits: { documentsWritten: 120 } })
    const f = await withReadingAdmin(t)
    const metas: string[] = []
    for (let i = 0; i < 2; i++) {
      const meta = await plantProject(t, {
        org_id: f.org.id,
        key: `BIG${i}`,
        name: `Big ${i}`,
        lead_id: f.user.id,
      })
      await plantSubProjects(t, f, meta.id, 30)
      await deleteProject(t, f, meta.id)
      metas.push(meta.id)
    }
    await runSteps(t)
    const items = await Promise.all(metas.map((id) => itemFor(t, id)))

    // every reveal in one restore wrote 62 projects and deleted their rows,
    // past the 120 documents written allowed here
    const result = await restore(
      t,
      f.user,
      items.map((item) => item.id),
    )
    expect(result.restored.sort()).toEqual(items.map((item) => item.id).sort())
    await runSteps(t)
    for (const meta of metas) expect((await treeRows(t, meta, 'milestones')).projects).toBe(31)
  })
})
