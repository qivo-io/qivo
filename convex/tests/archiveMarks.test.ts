/* Archiving a task marks its relation rows (labels, attachments, follows and
 * links) in background steps, so the app snapshot skips them by index, and
 * flags the task relations_marked (model/archiveMarks.ts). The steps check
 * the task when they run, and a project archive marks nothing. A restore
 * writes no relation row: it schedules steps that clear the marks, and until
 * they finish the snapshot reads the flagged task through its own indexes.
 * The steps run when the test fires the fake timers, so each case can look
 * before and after them. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { RELATION_READ } from '../lib/snapshotRelations'
import { ARCHIVE_MARKS, clearMarkedTasks, markArchivedTasks } from '../model/archiveMarks'
import { scheduleArchivedReads } from '../model/messages'
import {
  as,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const DEFAULT_MARKS = { ...ARCHIVE_MARKS }
const DEFAULT_READ = { ...RELATION_READ }

/* Every case drives the scheduler itself, so none may await real time. */
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  Object.assign(ARCHIVE_MARKS, DEFAULT_MARKS)
  Object.assign(RELATION_READ, DEFAULT_READ)
})

/* Runs every scheduled function, and anything they schedule, to completion. */
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

/* Runs the functions scheduled so far once, not the ones they schedule. */
async function runPending(t: T): Promise<void> {
  vi.runOnlyPendingTimers()
  await t.finishInProgressScheduledFunctions()
}

/* A label, an attachment and the admin's follow on `task`, and a link from
 * it to each task in `to`. */
async function plantRelations(
  t: T,
  f: OrgFixture,
  task: Doc<'issues'>,
  to: Doc<'issues'>[] = [],
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert('issue_labels', {
      org_id: f.org.id,
      issue_id: task.id,
      label_id: 'label',
    })
    await ctx.db.insert('issue_attachments', {
      id: uuid(),
      org_id: f.org.id,
      issue_id: task.id,
      name: 'notes.txt',
      size_bytes: 1,
      storage_id: await ctx.storage.store(new Blob() as never),
      inline: false,
      created_at: NOW,
    })
    await ctx.db.insert('issue_subscriptions', {
      issue_id: task.id,
      profile_id: f.admin.id,
      created_at: NOW,
    })
    for (const other of to)
      await ctx.db.insert('issue_links', {
        id: uuid(),
        org_id: f.org.id,
        source_id: task.id,
        target_id: other.id,
        type: 'blocks',
        pair_key: [task.id, other.id].sort().join(':'),
        created_at: NOW,
      })
  })
}

/* Whether each relation row of the task carries the mark, by table, its
 * links at either end, and whether the task carries relations_marked. */
const marks = (t: T, task: Doc<'issues'>) =>
  t.run(async (ctx) => {
    const of = (rows: { task_archived?: true }[]) => rows.map((row) => row.task_archived === true)
    return {
      labels: of(
        await ctx.db
          .query('issue_labels')
          .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
          .collect(),
      ),
      attachments: of(
        await ctx.db
          .query('issue_attachments')
          .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
          .collect(),
      ),
      follows: of(
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', task.id))
          .collect(),
      ),
      links: of([
        ...(await ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) => q.eq('source_id', task.id))
          .collect()),
        ...(await ctx.db
          .query('issue_links')
          .withIndex('by_target', (q) => q.eq('target_id', task.id))
          .collect()),
      ]),
      flagged: (await ctx.db.get(task._id))?.relations_marked === true,
    }
  })

/* The marks of a task with one row in each table and `links` links, all
 * marked (and the task flagged) or none. */
const each = (mark: boolean, links = 1) => ({
  labels: [mark],
  attachments: [mark],
  follows: [mark],
  links: Array.from({ length: links }, () => mark),
  flagged: mark,
})

/* How many of the task's relation rows the admin's snapshot sends, by table. */
async function shown(t: T, f: OrgFixture, issueId: string) {
  const snap = (await as(t, f.admin).query(api.snapshot.forMe, {}))!
  return {
    labels: snap.issueLabels.filter((row) => row.issue_id === issueId).length,
    attachments: snap.attachments.filter((row) => row.issue_id === issueId).length,
    follows: snap.issueSubs.filter((row) => row.issue_id === issueId).length,
    links: snap.links.filter((row) => row.source_id === issueId || row.target_id === issueId)
      .length,
  }
}
const NONE = { labels: 0, attachments: 0, follows: 0, links: 0 }
const ALL = { labels: 1, attachments: 1, follows: 1, links: 1 }

const archive = (t: T, f: OrgFixture, task: Doc<'issues'>) =>
  as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: task.id })
const unarchive = (t: T, f: OrgFixture, task: Doc<'issues'>) =>
  as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: task.id })

/* The agent reads and writes the Testbed tree. */
const grantAgent = (t: T, f: OrgFixture) =>
  t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
const machineArchive = (t: T, f: OrgFixture, task: Doc<'issues'>, archived: boolean) =>
  t.mutation(internal.machine.mcp.updateIssue, {
    callerId: f.agent.id,
    access: 'write',
    ref: `QN-${task.num}`,
    archived,
  })

/* The scheduled functions waiting under `name`. */
const pending = (t: T, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query('_scheduled_functions').collect()).filter(
      (job) => job.name === name && job.state.kind === 'pending',
    ),
  )

/* An active task, a parent, and its subtask in another project, each with
 * relation rows; the parent and the subtask each link to the active task. */
async function family(t: T, f: OrgFixture) {
  const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const child = await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub2.id,
    parent_id: parent.id,
  })
  await plantRelations(t, f, other)
  await plantRelations(t, f, parent, [other])
  await plantRelations(t, f, child, [other])
  return { other, parent, child }
}

describe('archiving a task', () => {
  it('marks the rows of the task and its subtree and flags them once the steps run; the snapshot sends none of them before or after', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { other, parent, child } = await family(t, f)
    expect(await shown(t, f, parent.id)).toEqual(ALL)

    await archive(t, f, parent)

    // unmarked rows of archived tasks are filtered, as before marks existed
    for (const task of [parent, child]) {
      expect(await marks(t, task)).toEqual(each(false))
      expect(await shown(t, f, task.id)).toEqual(NONE)
    }
    await runSteps(t)
    for (const task of [parent, child]) {
      expect(await marks(t, task)).toEqual(each(true))
      expect(await shown(t, f, task.id)).toEqual(NONE)
    }
    // the active task keeps its own rows; its links lead to archived tasks
    expect(await marks(t, other)).toEqual({ ...each(false, 0), links: [true, true] })
    expect(await shown(t, f, other.id)).toEqual({ ...ALL, links: 0 })
  })

  it('through the machine toggle marks the subtree too', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grantAgent(t, f)
    const { parent, child } = await family(t, f)

    await machineArchive(t, f, parent, true)
    await runSteps(t)

    for (const task of [parent, child]) expect(await marks(t, task)).toEqual(each(true))
  })

  it('by the nightly sweep marks the tasks it archives', async () => {
    const t = newT()
    const f = await withOrg(t)
    const done = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    })
    const open = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantRelations(t, f, done, [open])

    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await runSteps(t)

    expect((await t.run((ctx) => ctx.db.get(done._id)))?.archived_at).toBeDefined()
    expect(await marks(t, done)).toEqual(each(true))
  })

  it('a project archive stamps no task and marks nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { parent, child } = await family(t, f)

    await as(t, f.user).mutation(api.projects.archive, { org_id: f.org.id, id: f.meta.id })
    await runSteps(t)

    for (const task of [parent, child]) {
      expect((await t.run((ctx) => ctx.db.get(task._id)))?.archived_at).toBeUndefined()
      expect(await marks(t, task)).toEqual(each(false))
    }
  })

  it('a restore before the step runs leaves the rows unmarked and in the snapshot', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { parent, child } = await family(t, f)

    await archive(t, f, parent)
    await unarchive(t, f, parent)
    await runSteps(t)

    // the step found the parent active; the subtask stays archived and marked
    expect(await marks(t, parent)).toEqual(each(false))
    expect(await shown(t, f, parent.id)).toEqual(ALL)
    expect(await marks(t, child)).toEqual(each(true))
  })
})

describe('a restore', () => {
  it('sends the rows of the task and every archived ancestor in the very next snapshot, and clears their marks in the background', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { other, parent, child } = await family(t, f)
    await archive(t, f, parent)
    await runSteps(t)

    // restoring the subtask restores its parent with it; the flag, server
    // bookkeeping, stays out of the row the app gets back
    const row = await unarchive(t, f, child)
    expect(row).not.toHaveProperty('relations_marked')

    for (const task of [parent, child]) {
      expect(await marks(t, task)).toEqual(each(true))
      expect(await shown(t, f, task.id)).toEqual(ALL)
    }
    expect(await shown(t, f, other.id)).toEqual({ ...ALL, links: 2 })
    await runSteps(t)
    for (const task of [parent, child]) {
      expect(await marks(t, task)).toEqual(each(false))
      expect(await shown(t, f, task.id)).toEqual(ALL)
    }
    expect(await shown(t, f, other.id)).toEqual({ ...ALL, links: 2 })
  })

  it('through the machine toggle does the same', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grantAgent(t, f)
    const { parent, child } = await family(t, f)
    await machineArchive(t, f, parent, true)
    await runSteps(t)

    await machineArchive(t, f, child, false)

    for (const task of [parent, child]) expect(await shown(t, f, task.id)).toEqual(ALL)
    await runSteps(t)
    for (const task of [parent, child]) {
      expect(await marks(t, task)).toEqual(each(false))
      expect(await shown(t, f, task.id)).toEqual(ALL)
    }
  })

  it('keeps a link hidden while either end is archived and sends it once both are active', async () => {
    const t = newT()
    const f = await withOrg(t)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantRelations(t, f, a, [b])
    const linkShown = async () => (await shown(t, f, a.id)).links

    await archive(t, f, a)
    await runSteps(t)
    expect((await marks(t, b)).links).toEqual([true])
    expect(await linkShown()).toBe(0)
    await archive(t, f, b)
    await runSteps(t)

    // with the other end still archived, the restored task's link stays out,
    // marked or not; clearing the mark meanwhile is safe
    await unarchive(t, f, a)
    expect(await linkShown()).toBe(0)
    await runSteps(t)
    expect((await marks(t, a)).links).toEqual([false])
    expect(await linkShown()).toBe(0)

    await unarchive(t, f, b)
    expect(await linkShown()).toBe(1)
  })

  it('of a task with more relation rows than one transaction may write succeeds, and its marks clear in bounded steps', async () => {
    Object.assign(ARCHIVE_MARKS, { rows: 40 })
    const t = newT({ transactionLimits: { documentsWritten: 100 } })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let from = 0; from < 240; from += 80) {
      await t.run(async (ctx) => {
        for (let i = from; i < from + 80; i++)
          await ctx.db.insert('issue_labels', {
            org_id: f.org.id,
            issue_id: task.id,
            label_id: `label-${i}`,
          })
      })
    }
    const marked = async () => (await marks(t, task)).labels.filter(Boolean).length
    await archive(t, f, task)
    await runSteps(t)
    expect(await marked()).toBe(240)

    // a restore that cleared 240 marks itself would pass the 100-write limit
    await unarchive(t, f, task)
    expect((await shown(t, f, task.id)).labels).toBe(240)
    await runSteps(t)
    expect(await marked()).toBe(0)
    expect((await marks(t, task)).flagged).toBe(false)
  })

  it('stays right in the snapshot when its clear step is lost, and the nightly sweep schedules it again', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { other, parent } = await family(t, f)
    await archive(t, f, parent)
    await runSteps(t)

    await unarchive(t, f, parent)
    const lost = await pending(t, 'archiveMarks:clearTasks')
    expect(lost).toHaveLength(1)
    await t.run((ctx) => ctx.scheduler.cancel(lost[0]._id))
    await runSteps(t)

    expect(await marks(t, parent)).toEqual(each(true))
    expect(await shown(t, f, parent.id)).toEqual(ALL)
    expect(await shown(t, f, other.id)).toEqual({ ...ALL, links: 1 })

    await t.mutation(internal.jobs.archiveDoneIssues, {})
    await runSteps(t)
    expect(await marks(t, parent)).toEqual(each(false))
    expect(await shown(t, f, parent.id)).toEqual(ALL)
  })

  it('archived again while its marks are cleared leaves the rows to the mark steps', async () => {
    Object.assign(ARCHIVE_MARKS, { rows: 2 })
    const t = newT()
    const f = await withOrg(t)
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantRelations(t, f, task, [other])
    await archive(t, f, task)
    await runSteps(t)
    expect(await marks(t, task)).toEqual(each(true))

    await unarchive(t, f, task)
    await runPending(t)
    // the first clear step cleared two of the four rows
    const half = await marks(t, task)
    expect([...half.labels, ...half.attachments, ...half.follows, ...half.links]).toEqual([
      false,
      false,
      true,
      true,
    ])
    expect(half.flagged).toBe(true)

    await archive(t, f, task)
    await runSteps(t)
    expect(await marks(t, task)).toEqual(each(true))
    expect(await shown(t, f, task.id)).toEqual(NONE)

    await unarchive(t, f, task)
    expect(await shown(t, f, task.id)).toEqual(ALL)
    await runSteps(t)
    expect(await marks(t, task)).toEqual(each(false))
  })
})

describe('the background steps', () => {
  it('continue across steps with lowered limits and change nothing when run again', async () => {
    Object.assign(ARCHIVE_MARKS, { rows: 2, tasks: 2 })
    const t = newT()
    const f = await withOrg(t)
    const archived = { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW }
    const a = await plantIssue(t, archived)
    const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const b = await plantIssue(t, archived)
    const c = await plantIssue(t, archived)
    for (const task of [a, active, b, c]) await plantRelations(t, f, task)
    const issues = [a.id, active.id, b.id, c.id]

    await t.mutation(internal.archiveMarks.markTasks, { issues })

    // two of a's three rows, and the next step starts at a again
    expect(await marks(t, a)).toEqual({ ...each(true, 0), follows: [false] })
    expect(await pending(t, 'archiveMarks:markTasks')).toHaveLength(1)

    await runSteps(t)

    // a's last row, then the active task ends the second step at two tasks;
    // then two of b's rows, b's last and one of c's, and c's last two
    const steps = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())
    expect(steps.map((job) => job.args[0])).toEqual([
      { issues },
      { issues: [b.id, c.id] },
      { issues: [b.id, c.id] },
      { issues: [c.id] },
    ])
    for (const task of [a, b, c]) expect(await marks(t, task)).toEqual(each(true, 0))
    expect(await marks(t, active)).toEqual(each(false, 0))

    const rows = () =>
      t.run(async (ctx) => [
        ...(await ctx.db.query('issue_labels').collect()),
        ...(await ctx.db.query('issue_attachments').collect()),
        ...(await ctx.db.query('issue_subscriptions').collect()),
        ...(await ctx.db.query('issues').collect()),
      ])
    const before = await rows()
    await t.mutation(internal.archiveMarks.markTasks, { issues })
    await runSteps(t)
    expect(await rows()).toEqual(before)
  })

  it('read only the rows they change, so a step that continues on a task reads none twice', async () => {
    Object.assign(ARCHIVE_MARKS, { rows: 10 })
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++)
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: task.id,
          label_id: `label-${i}`,
        })
    })
    // each call is one step; the continuations they schedule are not run
    const documentsRead = (step: typeof markArchivedTasks) =>
      t.mutation(async (ctx) => {
        await step(ctx, [task.id])
        return (await ctx.meta.getTransactionMetrics()).documentsRead.used
      })
    await t.run((ctx) => ctx.db.patch(task._id, { archived_at: NOW }))
    const marking = [] as number[]
    for (let i = 0; i < 3; i++) marking.push(await documentsRead(markArchivedTasks))
    expect((await marks(t, task)).labels.every(Boolean)).toBe(true)
    await t.run((ctx) => ctx.db.patch(task._id, { archived_at: undefined }))
    const clearing = [] as number[]
    for (let i = 0; i < 3; i++) clearing.push(await documentsRead(clearMarkedTasks))
    expect((await marks(t, task)).labels.some(Boolean)).toBe(false)
    // The task and its flag, at most the 10 rows a step changes plus one that
    // shows more remain, and each row again as it is patched; never the rows
    // an earlier step already changed (a rescan would read 30 by the third).
    for (const used of [...marking, ...clearing]) expect(used).toBeLessThanOrEqual(23)
  })

  it('are scheduled in steps of at most ARCHIVE_MARKS.tasks tasks', async () => {
    Object.assign(ARCHIVE_MARKS, { tasks: 2 })
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (let i = 0; i < 4; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id })

    await archive(t, f, parent)

    const marking = await pending(t, 'archiveMarks:markTasks')
    expect(marking.map((job) => (job.args[0] as { issues: string[] }).issues.length)).toEqual([
      2, 2, 1,
    ])
    expect((marking[0].args[0] as { issues: string[] }).issues[0]).toBe(parent.id)
  })
})

describe('rows of tasks archived before marks existed', () => {
  it('stay out of the snapshot, read in bulk or task by task, until a scheduled step marks them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const old = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW })
    const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantRelations(t, f, old, [active])
    await plantRelations(t, f, active)

    expect(await shown(t, f, old.id)).toEqual(NONE)
    Object.assign(RELATION_READ, { tasks: Number.POSITIVE_INFINITY, ratio: 0 })
    expect(await shown(t, f, old.id)).toEqual(NONE)
    expect(await shown(t, f, active.id)).toEqual({ ...ALL, links: 0 })
    Object.assign(RELATION_READ, DEFAULT_READ)

    // what a backfill over old archives does
    await t.run((ctx) => scheduleArchivedReads(ctx, { issues: [old.id] }))
    await runSteps(t)
    expect(await marks(t, old)).toEqual(each(true))
  })
})

describe('a follow of an archived task', () => {
  it('is not sent, still brings news, and is sent again at once after a restore', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantRelations(t, f, task)
    await archive(t, f, task)
    await runSteps(t)
    expect((await marks(t, task)).follows).toEqual([true])
    expect((await shown(t, f, task.id)).follows).toBe(0)

    // the roster still lists the follower, and a comment still reaches them
    const roster = await as(t, f.user).query(api.issues.subscribers, {
      org_id: f.org.id,
      issue_id: task.id,
    })
    expect(roster.subscribers).toContain(f.admin.id)
    // a later instant than the Archived notice, so the item keeps the comment
    vi.setSystemTime(Date.now() + 1000)
    await as(t, f.user).mutation(api.comments.create, {
      org_id: f.org.id,
      id: uuid(),
      issue_id: task.id,
      body: 'Still following?',
    })
    expect((await messagesFor(t, f.admin.id, task.id)).map((m) => m.detail)).toEqual([
      'New comment',
    ])

    await unarchive(t, f, task)
    expect((await shown(t, f, task.id)).follows).toBe(1)
    await runSteps(t)
    expect((await shown(t, f, task.id)).follows).toBe(1)
  })
})
