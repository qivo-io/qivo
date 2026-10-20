/* The 20,000-character cap on task descriptions, comment bodies and archive
 * reasons (lib/textLimits.ts). The model layer enforces it for the app, REST
 * and MCP alike, and MCP's tool schemas declare it as maxLength. Lengths are
 * UTF-16 code units. Rows saved before the cap are planted raw, so they can
 * be longer, and they keep working. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { TEXT_MAX } from '../lib/textLimits'
import { sha256hex } from '../machine/auth'
import { ARCHIVE_REASON_TOO_LONG, COMMENT_TOO_LONG } from '../model/comments'
import { DESCRIPTION_TOO_LONG } from '../model/issues'
import {
  as,
  countersFor,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const AT_CAP = 'a'.repeat(TEXT_MAX)
const OVER = 'a'.repeat(TEXT_MAX + 1)
// 10,000 code points that are 20,000 code units. A code point count would
// also let the one-letter-longer text through
const EMOJI_AT_CAP = '😀'.repeat(TEXT_MAX / 2)
const LEGACY = 'b'.repeat(25_000)

const issueRow = (t: T, id: string): Promise<Doc<'issues'> | null> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
  )

const commentRow = (t: T, id: string): Promise<Doc<'comments'> | null> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('comments')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
  )

const commentsOn = (t: T, issueId: string): Promise<Doc<'comments'>[]> =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
        .collect(),
  )

/* A comment planted raw, so it may be longer than the cap. */
async function plantComment(t: T, issueId: string, author: string, body: string) {
  const id = uuid()
  await t.run(async (ctx) => {
    await ctx.db.insert('comments', { id, issue_id: issueId, author, body, created_at: NOW })
  })
  return id
}

describe('task descriptions in the app', () => {
  it('stores exactly 20,000 characters, with emoji counting two each', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const description of [AT_CAP, EMOJI_AT_CAP]) {
      const id = uuid()
      await as(t, f.user).mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title: 'Long brief',
        description,
      })
      expect((await issueRow(t, id))?.description).toBe(description)
    }
  })

  it('refuses one character more at create, writing nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const description of [OVER, `${EMOJI_AT_CAP}a`]) {
      const id = uuid()
      const e = await expectRefusal(
        as(t, f.user).mutation(api.issues.create, {
          org_id: f.org.id,
          id,
          project_id: f.sub.id,
          title: 'Too long',
          description,
        }),
        'rule',
      )
      expect(e.data.message).toBe(DESCRIPTION_TOO_LONG)
      expect(await issueRow(t, id)).toBeNull()
    }
    expect((await countersFor(t, f.org.id)).next_issue_num).toBe(1)
  })

  it('updates to exactly 20,000 or to null, and refuses 20,001 leaving the text', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: 'x' })
    const update = (description: string | null) =>
      as(t, f.user).mutation(api.issues.update, {
        org_id: f.org.id,
        id: task.id,
        patch: { description },
      })
    await update(AT_CAP)
    expect((await issueRow(t, task.id))?.description).toBe(AT_CAP)
    const e = await expectRefusal(update(`${AT_CAP}!`), 'rule')
    expect(e.data.message).toBe(DESCRIPTION_TOO_LONG)
    expect((await issueRow(t, task.id))?.description).toBe(AT_CAP)
    await update(null)
    expect((await issueRow(t, task.id))?.description).toBe('')
  })

  it('a task saved before the cap keeps its text; a new value must fit', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: LEGACY,
    })
    const update = (patch: {
      title?: string
      status?: 'progress'
      assignee_id?: string
      description?: string
    }) => as(t, f.user).mutation(api.issues.update, { org_id: f.org.id, id: task.id, patch })
    // patches without the field, and one sending the stored text back
    await update({ title: 'Renamed', status: 'progress' })
    await update({ assignee_id: f.user.id })
    await update({ description: LEGACY })
    expect(await issueRow(t, task.id)).toMatchObject({
      title: 'Renamed',
      status: 'progress',
      assignee_id: f.user.id,
      description: LEGACY,
    })
    // shorter, but still over the cap
    const e = await expectRefusal(update({ description: LEGACY.slice(1) }), 'rule')
    expect(e.data.message).toBe(DESCRIPTION_TOO_LONG)
    expect((await issueRow(t, task.id))?.description).toBe(LEGACY)
    await update({ description: AT_CAP })
    expect((await issueRow(t, task.id))?.description).toBe(AT_CAP)
  })
})

describe('comments and archive reasons in the app', () => {
  it('stores 20,000 characters after trimming and refuses 20,001', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const post = async (body: string) => {
      const id = uuid()
      await as(t, f.user).mutation(api.comments.create, {
        org_id: f.org.id,
        id,
        issue_id: task.id,
        body,
      })
      return id
    }
    expect((await commentRow(t, await post(AT_CAP)))?.body).toBe(AT_CAP)
    expect((await commentRow(t, await post(`     ${AT_CAP}     `)))?.body).toBe(AT_CAP)
    for (const body of [OVER, `  ${OVER}  `]) {
      const e = await expectRefusal(post(body), 'rule')
      expect(e.data.message).toBe(COMMENT_TOO_LONG)
    }
    expect(await commentsOn(t, task.id)).toHaveLength(2)
  })

  it('edits within the cap; a comment saved before it can be sent back unchanged', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const short = await plantComment(t, task.id, f.user.id, 'short')
    const legacy = await plantComment(t, task.id, f.user.id, LEGACY)
    const edit = (id: string, body: string) =>
      as(t, f.user).mutation(api.comments.update, { org_id: f.org.id, id, body })
    const e = await expectRefusal(edit(short, OVER), 'rule')
    expect(e.data.message).toBe(COMMENT_TOO_LONG)
    expect((await commentRow(t, short))?.body).toBe('short')
    await edit(short, AT_CAP)
    expect((await commentRow(t, short))?.body).toBe(AT_CAP)
    // the identical legacy text is no change and stamps nothing
    await edit(legacy, LEGACY)
    const kept = await commentRow(t, legacy)
    expect(kept?.body).toBe(LEGACY)
    expect(kept?.edited_at).toBeUndefined()
    const shorter = await expectRefusal(edit(legacy, LEGACY.slice(1)), 'rule')
    expect(shorter.data.message).toBe(COMMENT_TOO_LONG)
    expect((await commentRow(t, legacy))?.body).toBe(LEGACY)
  })

  it('archives with a 20,000-character reason and refuses 20,001 without archiving', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const archive = (reason: string) =>
      as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: task.id, reason })
    const e = await expectRefusal(archive(` ${OVER} `), 'rule')
    expect(e.data.message).toBe(ARCHIVE_REASON_TOO_LONG)
    expect((await issueRow(t, task.id))?.archived_at).toBeUndefined()
    expect(await commentsOn(t, task.id)).toEqual([])
    await archive(` ${AT_CAP} `)
    expect((await issueRow(t, task.id))?.archived_at).toBeDefined()
    expect((await commentsOn(t, task.id)).map((c) => c.body)).toEqual([AT_CAP])
  })
})

/* ------------------------------------------------------------- the wire */

type Wire = { status: number; json: unknown }
const SECRET = `qva_${'textlimit'.repeat(6)}`

/* withOrg, with the fixture agent holding User on the TBED meta and an agent
 * key, so REST and MCP run over t.fetch as a real client calls them. */
async function wireOrg(t: T): Promise<OrgFixture> {
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
      name: 'limits',
      key_prefix: SECRET.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  return f
}

async function send(
  t: T,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Wire> {
  const http = t as unknown as {
    fetch(
      path: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ): Promise<{ status: number; text(): Promise<string> }>
  }
  const res = await http.fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: JSON.parse(await res.text()) }
}

const rest = (t: T, method: string, path: string, body?: unknown) => send(t, method, path, body)

describe('REST', () => {
  it('accepts 20,000 characters and answers 400 with the sentence for more', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const create = (title: string, description: string) =>
      rest(t, 'POST', '/v1/tasks', { project: f.sub.key, title, description })
    const created = await create('At the cap', AT_CAP)
    expect(created.status).toBe(201)
    const task = created.json as { id: string; key: string }
    const sentence = { error: 'description must be at most 20,000 characters' }
    expect(await create('Over', OVER)).toEqual({ status: 400, json: sentence })
    expect(await create('Emoji', EMOJI_AT_CAP)).toMatchObject({ status: 201 })
    expect(await create('Emoji over', `${EMOJI_AT_CAP}a`)).toEqual({ status: 400, json: sentence })
    // the refused field takes the whole PATCH with it
    const path = `/v1/tasks/${task.key}`
    expect(await rest(t, 'PATCH', path, { title: 'New', description: OVER })).toEqual({
      status: 400,
      json: sentence,
    })
    expect((await issueRow(t, task.id))?.title).toBe('At the cap')
    expect(await rest(t, 'PATCH', path, { title: 'New', description: 'short' })).toMatchObject({
      status: 200,
      json: { title: 'New', description: 'short' },
    })
  })

  it('keeps a legacy description through an identical resend; a new value must fit', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: LEGACY,
    })
    const path = `/v1/tasks/${task.id}`
    expect(await rest(t, 'PATCH', path, { description: LEGACY, status: 'progress' })).toMatchObject(
      { status: 200, json: { status: 'progress', description: LEGACY } },
    )
    expect(await rest(t, 'PATCH', path, { description: LEGACY.slice(1) })).toEqual({
      status: 400,
      json: { error: 'description must be at most 20,000 characters' },
    })
    expect(await rest(t, 'PATCH', path, { description: AT_CAP })).toMatchObject({ status: 200 })
    expect((await issueRow(t, task.id))?.description).toBe(AT_CAP)
  })

  it('refuses a long archive_reason before any write, also on an archived task', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const done = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, archived_at: NOW })
    const archive = (id: string, archive_reason: string) =>
      rest(t, 'PATCH', `/v1/tasks/${id}`, { archived: true, archive_reason })
    const sentence = { error: 'archive_reason must be at most 20,000 characters' }
    expect(await archive(task.id, ` ${OVER} `)).toEqual({ status: 400, json: sentence })
    expect(await archive(done.id, OVER)).toEqual({ status: 400, json: sentence })
    expect((await issueRow(t, task.id))?.archived_at).toBeUndefined()
    expect(await commentsOn(t, task.id)).toEqual([])
    expect(await archive(task.id, ` ${AT_CAP} `)).toMatchObject({
      status: 200,
      json: { archived: true },
    })
    expect((await commentsOn(t, task.id)).map((c) => c.body)).toEqual([AT_CAP])
  })

  it('caps comment bodies on POST and PATCH', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const posted = await rest(t, 'POST', `/v1/tasks/${task.id}/comments`, { body: AT_CAP })
    expect(posted.status).toBe(201)
    const sentence = { error: 'a comment must be at most 20,000 characters' }
    expect(await rest(t, 'POST', `/v1/tasks/${task.id}/comments`, { body: OVER })).toEqual({
      status: 400,
      json: sentence,
    })
    const { id } = posted.json as { id: string }
    expect(await rest(t, 'PATCH', `/v1/comments/${id}`, { body: OVER })).toEqual({
      status: 400,
      json: sentence,
    })
    expect((await commentRow(t, id))?.body).toBe(AT_CAP)
    expect(await rest(t, 'PATCH', `/v1/comments/${id}`, { body: 'shorter' })).toMatchObject({
      status: 200,
      json: { body: 'shorter' },
    })
    expect(await commentsOn(t, task.id)).toHaveLength(1)
  })
})

type ToolResult = { content: { type: string; text: string }[]; isError?: true }

/* One JSON-RPC request on MCP's modern leg (plain JSON answers). */
async function mcp(t: T, method: string, params: Record<string, unknown>, name?: string) {
  const { status, json } = await send(
    t,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'limits', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      id: 1,
    },
    {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': method,
      ...(name === undefined ? {} : { 'Mcp-Name': name }),
    },
  )
  expect(status).toBe(200)
  return (json as { result: unknown }).result
}

const tool = async (t: T, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  (await mcp(t, 'tools/call', { name, arguments: args }, name)) as ToolResult

const tooBig = (name: string, field: string): ToolResult => ({
  content: [
    {
      type: 'text',
      text: `Input validation error: Invalid arguments for tool ${name}: ${field}: Too big: expected string to have <=20000 characters`,
    },
  ],
  isError: true,
})

describe('MCP', () => {
  it('declares maxLength 20000 on the five text arguments', async () => {
    const t = newT()
    await wireOrg(t)
    const { tools } = (await mcp(t, 'tools/list', {})) as {
      tools: { name: string; inputSchema: { properties: Record<string, { maxLength?: number }> } }[]
    }
    const max = (name: string, field: string) =>
      tools.find((x) => x.name === name)?.inputSchema.properties[field]?.maxLength
    expect([
      max('create_task', 'description'),
      max('update_task', 'description'),
      max('update_task', 'archive_reason'),
      max('add_comment', 'body'),
      max('update_comment', 'body'),
    ]).toEqual([20000, 20000, 20000, 20000, 20000])
  })

  it('writes 20,000 characters and refuses 20,001, by the schema or by the server rule', async () => {
    const t = newT()
    await wireOrg(t)
    const issueCount = () => t.run(async (ctx) => (await ctx.db.query('issues').collect()).length)
    const refusal = (text: string): ToolResult => ({
      content: [{ type: 'text', text }],
      isError: true,
    })
    const made = await tool(t, 'create_task', {
      project: 'FW',
      title: 'At cap',
      description: AT_CAP,
    })
    expect(made.isError).toBeUndefined()
    const { id: taskId, key } = JSON.parse(made.content[0].text) as { id: string; key: string }
    expect(
      await tool(t, 'create_task', { project: 'FW', title: 'No', description: OVER }),
    ).toMatchObject(tooBig('create_task', 'description'))
    expect(await issueCount()).toBe(1)

    // the server checks these, as for the app and REST
    const updated = await tool(t, 'update_task', { ref: key, description: AT_CAP.slice(1) })
    expect(updated.isError).toBeUndefined()
    expect(await tool(t, 'update_task', { ref: key, description: OVER })).toMatchObject(
      refusal('description must be at most 20,000 characters'),
    )
    expect(
      await tool(t, 'update_task', { ref: key, archived: true, archive_reason: OVER }),
    ).toMatchObject(refusal('archive_reason must be at most 20,000 characters'))

    const commented = await tool(t, 'add_comment', { ref: key, body: AT_CAP })
    expect(commented.isError).toBeUndefined()
    const { id } = JSON.parse(commented.content[0].text) as { id: string }
    expect(await tool(t, 'add_comment', { ref: key, body: OVER })).toMatchObject(
      refusal('a comment must be at most 20,000 characters'),
    )
    expect(await tool(t, 'update_comment', { comment: id, body: OVER })).toMatchObject(
      refusal('a comment must be at most 20,000 characters'),
    )
    expect((await tool(t, 'update_comment', { comment: id, body: 'shorter' })).isError).toBe(
      undefined,
    )

    const task = await issueRow(t, taskId)
    expect(task?.description).toBe(AT_CAP.slice(1))
    expect(task?.archived_at).toBeUndefined()
    expect((await commentsOn(t, taskId)).map((c) => c.body)).toEqual(['shorter'])
  })

  it('takes text at the cap after trimming and an unchanged longer description, as REST does', async () => {
    const t = newT()
    await wireOrg(t)
    const made = await tool(t, 'create_task', { project: 'FW', title: 'Padded' })
    const { id: taskId, key } = JSON.parse(made.content[0].text) as { id: string; key: string }
    const padded = `  ${AT_CAP}\n`
    const commented = await tool(t, 'add_comment', { ref: key, body: padded })
    expect(commented.isError).toBeUndefined()
    const { id } = JSON.parse(commented.content[0].text) as { id: string }
    expect((await tool(t, 'update_comment', { comment: id, body: ` ${AT_CAP} ` })).isError).toBe(
      undefined,
    )
    // a description saved before the cap may be sent back unchanged
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', taskId))
        .unique()
      await ctx.db.patch(row!._id, { description: OVER })
    })
    const resent = await tool(t, 'update_task', { ref: key, description: OVER, title: 'Kept' })
    expect(resent.isError).toBeUndefined()
    const archived = await tool(t, 'update_task', {
      ref: key,
      archived: true,
      archive_reason: ` ${AT_CAP} `,
    })
    expect(archived.isError).toBeUndefined()
    expect((await issueRow(t, taskId))?.archived_at).toBeDefined()
    expect((await commentsOn(t, taskId)).map((c) => c.body.length)).toEqual([TEXT_MAX, TEXT_MAX])
  })
})
