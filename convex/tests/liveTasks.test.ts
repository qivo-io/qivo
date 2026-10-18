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
import { byId } from '../lib/db'
import { countsAsSubtask, groupTest } from '../lib/liveTasks'
import { OWNER_LOAD_CHECKS, ownerLoadSpans } from '../lib/machineDelay'
import { orgProjectView } from '../lib/visibility'
import { weekGrid } from '../lib/workload'
import { MOVE_SUBTREE_HOLDER_RULE, REVIEWER_RULE } from '../model/issues'
import { assigneeLoad, workloadCore } from '../planning'
import { RESTORE_REGROUP, restoredStep } from '../regroup'
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
  type T,
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
  fx.t.query(internal.machine.rest.getIssue, { callerId, access: 'read', now: NOW, ref })

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
      now: NOW,
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
      now: NOW,
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

  it('restoring a top-level project walks each restored sub-project, also when the restorer is gone', async () => {
    const fx = await setup()
    // a subtask stored before a subtask had to stay in its parent's project
    const parent = await task(fx, { project_id: fx.away.id, remaining_hours: 6, title: 'Away' })
    await plantSubscription(fx.t, { issue_id: parent.id, profile_id: fx.admin.id })
    await task(fx, { project_id: fx.sub2.id, parent_id: parent.id })
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
    // the next step reads the same page again
    expect(first.next).toEqual([{ projects: [fx.shelf.id], restorer_id: fx.user.id }])
    // 47 profiles, read once, not for each of the 4 tasks it cleared
    expect(first.read).toBeLessThan(120)
    await runSteps(fx.t)
    expect(await cleared()).toBe(6)
    expect(await details(fx, parents[5].id)).toEqual([['Remaining cleared (was 2 h)', fx.user.id]])
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
    const root = await task(fx, { title: 'Root', remaining_hours: 6, remaining_set_at: NOW })
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
