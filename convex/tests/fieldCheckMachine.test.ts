/* The field check over REST and MCP (model/expected.ts parseExpected). A
 * machine edit may carry `expected`, the fields as REST or MCP last read
 * them. A stale one is answered 409 over REST and as an isError result over
 * MCP, with one sentence; a malformed one is a 400 sentence on both. Without
 * `expected` an edit saves as before. Requests go through the real routes
 * with the fixture agent's key. */
/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import { printOf, trimmedForm } from '../lib/fieldPrints'
import type { Refusal } from '../lib/functions'
import { sha256hex } from '../machine/auth'
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

const SECRET = `qva_${'fieldchk'.repeat(6)}`

type Fx = OrgFixture & { t: T }

/* withOrg, with the agent Relay holding User on TBED and a key. */
async function setup(): Promise<Fx> {
  const t = newT()
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
      name: 'drive',
      key_prefix: SECRET.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  return { t, ...f }
}

type Wire = { status: number; text: string }

async function send(fx: Fx, method: string, path: string, body?: unknown, headers = {}) {
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
  return { status: res.status, text: await res.text() } satisfies Wire
}

type ToolResult = { content: { type: string; text: string }[]; isError?: true }

/* One MCP request on the modern leg, answered as plain JSON. */
async function mcp(fx: Fx, method: string, params: Record<string, unknown>, name?: string) {
  const { status, text } = await send(
    fx,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'field-check', version: '1.0.0' },
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
  return (JSON.parse(text) as { result: unknown }).result
}

const tool = (fx: Fx, name: string, args: Record<string, unknown>) =>
  mcp(fx, 'tools/call', { name, arguments: args }, name) as Promise<ToolResult>

/* The isError result of a refused tool call with `text`. */
const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true })

const titlePrint = (text: string) => printOf(trimmedForm(text))
const task = (fx: Fx, id: string) => fx.t.run((ctx) => byId(ctx, 'issues', id))
const key = (row: Doc<'issues'>) => `QN-${row.num}`
const stale = (who: string, what: string, label: string) =>
  `${who} changed ${what} of ${label} since you read it, so nothing was saved; read ${label} again and resend your change`

describe('REST task edits', () => {
  it('answers a stale field 409 with one sentence and saves a current one', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    const path = `/v1/tasks/${key(row)}`
    // the user renames it in the app after the agent read One
    await as(fx.t, fx.user).mutation(api.issues.update, {
      org_id: fx.org.id,
      id: row.id,
      patch: { title: 'Two' },
      expected: { title: titlePrint('One') },
    })
    const before = await task(fx, row.id)
    expect(await send(fx, 'PATCH', path, { title: 'Agent', expected: { title: 'One' } })).toEqual({
      status: 409,
      text: JSON.stringify({ error: stale('user', 'title', key(row)) }),
    })
    expect(await task(fx, row.id)).toEqual(before)
    const saved = await send(fx, 'PATCH', path, { title: 'Agent', expected: { title: ' Two ' } })
    expect(saved.status).toBe(200)
    expect(await send(fx, 'PATCH', path, { title: 'Plain' })).toMatchObject({ status: 200 })
    expect((await task(fx, row.id))?.title).toBe('Plain')
  })

  it('names the agent to a later app edit over its change', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    const saved = await send(fx, 'PATCH', `/v1/tasks/${row.id}`, {
      title: 'Two',
      expected: { title: 'One' },
    })
    expect(saved.status).toBe(200)
    const e = await expectRefusal(
      as(fx.t, fx.admin).mutation(api.issues.update, {
        org_id: fx.org.id,
        id: row.id,
        patch: { title: 'Three' },
        expected: { title: titlePrint('One') },
      }),
      'conflict',
    )
    const data = e.data as Refusal
    expect(data.changes?.[0]).toMatchObject({ field: 'title', by: fx.agent.id })
    expect(data.message).toBe(stale('Relay', 'title', key(row)))
  })

  it('reads an active group with stale hours as none, so clearing them passes', async () => {
    const fx = await setup()
    const group = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      remaining_hours: 5,
    })
    await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, parent_id: group.id })
    const res = await send(fx, 'PATCH', `/v1/tasks/${group.id}`, {
      remaining_hours: null,
      expected: { remaining_hours: null },
    })
    expect(res.status).toBe(200)
    expect((await task(fx, group.id))?.remaining_hours).toBeUndefined()
  })

  it('refuses a move whose project the agent read is stale, over REST and MCP', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const move = { project: 'TBED', sub_project: 'PCB' }
    const sentence = `project of ${key(row)} changed since you read it, so nothing was saved; read ${key(row)} again and resend your change`
    expect(
      await send(fx, 'PATCH', `/v1/tasks/${row.id}`, {
        ...move,
        expected: { project_id: fx.sub2.id },
      }),
    ).toEqual({ status: 409, text: JSON.stringify({ error: sentence }) })
    expect(
      await tool(fx, 'update_task', { ref: row.id, ...move, expected: { project_id: fx.meta.id } }),
    ).toMatchObject(toolError(sentence))
    expect((await task(fx, row.id))?.project_id).toBe(fx.sub.id)
    const moved = await tool(fx, 'update_task', {
      ref: row.id,
      ...move,
      expected: { project_id: fx.sub.id },
    })
    expect(moved.isError).toBeUndefined()
    expect((await task(fx, row.id))?.project_id).toBe(fx.sub2.id)
  })
})

describe('malformed expected', () => {
  it('refuses each shape with its own sentence over REST and MCP, and saves nothing', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    const TASK_KEYS =
      'title, description, status, priority, assignee_id, reviewer_id, start_week, end_week, due_date, remaining_hours, paused, parent_id, has_hidden_parent, project_id'
    const NOT_OBJECT = 'expected must be an object of the fields as you last read them'
    const cases: [Record<string, unknown>, string][] = [
      [{ title: 'X', expected: [] }, NOT_OBJECT],
      [{ title: 'X', expected: 'x' }, NOT_OBJECT],
      [{ title: 'X', expected: {} }, 'expected must name at least one field'],
      [
        { title: 'X', expected: { bogus: 1 } },
        `unknown field "expected.bogus"; expected takes ${TASK_KEYS}`,
      ],
      [
        { status: 'done', expected: { status: 'finished' } },
        'expected.status must be one of backlog, todo, progress, review, done',
      ],
      [
        { status: 'done', expected: { title: 'One' } },
        'expected.title applies only when the request sends title',
      ],
      [
        { parent: null, expected: { parent_id: null } },
        'expected.parent_id and expected.has_hidden_parent go together',
      ],
      [
        { parent: null, expected: { parent_id: uuid(), has_hidden_parent: true } },
        'expected.has_hidden_parent must be false when expected.parent_id names a task',
      ],
    ]
    for (const [body, error] of cases) {
      expect(await send(fx, 'PATCH', `/v1/tasks/${row.id}`, body), error).toEqual({
        status: 400,
        text: JSON.stringify({ error }),
      })
      expect(await tool(fx, 'update_task', { ref: row.id, ...body }), error).toMatchObject(
        toolError(error),
      )
    }
    // REST reads a JSON null as a value, which MCP's schema refuses first
    expect(await send(fx, 'PATCH', `/v1/tasks/${row.id}`, { title: 'X', expected: null })).toEqual({
      status: 400,
      text: JSON.stringify({ error: NOT_OBJECT }),
    })
    expect((await task(fx, row.id))?.title).toBe('One')

    // the tools that create without an id, and a removal, take no expected
    for (const [name, args, error] of [
      [
        'set_milestone',
        { project: 'TBED', name: 'M', date: '2026-06-01' },
        'expected applies only when changing an existing milestone',
      ],
      [
        'set_label',
        { name: 'L', color: '#336699' },
        'expected applies only when changing an existing label',
      ],
      ['set_team', { name: 'T' }, 'expected applies only when changing an existing team'],
      [
        'set_project_access',
        { project: 'FW', user_id: fx.guest.id, level: null },
        'expected applies only when level is not null',
      ],
    ] as const) {
      expect(await tool(fx, name, { ...args, expected: { name: 'x' } }), name).toMatchObject(
        toolError(error),
      )
    }
  })
})

describe('the tool list', () => {
  it('offers expected on the tools that change or delete an existing record', async () => {
    const fx = await setup()
    const { tools } = (await mcp(fx, 'tools/list', {})) as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[]
    }
    const offering = tools.filter((t) => 'expected' in t.inputSchema.properties).map((t) => t.name)
    expect(offering.sort()).toEqual(
      [
        'update_task',
        'update_comment',
        'delete_comment',
        'update_project',
        'set_project_access',
        'set_milestone',
        'delete_milestone',
        'set_label',
        'set_team',
        'update_user',
      ].sort(),
    )
  })
})
