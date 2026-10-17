/* REST GET /v1/tasks and MCP list_tasks over large archives (lib/core.ts
 * listActiveIssuesCore and listArchivedIssuesCore). An active list reads
 * only active tasks and its search only active tasks' label assignments.
 * Archived tasks are listed one project at a time and paged with a cursor,
 * so each page reads a bounded amount whatever the archive holds. A
 * single-task read of an active group never reads archived tasks elsewhere. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { type ArchiveCursor, archiveCursorText, parseArchiveCursor } from '../lib/archivedTasks'
import { ARCHIVE_PAGE, SUBTREE_WALK } from '../lib/core'
import type { Refusal, RefusalCode } from '../lib/functions'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  restArchivedPage,
  restTasks,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

type Fx = OrgFixture & { t: T }

const grant = (t: T, project_id: string, profile_id: string) =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level: 'user' })
  })

/* withOrg, with the agent holding Edit on TBED (FW and PCB). */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await grant(t, f.meta.id, f.agent.id)
  return { t, ...f }
}

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

/* Task numbers for plantMany, clear of plantIssue's. */
let bulkNum = 100_000

/* `count` tasks in one transaction, without reading anything. */
const plantMany = (fx: Fx, count: number, over: Partial<Doc<'issues'>> & { project_id: string }) =>
  fx.t.run(async (ctx) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = uuid()
      ids.push(id)
      await ctx.db.insert('issues', {
        id,
        org_id: fx.org.id,
        num: bulkNum++,
        title: `Bulk ${i}`,
        description: '',
        status: 'done',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        ...over,
      })
    }
    return ids
  })

/* MCP list_tasks as `callerId`, parsed. */
const mcpList = async <Out>(fx: Fx, callerId: string, args: Record<string, unknown>) =>
  JSON.parse(
    await fx.t.query(internal.machine.mcp.listIssues, { callerId, access: 'read', ...args }),
  ) as Out

type McpPage = { next_cursor: string | null; tasks: { id: string }[] }

/* Every page of `project`'s archived tasks on both surfaces, as task ids in
 * the order they came, and how many pages each took. */
async function everyPage(
  fx: Fx,
  callerId: string,
  args: { project: string; limit?: number; search?: string },
  between: (page: number) => Promise<void> = async () => {},
): Promise<{ rest: string[]; mcp: string[]; restPages: number; mcpPages: number }> {
  const rest: string[] = []
  let restPages = 0
  let cursor: string | undefined
  do {
    const page = await restArchivedPage(fx.t, {
      callerId,
      access: 'read',
      project: args.project,
      search: args.search,
      limit: args.limit === undefined ? undefined : String(args.limit),
      cursor,
    })
    rest.push(...page.tasks.map((task) => task.id))
    cursor = page.next_cursor ?? undefined
    await between(++restPages)
    if (restPages > 100) throw new Error('REST paging does not end')
  } while (cursor !== undefined)
  const mcp: string[] = []
  let mcpPages = 0
  do {
    const page: McpPage = await mcpList(fx, callerId, { ...args, archived: true, cursor })
    mcp.push(...page.tasks.map((task) => task.id))
    cursor = page.next_cursor ?? undefined
    if (++mcpPages > 100) throw new Error('MCP paging does not end')
  } while (cursor !== undefined)
  return { rest, mcp, restPages, mcpPages }
}

/* The archived tasks of `projectIds` in archive order, most recently
 * archived first, then newest created first. */
const archiveOrder = (fx: Fx, projectIds: string[]) =>
  fx.t.run(async (ctx) => {
    const rows = await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
      .collect()
    return rows
      .filter((t) => t.archived_at !== undefined && projectIds.includes(t.project_id))
      .sort((a, b) =>
        a.archived_at === b.archived_at
          ? b._creationTime - a._creationTime
          : (b.archived_at ?? '') < (a.archived_at ?? '')
            ? -1
            : 1,
      )
      .map((t) => t.id)
  })

const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}T09:00:00.000Z`

describe('active task lists read active tasks only', () => {
  it('lists active tasks while hundreds of archived ones exist, on both surfaces', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 100 } }))
    await plantMany(fx, 300, { project_id: fx.sub.id, archived_at: NOW })
    const live = []
    for (const title of ['One', 'Two', 'Three']) {
      live.push(await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title }))
    }
    const ids = live.map((task) => task.id)
    const rest = await restTasks(fx.t, { callerId: fx.agent.id, access: 'read' })
    expect(rest.map((row) => row.id)).toEqual(ids)
    const mcp = await mcpList<{ id: string }[]>(fx, fx.agent.id, { project: 'FW' })
    expect(mcp.map((row) => row.id)).toEqual(ids)
  })

  it('searches labels without reading archived tasks’ assignments', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 100 } }))
    const bug = uuid()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id: bug,
        org_id: fx.org.id,
        name: 'Bug',
        name_lower: 'bug',
        color: '#ff0000',
        created_at: NOW,
      })
    })
    // 300 archived tasks whose assignments carry the archive mark
    const archived = await plantMany(fx, 300, {
      project_id: fx.sub.id,
      archived_at: NOW,
      relations_marked: true,
    })
    const plain = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    // restored from the archive, its assignment still marked
    const restored = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub2.id,
      relations_marked: true,
    })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'Unlabelled' })
    await fx.t.run(async (ctx) => {
      for (const issue_id of archived) {
        await ctx.db.insert('issue_labels', {
          org_id: fx.org.id,
          issue_id,
          label_id: bug,
          task_archived: true,
        })
      }
      await ctx.db.insert('issue_labels', { org_id: fx.org.id, issue_id: plain.id, label_id: bug })
      await ctx.db.insert('issue_labels', {
        org_id: fx.org.id,
        issue_id: restored.id,
        label_id: bug,
        task_archived: true,
      })
    })
    const rest = await restTasks(fx.t, { callerId: fx.agent.id, access: 'read', search: 'bug' })
    expect(rest.map((row) => row.id)).toEqual([plain.id, restored.id])
    const mcp = await mcpList<{ id: string }[]>(fx, fx.agent.id, { search: 'bug' })
    expect(mcp.map((row) => row.id)).toEqual([plain.id, restored.id])
  })

  it('reads a large group under an active task without the archive', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 100 } }))
    const before = SUBTREE_WALK.reads
    SUBTREE_WALK.reads = 2
    try {
      await plantMany(fx, 200, { project_id: fx.sub2.id, archived_at: NOW })
      const root = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
      const kids = []
      for (const week of ['2026-03-02', '2026-03-09', '2026-03-16']) {
        kids.push(
          await plantIssue(fx.t, {
            org_id: fx.org.id,
            project_id: fx.sub.id,
            parent_id: root.id,
            start_week: week,
            end_week: week,
          }),
        )
      }
      // three subtasks take the walk past its two reads to the fallback
      const rest = await fx.t.query(internal.machine.rest.getIssue, {
        callerId: fx.agent.id,
        access: 'read',
        ref: root.id,
      })
      expect(rest).toMatchObject({
        is_group: true,
        start_week: '2026-03-02',
        end_week: '2026-03-16',
      })
      expect(rest.subtasks.map((task) => task.id)).toEqual(kids.map((task) => task.id))
      const mcp = JSON.parse(
        await fx.t.query(internal.machine.mcp.getIssue, {
          callerId: fx.agent.id,
          access: 'read',
          ref: root.id,
        }),
      ) as { subtasks: { id: string }[] }
      expect(mcp.subtasks.map((task) => task.id)).toEqual(kids.map((task) => task.id))
    } finally {
      SUBTREE_WALK.reads = before
    }
  })
})

describe('archived task lists page one project with a cursor', () => {
  afterEach(() => {
    Object.assign(ARCHIVE_PAGE, { tasks: 1000, ranges: 1500, documents: 16_000, bytes: 8 << 20 })
  })

  it('writes cursors as text that reads back, and refuses anything else', () => {
    const cursor: ArchiveCursor = {
      created: 1760583600000.123,
      archived_at: '2026-10-16T03:00:00.000Z',
    }
    expect(archiveCursorText(cursor)).toBe('1~1760583600000.123~2026-10-16T03:00:00.000Z')
    expect(parseArchiveCursor(archiveCursorText(cursor))).toEqual(cursor)
    // the timestamp is taken verbatim, whatever it holds
    expect(parseArchiveCursor('1~5~a~b')).toEqual({ created: 5, archived_at: 'a~b' })
    for (const text of ['abc', '2~1~x', '1~-1~x', '1~1~', '1~1.~x', `1~1~${'x'.repeat(65)}`]) {
      expect(parseArchiveCursor(text), text).toBeNull()
    }
  })

  it('refuses archived lists without a project, offsets and foreign cursors', async () => {
    const fx = await setup()
    const rest = (args: Record<string, string>) =>
      fx.t.query(internal.machine.rest.listIssues, {
        callerId: fx.agent.id,
        access: 'read',
        ...args,
      })
    const mcp = (args: Record<string, unknown>) => mcpList(fx, fx.agent.id, args)
    await refused(
      rest({ archived: 'true' }),
      'bad_request',
      'archived=true needs project, because archived tasks are listed one project at a time',
    )
    await refused(
      mcp({ archived: true }),
      'bad_request',
      'archived: true needs project, because archived tasks are listed one project at a time',
    )
    for (const archived of [undefined, 'false']) {
      await refused(
        rest({ ...(archived === undefined ? {} : { archived }), cursor: '1~1~x' }),
        'bad_request',
        'cursor works only with archived=true',
      )
    }
    await refused(
      mcp({ archived: false, cursor: '1~1~x' }),
      'bad_request',
      'cursor works only with archived: true',
    )
    const offset = 'offset does not apply to archived tasks; pass next_cursor as cursor'
    await refused(rest({ archived: 'true', project: 'FW', offset: '5' }), 'bad_request', offset)
    await refused(mcp({ archived: true, project: 'FW', offset: 5 }), 'bad_request', offset)
    for (const cursor of ['abc', '2~1~x', '1~-1~x', '1~1~']) {
      const sentence = 'cursor must be the next_cursor of an earlier page'
      await refused(rest({ archived: 'true', project: 'FW', cursor }), 'bad_request', sentence)
      await refused(mcp({ archived: true, project: 'FW', cursor }), 'bad_request', sentence)
    }
    // an unreadable project answers like an unknown one, before the rest
    await refused(
      rest({ archived: 'true', project: 'SKNK', offset: '5' }),
      'not_found',
      'project not found',
    )
    // offset 0 and an empty cursor change nothing
    expect(await rest({ archived: 'true', project: 'FW', offset: '0', cursor: '' })).toEqual({
      next_cursor: null,
      tasks: [],
    })
    expect(await rest({ cursor: '' })).toEqual([])
    expect(await mcp({ archived: true, project: 'FW', offset: 0 })).toEqual({
      next_cursor: null,
      tasks: [],
    })
  })

  /* TBED with FW, PCB, DOC and the archived ARC: 25 archived tasks, six of
   * them archived at the same moment in FW and PCB, and active ones. */
  async function archive(fx: Fx) {
    const doc = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      key: 'DOC',
    })
    const arc = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
      key: 'ARC',
      archived_at: NOW,
    })
    const subs = [fx.sub.id, fx.sub2.id, doc.id, arc.id]
    for (let i = 0; i < 19; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: subs[i % 4],
        archived_at: day(1 + (i % 9)),
        title: `Old ${i}`,
      })
    }
    for (let i = 0; i < 6; i++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: i % 2 === 0 ? fx.sub.id : fx.sub2.id,
        archived_at: day(20),
        title: `Tied ${i}`,
      })
    }
    for (const project_id of subs) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id, title: 'Active' })
    }
    return { doc, arc, subs }
  }

  it('pages every archived task of a project once, in archive order', async () => {
    const fx = await setup()
    const { doc, subs } = await archive(fx)
    const expected = await archiveOrder(fx, subs)
    expect(expected).toHaveLength(25)
    const pages = await everyPage(fx, fx.agent.id, { project: 'TBED', limit: 4 })
    expect(pages.rest).toEqual(expected)
    expect(pages.mcp).toEqual(expected)
    expect(pages.restPages).toBe(7)
    expect(pages.mcpPages).toBe(7)
    // naming one sub-project pages only its tasks
    const fw = await everyPage(fx, fx.agent.id, { project: 'FW', limit: 3 })
    expect(fw.rest).toEqual(await archiveOrder(fx, [fx.sub.id]))
    // someone who reads only FW and DOC never sees PCB's or ARC's
    const reader = await fx.t.run(async (ctx) => {
      const id = uuid()
      await ctx.db.insert('profiles', {
        id,
        org_id: fx.org.id,
        name: 'Reader',
        initials: 'RD',
        color: '#7a7ad0',
        org_role: 'guest',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      return id
    })
    await grant(fx.t, fx.sub.id, reader)
    await grant(fx.t, doc.id, reader)
    const guest = await everyPage(fx, reader, { project: 'TBED', limit: 4 })
    expect(guest.rest).toEqual(await archiveOrder(fx, [fx.sub.id, doc.id]))
    expect(guest.mcp).toEqual(guest.rest)
  })

  it('keeps paging in order while tasks are archived and restored', async () => {
    const fx = await setup()
    const { subs } = await archive(fx)
    const expected = await archiveOrder(fx, subs)
    const restore = expected[10]
    let added = ''
    const pages = await everyPage(fx, fx.agent.id, { project: 'TBED', limit: 4 }, async (page) => {
      if (page !== 1) return
      added = (
        await plantIssue(fx.t, {
          org_id: fx.org.id,
          project_id: fx.sub.id,
          archived_at: day(28),
        })
      ).id
      await fx.t.run(async (ctx) => {
        const row = await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', restore))
          .unique()
        if (row !== null) await ctx.db.patch(row._id, { archived_at: undefined })
      })
    })
    expect(pages.rest).toEqual(expected.filter((id) => id !== restore))
    expect(pages.rest).not.toContain(added)
  })

  it('ends a page at its budget, with a cursor, however few rows it holds', async () => {
    const fx = await setup()
    const { subs } = await archive(fx)
    ARCHIVE_PAGE.tasks = 5
    // nothing matches, so five empty pages look at five tasks each
    const none = await everyPage(fx, fx.agent.id, { project: 'TBED', search: 'zzz' })
    expect(none).toEqual({ rest: [], mcp: [], restPages: 5, mcpPages: 5 })
    const all = await everyPage(fx, fx.agent.id, { project: 'TBED' })
    expect(all.rest).toEqual(await archiveOrder(fx, subs))
    expect(all.restPages).toBe(5)
  })

  it('ends a page before a group whose walk does not fit, and starts the next with it', async () => {
    const fx = await setup()
    const task = (over: Partial<Doc<'issues'>>) =>
      plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })
    const first = await task({ archived_at: day(9), title: 'First' })
    const second = await task({ archived_at: day(9), title: 'Second' })
    const group = await task({ archived_at: day(8), title: 'Group' })
    await plantMany(fx, 30, { project_id: fx.sub.id, archived_at: day(7), parent_id: group.id })
    ARCHIVE_PAGE.ranges = 20
    const page = (cursor?: string) =>
      restArchivedPage(fx.t, { callerId: fx.agent.id, access: 'read', project: 'FW', cursor })
    const one = await page()
    expect(one.tasks.map((t) => t.id)).toEqual([second.id, first.id])
    expect(one.next_cursor).not.toBeNull()
    const two = await page(one.next_cursor ?? undefined)
    expect(two.tasks.map((t) => t.id)).toEqual([group.id])
    expect(two.tasks[0]).toMatchObject({ is_group: true })
    const rest = await everyPage(fx, fx.agent.id, { project: 'FW' })
    expect(rest.rest).toEqual(await archiveOrder(fx, [fx.sub.id]))
  })

  it('reads only the named project’s archive', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 80 } }))
    await plantMany(fx, 200, { project_id: fx.sub2.id, archived_at: day(1) })
    const own = await plantMany(fx, 20, { project_id: fx.sub.id, archived_at: day(2) })
    const page = await restArchivedPage(fx.t, {
      callerId: fx.agent.id,
      access: 'read',
      project: 'FW',
    })
    expect(page.tasks.map((t) => t.id).sort()).toEqual([...own].sort())
    expect(page.next_cursor).toBeNull()
  })

  it('finds every archived task through the active and archived project lists', async () => {
    const fx = await setup()
    const { subs } = await archive(fx)
    // an archived top-level project, and a reader who holds only FW and its
    // archived sub-project, so both top-level projects are navigation-only
    const oldMeta = await plantProject(fx.t, { org_id: fx.org.id, key: 'OLDM', archived_at: NOW })
    const oldSub = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: oldMeta.id,
      key: 'OLDS',
      archived_at: NOW,
    })
    for (let i = 0; i < 3; i++) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: oldSub.id, archived_at: day(i + 1) })
    }
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: oldSub.id, title: 'Active' })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.hidden.id, archived_at: NOW })
    const reader = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Reader', org_role: 'guest' })
    await grant(fx.t, fx.sub.id, reader.id)
    await grant(fx.t, oldSub.id, reader.id)

    /* The two steps the docs describe: list projects with and without the
     * archived flag, then page each top-level project's archived tasks. */
    const found = async (callerId: string) => {
      const restProjects = async (archived: string) =>
        await fx.t.query(internal.machine.rest.listProjects, { callerId, access: 'read', archived })
      const mcpProjects = async (archived: boolean) =>
        JSON.parse(
          await fx.t.query(internal.machine.mcp.listProjects, {
            callerId,
            access: 'read',
            archived,
          }),
        ) as { key: string; parent_id: string | null }[]
      const tops = [...(await restProjects('false')), ...(await restProjects('true'))]
        .filter((p) => p.parent_id === null)
        .map((p) => p.key)
      const mcpTops = [...(await mcpProjects(false)), ...(await mcpProjects(true))]
        .filter((p) => p.parent_id === null)
        .map((p) => p.key)
      expect(mcpTops).toEqual(tops)
      const rest: string[] = []
      const mcp: string[] = []
      for (const project of tops) {
        const pages = await everyPage(fx, callerId, { project, limit: 5 })
        rest.push(...pages.rest)
        mcp.push(...pages.mcp)
      }
      return { tops, rest: rest.sort(), mcp: mcp.sort() }
    }
    const every = await archiveOrder(fx, [...subs, oldSub.id, fx.hidden.id])
    expect(every).toHaveLength(29)
    const admin = await found(fx.admin.id)
    expect(admin.tops).toEqual(['SKNK', 'TBED', 'OLDM'])
    expect(admin).toMatchObject({ rest: [...every].sort(), mcp: [...every].sort() })
    const readable = (await archiveOrder(fx, [fx.sub.id, oldSub.id])).sort()
    const guest = await found(reader.id)
    expect(guest).toEqual({ tops: ['TBED', 'OLDM'], rest: readable, mcp: readable })
  })

  it('filters archived tasks like active ones', async () => {
    const fx = await setup()
    const thermal = uuid()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('labels', {
        id: thermal,
        org_id: fx.org.id,
        name: 'Thermal',
        name_lower: 'thermal',
        color: '#4C9AFF',
        created_at: NOW,
      })
    })
    const task = (over: Partial<Doc<'issues'>>) =>
      plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, archived_at: NOW, ...over })
    const group = await task({ title: 'Group', status: 'todo', assignee_id: fx.user.id })
    const child = await task({
      title: 'Child',
      status: 'todo',
      assignee_id: fx.guest.id,
      parent_id: group.id,
    })
    const leaf = await task({
      title: 'Leaf',
      status: 'done',
      priority: 'high',
      assignee_id: fx.user.id,
    })
    const review = await task({
      title: 'Review',
      status: 'review',
      assignee_id: fx.guest.id,
      reviewer_id: fx.user.id,
    })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('issue_labels', {
        org_id: fx.org.id,
        issue_id: leaf.id,
        label_id: thermal,
        task_archived: true,
      })
    })
    const ids = async (args: Record<string, string>) =>
      (
        await restArchivedPage(fx.t, {
          callerId: fx.agent.id,
          access: 'read',
          project: 'TBED',
          ...args,
        })
      ).tasks.map((t) => t.id)
    // newest created first, as they share one archive moment
    expect(await ids({})).toEqual([review.id, leaf.id, child.id, group.id])
    // a status filter leaves the group out
    expect(await ids({ status: 'todo' })).toEqual([child.id])
    expect(await ids({ status: 'todo,done' })).toEqual([leaf.id, child.id])
    // the reviewer owns the task in review; a group stays with its assignee
    expect(await ids({ owner: fx.user.id })).toEqual([review.id, leaf.id, group.id])
    expect(await ids({ priority: 'high' })).toEqual([leaf.id])
    expect(await ids({ assignee: fx.guest.id })).toEqual([review.id, child.id])
    // a label name, and a status name, which a group does not show
    expect(await ids({ search: 'therm' })).toEqual([leaf.id])
    expect(await ids({ search: 'to do' })).toEqual([child.id])
    const mcp = await mcpList<McpPage>(fx, fx.agent.id, {
      project: 'TBED',
      archived: true,
      status: ['todo'],
    })
    expect(mcp.tasks.map((t) => t.id)).toEqual([child.id])
  })
})
