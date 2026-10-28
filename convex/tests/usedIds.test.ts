/* Every id a task or project held stays taken until its organization's
 * teardown ends (schema.ts used_ids). A create refuses it in any
 * organization, whichever path makes the task or project, Deleted items
 * keeps it through a move, a restore and a purge, every teardown lets it go
 * after everything else of the organization, unless something outside the
 * organization still names it, and internal/usedIdsBackfill records the ids
 * held from before the table. */

import type { FunctionArgs } from 'convex/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { BACKFILL_PAGE, RUN } from '../internal/usedIdsBackfill'
import { insertUsed, keepUsedId, newWindowKey } from '../lib/db'
import { rule } from '../lib/functions'
import { deleteOrgDeep, REMOVAL_BUDGET } from '../model/cascade'
import { insertTask } from '../model/descriptions'
import { wipeWorkStep } from '../model/orgDeletion'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'
import {
  deleteTask,
  forgetUsedId,
  installTrashTimers,
  itemFor,
  liveTask,
  runSteps,
} from './trash.setup'

installTrashTimers()
const DEFAULT_PAGE = structuredClone(BACKFILL_PAGE)
const DEFAULT_RUN = { ...RUN }
afterEach(() => {
  Object.assign(BACKFILL_PAGE, structuredClone(DEFAULT_PAGE))
  Object.assign(RUN, DEFAULT_RUN)
})

const ALREADY = /with this id already exists/

/** Every used_ids row of id `id`. */
const usedOf = (t: T, id: string) =>
  t.run(async (ctx) => (await ctx.db.query('used_ids').collect()).filter((r) => r.row_id === id))

/** Every used_ids row organization `orgId` holds, kept ones included. */
const usedBy = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('used_ids')
      .withIndex('by_org_kept', (q) => q.eq('org_id', orgId))
      .collect(),
  )

let keys = 0

/** A new task `id` in sub-project `projectId`, created through the app by
 * `who`. */
const createTask = (t: T, who: Doc<'profiles'>, projectId: string, id: string) =>
  as(t, who).mutation(api.issues.create, {
    org_id: who.org_id,
    id,
    project_id: projectId,
    title: 'Again',
  })

/** A new project `id`, a sub-project of `parentId` when given, created
 * through the app by `who`. */
const createProject = (t: T, who: Doc<'profiles'>, id: string, parentId?: string) =>
  as(t, who).mutation(api.projects.create, {
    org_id: who.org_id,
    id,
    type: parentId === undefined ? 'meta' : 'project',
    ...(parentId === undefined ? {} : { parent_id: parentId }),
    key: `U${keys++}`,
    name: 'Again',
    sort_order: 9,
  })

/** Moves task or project `id` of `f`'s organization to Deleted items and
 * purges it for good, every step run, so no live row or stored copy holds
 * the id any more. */
async function purge(t: T, f: OrgFixture, id: string, kind: 'task' | 'project') {
  if (kind === 'task') await deleteTask(t, f, id)
  else await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id })
  await runSteps(t)
  const item = await itemFor(t, id)
  await as(t, f.admin).mutation(api.deletedItems.purge, { org_id: f.org.id, ids: [item.id] })
  await runSteps(t)
  const stored = await t.run((ctx) =>
    ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) =>
        q.eq('table', kind === 'task' ? 'issues' : 'projects').eq('row_id', id),
      )
      .first(),
  )
  expect(stored).toBeNull()
}

/** A sub-project of the other organization's project, for its tasks. */
const otherSub = (t: T, f: OrgFixture) =>
  plantProject(t, { org_id: f.otherOrg.id, type: 'project', parent_id: f.otherProject.id })

/** The id each of `uuids` calls of crypto.randomUUID answers, in order, as
 * the server's next new ids. */
function nextUuids(...uuids: string[]) {
  const spy = vi.spyOn(crypto, 'randomUUID')
  for (const id of uuids)
    spy.mockImplementationOnce(() => id as ReturnType<typeof crypto.randomUUID>)
}

describe('a used task or project id', () => {
  it('is refused for a new task in the same organization and in another once purged', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await createTask(t, f.user, f.sub.id, id)
    expect(await usedOf(t, id)).toMatchObject([{ table: 'issues', org_id: f.org.id }])
    await purge(t, f, id, 'task')
    expect(await liveTask(t, id)).toBeNull()
    // the purge leaves the row
    expect(await usedOf(t, id)).toMatchObject([{ table: 'issues', org_id: f.org.id }])
    await expectRefusal(createTask(t, f.user, f.sub.id, id), 'bad_request', ALREADY)
    await expectRefusal(
      createTask(t, f.otherAdmin, (await otherSub(t, f)).id, id),
      'bad_request',
      ALREADY,
    )
    // a subtask with the id is refused before its parent is checked
    const parent = uuid()
    await createTask(t, f.user, f.sub.id, parent)
    await expectRefusal(
      as(t, f.user).mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        parent_id: parent,
        title: 'Again',
      }),
      'bad_request',
      ALREADY,
    )
    expect(await usedOf(t, id)).toHaveLength(1)
  })

  it('is refused for a new project in the same organization and in another once purged', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await createProject(t, f.admin, id, f.meta.id)
    expect(await usedOf(t, id)).toMatchObject([{ table: 'projects', org_id: f.org.id }])
    await purge(t, f, id, 'project')
    await expectRefusal(createProject(t, f.admin, id, f.meta.id), 'bad_request', ALREADY)
    await expectRefusal(createProject(t, f.admin, id), 'bad_request', ALREADY)
    await expectRefusal(createProject(t, f.otherAdmin, id), 'bad_request', ALREADY)
    expect(await usedOf(t, id)).toHaveLength(1)
  })

  it('is refused on REST and MCP creates, whose ids the server picks, should it pick one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = uuid()
    const project = uuid()
    await createTask(t, f.user, f.sub.id, task)
    await createProject(t, f.admin, project, f.meta.id)
    await purge(t, f, task, 'task')
    await purge(t, f, project, 'project')
    const machine = { callerId: f.admin.id, access: 'write' as const }
    nextUuids(task)
    await expectRefusal(
      t.mutation(internal.machine.rest.createIssue, {
        ...machine,
        keyName: null,
        body: JSON.stringify({ project: f.sub.id, title: 'Again' }),
      }),
      'bad_request',
      ALREADY,
    )
    nextUuids(task)
    await expectRefusal(
      t.mutation(internal.machine.mcp.createIssue, {
        ...machine,
        project: f.sub.id,
        title: 'Again',
      }),
      'bad_request',
      ALREADY,
    )
    nextUuids(project)
    await expectRefusal(
      t.mutation(internal.machine.projects.restCreateProject, {
        ...machine,
        keyName: null,
        body: JSON.stringify({ name: 'Again' }),
      }),
      'bad_request',
      ALREADY,
    )
    nextUuids(project)
    await expectRefusal(
      t.mutation(internal.machine.projects.mcpCreateProject, { ...machine, name: 'Again' }),
      'bad_request',
      ALREADY,
    )
    // and a fresh id the server picks goes through, with its row
    const fresh = uuid()
    nextUuids(fresh)
    await t.mutation(internal.machine.mcp.createIssue, {
      ...machine,
      project: f.sub.id,
      title: 'New',
    })
    expect(await usedOf(t, fresh)).toMatchObject([{ table: 'issues', org_id: f.org.id }])
  })

  it('is refused for an id the server chose, and a restore keeps the row its id has', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await createTask(t, f.user, f.sub.id, id)
    await purge(t, f, id, 'task')
    const doc = {
      id,
      org_id: f.otherOrg.id,
      project_id: (await otherSub(t, f)).id,
      num: 77,
      title: 'Seeded',
      description: '',
      status: 'todo' as const,
      priority: 'low' as const,
      paused: false,
      window_key: newWindowKey(),
      created_at: NOW,
      updated_at: NOW,
    }
    await expectRefusal(
      t.run((ctx) => insertTask(ctx.db, doc, { server: rule('a seeded id was used') })),
      'rule',
      /a seeded id was used/,
    )
    const project = uuid()
    await createProject(t, f.admin, project, f.meta.id)
    await purge(t, f, project, 'project')
    await expectRefusal(
      t.run((ctx) =>
        insertUsed(
          ctx.db,
          'projects',
          {
            id: project,
            org_id: f.otherOrg.id,
            type: 'meta',
            key: 'SEED',
            name: 'Seeded',
            description: '',
            sort_order: 0,
            num: 9,
            track_delay: true,
            created_at: NOW,
          },
          rule('a seeded id was used'),
        ),
      ),
      'rule',
      /a seeded id was used/,
    )
    // a restore writes a row only where its organization holds none
    expect(await t.run((ctx) => keepUsedId(ctx.db, 'issues', id, f.org.id))).toBe(false)
    expect(await t.run((ctx) => keepUsedId(ctx.db, 'issues', id, f.otherOrg.id))).toBe(true)
    expect(await usedOf(t, id)).toHaveLength(2)
  })

  it('comes back with a restore from Deleted items, which records an id stored before the table', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = uuid()
    const kept = uuid()
    const project = uuid()
    for (const id of [task, kept]) await createTask(t, f.user, f.sub.id, id)
    await createProject(t, f.admin, project, f.meta.id)
    for (const id of [task, kept]) await deleteTask(t, f, id)
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: project })
    await runSteps(t)
    // a task and a project stored before used_ids, whose rows the backfill
    // has not written
    await forgetUsedId(t, task)
    await forgetUsedId(t, project)
    // nobody takes a stored id meanwhile
    await expectRefusal(createTask(t, f.user, f.sub.id, kept), 'bad_request', ALREADY)
    await expectRefusal(createTask(t, f.user, f.sub.id, task), 'bad_request', ALREADY)
    const items = await Promise.all(
      [task, kept, project].map(async (id) => (await itemFor(t, id)).id),
    )
    await as(t, f.admin).mutation(api.deletedItems.restore, { org_id: f.org.id, ids: items })
    await runSteps(t)
    for (const id of [task, kept]) expect(await liveTask(t, id)).not.toBeNull()
    for (const [id, table] of [
      [task, 'issues'],
      [kept, 'issues'],
      [project, 'projects'],
    ] as const)
      expect(await usedOf(t, id)).toMatchObject([{ table, org_id: f.org.id }])
  })
})

/** Deletes `f`'s organization step by step as orgRemovals does, a few rows
 * a step, and checks after each step that its used_ids rows (`count` of
 * them) stay until the organization row and every row the deletion checks
 * are gone. */
async function deleteInSteps(t: T, f: OrgFixture, count: number) {
  Object.assign(REMOVAL_BUDGET, { rows: 4 })
  await as(t, f.admin).mutation(api.orgRemovals.recordExport, { org_id: f.org.id })
  const { delete_after } = await as(t, f.admin).action(api.orgRemovals.request, {
    org_id: f.org.id,
    confirm: f.org.slug,
  })
  vi.setSystemTime(Date.parse(delete_after) + 60_000)
  await t.action(internal.orgRemovals.begin, { org_id: f.org.id })
  let released = false
  for (let steps = 0; ; steps++) {
    const removal = await t.run((ctx) =>
      ctx.db
        .query('org_removals')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique(),
    )
    if (removal === null) break
    expect(steps).toBeLessThan(400)
    await t.mutation(internal.orgRemovals.step, { org_id: f.org.id })
    const left = await t.run(async (ctx) => ({
      org: await ctx.db
        .query('organizations')
        .withIndex('by_uuid', (q) => q.eq('id', f.org.id))
        .unique(),
      rows: await Promise.all(
        (['issues', 'projects', 'profiles', 'deleted_rows', 'removed_access'] as const).map(
          (table) =>
            ctx.db
              .query(table)
              .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
              .first(),
        ),
      ),
    }))
    const unkept = (await usedBy(t, f.org.id)).filter((row) => row.kept === undefined)
    if (left.org !== null || left.rows.some((row) => row !== null))
      expect(unkept).toHaveLength(count)
    else if (unkept.length < count) released = true
  }
  expect(released).toBe(true)
}

describe('teardowns', () => {
  it("an organization's deletion lets its ids go last, keeps those named outside, and leaves the others", async () => {
    const t = newT()
    const f = await withOrg(t)
    const live = uuid()
    const stored = uuid()
    const purged = uuid()
    const detaching = uuid()
    const doubled = uuid()
    for (const id of [live, stored, purged, detaching, doubled])
      await createTask(t, f.user, f.sub.id, id)
    await deleteTask(t, f, stored)
    await runSteps(t)
    for (const id of [purged, detaching, doubled]) await purge(t, f, id, 'task')
    const sub = await otherSub(t, f)
    const other = uuid()
    await createTask(t, f.otherAdmin, sub.id, other)
    await t.run(async (ctx) => {
      // a detach of a deleted task's archived subtasks still runs
      await ctx.db.insert('archived_detaches', {
        parent_id: detaching,
        actor_id: f.user.id,
        deleted_at: NOW,
        progress_at: NOW,
        attempts: 0,
      })
      // a task an earlier release wrote in the other organization during a
      // rollback, with an id this one had used
      await insertTask(
        ctx.db,
        {
          id: doubled,
          org_id: f.otherOrg.id,
          project_id: sub.id,
          num: 500,
          title: 'Written by an earlier release',
          description: '',
          status: 'todo',
          priority: 'low',
          paused: false,
          window_key: newWindowKey(),
          created_at: NOW,
          updated_at: NOW,
        },
        'restore',
      )
    })
    await forgetUsedId(t, doubled)
    await t.run((ctx) => keepUsedId(ctx.db, 'issues', doubled, f.org.id))
    const before = await usedBy(t, f.org.id)
    const otherBefore = await usedBy(t, f.otherOrg.id)
    await deleteInSteps(t, f, before.length)
    // only the ids still named outside stay, kept for good
    expect((await usedBy(t, f.org.id)).map((row) => [row.row_id, row.kept]).sort()).toEqual(
      [
        [detaching, true],
        [doubled, true],
      ].sort(),
    )
    expect(await usedBy(t, f.otherOrg.id)).toEqual(otherBefore)
    // a released id can be taken again; a kept one cannot
    await createTask(t, f.otherAdmin, sub.id, live)
    await createTask(t, f.otherAdmin, sub.id, purged)
    await expectRefusal(createTask(t, f.otherAdmin, sub.id, detaching), 'bad_request', ALREADY)
  })

  it('the Northstar wipe keeps an id a pending detach names, and lets it go at the next wipe once it ended', async () => {
    const t = newT()
    const f = await withOrg(t)
    const named = uuid()
    const other = uuid()
    for (const id of [named, other]) await createTask(t, f.user, f.sub.id, id)
    const detach = await t.run((ctx) =>
      ctx.db.insert('archived_detaches', {
        parent_id: named,
        actor_id: f.user.id,
        deleted_at: NOW,
        progress_at: NOW,
        attempts: 0,
      }),
    )
    const wipe = async () => {
      for (let calls = 0; !(await t.run((ctx) => wipeWorkStep(ctx, f.org.id, []))); calls++)
        expect(calls).toBeLessThan(20)
    }
    await wipe()
    expect(await usedOf(t, named)).toMatchObject([{ org_id: f.org.id, kept: true }])
    expect(await usedOf(t, other)).toEqual([])
    // a wipe while the detach still runs keeps the row
    await wipe()
    expect(await usedOf(t, named)).toHaveLength(1)
    await t.run((ctx) => ctx.db.delete(detach))
    await wipe()
    expect(await usedOf(t, named)).toEqual([])
  })

  it('deleteOrgDeep lets the ids go after the organization, so the guest fixture rebuilds with its own', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await createTask(t, f.user, f.sub.id, id)
    await createTask(t, f.user, f.sub.id, uuid())
    await purge(t, f, id, 'task')
    expect(await usedBy(t, f.org.id)).toHaveLength(2)
    await t.run((ctx) => deleteOrgDeep(ctx, f.org))
    expect(await usedBy(t, f.org.id)).toEqual([])
    await assertNoDanglingRefs(t, 'after the deep delete')
    await createTask(t, f.otherAdmin, (await otherSub(t, f)).id, id)
    const { org_id } = await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    const first = await usedBy(t, org_id)
    expect(first.length).toBe(7)
    await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    expect((await usedBy(t, org_id)).map((row) => row.row_id).sort()).toEqual(
      first.map((row) => row.row_id).sort(),
    )
    // a rebuild whose task id a pending detach still names refuses, as one
    // transaction, and goes through once the detach ended
    const shared = await t.run(async (ctx) =>
      (await ctx.db.query('issues').collect()).find((task) => task.title === 'ZZ shared task'),
    )
    if (shared === undefined) throw new Error('the fixture has no shared task')
    const detach = await t.run((ctx) =>
      ctx.db.insert('archived_detaches', {
        parent_id: shared.id,
        actor_id: f.user.id,
        deleted_at: NOW,
        progress_at: NOW,
        attempts: 0,
      }),
    )
    await expectRefusal(
      t.mutation(internal.internal.guestOrg.zzGuestOrg, {}),
      'conflict',
      /ZZ fixture task or project id is still taken/,
    )
    expect(await usedBy(t, org_id)).toHaveLength(7)
    await t.run((ctx) => ctx.db.delete(detach))
    await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    expect(await usedBy(t, org_id)).toHaveLength(7)
  })
})

/** Runs the backfill, a dry run with `dry_run`, call after call from where
 * each stopped until one answers done, and adds up the counts every call
 * answered. */
async function backfill(t: T, dry_run: boolean) {
  const totals: Record<string, number> = {}
  let args: FunctionArgs<typeof internal.internal.usedIdsBackfill.run> = { dry_run }
  for (let calls = 0; ; calls++) {
    expect(calls).toBeLessThan(200)
    const result = await t.action(internal.internal.usedIdsBackfill.run, args)
    for (const [key, value] of Object.entries(result))
      if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value
    if (result.done) return totals
    args = { dry_run, source: result.source, cursor: result.cursor }
  }
}

describe('internal/usedIdsBackfill', () => {
  /** Live, stored and half-purged tasks and projects in both
   * organizations, none with a used_ids row, as before the table. Answers
   * the ids each source holds. */
  async function plantWork(t: T, f: OrgFixture) {
    const live = [uuid(), uuid()]
    const stored = uuid()
    const halfPurged = uuid()
    const project = uuid()
    const itemProject = uuid()
    for (const id of [...live, stored, halfPurged]) await createTask(t, f.user, f.sub.id, id)
    await createProject(t, f.admin, project, f.meta.id)
    await createProject(t, f.admin, itemProject, f.meta.id)
    await deleteTask(t, f, stored)
    await deleteTask(t, f, halfPurged)
    await as(t, f.admin).mutation(api.projects.deleteDeep, { org_id: f.org.id, id: itemProject })
    await runSteps(t)
    const other = uuid()
    await createTask(t, f.otherAdmin, (await otherSub(t, f)).id, other)
    await t.run(async (ctx) => {
      // a purge that stopped after the stored copies went: the task's
      // deleted_tasks row and the project item still name them
      for (const [table, id] of [
        ['issues', halfPurged],
        ['projects', itemProject],
      ] as const) {
        const row = await ctx.db
          .query('deleted_rows')
          .withIndex('by_row', (q) => q.eq('table', table).eq('row_id', id))
          .unique()
        if (row !== null) await ctx.db.delete(row._id)
      }
      // and a light row of an organization deleted meanwhile
      await ctx.db.insert('deleted_tasks', {
        org_id: uuid(),
        item_id: uuid(),
        task_id: uuid(),
        num: 1,
        title: 'Gone',
        project_id: uuid(),
        archived: false,
      })
      for (const row of await ctx.db.query('used_ids').collect()) await ctx.db.delete(row._id)
    })
    return { live, stored, halfPurged, project, itemProject, other }
  }

  /** The used_ids rows by `table:id:org`. */
  const recorded = (t: T) =>
    t.run(async (ctx) =>
      (await ctx.db.query('used_ids').collect())
        .map((row) => `${row.table}:${row.row_id}:${row.org_id}`)
        .sort(),
    )

  it('records live and stored tasks and projects, after a dry run that writes nothing, and nothing more the second time', async () => {
    const t = newT()
    const f = await withOrg(t)
    const w = await plantWork(t, f)
    const live = await t.run(async (ctx) => ({
      issues: (await ctx.db.query('issues').collect()).map((r) => `issues:${r.id}:${r.org_id}`),
      projects: (await ctx.db.query('projects').collect()).map(
        (r) => `projects:${r.id}:${r.org_id}`,
      ),
    }))
    const dry = await backfill(t, true)
    expect(await recorded(t)).toEqual([])
    expect(dry).toMatchObject({
      issues: live.issues.length,
      projects: live.projects.length,
      stored_issues: 1,
      stored_projects: 0,
      deleted_tasks: 2,
      project_items: 1,
      orphans: 1,
    })
    const remaining = await t.query(internal.internal.usedIdsBackfill.remaining, {
      source: 'deleted_tasks',
    })
    expect(remaining).toMatchObject({ rows: 2, orphans: 1, done: true })
    const ran = await backfill(t, false)
    expect(ran).toMatchObject({
      issues: live.issues.length,
      projects: live.projects.length,
      // the stored task is in deleted_tasks too, and recorded once
      stored_issues: 1,
      deleted_tasks: 1,
      project_items: 1,
      orphans: 1,
    })
    expect(await recorded(t)).toEqual(
      [
        ...live.issues,
        ...live.projects,
        `issues:${w.stored}:${f.org.id}`,
        `issues:${w.halfPurged}:${f.org.id}`,
        `projects:${w.itemProject}:${f.org.id}`,
      ].sort(),
    )
    const audits = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audits.filter((a) => a.action === 'used_ids_backfill')).toHaveLength(1)
    // nothing is left, and a second run writes nothing
    expect(await backfill(t, true)).toMatchObject({ issues: 0, projects: 0, deleted_tasks: 0 })
    const again = await backfill(t, false)
    for (const source of ['issues', 'projects', 'stored_issues', 'deleted_tasks', 'project_items'])
      expect(again[source]).toBe(0)
    // the recorded ids are refused now
    await expectRefusal(createTask(t, f.user, f.sub.id, w.halfPurged), 'bad_request', ALREADY)
    await expectRefusal(createProject(t, f.otherAdmin, w.itemProject), 'bad_request', ALREADY)
  })

  it('stops between steps once its time is up and goes on where it stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantWork(t, f)
    const whole = await backfill(t, true)
    Object.assign(RUN, { ms: 0 })
    for (const source of Object.keys(BACKFILL_PAGE.rows) as (keyof typeof BACKFILL_PAGE.rows)[])
      BACKFILL_PAGE.rows[source] = 1
    BACKFILL_PAGE.batch = 1
    const first = await t.action(internal.internal.usedIdsBackfill.run, { dry_run: false })
    expect(first).toMatchObject({ done: false, source: 'issues' })
    expect(first.cursor).not.toBeNull()
    const ran = await backfill(t, false)
    // the first call recorded one task; the rest go on from its cursor
    expect(ran.issues + first.issues).toBe(whole.issues)
    expect(await backfill(t, true)).toMatchObject({ issues: 0, projects: 0 })
    await expectRefusal(
      t.action(internal.internal.usedIdsBackfill.run, { dry_run: true, cursor: first.cursor }),
      'bad_request',
      /a cursor goes back with the source/,
    )
  })

  it('records a task an earlier release wrote with an id another organization used, and audits a call that fails', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await createTask(t, f.user, f.sub.id, id)
    await purge(t, f, id, 'task')
    const sub = await otherSub(t, f)
    await t.run((ctx) =>
      ctx.db.insert('issues', {
        id,
        org_id: f.otherOrg.id,
        project_id: sub.id,
        num: 600,
        title: 'Written by an earlier release',
        status: 'todo',
        priority: 'low',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
      }),
    )
    expect(await backfill(t, true)).toMatchObject({ issues: 1 })
    await backfill(t, false)
    expect((await usedOf(t, id)).map((row) => row.org_id).sort()).toEqual(
      [f.org.id, f.otherOrg.id].sort(),
    )
    // a page that fails ends the call with its error, after the audit row
    const failed = await t.action(internal.internal.usedIdsBackfill.run, {
      dry_run: false,
      source: 'projects',
      cursor: 'not a cursor',
    })
    expect(failed).toMatchObject({ done: false, source: 'projects', cursor: 'not a cursor' })
    expect(failed.error).toBeTruthy()
    const audits = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audits.at(-1)).toMatchObject({
      action: 'used_ids_backfill',
      detail: { done: false, source: 'projects', cursor: 'not a cursor' },
    })
  })
})
