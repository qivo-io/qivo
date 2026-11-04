/* What REST and MCP reads say about tasks and projects that the app also
 * shows (lib/core.ts):
 *
 *   1. A group's `progress`, the Progress of the app's task window, on list
 *      rows and the single-task read. It is checked against the app's own
 *      groupProgress over the snapshot the app serves the same person.
 *   2. A project's `completion`, the Completion of the app's Overview, on the
 *      single-project read and its write answers, checked the same way.
 *   3. `last_comment_at` on list rows, the single read and the REST write
 *      answers, and the read budget an active page keeps while it reads it
 *      (lib/activeTaskPage.ts). */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { type GroupIssue, groupProgress, isIssueGroup } from '../../src/lib/issueGroups'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { COUNT_PAGE } from '../internal/overviewCountsBackfill'
import { ACTIVE_PAGE, TASK_LIST_UNREADABLE } from '../lib/activeTaskPage'
import { COMPLETION_RESERVE } from '../lib/core'
import type { Refusal } from '../lib/functions'
import { CURSOR_REFUSAL, offsetRefusal } from '../lib/listCursor'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  restArchivedPage,
  restTasks,
  type T,
  TODAY,
  uuid,
  withOrg,
  workspaceOf,
} from './helpers.setup'
import { countOrg } from './overviewCounts.setup'
import { lowered, mcpPages, restPage, restPages } from './taskPages.setup'

type Fx = OrgFixture & {
  t: T
  /** a sub-project of TBED that the guest cannot see */
  hiddenSib: Doc<'projects'>
  /** an archived sub-project of TBED */
  archivedSub: Doc<'projects'>
}

/* withOrg, with the agent holding Edit on TBED, the guest Edit on FW and PCB
 * only, and the sub-projects hiddenSib and an archived ARC under TBED. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
  })
  const hiddenSib = await plantHiddenSibling(t, f, f.guest)
  const archivedSub = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    key: 'ARC',
    archived_at: NOW,
  })
  return { t, ...f, hiddenSib, archivedSub }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

/* The tree of groups the progress and completion cases read. Leaves are
 * named l*, groups g*, and the archived group ga. */
async function tree(fx: Fx) {
  const pcb = fx.sub2.id
  const sib = fx.hiddenSib.id
  const g1 = await task(fx, { title: 'G1' })
  const l1 = await task(fx, { parent_id: g1.id, status: 'todo' })
  const l2 = await task(fx, { parent_id: g1.id, project_id: pcb, status: 'done' })
  const g2 = await task(fx, { parent_id: g1.id, title: 'G2' })
  const l3 = await task(fx, { parent_id: g2.id, status: 'done' })
  // hidden from the guest, and an archived subtask nobody counts
  const l4 = await task(fx, { parent_id: g2.id, project_id: sib, status: 'progress' })
  await task(fx, { parent_id: g2.id, status: 'done', archived_at: NOW })
  // only a subtask the guest cannot see
  const g3 = await task(fx, { title: 'G3' })
  await task(fx, { parent_id: g3.id, project_id: sib, status: 'todo' })
  // a subtask in an archived project, which makes no task in an active one a group
  const g4 = await task(fx, { project_id: pcb, title: 'G4' })
  await task(fx, { parent_id: g4.id, project_id: pcb, status: 'done' })
  await task(fx, { parent_id: g4.id, project_id: fx.archivedSub.id, status: 'todo' })
  const g5 = await task(fx, { title: 'G5' })
  await task(fx, { parent_id: g5.id, status: 'done' })
  await task(fx, { parent_id: g5.id, project_id: pcb, status: 'done' })
  const g6 = await task(fx, { title: 'G6' })
  const g7 = await task(fx, { parent_id: g6.id, title: 'G7' })
  await task(fx, { parent_id: g7.id, status: 'done' })
  await task(fx, { parent_id: g6.id, status: 'backlog' })
  const l13 = await task(fx, { title: 'Leaf' })
  // an archived group counts its whole subtree; the guest cannot see la2
  const ga = await task(fx, { title: 'GA', archived_at: NOW })
  await task(fx, { parent_id: ga.id, status: 'done', archived_at: NOW })
  await task(fx, { parent_id: ga.id, project_id: sib, status: 'todo', archived_at: NOW })
  await task(fx, { status: 'done', archived_at: NOW })
  return { g1, g2, g3, g4, g5, g6, g7, ga, l1, l2, l3, l4, l13 }
}

/* What the app shows `person`: the snapshot's rows of the fixture
 * organization as the planner shapes them for src/lib/issueGroups.ts, and
 * its projects. */
async function appView(fx: Fx, person: Doc<'profiles'>) {
  const snap = await workspaceOf(as(fx.t, person))
  if (snap === null) throw new Error(`${person.name} has no snapshot`)
  const rows = snap.issues.filter((i) => i.org_id === fx.org.id)
  const byId: Record<string, GroupIssue> = {}
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      status: row.status,
      children: rows.filter((c) => c.parent_id === row.id).map((c) => c.id),
      hasHiddenSubtasks: row.has_hidden_subtasks,
    }
  }
  return { rows, byId, projects: snap.projects.filter((p) => p.org_id === fx.org.id) }
}

/* The Overview's Completion of the top-level project `metaId` over the app's
 * view (src/store/planner.ts progressIn over scopeInfo's sub-projects). */
function appCompletion(view: Awaited<ReturnType<typeof appView>>, metaId: string) {
  const subs = new Set(
    view.projects.filter((p) => p.parent_id === metaId && p.archived_at == null).map((p) => p.id),
  )
  const counted = view.rows.filter((r) => subs.has(r.project_id) && !isIssueGroup(view.byId[r.id]))
  const done = counted.filter((r) => r.status === 'done').length
  const total = counted.length
  return { status: 'ok', done, total, percent: total ? Math.round((done / total) * 100) : 0 }
}

const restGet = (fx: Fx, ref: string, callerId: string) =>
  fx.t.query(internal.machine.rest.getIssue, { today: TODAY, callerId, access: 'read', ref })

const mcpRead = async <Out>(
  fx: Fx,
  fn: typeof internal.machine.mcp.getIssue | typeof internal.machine.mcp.listIssues,
  callerId: string,
  args: Record<string, unknown>,
): Promise<Out> =>
  JSON.parse(
    await fx.t.query(fn, { today: TODAY, callerId, access: 'read', ...args } as never),
  ) as Out

type Row = { id: string; progress: unknown; last_comment_at: unknown }

/** A page of MCP list_tasks. */
type McpPage = { next_cursor: string | null; tasks: Row[] }

/* ------------------------------------------------------------ 1. progress */

describe('a group’s progress is the app task window’s Progress', () => {
  it('counts what each reader is shown, as the app’s groupProgress does', async () => {
    const fx = await setup()
    await tree(fx)
    for (const person of [fx.admin, fx.guest]) {
      const app = await appView(fx, person)
      const rows = await restTasks(fx.t, { callerId: person.id, access: 'read', limit: '200' })
      // an active list holds the app's working set, no more and no less
      expect(rows.map((r) => r.id).sort()).toEqual(app.rows.map((r) => r.id).sort())
      for (const row of rows) {
        const shown = app.byId[row.id]
        const expected = isIssueGroup(shown)
          ? (({ done, total, pct, unknown }) => ({ done, total, percent: pct, partial: unknown }))(
              groupProgress(shown, app.byId),
            )
          : null
        expect(row.progress, `${person.name} ${row.title}`).toEqual(expected)
      }
    }
  })

  it('reads the same on list rows and the single read, on both surfaces', async () => {
    const fx = await setup()
    const { g1, g2, g3, g4, g5, g6, g7, ga, l13 } = await tree(fx)
    const p = (done: number, total: number, percent: number, partial: boolean) => ({
      done,
      total,
      percent,
      partial,
    })
    const expected = {
      // l4 is hidden from the guest; the archived subtask counts for no one
      guest: [
        [g1, p(2, 3, 67, true)],
        [g2, p(1, 1, 100, true)],
        [g3, p(0, 0, 0, true)],
        [g4, p(1, 1, 100, false)],
        [g5, p(2, 2, 100, false)],
        [g6, p(1, 2, 50, false)],
        [g7, p(1, 1, 100, false)],
        [ga, p(1, 1, 100, true)],
        [l13, null],
      ],
      // the admin sees l4, so nothing stays unknown; G4's subtask in ARC
      // leaves out nothing, because it does not count
      admin: [
        [g1, p(2, 4, 50, false)],
        [g2, p(1, 2, 50, false)],
        [g3, p(0, 1, 0, false)],
        [g4, p(1, 1, 100, false)],
        [ga, p(1, 2, 50, false)],
      ],
    } as const
    for (const person of [fx.guest, fx.admin]) {
      const rest = await restTasks(fx.t, { callerId: person.id, access: 'read', limit: '200' })
      const mcp = (
        await mcpRead<McpPage>(fx, internal.machine.mcp.listIssues, person.id, { limit: 200 })
      ).tasks
      for (const [issue, progress] of expected[person.id === fx.guest.id ? 'guest' : 'admin']) {
        const label = `${person.name} ${issue.title}`
        expect((await restGet(fx, issue.id, person.id)).progress, label).toEqual(progress)
        const viaMcp = await mcpRead<Row>(fx, internal.machine.mcp.getIssue, person.id, {
          ref: issue.id,
        })
        expect(viaMcp.progress, label).toEqual(progress)
        // archived tasks are not on active lists
        if (issue.archived_at !== undefined) continue
        expect(rest.find((r) => r.id === issue.id)?.progress, label).toEqual(progress)
        expect(mcp.find((r) => r.id === issue.id)?.progress, label).toEqual(progress)
      }
    }
    // an archived page answers what the single read does
    const page = await restArchivedPage(fx.t, {
      callerId: fx.guest.id,
      access: 'read',
      project: 'FW',
    })
    expect(page.tasks.find((r) => r.id === ga.id)?.progress).toEqual(p(1, 1, 100, true))
  })

  /* Valid writes keep one level of subtasks (assertParentChain). The walk
   * still stops on a cycle, which only broken data can hold, and says the
   * progress is partial. */
  it('is partial on a parent cycle', async () => {
    const fx = await setup()
    // two tasks parented to each other, so each is the other's group
    const aId = uuid()
    const b = await task(fx, { parent_id: aId, title: 'Cycle B' })
    const a = await task(fx, { id: aId, parent_id: b.id, title: 'Cycle A' })
    const progress = { done: 0, total: 0, percent: 0, partial: true }
    expect((await restGet(fx, a.id, fx.admin.id)).progress).toEqual(progress)
    const viaMcp = await mcpRead<Row>(fx, internal.machine.mcp.getIssue, fx.admin.id, {
      ref: a.id,
    })
    expect(viaMcp.progress).toEqual(progress)
  })
})

/* ---------------------------------------------------------- 2. completion */

describe('a project’s completion is the app Overview’s Completion', () => {
  /* REST GET /v1/projects/{ref} as `person`. */
  const restProject = (fx: Fx, person: Doc<'profiles'>, ref: string) =>
    fx.t.query(internal.machine.rest.getProject, { callerId: person.id, access: 'read', ref })

  it('counts the active tasks without subtasks that each reader is shown', async () => {
    const fx = await setup()
    await tree(fx)
    await countOrg(fx.t, fx.org.id)
    for (const person of [fx.admin, fx.guest]) {
      const app = appCompletion(await appView(fx, person), fx.meta.id)
      expect((await restProject(fx, person, 'TBED')).completion, person.name).toEqual(app)
    }
    // the admin counts hiddenSib's two leaves too; ARC's task, the archived
    // ones and every group stay out
    expect((await restProject(fx, fx.admin, 'TBED')).completion).toEqual({
      status: 'ok',
      done: 6,
      total: 11,
      percent: 55,
    })
    expect((await restProject(fx, fx.guest, 'TBED')).completion).toEqual({
      status: 'ok',
      done: 6,
      total: 9,
      percent: 67,
    })
    // a sub-project counts its own tasks
    const fw = { status: 'ok', done: 3, total: 6, percent: 50 }
    expect((await restProject(fx, fx.admin, 'FW')).completion).toEqual(fw)
    const viaMcp = JSON.parse(
      await fx.t.query(internal.machine.projects.mcpGetProject, {
        callerId: fx.admin.id,
        access: 'read',
        project: 'FW',
      }),
    ) as Record<string, unknown>
    expect(viaMcp.completion).toEqual(fw)
    const keys = Object.keys(viaMcp)
    expect(keys[keys.indexOf('track_delay') + 1]).toBe('completion')
    // an archived project's tasks are outside the plan
    expect((await restProject(fx, fx.admin, 'ARC')).completion).toBeNull()
    // a change answers the project with its completion
    const changed = await fx.t.mutation(internal.machine.projects.restUpdateProject, {
      callerId: fx.user.id,
      access: 'write',
      keyName: 'drive',
      ref: 'FW',
      body: JSON.stringify({ description: 'Firmware work' }),
    })
    expect(changed.completion).toEqual(fw)
  })

  it('answers a new project’s zero completion without reading tasks', async () => {
    // the parent's tasks pass this many documents, which creating never
    // reads, and which the parent's completion from the counts reads none of
    const fx = await setup(newT({ transactionLimits: { documentsRead: 250 } }))
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: fx.org.id,
          project_id: fx.sub.id,
          num: 50_000 + i,
          title: `Bulk ${i}`,
          description: '',
          status: 'todo',
          priority: 'low',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
      }
    })
    // counted with the backfill's steps, each kept inside the request's
    // documents by a smaller page
    const page = structuredClone(COUNT_PAGE)
    Object.assign(COUNT_PAGE, { tasks: 20 })
    try {
      await countOrg(fx.t, fx.org.id)
    } finally {
      Object.assign(COUNT_PAGE, page)
    }
    const created = JSON.parse(
      await fx.t.mutation(internal.machine.projects.mcpCreateProject, {
        callerId: fx.user.id,
        access: 'write',
        name: 'Optics',
        parent: 'TBED',
      }),
    ) as { completion: unknown }
    expect(created.completion).toEqual({ status: 'ok', done: 0, total: 0, percent: 0 })
    // the parent's read answers its 300 tasks from the counts, with what
    // the project's detail keeps back lowered to fit this request's 250
    // documents, and unavailable where that leaves no room
    const parent = () =>
      fx.t.query(internal.machine.rest.getProject, {
        callerId: fx.user.id,
        access: 'read',
        ref: 'TBED',
      })
    expect((await parent()).completion).toEqual({
      status: 'unavailable',
      done: null,
      total: null,
      percent: null,
    })
    const reserve = structuredClone(COMPLETION_RESERVE)
    Object.assign(COMPLETION_RESERVE, { documents: 32 })
    try {
      expect((await parent()).completion).toEqual({
        status: 'ok',
        done: 0,
        total: 300,
        percent: 0,
      })
    } finally {
      Object.assign(COMPLETION_RESERVE, reserve)
    }
  })
})

/* ---------------------------------------------------- 3. last_comment_at */

describe('last_comment_at is when the newest comment was posted', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('on list rows, the single read and the REST answers, through edits and deletes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-03-02T09:00:00.000Z'))
    const fx = await setup()
    const talked = await task(fx, { title: 'Talked about' })
    const quiet = await task(fx, { title: 'Quiet' })
    const agent = { callerId: fx.agent.id, access: 'write' } as const
    const post = async (body: string) => {
      const comment = await fx.t.mutation(internal.machine.rest.addComment, {
        ...agent,
        ref: talked.id,
        body: JSON.stringify({ body }),
      })
      vi.setSystemTime(Date.now() + 60_000)
      return comment
    }
    await post('One')
    const two = await post('Two')
    const three = await post('Three')
    /* last_comment_at of `issue` on every read, which must agree. */
    const everywhere = async (issue: Doc<'issues'>) => {
      const rest = await restTasks(fx.t, { callerId: fx.agent.id, access: 'read' })
      const mcp = (await mcpRead<McpPage>(fx, internal.machine.mcp.listIssues, fx.agent.id, {}))
        .tasks
      const values = [
        rest.find((r) => r.id === issue.id)?.last_comment_at,
        mcp.find((r) => r.id === issue.id)?.last_comment_at,
        (await restGet(fx, issue.id, fx.agent.id)).last_comment_at,
        (await mcpRead<Row>(fx, internal.machine.mcp.getIssue, fx.agent.id, { ref: issue.id }))
          .last_comment_at,
      ]
      expect(new Set(values).size, JSON.stringify(values)).toBe(1)
      return values[0]
    }
    expect(three.created_at).toBe('2026-03-02T09:02:00.000Z')
    expect(await everywhere(talked)).toBe(three.created_at)
    expect(await everywhere(quiet)).toBeNull()
    // an edit is not a new comment
    await fx.t.mutation(internal.machine.discussion.restUpdateComment, {
      ...agent,
      ref: three.id,
      body: JSON.stringify({ body: 'Three, edited' }),
    })
    expect(await everywhere(talked)).toBe(three.created_at)
    // without its newest comment, the one before it is the newest
    await fx.t.mutation(internal.machine.discussion.restDeleteComment, { ...agent, ref: three.id })
    expect(await everywhere(talked)).toBe(two.created_at)
    // REST write answers carry it: none on a new task, then the archive's
    // reason, which is a comment posted at the archive
    const created = await fx.t.mutation(internal.machine.rest.createIssue, {
      ...agent,
      keyName: 'drive',
      body: JSON.stringify({ project: 'FW', title: 'New' }),
    })
    expect(created.last_comment_at).toBeNull()
    const archived = await fx.t.mutation(internal.machine.rest.updateIssue, {
      ...agent,
      keyName: 'drive',
      ref: created.id,
      body: JSON.stringify({ archived: true, archive_reason: 'Not needed' }),
    })
    expect(archived.last_comment_at).toBe(archived.archived_at)
    // and so does an archived page's row
    const page = await restArchivedPage(fx.t, {
      callerId: fx.agent.id,
      access: 'read',
      project: 'FW',
    })
    expect(page.tasks.find((r) => r.id === created.id)?.last_comment_at).toBe(archived.archived_at)
  })
})

describe('an active page keeps inside the request’s read limits', () => {
  it('ends a page whose newest comments pass its budget early, and the next goes on with no gap or repeat', async () => {
    const fx = await setup(newT({ transactionLimits: { bytesRead: 512 << 10 } }))
    // thirty tasks whose newest comments hold about 19 KB each, 570 KB in all
    const ids: string[] = []
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        const id = uuid()
        ids.push(id)
        await ctx.db.insert('issues', {
          id,
          org_id: fx.org.id,
          project_id: fx.sub.id,
          num: 60_000 + i,
          title: `Discussed ${i}`,
          description: '',
          status: 'todo',
          priority: 'low',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: id,
          author: fx.agent.id,
          body: 'x'.repeat(19_000),
          created_at: NOW,
        })
      }
    })
    // a page budget of 300 KB that fits this request's 512 KB
    const budget = {
      page: { bytes: 300 << 10, delays: { ...ACTIVE_PAGE.delays, bytes: 50 << 10 } },
      reserve: { bytes: 64 << 10 },
    }
    await lowered(budget, async () => {
      const args = { callerId: fx.agent.id, access: 'read' as const }
      const first = await restPage(fx.t, args)
      expect(first.tasks.length).toBeGreaterThan(0)
      expect(first.tasks.length).toBeLessThan(30)
      expect(first.next_cursor).toEqual(expect.any(String))
      const rest = await restPages(fx.t, args)
      expect(rest.rows.map((r) => r.id)).toEqual(ids)
      expect(rest.rows.map((r) => r.last_comment_at)).toEqual(Array(30).fill(NOW))
      const mcp = await mcpPages(fx.t, args)
      expect(mcp.rows.map((r) => r.id)).toEqual(ids)
      expect(mcp.rows.map((r) => r.last_comment_at)).toEqual(Array(30).fill(NOW))
    })
  })

  it('refuses a request without room for a whole page, whatever the limit', async () => {
    // short of the page's bytes, then of its index ranges
    for (const transactionLimits of [{ bytesRead: 512 << 10 }, { databaseQueries: 64 }]) {
      const fx = await setup(newT({ transactionLimits }))
      await task(fx, { title: 'Never discussed' })
      const refusal = async (p: Promise<unknown>) => {
        const e = await expectRefusal(p, 'bad_request')
        expect((e.data as Refusal).message, JSON.stringify(transactionLimits)).toBe(
          TASK_LIST_UNREADABLE,
        )
      }
      await refusal(restTasks(fx.t, { callerId: fx.agent.id, access: 'read', limit: '1' }))
      await refusal(
        fx.t.query(internal.machine.mcp.listIssues, {
          today: TODAY,
          callerId: fx.agent.id,
          access: 'read',
          limit: 1,
        }),
      )
    }
  })
})

describe("an active list's refusals", () => {
  it('are the pinned sentences, which the public docs quote', () => {
    const sentences = {
      [TASK_LIST_UNREADABLE]:
        "the task list could not be read within the request's limits; pass project to list one project's tasks",
      [CURSOR_REFUSAL]: 'cursor must be the next_cursor of an earlier page',
      [offsetRefusal('active tasks')]:
        'offset does not apply to active tasks; pass next_cursor as cursor',
    }
    for (const [sent, pinned] of Object.entries(sentences)) expect(sent).toBe(pinned)
    const docs = import.meta.glob(['../../docs/rest-api.md', '../../docs/mcp.md'], {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>
    expect(Object.keys(docs)).toHaveLength(2)
    for (const [path, text] of Object.entries(docs)) {
      // a wrapped line reads as one space
      const prose = text.replace(/\s+/g, ' ')
      for (const pinned of Object.values(sentences)) expect(prose, path).toContain(pinned)
    }
  })
})
