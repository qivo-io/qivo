/* REST GET /v1/tasks and MCP list_tasks over large archives
 * (lib/activeTaskPage.ts listActiveIssuesCore and lib/core.ts
 * listArchivedIssuesCore). An active list reads only active tasks, and its
 * search only the label assignments of the tasks it looks at. Archived
 * tasks are listed one project at a time. Both page with a cursor, so each
 * page reads a bounded amount whatever the archive holds. A single-task read
 * of an active group never reads archived tasks elsewhere, and one of any
 * group walks only as much of its subtree as the request can read. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACTIVE_PAGE, TASK_LIST_UNREADABLE } from '../lib/activeTaskPage'
import {
  ARCHIVE_LABELS,
  ARCHIVE_PAGE,
  ARCHIVE_RESERVE,
  ARCHIVED_SCOPE,
  type ArchiveCursor,
  archiveCursorText,
  archivedTasksAfter,
  cursorAfter,
  parseArchiveCursor,
} from '../lib/archivedTasks'
import { ARCHIVED_TOO_WIDE, TASK_READ_RESERVE } from '../lib/core'
import { byId } from '../lib/db'
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
  TODAY,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { countOrg } from './overviewCounts.setup'
import { withReach } from './projectReach.setup'
import { lowered, mcpPage, mcpPages, restPage, restPages } from './taskPages.setup'

/* Archive cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts), so every page with a next cursor needs one. */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'taskLists-test-secret-not-a-deployment-key'

type Fx = OrgFixture & { t: T }

/** Gives `profile_id` User access to `project_id`. */
const grant = (t: T, project_id: string, profile_id: string) =>
  t.run(async (ctx) => {
    await ctx.db.insert('project_access', { project_id, profile_id, level: 'user' })
  })

/* withOrg, with the agent holding Edit on TBED (FW and PCB). */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withReadingAdmin(t)
  await grant(t, f.meta.id, f.agent.id)
  return { t, ...f }
}

/** Expects `p` to be refused with `code` and exactly `sentence`. */
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
    await fx.t.query(internal.machine.mcp.listIssues, {
      today: TODAY,
      callerId,
      access: 'read',
      ...args,
    }),
  ) as Out

/** An archived page as MCP list_tasks answers it. */
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

/** 09:00 UTC on day `d` of March 2026, as an archive time. */
const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}T09:00:00.000Z`

/* An active page's budget and reserve lowered to fit a request of 100 or
 * 120 documents (lib/activeTaskPage.ts), whose page would otherwise be
 * refused with TASK_LIST_UNREADABLE before it reads anything. */
const smallPage = (documents: number) => ({
  page: { documents, delays: { ...ACTIVE_PAGE.delays, documents: 8 } },
  reserve: { documents: 16 },
})

describe('active task lists read active tasks only', () => {
  it('lists active tasks while hundreds of archived ones exist, on both surfaces', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 100 } }))
    await plantMany(fx, 300, { project_id: fx.sub.id, archived_at: NOW })
    const live = []
    for (const title of ['One', 'Two', 'Three']) {
      live.push(await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title }))
    }
    const ids = live.map((task) => task.id)
    await lowered(smallPage(40), async () => {
      // one page holds them all, so the archived tasks took none of its budget
      const rest = await restPage(fx.t, { callerId: fx.agent.id, access: 'read' })
      expect(rest.tasks.map((row) => row.id)).toEqual(ids)
      expect(rest.next_cursor).toBeNull()
      const mcp = await mcpPage(fx.t, { callerId: fx.agent.id, access: 'read', project: 'FW' })
      expect(mcp.tasks.map((row) => row.id)).toEqual(ids)
      expect(mcp.next_cursor).toBeNull()
    })
  })

  it('lists one project’s tasks and counts its completion past the ranges a page and a completion read, and fails the rest safely', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    // empty sub-projects of TBED, 30 with FW and PCB, the most one project
    // holds at the design size
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 28; i++) {
        await ctx.db.insert('projects', {
          id: uuid(),
          org_id: fx.org.id,
          type: 'project',
          parent_id: fx.meta.id,
          key: `E${i}`,
          name: `Empty ${i}`,
          description: '',
          sort_order: 1000 + i,
          num: 1000 + i,
          track_delay: false,
          created_at: NOW,
        })
      }
    })
    const task = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await countOrg(fx.t, fx.org.id)
    // a page's rows lowered to about ten ranges, fewer than the family's
    // projects, as thousands of projects pass the real ones
    await lowered({ page: { ranges: ACTIVE_PAGE.delays.ranges + 10 } }, async () => {
      // more projects than a page opens side by side is refused with the
      // sentence that says to name a project
      await refused(
        restTasks(fx.t, { callerId: fx.agent.id, access: 'read', limit: '1' }),
        'bad_request',
        TASK_LIST_UNREADABLE,
      )
      const rest = await restPage(fx.t, {
        callerId: fx.agent.id,
        access: 'read',
        project: 'FW',
        limit: '1',
      })
      expect(rest).toEqual({
        next_cursor: null,
        tasks: [expect.objectContaining({ id: task.id })],
      })
      const mcp = await mcpPage(fx.t, {
        callerId: fx.agent.id,
        access: 'read',
        project: 'FW',
        limit: 1,
      })
      expect(mcp.tasks.map((row) => row.id)).toEqual([task.id])
      expect(mcp.next_cursor).toBeNull()
    })
    // the completion reads the counts, FW's own and TBED's 30 sub-projects'
    for (const ref of ['FW', 'TBED']) {
      const project = await fx.t.query(internal.machine.rest.getProject, {
        callerId: fx.agent.id,
        access: 'read',
        ref,
      })
      expect(project.completion, ref).toEqual({ status: 'ok', done: 0, total: 1, percent: 0 })
    }
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
    // each task's own assignments, against the organization's scanned
    // labels and, past the scan, read label by label, within a page that
    // fits this request's 100 documents
    const scan = ARCHIVE_LABELS.scan
    try {
      for (const labels of [scan, 0]) {
        ARCHIVE_LABELS.scan = labels
        await lowered(smallPage(40), async () => {
          const args = { callerId: fx.agent.id, access: 'read' as const, search: 'bug' }
          const rest = await restPages(fx.t, args)
          expect(rest.rows.map((row) => row.id)).toEqual([plain.id, restored.id])
          const mcp = await mcpPages(fx.t, args)
          expect(mcp.rows.map((row) => row.id)).toEqual([plain.id, restored.id])
        })
      }
    } finally {
      ARCHIVE_LABELS.scan = scan
    }
  })

  it('reads a large group under an active task without the archive', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 100 } }))
    const before = { ...TASK_READ_RESERVE }
    TASK_READ_RESERVE.documents = 30
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
      const rest = await fx.t.query(internal.machine.rest.getIssue, {
        today: TODAY,
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
          today: TODAY,
          callerId: fx.agent.id,
          access: 'read',
          ref: root.id,
        }),
      ) as { subtasks: { id: string }[] }
      expect(mcp.subtasks.map((task) => task.id)).toEqual(kids.map((task) => task.id))
    } finally {
      Object.assign(TASK_READ_RESERVE, before)
    }
  })
})

describe('archived task lists page one project with a cursor', () => {
  const page = { ...ARCHIVE_PAGE }
  const reserve = { ...ARCHIVE_RESERVE }
  const expansion = { ...ARCHIVED_SCOPE }
  afterEach(() => {
    Object.assign(ARCHIVE_PAGE, page)
    Object.assign(ARCHIVE_RESERVE, reserve)
    Object.assign(ARCHIVED_SCOPE, expansion)
  })

  it('writes sealed cursors that read back, and refuses anything else', async () => {
    const cursor: ArchiveCursor = {
      created: 1760583600000.123,
      id: 'k57c3d4e5f6g7h8',
      archived_at: '2026-10-16T03:00:00.000Z',
    }
    const PID = '0b6f2c1e-4d3a-4b5c-9e8f-7a6b5c4d3e2f'
    const text = await archiveCursorText(cursor, PID)
    // sealed: the task's id and times do not show, and the same position
    // seals to the same text
    expect(text).toMatch(/^2~[0-9a-f]+$/)
    for (const part of ['k57c3d4e5f6g7h8', '1760583600000', '2026-10-16']) {
      expect(text).not.toContain(part)
    }
    expect(await archiveCursorText(cursor, PID)).toBe(text)
    expect(await parseArchiveCursor(text, PID)).toEqual(cursor)
    // a cursor pages only the project whose list it came from
    expect(await parseArchiveCursor(text, '1c7e3d2f-5e4b-4c6d-8f9a-8b7c6d5e4f3a')).toBeNull()
    // the archive time is taken verbatim, whatever it holds
    const odd: ArchiveCursor = { created: 5, id: 'k1', archived_at: 'a~b' }
    expect(await parseArchiveCursor(await archiveCursorText(odd, PID), PID)).toEqual(odd)
    // the longest position the parser accepts still reads back
    const longest: ArchiveCursor = {
      created: 1760583600000.1235,
      id: 'k'.repeat(64),
      archived_at: '\u{1F600}'.repeat(32),
    }
    expect(await parseArchiveCursor(await archiveCursorText(longest, PID), PID)).toEqual(longest)
    // a changed hex digit fails the tag
    const flipped = text.slice(0, -1) + (text.endsWith('0') ? '1' : '0')
    for (const bad of [
      // a plain position, even a valid one, is not a cursor a page gave out
      '1~1760583600000.123~k57c3d4e5f6g7h8~2026-10-16T03:00:00.000Z',
      '1~5~k1~a~b',
      'abc',
      '1~1~x',
      '2~1~k1~x',
      '1~-1~k1~x',
      '1~1~k1~',
      '1~1.~k1~x',
      '1~1~K1~x',
      `1~1~${'k'.repeat(65)}~x`,
      `1~1~k1~${'x'.repeat(65)}`,
      '2~',
      '2~00',
      `2~${'0'.repeat(64)}`,
      flipped,
      `${text}00`,
      text.toUpperCase(),
      `2~${'ab'.repeat(400)}`,
    ]) {
      expect(await parseArchiveCursor(bad, PID), bad).toBeNull()
    }
    // a cursor sealed under another secret does not open
    vi.stubEnv('BETTER_AUTH_SECRET', 'another-deployment-secret-for-this-test')
    try {
      expect(await parseArchiveCursor(text, PID)).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
    expect(await parseArchiveCursor(text, PID)).toEqual(cursor)
  })

  it('pages tasks that share both archive times one at a time, by id', async () => {
    // Convex does not promise distinct creation times, and its indexes order
    // tasks that share them by id
    type Row = {
      _id: string
      _creationTime: number
      archived_at?: string
      project_id: string
      org_id: string
    }
    type Field = keyof Row
    type Range = {
      eq(field: Field, value: unknown): Range
      gt(field: Field, value: unknown): Range
      lt(field: Field, value: unknown): Range
    }
    const compare = (a: unknown, b: unknown): number =>
      a === b
        ? 0
        : a === undefined
          ? -1
          : b === undefined
            ? 1
            : (a as string | number) < (b as string | number)
              ? -1
              : 1
    // an index read over `rows`, newest first, as Convex orders it
    const ctxOver = (rows: Row[]) => {
      const withIndex = (index: string, range: (q: Range) => unknown) => {
        const tests: ((row: Row) => boolean)[] = []
        const bound =
          (keeps: (order: number) => boolean) =>
          (field: Field, value: unknown): Range => {
            tests.push((row) => keeps(compare(row[field], value)))
            return q
          }
        const q: Range = {
          eq: bound((order) => order === 0),
          gt: bound((order) => order > 0),
          lt: bound((order) => order < 0),
        }
        range(q)
        const keys: Field[] = [
          index === 'by_project_archived' ? 'project_id' : 'org_id',
          'archived_at',
          '_creationTime',
          '_id',
        ]
        const found = rows
          .filter((row) => tests.every((test) => test(row)))
          .sort((a, b) => keys.reduce((c, key) => c || compare(b[key], a[key]), 0))
        return {
          order: () => ({
            async *[Symbol.asyncIterator]() {
              yield* found
            },
          }),
        }
      }
      return { db: { query: () => ({ withIndex }) } } as unknown as QueryCtx
    }
    const row = (id: string, project_id: string, archived_at: string, created: number): Row => ({
      _id: id,
      _creationTime: created,
      archived_at,
      project_id,
      org_id: 'org',
    })
    const ctx = ctxOver([
      row('k1', 'P', 'T', 100),
      row('k5', 'Q', 'T', 100),
      row('k3', 'P', 'T', 100),
      row('k4', 'Q', 'T', 100),
      row('k2', 'P', 'T', 100),
      row('a0', 'Q', 'T', 50),
      row('z9', 'P', 'U', 10),
      row('b0', 'Q', 'S', 900),
    ])
    // read through each project, the only read of every scope
    const seen: string[] = []
    let cursor: ArchiveCursor | null = null
    for (let page = 0; page < 20; page++) {
      const stream = await archivedTasksAfter(
        ctx,
        { orgId: 'org', projectIds: ['P', 'Q'] },
        cursor,
        async () => true,
      )
      if (stream === null) throw new Error('two projects open side by side')
      const task = await stream.next()
      await stream.close()
      if (task === null) break
      seen.push(task._id)
      cursor = cursorAfter(task)
    }
    expect(seen).toEqual(['z9', 'k5', 'k4', 'k3', 'k2', 'k1', 'a0', 'b0'])
    // projects that do not open side by side answer no stream
    expect(
      await archivedTasksAfter(
        ctx,
        { orgId: 'org', projectIds: ['P', 'Q'] },
        null,
        async () => false,
      ),
    ).toBeNull()
  })

  it('refuses archived lists without a project, offsets and foreign cursors', async () => {
    const fx = await setup()
    const rest = (args: Record<string, string>) =>
      fx.t.query(internal.machine.rest.listIssues, {
        today: TODAY,
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
    // a cursor without archived is an active list's, and one it did not
    // write is refused
    const foreign = 'cursor must be the next_cursor of an earlier page'
    for (const archived of [undefined, 'false']) {
      await refused(
        rest({ ...(archived === undefined ? {} : { archived }), cursor: '1~1~x' }),
        'bad_request',
        foreign,
      )
    }
    await refused(mcp({ archived: false, cursor: '1~1~x' }), 'bad_request', foreign)
    const offset = 'offset does not apply to archived tasks; pass next_cursor as cursor'
    // any value but 0
    for (const value of ['5', '-5', 'abc']) {
      await refused(rest({ archived: 'true', project: 'FW', offset: value }), 'bad_request', offset)
    }
    // an active list pages with a cursor too, and says so
    await refused(
      rest({ offset: 'abc' }),
      'bad_request',
      'offset does not apply to active tasks; pass next_cursor as cursor',
    )
    await refused(mcp({ archived: true, project: 'FW', offset: 5 }), 'bad_request', offset)
    // a plain position is refused too, so a caller cannot choose where a page starts
    for (const cursor of ['abc', '2~1~x', '1~-1~x', '1~1~', '1~5~k1~2026-03-01T09:00:00.000Z']) {
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
    expect(await rest({ cursor: '' })).toEqual({ next_cursor: null, tasks: [] })
    expect(await mcp({ archived: true, project: 'FW', offset: 0 })).toEqual({
      next_cursor: null,
      tasks: [],
    })
  })

  /* TBED with FW, PCB, DOC and the archived ARC, holding 25 archived tasks
   * and active ones. Six of the archived tasks share one moment across FW
   * and PCB. */
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

  it('refuses a scope that does not open side by side within its budget, for an admin as for anyone', async () => {
    const fx = await setup()
    // a top-level project outside TBED, archived most recently
    const secret = await plantProject(fx.t, { org_id: fx.org.id, type: 'meta', key: 'SEC' })
    const hidden: Doc<'issues'>[] = []
    for (let d = 20; d <= 23; d++) {
      hidden.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id: secret.id, archived_at: day(d) }),
      )
    }
    for (let d = 1; d <= 3; d++) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, archived_at: day(d) })
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub2.id, archived_at: day(d) })
    }
    // within the budget TBED's pages list its own tasks, never the hidden ones
    const all = await everyPage(fx, fx.agent.id, { project: 'TBED' })
    const expected = await archiveOrder(fx, [fx.sub.id, fx.sub2.id])
    expect(all.rest).toEqual(expected)
    expect(all.rest.some((id) => hidden.some((task) => task.id === id))).toBe(false)
    // a budget of one document fits no two of TBED's projects side by
    // side, so every page is refused, as none reads the organization's
    // archive: the agent's, who reads TBED, and the admin's alike
    ARCHIVE_PAGE.documents = 1
    for (const callerId of [fx.agent.id, fx.admin.id]) {
      await refused(
        restArchivedPage(fx.t, { callerId, access: 'read', project: 'TBED' }),
        'bad_request',
        ARCHIVED_TOO_WIDE,
      )
      await refused(
        mcpList(fx, callerId, { project: 'TBED', archived: true }),
        'bad_request',
        ARCHIVED_TOO_WIDE,
      )
    }
    // a sub-project alone always fits
    expect((await everyPage(fx, fx.agent.id, { project: 'FW' })).rest).toEqual(
      await archiveOrder(fx, [fx.sub.id]),
    )
  })

  it('refuses a cursor from another project’s list', async () => {
    const fx = await setup()
    for (let d = 1; d <= 3; d++) {
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, archived_at: day(d) })
      await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub2.id, archived_at: day(d) })
    }
    ARCHIVE_PAGE.tasks = 1
    const caller = { callerId: fx.agent.id, access: 'read' } as const
    const fw = await restArchivedPage(fx.t, { ...caller, project: 'FW' })
    const cursor = fw.next_cursor ?? ''
    expect(cursor).toMatch(/^2~/)
    const sentence = 'cursor must be the next_cursor of an earlier page'
    const rest = (project: string) =>
      fx.t.query(internal.machine.rest.listIssues, {
        today: TODAY,
        ...caller,
        archived: 'true',
        project,
        cursor,
      })
    await refused(rest('PCB'), 'bad_request', sentence)
    await refused(
      mcpList(fx, fx.agent.id, { project: 'PCB', archived: true, cursor }),
      'bad_request',
      sentence,
    )
    // the project it came from still pages with it, on either surface
    expect(((await rest('FW')) as { tasks: unknown[] }).tasks).toHaveLength(1)
    const mcp = await mcpList<McpPage>(fx, fx.agent.id, { project: 'FW', archived: true, cursor })
    expect(mcp.tasks).toHaveLength(1)
  })

  it('ends a page before a group whose subtasks do not fit, and starts the next with it', async () => {
    const fx = await setup()
    const task = (over: Partial<Doc<'issues'>>) =>
      plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })
    const first = await task({ archived_at: day(9), title: 'First' })
    const second = await task({ archived_at: day(9), title: 'Second' })
    const group = await task({ archived_at: day(8), title: 'Group' })
    await plantMany(fx, 30, { project_id: fx.sub.id, archived_at: day(7), parent_id: group.id })
    ARCHIVE_PAGE.documents = 30
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

  it('ends pages on the documents and bytes they read, and lists every task once', async () => {
    const fx = await setup()
    for (let d = 1; d <= 10; d++) {
      await plantIssue(fx.t, {
        org_id: fx.org.id,
        project_id: fx.sub.id,
        archived_at: day(d),
        description: 'x'.repeat(10_000),
      })
    }
    const expected = await archiveOrder(fx, [fx.sub.id])
    // a task with its 10,000-character text reads a little under 11 KB, so
    // a page ends on its bytes after its third task
    ARCHIVE_PAGE.bytes = 30 << 10
    const bytes = await everyPage(fx, fx.agent.id, { project: 'FW' })
    expect(bytes.rest).toEqual(expected)
    expect(bytes.mcp).toEqual(expected)
    expect(bytes.restPages).toBeGreaterThanOrEqual(4)
    ARCHIVE_PAGE.bytes = page.bytes
    ARCHIVE_PAGE.documents = 4
    const documents = await everyPage(fx, fx.agent.id, { project: 'FW' })
    expect(documents.rest).toEqual(expected)
    expect(documents.mcp).toEqual(expected)
    expect(documents.restPages).toBeGreaterThanOrEqual(3)
  })

  it('ends a page before a group whose subtasks would pass its bytes', async () => {
    const fx = await setup(newT({ transactionLimits: { bytesRead: 1 << 20 } }))
    ARCHIVE_PAGE.bytes = 32 << 10
    ARCHIVE_RESERVE.bytes = 4 << 10
    const tasks = await plantMany(fx, 45, { project_id: fx.sub.id, archived_at: day(9) })
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(8),
      title: 'Group',
    })
    // 60 subtasks under one group, which the 45 tasks before it leave no
    // room for
    const kids = await plantMany(fx, 60, {
      project_id: fx.sub.id,
      archived_at: day(7),
      parent_id: group.id,
      start_week: '2026-03-02',
      end_week: '2026-03-09',
    })
    const read = (cursor?: string) =>
      restArchivedPage(fx.t, { callerId: fx.agent.id, access: 'read', project: 'FW', cursor })
    const one = await read()
    expect(one.tasks.map((t) => t.id)).toEqual([...tasks].reverse())
    const two = await read(one.next_cursor ?? undefined)
    expect(two.tasks[0]).toMatchObject({
      id: group.id,
      is_group: true,
      start_week: '2026-03-02',
      end_week: '2026-03-09',
    })
    const all = await everyPage(fx, fx.agent.id, { project: 'FW' })
    expect(all.rest).toEqual([...[...tasks].reverse(), group.id, ...[...kids].reverse()])
    expect(all.mcp).toEqual(all.rest)
  })

  it('never reads the organization’s tasks for a large archived group', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 200 } }))
    await plantMany(fx, 250, { project_id: fx.sub2.id, archived_at: day(1) })
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
      title: 'Group',
    })
    const kids = []
    for (const week of ['2026-03-02', '2026-03-09', '2026-03-16']) {
      kids.push(
        await plantIssue(fx.t, {
          org_id: fx.org.id,
          project_id: fx.sub.id,
          parent_id: group.id,
          archived_at: day(8),
          start_week: week,
          end_week: week,
        }),
      )
    }
    // the page walks the group's subtree under its own ceiling, never the
    // organization's archived tasks
    const page = await restArchivedPage(fx.t, {
      callerId: fx.agent.id,
      access: 'read',
      project: 'FW',
    })
    expect(page.tasks.map((t) => t.id)).toEqual([group.id, ...kids.map((t) => t.id).reverse()])
    expect(page.tasks[0]).toMatchObject({
      is_group: true,
      start_week: '2026-03-02',
      end_week: '2026-03-16',
    })
    expect(page.next_cursor).toBeNull()
  })

  it('lists a group too large for one request without its plan weeks or progress, and moves on', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 200 } }))
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
      title: 'Group',
    })
    const kids = await plantMany(fx, 250, {
      project_id: fx.sub.id,
      archived_at: day(7),
      parent_id: group.id,
      start_week: '2026-03-02',
    })
    const first = await restArchivedPage(fx.t, {
      callerId: fx.agent.id,
      access: 'read',
      project: 'FW',
    })
    expect(first.tasks.map((t) => t.id)).toEqual([group.id])
    expect(first.tasks[0]).toMatchObject({
      is_group: true,
      start_week: null,
      end_week: null,
      progress: { done: 0, total: 0, percent: 0, partial: true },
    })
    expect(first.next_cursor).not.toBeNull()
    const all = await everyPage(fx, fx.agent.id, { project: 'FW' })
    expect(all.rest).toEqual([group.id, ...[...kids].reverse()])
    expect(all.mcp).toEqual(all.rest)
  })

  it('refuses a scope too wide to open project by project, for an admin as for anyone', async () => {
    const fx = await setup()
    const subs = [fx.sub.id, fx.sub2.id]
    for (let i = 0; i < 10; i++) {
      const sub = await plantProject(fx.t, {
        org_id: fx.org.id,
        type: 'project',
        parent_id: fx.meta.id,
        key: `W${i}`,
      })
      subs.push(sub.id)
    }
    // one task per sub-project, a day apart
    const tasks = []
    for (const [i, project_id] of subs.entries())
      tasks.push(
        await plantIssue(fx.t, { org_id: fx.org.id, project_id, archived_at: day(10 + i) }),
      )
    // a page lowered to 2 KiB fits a few of the tasks side by side, not
    // twelve, so the agent and the admin, who both read TBED and neither the
    // organization's archive, are refused
    ARCHIVE_PAGE.bytes = 2 * 1024
    for (const callerId of [fx.agent.id, fx.admin.id])
      for (const surface of ['rest', 'mcp'] as const)
        await refused(
          surface === 'rest'
            ? restArchivedPage(fx.t, { callerId, access: 'read', project: 'TBED' })
            : mcpList(fx, callerId, { project: 'TBED', archived: true }),
          'bad_request',
          ARCHIVED_TOO_WIDE,
        )
    // a sub-project alone fits
    expect((await everyPage(fx, fx.admin.id, { project: 'FW' })).rest).toEqual([tasks[0].id])
  })

  it('refuses a scope of more projects than one page merges for anyone, an admin included', async () => {
    const fx = await setup()
    const fw = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(2),
    })
    // TBED with FW and PCB is three projects
    ARCHIVED_SCOPE.subProjects = 2
    for (const surface of ['rest', 'mcp'] as const)
      await refused(
        surface === 'rest'
          ? restArchivedPage(fx.t, { callerId: fx.agent.id, access: 'read', project: 'TBED' })
          : mcpList(fx, fx.agent.id, { project: 'TBED', archived: true }),
        'bad_request',
        ARCHIVED_TOO_WIDE,
      )
    expect((await everyPage(fx, fx.agent.id, { project: 'FW' })).rest).toEqual([fw.id])
    await refused(
      restArchivedPage(fx.t, { callerId: fx.admin.id, access: 'read', project: 'TBED' }),
      'bad_request',
      ARCHIVED_TOO_WIDE,
    )
    expect((await everyPage(fx, fx.admin.id, { project: 'FW' })).rest).toEqual([fw.id])
  })

  it('leaves out a task stored under another organization', async () => {
    const fx = await setup()
    const own = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(2),
    })
    const foreign = await plantIssue(fx.t, {
      org_id: uuid(),
      project_id: fx.sub.id,
      archived_at: day(3),
    })
    const pages = await everyPage(fx, fx.agent.id, { project: 'FW' })
    expect(pages).toMatchObject({ rest: [own.id], mcp: [own.id] })
    // as the single-task read does
    await refused(
      fx.t.query(internal.machine.rest.getIssue, {
        today: TODAY,
        callerId: fx.agent.id,
        access: 'read',
        ref: foreign.id,
      }),
      'not_found',
      'task not found',
    )
  })

  it('reads only the named project’s archive', async () => {
    // room for FW's 20 tasks beside ARCHIVE_RESERVE's 128 documents, and too
    // little for a read of the organization's archive, which passes PCB's 200
    const fx = await setup(newT({ transactionLimits: { documentsRead: 250 } }))
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
    // an archived top-level project, which the admin leads, and a reader who
    // holds only FW and its archived sub-project, so both top-level
    // projects are navigation-only
    const oldMeta = await plantProject(fx.t, {
      org_id: fx.org.id,
      key: 'OLDM',
      archived_at: NOW,
      lead_id: fx.admin.id,
    })
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
    // the project lists read the reach rows
    await withReach(fx.t)

    /* The two steps the docs describe. Page projects with and without the
     * archived flag, then page each top-level project's archived tasks. */
    const found = async (callerId: string) => {
      const restProjects = async (archived: string) => {
        const rows: { key: string; parent_id: string | null }[] = []
        let cursor: string | undefined
        do {
          const page = await fx.t.query(internal.machine.rest.listProjects, {
            callerId,
            access: 'read',
            archived,
            limit: '2',
            cursor,
          })
          rows.push(...page.projects)
          cursor = page.next_cursor ?? undefined
        } while (cursor !== undefined)
        return rows
      }
      const mcpProjects = async (archived: boolean) => {
        const rows: { key: string; parent_id: string | null }[] = []
        let cursor: string | undefined
        do {
          const page = JSON.parse(
            await fx.t.query(internal.machine.mcp.listProjects, {
              callerId,
              access: 'read',
              archived,
              limit: 2,
              cursor,
            }),
          ) as { next_cursor: string | null; projects: { key: string; parent_id: string | null }[] }
          rows.push(...page.projects)
          cursor = page.next_cursor ?? undefined
        } while (cursor !== undefined)
        return rows
      }
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

describe('a single-task read of an archived group', () => {
  const reserve = { ...TASK_READ_RESERVE }
  afterEach(() => {
    Object.assign(TASK_READ_RESERVE, reserve)
  })

  /* REST GET /v1/tasks/{ref} and MCP get_task of `ref` as the agent. */
  const reads = async (fx: Fx, ref: string) => {
    const args = { today: TODAY, callerId: fx.agent.id, access: 'read' as const, ref }
    const rest = await fx.t.query(internal.machine.rest.getIssue, args)
    const mcp = JSON.parse(await fx.t.query(internal.machine.mcp.getIssue, args)) as Record<
      string,
      unknown
    >
    return { rest, mcp }
  }

  it('reads its subtasks in an organization whose archive passes what a request may read', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 400 } }))
    Object.assign(TASK_READ_RESERVE, { ranges: 16, documents: 64, bytes: 1 << 20 })
    // 500 archived tasks elsewhere, more documents than the request may read
    await plantMany(fx, 500, { project_id: fx.sub2.id, archived_at: day(1) })
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
      title: 'Group',
    })
    const kids = await plantMany(fx, 12, {
      project_id: fx.sub.id,
      archived_at: day(9),
      parent_id: group.id,
      status: 'todo',
      start_week: '2026-03-02',
      end_week: '2026-03-09',
      remaining_hours: 1,
    })
    const { rest, mcp } = await reads(fx, group.id)
    expect(rest).toMatchObject({
      is_group: true,
      start_week: '2026-03-02',
      end_week: '2026-03-09',
      progress: { done: 0, total: 12, percent: 0, partial: false },
      group_remaining_hours: 12,
    })
    expect(rest.subtasks.map((t) => t.id)).toEqual(kids)
    expect(mcp).toMatchObject({ is_group: true, group_remaining_hours: 12 })
    expect((mcp.subtasks as unknown[]).length).toBe(12)
  })

  it('reads the followers of a group too large to read before its subtasks take the room', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 400 } }))
    Object.assign(TASK_READ_RESERVE, { ranges: 16, documents: 64, bytes: 1 << 20 })
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
      title: 'Group',
    })
    // 450 unfinished subtasks with hours, more documents than the request
    // has left, and 60 followers, each one more profile read, more than the
    // reserve holds
    const kids = await plantMany(fx, 450, {
      project_id: fx.sub.id,
      archived_at: day(9),
      parent_id: group.id,
      status: 'todo',
      remaining_hours: 2,
    })
    const followers = await fx.t.run(async (ctx) => {
      const ids: string[] = []
      for (let i = 0; i < 60; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: fx.org.id,
          name: `Follower ${String(i).padStart(2, '0')}`,
          initials: 'FO',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
        })
        await ctx.db.insert('issue_subscriptions', {
          issue_id: group.id,
          profile_id: id,
          created_at: NOW,
        })
        ids.push(id)
      }
      return ids
    })
    const { rest, mcp } = await reads(fx, group.id)
    // the subtasks it read are not all of them, so it sums none of their hours
    expect(rest).toMatchObject({
      is_group: true,
      progress: { done: 0, total: 0, percent: 0, partial: true },
      group_remaining_hours: null,
      has_more_subtasks: true,
    })
    expect(mcp).toMatchObject({ is_group: true, group_remaining_hours: null })
    // first pages, read before the walk, each with its cursor
    expect(rest.subtasks.map((t) => t.id)).toEqual(kids.slice(0, 50))
    expect(rest.followers.map((p) => p.id)).toEqual(followers.slice(0, 50))
    expect(rest.followers_next_cursor).toEqual(expect.any(String))
    expect((mcp.followers as unknown[]).length).toBe(50)
  })

  it('archives a group whose answer does not fit after the cascade, and says it has more subtasks', async () => {
    // the cascade reads each subtask twice, which leaves the answer's walk
    // no room before the root's own subtasks, so it lists the first
    const fx = await setup(newT({ transactionLimits: { documentsRead: 800 } }))
    Object.assign(TASK_READ_RESERVE, { ranges: 16, documents: 500, bytes: 1 << 20 })
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Group',
    })
    const kids = await plantMany(fx, 100, { project_id: fx.sub.id, parent_id: group.id })
    const answer = await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'archive test',
      ref: group.id,
      body: JSON.stringify({ archived: true }),
    })
    expect(answer).toMatchObject({
      is_group: true,
      progress: { done: 0, total: 0, percent: 0, partial: true },
    })
    expect(answer.archived_at).not.toBeNull()
    expect(answer.has_more_subtasks).toBe(true)
    expect(answer.subtasks.map((t) => t.id)).toEqual(kids.slice(0, answer.subtasks.length))
    expect(answer.subtasks.length).toBeGreaterThan(0)
    const stored = await fx.t.run((ctx) => byId(ctx, 'issues', kids[99]))
    expect(stored?.archived_at).toBeDefined()
    // a read of the same group, which the cascade does not burden, is
    // whole, and lists its first 50 subtasks with a cursor for the rest
    const { rest } = await reads(fx, group.id)
    expect(rest).toMatchObject({
      progress: { total: 100, partial: false },
      has_more_subtasks: true,
    })
    expect(rest.subtasks.map((t) => t.id)).toEqual(kids.slice(0, 50))
  })

  it('lists the first subtasks of a group whose own subtasks do not fit, and says there are more', async () => {
    const fx = await setup(newT({ transactionLimits: { documentsRead: 400 } }))
    Object.assign(TASK_READ_RESERVE, { ranges: 16, documents: 64, bytes: 1 << 20 })
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
      title: 'Group',
    })
    const kids = await plantMany(fx, 450, {
      project_id: fx.sub.id,
      archived_at: day(9),
      parent_id: group.id,
    })
    const { rest, mcp } = await reads(fx, group.id)
    for (const read of [rest, mcp]) {
      expect(read).toMatchObject({ is_group: true, has_more_subtasks: true })
      const listed = (read.subtasks as { id: string }[]).map((t) => t.id)
      expect(listed.length).toBeGreaterThan(0)
      expect(listed).toEqual(kids.slice(0, listed.length))
    }
    // a group with none past what fits says so
    const small = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
    })
    const few = await plantMany(fx, 3, {
      project_id: fx.sub.id,
      archived_at: day(9),
      parent_id: small.id,
    })
    const { rest: whole } = await reads(fx, small.id)
    expect(whole).toMatchObject({ has_more_subtasks: false })
    expect(whole.subtasks.map((t) => t.id)).toEqual(few)
  })

  it('lists the first subtask of a group whose read has no index range left for it', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    // a reserve of every range Convex allows leaves the walk none
    Object.assign(TASK_READ_RESERVE, { ranges: 4096 })
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
      title: 'Group',
    })
    const kids = await plantMany(fx, 3, {
      project_id: fx.sub.id,
      archived_at: day(9),
      parent_id: group.id,
    })
    const { rest } = await reads(fx, group.id)
    expect(rest).toMatchObject({ is_group: true, has_more_subtasks: true })
    expect(rest.subtasks.map((t) => t.id)).toEqual(kids.slice(0, 1))
    // a group of one lists it and leaves nothing out
    const single = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      archived_at: day(9),
    })
    const only = await plantMany(fx, 1, {
      project_id: fx.sub.id,
      archived_at: day(9),
      parent_id: single.id,
    })
    // a group of one lists it; the page had no room to look further, so its
    // cursor is set and the next page answers the end
    const { rest: one } = await reads(fx, single.id)
    expect(one).toMatchObject({ is_group: true, has_more_subtasks: true })
    expect(one.subtasks.map((t) => t.id)).toEqual(only)
    expect(
      await fx.t.query(internal.machine.records.restListSubtasks, {
        callerId: fx.agent.id,
        access: 'read',
        ref: single.id,
        cursor: one.subtasks_next_cursor ?? undefined,
      }),
    ).toEqual({ next_cursor: null, subtasks: [] })
  })

  it('reads and archives a group whose subtasks pass what a request may read', async () => {
    // a request may read 2 MiB and 160 KiB, room for the archive's patch of
    // each active subtask, which needs two rows at Convex's document size
    // limit, and the walk keeps 2 MiB and 64 KiB of it back for the reads
    // after it
    const fx = await setup(newT({ transactionLimits: { bytesRead: (2 << 20) + (160 << 10) } }))
    TASK_READ_RESERVE.bytes = (2 << 20) + (64 << 10)
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      title: 'Large group',
    })
    // 30 active and 300 archived subtasks, more than the walk may read
    await plantMany(fx, 30, { project_id: fx.sub.id, parent_id: group.id })
    await plantMany(fx, 300, { project_id: fx.sub.id, parent_id: group.id, archived_at: day(9) })
    const answer = await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'archive test',
      ref: group.id,
      body: JSON.stringify({ archived: true }),
    })
    expect(answer).toMatchObject({ is_group: true, has_more_subtasks: true })
    expect(answer.archived_at).not.toBeNull()
    expect(answer.subtasks.length).toBeGreaterThan(0)
    const { rest, mcp } = await reads(fx, group.id)
    for (const read of [rest, mcp]) {
      expect(read).toMatchObject({
        is_group: true,
        has_more_subtasks: true,
        progress: { total: 0, partial: true },
      })
      expect((read.subtasks as unknown[]).length).toBeLessThan(330)
    }
  })
})
