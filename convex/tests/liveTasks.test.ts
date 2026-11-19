/* The group rule (lib/liveTasks.ts countsAsSubtask): a task is a group
 * through its subtasks, which share its sub-project, on every surface,
 * whether that project is archived or not; the lists never read the tasks
 * of an archived project, and the workload reads no task its people do not
 * own. A project restore changes no task's group, and the restore's old
 * regroup step ends doing nothing. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { accessOf } from '../lib/access'
import { ACTIVE_PAGE } from '../lib/activeTaskPage'
import { COMPLETION_RESERVE } from '../lib/core'
import { byId } from '../lib/db'
import { countsAsSubtask } from '../lib/liveTasks'
import { callRoom, loadRowsOf, OWNER_LOADS, ownerLoadReader } from '../lib/ownerLoads'
import { issueKey } from '../lib/taskRefs'
import { getProject } from '../machine/rest'
import { moveSubtreeHolderRule, REVIEWER_RULE } from '../model/issues'
import { finishedBefore, positionAfter } from '../overviewRegroup'
import { assigneeLoad, LOAD_UNAVAILABLE, workloadPage } from '../planning'
import { restoredStep } from '../regroup'
import { boardFor, NO_FILTERS, projectScope } from './board.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
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

/* The old regroup step's handler, to run it inside a test's own mutation. */
const stepHandler = (
  restoredStep as unknown as {
    _handler: (ctx: MutationCtx, args: { projects: string[]; restorer_id: string }) => Promise<null>
  }
)._handler

describe('the group rule', () => {
  it('counts a subtask by both tasks', () => {
    const at = (id: string, over: Partial<Doc<'issues'>> = {}) => ({
      id,
      org_id: 'o',
      project_id: 'p',
      archived_at: undefined,
      parent_id: undefined as string | undefined,
      ...over,
    })
    const parent = at('a')
    const kid = (over: Partial<Doc<'issues'>> = {}) => at('k', { parent_id: 'a', ...over })
    // an active parent: an active subtask
    expect(countsAsSubtask(parent, kid())).toBe(true)
    expect(countsAsSubtask(parent, kid({ archived_at: NOW }))).toBe(false)
    // an archived parent: every subtask
    const archived = at('a', { archived_at: NOW })
    expect(countsAsSubtask(archived, kid({ archived_at: NOW }))).toBe(true)
    expect(countsAsSubtask(archived, kid())).toBe(true)
    // only its own subtask, in its own sub-project (lib/liveTasks.ts liveLink)
    expect(countsAsSubtask(parent, kid({ parent_id: 'b' }))).toBe(false)
    expect(countsAsSubtask(parent, kid({ project_id: 'elsewhere' }))).toBe(false)
  })

  it('a subtask makes a group in an active or an archived project, and an archived tree stays one', async () => {
    const fx = await setup()
    // a task in an archived project counts its active subtask there
    const shelved = await task(fx, { project_id: fx.shelf.id, title: 'Shelved' })
    await task(fx, { project_id: fx.shelf.id, parent_id: shelved.id })
    // an archived task counts its archived subtask
    const gone = await task(fx, { title: 'Gone', archived_at: NOW })
    await task(fx, { parent_id: gone.id, archived_at: NOW })
    // a task whose only subtask is archived is a leaf
    const archivedOnly = await task(fx, { title: 'Archived only' })
    await task(fx, { parent_id: archivedOnly.id, archived_at: NOW })

    for (const [t, group] of [
      [shelved, true],
      [gone, true],
      [archivedOnly, false],
    ] as const) {
      expect((await restGet(fx, t.id, fx.admin.id)).is_group, t.title).toBe(group)
    }
    await restPatch(fx, archivedOnly.id, { remaining_hours: 2 })
    expect((await row(fx, archivedOnly.id))?.remaining_hours).toBe(2)
    const group = await task(fx, { title: 'Group' })
    await task(fx, { parent_id: group.id })
    await expectRefusal(
      restPatch(fx, group.id, { remaining_hours: 2 }),
      'bad_request',
      /^remaining_hours cannot be set on a task with subtasks/,
    )
  })
})

describe('the guard on parent links', () => {
  it('names no parent outside the task’s own sub-project to a reader who cannot see it', async () => {
    const fx = await setup()
    // a row no write makes: its parent in AWAY, which the guest and the
    // agent cannot see
    const parent = await task(fx, { project_id: fx.away.id, title: 'Parent elsewhere' })
    const child = await task(fx, { parent_id: parent.id, title: 'Child' })
    // the task window
    const window = await as(fx.t, fx.guest).query(api.taskWindow.task, {
      org_id: fx.org.id,
      ref: child.id,
    })
    if (window.state !== 'ok') throw new Error(window.state)
    expect(window.parent).toBeNull()
    expect(window.task.has_hidden_parent).toBe(false)
    expect('parent_id' in window.task).toBe(false)
    // a view read, the Board of FW
    const board = await boardFor(fx.t, fx.guest, projectScope(fx.guest, fx.sub.id), NO_FILTERS)
    if (board.state !== 'ok') throw new Error(board.state)
    const row = board.rows.find((r) => r.id === child.id)
    expect(row?.has_hidden_parent).toBe(false)
    expect(row).not.toHaveProperty('parent_id')
    // the REST read
    const rest = await restGet(fx, child.id)
    expect(rest).toMatchObject({ parent_id: null, has_hidden_parent: false })
    for (const answer of [window, board, rest])
      expect(JSON.stringify(answer)).not.toContain(parent.id)
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

  it("a person's load reads their own tasks, and counts a task whose subtasks are archived", async () => {
    const fx = await setup()
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-14' }
    const leaf = await task(fx, { ...plan, remaining_hours: 3 })
    // its only subtask is archived
    const archivedOnly = await task(fx, { ...plan, remaining_hours: 5 })
    await task(fx, { parent_id: archivedOnly.id, archived_at: NOW })
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
    expect(rows.map((r) => r.issue_id).sort()).toEqual([leaf.id, archivedOnly.id].sort())
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
    const kid = await task(fx, { parent_id: group.id, status: 'done' })
    const leaf = await task(fx, { title: 'Leaf' })
    // the organization is counted, as on a deployment, before the archived
    // sub-project's tasks, which no live figure counts, are planted past
    // the counts
    await countOrg(fx.t, fx.org.id)
    await plantMany(fx, 2000, { project_id: fx.shelf.id })
    const expected = [group.id, kid.id, leaf.id]
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
      ])
      const mcp = await mcpPage(fx.t, { callerId: fx.agent.id, access: 'read', project: 'TBED' })
      expect(mcp.tasks.map((r) => r.id)).toEqual(expected)
      expect(mcp.next_cursor).toBeNull()
    })
    // the group's done subtask and the leaf, from the counts, which read no
    // task, with what the project's detail keeps back lowered to fit this
    // request's 400 documents
    const reserve = structuredClone(COMPLETION_RESERVE)
    Object.assign(COMPLETION_RESERVE, { documents: 64 })
    try {
      const completion = { status: 'ok', done: 1, total: 2, percent: 50 }
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

  it('a list that names an archived project counts the subtasks its tasks have there', async () => {
    const fx = await setup()
    const shelved = await task(fx, { project_id: fx.shelf.id, title: 'Shelved group' })
    const kid = await task(fx, {
      project_id: fx.shelf.id,
      parent_id: shelved.id,
      start_week: '2026-09-07',
      end_week: '2026-09-07',
    })
    const rest = await restTasks(fx.t, { callerId: fx.agent.id, access: 'read', project: 'SHELF' })
    expect(rest.map((r) => [r.id, r.is_group, r.start_week, r.end_week])).toEqual([
      [shelved.id, true, '2026-09-07', '2026-09-07'],
      [kid.id, false, '2026-09-07', '2026-09-07'],
    ])
  })

  it("a busy person's load past the subtask checks is unavailable, read in few ranges", async () => {
    // 300 subtask checks would take more index ranges than the read may
    const fx = await setup(newT({ transactionLimits: { databaseQueries: 200 } }))
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-14' }
    await plantMany(fx, 299, { project_id: fx.sub.id, ...plan })
    const group = await task(fx, plan)
    await task(fx, { parent_id: group.id })
    // a leaf whose only subtask is archived is one of them
    const archivedOnly = await task(fx, plan)
    await task(fx, { parent_id: archivedOnly.id, archived_at: NOW })
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

  it('a delay verdict’s owner load counts a task whose subtasks are archived', async () => {
    const fx = await setup()
    const plan = { assignee_id: fx.user.id, start_week: '2026-09-07', end_week: '2026-09-07' }
    const leaf = await task(fx, { ...plan, remaining_hours: 5, remaining_set_at: NOW })
    await task(fx, { parent_id: leaf.id, archived_at: NOW })
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
    // a leaf whose only subtask is archived, so its own hours count
    const leaf = await task(fx, { ...plan, remaining_hours: 5 })
    await task(fx, { parent_id: leaf.id, archived_at: NOW })
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
    expect(all.hours).toEqual([12])
    const scoped = await workload(fx.meta)
    expect(scoped.hours).toEqual([8])
    // tasks nobody on the page owns are never read
    await plantMany(fx, 30, { project_id: fx.away.id })
    await plantMany(fx, 30, { project_id: fx.sub.id, status: 'done' })
    expect(await workload(null)).toEqual(all)
    expect(await workload(fx.meta)).toEqual(scoped)
  })
})

describe("a project's completion", () => {
  it('reads no task, and counts the leaves, as in the Overview', async () => {
    const fx = await setup()
    const group = await task(fx, { title: 'Group' })
    await task(fx, { parent_id: group.id, status: 'done' })
    await task(fx, { title: 'Leaf' })
    await task(fx, { project_id: fx.sub2.id, title: 'Leaf of PCB', status: 'done' })
    await countOrg(fx.t, fx.org.id)
    const read = (ref: string) =>
      as(fx.t, fx.admin).query(async (ctx) => {
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        const out = await getProjectHandler(ctx, { callerId: fx.admin.id, access: 'read', ref })
        const documents = (await ctx.meta.getTransactionMetrics()).documentsRead.used - before
        return { completion: out.completion, documents }
      })
    const tbed = await read('TBED')
    // Group's subtask and Leaf in FW, and the leaf of PCB, count
    expect(tbed.completion).toEqual({ status: 'ok', done: 2, total: 3, percent: 67 })
    expect(tbed.documents).toBeLessThan(150)
    expect((await read('FW')).completion).toEqual({
      status: 'ok',
      done: 1,
      total: 2,
      percent: 50,
    })
    // more tasks in the family and in another family are never read
    await plantMany(fx, 30, { project_id: fx.sub2.id })
    await plantMany(fx, 30, { project_id: fx.away.id })
    expect((await read('TBED')).documents).toBe(tbed.documents)
  })
})

describe('project restores and moves', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
  })

  it('restoring a sub-project changes no group and schedules no regroup step', async () => {
    const fx = await setup()
    const own = { remaining_hours: 5, remaining_set_at: NOW }
    // a group in SHELF through its subtask there, and a leaf with hours
    const inside = await task(fx, { project_id: fx.shelf.id, title: 'Inside' })
    await task(fx, { project_id: fx.shelf.id, parent_id: inside.id })
    const leaf = await task(fx, { project_id: fx.shelf.id, title: 'Leaf', ...own })
    expect((await restGet(fx, inside.id, fx.admin.id)).is_group).toBe(true)
    await as(fx.t, fx.user).mutation(api.projects.unarchive, { org_id: fx.org.id, id: fx.shelf.id })
    await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await row(fx, leaf.id)).toMatchObject(own)
    expect((await restGet(fx, inside.id, fx.admin.id)).is_group).toBe(true)
    const steps = await fx.t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name === 'regroup:restoredStep',
      ),
    )
    expect(steps).toEqual([])
  })

  it('the regroup step a restore scheduled before this release ends, writing nothing', async () => {
    const fx = await setup()
    // a group of SHELF that still stores hours of its own
    const parent = await task(fx, { project_id: fx.shelf.id, title: 'Parent', remaining_hours: 2 })
    await task(fx, { project_id: fx.shelf.id, parent_id: parent.id })
    const after = await fx.t.mutation(async (ctx) => {
      await stepHandler(ctx, { projects: [fx.shelf.id], restorer_id: fx.user.id })
      const jobs = await ctx.db.system.query('_scheduled_functions').collect()
      return jobs.filter((job) => job.state.kind === 'pending')
    })
    expect(after).toEqual([])
    expect(await row(fx, parent.id)).toEqual(parent)
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
    // its only subtask is archived, so its reviewer is its own, also once
    // the move carries that subtask along
    const reviewed = await task(fx, { status: 'review', reviewer_id: rita.id })
    await task(fx, { parent_id: reviewed.id, archived_at: NOW })
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
    const refusal = await expectRefusal(
      as(fx.t, fx.admin).mutation(api.issues.move, {
        org_id: fx.org.id,
        id: root.id,
        project_id: fx.away.id,
      }),
      'rule',
    )
    expect(refusal.data.message).toBe(
      moveSubtreeHolderRule([{ name: rita.name, tasks: [issueKey(kid.num)] }]),
    )
    expect(await row(fx, kid.id)).toMatchObject({ project_id: fx.sub.id, reviewer_id: rita.id })
  })
})
