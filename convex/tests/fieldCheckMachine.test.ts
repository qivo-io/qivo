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
  plantProject,
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
      [{ title: 'X', expected: null }, NOT_OBJECT],
      [{ title: 'X', expected: [] }, NOT_OBJECT],
      [{ title: 'X', expected: 'x' }, NOT_OBJECT],
      [{ title: 'X', expected: {} }, 'expected must name at least one field'],
      [
        { title: 'X', expected: { bogus: 1 } },
        `unknown field "expected.bogus"; expected takes ${TASK_KEYS}`,
      ],
      // a name every object inherits is no field either
      [
        { title: 'X', expected: { constructor: 'x' } },
        `unknown field "expected.constructor"; expected takes ${TASK_KEYS}`,
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

describe('typed values in expected', () => {
  /* Each value differs from the stored one, so without the check of its
   * type the request would be answered as a conflict. */
  it('refuses a value its field would refuse with a 400 sentence, before any comparison', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    const DAY = 'a calendar date as YYYY-MM-DD or null'
    const cases: [Record<string, unknown>, string][] = [
      [
        { due_date: '2026-07-01', expected: { due_date: 'soon' } },
        `expected.due_date must be ${DAY}`,
      ],
      // shaped like a date, but no such day
      [
        { due_date: '2026-07-01', expected: { due_date: '2026-02-31' } },
        `expected.due_date must be ${DAY}`,
      ],
      [
        {
          start_week: '2026-06-01',
          end_week: '2026-06-05',
          expected: { start_week: '2026-6-1', end_week: null },
        },
        `expected.start_week must be ${DAY}`,
      ],
      [
        { remaining_hours: 3, expected: { remaining_hours: -1 } },
        'expected.remaining_hours must be a non-negative number or null',
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
    const kept = await task(fx, row.id)
    expect([kept?.due_date, kept?.start_week, kept?.remaining_hours]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    // a real day still compares, and saves when it matches
    const saved = await send(fx, 'PATCH', `/v1/tasks/${row.id}`, {
      due_date: '2026-07-01',
      expected: { due_date: null },
    })
    expect(saved.status).toBe(200)
    expect(
      await send(fx, 'PATCH', `/v1/tasks/${row.id}`, {
        due_date: '2026-08-01',
        expected: { due_date: '2026-06-30' },
      }),
    ).toMatchObject({ status: 409 })

    const milestone = uuid()
    const label = uuid()
    // only an organization admin reaches a label's body over REST
    const ADMIN = `qvt_${'fieldadm'.repeat(6)}`
    const token_hash = await sha256hex(ADMIN)
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: fx.admin.id,
        name: 'admin',
        token_prefix: ADMIN.slice(0, 11),
        token_hash,
        access: 'write',
        created_at: NOW,
      })
      await ctx.db.insert('milestones', {
        id: milestone,
        project_id: fx.meta.id,
        name: 'Prototype',
        week: '2026-06-01',
        created_at: NOW,
      })
      await ctx.db.insert('labels', {
        id: label,
        org_id: fx.org.id,
        name: 'Hardware',
        name_lower: 'hardware',
        color: '#336699',
        created_at: NOW,
      })
    })
    const other: [
      string,
      string,
      Record<string, unknown>,
      string,
      Record<string, unknown>,
      string,
    ][] = [
      [
        'PATCH',
        '/v1/projects/TBED',
        { review_hours: 3, expected: { review_hours: 1000 } },
        'update_project',
        { project: 'TBED', review_hours: 3, expected: { review_hours: 1000 } },
        'expected.review_hours must be a number of hours from 0 to 999, or null',
      ],
      [
        'PATCH',
        `/v1/users/${fx.user.id}`,
        { plannable_hours: 30, expected: { plannable_hours: 2.5 } },
        'update_user',
        { user_id: fx.user.id, plannable_hours: 30, expected: { plannable_hours: 0 } },
        'expected.plannable_hours must be a whole number of hours from 1 to 168, or null',
      ],
      [
        'PATCH',
        `/v1/projects/TBED/milestones/${milestone}`,
        { date: '2026-07-01', expected: { date: '2026-02-31' } },
        'set_milestone',
        { project: 'TBED', milestone, date: '2026-07-01', expected: { date: 'June' } },
        'expected.date must be a calendar date as YYYY-MM-DD',
      ],
      [
        'PATCH',
        `/v1/labels/${label}`,
        { color: '#112233', expected: { color: 'red' } },
        'set_label',
        { label, color: '#112233', expected: { color: '#12345' } },
        'expected.color must be # followed by six hex digits, like #4C9AFF',
      ],
    ]
    for (const [method, path, body, name, args, error] of other) {
      const asAdmin = path.startsWith('/v1/labels') ? { Authorization: `Bearer ${ADMIN}` } : {}
      expect(await send(fx, method, path, body, asAdmin), error).toEqual({
        status: 400,
        text: JSON.stringify({ error }),
      })
      expect(await tool(fx, name, args), error).toMatchObject(toolError(error))
    }
  })
})

describe('text values in expected', () => {
  /* Each value differs from the stored one, so without the check of its
   * field's rule the request would be answered as a conflict. */
  it('refuses text its field would refuse with a 400 sentence, before any comparison', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'One' })
    const TITLE = 'expected.title must be a string that is not blank, of at most 80 characters'
    for (const seen of ['', '   ', 'x'.repeat(81), '\u{1F680}'.repeat(81)]) {
      const body = { title: 'Two', expected: { title: seen } }
      expect(await send(fx, 'PATCH', `/v1/tasks/${row.id}`, body), seen).toEqual({
        status: 400,
        text: JSON.stringify({ error: TITLE }),
      })
      expect(await tool(fx, 'update_task', { ref: row.id, ...body }), seen).toMatchObject(
        toolError(TITLE),
      )
    }
    expect((await task(fx, row.id))?.title).toBe('One')
    // 80 code points is a title, so it compares
    expect(
      await send(fx, 'PATCH', `/v1/tasks/${row.id}`, {
        title: 'Two',
        expected: { title: ` ${'\u{1F680}'.repeat(80)} ` },
      }),
    ).toMatchObject({ status: 409 })

    const commented = await send(fx, 'POST', `/v1/tasks/${row.id}/comments`, { body: 'First' })
    const comment = (JSON.parse(commented.text) as { id: string }).id
    const milestone = uuid()
    const label = uuid()
    // only an organization admin reaches a label's or a project's body over REST
    const ADMIN = `qvt_${'textadmn'.repeat(6)}`
    const token_hash = await sha256hex(ADMIN)
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: fx.admin.id,
        name: 'admin',
        token_prefix: ADMIN.slice(0, 11),
        token_hash,
        access: 'write',
        created_at: NOW,
      })
      await ctx.db.insert('milestones', {
        id: milestone,
        project_id: fx.meta.id,
        name: 'Prototype',
        week: '2026-06-01',
        created_at: NOW,
      })
      await ctx.db.insert('labels', {
        id: label,
        org_id: fx.org.id,
        name: 'Hardware',
        name_lower: 'hardware',
        color: '#336699',
        created_at: NOW,
      })
    })
    const NAME = 'expected.name must be a string that is not blank'
    const other: [string, Record<string, unknown>, string, Record<string, unknown>, string][] = [
      [
        `/v1/comments/${comment}`,
        { body: 'Second', expected: { body: ' ' } },
        'update_comment',
        { comment, body: 'Second', expected: { body: '' } },
        'expected.body must be a string that is not blank',
      ],
      [
        '/v1/projects/TBED',
        { name: 'Testbed 2', expected: { name: '' } },
        'update_project',
        { project: 'TBED', name: 'Testbed 2', expected: { name: '\n' } },
        NAME,
      ],
      [
        `/v1/projects/TBED/milestones/${milestone}`,
        { name: 'Pilot', expected: { name: '' } },
        'set_milestone',
        { project: 'TBED', milestone, name: 'Pilot', expected: { name: ' ' } },
        NAME,
      ],
      [
        `/v1/labels/${label}`,
        { name: 'Firmware', expected: { name: 'x'.repeat(41) } },
        'set_label',
        { label, name: 'Firmware', expected: { name: '' } },
        'expected.name must be a string that is not blank, of at most 40 characters',
      ],
      [
        `/v1/teams/${fx.team.id}`,
        { name: 'Firmware', expected: { name: '' } },
        'set_team',
        { team_id: fx.team.id, name: 'Firmware', expected: { name: '  ' } },
        NAME,
      ],
    ]
    for (const [path, body, name, args, error] of other) {
      const admin = { Authorization: `Bearer ${ADMIN}` }
      expect(await send(fx, 'PATCH', path, body, admin), `${path} ${error}`).toEqual({
        status: 400,
        text: JSON.stringify({ error }),
      })
      expect(await tool(fx, name, args), `${name} ${error}`).toMatchObject(toolError(error))
    }
  })

  it('compares a name or description longer than its cap, which one saved before the cap reads as', async () => {
    const fx = await setup()
    const long = 'Hardware '.repeat(10).trim()
    await fx.t.run(async (ctx) => {
      const team = await byId(ctx, 'teams', fx.team.id)
      if (team) await ctx.db.patch(team._id, { name: long })
    })
    const ADMIN = `qvt_${'longname'.repeat(6)}`
    const token_hash = await sha256hex(ADMIN)
    await fx.t.run((ctx) =>
      ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: fx.admin.id,
        name: 'admin',
        token_prefix: ADMIN.slice(0, 11),
        token_hash,
        access: 'write',
        created_at: NOW,
      }),
    )
    const path = `/v1/teams/${fx.team.id}`
    const admin = { Authorization: `Bearer ${ADMIN}` }
    expect(
      await send(fx, 'PATCH', path, { name: 'Firmware', expected: { name: `${long}!` } }, admin),
    ).toMatchObject({ status: 409 })
    expect(
      await send(fx, 'PATCH', path, { name: 'Firmware', expected: { name: long } }, admin),
    ).toMatchObject({ status: 200 })

    // a project description saved before its 500-character cap, too
    const legacy = 'legacy text '.repeat(50)
    await fx.t.run((ctx) => ctx.db.patch(fx.meta._id, { description: legacy }))
    const project = '/v1/projects/TBED'
    expect(
      await send(
        fx,
        'PATCH',
        project,
        { description: 'Short', expected: { description: `${legacy}!` } },
        admin,
      ),
    ).toMatchObject({ status: 409 })
    expect(
      await send(
        fx,
        'PATCH',
        project,
        { description: 'Short', expected: { description: legacy } },
        admin,
      ),
    ).toMatchObject({ status: 200 })
  })

  it('compares a well-formed id that names nobody, so a refusal tells no id exists', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const move = { project: 'TBED', sub_project: 'PCB' }
    const sentence = `project of ${key(row)} changed since you read it, so nothing was saved; read ${key(row)} again and resend your change`
    expect(
      await send(fx, 'PATCH', `/v1/tasks/${row.id}`, { ...move, expected: { project_id: uuid() } }),
    ).toEqual({ status: 409, text: JSON.stringify({ error: sentence }) })
  })
})

describe('expected on a create', () => {
  it('refuses it with the sentence of the record, over REST and MCP', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const sentence = (record: string) => `expected applies only when changing an existing ${record}`
    const expected = { name: 'x' }
    for (const [path, body, record] of [
      ['/v1/tasks', { project: 'TBED', sub_project: 'PCB', title: 'X', expected }, 'task'],
      [`/v1/tasks/${row.id}/comments`, { body: 'x', expected }, 'comment'],
      ['/v1/projects', { name: 'X', expected }, 'project'],
      ['/v1/projects/TBED/milestones', { name: 'M', date: '2026-06-01', expected }, 'milestone'],
      ['/v1/labels', { name: 'L', color: '#336699', expected }, 'label'],
      ['/v1/teams', { name: 'T', expected }, 'team'],
    ] as const) {
      expect(await send(fx, 'POST', path, body), path).toEqual({
        status: 400,
        text: JSON.stringify({ error: sentence(record) }),
      })
    }
    for (const [name, args, record] of [
      ['create_task', { project: 'TBED', sub_project: 'PCB', title: 'X' }, 'task'],
      ['add_comment', { ref: row.id, body: 'x' }, 'comment'],
      ['create_project', { name: 'X' }, 'project'],
    ] as const) {
      // null too, which is no object of fields either
      for (const value of [expected, null])
        expect(await tool(fx, name, { ...args, expected: value }), name).toMatchObject(
          toolError(sentence(record)),
        )
    }
    // nothing was created
    const tasks = await fx.t.run((ctx) => ctx.db.query('issues').collect())
    expect(tasks.map((t) => t.id)).toEqual([row.id])
  })
})

describe('a parent the caller cannot read', () => {
  it('compares an id the caller is not shown as a hidden parent, so it tells nothing', async () => {
    const fx = await setup()
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, title: 'Child' })
    // a parent in a top-level project the agent cannot read
    const elsewhere = await plantProject(fx.t, { org_id: fx.org.id, key: 'HID' })
    const away = await plantProject(fx.t, {
      org_id: fx.org.id,
      key: 'HIDS',
      type: 'project',
      parent_id: elsewhere.id,
    })
    const hidden = (await plantIssue(fx.t, { org_id: fx.org.id, project_id: away.id })).id
    // the right hidden id and any other id the caller cannot read answer alike
    for (const guess of [hidden, uuid()]) {
      await fx.t.run(async (ctx) => {
        const live = await byId(ctx, 'issues', row.id)
        if (live) await ctx.db.patch(live._id, { parent_id: hidden })
      })
      const probe = await send(fx, 'PATCH', `/v1/tasks/${row.id}`, {
        parent: null,
        expected: { parent_id: guess, has_hidden_parent: false },
      })
      expect(probe.status, guess).toBe(200)
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
