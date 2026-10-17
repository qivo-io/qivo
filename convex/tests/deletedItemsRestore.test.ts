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
import { deleteOrgDeep } from '../model/cascade'
import {
  type RestoreResult,
  restoreItems,
  STALLED_MS,
  startPurge,
  TRASH_BUDGET,
} from '../model/deletedItems'
import {
  activityFor,
  as,
  messagesFor,
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

  it('brings a subtask back top-level when the restorer cannot edit its parent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // the guest edits Firmware through the top-level grant, and cannot see
    // Skunkworks, where the parent is
    const hiddenSub = await plantProject(t, { org_id, type: 'project', parent_id: f.hidden.id })
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

  it('keeps a parent only while the chain stays within 20 levels', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const chain: Doc<'issues'>[] = []
    for (let i = 0; i < 19; i++)
      chain.push(await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: chain.at(-1)?.id }))
    const deepest = await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: chain[18].id })
    // twenty levels: the parent comes back
    await deleteTask(t, f, deepest.id)
    await restore(t, f.user, [(await itemFor(t, deepest.id)).id])
    expect((await liveTask(t, deepest.id))?.parent_id).toBe(chain[18].id)
    // the chain grew while the task was in Deleted items: 21 levels
    await deleteTask(t, f, deepest.id)
    const top = await plantIssue(t, { org_id, project_id: f.sub.id })
    await patch(t, 'issues', chain[0].id, { parent_id: top.id })
    await restore(t, f.user, [(await itemFor(t, deepest.id)).id])
    expect((await liveTask(t, deepest.id))?.parent_id).toBeUndefined()
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

  it('moves a subtask whose project was deleted to that project item, or deletes it when that is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await comment(t, sub)
    const file = await attach(t, sub)
    const neighbour = await plantIssue(t, { org_id, project_id: f.sub2.id })
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
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

    // the project brings it back under its parent
    await restore(t, f.user, [projectItem.id])
    expect((await liveTask(t, sub.id))?.parent_id).toBe(root.id)
    expect(await blobExists(t, file.storage_id)).toBe(true)
    await assertNoDanglingRefs(t, 'after a subtask came back with its project')

    // a project purged for good takes the subtask with it
    const third = await plantProject(t, { org_id, type: 'project', parent_id: f.meta.id })
    const root2 = await plantIssue(t, { org_id, project_id: f.sub.id })
    const lost = await plantIssue(t, { org_id, project_id: third.id, parent_id: root2.id })
    const lostFile = await attach(t, lost)
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
    await assertNoDanglingRefs(t, 'after a subtask went with its purged project')
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
    // a task whose parent stays outside the project, and a link out
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
      // with its hours until the reveal
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
    expect((await liveTask(t, edge.id))?.parent_id).toBe(outsideParent.id)
    expect((await liveTask(t, outsideParent.id))?.remaining_hours).toBeUndefined()
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
    const epic = await plantIssue(t, { org_id, project_id: f.hidden.id })
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
  /** `n` tasks of Board rev under one epic in Skunkworks, which the user
   * leads, with Board rev moved to Deleted items. The epic, a leaf again,
   * holds 8 hours of its own and the admin follows it. */
  async function underEpic(t: T, f: OrgFixture, n: number) {
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.hidden.id })
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

  /** Board rev with one task under each of `parents`, outside it, then
   * moved to Deleted items. Waiting tasks attach in uuid order, so each task
   * gets a uuid that sorts by its place in `parents`. */
  async function oneUnderEach(t: T, f: OrgFixture, parents: Doc<'issues'>[]) {
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

  it('brings back 500 tasks of 16 KB under one parent outside the project within the real limits', async () => {
    // 8 MiB of tasks under a parent outside, which no single transaction
    // can read and write back with their parent
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const org_id = f.org.id
    const epic = await plantIssue(t, { org_id, project_id: f.hidden.id })
    await plantSubscription(t, { issue_id: epic.id, profile_id: f.admin.id })
    const description = 'Spec line. '.repeat(1490)
    const ids = await t.run(async (ctx) => {
      const planted: string[] = []
      for (let i = 0; i < 500; i++) {
        const id = uuid()
        await ctx.db.insert('issues', {
          id,
          org_id,
          num: 50_000 + i,
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
        planted.push(id)
      }
      return planted
    })
    await deleteProject(t, f, f.sub2.id)
    await runSteps(t)
    const item = await itemFor(t, f.sub2.id)
    expect(item).toMatchObject({ state: 'ready', counts: { tasks: 500 } })
    await patch(t, 'issues', epic.id, { remaining_hours: 8, remaining_set_at: NOW })

    const result = await as(t, f.user).mutation(api.deletedItems.restore, {
      org_id,
      ids: [item.id],
    })
    expect(result.restored).toEqual([item.id])
    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    const children = await t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', epic.id))
        .collect(),
    )
    expect(children.map((c) => c.id).sort()).toEqual([...ids].sort())
    expect(children.every((c) => c.description === description)).toBe(true)
    expect((await liveTask(t, epic.id))?.remaining_hours).toBeUndefined()
    expect((await messagesFor(t, f.admin.id, epic.id)).map((m) => m.detail)).toEqual([
      'Remaining cleared (was 8 h)',
    ])
    expect(await waitingParents(t)).toEqual([])
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
    const epics = [
      await plantIssue(t, { org_id, project_id: f.hidden.id }),
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
    // the user may change each parent, in Firmware through Testbed platform
    // and in Skunkworks, which they lead
    const parents = [
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.hidden.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
      await plantIssue(t, { org_id, project_id: f.sub.id }),
    ]
    const [first, unreadable, deep, loop] = parents
    const {
      tasks: [kept, ...lost],
      item,
    } = await oneUnderEach(t, f, parents)
    await patch(t, 'issues', unreadable.id, { remaining_hours: 5, remaining_set_at: NOW })

    TRASH_BUDGET.tasks = 1
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, [kept, ...lost])).toEqual([first.id, undefined, undefined, undefined])
    // Skunkworks gets another lead, so the user can no longer see it; 19
    // tasks above the next parent leave no level for the task; the last
    // parent now hangs under the very task that waits for it
    await patch(t, 'projects', f.hidden.id, { lead_id: f.admin.id })
    let above: string | undefined
    for (let i = 0; i < 19; i++)
      above = (await plantIssue(t, { org_id, project_id: f.sub.id, parent_id: above })).id
    await patch(t, 'issues', deep.id, { parent_id: above })
    await patch(t, 'issues', loop.id, { parent_id: lost[2].id })

    await stepThrough(t, item.id)
    expect(await itemById(t, item.id)).toBeNull()
    expect(await parentsOf(t, [kept, ...lost])).toEqual([first.id, undefined, undefined, undefined])
    expect((await liveTask(t, loop.id))?.parent_id).toBe(lost[2].id)
    // nothing changed in the project the user can no longer see
    expect((await liveTask(t, unreadable.id))?.remaining_hours).toBe(5)
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

  it('counts what the depth check reads against the step budget', async () => {
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
    // the three subtasks of 16 KB under the first task spend the step
    TRASH_BUDGET.bytes = 40_000
    await untilAttach(t, f, item.id)
    expect(await parentsOf(t, [heavy, light])).toEqual([epic.id, undefined])
    await stepThrough(t, item.id)
    expect(await parentsOf(t, [heavy, light])).toEqual([epic.id, epic.id])
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
    // a failed step leaves the job at its last committed progress
    let now = START
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
    await assertNoDanglingRefs(t, 'after a late split deleted the subtask for good')
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
