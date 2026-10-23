/* Label delete in bounded steps (model/labels.ts deleteLabelCore and the
 * background steps in labelRemovals.ts).
 *
 * The admin's delete must fit Convex's limits for a label on any number of
 * tasks. The label leaves every reader at once, the assignments left go in
 * background steps, and the label_removals row keeps the id from a new
 * label until they are gone. Fake timers keep every scheduled step from
 * running until a test releases it. catalog.test.ts pins the small delete
 * that needs no step. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { STALLED_MS } from '../labelRemovals'
import type { Refusal, RefusalCode } from '../lib/functions'
import { LABEL_REMOVAL } from '../model/labels'
import {
  activityFor,
  as,
  drainActivity,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  type T,
  TODAY,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'

const START = Date.parse('2026-05-04T10:00:00.000Z')
const DEFAULTS = { ...LABEL_REMOVAL }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  Object.assign(LABEL_REMOVAL, DEFAULTS)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

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

let nextNum = 10_000

/* `count` tasks in the fixture's sub-project, every third one archived,
 * each carrying every label in `labels`. */
const plantLabelledTasks = (
  t: T,
  f: OrgFixture,
  count: number,
  labels: readonly Doc<'labels'>[],
): Promise<string[]> =>
  t.run(async (ctx) => {
    const ids: string[] = []
    for (let n = 0; n < count; n++) {
      const id = uuid()
      const archived = n % 3 === 2
      await ctx.db.insert('issues', {
        id,
        org_id: f.org.id,
        project_id: f.sub.id,
        num: nextNum++,
        title: `Labelled ${n}`,
        description: '',
        status: archived ? 'done' : 'todo',
        priority: 'medium',
        paused: false,
        ...(archived ? { done_at: NOW, archived_at: NOW } : {}),
        created_at: NOW,
        updated_at: NOW,
      })
      for (const label of labels) {
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: id,
          label_id: label.id,
          ...(archived ? { task_archived: true } : {}),
        })
      }
      ids.push(id)
    }
    return ids
  })

const assignments = (t: T, labelId: string) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('issue_labels')
          .withIndex('by_label', (q) => q.eq('label_id', labelId))
          .collect()
      ).length,
  )

const jobOf = (t: T, labelId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('label_removals')
      .withIndex('by_label', (q) => q.eq('label_id', labelId))
      .unique(),
  )

const stepsRun = (t: T) =>
  t.run(
    async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name.startsWith('labelRemovals') && job.state.kind === 'success',
      ).length,
  )

const remove = (t: T, f: OrgFixture, label: Doc<'labels'>) =>
  as(t, f.admin).mutation(api.labels.remove, { org_id: f.org.id, id: label.id })

const create = (t: T, f: OrgFixture, id: string, name: string) =>
  as(t, f.admin).mutation(api.labels.create, { org_id: f.org.id, id, name, color: '#4C9AFF' })

describe('a label on more tasks than one delete removes', () => {
  it('leaves every reader at once, keeps its id reserved and goes in steps', async () => {
    LABEL_REMOVAL.inline = 2
    LABEL_REMOVAL.step = 3
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const bug = await plantLabel(t, f.org.id, 'Bug')
    const keep = await plantLabel(t, f.org.id, 'Keep')
    const tasks = await plantLabelledTasks(t, f, 10, [bug, keep])
    await drainActivity(t)

    await remove(t, f, bug)

    expect(await t.run((ctx) => ctx.db.get(bug._id))).toBeNull()
    expect(await assignments(t, bug.id)).toBe(8)
    const job = await jobOf(t, bug.id)
    expect(job).toMatchObject({ removed_at: new Date(START).toISOString() })
    expect(job?.scheduled_id).toBeDefined()
    const events = await activityFor(t, f.org.id)
    expect(events.map((e) => [e.verb, e.label])).toEqual([['deleted label', 'Bug']])

    // The app joins the snapshot's labels as below. planner.ts drops an
    // assignment whose label is not in the list.
    const snap = (await workspaceOf(as(t, f.admin)))!
    const shown = new Set(snap.labels.map((l) => l.id))
    expect(shown.has(bug.id)).toBe(false)
    const joined = snap.issueLabels.filter((row) => shown.has(row.label_id))
    expect(new Set(joined.map((row) => row.label_id))).toEqual(new Set([keep.id]))
    // The machine task read and label search, on an archived task too.
    for (const ref of [tasks[0], tasks[2]]) {
      const detail = await t.query(internal.machine.rest.getIssue, {
        today: TODAY,
        callerId: f.admin.id,
        access: 'read',
        ref,
      })
      expect(detail.labels.map((l) => l.name)).toEqual(['Keep'])
    }
    const search = (term: string) =>
      t.query(internal.machine.rest.listIssues, {
        today: TODAY,
        callerId: f.admin.id,
        access: 'read',
        search: term,
      })
    expect(await search('Bug')).toEqual([])
    expect(await search('Keep')).toHaveLength(7)

    // The reserved id refuses a new label and every write that names it.
    await refused(
      create(t, f, bug.id, 'Bug again'),
      'bad_request',
      'a label with this id already exists',
    )
    await refused(
      as(t, f.admin).mutation(api.labels.toggle, {
        org_id: f.org.id,
        issue_id: tasks[0],
        label_id: bug.id,
        on: true,
      }),
      'rule',
      'label and task must belong to the same organization',
    )
    await refused(
      as(t, f.admin).mutation(api.labels.remove, { org_id: f.org.id, id: bug.id }),
      'not_found',
      'label not found',
    )
    await refused(
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.admin.id,
        access: 'write',
        keyName: 'drive',
        ref: tasks[0],
        body: JSON.stringify({ add_labels: [bug.id] }),
      }),
      'bad_request',
      `label "${bug.id}" not found`,
    )
    await refused(
      t.mutation(internal.machine.mcp.setLabel, {
        callerId: f.admin.id,
        access: 'write',
        label: bug.id,
        name: 'Renamed',
      }),
      'not_found',
      `label "${bug.id}" not found`,
    )

    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(await assignments(t, bug.id)).toBe(0)
    expect(await assignments(t, keep.id)).toBe(10)
    expect(await jobOf(t, bug.id)).toBeNull()
    expect(await stepsRun(t)).toBe(3) // 3 + 3 + 2
    expect(info).toHaveBeenCalledWith(
      'Label removal completed',
      expect.objectContaining({ label_id: bug.id }),
    )
    await assertNoDanglingRefs(t, 'after the label removal')
    // The id is free again, and the new label is on no task.
    await create(t, f, bug.id, 'Bug again')
    expect(await assignments(t, bug.id)).toBe(0)
  })

  it('starts a removal only for more assignments than the inline bound', async () => {
    LABEL_REMOVAL.inline = 3
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const exact = await plantLabel(t, f.org.id, 'Exact')
    const over = await plantLabel(t, f.org.id, 'Over')
    await plantLabelledTasks(t, f, 3, [exact])
    await plantLabelledTasks(t, f, 4, [over])

    await remove(t, f, exact)
    expect(await assignments(t, exact.id)).toBe(0)
    expect(await jobOf(t, exact.id)).toBeNull()

    await remove(t, f, over)
    expect(await assignments(t, over.id)).toBe(1)
    expect(await jobOf(t, over.id)).not.toBeNull()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await assignments(t, over.id)).toBe(0)
    expect(await jobOf(t, over.id)).toBeNull()
    expect(await stepsRun(t)).toBe(1)
  })

  it('fits a transaction that may write 50 documents with 200 assignments', async () => {
    LABEL_REMOVAL.inline = 20
    LABEL_REMOVAL.step = 40
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const t = newT({ transactionLimits: { documentsWritten: 50 } })
    const f = await withOrg(t)
    const bug = await plantLabel(t, f.org.id, 'Bug')
    // planted in batches the limit allows
    for (let n = 0; n < 10; n++) await plantLabelledTasks(t, f, 20, [bug])
    expect(await assignments(t, bug.id)).toBe(200)

    await remove(t, f, bug)
    expect(await assignments(t, bug.id)).toBe(180)
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(await assignments(t, bug.id)).toBe(0)
    expect(await jobOf(t, bug.id)).toBeNull()
  })
})

describe('recovery', () => {
  it('resumes a dropped step once it stalls and leaves a waiting step alone', async () => {
    LABEL_REMOVAL.inline = 2
    LABEL_REMOVAL.step = 3
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const bug = await plantLabel(t, f.org.id, 'Bug')
    await plantLabelledTasks(t, f, 10, [bug])
    await remove(t, f, bug)
    const dropped = (await jobOf(t, bug.id))!
    await t.run((ctx) => ctx.scheduler.cancel(dropped.scheduled_id!))
    // a fresh row is not stalled yet
    await t.mutation(internal.labelRemovals.recover, {})
    expect(await jobOf(t, bug.id)).toEqual(dropped)

    vi.setSystemTime(START + STALLED_MS + 1)
    await t.mutation(internal.labelRemovals.recover, {})
    const resumed = (await jobOf(t, bug.id))!
    expect(resumed.scheduled_id).not.toBe(dropped.scheduled_id)
    expect(resumed.progress_at).toBe(new Date(START + STALLED_MS + 1).toISOString())
    expect(warn).toHaveBeenCalledWith(
      'Label removal resumed',
      expect.objectContaining({ label_id: bug.id }),
    )
    // its step waits in the queue, so a later sweep must not start a second chain
    vi.setSystemTime(START + 3 * STALLED_MS)
    await t.mutation(internal.labelRemovals.recover, {})
    expect(await jobOf(t, bug.id)).toEqual(resumed)

    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await assignments(t, bug.id)).toBe(0)
    expect(await jobOf(t, bug.id)).toBeNull()
  })

  it('stops without deleting the rows of a live label that a fixture gave the id', async () => {
    LABEL_REMOVAL.inline = 2
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const bug = await plantLabel(t, f.org.id, 'Bug')
    await plantLabelledTasks(t, f, 5, [bug])
    await remove(t, f, bug)
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = bug
      await ctx.db.insert('labels', row)
    })

    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(await jobOf(t, bug.id)).toBeNull()
    expect(await assignments(t, bug.id)).toBe(3)
    expect(error).toHaveBeenCalledWith('Label removal stopped because a live label has its id', {
      label_id: bug.id,
    })
  })
})
