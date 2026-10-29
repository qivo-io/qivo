/* The live counts of an organization (schema.ts org_counters active_tasks
 * and live_projects): every write of a task or project keeps them equal to
 * the rows the app's windows read (model/orgs.ts tallyRows), the backfill
 * (internal/liveCountsBackfill.ts) counts an organization exactly while
 * writes go on between its steps, and the root part sends them only once
 * they are counted. */

import { getFunctionName, makeFunctionReference } from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { ActionCtx } from '../_generated/server'
import { COUNT_PAGE, dryCount, RUN } from '../internal/liveCountsBackfill'
import { startWindows, type WindowCounts } from '../lib/idWindows'
import { DEFAULT_ARCHIVE_DAYS } from '../model/orgs'
import {
  as,
  expectLiveCounts,
  NOW,
  newT,
  type OrgFixture,
  plantCopiedIssue,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { deleteProject, deleteTask, installTrashTimers, itemFor, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULT_COUNT_PAGE = { ...COUNT_PAGE }
const DEFAULT_RUN = { ...RUN }
afterEach(() => {
  Object.assign(COUNT_PAGE, DEFAULT_COUNT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
})

/** The organization's org_counters row. */
const countersOf = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('org_counters')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .unique(),
  )

const backfill = (t: T, args: { dry_run: boolean; recount?: boolean; cursor?: string }) =>
  t.action(internal.internal.liveCountsBackfill.run, args)

/** The organization's row in the root part, as `who` (`f.user` unless
 * given) reads it. */
const rootRow = async (t: T, f: OrgFixture, who: OrgFixture['user'] = f.user) => {
  const root = await as(t, who).query(makeFunctionReference<'query'>('workspace:root'), {})
  return (root as { orgs: (WindowCounts & { id: string })[] }).orgs.find((o) => o.id === f.org.id)
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

  it('sends the exact counts only to staff, and guests and Viewers the same windows', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (let i = 0; i < 3; i++) await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await backfill(t, { dry_run: false })
    const exact = await expectLiveCounts(t, f.org.id)
    for (const staff of [f.admin, f.user]) expect(await rootRow(t, f, staff)).toMatchObject(exact)
    for (const reader of [f.guest, f.viewer]) {
      const row = await rootRow(t, f, reader)
      expect(row).toMatchObject({ active_tasks: 200, live_projects: 250 })
      expect(startWindows(row as WindowCounts)).toEqual({ tasks: 1, projects: 1 })
    }
  })

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

  it('a step ends a page early once it has read its bytes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    Object.assign(COUNT_PAGE, { bytes: 100_000 })
    // descriptions over what the app takes now, in the task rows, as
    // earlier releases stored them and every deployment holds them until
    // the description backfill's clear
    const long = []
    for (let i = 0; i < 3; i++)
      long.push(
        await plantCopiedIssue(t, {
          org_id,
          project_id: f.sub.id,
          description: 'x'.repeat(60_000),
        }),
      )
    const step = () =>
      t.mutation(internal.internal.liveCountsBackfill.step, { org_id, recount: false })
    // the first task, read twice to find any that share its number, fills
    // the bytes
    expect(await step()).toBeNull()
    expect((await countersOf(t, org_id))?.counted?.tasks).toBe(long[0].num)
    let done = null
    for (let n = 0; done === null && n < 10; n++) done = await step()
    expect(done).toEqual(await expectLiveCounts(t, org_id))
  })

  it('a dry run compares counts only with a state no write moved while it counted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await backfill(t, { dry_run: false })
    const state = () => t.query(internal.internal.liveCountsBackfill.state, { org_id })
    /** An action context whose queries `t` answers, with a task created
     * before each of its first `writes` reads of the state, so after a
     * count. */
    const racing = (writes: number): Pick<ActionCtx, 'runQuery'> => ({
      runQuery: async (query, ...args) => {
        const name = getFunctionName(query)
        if (name === 'internal/liveCountsBackfill:state' && writes-- > 0) await create(t, f)
        return await t.query(makeFunctionReference<'query'>(name), args[0])
      },
    })

    // a create while it counted counts again, and then matches
    const once = await dryCount(racing(1), await state())
    expect(once.settled).toBe(true)
    expect(once.counts).toEqual(once.state.stored)
    expect(once.counts).toEqual(await expectLiveCounts(t, org_id))

    // creates through every count leave it unsettled, never differing
    const busy = await dryCount(racing(Number.POSITIVE_INFINITY), await state())
    expect(busy.settled).toBe(false)
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
    expect(found).toMatchObject({ counted: 0, differing: 1, unsettled: 0 })
    expect(found.differ).toEqual([
      { org_id, active_tasks: 1, live_projects: 4, stored: { active_tasks: 7, live_projects: 4 } },
    ])
    await backfill(t, { dry_run: false, recount: true })
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 1, live_projects: 4 })
  })

  it('skips an organization without an org_counters row, and counts it once a create makes one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    await plantIssue(t, { org_id, project_id: f.sub.id })
    const row = await countersOf(t, org_id)
    await t.run((ctx) => ctx.db.delete(row?._id ?? ('' as never)))
    const step = () =>
      t.mutation(internal.internal.liveCountsBackfill.step, { org_id, recount: false })
    expect(await step()).toBe('skipped')

    const skipped = { counted: 1, skipped: 1, skipped_orgs: [org_id] }
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject(skipped)
    expect(dry.to_count.map((o) => o.org_id)).not.toContain(org_id)
    expect(await backfill(t, { dry_run: false })).toMatchObject(skipped)
    expect(await countersOf(t, org_id)).toBeNull()

    await create(t, f)
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 1, skipped: 0 })
    expect(await expectLiveCounts(t, org_id)).toEqual({ active_tasks: 2, live_projects: 4 })
  })

  it('a call past its time answers a cursor, and the calls from it go through every organization once', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    Object.assign(RUN, { orgs: 1, ms: 0 })
    /** Every call of a run, each from the cursor the one before answered. */
    const calls = async (dry_run: boolean) => {
      const got = [await backfill(t, { dry_run })]
      for (let last = got[0]; last.cursor !== null && got.length < 5; got.push(last))
        last = await backfill(t, { dry_run, cursor: last.cursor })
      return got
    }
    for (const dry_run of [true, false]) {
      const got = await calls(dry_run)
      expect(got[0]).toMatchObject({ orgs: 1, done: false })
      expect(got.at(-1)).toMatchObject({ done: true, cursor: null })
      expect(got.reduce((n, call) => n + call.counted, 0)).toBe(2)
    }
    expect(await expectLiveCounts(t, f.org.id)).toEqual({ active_tasks: 1, live_projects: 4 })
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
