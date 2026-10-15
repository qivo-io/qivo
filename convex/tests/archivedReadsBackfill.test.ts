/* internal/archivedReadsBackfill, the one-time pass that marks read the
 * inbox messages about tasks archived, or in projects archived, before
 * archiving did that itself. The fixtures insert that older state directly,
 * as archived rows whose messages are still unread or snoozed. The steps
 * run when the test fires the fake timers. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  allMessages,
  as,
  messagesFor,
  NOW,
  newT,
  plantIssue,
  plantMessage,
  type T,
  withOrg,
} from './helpers.setup'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const backfill = internal.internal.archivedReadsBackfill

/* Runs every scheduled function, and anything they schedule, to completion. */
const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())

const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())

/* What a recipient's item about one task holds, oldest first. */
const item = async (t: T, who: Doc<'profiles'>, task: Doc<'issues'>) =>
  (await messagesFor(t, who.id, task.id)).map((m) => ({
    detail: m.detail,
    read: m.read_at !== undefined,
    snoozed: m.snoozed_until !== undefined,
  }))

/* Two unread messages about `task` for `who`, the newer one snoozed when
 * asked, as an inbox held them before archiving marked anything read. */
async function unreadPair(t: T, who: Doc<'profiles'>, task: Doc<'issues'>, snoozed = false) {
  const base = { org_id: task.org_id, recipient_id: who.id, issue_id: task.id }
  await plantMessage(t, { ...base, detail: 'older', created_at: '2026-01-02T00:00:00.000Z' })
  await plantMessage(t, {
    ...base,
    detail: 'newer',
    created_at: '2026-01-03T00:00:00.000Z',
    snoozed_until: snoozed ? '2099-01-01T00:00:00.000Z' : undefined,
  })
}

const UNREAD = [
  { detail: 'older', read: false, snoozed: false },
  { detail: 'newer', read: false, snoozed: false },
]
const READ = [{ detail: 'newer', read: true, snoozed: false }]

/* withOrg with older archived data in both organizations: in Testbed an
 * archived task in FW, PCB archived with an active and an archived task in
 * it, and an active control task in FW; in Other an archived task. The
 * admin of each holds unread messages about each of its tasks. */
async function olderArchives(t: T) {
  const f = await withOrg(t)
  const archived = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW })
  const shelved = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
  const both = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, archived_at: NOW })
  const active = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW }))
  const elsewhere = await plantIssue(t, {
    org_id: f.otherOrg.id,
    project_id: f.otherProject.id,
    archived_at: NOW,
  })
  await unreadPair(t, f.admin, archived, true)
  await unreadPair(t, f.guest, archived)
  for (const task of [shelved, both, active]) await unreadPair(t, f.admin, task)
  await unreadPair(t, f.otherAdmin, elsewhere)
  return { f, archived, shelved, both, active, elsewhere }
}

describe('internal/archivedReadsBackfill', () => {
  it('marks read the messages about archived tasks and archived projects in every organization, and is safe to run again', async () => {
    const t = newT()
    const { f, archived, shelved, both, active, elsewhere } = await olderArchives(t)

    // two runs that overlap
    expect(await t.mutation(backfill.start, {})).toBeNull()
    await t.mutation(backfill.start, {})
    await runSteps(t)

    // each item keeps its newest message, read, and the snooze is gone
    for (const task of [archived, shelved, both]) expect(await item(t, f.admin, task)).toEqual(READ)
    expect(await item(t, f.guest, archived)).toEqual(READ)
    expect(await item(t, f.otherAdmin, elsewhere)).toEqual(READ)
    expect(await item(t, f.admin, active)).toEqual(UNREAD)

    // a later run finds nothing to change
    const before = await allMessages(t)
    await t.mutation(backfill.start, {})
    await runSteps(t)
    expect(await allMessages(t)).toEqual(before)
  })

  it('hands each page to the archive steps and leaves a task or project restored before its step alone', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW })
    const shelved = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW }))
    for (const issue of [task, shelved]) await unreadPair(t, f.admin, issue)

    const step = { org_id: f.org.id, tasks: 0, projects: 0 }
    await t.mutation(backfill.org, { ...step, phase: 'tasks' })
    await t.mutation(backfill.org, { ...step, phase: 'projects' })
    const steps = (await scheduled(t)).map((job) => [job.name, job.args[0]])
    expect(steps).toContainEqual(['messages:readArchivedTasks', { issues: [task.id] }])
    expect(steps).toContainEqual(['messages:readArchivedProject', { project_id: f.sub2.id }])

    // both are restored before those steps run
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: task.id })
    await as(t, f.user).mutation(api.projects.unarchive, { org_id: f.org.id, id: f.sub2.id })
    await runSteps(t)

    expect(await item(t, f.admin, task)).toEqual(UNREAD)
    expect(await item(t, f.admin, shelved)).toEqual(UNREAD)
  })

  it('walks organizations, archived tasks and projects over several pages', async () => {
    // spied before newT, which takes the console the functions log to
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    // a second fixture adds two more organizations to walk
    const g = await withOrg(t)
    const tasks: Doc<'issues'>[] = []
    for (let n = 0; n < 3; n++) {
      tasks.push(await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW }))
    }
    const inSub2 = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const inHidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    const later = await plantIssue(t, { org_id: g.org.id, project_id: g.sub.id, archived_at: NOW })
    await t.run(async (ctx) => {
      for (const p of [f.sub2, f.hidden]) await ctx.db.patch(p._id, { archived_at: NOW })
    })
    for (const task of [...tasks, inSub2, inHidden]) await unreadPair(t, f.admin, task)
    await unreadPair(t, g.admin, later)

    await t.mutation(backfill.start, { page: 1 })
    await runSteps(t)

    for (const task of [...tasks, inSub2, inHidden]) {
      expect(await item(t, f.admin, task)).toEqual(READ)
    }
    expect(await item(t, g.admin, later)).toEqual(READ)
    // one organization per start step, and one task or project per org step
    const jobs = await scheduled(t)
    const named = (name: string) =>
      jobs.filter((job) => job.name === name).map((job) => job.args[0])
    expect(named('internal/archivedReadsBackfill:start').length).toBeGreaterThanOrEqual(3)
    const walk = named('internal/archivedReadsBackfill:org').filter((a) => a.org_id === f.org.id)
    expect(walk.filter((a) => a.phase === 'tasks').length).toBeGreaterThanOrEqual(3)
    expect(walk.filter((a) => a.phase === 'projects').length).toBeGreaterThanOrEqual(3)
    // every page was handed over: three tasks, then PCB and SKNK
    expect(logged).toHaveBeenCalledWith('Archived reads backfill scheduled', {
      org_id: f.org.id,
      tasks: 3,
      projects: 2,
    })
  })

  it('schedules nothing on an empty deployment', async () => {
    const t = newT()
    expect(await t.mutation(backfill.start, {})).toBeNull()
    expect(await scheduled(t)).toEqual([])
    await runSteps(t)
    expect(await allMessages(t)).toEqual([])
  })
})
