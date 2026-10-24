/* The live counts of an organization (schema.ts org_counters active_tasks
 * and live_projects): every write of a task or project keeps them equal to
 * the rows the app's windows read (model/orgs.ts tallyRows), the backfill
 * (internal/liveCountsBackfill.ts) counts an organization exactly while
 * writes go on between its steps, and the root part sends them only once
 * they are counted. */

import { makeFunctionReference } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import { COUNT_PAGE } from '../internal/liveCountsBackfill'
import { DEFAULT_ARCHIVE_DAYS } from '../model/orgs'
import {
  as,
  expectLiveCounts,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { deleteProject, deleteTask, installTrashTimers, itemFor, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULT_COUNT_PAGE = { ...COUNT_PAGE }
afterEach(() => {
  Object.assign(COUNT_PAGE, DEFAULT_COUNT_PAGE)
})

/** The organization's org_counters row. */
const countersOf = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_counters')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique(),
  )

const backfill = (t: T, args: { dry_run: boolean; recount?: boolean }) =>
  t.action(internal.internal.liveCountsBackfill.run, args)

/** The organization's row in the root part, as `f.user` reads it. */
const rootRow = async (t: T, f: OrgFixture) => {
  const root = await as(t, f.user).query(makeFunctionReference<'query'>('workspace:root'), {})
  return (root as { orgs: { id: string }[] }).orgs.find((o) => o.id === f.org.id)
}

const create = (t: T, f: OrgFixture, extra: { parent_id?: string } = {}) =>
  as(t, f.user).mutation(api.issues.create, {
    org_id: f.org.id,
    id: uuid(),
    project_id: f.sub.id,
    title: 'Counted task',
    ...extra,
  })

describe('live counts', () => {
  it('every write of a task or project keeps the counts equal to the rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    // done long enough ago for the nightly archive, planted before counting
    const stale = await plantIssue(t, {
      org_id,
      project_id: f.sub.id,
      status: 'done',
      done_at: new Date(Date.parse(NOW) - DEFAULT_ARCHIVE_DAYS * 86_400_000).toISOString(),
    })
    await plantIssue(t, { org_id, project_id: f.sub.id, archived_at: NOW })
    expect(await countersOf(t, org_id)).not.toHaveProperty('active_tasks')
    await backfill(t, { dry_run: false })
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 1, live_projects: 4 })

    // creates: a task, its subtask and a project
    const parent = await create(t, f)
    const kid = await create(t, f, { parent_id: parent.id })
    await as(t, f.user).mutation(api.projects.create, {
      org_id,
      id: uuid(),
      type: 'meta',
      key: 'CNT',
      name: 'Counted project',
      sort_order: 9,
    })
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 3, live_projects: 5 })

    // the archive takes the subtask with it, and the subtask's restore
    // brings its parent back
    await as(t, f.user).mutation(api.issues.archive, { org_id, id: parent.id, reason: 'Moved on' })
    expect((await expectLiveCounts(t, org_id)).active_tasks).toBe(1)
    await as(t, f.user).mutation(api.issues.unarchive, { org_id, id: kid.id })
    expect((await expectLiveCounts(t, org_id)).active_tasks).toBe(3)

    // a machine archive and restore
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'user',
      }),
    )
    const machine = (archived: boolean) =>
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        ref: `QN-${kid.num}`,
        archived,
      })
    await machine(true)
    expect((await expectLiveCounts(t, org_id)).active_tasks).toBe(2)
    await machine(false)
    expect((await expectLiveCounts(t, org_id)).active_tasks).toBe(3)

    // the nightly archive
    await t.mutation(internal.jobs.archiveDoneIssues, { now: NOW })
    await runSteps(t)
    expect((await t.run((ctx) => ctx.db.get(stale._id)))?.archived_at).toBe(NOW)
    expect((await expectLiveCounts(t, org_id)).active_tasks).toBe(2)

    // a task to Deleted items, its subtask left behind, and back
    await deleteTask(t, f, parent.id)
    await runSteps(t)
    expect((await expectLiveCounts(t, org_id)).active_tasks).toBe(1)
    const taskItem = await itemFor(t, parent.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [taskItem.id] })
    await runSteps(t)
    expect((await expectLiveCounts(t, org_id)).active_tasks).toBe(2)

    // a project with its tasks to Deleted items and back
    await deleteProject(t, f, f.sub.id)
    await runSteps(t)
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 0, live_projects: 4 })
    const projectItem = await itemFor(t, f.sub.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [projectItem.id] })
    await runSteps(t)
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 2, live_projects: 5 })

    // and out for good
    await deleteProject(t, f, f.sub.id)
    await runSteps(t)
    const gone = await itemFor(t, f.sub.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id, ids: [gone.id] })
    await runSteps(t)
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 0, live_projects: 4 })
  }, 60_000)

  it('counts an organization exactly while its rows change between the steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    Object.assign(COUNT_PAGE, { issues: 2, projects: 2 })
    // numbered 100 and up by the fixture, two of them archived
    const planted = []
    for (let i = 0; i < 8; i++)
      planted.push(
        await plantIssue(t, {
          org_id,
          project_id: f.sub.id,
          ...(i % 4 === 3 ? { archived_at: NOW } : {}),
        }),
      )
    const step = () =>
      t.mutation(internal.internal.liveCountsBackfill.step, { org_id, recount: false })
    // the first step counts the first two tasks and two projects
    expect(await step()).toBeNull()
    expect((await countersOf(t, org_id))?.counted?.tasks).toBe(planted[1].num)
    // the app does not see counts while they are counted
    expect(await rootRow(t, f)).not.toHaveProperty('active_tasks')

    // archives below and past where it counted, a delete below, a create
    // past every number, and a new project
    const archive = (id: string) =>
      as(t, f.user).mutation(api.issues.archive, { org_id, id, reason: 'Moved on' })
    await archive(planted[0].id)
    await archive(planted[5].id)
    await deleteTask(t, f, planted[1].id)
    await runSteps(t)
    await create(t, f)
    await as(t, f.user).mutation(api.projects.create, {
      org_id,
      id: uuid(),
      type: 'meta',
      key: 'MID',
      name: 'Made meanwhile',
      sort_order: 9,
    })

    let done = null
    for (let n = 0; done === null && n < 20; n++) done = await step()
    expect(done).toEqual(await expectLiveCounts(t, org_id))
    expect(await rootRow(t, f)).toMatchObject(done ?? {})
  })

  it('a dry run writes nothing and finds counts their rows do not give, which a recount mends', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await plantIssue(t, { org_id, project_id: f.sub.id })
    const before = await countersOf(t, org_id)
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({ dry_run: true, counted: 2, differing: 0, differ: [] })
    expect(dry.to_count).toContainEqual({ org_id, active_tasks: 1, live_projects: 4 })
    expect(await countersOf(t, org_id)).toEqual(before)

    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 2 })
    await expectLiveCounts(t, org_id)
    // a second run leaves counted organizations alone
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 0 })

    const row = await countersOf(t, org_id)
    await t.run((ctx) => ctx.db.patch(row?._id ?? ('' as never), { active_tasks: 7 }))
    const found = await backfill(t, { dry_run: true })
    expect(found).toMatchObject({ counted: 0, differing: 1 })
    expect(found.differ).toEqual([
      { org_id, active_tasks: 1, live_projects: 4, stored: { active_tasks: 7, live_projects: 4 } },
    ])
    await backfill(t, { dry_run: false, recount: true })
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 1, live_projects: 4 })
  })

  it('the guest fixture counts the rows it plants, also when it plants them again', async () => {
    const t = newT()
    const zz = () => t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    const { org_id } = await zz()
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 3, live_projects: 4 })
    expect((await zz()).torn_down).toBe(true)
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 3, live_projects: 4 })
  })
})
