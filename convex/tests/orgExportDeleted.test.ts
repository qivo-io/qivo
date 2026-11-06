/* The organization export's Deleted items section (format 4,
 * model/orgExportRead.ts storedBatch and itemsBatch): the organization's
 * retained Deleted items under deleted/, each stored table read on its own
 * and the items last, every item marked complete or partial with the
 * reason, nothing exported twice or skipped silently.
 *
 * Items are made with the app's delete and restore paths on the trash
 * suites' fake timers (trash.setup.ts); a state those paths pass through
 * on their way is held by cancelling the item's next step. The export runs
 * to the end with `settle`, or a step at a time (exportUntil) where a case
 * changes Deleted items while it reads. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from '../lib/db'
import {
  archiveRow,
  JOB_ORDER,
  LIVE_READ_WARNING,
  ORG_EXPORT_ORDER,
  type OrgExportRow,
} from '../lib/orgExport'
import { restoreItems, TRASH_BUDGET } from '../model/deletedItems'
import { type BatchJob, exportRow, JOINED_PAGE_SIZE, readBatch } from '../model/orgExportRead'
import { EXPORT_LIMITS } from '../model/orgExports'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import {
  archiveOf,
  exportAs,
  exportUntil,
  jobOf,
  nextStep,
  partsOf,
  settle,
} from './orgExport.setup'
import {
  attach,
  comment,
  deleteProject,
  deleteTask,
  installTrashTimers,
  itemById,
  itemFor,
  jobFor,
  plantRows,
  step,
  storedTasks,
} from './trash.setup'

installTrashTimers()
const DEFAULT_LIMITS = { ...EXPORT_LIMITS }
afterEach(() => {
  Object.assign(EXPORT_LIMITS, DEFAULT_LIMITS)
})

/** The index in JOB_ORDER of the section keyed `key`. */
const sectionOf = (key: string) => JOB_ORDER.findIndex((section) => section.key === key)

/** Lets a second of fake time pass, so what happens next is later than
 * what happened before. */
const later = () => vi.advanceTimersByTime(1000)

/** Holds deleted item `itemId` in its state: cancels its next step, so
 * the export's steps run alone. A step run by hand (`step`) schedules the
 * next one too, so a case holds the item before each such step. */
async function hold(t: T, itemId: string) {
  const job = await jobFor(t, itemId)
  const scheduled = job?.scheduled_id
  if (scheduled !== undefined) await t.run((ctx) => ctx.scheduler.cancel(scheduled))
}

/** Restores the items `ids` as `who`, as deletedItems.restore does after
 * its visibility fence. */
const restore = (t: T, who: Doc<'profiles'>, ids: string[]) =>
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

/** The item row deleted/items holds for item `id`. */
function itemRow(archive: Awaited<ReturnType<typeof archiveOf>>, id: string) {
  const row = archive.tables['deleted/items'].find((r) => r.id === id)
  if (row === undefined) throw new Error(`deleted/items lacks ${id}`)
  return row
}

/** Ids in `rows`, sorted. */
const idsOf = (rows: readonly OrgExportRow[]) => rows.map((row) => row.id as string).sort()

/** What deleted/ must hold for organization `orgId`'s stored rows of
 * items `itemIds`, by job section key, each stored table but
 * issue_subscriptions in its index's order: each document as its live
 * table's section writes it, a task with its stored text, and its item's
 * id, as JSON carries them. */
async function storedExpectation(t: T, orgId: string, itemIds: readonly string[]) {
  const out: Record<string, OrgExportRow[]> = {}
  await t.run(async (ctx) => {
    for (const section of JOB_ORDER) {
      if (section.kind !== 'stored') continue
      const rows = await ctx.db
        .query('deleted_rows')
        .withIndex('by_table_org_owner', (q) => q.eq('table', section.table).eq('org_id', orgId))
        .collect()
      out[section.key] = rows
        .filter((stored) => itemIds.includes(stored.item_id))
        .map((stored) => {
          const row = exportRow(stored.row.doc, section.table)
          if (stored.row.table === 'issues') row.description = stored.row.doc.description ?? ''
          return JSON.parse(
            JSON.stringify(archiveRow({ ...row, deleted_item_id: stored.item_id })),
          ) as OrgExportRow
        })
    }
  })
  return out
}

/** A top-level project with three sub-projects, two tasks in each, a
 * milestone, two grants and a team share: the fixture's Testbed platform
 * with one sub-project more. */
async function projectFamily(t: T, f: OrgFixture) {
  const third = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    key: 'QA',
    name: 'Bench QA',
  })
  const tasks: Doc<'issues'>[] = []
  for (const project of [f.sub, f.sub2, third])
    for (let i = 0; i < 2; i++)
      tasks.push(
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: project.id,
          description: `<p>${project.name} bench step ${i}</p>`,
        }),
      )
  for (const task of tasks.slice(0, 2)) await comment(t, task)
  await t.run(async (ctx) => {
    await ctx.db.insert('milestones', {
      id: uuid(),
      project_id: f.meta.id,
      name: 'Bring-up',
      week: '2026-05-04',
      created_at: NOW,
    })
    await ctx.db.insert('project_team_access', {
      project_id: f.meta.id,
      team_id: f.team.id,
      level: 'user',
    })
  })
  return { third, tasks }
}

describe('the Deleted items section', () => {
  it("holds a task item's stored rows once, apart from the live tables, with the item's classified fields", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      description: '<p>Stored text</p>',
    })
    const subtask = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      parent_id: task.id,
      description: '<p>Subtask text</p>',
    })
    const to = await plantIssue(t, { org_id, project_id: f.sub.id })
    const from = await plantIssue(t, { org_id, project_id: f.sub.id })
    const planted = await plantRows(t, f, task, { to, from })
    await deleteTask(t, f, task.id, {
      subtask_ids: [subtask.id],
      reason: 'Duplicate of the rig task',
    })
    await settle(t)
    const item = await itemFor(t, task.id)
    expect(item.state).toBe('ready')
    // no step reads a file: the attachment's bytes may be gone
    await t.run((ctx) => ctx.storage.delete(planted.attachment.storage_id))
    later()
    const exportId = await exportAs(t, f.admin, org_id)
    const job = await jobOf(t, exportId)
    expect(job).toMatchObject({ state: 'ready', format_version: 4 })
    const archive = await archiveOf(t, exportId)

    expect(idsOf(archive.tables['deleted/tasks'])).toEqual([task.id, subtask.id].sort())
    const stored = archive.tables['deleted/tasks'].find((row) => row.id === task.id)
    expect(stored).toMatchObject({ deleted_item_id: item.id, description: '<p>Stored text</p>' })
    // the live tasks' exclusions, and none of the search and item copies
    // deleted_tasks keeps
    for (const field of [
      'window_key',
      'task_key',
      'relations_marked',
      '_id',
      '_creationTime',
      'search_text',
      'cross_project_id',
      'item_project_id',
    ])
      expect(stored, field).not.toHaveProperty(field)
    expect(archive.tables['deleted/comments']).toEqual([
      expect.objectContaining({
        task_id: task.id,
        body: 'Measured 3.7 V',
        deleted_item_id: item.id,
      }),
    ])
    expect(archive.tables['deleted/task_labels']).toEqual([
      expect.objectContaining({ task_id: task.id, label_id: planted.labelId }),
    ])
    expect(archive.tables['deleted/task_labels'][0]).not.toHaveProperty('org_id')
    expect(
      archive.tables['deleted/task_links'].map((row) => [row.source_id, row.target_id]).sort(),
    ).toEqual(
      [
        [task.id, to.id],
        [from.id, task.id],
      ].sort(),
    )
    expect(archive.tables['deleted/task_attachments']).toEqual([
      expect.objectContaining({ id: planted.attachment.id, task_id: task.id }),
    ])
    // the follow is personal and stays out
    expect(JSON.stringify(archive.tables)).not.toContain('issue_subscriptions')
    expect(Object.keys(archive.tables)).toEqual(JOB_ORDER.map((section) => section.key))
    // the live tables hold none of it
    expect(idsOf(archive.tables.tasks)).not.toContain(task.id)
    expect(idsOf(archive.tables.tasks)).not.toContain(subtask.id)
    expect(archive.tables.comments.filter((row) => row.task_id === task.id)).toEqual([])
    expect(
      archive.tables.task_links.filter(
        (row) => row.source_id === task.id || row.target_id === task.id,
      ),
    ).toEqual([])
    // every stored row once, as its live table's section writes it
    const expected = await storedExpectation(t, org_id, [item.id])
    for (const [key, rows] of Object.entries(expected))
      expect(archive.tables[key], key).toEqual(rows)

    // the item with its classified fields
    const row = itemRow(archive, item.id)
    expect(row).toMatchObject({
      id: item.id,
      org_id,
      kind: 'task',
      target_id: task.id,
      num: task.num,
      name: task.title,
      archived: false,
      project_id: f.sub.id,
      deleted_at: item.deleted_at,
      deleted_by: f.user.id,
      reason: 'Duplicate of the rig task',
      state: 'ready',
      counts: item.counts,
      path: item.path,
      purge_at: new Date(item.purge_after).toISOString(),
      export_rows: 'complete',
      deleted_during_export: false,
    })
    for (const field of ['purge_after', 'restore_by', 'export_reason', 'via', '_id'])
      expect(row, field).not.toHaveProperty(field)
    expect(archive.manifest.deleted_items).toMatchObject({
      items: { complete: 1, partial: 0 },
      left_out: {},
    })
    expect(archive.manifest.deleted_items?.tables['deleted/tasks'].records).toBe(2)
    expect(archive.manifest.tables).not.toHaveProperty('deleted/tasks')
  })

  it("holds a project item's projects, milestones, grants, share and tasks once each, and none of it in data/", async () => {
    const t = newT()
    const f = await withOrg(t)
    const { third, tasks } = await projectFamily(t, f)
    await deleteProject(t, f, f.meta.id)
    await settle(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('ready')
    later()
    const archive = await archiveOf(t, await exportAs(t, f.admin, f.org.id))
    const family = [f.meta.id, f.sub.id, f.sub2.id, third.id].sort()
    expect(idsOf(archive.tables['deleted/projects'])).toEqual(family)
    expect(idsOf(archive.tables['deleted/tasks'])).toEqual(idsOf(tasks))
    expect(archive.tables['deleted/milestones']).toEqual([
      expect.objectContaining({ project_id: f.meta.id, name: 'Bring-up' }),
    ])
    expect(archive.tables['deleted/project_access'].map((row) => row.profile_id).sort()).toEqual(
      [f.guest.id, f.viewer.id].sort(),
    )
    expect(archive.tables['deleted/project_team_access']).toEqual([
      expect.objectContaining({ project_id: f.meta.id, team_id: f.team.id }),
    ])
    expect(archive.tables['deleted/comments']).toHaveLength(2)
    for (const id of family) expect(idsOf(archive.tables.projects)).not.toContain(id)
    for (const task of tasks) expect(idsOf(archive.tables.tasks)).not.toContain(task.id)
    expect(
      archive.tables.project_access.filter((row) => family.includes(row.project_id as string)),
    ).toEqual([])
    const expected = await storedExpectation(t, f.org.id, [item.id])
    for (const [key, rows] of Object.entries(expected))
      expect(archive.tables[key], key).toEqual(rows)
    expect(itemRow(archive, item.id)).toMatchObject({ kind: 'project', export_rows: 'complete' })
  })

  it("shows a personal credential's table only, and an agent key's id and name", async () => {
    const t = newT()
    const f = await withOrg(t)
    const personal = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const agent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const task of [personal, agent]) await deleteTask(t, f, task.id)
    const keyId = uuid()
    await t.run(async (ctx) => {
      const a = await ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', personal.id))
        .unique()
      const b = await ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', agent.id))
        .unique()
      if (a === null || b === null) throw new Error('no items')
      await ctx.db.patch(a._id, { via: { table: 'mcp_tokens', id: uuid(), name: "Ada's laptop" } })
      await ctx.db.patch(b._id, { via: { table: 'agent_keys', id: keyId, name: 'Build bot' } })
    })
    later()
    const archive = await archiveOf(t, await exportAs(t, f.admin, f.org.id))
    expect(itemRow(archive, (await itemFor(t, personal.id)).id).via).toEqual({
      table: 'mcp_tokens',
    })
    expect(itemRow(archive, (await itemFor(t, agent.id)).id).via).toEqual({
      table: 'agent_keys',
      id: keyId,
      name: 'Build bot',
    })
    expect(JSON.stringify(archive.tables['deleted/items'])).not.toContain("Ada's laptop")
  })
})

describe("an item's state", () => {
  it('calls a moving project item partial, with its stored rows, and skips its live tasks without a duplicate', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { tasks } = await projectFamily(t, f)
    // a move that needs steps, which the export runs before
    Object.assign(TRASH_BUDGET, { rows: 2, tasks: 1, ranges: 60 })
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('moving')
    await hold(t, item.id)
    later()
    const exportId = await exportAs(t, f.admin, f.org.id)
    const job = await jobOf(t, exportId)
    const archive = await archiveOf(t, exportId)
    expect(itemRow(archive, item.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'moving',
      state: 'moving',
    })
    expect(idsOf(archive.tables['deleted/projects'])).toContain(f.meta.id)
    const live = idsOf(archive.tables.tasks)
    const stored = idsOf(archive.tables['deleted/tasks'])
    expect(live.filter((id) => stored.includes(id))).toEqual([])
    // the tasks still in issues under the absent projects are skipped
    const stillLive = tasks.filter((task) => !stored.includes(task.id))
    expect(stillLive.length).toBeGreaterThan(0)
    expect(job?.skipped).toBe(stillLive.length)
    expect(archive.manifest.skipped.tasks).toBe(stillLive.length)
    for (const task of stillLive) expect(live).not.toContain(task.id)
    expect(archive.manifest.deleted_items?.items).toEqual({ complete: 0, partial: 1 })
  })

  it('calls a restoring project item partial before its reveal', async () => {
    const t = newT()
    const f = await withOrg(t)
    await projectFamily(t, f)
    await deleteProject(t, f, f.meta.id)
    await settle(t)
    const item = await itemFor(t, f.meta.id)
    Object.assign(TRASH_BUDGET, { rows: 2, tasks: 1, ranges: 60 })
    await restore(t, f.user, [item.id])
    expect(await itemById(t, item.id)).toMatchObject({ state: 'restoring' })
    await hold(t, item.id)
    expect(await t.run((ctx) => byId(ctx, 'projects', f.meta.id))).toBeNull()
    later()
    const archive = await archiveOf(t, await exportAs(t, f.admin, f.org.id))
    expect(itemRow(archive, item.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'restoring',
    })
  })

  it('leaves out the stored grants of a project item past its reveal, exporting them once from the live table', async () => {
    const t = newT()
    const f = await withOrg(t)
    await projectFamily(t, f)
    await deleteProject(t, f, f.meta.id)
    await settle(t)
    const item = await itemFor(t, f.meta.id)
    Object.assign(TRASH_BUDGET, { rows: 2, tasks: 1, ranges: 60 })
    await restore(t, f.user, [item.id])
    // step the restore until its reveal is done and its stored grants wait
    for (let guard = 0; guard < 200; guard++) {
      const job = await jobFor(t, item.id)
      if (job?.phase === 'restore_grants') break
      await hold(t, item.id)
      await step(t, item.id)
    }
    expect((await jobFor(t, item.id))?.phase).toBe('restore_grants')
    await hold(t, item.id)
    expect(await t.run((ctx) => byId(ctx, 'projects', f.meta.id))).not.toBeNull()
    const storedGrants = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('deleted_rows')
            .withIndex('by_item_table_owner', (q) =>
              q.eq('item_id', item.id).eq('table', 'project_access'),
            )
            .collect()
        ).length,
    )
    expect(storedGrants).toBeGreaterThan(0)
    later()
    const archive = await archiveOf(t, await exportAs(t, f.admin, f.org.id))
    expect(itemRow(archive, item.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'restored',
    })
    // the grants are in the live table once, and their stored copies out
    expect(archive.tables['deleted/project_access']).toEqual([])
    const live = await t.run((ctx) =>
      ctx.db
        .query('project_access')
        .withIndex('by_project', (q) => q.eq('project_id', f.meta.id))
        .collect(),
    )
    expect(live.length).toBeGreaterThan(0)
    const grants = archive.tables.project_access.filter((row) => row.project_id === f.meta.id)
    expect(grants.map((row) => row.profile_id).sort()).toEqual(
      live.map((row) => row.profile_id).sort(),
    )
  })

  it('calls a purging item partial and leaves its rows out, a stuck one partial with its rows, and shows dropped rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await comment(t, task)
      await deleteTask(t, f, task.id)
      tasks.push(task)
    }
    const [purging, stuck, dropped] = await Promise.all(tasks.map((task) => itemFor(t, task.id)))
    await t.run(async (ctx) => {
      await ctx.db.patch(purging._id, { state: 'purging' })
      await ctx.db.patch(stuck._id, { state: 'stuck' })
      await ctx.db.patch(dropped._id, { dropped_rows: 2 })
    })
    later()
    const archive = await archiveOf(t, await exportAs(t, f.admin, f.org.id))
    expect(itemRow(archive, purging.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'purging',
    })
    expect(itemRow(archive, stuck.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'stuck',
    })
    expect(itemRow(archive, dropped.id)).toMatchObject({ export_rows: 'complete', dropped_rows: 2 })
    const items = archive.tables['deleted/tasks'].map((row) => row.deleted_item_id)
    expect(items).not.toContain(purging.id)
    expect(items).toContain(stuck.id)
    expect(archive.tables['deleted/comments'].map((row) => row.deleted_item_id)).not.toContain(
      purging.id,
    )
  })
})

describe('Deleted items that change while the export runs', () => {
  it('marks an item deleted after collection began, its rows in deleted/', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    later()
    await deleteTask(t, f, task.id)
    await settle(t)
    const item = await itemFor(t, task.id)
    const archive = await archiveOf(t, export_id)
    expect(itemRow(archive, item.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'deleted_during_export',
      deleted_during_export: true,
    })
    // the live read came after the delete, so the task is in deleted/ only
    expect(idsOf(archive.tables['deleted/tasks'])).toEqual([task.id])
    expect(idsOf(archive.tables.tasks)).not.toContain(task.id)
  })

  it('leaves out of deleted/ the rows of an item deleted after their live sections read them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await comment(t, task)
    const file = await attach(t, task)
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    // every live section of a task's rows has ended: agent_keys is next
    await exportUntil(t, export_id, sectionOf('agent_keys'))
    later()
    await deleteTask(t, f, task.id)
    await settle(t)
    const item = await itemFor(t, task.id)
    const archive = await archiveOf(t, export_id)
    expect(idsOf(archive.tables.tasks)).toContain(task.id)
    expect(archive.tables.comments.filter((row) => row.task_id === task.id)).toHaveLength(1)
    expect(idsOf(archive.tables.task_attachments)).toContain(file.id)
    // once in the archive, not twice
    expect(archive.tables['deleted/tasks']).toEqual([])
    expect(archive.tables['deleted/comments']).toEqual([])
    expect(archive.tables['deleted/task_attachments']).toEqual([])
    expect(itemRow(archive, item.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'deleted_during_export',
      deleted_during_export: true,
    })
  })

  it('keeps in deleted/ a link the live read dropped while an item was in flight, once its task is deleted after the read', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { tasks } = await projectFamily(t, f)
    // a task outside the family, linked to each of its tasks
    const source = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    await t.run(async (ctx) => {
      for (const target of tasks)
        await ctx.db.insert('issue_links', {
          org_id: f.org.id,
          id: uuid(),
          source_id: source.id,
          target_id: target.id,
          type: 'blocks',
          pair_key: [source.id, target.id].sort().join(':'),
          created_at: NOW,
          task_key: source.window_key,
        })
    })
    // a move held part way, some tasks still in issues under its absent
    // projects, so the live read drops the links to them
    Object.assign(TRASH_BUDGET, { rows: 2, tasks: 1, ranges: 60 })
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    await hold(t, item.id)
    const stillLive = await t.run(async (ctx) => {
      const out: string[] = []
      for (const task of tasks) if ((await byId(ctx, 'issues', task.id)) !== null) out.push(task.id)
      return out
    })
    expect(stillLive.length).toBeGreaterThan(0)
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    // the live sections of a task's rows have all ended, and agent_keys is next
    const read = await exportUntil(t, export_id, sectionOf('agent_keys'))
    // each live read of a table Deleted items stores found the item moving
    expect([...(read?.step.in_flight ?? [])].sort()).toEqual(
      JOB_ORDER.flatMap((section) => (section.kind === 'stored' ? [section.name] : [])).sort(),
    )
    later()
    // the source's delete stores its links to the tasks still in issues
    Object.assign(TRASH_BUDGET, { rows: 300, tasks: 100, ranges: 2500 })
    await deleteTask(t, f, source.id)
    await hold(t, item.id)
    await settle(t)
    const archive = await archiveOf(t, export_id)
    const targets = (rows: readonly OrgExportRow[]) =>
      rows.filter((row) => row.source_id === source.id).map((row) => row.target_id as string)
    expect(targets(archive.tables.task_links)).toEqual([])
    // every link once, none lost
    expect(targets(archive.tables['deleted/task_links']).sort()).toEqual(
      tasks.map((task) => task.id).sort(),
    )
    const deleted = await itemFor(t, source.id)
    expect(
      archive.tables['deleted/task_links']
        .filter((row) => stillLive.includes(row.target_id as string))
        .map((row) => row.deleted_item_id),
    ).toEqual(stillLive.map(() => deleted.id))
    expect(itemRow(archive, deleted.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'deleted_during_export',
    })
  })

  it('leaves out a stored row only when the live read held it for certain', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await comment(t, task)
    await deleteTask(t, f, task.id)
    await settle(t)
    const item = await itemFor(t, task.id)
    const stored = await t.run((ctx) =>
      ctx.db
        .query('deleted_rows')
        .withIndex('by_item_table_owner', (q) => q.eq('item_id', item.id).eq('table', 'comments'))
        .unique(),
    )
    if (stored === null) throw new Error('no stored comment')
    // the live comments read began at B and ended at E, around the moment
    // C the comment was stored
    const c = stored._creationTime
    const b = c - 20_000
    const e = c - 10_000
    const iso = (ms: number) => new Date(ms).toISOString()
    /** The comment ids one read of deleted/comments gives, with the item
     * deleted at `deleted`, the comment created at `created` and the live
     * read ending at `ended`, which found an item in flight in `inFlight`. */
    const read = async (a: {
      deleted?: number
      created?: number
      ended?: number
      inFlight?: string[]
    }) => {
      await t.run(async (ctx) => {
        await ctx.db.patch(item._id, { deleted_at: iso(a.deleted ?? e + 5_000) })
        await ctx.db.patch(stored._id, { created_ts: a.created ?? b - 1_000 })
      })
      const batch = await t.run((ctx) =>
        readBatch(
          ctx,
          f.org.id,
          { section: sectionOf('deleted/comments'), cursor: null },
          {
            job: {
              started_at: iso(b - 30_000),
              ended: { task_attachments: iso(b), comments: iso(a.ended ?? e) },
              in_flight: a.inFlight ?? [],
              unsettled: [],
            },
          },
        ),
      )
      return batch.rows.map((row) => row.id)
    }
    const kept = [stored.row_id]
    // deleted after the read ended, created before it began and stored
    // after it ended, so data/comments holds it
    expect(await read({})).toEqual([])
    // created once the read began
    expect(await read({ created: b })).toEqual(kept)
    // stored by the time the read ended (a creation time holds fractions
    // of a millisecond, an ISO time none)
    expect(await read({ ended: Math.ceil(c), deleted: c + 5_000 })).toEqual(kept)
    // deleted by the time the read ended
    expect(await read({ deleted: e })).toEqual(kept)
    // a read of comments that found an item in flight
    expect(await read({ inFlight: ['comments'] })).toEqual(kept)
  })

  it('calls an item moving while deleted/tasks reads it and ready by the items partial, changed during the export', async () => {
    const t = newT()
    const f = await withOrg(t)
    await projectFamily(t, f)
    Object.assign(TRASH_BUDGET, { rows: 2, tasks: 1, ranges: 60 })
    await deleteProject(t, f, f.meta.id)
    const item = await itemFor(t, f.meta.id)
    await hold(t, item.id)
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    await exportUntil(t, export_id, sectionOf('deleted/comments'))
    // the move goes on to the end before the export reads the items
    Object.assign(TRASH_BUDGET, { rows: 300, tasks: 100, ranges: 2500 })
    for (let guard = 0; guard < 50; guard++) {
      if ((await itemById(t, item.id))?.state === 'ready') break
      await hold(t, item.id)
      await step(t, item.id)
    }
    expect(await itemById(t, item.id)).toMatchObject({ state: 'ready' })
    await hold(t, item.id)
    await settle(t)
    const job = await jobOf(t, export_id)
    expect(job?.step.unsettled).toContain(item.id)
    const archive = await archiveOf(t, export_id)
    expect(itemRow(archive, item.id)).toMatchObject({
      state: 'ready',
      export_rows: 'partial',
      export_reason: 'changed_during_export',
      deleted_during_export: false,
    })
  })

  it('calls a ready item partial when a later batch reads a row of it stored again while the export ran', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await comment(t, task)
    await deleteTask(t, f, task.id)
    await settle(t)
    const item = await itemFor(t, task.id)
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    // between two reads that each find the item ready, a failed restore
    // and the move back store its comment again, as a new row
    await exportUntil(t, export_id, sectionOf('deleted/comments'))
    later()
    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query('deleted_rows')
        .withIndex('by_item_table_owner', (q) => q.eq('item_id', item.id).eq('table', 'comments'))
        .unique()
      if (stored === null) throw new Error('no stored comment')
      const { _id, _creationTime, ...again } = stored
      await ctx.db.delete(_id)
      await ctx.db.insert('deleted_rows', again)
    })
    await settle(t)
    expect(await itemById(t, item.id)).toMatchObject({ state: 'ready' })
    const archive = await archiveOf(t, export_id)
    expect(itemRow(archive, item.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'changed_during_export',
      deleted_during_export: false,
    })
  })

  it('leaves rows of an item restored before the items section under an item deleted/items does not list', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f, task.id)
    await settle(t)
    const item = await itemFor(t, task.id)
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id: f.org.id })
    await exportUntil(t, export_id, sectionOf('deleted/items'))
    await restore(t, f.user, [item.id])
    for (let guard = 0; guard < 50 && (await itemById(t, item.id)) !== null; guard++) {
      await hold(t, item.id)
      await step(t, item.id)
    }
    expect(await itemById(t, item.id)).toBeNull()
    await settle(t)
    const archive = await archiveOf(t, export_id)
    expect(archive.tables['deleted/tasks']).toEqual([
      expect.objectContaining({ id: task.id, deleted_item_id: item.id }),
    ])
    expect(archive.tables['deleted/items'].map((row) => row.id)).not.toContain(item.id)
    expect(idsOf(archive.tables.tasks)).not.toContain(task.id)
    expect(archive.readme).toMatch(/whose deleted_item_id deleted\/items does not list/)
  })

  it('calls an item partial once a restore hands it a link behind the cursor of deleted/task_links, which the archive then lacks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // B's task sorts before A's in deleted_rows' by_table_org_owner
    const b = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      id: '00000000-0000-4000-8000-00000000000b',
    })
    const a = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      id: 'ffffffff-0000-4000-8000-00000000000a',
    })
    const link = (source: Doc<'issues'>, target: Doc<'issues'>) =>
      t.run(async (ctx) => {
        const id = uuid()
        await ctx.db.insert('issue_links', {
          org_id,
          id,
          source_id: source.id,
          target_id: target.id,
          type: 'relates',
          pair_key: [source.id, target.id].sort().join(':'),
          created_at: NOW,
          task_key: source.window_key,
        })
        return id
      })
    // A's link to B, which A's item stores, and a page of B's links to live
    // tasks, which B's item stores
    const handed = await link(a, b)
    for (let i = 0; i < JOINED_PAGE_SIZE; i++)
      await link(b, await plantIssue(t, { org_id, project_id: f.sub.id }))
    await deleteTask(t, f, a.id)
    await deleteTask(t, f, b.id)
    await settle(t)
    const [itemA, itemB] = [await itemFor(t, a.id), await itemFor(t, b.id)]
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id })
    await exportUntil(t, export_id, sectionOf('deleted/task_links'))
    // one read of deleted/task_links takes B's page and stops before A's link
    EXPORT_LIMITS.reads = 1
    await nextStep(t)
    expect((await jobOf(t, export_id))?.step).toMatchObject({
      section: sectionOf('deleted/task_links'),
      cursor: expect.any(String),
    })
    EXPORT_LIMITS.reads = DEFAULT_LIMITS.reads
    later()
    // A's restore hands its link to B's item, owned by B, behind the cursor
    await restore(t, f.user, [itemA.id])
    for (let guard = 0; guard < 50 && (await itemById(t, itemA.id)) !== null; guard++) {
      await hold(t, itemA.id)
      await step(t, itemA.id)
    }
    expect(await itemById(t, itemA.id)).toBeNull()
    const moved = await t.run((ctx) =>
      ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', 'issue_links').eq('row_id', handed))
        .unique(),
    )
    expect(moved).toMatchObject({ item_id: itemB.id, owner_id: b.id })
    expect((await itemById(t, itemB.id))?.received_at).toBe(new Date(Date.now()).toISOString())
    await settle(t)
    const archive = await archiveOf(t, export_id)
    // the link is in neither part, so B's item cannot be complete
    expect(archive.tables['deleted/task_links'].map((row) => row.id)).not.toContain(handed)
    expect(archive.tables.task_links.map((row) => row.id)).not.toContain(handed)
    expect(archive.tables['deleted/task_links']).toHaveLength(JOINED_PAGE_SIZE)
    expect(itemRow(archive, itemB.id)).toMatchObject({
      state: 'ready',
      export_rows: 'partial',
      export_reason: 'changed_during_export',
      deleted_during_export: false,
    })
    expect(itemRow(archive, itemB.id)).not.toHaveProperty('received_at')
  })

  it("calls an item partial once a restore's split hands it a subtask while the export runs", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const root = await plantIssue(t, { org_id, project_id: f.sub.id })
    const sub = await plantIssue(t, { org_id, project_id: f.sub2.id, parent_id: root.id })
    await comment(t, sub)
    await deleteTask(t, f, root.id, { subtask_ids: [sub.id] })
    await deleteProject(t, f, f.sub2.id)
    await settle(t)
    const [taskItem, projectItem] = [await itemFor(t, root.id), await itemFor(t, f.sub2.id)]
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id })
    // every stored table is read; the items come next
    await exportUntil(t, export_id, sectionOf('deleted/items'))
    later()
    // the subtask's project is in Deleted items, so the restore moves the
    // subtask with its rows to the item that holds it
    await restore(t, f.user, [taskItem.id])
    for (let guard = 0; guard < 50 && (await itemById(t, taskItem.id)) !== null; guard++) {
      await hold(t, taskItem.id)
      await step(t, taskItem.id)
    }
    expect(await itemById(t, taskItem.id)).toBeNull()
    expect((await storedTasks(t, projectItem.id)).map((task) => task.task_id)).toEqual([sub.id])
    await settle(t)
    const archive = await archiveOf(t, export_id)
    // read under the item that held it then, which deleted/items no longer lists
    expect(archive.tables['deleted/tasks'].find((row) => row.id === sub.id)).toMatchObject({
      deleted_item_id: taskItem.id,
    })
    expect(itemRow(archive, projectItem.id)).toMatchObject({
      state: 'ready',
      export_rows: 'partial',
      export_reason: 'changed_during_export',
      deleted_during_export: false,
    })
  })

  it('fails with deleted_changing once more items change than EXPORT_LIMITS.unsettled names, erasing its parts', async () => {
    const t = newT()
    const f = await withOrg(t)
    const moving: string[] = []
    for (let i = 0; i < 2; i++) {
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
      await deleteTask(t, f, task.id)
      const item = await itemFor(t, task.id)
      await t.run((ctx) => ctx.db.patch(item._id, { state: 'moving' }))
      moving.push(item.id)
    }
    EXPORT_LIMITS.unsettled = 1
    later()
    const exportId = await exportAs(t, f.admin, f.org.id)
    expect(await jobOf(t, exportId)).toMatchObject({
      state: 'failed',
      error: {
        code: 'deleted_changing',
        message:
          'The export stopped because many deleted items changed while it ran. Start a new export.',
      },
    })
    expect(await partsOf(t, exportId)).toEqual([])
  })
})

describe('the Deleted items section pages', () => {
  const job = (startedAt: string): BatchJob => ({
    started_at: startedAt,
    ended: {},
    in_flight: [],
    unsettled: [],
  })

  /** The rows each read of section `key` gives, in order. */
  async function pages(t: T, orgId: string, key: string) {
    const reads: OrgExportRow[][] = []
    let at = { section: sectionOf(key), cursor: null as string | null }
    const started = new Date(Date.now()).toISOString()
    for (let guard = 0; guard < 20; guard++) {
      const batch = await t.run((ctx) => readBatch(ctx, orgId, at, { job: job(started) }))
      reads.push(batch.rows)
      if (batch.done) break
      at = { section: at.section, cursor: batch.at.cursor }
    }
    return reads
  }

  it('pages one item with 250 stored comments as the live comments page', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++)
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: task.id,
          body: `Note ${i}`,
          created_at: NOW,
        })
    })
    await deleteTask(t, f, task.id)
    await settle(t)
    later()
    const reads = await pages(t, f.org.id, 'deleted/comments')
    expect(reads.map((rows) => rows.length)).toEqual([100, 100, 50])
    expect(new Set(reads.flat().map((row) => row.id)).size).toBe(250)
  })

  it('reads the rows of many items in one page, each once, and the items in pages of their own', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 120 task items with a stored comment each, planted as a move stores them
    const ids = await t.run(async (ctx) => {
      const out: string[] = []
      for (let i = 0; i < 120; i++) {
        const id = uuid()
        const taskId = uuid()
        await ctx.db.insert('deleted_items', {
          id,
          org_id: f.org.id,
          kind: 'task',
          target_id: taskId,
          num: 9000 + i,
          name: `Bench task ${i}`,
          status: 'todo',
          archived: false,
          project_id: f.sub.id,
          parent_project_id: f.meta.id,
          path: [f.meta.name, f.sub.name],
          projects: [],
          counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
          deleted_at: NOW,
          deleted_by: f.user.id,
          state: 'ready',
          purge_after: Date.parse(NOW) + 30 * 86_400_000,
        })
        const commentId = uuid()
        await ctx.db.insert('deleted_rows', {
          item_id: id,
          org_id: f.org.id,
          table: 'comments',
          owner_id: taskId,
          row_id: commentId,
          created_ts: Date.parse(NOW),
          row: {
            table: 'comments',
            doc: { id: commentId, issue_id: taskId, body: `Note ${i}`, created_at: NOW },
          },
        })
        out.push(id)
      }
      return out
    })
    later()
    const comments = await pages(t, f.org.id, 'deleted/comments')
    expect(comments.map((rows) => rows.length)).toEqual([100, 20])
    expect(
      comments
        .flat()
        .map((row) => row.deleted_item_id)
        .sort(),
    ).toEqual([...ids].sort())
    const items = await pages(t, f.org.id, 'deleted/items')
    expect(items.map((rows) => rows.length)).toEqual([100, 20])
    expect(
      items
        .flat()
        .map((row) => row.id)
        .sort(),
    ).toEqual([...ids].sort())
  })
})

describe("the Deleted items section reads only the organization's own rows", () => {
  it("leaves out and counts stored rows that name another organization, and never reads another organization's items", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const task = await plantIssue(t, { org_id, project_id: f.sub.id })
    const to = await plantIssue(t, { org_id, project_id: f.sub.id })
    const from = await plantIssue(t, { org_id, project_id: f.sub.id })
    await plantRows(t, f, task, { to, from })
    await deleteTask(t, f, task.id)
    await settle(t)
    const item = await itemFor(t, task.id)
    // another organization's task, label and Deleted items
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    const gone = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await as(t, f.otherAdmin).mutation(api.issues.deleteDeep, {
      org_id: f.otherOrg.id,
      id: gone.id,
    })
    await settle(t)
    const foreignItem = await itemFor(t, gone.id)
    const foreignLabel = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id: foreignLabel,
        org_id: f.otherOrg.id,
        name: 'Elsewhere',
        name_lower: 'elsewhere',
        color: '#000',
        created_at: NOW,
      })
      const rows = await ctx.db
        .query('deleted_rows')
        .withIndex('by_item_owner', (q) => q.eq('item_id', item.id))
        .collect()
      for (const stored of rows) {
        const { row } = stored
        if (row.table === 'issue_links' && row.doc.source_id === task.id)
          await ctx.db.patch(stored._id, {
            row: { table: 'issue_links', doc: { ...row.doc, target_id: foreign.id } },
          })
        if (row.table === 'issue_labels')
          await ctx.db.patch(stored._id, {
            row: { table: 'issue_labels', doc: { ...row.doc, label_id: foreignLabel } },
          })
        if (row.table === 'issue_attachments')
          await ctx.db.patch(stored._id, {
            row: { table: 'issue_attachments', doc: { ...row.doc, org_id: f.otherOrg.id } },
          })
        // a comment whose item id names the other organization's item
        if (row.table === 'comments') await ctx.db.patch(stored._id, { item_id: foreignItem.id })
      }
    })
    later()
    const archive = await archiveOf(t, await exportAs(t, f.admin, org_id))
    expect(archive.tables['deleted/task_links'].map((row) => row.source_id)).toEqual([from.id])
    expect(archive.tables['deleted/task_labels']).toEqual([])
    expect(archive.tables['deleted/task_attachments']).toEqual([])
    expect(archive.tables['deleted/comments']).toEqual([])
    expect(archive.manifest.deleted_items?.left_out).toEqual({
      'deleted/comments': 1,
      'deleted/task_labels': 1,
      'deleted/task_links': 1,
      'deleted/task_attachments': 1,
    })
    expect(archive.tables['deleted/items'].map((row) => row.id)).toEqual([item.id])
    expect(JSON.stringify(archive.tables)).not.toContain(gone.id)
    expect(JSON.stringify(archive.tables)).not.toContain(f.otherOrg.id)
  })

  it('calls an item partial once a record it kept names a label or team deleted after it, and every item once more items lose records than the job may name', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // a task with a label, deleted before its label
    const labeled = await plantIssue(t, { org_id, project_id: f.hidden.id })
    const labelId = uuid()
    const admin = as(t, f.admin)
    await admin.mutation(api.labels.create, {
      org_id,
      id: labelId,
      name: 'Bench',
      color: '#ffcc00',
    })
    await as(t, f.user).mutation(api.labels.toggle, {
      org_id,
      issue_id: labeled.id,
      label_id: labelId,
      on: true,
    })
    await deleteTask(t, f, labeled.id)
    // a project shared with a team, deleted before the team
    const teamId = uuid()
    await admin.mutation(api.teams.create, { org_id, id: teamId, name: 'Bench crew' })
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: teamId,
        level: 'user',
      }),
    )
    await deleteProject(t, f, f.meta.id)
    // and a task item that keeps every record
    const plain = await plantIssue(t, { org_id, project_id: f.hidden.id })
    await deleteTask(t, f, plain.id)
    await settle(t)
    // the normal deletes of the label and the team leave the stored rows
    await admin.mutation(api.labels.remove, { org_id, id: labelId })
    await admin.mutation(api.teams.deleteDeep, { org_id, id: teamId })
    await settle(t)
    const [labeledItem, sharedItem, plainItem] = [
      await itemFor(t, labeled.id),
      await itemFor(t, f.meta.id),
      await itemFor(t, plain.id),
    ]
    for (const [item, table] of [
      [labeledItem, 'issue_labels'],
      [sharedItem, 'project_team_access'],
    ] as const)
      expect(
        (
          await t.run((ctx) =>
            ctx.db
              .query('deleted_rows')
              .withIndex('by_item_table_owner', (q) => q.eq('item_id', item.id).eq('table', table))
              .collect(),
          )
        ).length,
        table,
      ).toBe(1)
    later()
    const first = await exportAs(t, f.admin, org_id)
    const archive = await archiveOf(t, first)
    expect(archive.tables['deleted/task_labels']).toEqual([])
    expect(archive.tables['deleted/project_team_access']).toEqual([])
    expect(archive.manifest.deleted_items?.left_out).toEqual({
      'deleted/task_labels': 1,
      'deleted/project_team_access': 1,
    })
    for (const item of [labeledItem, sharedItem])
      expect(itemRow(archive, item.id)).toMatchObject({
        state: 'ready',
        export_rows: 'partial',
        export_reason: 'rows_left_out',
        deleted_during_export: false,
      })
    expect(itemRow(archive, plainItem.id)).toMatchObject({ export_rows: 'complete' })
    expect(itemRow(archive, plainItem.id)).not.toHaveProperty('export_reason')
    expect(archive.manifest.deleted_items?.items).toEqual({ complete: 1, partial: 2 })
    expect((await jobOf(t, first))?.step.left_out_items?.sort()).toEqual(
      [labeledItem.id, sharedItem.id].sort(),
    )

    // past the names the job keeps, every item is partial, also one that
    // kept every record
    EXPORT_LIMITS.leftOut = 1
    later()
    const second = await exportAs(t, f.admin, org_id)
    const capped = await archiveOf(t, second)
    for (const item of [labeledItem, sharedItem, plainItem])
      expect(itemRow(capped, item.id)).toMatchObject({
        export_rows: 'partial',
        export_reason: 'rows_left_out',
      })
    expect(capped.manifest.deleted_items?.items).toEqual({ complete: 0, partial: 3 })
    const step = (await jobOf(t, second))?.step
    expect(step?.left_out_more).toBe(true)
    expect(step?.left_out_items).toBeUndefined()
  })

  it('says format 4 in the README and manifest, with the Deleted items tables, tallies and the skipped tasks', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deleteTask(t, f, task.id)
    await settle(t)
    later()
    const archive = await archiveOf(t, await exportAs(t, f.admin, f.org.id))
    expect(archive.manifest).toMatchObject({
      version: 4,
      consistency_note: LIVE_READ_WARNING,
      skipped: { tasks: 0, reason: expect.stringMatching(/Their item in deleted\/items/) },
      deleted_items: {
        items: { complete: 1, partial: 0 },
        tables: {
          'deleted/tasks': { files: ['deleted/tasks/0001.json'], records: 1 },
          'deleted/items': { files: ['deleted/items/0001.json'], records: 1 },
        },
        note: expect.stringMatching(/restores nothing/),
      },
    })
    expect(Object.keys(archive.manifest.deleted_items?.tables ?? {})).toEqual(
      JOB_ORDER.filter((section) => section.folder === 'deleted').map((section) => section.key),
    )
    expect(archive.manifest.exclusions.join('\n')).toMatch(/Deleted items' bookkeeping/)
    expect(archive.manifest.exclusions.join('\n')).not.toMatch(/restore an item/)
    expect(archive.readme).toMatch(/Being in this archive restores nothing/)
    expect(archive.readme).toMatch(/Records Qivo already deleted for good are not here/)
    expect(archive.readme).toMatch(/manifest.json counts such tasks\s+under\s+skipped/)
  })
})

describe('a job collecting at the deploy of format 4', () => {
  it('goes on from the live sections a format 3 job read into the Deleted items section, keeping every stored row, and finishes as format 4', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const before = await plantIssue(t, { org_id, project_id: f.sub.id })
    await comment(t, before)
    await deleteTask(t, f, before.id)
    await settle(t)
    const during = await plantIssue(t, { org_id, project_id: f.sub.id })
    await comment(t, during)
    later()
    const { export_id } = await as(t, f.admin).mutation(api.orgExport.request, { org_id })
    // the release before read the live sections only, so its job is past
    // them, and it wrote none of this release's step fields
    await exportUntil(t, export_id, ORG_EXPORT_ORDER.length)
    await t.run(async (ctx) => {
      const job = await byId(ctx, 'org_exports', export_id)
      if (job === null) throw new Error('no job')
      const { n, section, cursor, part, seq, bytes, counts } = job.step
      expect(section).toBe(ORG_EXPORT_ORDER.length)
      await ctx.db.patch(job._id, {
        format_version: 3,
        step: { n, section, cursor, part, seq, bytes, counts },
      })
    })
    // deleted after the live sections read it
    later()
    await deleteTask(t, f, during.id)
    await settle(t)
    expect(await jobOf(t, export_id)).toMatchObject({ state: 'ready', format_version: 4 })
    const [beforeItem, duringItem] = [await itemFor(t, before.id), await itemFor(t, during.id)]
    const archive = await archiveOf(t, export_id)
    expect(archive.manifest.version).toBe(4)
    expect(Object.keys(archive.manifest.deleted_items?.tables ?? {})).toEqual(
      JOB_ORDER.filter((section) => section.folder === 'deleted').map((section) => section.key),
    )
    // with no record of when the live sections ended, every stored row
    // stays, also those of an item deleted after its table was read
    const expected = await storedExpectation(t, org_id, [beforeItem.id, duringItem.id])
    for (const [key, rows] of Object.entries(expected))
      expect(archive.tables[key], key).toEqual(rows)
    expect(idsOf(archive.tables['deleted/tasks'])).toEqual([before.id, during.id].sort())
    expect(archive.tables['deleted/comments']).toHaveLength(2)
    expect(itemRow(archive, beforeItem.id)).toMatchObject({ export_rows: 'complete' })
    expect(itemRow(archive, duringItem.id)).toMatchObject({
      export_rows: 'partial',
      export_reason: 'deleted_during_export',
      deleted_during_export: true,
    })
  })
})

describe("the Deleted items section inside Convex's limits", () => {
  it("reads deleted/tasks of a project item holding a project's 800 open tasks, every task once", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const third = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      key: 'QA',
      name: 'Bench QA',
    })
    // a project's open figure at its design size in three sub-projects,
    // everyday elsewhere
    const planted: string[] = []
    for (const [i, project] of [f.sub, f.sub2, third].entries())
      for (let n = 0; n < (i === 2 ? 266 : 267); n++)
        planted.push(
          (
            await plantIssue(t, {
              org_id: f.org.id,
              project_id: project.id,
              description: `<p>Bench run ${n}: replaced the fan controller, logged the readings at idle and under load, and compared them with the last calibration.</p>`,
            })
          ).id,
        )
    await deleteProject(t, f, f.meta.id)
    await settle(t)
    const item = await itemFor(t, f.meta.id)
    expect(item.state).toBe('ready')
    later()
    const started = new Date(Date.now()).toISOString()
    let at = { section: sectionOf('deleted/tasks'), cursor: null as string | null }
    const read: string[] = []
    const measures: { rows: number; ranges: number; documents: number; mib: number }[] = []
    for (let guard = 0; guard < 20; guard++) {
      const m = await t.run(async (ctx: QueryCtx) => {
        const batch = await readBatch(ctx, f.org.id, at, {
          job: { started_at: started, ended: {}, in_flight: [], unsettled: [] },
        })
        const metrics = await ctx.meta.getTransactionMetrics()
        return {
          batch,
          ranges: metrics.databaseQueries.used,
          documents: metrics.documentsRead.used,
          mib: Math.round((metrics.bytesRead.used / 1024 / 1024) * 1000) / 1000,
        }
      })
      measures.push({
        rows: m.batch.rows.length,
        ranges: m.ranges,
        documents: m.documents,
        mib: m.mib,
      })
      read.push(...m.batch.rows.map((row) => row.id as string))
      if (m.batch.done) break
      at = { section: at.section, cursor: m.batch.at.cursor }
    }
    console.info('export: deleted/tasks of a project item of 800 open tasks', {
      reads: measures.length,
      most_ranges: Math.max(...measures.map((m) => m.ranges)),
      most_documents: Math.max(...measures.map((m) => m.documents)),
      most_mib: Math.max(...measures.map((m) => m.mib)),
      rows: measures.map((m) => m.rows),
    })
    expect(read.sort()).toEqual([...planted].sort())
    for (const m of measures) expect(m.mib).toBeLessThan(4)
  })
})
