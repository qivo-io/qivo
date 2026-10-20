/* The live layer group rule (lib/liveTasks.ts countsAsSubtask): a task in
 * an active project is a group only through active subtasks in active
 * projects, on every surface, and the readers that need the organization's
 * live tasks never read the tasks of an archived project. The writes that
 * make a subtask count again (a project restore, a move out of an archived
 * project, a carried subtask) clear the parent's own hours, and those that
 * leave it uncounted (a task restore or an attach inside an archived
 * project) do not. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { ACCESS_POINT_CHECKS, taskOut } from '../lib/core'
import { byId } from '../lib/db'
import { countsAsSubtask, groupTest, LIVE_PROJECT_READS } from '../lib/liveTasks'
import { OWNER_LOAD_CHECKS, ownerLoadSpans } from '../lib/machineDelay'
import { orgProjectView } from '../lib/visibility'
import { weekGrid } from '../lib/workload'
import { getProject } from '../machine/rest'
import { MOVE_SUBTREE_HOLDER_RULE, REVIEWER_RULE } from '../model/issues'
import { ASSIGNEE_LOAD_CHECKS, assigneeLoad, workloadCore } from '../planning'
import { finishedBefore, positionAfter, RESTORE_REGROUP, restoredStep } from '../regroup'
import { invokeSnapshot } from './backendPerformance.setup'
import {
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  plantSubscription,
  restTasks,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'

type Fx = OrgFixture & {
  t: T
  /** an archived sub-project of TBED */
  shelf: Doc<'projects'>
  /** an active sub-project of SKNK, another top-level project */
  away: Doc<'projects'>
}

/* withOrg, with the agent holding Edit on TBED, an archived sub-project
 * SHELF of TBED and an active sub-project of SKNK. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
  })
  const shelf = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    key: 'SHELF',
    archived_at: NOW,
  })
  const away = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.hidden.id,
    key: 'AWAY',
  })
  return { t, ...f, shelf, away }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

const row = (fx: Fx, id: string) => fx.t.run((ctx) => byId(ctx, 'issues', id))

const restGet = (fx: Fx, ref: string, callerId = fx.agent.id) =>
  fx.t.query(internal.machine.rest.getIssue, { callerId, access: 'read', today: TODAY, ref })

const restPatch = (fx: Fx, ref: string, body: unknown) =>
  fx.t.mutation(internal.machine.rest.updateIssue, {
    callerId: fx.agent.id,
    access: 'write',
    keyName: 'drive',
    ref,
    body: JSON.stringify(body),
  })

const mcpGet = async (fx: Fx, ref: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await fx.t.query(internal.machine.mcp.getIssue, {
      callerId: fx.agent.id,
      access: 'read',
      today: TODAY,
      ref,
    }),
  )

/* Task numbers for plantMany, clear of the fixtures' own. */
let bulkNum = 50_000

/* `count` active tasks in `project_id`, written in one transaction. */
const plantMany = (fx: Fx, count: number, over: Partial<Doc<'issues'>> & { project_id: string }) =>
  fx.t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('issues', {
        id: uuid(),
        org_id: fx.org.id,
        num: bulkNum++,
        title: `Bulk ${i}`,
        description: '',
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        ...over,
      })
    }
  })

/* A public query's handler run inside `ctx`, so a test can read the
 * transaction's metrics after it (backendPerformance.setup invokeSnapshot). */
const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

/* REST GET /v1/projects/{ref}'s handler, to read the metrics after it. */
const getProjectHandler = (
  ctx: QueryCtx,
  args: { callerId: string; access: 'read'; ref: string },
) => handlerOf<typeof args, { completion: unknown }>(getProject)(ctx, args)

/* One regroup step's handler, to run a step inside a test's own mutation. */
const stepHandler = (
  restoredStep as unknown as {
    _handler: (ctx: MutationCtx, args: { projects: string[]; restorer_id: string }) => Promise<null>
  }
)._handler

describe('the group rule', () => {
  it('counts a subtask by both tasks and their projects', () => {
    const layer = (archived: boolean, projectLive: boolean) => ({ archived, projectLive })
    // an active parent in an active project: active subtasks in active projects only
    expect(countsAsSubtask(layer(false, true), layer(false, true))).toBe(true)
    expect(countsAsSubtask(layer(false, true), layer(false, false))).toBe(false)
    expect(countsAsSubtask(layer(false, true), layer(true, true))).toBe(false)
    // an active parent in an archived project: every active subtask
    expect(countsAsSubtask(layer(false, false), layer(false, false))).toBe(true)
    expect(countsAsSubtask(layer(false, false), layer(false, true))).toBe(true)
    expect(countsAsSubtask(layer(false, false), layer(true, false))).toBe(false)
    // an archived parent: every subtask
    expect(countsAsSubtask(layer(true, true), layer(true, false))).toBe(true)
    expect(countsAsSubtask(layer(true, false), layer(false, true))).toBe(true)

    const live = (id: string) => id === 'on'
    const rows = [
      { parent_id: 'a', archived_at: undefined, project_id: 'off' },
      { parent_id: 'b', archived_at: undefined, project_id: 'on' },
      { parent_id: 'c', archived_at: NOW, project_id: 'on' },
    ]
    const isGroup = groupTest(rows, live)
    const at = (id: string, project_id: string, archived_at?: string) => ({
      id,
      project_id,
      archived_at,
    })
    expect(isGroup(at('a', 'on'))).toBe(false)
    expect(isGroup(at('a', 'off'))).toBe(true)
    expect(isGroup(at('b', 'on'))).toBe(true)
    expect(isGroup(at('c', 'on'))).toBe(false)
    expect(isGroup(at('c', 'on', NOW))).toBe(true)
  })

  it('a task whose only subtask is in an archived sub-project is no group, on every surface', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent', status: 'todo' })
    await task(fx, { project_id: fx.shelf.id, parent_id: parent.id })
    expect(await restGet(fx, parent.id)).toMatchObject({ is_group: false, progress: null })
    expect(await mcpGet(fx, parent.id)).toMatchObject({ is_group: false })
    // a status filter keeps it, as it keeps every task without subtasks
    const todo = await fx.t.query(internal.machine.rest.listIssues, {
      callerId: fx.agent.id,
      access: 'read',
      today: TODAY,
      status: 'todo',
    })
    expect(Array.isArray(todo) && todo.map((r) => r.id)).toContain(parent.id)
    const snap = await as(fx.t, fx.admin).query(api.snapshot.forMe, {})
    expect(snap?.issues.find((i) => i.id === parent.id)?.has_hidden_subtasks).toBe(false)
    // and it takes a status, dates and hours of its own
    await restPatch(fx, parent.id, {
      status: 'progress',
      start_week: '2026-09-07',
      end_week: '2026-09-14',
      remaining_hours: 4,
    })
    expect(await row(fx, parent.id)).toMatchObject({
      status: 'progress',
      start_week: '2026-09-07',
      remaining_hours: 4,
    })
  })

  it('a hidden subtask, a subtask in an archived project and an archived tree still make groups; a stranded one does not', async () => {
    const fx = await setup()
    // the agent cannot see AWAY; the subtask is active in an active project
    const hiddenOnly = await task(fx, { title: 'Hidden only' })
    await task(fx, { project_id: fx.away.id, parent_id: hiddenOnly.id })
    // a task in an archived project counts its active subtask there
    const shelved = await task(fx, { project_id: fx.shelf.id, title: 'Shelved' })
    await task(fx, { project_id: fx.shelf.id, parent_id: shelved.id })
    // an archived task counts its archived subtask in an archived project
    const gone = await task(fx, { title: 'Gone', archived_at: NOW })
    await task(fx, { project_id: fx.shelf.id, parent_id: gone.id, archived_at: NOW })
    // a subtask whose project row is gone, as while Deleted items moves it
    const stranded = await task(fx, { title: 'Stranded' })
    await task(fx, { project_id: uuid(), parent_id: stranded.id })

    for (const [t, group] of [
      [hiddenOnly, true],
      [shelved, true],
      [gone, true],
      [stranded, false],
    ] as const) {
      expect((await restGet(fx, t.id, fx.admin.id)).is_group, t.title).toBe(group)
    }
    await restPatch(fx, stranded.id, { remaining_hours: 2 })
    expect((await row(fx, stranded.id))?.remaining_hours).toBe(2)
    await expectRefusal(
      restPatch(fx, hiddenOnly.id, { remaining_hours: 2 }),
      'bad_request',
      /^remaining_hours cannot be set on a task with subtasks/,
    )
  })
})

describe('reading only live tasks', () => {
  it('the snapshot never reads the tasks of an archived project', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent' })
    await task(fx, { parent_id: parent.id })
    await task(fx, { project_id: fx.sub2.id, start_week: '2026-09-07', end_week: '2026-09-07' })
    const read = (who: Doc<'profiles'>) =>
      as(fx.t, who).query(async (ctx) => {
        const snapshot = await invokeSnapshot(ctx)
        const { documentsRead } = await ctx.meta.getTransactionMetrics()
        return { snapshot, documents: documentsRead.used }
      })
    const before = { admin: await read(fx.admin), guest: await read(fx.guest) }
    await plantMany(fx, 400, { project_id: fx.shelf.id })
    for (const who of [fx.admin, fx.guest]) {
      const now = await read(who)
      const was = who === fx.admin ? before.admin : before.guest
      expect(now.snapshot?.issues).toEqual(was.snapshot?.issues)
      expect(now.snapshot?.orgLoad).toEqual(was.snapshot?.orgLoad)
      expect(now.documents - was.documents, who.name).toBeLessThan(5)
    }
  })

  it("a person's load reads their own tasks, and counts a task whose subtasks are archived away", async () => {
    const fx = await setup()
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-14' }
    const leaf = await task(fx, { ...plan, remaining_hours: 3 })
    // its only subtask is in the archived sub-project
    const shelvedOnly = await task(fx, { ...plan, remaining_hours: 5 })
    await task(fx, { project_id: fx.shelf.id, parent_id: shelvedOnly.id })
    // a group, and a task of the archived sub-project, carry no load
    const group = await task(fx, { ...plan, remaining_hours: 7 })
    await task(fx, { parent_id: group.id })
    await task(fx, { ...plan, project_id: fx.shelf.id, remaining_hours: 11 })
    // someone else's work, which this read never needs
    await plantMany(fx, 300, { project_id: fx.sub2.id, assignee_id: fx.admin.id })
    const { rows, documents } = await as(fx.t, fx.admin).query(async (ctx) => {
      const rows = await handlerOf<{ assignee_id: string }, { issue_id: string | null }[]>(
        assigneeLoad,
      )(ctx, { assignee_id: fx.user.id })
      return { rows, documents: (await ctx.meta.getTransactionMetrics()).documentsRead.used }
    })
    expect(rows.map((r) => r.issue_id).sort()).toEqual([leaf.id, shelvedOnly.id].sort())
    expect(documents).toBeLessThan(60)
  })

  it("a busy agent's load reads none of the Done tasks it keeps for a month", async () => {
    const fx = await setup()
    const plan = { start_week: '2026-09-07', end_week: '2026-09-14', remaining_hours: 2 }
    const open = await task(fx, { ...plan, assignee_id: fx.agent.id })
    // the agent reviews this one, which is its own work while In Review
    const reviewing = await task(fx, {
      ...plan,
      status: 'review',
      assignee_id: fx.user.id,
      reviewer_id: fx.agent.id,
    })
    // a month of an agent closing a hundred tasks a day, and reviewing more
    const done = { ...plan, status: 'done' as const, done_at: NOW }
    await plantMany(fx, 3000, { ...done, project_id: fx.sub.id, assignee_id: fx.agent.id })
    await plantMany(fx, 500, {
      ...done,
      project_id: fx.sub2.id,
      assignee_id: fx.user.id,
      reviewer_id: fx.agent.id,
    })
    const { rows, documents } = await as(fx.t, fx.admin).query(async (ctx) => {
      const rows = await handlerOf<{ assignee_id: string }, { issue_id: string | null }[]>(
        assigneeLoad,
      )(ctx, { assignee_id: fx.agent.id })
      return { rows, documents: (await ctx.meta.getTransactionMetrics()).documentsRead.used }
    })
    expect(rows.map((r) => r.issue_id).sort()).toEqual([open.id, reviewing.id].sort())
    expect(documents).toBeLessThan(60)
  })

  it('active lists and a project’s completion never read the tasks of an archived project', async () => {
    // far fewer documents than the archived project holds
    const fx = await setup(newT({ transactionLimits: { documentsRead: 400 } }))
    const group = await task(fx, { title: 'Group' })
    const kid = await task(fx, { project_id: fx.sub2.id, parent_id: group.id, status: 'done' })
    // its only subtask is in the archived sub-project, so it is no group
    const shelvedOnly = await task(fx, { title: 'Shelved only' })
    await task(fx, { project_id: fx.shelf.id, parent_id: shelvedOnly.id })
    // a parent left behind in the archived sub-project
    const stranded = await task(fx, { project_id: fx.shelf.id, title: 'Stranded parent' })
    const child = await task(fx, { parent_id: stranded.id, title: 'Child' })
    await plantMany(fx, 2000, { project_id: fx.shelf.id })
    const expected = [group.id, kid.id, shelvedOnly.id, child.id]
    const rest = await restTasks(fx.t, { callerId: fx.agent.id, access: 'read' })
    expect(rest.map((r) => r.id)).toEqual(expected)
    expect(rest.map((r) => [r.is_group, r.parent_id])).toEqual([
      [true, null],
      [false, group.id],
      [false, null],
      [false, stranded.id],
    ])
    const mcp = JSON.parse(
      await fx.t.query(internal.machine.mcp.listIssues, {
        callerId: fx.agent.id,
        access: 'read',
        today: TODAY,
        project: 'TBED',
      }),
    ) as { id: string }[]
    expect(mcp.map((r) => r.id)).toEqual(expected)
    // the group's done subtask, the leaf without a group and the child
    const completion = { done: 1, total: 3, percent: 33 }
    const project = await fx.t.query(internal.machine.rest.getProject, {
      callerId: fx.agent.id,
      access: 'read',
      ref: 'TBED',
    })
    expect(project.completion).toEqual(completion)
    const mcpProject = JSON.parse(
      await fx.t.query(internal.machine.projects.mcpGetProject, {
        callerId: fx.agent.id,
        access: 'read',
        project: 'TBED',
      }),
    ) as { completion: unknown }
    expect(mcpProject.completion).toEqual(completion)
  })

  it('a list that names an archived project still counts every active subtask of its tasks', async () => {
    const fx = await setup()
    const shelved = await task(fx, { project_id: fx.shelf.id, title: 'Shelved group' })
    await task(fx, { parent_id: shelved.id, start_week: '2026-09-07', end_week: '2026-09-07' })
    // its only subtask is in another archived project, which the active
    // projects' tasks do not hold
    const attic = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      key: 'ATTIC',
      archived_at: NOW,
    })
    const atticGroup = await task(fx, { project_id: fx.shelf.id, title: 'Attic group' })
    await task(fx, {
      project_id: attic.id,
      parent_id: atticGroup.id,
      start_week: '2026-10-05',
      end_week: '2026-10-12',
    })
    const rest = await restTasks(fx.t, { callerId: fx.agent.id, access: 'read', project: 'SHELF' })
    expect(rest.map((r) => [r.id, r.is_group, r.start_week, r.end_week])).toEqual([
      [shelved.id, true, '2026-09-07', '2026-09-07'],
      [atticGroup.id, true, '2026-10-05', '2026-10-12'],
    ])
  })

  it('a list past LIVE_PROJECT_READS answers as the per-project read does', async () => {
    const fx = await setup()
    const group = await task(fx, { title: 'Group', start_week: '2026-09-07' })
    await task(fx, {
      project_id: fx.sub2.id,
      parent_id: group.id,
      status: 'done',
      start_week: '2026-09-07',
      end_week: '2026-09-14',
    })
    const shelvedOnly = await task(fx, { title: 'Shelved only' })
    await task(fx, { project_id: fx.shelf.id, parent_id: shelvedOnly.id })
    const stranded = await task(fx, { project_id: fx.shelf.id, title: 'Stranded parent' })
    await task(fx, { parent_id: stranded.id, title: 'Child' })
    const read = async () => ({
      rest: await restTasks(fx.t, { callerId: fx.agent.id, access: 'read' }),
      mcp: await fx.t.query(internal.machine.mcp.listIssues, {
        callerId: fx.agent.id,
        access: 'read',
        today: TODAY,
        project: 'TBED',
      }),
      completion: (
        await fx.t.query(internal.machine.rest.getProject, {
          callerId: fx.agent.id,
          access: 'read',
          ref: 'TBED',
        })
      ).completion,
    })
    const perProject = await read()
    expect(perProject.rest).toHaveLength(4)
    const reads = LIVE_PROJECT_READS.reads
    LIVE_PROJECT_READS.reads = 1
    try {
      expect(await read()).toEqual(perProject)
    } finally {
      LIVE_PROJECT_READS.reads = reads
    }
  })

  it("a busy person's load finds the groups in one read past ASSIGNEE_LOAD_CHECKS", async () => {
    // 300 subtask checks would take more index ranges than the read may
    const fx = await setup(newT({ transactionLimits: { databaseQueries: 200 } }))
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-14' }
    await plantMany(fx, 300, { project_id: fx.sub.id, ...plan })
    const group = await task(fx, plan)
    await task(fx, { parent_id: group.id })
    const shelvedOnly = await task(fx, plan)
    await task(fx, { project_id: fx.shelf.id, parent_id: shelvedOnly.id })
    const checks = ASSIGNEE_LOAD_CHECKS.reads
    ASSIGNEE_LOAD_CHECKS.reads = 100
    try {
      const rows = await as(fx.t, fx.admin).query((ctx) =>
        handlerOf<{ assignee_id: string }, { issue_id: string | null }[]>(assigneeLoad)(ctx, {
          assignee_id: fx.user.id,
        }),
      )
      const ids = rows.map((r) => r.issue_id)
      expect(ids).toHaveLength(301)
      expect(ids).toContain(shelvedOnly.id)
      expect(ids).not.toContain(group.id)
    } finally {
      ASSIGNEE_LOAD_CHECKS.reads = checks
    }
  })

  it('a delay verdict’s owner load counts a task whose subtasks are archived away', async () => {
    const fx = await setup()
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-07' }
    const leaf = await task(fx, { ...plan, remaining_hours: 5, remaining_set_at: NOW })
    await task(fx, { project_id: fx.shelf.id, parent_id: leaf.id })
    // a group, and a task of the archived sub-project, carry no load
    const group = await task(fx, { ...plan, remaining_hours: 7 })
    await task(fx, { parent_id: group.id })
    await task(fx, { ...plan, project_id: fx.shelf.id, remaining_hours: 11 })
    const checks = OWNER_LOAD_CHECKS.reads
    try {
      // task by task, and past the checks in one read of the live tasks
      for (const reads of [checks, 0]) {
        OWNER_LOAD_CHECKS.reads = reads
        const spans = await fx.t.run(async (ctx) => {
          const me = (await byId(ctx, 'profiles', fx.admin.id)) as Doc<'profiles'>
          const owner = (await byId(ctx, 'profiles', fx.user.id)) as Doc<'profiles'>
          const view = await orgProjectView(ctx, me)
          return await ownerLoadSpans(ctx, me, owner, weekGrid(fx.org.week_start), view)
        })
        expect(
          spans.map((span) => span.issueUuid),
          `${reads} checks`,
        ).toEqual([leaf.id])
      }
    } finally {
      OWNER_LOAD_CHECKS.reads = checks
    }
  })

  it('the workload reads the live tasks of the organization, also when it is limited to a project', async () => {
    const fx = await setup()
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-07' }
    await task(fx, { ...plan, remaining_hours: 3 })
    await task(fx, { ...plan, project_id: fx.away.id, remaining_hours: 4 })
    // a group through a subtask stored in another top-level project, with
    // the hours it held as a leaf, as before a restore's steps clear them
    const stale = await task(fx, { ...plan, remaining_hours: 5 })
    await task(fx, { project_id: fx.away.id, parent_id: stale.id })
    await plantMany(fx, 300, { project_id: fx.shelf.id, ...plan, remaining_hours: 1 })
    await plantMany(fx, 300, { project_id: fx.away.id })
    const workload = (project: Doc<'projects'> | null) =>
      fx.t.run(async (ctx) => {
        const me = (await byId(ctx, 'profiles', fx.admin.id)) as Doc<'profiles'>
        const out = await workloadCore(ctx, me, { fromDay: '2026-09-07', weeks: 1, project })
        const hours = out.people.find((p) => p.id === fx.user.id)?.hours
        return { hours, documents: (await ctx.meta.getTransactionMetrics()).documentsRead.used }
      })
    const all = await workload(null)
    expect(all.hours).toEqual([7])
    // the group's hours count in neither, and no archived task is read
    const scoped = await workload(fx.meta)
    expect(scoped.hours).toEqual([3])
    for (const read of [all, scoped]) expect(read.documents).toBeLessThan(400)
  })

  it('the load, workload and snapshot reads past LIVE_PROJECT_READS read the active tasks in one range', async () => {
    const fx = await setup()
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-07' }
    const leaf = await task(fx, { ...plan, remaining_hours: 3, remaining_set_at: NOW })
    const group = await task(fx, { ...plan, remaining_hours: 5 })
    await task(fx, { project_id: fx.away.id, parent_id: group.id })
    const shelvedOnly = await task(fx, { ...plan, remaining_hours: 2 })
    await task(fx, { project_id: fx.shelf.id, parent_id: shelvedOnly.id })
    await task(fx, { ...plan, project_id: fx.shelf.id, remaining_hours: 11 })
    // forty more active projects, each one more range per project read
    for (let i = 0; i < 40; i++) {
      await plantProject(fx.t, { org_id: fx.org.id, type: 'project', parent_id: fx.meta.id })
    }
    const read = () =>
      as(fx.t, fx.admin).query(async (ctx) => {
        const me = (await byId(ctx, 'profiles', fx.admin.id)) as Doc<'profiles'>
        const owner = (await byId(ctx, 'profiles', fx.user.id)) as Doc<'profiles'>
        const ranges = async <R>(run: () => Promise<R>) => {
          const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
          const out = await run()
          return {
            out,
            ranges: (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before,
          }
        }
        const view = await orgProjectView(ctx, me)
        return {
          workload: await ranges(() =>
            workloadCore(ctx, me, { fromDay: '2026-09-07', weeks: 1, project: null }),
          ),
          assignee: await ranges(() =>
            handlerOf<{ assignee_id: string }, unknown[]>(assigneeLoad)(ctx, {
              assignee_id: fx.user.id,
            }),
          ),
          owner: await ranges(() =>
            ownerLoadSpans(ctx, me, owner, weekGrid(fx.org.week_start), view),
          ),
          // the same answer at another moment
          snapshot: await ranges(async () => ({
            ...(await invokeSnapshot(ctx)),
            delivered_at: '',
          })),
        }
      })
    const reads = LIVE_PROJECT_READS.reads
    const checks = { owner: OWNER_LOAD_CHECKS.reads, assignee: ASSIGNEE_LOAD_CHECKS.reads }
    // past the checks, the two load reads take the organization's live tasks
    OWNER_LOAD_CHECKS.reads = 0
    ASSIGNEE_LOAD_CHECKS.reads = 0
    try {
      const perProject = await read()
      LIVE_PROJECT_READS.reads = 1
      const oneRange = await read()
      for (const key of ['workload', 'assignee', 'owner', 'snapshot'] as const) {
        expect(oneRange[key].out, key).toEqual(perProject[key].out)
        expect(oneRange[key].ranges, key).toBeLessThan(perProject[key].ranges - 40)
      }
      expect(oneRange.owner.out.map((span) => span.issueUuid)).toEqual([leaf.id, shelvedOnly.id])
    } finally {
      LIVE_PROJECT_READS.reads = reads
      OWNER_LOAD_CHECKS.reads = checks.owner
      ASSIGNEE_LOAD_CHECKS.reads = checks.assignee
    }
  })
})

describe("a project's completion", () => {
  it("reads only its family's tasks, and a subtask stored in another family changes only the counts", async () => {
    const fx = await setup()
    const group = await task(fx, { title: 'Group' })
    await task(fx, { project_id: fx.sub2.id, parent_id: group.id, status: 'done' })
    await task(fx, { title: 'Leaf' })
    // a subtask in another top-level project, as before the family rule
    const legacy = await task(fx, { title: 'Legacy parent' })
    await task(fx, { project_id: fx.away.id, parent_id: legacy.id })
    // another family's tasks, which the completion never needs
    await plantMany(fx, 300, { project_id: fx.away.id })
    const read = (ref: string) =>
      as(fx.t, fx.admin).query(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        const out = await getProjectHandler(ctx, { callerId: fx.admin.id, access: 'read', ref })
        const documents = (await ctx.meta.getTransactionMetrics()).documentsRead.used - before
        return { completion: out.completion, documents }
      })
    const tbed = await read('TBED')
    // Group's done subtask, Leaf and Legacy parent counted as a task without
    // subtasks, since its subtask in SKNK is not read
    expect(tbed.completion).toEqual({ done: 1, total: 3, percent: 33 })
    expect(tbed.documents).toBeLessThan(150)
    expect((await read('FW')).completion).toEqual({ done: 0, total: 2, percent: 0 })
  })
})

describe('checking access in a read without the list flags', () => {
  it('answers a group spread over many projects the same, one project at a time or all at once', async () => {
    const fx = await setup()
    const group = await task(fx, { title: 'Wide group' })
    const kids: string[] = []
    // twenty sub-projects the agent reads through TBED, and four of SKNK it
    // cannot read, as a subtask stored before the family rule could be
    for (let i = 0; i < 24; i++) {
      const project = await plantProject(fx.t, {
        org_id: fx.org.id,
        type: 'project',
        parent_id: i < 20 ? fx.meta.id : fx.hidden.id,
      })
      const kid = await task(fx, {
        project_id: project.id,
        parent_id: group.id,
        status: i % 4 === 0 ? 'done' : 'todo',
      })
      kids.push(kid.id)
    }
    const read = () =>
      fx.t.run(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
        const me = (await byId(ctx, 'profiles', fx.agent.id)) as Doc<'profiles'>
        const issue = (await byId(ctx, 'issues', group.id)) as Doc<'issues'>
        const out = await taskOut(ctx, issue, { surface: 'rest', me, today: TODAY })
        const ranges = (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before
        return { out, ranges }
      })
    const checks = ACCESS_POINT_CHECKS.checks
    try {
      ACCESS_POINT_CHECKS.checks = 1000
      const oneByOne = await read()
      ACCESS_POINT_CHECKS.checks = checks
      const batched = await read()
      expect(batched.out).toEqual(oneByOne.out)
      expect(batched.out.progress).toEqual({ done: 5, total: 20, percent: 25, partial: true })
      expect(batched.out.subtasks.map((t) => t.id).sort()).toEqual(kids.slice(0, 20).sort())
      expect(batched.ranges).toBeLessThan(oneByOne.ranges - 8)
    } finally {
      ACCESS_POINT_CHECKS.checks = checks
    }
  })
})

describe('writes that change which subtasks count', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    Object.assign(RESTORE_REGROUP, { tasks: 200, bytes: 4 * 1024 * 1024, clears: 50, room: 0.5 })
  })

  const runSteps = (t: T) => t.finishAllScheduledFunctions(() => vi.runAllTimers())
  // what `who`, who follows the task, reads about it, and from whom
  const details = async (fx: Fx, id: string, who = fx.admin) =>
    (await messagesFor(fx.t, who.id, id)).map((m) => [m.detail, m.actor_id ?? null])

  it('restoring a sub-project clears the own hours of the parents it makes groups again', async () => {
    const fx = await setup()
    const own = { remaining_hours: 5, remaining_set_at: NOW }
    // a leaf while its only subtask is archived away
    const parent = await task(fx, { title: 'Parent', ...own })
    await plantSubscription(fx.t, { issue_id: parent.id, profile_id: fx.admin.id })
    // a group restored with SHELF, holding hours it took before as a leaf
    const inside = await task(fx, { project_id: fx.shelf.id, title: 'Inside', ...own })
    // an archived parent, and one in another archived sub-project
    const archived = await task(fx, { title: 'Archived', archived_at: NOW, ...own })
    const other = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      archived_at: NOW,
    })
    const elsewhere = await task(fx, { project_id: other.id, title: 'Elsewhere', ...own })
    for (const p of [parent, parent, inside, archived, elsewhere]) {
      await task(fx, { project_id: fx.shelf.id, parent_id: p.id })
    }
    // a page of two tasks spreads the walk over three steps
    RESTORE_REGROUP.tasks = 2
    await as(fx.t, fx.user).mutation(api.projects.unarchive, { org_id: fx.org.id, id: fx.shelf.id })
    await runSteps(fx.t)
    expect((await row(fx, parent.id))?.remaining_hours).toBeUndefined()
    expect((await row(fx, parent.id))?.remaining_set_at).toBeUndefined()
    expect(await details(fx, parent.id)).toEqual([['Remaining cleared (was 5 h)', fx.user.id]])
    expect((await row(fx, inside.id))?.remaining_hours).toBeUndefined()
    for (const kept of [archived, elsewhere]) {
      expect((await row(fx, kept.id))?.remaining_hours, kept.title).toBe(5)
    }
    const steps = await fx.t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name === 'regroup:restoredStep',
      ),
    )
    expect(steps).toHaveLength(3)
  })

  it('restoring a top-level project walks it and each restored sub-project, also when the restorer is gone', async () => {
    const fx = await setup()
    // a subtask stored before a subtask had to stay in its parent's project
    const parent = await task(fx, { project_id: fx.away.id, remaining_hours: 6, title: 'Away' })
    await plantSubscription(fx.t, { issue_id: parent.id, profile_id: fx.admin.id })
    await task(fx, { project_id: fx.sub2.id, parent_id: parent.id })
    // and one stored under the top-level project itself, as older code could
    const second = await task(fx, { project_id: fx.away.id, remaining_hours: 2, title: 'Away 2' })
    await task(fx, { project_id: fx.meta.id, parent_id: second.id })
    await as(fx.t, fx.user).mutation(api.projects.archive, { org_id: fx.org.id, id: fx.meta.id })
    expect((await restGet(fx, parent.id, fx.admin.id)).is_group).toBe(false)
    await as(fx.t, fx.user).mutation(api.projects.unarchive, { org_id: fx.org.id, id: fx.meta.id })
    // the restorer's profile goes before the steps run
    await fx.t.run(async (ctx) => {
      const user = await byId(ctx, 'profiles', fx.user.id)
      if (user !== null) await ctx.db.delete(user._id)
    })
    await runSteps(fx.t)
    expect((await row(fx, parent.id))?.remaining_hours).toBeUndefined()
    expect(await details(fx, parent.id)).toEqual([['Remaining cleared (was 6 h)', null]])
    expect((await row(fx, second.id))?.remaining_hours).toBeUndefined()
  })

  it('restoring a task’s sub-project after its subtask’s clears the hours it took as a leaf', async () => {
    const fx = await setup()
    // a leaf while its only subtask is archived away, so it takes hours
    const parent = await task(fx, { title: 'Parent' })
    await task(fx, { project_id: fx.shelf.id, parent_id: parent.id })
    await restPatch(fx, parent.id, { remaining_hours: 5 })
    // archiving FW makes it a group, which counts its subtask in SHELF
    await as(fx.t, fx.user).mutation(api.projects.archive, { org_id: fx.org.id, id: fx.sub.id })
    for (const id of [fx.shelf.id, fx.sub.id]) {
      await as(fx.t, fx.user).mutation(api.projects.unarchive, { org_id: fx.org.id, id })
      await runSteps(fx.t)
    }
    expect(await restGet(fx, parent.id)).toMatchObject({ is_group: true, remaining_hours: null })
  })

  it('a regroup step reads the profiles once and stops after its share of clears', async () => {
    const fx = await setup()
    for (let i = 0; i < 40; i++) await plantSeat(fx.t, { org_id: fx.org.id, name: `Seat ${i}` })
    const parents: Doc<'issues'>[] = []
    for (let i = 0; i < 6; i++) {
      const parent = await task(fx, { title: `Parent ${i}`, remaining_hours: 2 })
      for (const who of [fx.admin, fx.viewer]) {
        await plantSubscription(fx.t, { issue_id: parent.id, profile_id: who.id })
      }
      await task(fx, { project_id: fx.shelf.id, parent_id: parent.id })
      parents.push(parent)
    }
    RESTORE_REGROUP.clears = 4
    await as(fx.t, fx.user).mutation(api.projects.unarchive, { org_id: fx.org.id, id: fx.shelf.id })
    // the first step alone, in place of the one the restore scheduled
    const first = await fx.t.mutation(async (ctx) => {
      for (const job of await ctx.db.system.query('_scheduled_functions').collect()) {
        if (job.state.kind === 'pending') await ctx.scheduler.cancel(job._id)
      }
      const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
      await stepHandler(ctx, { projects: [fx.shelf.id], restorer_id: fx.user.id })
      const read = (await ctx.meta.getTransactionMetrics()).documentsRead.used - before
      const jobs = await ctx.db.system.query('_scheduled_functions').collect()
      const next = jobs.filter((job) => job.state.kind === 'pending').map((job) => job.args[0])
      return { read, next }
    })
    const cleared = async () => {
      const rows = await Promise.all(parents.map((p) => row(fx, p.id)))
      return rows.filter((r) => r?.remaining_hours === undefined).length
    }
    expect(await cleared()).toBe(4)
    // the next step reads the same page from the task after the fourth
    expect(first.next).toEqual([
      {
        projects: [fx.shelf.id],
        restorer_id: fx.user.id,
        after: { time: expect.any(Number), ids: [expect.any(String)] },
      },
    ])
    // 47 profiles, read once, not for each of the 4 tasks it cleared
    expect(first.read).toBeLessThan(120)
    await runSteps(fx.t)
    expect(await cleared()).toBe(6)
    expect(await details(fx, parents[5].id)).toEqual([['Remaining cleared (was 2 h)', fx.user.id]])
  })

  it('a regroup step stops reading once it is full and the next one starts after the last task it finished', async () => {
    const fx = await setup()
    const other = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      archived_at: NOW,
    })
    // two leaves whose subtasks stay archived away, and a group
    const leaves = [await task(fx, { project_id: fx.shelf.id, remaining_hours: 3 })]
    leaves.push(await task(fx, { project_id: fx.shelf.id, remaining_hours: 3 }))
    for (const leaf of leaves) {
      for (let i = 0; i < 2; i++) await task(fx, { project_id: other.id, parent_id: leaf.id })
    }
    const group = await task(fx, { project_id: fx.shelf.id, remaining_hours: 3 })
    await task(fx, { project_id: fx.sub2.id, parent_id: group.id })
    // full after the first task of each step
    RESTORE_REGROUP.room = 0
    await as(fx.t, fx.user).mutation(api.projects.unarchive, { org_id: fx.org.id, id: fx.shelf.id })
    await runSteps(fx.t)
    expect((await row(fx, group.id))?.remaining_hours).toBeUndefined()
    for (const leaf of leaves) expect((await row(fx, leaf.id))?.remaining_hours).toBe(3)
    const steps = await fx.t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name === 'regroup:restoredStep',
      ),
    )
    expect(steps).toHaveLength(3)
  })

  it('a stopped regroup step resumes at a task that shares the last creation time', () => {
    const at = (time: number, id: string) => ({ _creationTime: time, id })
    const [a, b, c, d] = [at(1, 'a'), at(2, 'b'), at(2, 'c'), at(3, 'd')]
    // stopped after b, which shares its creation time with c
    const stop = positionAfter(positionAfter(undefined, a), b)
    expect(stop).toEqual({ time: 2, ids: ['b'] })
    expect([a, b, c, d].map((t) => finishedBefore(t, stop))).toEqual([true, true, false, false])
    // the next step finishes c and still counts b as finished
    const next = positionAfter(stop, c)
    expect(next).toEqual({ time: 2, ids: ['b', 'c'] })
    expect([a, b, c, d].map((t) => finishedBefore(t, next))).toEqual([true, true, true, false])
  })

  it('a task moved out of an archived project clears its parent’s own hours', async () => {
    const fx = await setup()
    const parent = await task(fx, { remaining_hours: 4, remaining_set_at: NOW })
    await plantSubscription(fx.t, { issue_id: parent.id, profile_id: fx.user.id })
    const child = await task(fx, { project_id: fx.shelf.id, parent_id: parent.id })
    await as(fx.t, fx.admin).mutation(api.issues.move, {
      org_id: fx.org.id,
      id: child.id,
      project_id: fx.sub2.id,
    })
    expect((await row(fx, parent.id))?.remaining_hours).toBeUndefined()
    expect(await details(fx, parent.id, fx.user)).toEqual([
      ['Remaining cleared (was 4 h)', fx.admin.id],
    ])
    // a REST update that names the parent the task already has
    const second = await task(fx, { remaining_hours: 4, remaining_set_at: NOW })
    const kid = await task(fx, { project_id: fx.shelf.id, parent_id: second.id })
    await restPatch(fx, kid.id, { project: fx.sub2.id, parent: second.id })
    expect(await row(fx, kid.id)).toMatchObject({ project_id: fx.sub2.id, parent_id: second.id })
    expect((await row(fx, second.id))?.remaining_hours).toBeUndefined()
  })

  it('a subtask carried out of an archived project makes the moved task a group in the same write', async () => {
    const fx = await setup()
    // In Review with a hand-off, which a group cannot keep
    const root = await task(fx, {
      title: 'Root',
      status: 'review',
      review_at: NOW,
      remaining_hours: 6,
      remaining_set_at: NOW,
    })
    const child = await task(fx, { project_id: fx.shelf.id, parent_id: root.id })
    await as(fx.t, fx.admin).mutation(api.issues.move, {
      org_id: fx.org.id,
      id: root.id,
      project_id: fx.away.id,
    })
    expect((await row(fx, child.id))?.project_id).toBe(fx.away.id)
    const after = await row(fx, root.id)
    expect(after).toMatchObject({ project_id: fx.away.id })
    expect(after?.remaining_hours).toBeUndefined()
    // the move restarts no measurement for hours that go with it
    expect(after && ('review_at' in after || 'remaining_set_at' in after)).toBe(false)
    expect((await restGet(fx, root.id, fx.admin.id)).is_group).toBe(true)
  })

  it('a move checks the reviewer by whether the task is a group once it lands', async () => {
    const fx = await setup()
    // Rita edits FW only
    const rita = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Rita' })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: fx.sub.id,
        profile_id: rita.id,
        level: 'user',
      })
    })
    // its only subtask is archived away, so its reviewer is its own
    const reviewed = await task(fx, { status: 'review', reviewer_id: rita.id })
    await task(fx, { project_id: fx.shelf.id, parent_id: reviewed.id })
    await expectRefusal(
      as(fx.t, fx.admin).mutation(api.issues.move, {
        org_id: fx.org.id,
        id: reviewed.id,
        project_id: fx.sub2.id,
      }),
      'rule',
      new RegExp(`^${REVIEWER_RULE}$`),
    )
    expect(await row(fx, reviewed.id)).toMatchObject({
      project_id: fx.sub.id,
      reviewer_id: rita.id,
    })
  })

  it('a move reads its carried subtasks as groups or leaves by where they land', async () => {
    const fx = await setup()
    // Rita edits FW and cannot see SKNK; Vic edits FW and only views SKNK
    const rita = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Rita' })
    const vic = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Vic' })
    await fx.t.run(async (ctx) => {
      for (const [project_id, profile_id, level] of [
        [fx.sub.id, rita.id, 'user'],
        [fx.sub.id, vic.id, 'user'],
        [fx.hidden.id, vic.id, 'viewer'],
      ] as const) {
        await ctx.db.insert('project_access', { project_id, profile_id, level })
      }
    })
    const move = (id: string) =>
      as(fx.t, fx.admin).mutation(api.issues.move, {
        org_id: fx.org.id,
        id,
        project_id: fx.away.id,
      })
    // a leaf while its only subtask is archived away, so Rita reviews it.
    // The subtask comes along to AWAY, where the task lands a group, so her
    // review is dormant and goes, as she cannot see AWAY.
    const root = await task(fx, { title: 'Root' })
    const mid = await task(fx, { title: 'Mid', parent_id: root.id, reviewer_id: rita.id })
    await task(fx, { project_id: fx.shelf.id, parent_id: mid.id })
    await move(root.id)
    expect(await row(fx, mid.id)).toMatchObject({ project_id: fx.away.id })
    expect((await row(fx, mid.id))?.reviewer_id).toBeUndefined()
    // a subtask stored in an archived sub-project of SKNK stays there, so
    // the task lands a leaf and Vic, who cannot edit AWAY, blocks the move
    const closed = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.hidden.id,
      archived_at: NOW,
    })
    const root2 = await task(fx, { title: 'Root 2' })
    const mid2 = await task(fx, { title: 'Mid 2', parent_id: root2.id, reviewer_id: vic.id })
    await task(fx, { project_id: closed.id, parent_id: mid2.id })
    await expectRefusal(move(root2.id), 'rule', new RegExp(`^${MOVE_SUBTREE_HOLDER_RULE}$`))
    expect(await row(fx, mid2.id)).toMatchObject({ project_id: fx.sub.id, reviewer_id: vic.id })
  })

  it('restoring or attaching a task in an archived project leaves a parent in an active one its own hours', async () => {
    const fx = await setup()
    const own = { remaining_hours: 3, remaining_set_at: NOW }
    const parent = await task(fx, { title: 'Parent', ...own })
    const child = await task(fx, {
      project_id: fx.shelf.id,
      parent_id: parent.id,
      archived_at: NOW,
    })
    // an archived parent comes back with its archived child, keeping its hours
    const archivedParent = await task(fx, { title: 'Archived parent', archived_at: NOW, ...own })
    const underArchived = await task(fx, {
      project_id: fx.shelf.id,
      parent_id: archivedParent.id,
      archived_at: NOW,
    })
    for (const id of [child.id, underArchived.id]) {
      await as(fx.t, fx.admin).mutation(api.issues.unarchive, { org_id: fx.org.id, id })
    }
    expect((await row(fx, parent.id))?.remaining_hours).toBe(3)
    expect(await row(fx, archivedParent.id)).toMatchObject({ remaining_hours: 3 })
    expect((await row(fx, archivedParent.id))?.archived_at).toBeUndefined()
    // an attach inside the archived sub-project leaves the parent's hours too
    const loose = await task(fx, { project_id: fx.shelf.id })
    const second = await task(fx, { title: 'Second', ...own })
    await as(fx.t, fx.admin).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: loose.id,
      patch: { parent_id: second.id },
    })
    expect(await row(fx, loose.id)).toMatchObject({ parent_id: second.id })
    expect((await row(fx, second.id))?.remaining_hours).toBe(3)
  })
})
