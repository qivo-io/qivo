/* internal/subtaskFamilyBackfill, the one-time audit and detach of subtasks
 * linked across top-level projects before the subtask rule. The fixtures
 * plant those older links directly, as the rule now refuses them. withOrg's
 * TBED holds FW (f.sub) and PCB (f.sub2); the scene adds a second top-level
 * project, Cloud, with the Backend sub-project. The backfill's steps run
 * when the test fires the fake timers. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { FAMILY_PAGE } from '../internal/subtaskFamilyBackfill'
import { issueKey } from '../lib/taskRefs'
import {
  activityFor,
  allMessages,
  newT,
  plantIssue,
  plantProject,
  plantSubscription,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const DEFAULT_PAGE = { ...FAMILY_PAGE }
const ARCHIVED = '2026-01-02T00:00:00.000Z'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.assign(FAMILY_PAGE, DEFAULT_PAGE)
})

const backfill = internal.internal.subtaskFamilyBackfill

type Page = Awaited<ReturnType<typeof auditPage>>
const auditPage = (t: T, cursor?: { from?: string; cursor?: string } | null) =>
  t.query(backfill.audit, cursor === undefined ? {} : { cursor })

/* Every audit page from the start, in order. */
async function auditAll(t: T): Promise<Page[]> {
  const pages: Page[] = []
  let cursor: Page['cursor'] = null
  for (let guard = 0; guard < 100; guard++) {
    const page = await auditPage(t, cursor)
    pages.push(page)
    if (page.done) return pages
    cursor = page.cursor
  }
  throw new Error('the audit did not finish')
}

/* A full backfill run from empty arguments. */
async function run(t: T): Promise<void> {
  await t.mutation(backfill.start, {})
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
}

const allIssues = (t: T): Promise<Doc<'issues'>[]> =>
  t.run(async (ctx) =>
    (await ctx.db.query('issues').collect()).sort((a, b) => a.id.localeCompare(b.id)),
  )

const auditRows = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('platform_audit_log').collect()).filter(
      (row) => row.action === 'subtask_family_backfill',
    ),
  )

/* The arguments of every backfill step scheduled so far. */
const steps = async (t: T): Promise<Record<string, unknown>[]> =>
  (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()))
    .filter((job) => job.name === 'internal/subtaskFamilyBackfill:start')
    .map((job) => job.args[0] as Record<string, unknown>)

/* withOrg plus Cloud › Backend and these links:
 *   - parent (FW): subtasks in FW and PCB (same top-level), and in Backend,
 *     one active and one archived
 *   - lone (FW): its only subtask is in Backend
 *   - shelved (FW, archived): an archived subtask in Backend
 *   - a Backend task whose parent no longer exists, an Other task under
 *     parent, and a Backend task under a parent whose project is gone. */
async function scene(t: T) {
  const f = await withOrg(t)
  const cloud = await plantProject(t, { org_id: f.org.id, key: 'CLD', name: 'Cloud' })
  const backend = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: cloud.id,
    key: 'BE',
    name: 'Backend',
  })
  const task = (project_id: string, extra: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: f.org.id, project_id, ...extra })
  const parent = await task(f.sub.id)
  const lone = await task(f.sub.id, { status: 'review' })
  const shelved = await task(f.sub.id, { archived_at: ARCHIVED })
  const gone = await task(uuid())
  const links = {
    sameSub: await task(f.sub.id, { parent_id: parent.id }),
    sibling: await task(f.sub2.id, { parent_id: parent.id }),
    cross: await task(backend.id, { parent_id: parent.id }),
    crossArchived: await task(backend.id, { parent_id: parent.id, archived_at: ARCHIVED }),
    loneChild: await task(backend.id, { parent_id: lone.id }),
    underShelved: await task(backend.id, { parent_id: shelved.id, archived_at: ARCHIVED }),
    dangling: await task(backend.id, { parent_id: uuid() }),
    foreign: await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      parent_id: parent.id,
    }),
    noProject: await task(backend.id, { parent_id: gone.id }),
  }
  return { f, backend, parent, lone, shelved, links }
}

type Scene = Awaited<ReturnType<typeof scene>>

/* The audit's row for `child` under `parent`. */
const crossRow = (
  s: Scene,
  child: Doc<'issues'>,
  parent: Doc<'issues'>,
  archived: { child: boolean; parent: boolean },
) => ({
  org_id: s.f.org.id,
  child: issueKey(child.num),
  child_project: 'BE',
  parent: issueKey(parent.num),
  parent_project: 'FW',
  child_archived: archived.child,
  parent_archived: archived.parent,
})

const expectedCross = (s: Scene) => [
  crossRow(s, s.links.cross, s.parent, { child: false, parent: false }),
  crossRow(s, s.links.crossArchived, s.parent, { child: true, parent: false }),
  crossRow(s, s.links.loneChild, s.lone, { child: false, parent: false }),
  crossRow(s, s.links.underShelved, s.shelved, { child: true, parent: true }),
]

const byChild = (a: { child: string }, b: { child: string }) => a.child.localeCompare(b.child)
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
/* A task.updated subscription of the admin's, so each event lands in the
 * outbox. The admin sees every project. */
async function subscribeToUpdates(t: T, f: Scene['f']): Promise<void> {
  const owner = await t.run(async (ctx) => {
    const id = uuid()
    const credential_row_id = await ctx.db.insert('mcp_tokens', {
      id,
      profile_id: f.admin.id,
      name: 'Backfill events',
      token_prefix: 'qvt_test',
      token_hash: uuid(),
      access: 'read',
      created_at: new Date().toISOString(),
    })
    return {
      profile_id: f.admin.id,
      credential_table: 'mcp_tokens' as const,
      credential_id: id,
      credential_row_id,
    }
  })
  await t.mutation(internal.webhooks.save, {
    owner,
    id: uuid(),
    name: 'task.updated',
    filters: {},
    url: 'https://receiver.example/events',
    encrypted_secret: 'test-only',
  })
}

/* The task id, actor and changed fields of each task.updated in the outbox. */
const updateEvents = (t: T) =>
  t.run(async (ctx) =>
    (await ctx.db.query('webhook_events').collect())
      .filter((e) => e.name === 'task.updated')
      .map((e) => {
        const { data } = JSON.parse(e.payload) as {
          data: { actor_id: string | null; changed_fields: string[] }
        }
        return { task_id: e.task_id, actor_id: data.actor_id, changed: data.changed_fields }
      }),
  )

describe('subtaskFamilyBackfill audit', () => {
  it('lists the links across top-level projects, archived ones included, and writes nothing', async () => {
    const t = newT()
    const s = await scene(t)
    const before = await allIssues(t)

    const [page] = await auditAll(t)

    expect([...page.cross].sort(byChild)).toEqual(expectedCross(s).sort(byChild))
    // the FW and PCB subtasks of parent are not listed
    expect(page).toMatchObject({
      dangling: 1,
      foreign_org: 1,
      no_project: 1,
      scanned: 9,
      cursor: null,
      done: true,
    })
    expect(await allIssues(t)).toEqual(before)
    expect(await steps(t)).toEqual([])
  })

  it('pages by task count and stops before a parent past the byte budget', async () => {
    const t = newT()
    const s = await scene(t)
    const all = (await auditAll(t))[0]

    FAMILY_PAGE.tasks = 2
    const small = await auditAll(t)
    expect(small.length).toBe(5)
    for (const page of small) expect(page.scanned).toBeLessThanOrEqual(2)

    // with a parent byte budget of 0, each page reads one parent
    FAMILY_PAGE.tasks = DEFAULT_PAGE.tasks
    FAMILY_PAGE.parentBytes = 0
    const narrow = await auditAll(t)
    // parent, lone, shelved, the gone task and the missing parent
    expect(narrow.length).toBe(5)
    for (const page of narrow.slice(0, -1))
      expect(page.cursor).toEqual({ from: expect.any(String) })

    for (const pages of [small, narrow]) {
      expect(pages.flatMap((p) => p.cross).sort(byChild)).toEqual(expectedCross(s).sort(byChild))
      const sum = (key: 'scanned' | 'dangling' | 'foreign_org' | 'no_project') =>
        pages.reduce((n, p) => n + p[key], 0)
      expect([sum('scanned'), sum('dangling'), sum('foreign_org'), sum('no_project')]).toEqual([
        all.scanned,
        1,
        1,
        1,
      ])
    }
  })
})

describe('subtaskFamilyBackfill start', () => {
  it('detaches exactly the links across top-level projects and leaves every other link', async () => {
    // spied before newT, which takes the console the functions log to
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const s = await scene(t)
    await subscribeToUpdates(t, s.f)
    await plantSubscription(t, { issue_id: s.links.cross.id, profile_id: s.f.user.id })
    const before = new Map((await allIssues(t)).map((task) => [task.id, task]))

    // one step at the default page size, so no further step is scheduled
    await t.mutation(backfill.start, {})

    const detached = [
      s.links.cross,
      s.links.crossArchived,
      s.links.loneChild,
      s.links.underShelved,
    ].map((task) => task.id)
    for (const task of await allIssues(t)) {
      const old = before.get(task.id)
      if (detached.includes(task.id)) {
        // the link goes, and nothing else changes, updated_at included
        const { parent_id: _gone, ...rest } = old as Doc<'issues'>
        expect(task).toEqual(rest)
      } else {
        expect(task).toEqual(old)
      }
    }
    expect(await steps(t)).toEqual([])

    const events = await updateEvents(t)
    expect(events.map((e) => e.task_id).sort()).toEqual([...detached].sort())
    for (const e of events) expect(e).toMatchObject({ actor_id: null, changed: ['parent_id'] })
    expect(await allMessages(t)).toEqual([])
    expect(await activityFor(t, s.f.org.id)).toEqual([])

    const counts = { scanned: 9, detached: 4, dangling: 1, foreign_org: 1, no_project: 1 }
    expect((await auditRows(t)).map((row) => [row.actor_email, row.detail])).toEqual([
      ['cli', counts],
    ])
    const done = info.mock.calls.filter(([message]) => message === 'Subtask family backfill done')
    expect(done).toEqual([['Subtask family backfill done', counts]])
    const left = warn.mock.calls.filter(
      ([message]) => message === 'Subtask family backfill left a link alone',
    )
    expect(left.map(([, detail]) => detail).sort(byId)).toEqual(
      [
        { id: s.links.dangling.id, reason: 'dangling' },
        { id: s.links.foreign.id, reason: 'foreign_org' },
        { id: s.links.noProject.id, reason: 'no_project' },
      ].sort(byId),
    )

    // the audit now lists nothing to detach
    expect((await auditAll(t)).flatMap((page) => page.cross)).toEqual([])
  })

  it('turns a parent whose only subtask left into a task without subtasks', async () => {
    const t = newT()
    const s = await scene(t)
    const getTask = (ref: string) =>
      t.query(internal.machine.rest.getIssue, { callerId: s.f.admin.id, access: 'read', ref })
    expect(await getTask(s.lone.id)).toMatchObject({ is_group: true })
    expect(await getTask(s.parent.id)).toMatchObject({ is_group: true })

    await run(t)

    // its own status shows again; parent keeps its FW and PCB subtasks
    expect(await getTask(s.lone.id)).toMatchObject({ is_group: false, status: 'review' })
    expect(await getTask(s.parent.id)).toMatchObject({ is_group: true })
    expect(await getTask(s.links.cross.id)).toMatchObject({ parent_id: null })
  })

  it('carries the counts across steps, and a second run detaches nothing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    await scene(t)
    FAMILY_PAGE.tasks = 2
    FAMILY_PAGE.parentBytes = 1

    await run(t)
    const after = await allIssues(t)
    expect((await steps(t)).length).toBeGreaterThan(3)
    await run(t)

    expect(await allIssues(t)).toEqual(after)
    const first = { scanned: 9, detached: 4, dangling: 1, foreign_org: 1, no_project: 1 }
    const second = { ...first, scanned: 5, detached: 0 }
    expect((await auditRows(t)).map((row) => row.detail)).toEqual([first, second])
    const done = info.mock.calls.filter(([message]) => message === 'Subtask family backfill done')
    expect(done.map(([, counts]) => counts)).toEqual([first, second])
  })
})
