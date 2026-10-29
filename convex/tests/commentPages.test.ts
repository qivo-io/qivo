/* Paged comment reads (model/comments.ts newestComments). REST
 * GET /v1/tasks/{ref}/comments and MCP list_comments answer the newest
 * comments, oldest first, with `limit` and `before`. The app's task window
 * subscribes to snapshot.threadComments, the newest COMMENT_PAGE_MAX and
 * whether earlier ones exist, and reads earlier pages with
 * snapshot.commentsBefore (model/comments.ts threadPage).
 *
 *   1. Paging: a long thread walks back page by page to an empty page on
 *      both surfaces, a short one answers whole, and the input rules. The
 *      app's pages say exactly when the start of the thread is loaded.
 *   2. Bytes: comments near Convex's 1 MiB document limit fill a page by
 *      size, and every read stays within the transaction's read limit,
 *      where reading the whole thread did not.
 *   3. Ties: comments that share a _creationTime are neither skipped nor
 *      repeated at a read or page boundary, and long ones keep a page
 *      within its byte bound.
 *   4. Over HTTP: the REST route passes its query parameters, and MCP
 *      answers an out-of-range `limit` with the same sentence as REST. */
/// <reference types="vite/client" />

import { getDocumentSize } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { BEFORE_NOT_A_COMMENT } from '../lib/core'
import type { Refusal, RefusalCode } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { sha256hex } from '../machine/auth'
import { COMMENT_PAGE_BYTES, COMMENT_PAGE_MAX, newestComments, threadPage } from '../model/comments'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

type Fx = OrgFixture & { t: T; task: Doc<'issues'> }

/* withOrg, with the agent holding Edit on TBED and a task in FW. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Long thread' })
  return { t, ...f, task }
}

/* `count` comments on `task` by the guest, one second apart, with bodies
 * `#0`, `#1`, … in posting order, or `body` for all of them. */
async function plantThread(
  fx: Fx,
  count: number,
  o: { task?: Doc<'issues'>; body?: string; perRun?: number } = {},
): Promise<void> {
  const perRun = o.perRun ?? count
  for (let start = 0; start < count; start += perRun) {
    await fx.t.run(async (ctx) => {
      for (let n = start; n < Math.min(count, start + perRun); n++) {
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: (o.task ?? fx.task).id,
          author: fx.guest.id,
          body: o.body ?? `#${n}`,
          created_at: new Date(Date.parse(NOW) + n * 1000).toISOString(),
        })
      }
    })
  }
}

/* The labels `#from` up to `#to - 1`. */
const bodies = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, n) => `#${from + n}`)

const restPage = (fx: Fx, page: { limit?: string; before?: string } = {}) =>
  fx.t.query(internal.machine.rest.listComments, {
    callerId: fx.agent.id,
    access: 'read',
    ref: `QN-${fx.task.num}`,
    ...page,
  })

const mcpPage = async (fx: Fx, page: { limit?: number; before?: string } = {}) =>
  JSON.parse(
    await fx.t.query(internal.machine.mcp.listComments, {
      callerId: fx.agent.id,
      access: 'read',
      ref: `QN-${fx.task.num}`,
      ...page,
    }),
  ) as { id: string; body: string }[]

/* The app's live thread and, with `before`, an earlier page, as bodies
 * and whether the thread holds earlier comments. */
async function appPage(fx: Fx, before?: string) {
  const page =
    before === undefined
      ? await as(fx.t, fx.guest).query(api.snapshot.threadComments, {
          org_id: fx.org.id,
          issue_id: fx.task.id,
        })
      : await as(fx.t, fx.guest).query(api.snapshot.commentsBefore, {
          org_id: fx.org.id,
          issue_id: fx.task.id,
          before,
        })
  return { ...page, bodies: page.comments.map((c) => c.body) }
}

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

/* --------------------------------------------------------------- 1. paging */

describe('paging a thread', () => {
  it('walks 120 comments back in pages of 50, 50 and 20, then an empty page, on both surfaces', async () => {
    const fx = await setup()
    await plantThread(fx, 120)
    const expected = [bodies(70, 120), bodies(20, 70), bodies(0, 20), []]
    let before: string | undefined
    for (const want of expected) {
      const page = await restPage(fx, before === undefined ? {} : { before })
      expect(page.map((c) => c.body)).toEqual(want)
      before = page[0]?.id
    }
    before = undefined
    for (const want of expected) {
      const page = await mcpPage(fx, before === undefined ? {} : { before })
      expect(page.map((c) => c.body)).toEqual(want)
      before = page[0]?.id
    }
  })

  it('limit takes fewer, and a short thread answers whole', async () => {
    const fx = await setup()
    await plantThread(fx, 3)
    expect((await restPage(fx)).map((c) => c.body)).toEqual(['#0', '#1', '#2'])
    expect((await mcpPage(fx)).map((c) => c.body)).toEqual(['#0', '#1', '#2'])
    expect((await restPage(fx, { limit: '1' })).map((c) => c.body)).toEqual(['#2'])
    const two = await mcpPage(fx, { limit: 2 })
    expect(two.map((c) => c.body)).toEqual(['#1', '#2'])
    // the id of a comment on this task is accepted in any case
    const rest = await restPage(fx, { limit: '50', before: two[0].id.toUpperCase() })
    expect(rest.map((c) => c.body)).toEqual(['#0'])
  })

  it('refuses a limit outside 1 to 50 and a before that is not a comment on this task', async () => {
    const fx = await setup()
    await plantThread(fx, 2)
    const other = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantThread(fx, 1, { task: other })
    const elsewhere = await fx.t.run((ctx) =>
      ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', other.id))
        .first(),
    )
    for (const limit of ['0', '51', 'abc', '', '1.5', '-1']) {
      await refused(restPage(fx, { limit }), 'rule', LIMITS.listComments.refusal)
    }
    for (const before of [elsewhere?.id ?? '', uuid(), 'xyz', '']) {
      await refused(restPage(fx, { before }), 'bad_request', BEFORE_NOT_A_COMMENT)
      await refused(mcpPage(fx, { before }), 'bad_request', BEFORE_NOT_A_COMMENT)
    }
  })

  it("the app's thread walks back to its start, and says when it is loaded", async () => {
    const fx = await setup()
    await plantThread(fx, 120)
    const expected = [
      { bodies: bodies(70, 120), earlier: true },
      { bodies: bodies(20, 70), earlier: true },
      { bodies: bodies(0, 20), earlier: false },
    ]
    let before: string | undefined
    for (const want of expected) {
      const page = await appPage(fx, before)
      expect({ bodies: page.bodies, earlier: page.earlier }).toEqual(want)
      // pure app rows, without Convex's system fields
      expect(Object.keys(page.comments[0]).sort()).toEqual(
        ['author', 'body', 'created_at', 'id', 'issue_id'].sort(),
      )
      before = page.comments[0].id
    }
    // before the first comment, there is nothing
    expect(await appPage(fx, before)).toMatchObject({ comments: [], earlier: false })
  })

  it("the app's thread is complete at exactly COMMENT_PAGE_MAX comments, and not at one more", async () => {
    const fx = await setup()
    await plantThread(fx, COMMENT_PAGE_MAX)
    expect(await appPage(fx)).toMatchObject({ earlier: false })
    await plantThread(fx, 1)
    const newest = await appPage(fx)
    expect(newest.earlier).toBe(true)
    const rest = await appPage(fx, newest.comments[0].id)
    expect(rest).toMatchObject({ bodies: ['#0'], earlier: false })
    const empty = await setup()
    expect(await appPage(empty)).toMatchObject({ comments: [], earlier: false })
  })

  it('answers the comment page and no history', async () => {
    const fx = await setup()
    await plantThread(fx, 70)
    const args = { org_id: fx.org.id, issue_id: fx.task.id }
    const live = await as(fx.t, fx.guest).query(api.snapshot.threadComments, args)
    expect(Object.keys(live).sort()).toEqual(['comments', 'earlier'])
    expect(live).toMatchObject({ earlier: true })
  })

  it("the app's pages keep the thread's order, so the first comment is the next before", async () => {
    const fx = await setup()
    // posted in this order, with created_at running backwards
    await fx.t.run(async (ctx) => {
      for (let n = 0; n < COMMENT_PAGE_MAX + 2; n++) {
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: fx.task.id,
          author: fx.guest.id,
          body: `#${n}`,
          created_at: new Date(Date.parse(NOW) - n * 1000).toISOString(),
        })
      }
    })
    const newest = await appPage(fx)
    expect(newest.bodies).toEqual(bodies(2, COMMENT_PAGE_MAX + 2))
    expect((await appPage(fx, newest.comments[0].id)).bodies).toEqual(['#0', '#1'])
  })

  it("REST and MCP pages keep the thread's order too, so a walk meets each comment once", async () => {
    const fx = await setup()
    // posted in this order, with created_at running backwards, as an
    // import that set the times could store them
    await fx.t.run(async (ctx) => {
      for (let n = 0; n < 5; n++) {
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: fx.task.id,
          author: fx.guest.id,
          body: `#${n}`,
          created_at: new Date(Date.parse(NOW) - n * 1000).toISOString(),
        })
      }
    })
    for (const page of [
      async (before?: string) =>
        (await restPage(fx, { limit: '2', before })) as { id: string; body: string }[],
      (before?: string) => mcpPage(fx, { limit: 2, before }),
    ]) {
      const seen: string[][] = []
      let before: string | undefined
      for (let rows = await page(); rows.length > 0; rows = await page(before)) {
        seen.push(rows.map((c) => c.body))
        before = rows[0].id
      }
      expect(seen).toEqual([['#3', '#4'], ['#1', '#2'], ['#0']])
    }
  })

  it('an earlier page refuses a before that is not a comment on this task, deleted ones included', async () => {
    const fx = await setup()
    await plantThread(fx, 2)
    const other = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantThread(fx, 1, { task: other })
    const [elsewhere, gone] = await fx.t.run(async (ctx) => {
      const foreign = await ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', other.id))
        .first()
      const first = await ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', fx.task.id))
        .first()
      if (first === null || foreign === null) throw new Error('missing comments')
      await ctx.db.delete(first._id)
      return [foreign.id, first.id]
    })
    for (const before of [elsewhere, gone, uuid(), 'xyz']) {
      await refused(appPage(fx, before), 'bad_request', BEFORE_NOT_A_COMMENT)
    }
  })
})

/* ---------------------------------------------------------------- 2. bytes */

describe('pages bounded by bytes', () => {
  // 20 comments of about 900 KB each, as saved before bodies were capped:
  // about 18 MB in all, more than one transaction may read
  const LARGE = 'a'.repeat(900_000)

  async function largeThread(): Promise<Fx> {
    const fx = await setup(newT({ transactionLimits: true }))
    await plantThread(fx, 20, { body: LARGE, perRun: 1 })
    return fx
  }

  it('the thread is more than one transaction may read whole', async () => {
    const fx = await largeThread()
    await expect(
      fx.t.query((ctx) =>
        ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', fx.task.id))
          .collect(),
      ),
    ).rejects.toThrow(/Read too much data/)
  })

  it('a page stops at its byte budget, and walking before reaches every comment once', async () => {
    const fx = await largeThread()
    const seen: string[] = []
    let before: string | undefined
    for (;;) {
      const page = await restPage(fx, before === undefined ? {} : { before })
      if (page.length === 0) break
      expect(page.length).toBeLessThan(20)
      seen.unshift(...page.map((c) => c.id))
      before = page[0].id
    }
    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
    const mcp = await mcpPage(fx)
    expect(mcp.length).toBeGreaterThan(0)
    expect(mcp.length).toBeLessThan(20)
  })

  it('one page reads at most one comment past COMMENT_PAGE_BYTES besides its reread', async () => {
    const fx = await largeThread()
    const { rows, bytesRead } = await fx.t.query(async (ctx) => {
      const page = await newestComments(ctx, fx.task.id, { limit: COMMENT_PAGE_MAX })
      return {
        rows: page.length,
        bytesRead: (await ctx.meta.getTransactionMetrics()).bytesRead.used,
      }
    })
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(20)
    expect(bytesRead).toBeGreaterThanOrEqual(COMMENT_PAGE_BYTES)
    expect(bytesRead).toBeLessThan(COMMENT_PAGE_BYTES + 2 * 1024 * 1024)
  })

  it("the app's pages walk to the start within the read limit, each comment once", async () => {
    const fx = await largeThread()
    const seen: string[] = []
    let before: string | undefined
    for (;;) {
      const page = await appPage(fx, before)
      expect(page.comments.length).toBeGreaterThan(0)
      expect(page.comments.length).toBeLessThan(20)
      seen.unshift(...page.comments.map((c) => c.id))
      if (!page.earlier) break
      before = page.comments[0].id
    }
    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
  })

  it("the app's thread loads the newest comments that fit", async () => {
    const fx = await largeThread()
    const { comments, earlier } = await appPage(fx)
    expect(comments.length).toBeGreaterThan(0)
    expect(comments.length).toBeLessThan(20)
    expect(earlier).toBe(true)
    expect(comments[comments.length - 1].created_at).toBe(
      new Date(Date.parse(NOW) + 19 * 1000).toISOString(),
    )
  })
})

/* ----------------------------------------------------------------- 3. ties */

/* The range newestComments asks the by_issue index for. */
type Range = { eq?: number; lt?: number; lte?: number }
type RangeBuilder = {
  eq(field: string, value: string | number): RangeBuilder
  lt(field: string, value: number): RangeBuilder
  lte(field: string, value: number): RangeBuilder
  range: Range
}
const rangeOf = (range: Range): RangeBuilder => ({
  eq: (field, value) =>
    rangeOf(field === '_creationTime' ? { ...range, eq: value as number } : range),
  lt: (_, value) => rangeOf({ ...range, lt: value }),
  lte: (_, value) => rangeOf({ ...range, lte: value }),
  range,
})

/* A QueryCtx holding one task's `thread` and nothing else, ordered as the
 * by_issue index orders it, _creationTime and then the document id. Convex
 * can give two comments the same _creationTime, and convex-test never does,
 * so ties are tested on this. `read()` is the bytes its reads returned, as
 * Convex counts them toward the read limit. */
function threadCtx(thread: Doc<'comments'>[]): { ctx: QueryCtx; read: () => number } {
  const newestFirst = [...thread].sort(
    (a, b) => b._creationTime - a._creationTime || (a._id < b._id ? 1 : -1),
  )
  let read = 0
  const answer = (rows: Doc<'comments'>[]) => {
    for (const row of rows) read += getDocumentSize(row)
    return rows
  }
  const query = () => ({
    withIndex: (_index: string, build: (q: RangeBuilder) => RangeBuilder) => {
      const { eq, lt, lte } = build(rangeOf({})).range
      const rows = newestFirst.filter(
        (c) =>
          (eq === undefined || c._creationTime === eq) &&
          (lt === undefined || c._creationTime < lt) &&
          (lte === undefined || c._creationTime <= lte),
      )
      return {
        order: (direction: 'asc' | 'desc') => {
          const ordered = direction === 'asc' ? [...rows].reverse() : rows
          return {
            take: async (n: number) => answer(ordered.slice(0, n)),
            collect: async () => answer(ordered),
            first: async () => answer(ordered.slice(0, 1))[0] ?? null,
          }
        },
      }
    },
  })
  return { ctx: { db: { query } } as unknown as QueryCtx, read: () => read }
}

/* A comment on the fake thread, at `time`, with `body`. */
const fakeComment = (n: number, time: number, body = `#${n}`): Doc<'comments'> =>
  ({
    _id: `c${String(n).padStart(2, '0')}`,
    _creationTime: time,
    id: uuid(),
    issue_id: 'task',
    author: 'guest',
    body,
    created_at: NOW,
  }) as unknown as Doc<'comments'>

describe('comments that share a _creationTime', () => {
  // 13 comments, three to an instant, so the first page's second index read
  // and many page boundaries fall inside a group of equal times
  const thread = Array.from({ length: 13 }, (_, n) => fakeComment(n, 1_000 + Math.floor(n / 3)))
  const newestFirst = bodies(0, 13).reverse()

  it('a page answers each of them', async () => {
    const { ctx } = threadCtx(thread)
    const page = await newestComments(ctx, 'task', { limit: COMMENT_PAGE_MAX })
    expect(page.map((c) => c.body)).toEqual(newestFirst)
  })

  it('walking before visits each of them once, whatever the page size', async () => {
    const { ctx } = threadCtx(thread)
    for (const limit of [1, 2, 4, 5]) {
      const seen: string[] = []
      let before: Doc<'comments'> | undefined
      for (;;) {
        const page = await newestComments(ctx, 'task', { limit, before })
        if (page.length === 0) break
        seen.push(...page.map((c) => c.body))
        before = page[page.length - 1]
      }
      expect(seen).toEqual(newestFirst)
    }
  })

  it('a group of long comments that share a time keeps a page within its byte bound', async () => {
    // four older comments, then nine of about 900 KB that share one time
    const LARGE = 'a'.repeat(900_000)
    const long = [
      ...Array.from({ length: 4 }, (_, n) => fakeComment(n, 1_000 + n, LARGE)),
      ...Array.from({ length: 9 }, (_, n) => fakeComment(4 + n, 2_000, LARGE)),
    ]
    const tiedBytes = long.slice(4).reduce((sum, c) => sum + getDocumentSize(c), 0)
    const newest = threadCtx(long)
    const first = await newestComments(newest.ctx, 'task', { limit: COMMENT_PAGE_MAX })
    expect(first.length).toBeGreaterThan(0)
    expect(newest.read()).toBeLessThan(COMMENT_PAGE_BYTES + 1024 * 1024)
    // before the oldest of the group, the page reads the group once and
    // then one comment, which a read limit of 16 MiB allows
    const earlier = threadCtx(long)
    const page = await newestComments(earlier.ctx, 'task', {
      limit: COMMENT_PAGE_MAX,
      before: long[4],
    })
    expect(page.map((c) => c._id)).toEqual(['c03'])
    expect(earlier.read()).toBeLessThan(tiedBytes + 1024 * 1024)
  })

  it("the app's thread has earlier comments when they share the time of its first", async () => {
    // the first three comments share one instant, and the newest page
    // stops at the third of them
    const thread = Array.from({ length: COMMENT_PAGE_MAX + 2 }, (_, n) =>
      fakeComment(n, 1_000 + Math.max(0, n - 2)),
    )
    const { ctx } = threadCtx(thread)
    const newest = await threadPage(ctx, 'task')
    expect(newest.comments[0]._id).toBe('c02')
    expect(newest.earlier).toBe(true)
    const rest = await threadPage(ctx, 'task', newest.comments[0])
    expect(rest.comments.map((c) => c._id)).toEqual(['c00', 'c01'])
    expect(rest.earlier).toBe(false)
  })
})

/* ------------------------------------------------------------ 4. over HTTP */

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
type Fetched = { status: number; text(): Promise<string> }
const fetchOf = (t: T) =>
  (t as unknown as { fetch(path: string, init?: FetchInit): Promise<Fetched> }).fetch

async function plantKey(fx: Fx): Promise<string> {
  const secret = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const key_hash = await sha256hex(secret)
  await fx.t.run((ctx) =>
    ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: fx.agent.id,
      name: 'Paging key',
      key_prefix: secret.slice(0, 11),
      key_hash,
      created_at: NOW,
    }),
  )
  return secret
}

describe('over HTTP', () => {
  it('REST and MCP pass limit and before and answer the same limit sentence', async () => {
    const fx = await setup()
    await plantThread(fx, 5)
    const secret = await plantKey(fx)
    const auth = { Authorization: `Bearer ${secret}` }
    const get = async (query: string) => {
      const res = await fetchOf(fx.t)(`/v1/tasks/QN-${fx.task.num}/comments${query}`, {
        method: 'GET',
        headers: auth,
      })
      return { status: res.status, body: JSON.parse(await res.text()) }
    }
    const newest = await get('?limit=2')
    expect(newest.status).toBe(200)
    expect(newest.body.map((c: { body: string }) => c.body)).toEqual(['#3', '#4'])
    const earlier = await get(`?limit=2&before=${newest.body[0].id}`)
    expect(earlier.body.map((c: { body: string }) => c.body)).toEqual(['#1', '#2'])
    expect(await get('?limit=500')).toEqual({
      status: 400,
      body: { error: LIMITS.listComments.refusal },
    })
    expect(await get(`?before=${uuid()}`)).toEqual({
      status: 400,
      body: { error: BEFORE_NOT_A_COMMENT },
    })

    const call = async (args: Record<string, unknown>) => {
      const res = await fetchOf(fx.t)('/mcp', {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'list_comments',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'list_comments',
            arguments: { ref: `QN-${fx.task.num}`, ...args },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'paging', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
          id: 1,
        }),
      })
      expect(res.status).toBe(200)
      return JSON.parse(await res.text()).result as {
        content: { text: string }[]
        isError?: boolean
      }
    }
    const one = await call({ limit: 1 })
    expect(one.isError).toBeUndefined()
    expect(JSON.parse(one.content[0].text).map((c: { body: string }) => c.body)).toEqual(['#4'])
    // the server checks the range and answers the limit's sentence, as REST does
    for (const limit of [51, 0]) {
      expect(await call({ limit })).toMatchObject({
        content: [{ type: 'text', text: LIMITS.listComments.refusal }],
        isError: true,
      })
    }
    // the schema still refuses a limit that is not a number
    const text = await call({ limit: '2' })
    expect(text.isError).toBe(true)
    expect(text.content[0].text).toBe(
      'Input validation error: Invalid arguments for tool list_comments: limit: Invalid input: expected number, received string',
    )
    const wrong = await call({ before: uuid() })
    expect(wrong).toMatchObject({
      content: [{ type: 'text', text: BEFORE_NOT_A_COMMENT }],
      isError: true,
    })
  })
})
