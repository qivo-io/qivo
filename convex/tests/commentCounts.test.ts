/* The per-task comment cap and the count behind it (model/commentCounts.ts).
 *
 *   1. The cap: a task holds at most COMMENT_MAX comments on the app, REST
 *      and MCP alike. A task that had more keeps them. An archive reason is
 *      always posted.
 *   2. The count: a task is counted at its first post and kept on every
 *      post and delete. A thread too long for one post is counted in steps,
 *      with the posts made meanwhile, and a delete meanwhile restarts it.
 *      Counting a thread too large to read whole stays within the read
 *      limit.
 *
 * Comments planted raw stand for comments saved before the count existed. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal } from '../lib/functions'
import { sha256hex } from '../machine/auth'
import {
  assertRoomForComment,
  COMMENT_MAX,
  COUNT_BUDGET,
  TOO_MANY_COMMENTS,
} from '../model/commentCounts'
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

const SECRET = `qva_${'commentcap'.repeat(5)}`
const DEFAULT_BUDGET = { ...COUNT_BUDGET }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  Object.assign(COUNT_BUDGET, DEFAULT_BUDGET)
  vi.useRealTimers()
})

type Fx = OrgFixture & { t: T; task: Doc<'issues'> }

/* withOrg, with the agent holding Edit on TBED and an agent key, so REST and
 * MCP run over t.fetch, and a task in FW. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  const key_hash = await sha256hex(SECRET)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: f.agent.id,
      name: 'Comment cap',
      key_prefix: SECRET.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Long thread' })
  return { t, ...f, task }
}

/* `count` comments on `task` by the guest, planted raw, one second apart,
 * `perRun` to a transaction. */
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

const thread = (fx: Fx, task = fx.task): Promise<Doc<'comments'>[]> =>
  fx.t.run((ctx) =>
    ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .collect(),
  )

const countOf = (fx: Fx, task = fx.task) =>
  fx.t.run(async (ctx) => {
    const rows = await ctx.db
      .query('comment_counts')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .collect()
    return rows.map(({ count, cursor }) => ({ count, counting: cursor !== undefined }))
  })

const appPost = (fx: Fx, body = 'From the app', task = fx.task) =>
  as(fx.t, fx.user).mutation(api.comments.create, {
    org_id: fx.org.id,
    id: uuid(),
    issue_id: task.id,
    body,
  })

const appDelete = (fx: Fx, comment: Doc<'comments'>) =>
  as(fx.t, fx.admin).mutation(api.comments.remove, { org_id: fx.org.id, id: comment.id })

type Wire = { status: number; json: unknown }

async function send(
  fx: Fx,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Wire> {
  const http = fx.t as unknown as {
    fetch(
      path: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ): Promise<{ status: number; text(): Promise<string> }>
  }
  const res = await http.fetch(path, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text === '' ? null : JSON.parse(text) }
}

const restPost = (fx: Fx, body = 'From REST') =>
  send(fx, 'POST', `/v1/tasks/${fx.task.id}/comments`, { body })

type ToolResult = { content: { type: string; text: string }[]; isError?: true }

/* One MCP tools/call on the modern leg (plain JSON answers). */
async function tool(fx: Fx, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { status, json } = await send(
    fx,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'comment-cap', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      id: 1,
    },
    {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
  )
  expect(status).toBe(200)
  return (json as { result: ToolResult }).result
}

const mcpPost = (fx: Fx, body = 'From MCP') => tool(fx, 'add_comment', { ref: fx.task.id, body })

async function appRefused(p: Promise<unknown>): Promise<void> {
  const e = await expectRefusal(p, 'rule')
  expect((e.data as Refusal).message).toBe(TOO_MANY_COMMENTS)
}

/* ------------------------------------------------------------------ 1. cap */

describe('the comment cap', () => {
  it('refuses the comment after 400 on the app, REST and MCP, and posts again after a delete', async () => {
    const fx = await setup()
    await plantThread(fx, COMMENT_MAX - 1)
    await appPost(fx, 'The last one')
    expect(await countOf(fx)).toEqual([{ count: COMMENT_MAX, counting: false }])

    await appRefused(appPost(fx))
    expect(await restPost(fx)).toEqual({ status: 400, json: { error: TOO_MANY_COMMENTS } })
    expect(await mcpPost(fx)).toMatchObject({
      content: [{ type: 'text', text: TOO_MANY_COMMENTS }],
      isError: true,
    })
    expect(await thread(fx)).toHaveLength(COMMENT_MAX)
    expect(await countOf(fx)).toEqual([{ count: COMMENT_MAX, counting: false }])

    await appDelete(fx, (await thread(fx))[0])
    expect(await restPost(fx)).toMatchObject({ status: 201 })
    expect(await thread(fx)).toHaveLength(COMMENT_MAX)
    await appRefused(appPost(fx))
  })

  it('keeps the comments of a task that already holds more, and still edits and deletes them', async () => {
    const fx = await setup()
    await plantThread(fx, COMMENT_MAX + 50)
    await appRefused(appPost(fx))
    // the refused post stored nothing, not even the count
    expect(await countOf(fx)).toEqual([])
    const [first, second] = await thread(fx)
    await as(fx.t, fx.admin).mutation(api.comments.update, {
      org_id: fx.org.id,
      id: first.id,
      body: 'Edited',
    })
    await appDelete(fx, second)
    const after = await thread(fx)
    expect(after).toHaveLength(COMMENT_MAX + 49)
    expect(after[0].body).toBe('Edited')
    expect((await restPost(fx)).status).toBe(400)
  })

  it('posts the archive reason of a task at the cap, so archiving never fails on it', async () => {
    const fx = await setup()
    await plantThread(fx, COMMENT_MAX - 1)
    await appPost(fx)
    await as(fx.t, fx.user).mutation(api.issues.archive, {
      org_id: fx.org.id,
      id: fx.task.id,
      reason: 'Superseded by a new task',
    })
    const after = await thread(fx)
    expect(after).toHaveLength(COMMENT_MAX + 1)
    expect(after[after.length - 1].body).toBe('Superseded by a new task')
    expect(await countOf(fx)).toEqual([{ count: COMMENT_MAX + 1, counting: false }])

    // the machine archive, on a task over the cap that was never counted:
    // the reason is posted and no thread is read to count it
    const other = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    await plantThread(fx, COMMENT_MAX + 5, { task: other })
    expect(
      await send(fx, 'PATCH', `/v1/tasks/${other.id}`, {
        archived: true,
        archive_reason: 'Done elsewhere',
      }),
    ).toMatchObject({ status: 200, json: { archived: true } })
    expect(await thread(fx, other)).toHaveLength(COMMENT_MAX + 6)
    expect(await countOf(fx, other)).toEqual([])
  })
})

/* ---------------------------------------------------------------- 2. count */

describe('the count', () => {
  it('counts a task at its first post and keeps it on every surface', async () => {
    const fx = await setup()
    await plantThread(fx, 3)
    await appPost(fx)
    expect(await countOf(fx)).toEqual([{ count: 4, counting: false }])
    const viaRest = (await restPost(fx)).json as { id: string }
    const viaMcp = JSON.parse((await mcpPost(fx)).content[0].text) as { id: string }
    expect(await countOf(fx)).toEqual([{ count: 6, counting: false }])

    await appDelete(fx, (await thread(fx))[0])
    expect((await send(fx, 'DELETE', `/v1/comments/${viaRest.id}`)).status).toBe(200)
    expect(await tool(fx, 'delete_comment', { comment: viaMcp.id })).not.toHaveProperty('isError')
    expect(await thread(fx)).toHaveLength(3)
    expect(await countOf(fx)).toEqual([{ count: 3, counting: false }])
  })

  it('counts a long thread in steps, with the posts made meanwhile', async () => {
    const fx = await setup()
    await plantThread(fx, 10)
    // so a post and a step each count one comment
    Object.assign(COUNT_BUDGET, { post: 1, step: 1 })
    await appPost(fx)
    expect(await countOf(fx)).toEqual([{ count: 1, counting: true }])
    // a later post counts on, and the steps count it with the rest
    await appPost(fx)
    expect(await countOf(fx)).toEqual([{ count: 2, counting: true }])
    await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await thread(fx)).toHaveLength(12)
    expect(await countOf(fx)).toEqual([{ count: 12, counting: false }])
  })

  it('drops a count that a delete meets while it runs, and counts again at the next post', async () => {
    const fx = await setup()
    await plantThread(fx, 10)
    Object.assign(COUNT_BUDGET, { post: 1, step: 1 })
    await appPost(fx)
    await appDelete(fx, (await thread(fx))[6])
    expect(await countOf(fx)).toEqual([])
    // the steps the first post started find no count and end
    await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await countOf(fx)).toEqual([])
    await appPost(fx)
    await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await thread(fx)).toHaveLength(11)
    expect(await countOf(fx)).toEqual([{ count: 11, counting: false }])
  })

  it('lets a long thread over the cap take one comment while it is counted, then refuses', async () => {
    const fx = await setup()
    await plantThread(fx, COMMENT_MAX + 5)
    Object.assign(COUNT_BUDGET, { post: 1 })
    await appPost(fx)
    await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await countOf(fx)).toEqual([{ count: COMMENT_MAX + 6, counting: false }])
    await appRefused(appPost(fx))
  })

  it('counts a thread more than one transaction may read, within each read limit', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    // 20 comments of about 900 KB, as saved before bodies were capped
    await plantThread(fx, 20, { body: 'a'.repeat(900_000), perRun: 1 })
    const read = await fx.t.mutation(async (ctx) => {
      await assertRoomForComment(ctx, fx.task.id)
      return (await ctx.meta.getTransactionMetrics()).bytesRead.used
    })
    // the post's budget and the one comment that passes it
    expect(read).toBeGreaterThanOrEqual(COUNT_BUDGET.post)
    expect(read).toBeLessThan(COUNT_BUDGET.post + 1024 * 1024)
    expect(await countOf(fx)).toEqual([{ count: 3, counting: true }])
    await appPost(fx)
    await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await countOf(fx)).toEqual([{ count: 21, counting: false }])
  })

  it('ends the steps of a task deleted while it is counted', async () => {
    const fx = await setup()
    await plantThread(fx, 5)
    Object.assign(COUNT_BUDGET, { post: 1, step: 1 })
    await appPost(fx)
    await as(fx.t, fx.admin).mutation(api.issues.deleteDeep, { org_id: fx.org.id, id: fx.task.id })
    expect(await countOf(fx)).toEqual([])
    await fx.t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await countOf(fx)).toEqual([])
  })
})
