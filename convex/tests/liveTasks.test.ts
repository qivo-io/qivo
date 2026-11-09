/* The live layer group rule (lib/liveTasks.ts countsAsSubtask): a task in
 * an active project is a group only through active subtasks in active
 * projects, on every surface, the lists never read the tasks of an
 * archived project, and the workload reads no task its people do not own.
 * The writes that make a subtask count again (a project restore, a move
 * out of an archived project, a carried subtask) clear the parent's own
 * hours, and those that leave it uncounted (a task restore or an attach
 * inside an archived project) do not. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { accessOf } from '../lib/access'
import { ACTIVE_PAGE } from '../lib/activeTaskPage'
import { COMPLETION_RESERVE, taskOut } from '../lib/core'
import { byId } from '../lib/db'
import { countsAsSubtask } from '../lib/liveTasks'
import { callRoom, loadRowsOf, OWNER_LOADS, ownerLoadReader } from '../lib/ownerLoads'
import { getProject } from '../machine/rest'
import { MOVE_SUBTREE_HOLDER_RULE, REVIEWER_RULE } from '../model/issues'
import { assigneeLoad, LOAD_UNAVAILABLE, workloadPage } from '../planning'
import { finishedBefore, positionAfter, RESTORE_REGROUP, restoredStep } from '../regroup'
import { boardFor, NO_FILTERS, projectScope } from './board.setup'
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
  withReadingAdmin,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import { countOrg } from './overviewCounts.setup'
import { lowered, mcpPage, restPage } from './taskPages.setup'

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
  const f = await withReadingAdmin(t)
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
 * transaction's metrics after it. */
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
  })

  it('a task whose only subtask is in an archived sub-project is no group, on every surface', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent', status: 'todo' })
    await task(fx, { project_id: fx.shelf.id, parent_id: parent.id })
    expect(await restGet(fx, parent.id)).toMatchObject({ is_group: false, progress: null })
    expect(await mcpGet(fx, parent.id)).toMatchObject({ is_group: false })
    // a status filter keeps it, as it keeps every task without subtasks
    const todo = await restTasks(fx.t, { callerId: fx.agent.id, access: 'read', status: 'todo' })
    expect(todo.map((r) => r.id)).toContain(parent.id)
    // the task window, the app's read of one task, shows no group either
    const window = await as(fx.t, fx.admin).query(api.taskWindow.task, {
      org_id: fx.org.id,
      ref: parent.id,
    })
    if (window.state !== 'ok') throw new Error(window.state)
    expect(window.task).toMatchObject({ has_subtasks: false, has_hidden_subtasks: false })
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
  it('the Board never sends the tasks of an archived sub-project, and its answer stays as they grow', async () => {
    const fx = await setup()
    const parent = await task(fx, { title: 'Parent' })
    await task(fx, { parent_id: parent.id })
    const shelved = await task(fx, { project_id: fx.shelf.id, title: 'On the shelf' })
    // the Board of the top-level project that holds the archived sub-project
    const read = async (who: Doc<'profiles'>) => {
      const answer = await boardFor(fx.t, who, projectScope(who, fx.meta.id), NO_FILTERS)
      if (answer.state !== 'ok') throw new Error(`${who.name}: ${answer.state}`)
      return answer
    }
    const before = { admin: await read(fx.admin), user: await read(fx.user) }
    for (const answer of Object.values(before)) {
      expect(answer.rows.map((r) => r.id)).toContain(parent.id)
      expect(JSON.stringify(answer)).not.toContain(shelved.id)
      expect(answer.held_projects).not.toContain(fx.shelf.id)
    }
    await plantMany(fx, 400, { project_id: fx.shelf.id })
    expect(await read(fx.admin)).toEqual(before.admin)
    expect(await read(fx.user)).toEqual(before.user)
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
    // the organization is counted, as on a deployment, before the archived
    // sub-project's tasks, which no live figure counts, are planted past
    // the counts
    await countOrg(fx.t, fx.org.id)
    await plantMany(fx, 2000, { project_id: fx.shelf.id })
    const expected = [group.id, kid.id, shelvedOnly.id, child.id]
    // a page budget that fits this request's 400 documents, which the
    // archived project's tasks would pass
    const page = {
      page: { documents: 200, delays: { ...ACTIVE_PAGE.delays, documents: 30 } },
      reserve: { documents: 32 },
    }
    await lowered(page, async () => {
      const rest = await restPage(fx.t, { callerId: fx.agent.id, access: 'read' })
      expect(rest.tasks.map((r) => r.id)).toEqual(expected)
      expect(rest.next_cursor).toBeNull()
      expect(rest.tasks.map((r) => [r.is_group, r.parent_id])).toEqual([
        [true, null],
        [false, group.id],
        [false, null],
        [false, stranded.id],
      ])
      const mcp = await mcpPage(fx.t, { callerId: fx.agent.id, access: 'read', project: 'TBED' })
      expect(mcp.tasks.map((r) => r.id)).toEqual(expected)
      expect(mcp.next_cursor).toBeNull()
    })
    // the group's done subtask, the leaf without a group and the child,
    // from the counts, which read no task, with what the project's detail
    // keeps back lowered to fit this request's 400 documents
    const reserve = structuredClone(COMPLETION_RESERVE)
    Object.assign(COMPLETION_RESERVE, { documents: 64 })
    try {
      const completion = { status: 'ok', done: 1, total: 3, percent: 33 }
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
    } finally {
      Object.assign(COMPLETION_RESERVE, reserve)
    }
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

  it("a busy person's load past the subtask checks is unavailable, read in few ranges", async () => {
    // 300 subtask checks would take more index ranges than the read may
    const fx = await setup(newT({ transactionLimits: { databaseQueries: 200 } }))
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-14' }
    await plantMany(fx, 299, { project_id: fx.sub.id, ...plan })
    const group = await task(fx, plan)
    await task(fx, { parent_id: group.id })
    // a leaf whose only subtask is archived away is one of them
    const shelvedOnly = await task(fx, plan)
    await task(fx, { project_id: fx.shelf.id, parent_id: shelvedOnly.id })
    const load = () =>
      as(fx.t, fx.admin).query((ctx) =>
        handlerOf<{ assignee_id: string }, { issue_id: string | null }[]>(assigneeLoad)(ctx, {
          assignee_id: fx.user.id,
        }),
      )
    const bounds = structuredClone(OWNER_LOADS)
    OWNER_LOADS.checks = 300
    try {
      // 301 tasks to check, one past the bound: no fewer rows and no empty
      // list, and none of the 301 checks is read
      const refused = await expectRefusal(load(), 'rule')
      expect((refused.data as { reason?: string }).reason).toBe(LOAD_UNAVAILABLE)
    } finally {
      Object.assign(OWNER_LOADS, bounds)
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
    const rows = await fx.t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', fx.admin.id)) as Doc<'profiles'>
      const access = accessOf(ctx, me)
      const load = await ownerLoadReader(ctx, { me, access, room: callRoom }).read(fx.user.id)
      if (load.state !== 'ok') throw new Error(`the load is ${load.state}`)
      return loadRowsOf(me, load.tasks)
    })
    expect(rows.map((row) => row.issue_id)).toEqual([leaf.id])
  })

  it("the workload reads each person's own open tasks, not the organization's, also when it is limited to a project", async () => {
    const fx = await setup()
    await keyOrg(fx.t, fx.org.id)
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-07' }
    await task(fx, { ...plan, remaining_hours: 3 })
    await task(fx, { ...plan, project_id: fx.away.id, remaining_hours: 4 })
    // a group through a subtask stored in another top-level project, with
    // the hours it held as a leaf, as before a restore's steps clear them
    const stale = await task(fx, { ...plan, remaining_hours: 5 })
    await task(fx, { project_id: fx.away.id, parent_id: stale.id })
    // open work in an archived sub-project carries no load
    await plantMany(fx, 30, { project_id: fx.shelf.id, ...plan, remaining_hours: 1 })
    const workload = (project: Doc<'projects'> | null) =>
      fx.t.run(async (ctx) => {
        const me = (await byId(ctx, 'profiles', fx.admin.id)) as Doc<'profiles'>
        const out = await workloadPage(ctx, me, {
          fromDay: '2026-09-07',
          weeks: 1,
          project,
          limit: 50,
          cursor: null,
        })
        const user = out.people.find((p) => p.id === fx.user.id)
        return {
          hours: user?.hours,
          documents: (await ctx.meta.getTransactionMetrics()).documentsRead.used,
        }
      })
    const all = await workload(null)
    expect(all.hours).toEqual([7])
    // the group's hours count in neither
    const scoped = await workload(fx.meta)
    expect(scoped.hours).toEqual([3])
    // tasks nobody on the page owns are never read
    await plantMany(fx, 30, { project_id: fx.away.id })
    await plantMany(fx, 30, { project_id: fx.sub.id, status: 'done' })
    expect(await workload(null)).toEqual(all)
    expect(await workload(fx.meta)).toEqual(scoped)
  })
})

describe("a project's completion", () => {
  it('reads no task, and a subtask in another top-level project makes its parent a group, as in the Overview', async () => {
    const fx = await setup()
    const group = await task(fx, { title: 'Group' })
    await task(fx, { project_id: fx.sub2.id, parent_id: group.id, status: 'done' })
    await task(fx, { title: 'Leaf' })
    // a subtask in another top-level project, as before the family rule
    const legacy = await task(fx, { title: 'Legacy parent' })
    await task(fx, { project_id: fx.away.id, parent_id: legacy.id })
    await countOrg(fx.t, fx.org.id)
    const read = (ref: string) =>
      as(fx.t, fx.admin).query(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        const out = await getProjectHandler(ctx, { callerId: fx.admin.id, access: 'read', ref })
        const documents = (await ctx.meta.getTransactionMetrics()).documentsRead.used - before
        return { completion: out.completion, documents }
      })
    const tbed = await read('TBED')
    // Group's done subtask and Leaf count. Legacy parent is a group, as its
    // subtask in SKNK is active in a live project, by the stored rule of the
    // counts, the app's P.isGroup and the Overview's, where the bounded read
    // of the family's tasks before the counts counted it as a leaf
    expect(tbed.completion).toEqual({ status: 'ok', done: 1, total: 2, percent: 50 })
    expect(tbed.documents).toBeLessThan(150)
    expect((await read('FW')).completion).toEqual({
      status: 'ok',
      done: 0,
      total: 1,
      percent: 0,
    })
    // more tasks in the family and in another family are never read
    await plantMany(fx, 30, { project_id: fx.sub2.id })
    await plantMany(fx, 30, { project_id: fx.away.id })
    expect((await read('TBED')).documents).toBe(tbed.documents)
  })
})

describe('checking access in the single-task read', () => {
  it('answers a group whose subtasks spread over many projects from the projects the caller reads', async () => {
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
    // the single-task read asks about the projects its subtree names, one
    // at a time through one accessOf instance, and answers only the 20 the
    // agent reads (the REST and MCP Inbox's bulk change asks the same way,
    // machineInbox.test.ts)
    const out = await fx.t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', fx.agent.id)) as Doc<'profiles'>
      const issue = (await byId(ctx, 'issues', group.id)) as Doc<'issues'>
      return await taskOut(ctx, issue, { surface: 'rest', me, today: TODAY })
    })
    expect(out.progress).toEqual({ done: 5, total: 20, percent: 25, partial: true })
    expect(out.subtasks.map((t) => t.id).sort()).toEqual(kids.slice(0, 20).sort())
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
    // the measurement and hand-off go with the hours
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

  it('a move reads its carried subtasks as leaves wherever they land', async () => {
    const fx = await setup()
    // Rita edits FW and cannot see SKNK
    const rita = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Rita' })
    await fx.t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: fx.sub.id,
        profile_id: rita.id,
        level: 'user',
      }),
    )
    // a subtask has no subtasks of its own, so its review is never a group's
    // dormant one: Rita, who cannot see AWAY, blocks the move rather than
    // losing the review
    const root = await task(fx, { title: 'Root' })
    const kid = await task(fx, { title: 'Kid', parent_id: root.id, reviewer_id: rita.id })
    await expectRefusal(
      as(fx.t, fx.admin).mutation(api.issues.move, {
        org_id: fx.org.id,
        id: root.id,
        project_id: fx.away.id,
      }),
      'rule',
      new RegExp(`^${MOVE_SUBTREE_HOLDER_RULE}$`),
    )
    expect(await row(fx, kid.id)).toMatchObject({ project_id: fx.sub.id, reviewer_id: rita.id })
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
