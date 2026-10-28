/* Label usage counts (schema.ts label_counts): every write keeps each
 * label's count equal to the active tasks that carry it
 * (model/labelCounts.ts), a label's count goes with the label, and the
 * backfill (internal/labelCountsBackfill.ts) counts an organization exactly
 * while writes go on between its steps. */

import {
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
} from 'convex/server'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { ActionCtx } from '../_generated/server'
import { COUNT_PAGE, dryCount, RUN } from '../internal/labelCountsBackfill'
import { byId } from '../lib/db'
import { REMOVAL_BUDGET } from '../model/cascade'
import { activeTaskCount, labelCountRow, labelCountRun } from '../model/labelCounts'
import { LABEL_REMOVAL } from '../model/labels'
import { wipeWorkStep } from '../model/orgDeletion'
import { DEFAULT_ARCHIVE_DAYS } from '../model/orgs'
import {
  as,
  expectListCounts,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'
import { assertNoDanglingRefs } from './refs.setup'
import { deleteProject, deleteTask, installTrashTimers, itemFor, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULT_COUNT_PAGE = { ...COUNT_PAGE }
const DEFAULT_RUN = { ...RUN }
const DEFAULT_REMOVAL = { ...LABEL_REMOVAL }
afterEach(() => {
  Object.assign(COUNT_PAGE, DEFAULT_COUNT_PAGE)
  Object.assign(RUN, DEFAULT_RUN)
  Object.assign(LABEL_REMOVAL, DEFAULT_REMOVAL)
})

/** Each label of the organization with the active tasks that carry it,
 * counted from the rows themselves. */
const truth = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const out: Record<string, number> = {}
    const labels = ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', orgId))
    for await (const label of labels) out[label.id] = 0
    const tasks = ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) => q.eq('org_id', orgId).eq('archived_at', undefined))
    for await (const task of tasks) {
      const rows = ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      for await (const row of rows) if (row.label_id in out) out[row.label_id]++
    }
    return out
  })

/** Each label of the organization with the count a reader may show. */
const shown = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const out: Record<string, number | null> = {}
    const labels = ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', orgId))
    for await (const label of labels) out[label.id] = await activeTaskCount(ctx, label)
    return out
  })

/** Expects every label of the organization counted, as its rows give. */
async function expectCounted(t: T, orgId: string): Promise<Record<string, number>> {
  const counts = await truth(t, orgId)
  expect(await shown(t, orgId)).toEqual(counts)
  return counts
}

const newLabel = async (t: T, f: OrgFixture, name: string): Promise<string> => {
  const id = uuid()
  await as(t, f.admin).mutation(api.labels.create, {
    org_id: f.org.id,
    id,
    name,
    color: '#4C9AFF',
  })
  return id
}

const newTask = (t: T, f: OrgFixture, extra: { parent_id?: string; project_id?: string } = {}) =>
  as(t, f.user).mutation(api.issues.create, {
    org_id: f.org.id,
    id: uuid(),
    project_id: f.sub.id,
    title: 'Labelled task',
    ...extra,
  })

const toggle = (t: T, f: OrgFixture, issue_id: string, label_id: string, on: boolean) =>
  as(t, f.user).mutation(api.labels.toggle, { org_id: f.org.id, issue_id, label_id, on })

/** A label planted raw, as stored before this release: without a row. */
const plantLabel = (t: T, org_id: string, name: string) =>
  t.run(async (ctx) => {
    const _id = await ctx.db.insert('labels', {
      id: uuid(),
      org_id,
      name,
      name_lower: name.toLowerCase(),
      color: '#4C9AFF',
      created_at: NOW,
    })
    return (await ctx.db.get(_id)) as Doc<'labels'>
  })

/** A task planted raw with the assignments of `labels`, without counting. */
const plantLabelled = async (
  t: T,
  f: OrgFixture,
  labels: readonly Doc<'labels'>[],
  extra: Partial<Doc<'issues'>> = {},
) => {
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...extra })
  await t.run(async (ctx) => {
    for (const label of labels)
      await ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: task.id,
        label_id: label.id,
        task_key: task.window_key,
      })
  })
  return task
}

const backfill = (t: T, args: { dry_run: boolean; recount?: boolean }) =>
  t.action(internal.internal.labelCountsBackfill.run, args)

type RunArgs = FunctionArgs<typeof internal.internal.labelCountsBackfill.run>
type RunAnswer = FunctionReturnType<typeof internal.internal.labelCountsBackfill.run>

/** Every call of a run, each from the cursor the one before answered,
 * until one answers done. */
async function calls(t: T, args: Omit<RunArgs, 'cursor'>): Promise<RunAnswer[]> {
  const got: RunAnswer[] = []
  let cursor: RunArgs['cursor']
  for (let n = 0; n < 40; n++) {
    const last = await t.action(internal.internal.labelCountsBackfill.run, { ...args, cursor })
    got.push(last)
    if (last.cursor === null) return got
    cursor = last.cursor
  }
  throw new Error('the run did not end')
}

/** The audit rows of the label backfill, oldest first. */
const audits = (t: T) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'label_counts_backfill'))
        .collect()
    ).map((row) => row.detail),
  )

/** Runs the organization's count steps until it is counted. */
async function countAll(t: T, org_id: string): Promise<void> {
  let cursor: string | null = null
  for (let n = 0; n < 100; n++) {
    const got: { done: boolean; cursor: string | null } = await t.mutation(
      internal.internal.labelCountsBackfill.step,
      { org_id, cursor },
    )
    if (got.done) return
    cursor = got.cursor
  }
  throw new Error('the count did not end')
}

describe('label counts', () => {
  it('every write keeps each count equal to the active tasks carrying the label', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const a = await newLabel(t, f, 'Firmware')
    const b = await newLabel(t, f, 'Power')
    // a new label is counted at once
    expect(await shown(t, org_id)).toEqual({ [a]: 0, [b]: 0 })

    const parent = await newTask(t, f)
    const kid = await newTask(t, f, { parent_id: parent.id })
    const other = await newTask(t, f)
    for (const task of [parent, kid, other]) await toggle(t, f, task.id, a, true)
    await toggle(t, f, parent.id, b, true)
    // asking for the state a task has already moves nothing
    await toggle(t, f, parent.id, b, true)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 3, [b]: 1 })
    await toggle(t, f, other.id, a, false)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 2, [b]: 1 })
    await toggle(t, f, other.id, a, true)

    // the archive takes the subtask with it, and the subtask's restore
    // brings its parent back
    await as(t, f.user).mutation(api.issues.archive, { org_id, id: parent.id, reason: 'Done' })
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 1, [b]: 0 })
    // a label put on or taken off an archived task counts nowhere
    await toggle(t, f, kid.id, b, true)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 1, [b]: 0 })
    await as(t, f.user).mutation(api.issues.unarchive, { org_id, id: kid.id })
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 3, [b]: 2 })

    // a machine update archives before it changes the labels
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.agent.id,
        level: 'user',
      }),
    )
    const machine = (args: {
      archived?: boolean
      add_labels?: string[]
      remove_labels?: string[]
    }) =>
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        ref: `QN-${other.num}`,
        ...args,
      })
    await machine({ archived: true, remove_labels: [a], add_labels: [b] })
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 2, [b]: 2 })
    await machine({ archived: false })
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 2, [b]: 3 })

    // a task in an archived project stays active, and so does its count
    await as(t, f.admin).mutation(api.projects.archive, { org_id, id: f.meta.id })
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 2, [b]: 3 })
    await as(t, f.admin).mutation(api.projects.unarchive, { org_id, id: f.meta.id })

    // a Done task counts until the nightly archive takes it
    const stale = await newTask(t, f)
    await toggle(t, f, stale.id, a, true)
    await t.run(async (ctx) => {
      const row = (await byId(ctx, 'issues', stale.id)) as Doc<'issues'>
      await ctx.db.patch(row._id, {
        status: 'done',
        done_at: new Date(Date.parse(NOW) - (DEFAULT_ARCHIVE_DAYS + 1) * 86_400_000).toISOString(),
      })
    })
    expect((await expectCounted(t, org_id))[a]).toBe(3)
    await t.mutation(internal.jobs.archiveDoneIssues, { now: NOW })
    await runSteps(t)
    expect((await t.run((ctx) => byId(ctx, 'issues', stale.id)))?.archived_at).toBe(NOW)
    expect((await expectCounted(t, org_id))[a]).toBe(2)

    // a task to Deleted items, its subtask left behind, and back
    await deleteTask(t, f, parent.id)
    await runSteps(t)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 1, [b]: 2 })
    const taskItem = await itemFor(t, parent.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [taskItem.id] })
    await runSteps(t)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 2, [b]: 3 })

    // a project with its tasks to Deleted items and back
    await deleteProject(t, f, f.sub.id)
    await runSteps(t)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 0, [b]: 0 })
    const projectItem = await itemFor(t, f.sub.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { org_id, ids: [projectItem.id] })
    await runSteps(t)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 2, [b]: 3 })

    // and out for good
    await deleteProject(t, f, f.sub.id)
    await runSteps(t)
    const gone = await itemFor(t, f.sub.id)
    await as(t, f.admin).mutation(api.deletedItems.purge, { org_id, ids: [gone.id] })
    await runSteps(t)
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 0, [b]: 0 })

    // a label's count goes with it
    await as(t, f.admin).mutation(api.labels.remove, { org_id, id: b })
    expect(await t.run((ctx) => labelCountRow(ctx, b))).toBeNull()
    expect(await expectCounted(t, org_id)).toEqual({ [a]: 0 })
    await assertNoDanglingRefs(t, 'label counts')
  }, 60_000)

  it('a label deleted in steps leaves its assignments counted nowhere, and its id comes back at zero', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    Object.assign(LABEL_REMOVAL, { inline: 1, step: 1 })
    const doomed = await newLabel(t, f, 'Doomed')
    const kept = await newLabel(t, f, 'Kept')
    const tasks = []
    for (let n = 0; n < 4; n++) {
      const task = await newTask(t, f)
      await toggle(t, f, task.id, doomed, true)
      await toggle(t, f, task.id, kept, true)
      tasks.push(task)
    }
    // one archived, so the delete reaches past the active tasks
    await as(t, f.user).mutation(api.issues.archive, { org_id, id: tasks[3].id, reason: 'Done' })
    expect(await expectCounted(t, org_id)).toEqual({ [doomed]: 3, [kept]: 3 })

    await as(t, f.admin).mutation(api.labels.remove, { org_id, id: doomed })
    expect(await t.run((ctx) => labelCountRow(ctx, doomed))).toBeNull()
    // an archive and a restore between the steps move only the kept label
    await as(t, f.user).mutation(api.issues.archive, { org_id, id: tasks[0].id, reason: 'Done' })
    await as(t, f.user).mutation(api.issues.unarchive, { org_id, id: tasks[3].id })
    expect(await expectCounted(t, org_id)).toEqual({ [kept]: 3 })
    await runSteps(t)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('issue_labels')
          .withIndex('by_label', (q) => q.eq('label_id', doomed))
          .collect(),
      ),
    ).toEqual([])
    expect(await expectCounted(t, org_id)).toEqual({ [kept]: 3 })

    // the freed id, taken by a label in another organization, starts at zero
    await as(t, f.otherAdmin).mutation(api.labels.create, {
      org_id: f.otherOrg.id,
      id: doomed,
      name: 'Doomed',
      color: '#4C9AFF',
    })
    expect(await expectCounted(t, f.otherOrg.id)).toEqual({ [doomed]: 0 })

    // a row an earlier release left for a deleted label never passes to a
    // new label with its id
    const reused = uuid()
    await t.run((ctx) =>
      ctx.db.insert('label_counts', { label_id: reused, org_id, active_tasks: 7, revision: 3 }),
    )
    await as(t, f.admin).mutation(api.labels.create, {
      org_id,
      id: reused,
      name: 'Reused',
      color: '#4C9AFF',
    })
    expect(await t.run((ctx) => labelCountRow(ctx, reused))).toMatchObject({
      org_id,
      active_tasks: 0,
      revision: 4,
    })
    await assertNoDanglingRefs(t, 'label removal')
  }, 60_000)

  it('counts an organization exactly while tasks and labels change between its steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    Object.assign(COUNT_PAGE, { tasks: 2, labels: 1 })
    const a = await plantLabel(t, org_id, 'Alpha')
    const b = await plantLabel(t, org_id, 'Beta')
    // planted first, so the count reads them first
    const shelved = await plantLabelled(t, f, [a, b], { archived_at: NOW })
    const planted = []
    for (let n = 0; n < 6; n++) planted.push(await plantLabelled(t, f, n % 2 === 0 ? [a] : [a, b]))
    const step = (cursor: string | null) =>
      t.mutation(internal.internal.labelCountsBackfill.step, { org_id, cursor })

    // the first step starts the run and sets the first label to zero; a
    // write meanwhile moves no count, and no count shows
    const first = await step(null)
    expect(first).toMatchObject({ done: false, labels: 1 })
    expect(await t.run((ctx) => labelCountRun(ctx, org_id))).toMatchObject({ counting: false })
    await toggle(t, f, planted[0].id, b.id, true)
    expect(await t.run((ctx) => labelCountRow(ctx, a.id))).toMatchObject({ active_tasks: 0 })
    expect(await shown(t, org_id)).toEqual({ [a.id]: null, [b.id]: null })
    expect(await step(first.cursor)).toMatchObject({ done: false, cursor: null, labels: 1 })
    expect(await t.run((ctx) => labelCountRun(ctx, org_id))).toMatchObject({ counting: true })

    // the first count step reads the two oldest active tasks
    expect(await step(null)).toMatchObject({ done: false, tasks: 2 })
    expect((await t.run((ctx) => labelCountRun(ctx, org_id)))?.through).toBe(
      planted[1]._creationTime,
    )
    // writes below and past where it counted
    await toggle(t, f, planted[1].id, b.id, false)
    await toggle(t, f, planted[4].id, b.id, true)
    await as(t, f.user).mutation(api.issues.archive, { org_id, id: planted[0].id, reason: 'Done' })
    await as(t, f.user).mutation(api.issues.archive, { org_id, id: planted[3].id, reason: 'Done' })
    await as(t, f.user).mutation(api.issues.unarchive, { org_id, id: shelved.id })
    await deleteTask(t, f, planted[2].id)
    await runSteps(t)
    const made = await newTask(t, f)
    await toggle(t, f, made.id, a.id, true)
    const c = await newLabel(t, f, 'Gamma')
    await toggle(t, f, planted[5].id, c, true)
    await toggle(t, f, planted[1].id, c, true)

    await countAll(t, org_id)
    expect(await t.run((ctx) => labelCountRun(ctx, org_id))).toBeNull()
    await expectCounted(t, org_id)
  }, 60_000)

  it('a count step ends a page early once it has read its bytes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    Object.assign(COUNT_PAGE, { bytes: 100_000 })
    const label = await plantLabel(t, org_id, 'Long')
    // descriptions over what the app takes now, as earlier releases stored
    for (let n = 0; n < 3; n++)
      await plantLabelled(t, f, [label], { description: 'x'.repeat(60_000) })
    const step = (cursor: string | null) =>
      t.mutation(internal.internal.labelCountsBackfill.step, { org_id, cursor })
    expect(await step(null)).toMatchObject({ done: false, labels: 1 })
    // the first task, read twice to find any that share its _creationTime,
    // fills the bytes
    expect(await step(null)).toMatchObject({ done: false, tasks: 1, uses: 1 })
    await countAll(t, org_id)
    expect(await expectCounted(t, org_id)).toEqual({ [label.id]: 3 })
  })

  it('a dry run writes nothing; a run counts what it lists, recount mends a drift and orphans go', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const a = await plantLabel(t, org_id, 'Alpha')
    await plantLabelled(t, f, [a])
    await plantLabelled(t, f, [a], { archived_at: NOW })
    // rows an earlier release left: a count without its label, a run of a
    // deleted organization
    await t.run(async (ctx) => {
      await ctx.db.insert('label_counts', {
        label_id: uuid(),
        org_id,
        active_tasks: 2,
        revision: 0,
      })
      await ctx.db.insert('label_count_runs', { org_id: uuid(), counting: true, through: 0 })
    })
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({ dry_run: true, counted: 1, labels: 1, uses: 1, orphans: 2 })
    expect(dry.to_count).toEqual([{ org_id, labels: 1, missing: 1, tasks: 1, uses: 1 }])
    expect(await shown(t, org_id)).toEqual({ [a.id]: null })
    expect(await t.run((ctx) => ctx.db.query('label_counts').collect())).toHaveLength(1)

    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 1, orphans: 2 })
    expect(await expectCounted(t, org_id)).toEqual({ [a.id]: 1 })
    expect(await t.run((ctx) => ctx.db.query('label_count_runs').collect())).toEqual([])
    // a second run leaves counted organizations alone
    expect(await backfill(t, { dry_run: false })).toMatchObject({ counted: 0, orphans: 0 })
    const written = await t.run((ctx) =>
      ctx.db
        .query('platform_audit_log')
        .filter((q) => q.eq(q.field('action'), 'label_counts_backfill'))
        .collect(),
    )
    expect(written.map((row) => row.detail)).toEqual([
      { counted: 1, labels: 1, tasks: 1, uses: 1, orphans: 2, cursor: null },
      { counted: 0, labels: 0, tasks: 0, uses: 0, orphans: 0, cursor: null },
    ])

    // a count an earlier release left wrong
    const row = await t.run((ctx) => labelCountRow(ctx, a.id))
    await t.run((ctx) => ctx.db.patch(row?._id ?? ('' as never), { active_tasks: 5 }))
    const found = await backfill(t, { dry_run: true })
    expect(found).toMatchObject({ counted: 0, differing: 1, unsettled: 0 })
    expect(found.differ).toEqual([{ org_id, label_id: a.id, active_tasks: 1, stored: 5 }])
    await backfill(t, { dry_run: false, recount: true })
    expect(await expectCounted(t, org_id)).toEqual({ [a.id]: 1 })
    expect((await backfill(t, { dry_run: true })).differing).toBe(0)
  })

  it('a dry run compares counts only with stored counts no write moved while it counted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const a = await newLabel(t, f, 'Alpha')
    const task = await newTask(t, f)
    let on = false
    // label pages a dry count has read, its stored counts read twice a try
    let pages = 0
    /** An action context whose queries `t` answers, with the label toggled
     * on the task, or on and off again with `undone`, before each of its
     * first `writes` reads of a label page after the first. */
    const racing = (writes: number, undone = false): Pick<ActionCtx, 'runQuery'> => {
      pages = 0
      return {
        runQuery: async (query, ...args) => {
          const name = getFunctionName(query)
          if (name === 'internal/labelCountsBackfill:labelPage' && pages++ > 0 && writes-- > 0) {
            on = !on
            await toggle(t, f, task.id, a, on)
            if (undone) {
              on = !on
              await toggle(t, f, task.id, a, on)
            }
          }
          return await t.query(makeFunctionReference<'query'>(name), args[0])
        },
      }
    }
    // a toggle while it counted counts again, and then matches
    const once = await dryCount(racing(1), org_id)
    expect(once.settled).toBe(true)
    expect(pages).toBe(3)
    expect(once.counts.get(a) ?? 0).toBe(once.stored.labels.get(a)?.stored)
    // a toggle undone before the next read leaves the count where it was,
    // and the row's revision still makes it count again
    const undone = await dryCount(racing(1, true), org_id)
    expect(undone.settled).toBe(true)
    expect(pages).toBe(3)
    // toggles through every count leave it unsettled, never differing
    expect((await dryCount(racing(Number.POSITIVE_INFINITY), org_id)).settled).toBe(false)
    expect((await dryCount(racing(Number.POSITIVE_INFINITY, true), org_id)).settled).toBe(false)
    // a call out of time does not count again
    const late = await dryCount(racing(Number.POSITIVE_INFINITY), org_id, () => true)
    expect(late.settled).toBe(false)
    expect(pages).toBe(2)
  })

  it('a call past its time answers a cursor, inside an organization too, and the calls from it go through every organization once', async () => {
    const t = newT()
    const f = await withOrg(t)
    // counted already, then one without a row: the check of whether the
    // organization is due reads two pages
    await newLabel(t, f, 'Counted')
    await plantLabelled(t, f, [await plantLabel(t, f.org.id, 'Alpha')])
    await plantLabel(t, f.otherOrg.id, 'Elsewhere')
    Object.assign(RUN, { rows: 1, ms: 0 })
    Object.assign(COUNT_PAGE, { labels: 1 })
    for (const dry_run of [true, false]) {
      const got = await calls(t, { dry_run })
      expect(got.length).toBeGreaterThan(2)
      expect(got.reduce((n, call) => n + call.counted, 0)).toBe(2)
      expect(got.reduce((n, call) => n + call.orgs, 0)).toBe(2)
      const insides = got.flatMap((call) =>
        call.cursor?.table === 'organizations' && call.cursor.org !== undefined
          ? [call.cursor.org]
          : [],
      )
      // a dry run stops between organizations, a run inside them, in its
      // check whether one is due and in its reset
      if (dry_run) expect(insides).toEqual([{ id: f.otherOrg.id }])
      else {
        expect(insides.some((org) => org.id === f.org.id && typeof org.due === 'string')).toBe(true)
        expect(insides.some((org) => typeof org.reset === 'string')).toBe(true)
      }
    }
    await expectCounted(t, f.org.id)
    await expectCounted(t, f.otherOrg.id)
  })

  it('a recount after a rollback starts an unfinished count again and ends exact', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    Object.assign(COUNT_PAGE, { tasks: 1 })
    const a = await plantLabel(t, org_id, 'Alpha')
    const b = await plantLabel(t, org_id, 'Beta')
    const tasks: Doc<'issues'>[] = []
    for (let n = 0; n < 4; n++) tasks.push(await plantLabelled(t, f, [a]))
    const step = (cursor: string | null) =>
      t.mutation(internal.internal.labelCountsBackfill.step, { org_id, cursor })
    // the reset and two tasks counted
    expect(await step(null)).toMatchObject({ done: false, cursor: null })
    await step(null)
    await step(null)
    expect((await t.run((ctx) => labelCountRun(ctx, org_id)))?.through).toBe(tasks[1]._creationTime)
    // an earlier release runs: it changes the labels of counted tasks and
    // moves no count
    await t.run(async (ctx) => {
      const held = await ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', tasks[1].id))
        .unique()
      if (held) await ctx.db.delete(held._id)
      await ctx.db.insert('issue_labels', { org_id, issue_id: tasks[0].id, label_id: b.id })
    })
    // the dry run cannot check the unfinished count and lists it
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({ running: 1, running_orgs: [org_id], differing: 0 })
    // the documented procedure: a recount until done
    await calls(t, { dry_run: false, recount: true })
    expect(await expectCounted(t, org_id)).toEqual({ [a.id]: 3, [b.id]: 1 })
    expect((await backfill(t, { dry_run: true })).differing).toBe(0)
  })

  it('a call a step ends with an error leaves its audit row, with where it stopped', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabelled(t, f, [await plantLabel(t, f.org.id, 'Alpha')])
    await plantLabel(t, f.otherOrg.id, 'Elsewhere')
    // two run rows of one organization, which no write makes: its first
    // read refuses
    await t.run(async (ctx) => {
      for (let n = 0; n < 2; n++)
        await ctx.db.insert('label_count_runs', {
          org_id: f.otherOrg.id,
          counting: false,
          through: 0,
        })
    })
    await expect(backfill(t, { dry_run: false })).rejects.toThrow()
    const [row] = await audits(t)
    expect(row).toMatchObject({
      counted: 1,
      labels: 1,
      tasks: 1,
      uses: 1,
      orphans: 0,
      cursor: { table: 'organizations', cursor: null, org: { id: f.otherOrg.id } },
    })
    expect(row?.error).toEqual(expect.any(String))
    await expectCounted(t, f.org.id)
  })

  it('the Northstar seed counts its labels, and its wipe takes the counts with the labels', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    const counts = await expectCounted(t, org.id)
    expect(Object.values(counts).some((n) => n > 0)).toBe(true)
    // small steps, with a label count step between two, as a backfill run
    // meanwhile would take
    let done = false
    let cursor: string | null = null
    for (let n = 0; n < 200 && !done; n++) {
      done = await t.run((ctx) =>
        wipeWorkStep(
          ctx,
          org.id,
          profiles.map((p) => p.id),
          { rows: 16, bytes: 4 * 1024 * 1024 },
        ),
      )
      await expectListCounts(t, org.id)
      const got: { done: boolean; cursor: string | null } = await t.mutation(
        internal.internal.labelCountsBackfill.step,
        { org_id: org.id, cursor },
      )
      cursor = got.done ? null : got.cursor
      await expectListCounts(t, org.id)
    }
    expect(done).toBe(true)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('label_counts')
          .withIndex('by_org', (q) => q.eq('org_id', org.id))
          .collect(),
      ),
    ).toEqual([])
  }, 60_000)

  it('the guest fixture and a new organization start their labels at zero', async () => {
    const t = newT()
    const { org_id } = await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})
    expect(Object.values(await expectCounted(t, org_id))).toEqual([0])
    expect((await t.mutation(internal.internal.guestOrg.zzGuestOrg, {})).torn_down).toBe(true)
    expect(Object.values(await expectCounted(t, org_id))).toEqual([0])
    const made = await t.mutation(internal.adminOrgs.insertOrganization, {
      name: 'Starter Labs',
      people: [{ name: 'Ada', email: 'ada@starter.test', role: 'admin' }],
      actor: { auth_user_id: 'operator', email: 'operator@qivo.test' },
    })
    expect(Object.values(await expectCounted(t, made.org_id))).toEqual([0, 0])
  })

  it("an organization's deletion in steps takes every count with it", async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
    const a = await newLabel(t, f, 'Alpha')
    for (let n = 0; n < 3; n++) await toggle(t, f, (await newTask(t, f)).id, a, true)
    const team = uuid()
    await as(t, f.admin).mutation(api.teams.create, { org_id, id: team, name: 'Counted' })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id,
      team_id: team,
      profile_id: f.user.id,
    })
    await t.run(async (ctx) => {
      // a backfill run that has just started
      await ctx.db.insert('label_count_runs', {
        org_id,
        counting: false,
        through: Number.MIN_SAFE_INTEGER,
      })
      await ctx.db.insert('org_removals', {
        org_id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      })
    })
    // small steps, so each phase stops between its rows
    REMOVAL_BUDGET.rows = 4
    // the organization goes before the removal row, which goes last
    const gone = () =>
      t.run(
        async (ctx) =>
          (await ctx.db
            .query('org_removals')
            .withIndex('by_org', (q) => q.eq('org_id', org_id))
            .first()) === null,
      )
    // a label and team count step between two deletion steps, as a
    // backfill run meanwhile would take, and every count right or gone
    let cursor: string | null = null
    let shown = 0
    for (let n = 0; n < 300 && !(await gone()); n++) {
      await t.mutation(internal.orgRemovals.step, { org_id })
      await expectListCounts(t, org_id)
      const got: { done: boolean; cursor: string | null } = await t.mutation(
        internal.internal.labelCountsBackfill.step,
        { org_id, cursor },
      )
      cursor = got.done ? null : got.cursor
      const teams = await t.run((ctx) =>
        ctx.db
          .query('teams')
          .withIndex('by_org', (q) => q.eq('org_id', org_id))
          .collect(),
      )
      for (const { id } of teams)
        await t.mutation(internal.internal.teamCountsBackfill.step, { team_id: id })
      shown += await expectListCounts(t, org_id)
    }
    expect(await gone()).toBe(true)
    // the backfill made counts the deletion then took
    expect(shown).toBeGreaterThan(0)
    expect(await t.run((ctx) => byId(ctx, 'organizations', org_id))).toBeNull()
    for (const table of ['label_counts', 'team_counts', 'label_count_runs'] as const)
      expect(
        (await t.run((ctx) => ctx.db.query(table).collect())).filter((r) => r.org_id === org_id),
        table,
      ).toEqual([])
    await assertNoDanglingRefs(t, 'organization deletion')
  }, 60_000)

  it('an organization deletion past its labels and teams deletes the counts an earlier release left', async () => {
    const t = newT()
    const f = await withOrg(t)
    const org_id = f.org.id
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
    REMOVAL_BUDGET.rows = 2
    const phase = async () =>
      (
        await t.run((ctx) =>
          ctx.db
            .query('org_removals')
            .withIndex('by_org', (q) => q.eq('org_id', org_id))
            .first(),
        )
      )?.phase
    for (
      let n = 0;
      n < 300 && !['activity', 'webhooks', 'billing', 'finish'].includes((await phase()) ?? '');
      n++
    )
      await t.mutation(internal.orgRemovals.step, { org_id })
    // an earlier release ran the labels and teams phases, deleting labels
    // and teams without their counts
    await t.run(async (ctx) => {
      for (let n = 0; n < 3; n++) {
        await ctx.db.insert('label_counts', {
          label_id: uuid(),
          org_id,
          active_tasks: n,
          revision: 0,
        })
        await ctx.db.insert('team_counts', { team_id: uuid(), org_id, members: n, revision: 0 })
      }
    })
    for (let n = 0; n < 300 && (await phase()) !== undefined; n++)
      await t.mutation(internal.orgRemovals.step, { org_id })
    expect(await phase()).toBeUndefined()
    expect(await t.run((ctx) => byId(ctx, 'organizations', org_id))).toBeNull()
    for (const table of ['label_counts', 'team_counts'] as const)
      expect(
        (await t.run((ctx) => ctx.db.query(table).collect())).filter((r) => r.org_id === org_id),
        table,
      ).toEqual([])
  }, 60_000)
})
