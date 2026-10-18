/* internal/subtaskFamilyBackfill, the one-time audit and detach of subtasks
 * linked across top-level projects before the subtask rule. The fixtures
 * plant those older links directly, as the rule now refuses them. withOrg's
 * TBED holds FW (f.sub) and PCB (f.sub2); the scene adds a second top-level
 * project, Cloud, with the Backend sub-project. The backfill's steps run
 * when the test fires the fake timers. */
/// <reference types="vite/client" />

import type { FunctionArgs } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { FAMILY_PAGE } from '../internal/subtaskFamilyBackfill'
import { issueKey } from '../lib/taskRefs'
import {
  activityFor,
  allMessages,
  NOW,
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

type StepArgs = FunctionArgs<typeof backfill.start>

/* The arguments of every backfill step scheduled so far, oldest first. */
const steps = async (t: T): Promise<StepArgs[]> =>
  (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect()))
    .filter((job) => job.name === 'internal/subtaskFamilyBackfill:start')
    .map((job) => job.args[0] as StepArgs)

/* A full backfill run from empty arguments, one step at a time, each with
 * the arguments the step before scheduled. Unlike run, it leaves the
 * webhook work the steps schedule alone. Answers the number of steps. */
async function stepAll(t: T): Promise<number> {
  let args: StepArgs = {}
  for (let n = 1; n <= 100; n++) {
    const before = (await steps(t)).length
    await t.mutation(backfill.start, args)
    const after = await steps(t)
    if (after.length === before) return n
    args = after[after.length - 1]
  }
  throw new Error('the backfill did not finish')
}

/* withOrg plus Cloud › Backend, Cloud › Ops (archived) and these links:
 *   - parent (FW): subtasks in FW and PCB (same top-level), in Backend, one
 *     active and one archived, and in Ops
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
  const ops = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: cloud.id,
    key: 'OPS',
    name: 'Ops',
    archived_at: ARCHIVED,
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
    inArchivedProject: await task(ops.id, { parent_id: parent.id }),
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
  return { f, cloud, parent, lone, shelved, links }
}

type Scene = Awaited<ReturnType<typeof scene>>

/* The audit's row for `child` under `parent`, a subtask in Backend unless
 * `child_project` names another sub-project. */
const crossRow = (
  s: Scene,
  child: Doc<'issues'>,
  parent: Doc<'issues'>,
  archived: { child: boolean; parent: boolean },
  child_project = 'BE',
) => ({
  org_id: s.f.org.id,
  child: issueKey(child.num),
  child_project,
  parent: issueKey(parent.num),
  parent_project: 'FW',
  child_archived: archived.child,
  parent_archived: archived.parent,
})

const expectedCross = (s: Scene) => [
  crossRow(s, s.links.cross, s.parent, { child: false, parent: false }),
  crossRow(s, s.links.crossArchived, s.parent, { child: true, parent: false }),
  crossRow(s, s.links.inArchivedProject, s.parent, { child: false, parent: false }, 'OPS'),
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

const SUBSCRIBERS = 6

/* `count` agents with a grant on Cloud, each with its own key and a
 * task.updated subscription, so each detach checks each agent's sight of
 * the subtask's project. */
async function subscribeAgents(t: T, s: Scene, count: number): Promise<void> {
  await t.run(async (ctx) => {
    for (let n = 0; n < count; n++) {
      const profile_id = uuid()
      await ctx.db.insert('profiles', {
        id: profile_id,
        org_id: s.f.org.id,
        name: `Agent ${n}`,
        initials: 'AG',
        color: '#50b070',
        org_role: 'user',
        active: true,
        kind: 'agent',
        created_at: NOW,
      })
      await ctx.db.insert('project_access', {
        project_id: s.cloud.id,
        profile_id,
        level: 'viewer',
      })
      const credential_id = uuid()
      const credential_row_id = await ctx.db.insert('agent_keys', {
        id: credential_id,
        profile_id,
        name: 'Backfill events',
        key_prefix: 'qva_1...1111',
        key_hash: uuid(),
        created_at: NOW,
      })
      await ctx.db.insert('webhook_subscriptions', {
        id: uuid(),
        org_id: s.f.org.id,
        owner: { profile_id, credential_table: 'agent_keys', credential_id, credential_row_id },
        name: 'task.updated',
        filters: {},
        url: `https://receiver.example/${n}`,
        encrypted_secret: 'test-only',
        created_at: Date.now(),
      })
    }
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
      scanned: 10,
      cursor: null,
      done: true,
    })
    expect(await allIssues(t)).toEqual(before)
    expect(await steps(t)).toEqual([])
  })

  it('pages by task count and task bytes, and stops before a parent past the byte budget', async () => {
    const t = newT()
    const s = await scene(t)
    const all = (await auditAll(t))[0]

    FAMILY_PAGE.tasks = 2
    const small = await auditAll(t)
    expect(small.length).toBe(5)
    for (const page of small) expect(page.scanned).toBeLessThanOrEqual(2)

    // with a task byte budget of 1, each page reads one task
    FAMILY_PAGE.tasks = DEFAULT_PAGE.tasks
    FAMILY_PAGE.bytes = 1
    const thin = await auditAll(t)
    expect(thin.length).toBeGreaterThanOrEqual(all.scanned)
    for (const page of thin) expect(page.scanned).toBeLessThanOrEqual(1)

    // with a parent byte budget of 0, each page reads one parent
    FAMILY_PAGE.bytes = DEFAULT_PAGE.bytes
    FAMILY_PAGE.parentBytes = 0
    const narrow = await auditAll(t)
    // parent, lone, shelved, the gone task and the missing parent
    expect(narrow.length).toBe(5)
    for (const page of narrow.slice(0, -1))
      expect(page.cursor).toEqual({ from: expect.any(String) })

    for (const pages of [small, thin, narrow]) {
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
      s.links.inArchivedProject,
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

    const counts = { scanned: 10, detached: 5, dangling: 1, foreign_org: 1, no_project: 1 }
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
      t.query(internal.machine.rest.getIssue, {
        now: NOW,
        callerId: s.f.admin.id,
        access: 'read',
        ref,
      })
    expect(await getTask(s.lone.id)).toMatchObject({ is_group: true })
    expect(await getTask(s.parent.id)).toMatchObject({ is_group: true })

    await run(t)

    // its own status shows again; parent keeps its FW and PCB subtasks
    expect(await getTask(s.lone.id)).toMatchObject({ is_group: false, status: 'review' })
    expect(await getTask(s.parent.id)).toMatchObject({ is_group: true })
    expect(await getTask(s.links.cross.id)).toMatchObject({ parent_id: null })
  })

  it.each([
    ['task count and parent bytes', { tasks: 2, parentBytes: 1 }],
    ['task bytes', { bytes: 1 }],
    ['room, so each step detaches one link', { room: 0 }],
  ])(
    'carries the counts across steps bounded by %s, and a second run detaches nothing',
    async (_, page) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = newT()
      await scene(t)
      Object.assign(FAMILY_PAGE, page)

      await run(t)
      const after = await allIssues(t)
      expect((await steps(t)).length).toBeGreaterThan(3)
      await run(t)

      expect(await allIssues(t)).toEqual(after)
      const first = { scanned: 10, detached: 5, dangling: 1, foreign_org: 1, no_project: 1 }
      const second = { ...first, scanned: 5, detached: 0 }
      expect((await auditRows(t)).map((row) => row.detail)).toEqual([first, second])
      const done = info.mock.calls.filter(([message]) => message === 'Subtask family backfill done')
      expect(done.map(([, counts]) => counts)).toEqual([first, second])
      expect((await auditAll(t)).flatMap((p) => p.cross)).toEqual([])
    },
  )

  /* The scene plus SUBSCRIBERS agents subscribed to task.updated, and 12
   * more subtasks of parent, each in its own new Cloud sub-project, so each
   * of the 17 detaches checks every agent's sight of a new project. */
  async function fanOutScene(t: T) {
    const s = await scene(t)
    await subscribeAgents(t, s, SUBSCRIBERS)
    for (let n = 0; n < 12; n++) {
      const project = await plantProject(t, {
        org_id: s.f.org.id,
        type: 'project',
        parent_id: s.cloud.id,
      })
      await plantIssue(t, { org_id: s.f.org.id, project_id: project.id, parent_id: s.parent.id })
    }
    return s
  }

  /* Runs the backfill step by step and checks its counts and events. */
  async function expectFullRun(t: T, info: { mock: { calls: unknown[][] } }): Promise<void> {
    expect(await stepAll(t)).toBeGreaterThan(2)
    const counts = { scanned: 22, detached: 17, dangling: 1, foreign_org: 1, no_project: 1 }
    expect((await auditRows(t)).map((row) => row.detail)).toEqual([counts])
    const done = info.mock.calls.filter(([message]) => message === 'Subtask family backfill done')
    expect(done.map(([, detail]) => detail)).toEqual([counts])
    expect((await updateEvents(t)).length).toBe(17)
    expect((await auditAll(t)).flatMap((p) => p.cross)).toEqual([])
  }

  it('stops a step at its budget of subscriber checks, then reads the same page again', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    await fanOutScene(t)
    // two detaches of SUBSCRIBERS checks each fit, a third does not
    FAMILY_PAGE.checks = 2 * SUBSCRIBERS + SUBSCRIBERS - 1

    await expectFullRun(t, info)
    const detached = (await steps(t)).map((step) => step.detached ?? 0)
    expect(detached.map((n, i) => n - (detached[i - 1] ?? 0))).toEqual(Array(8).fill(2))
  })

  it('stops a step before its events pass Convex limits, then reads the same page again', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Each task.updated checks every subscriber's sight of the task's
    // project, five index ranges per subscriber here. The page's 17 detaches
    // in one step read about 470 ranges, past the 300 allowed here.
    const t = newT({ transactionLimits: { databaseQueries: 300 } })
    await fanOutScene(t)

    await expectFullRun(t, info)
  })
})
