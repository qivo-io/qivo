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

/* One MCP request on the modern leg, answered as plain JSON. `auth` replaces
 * the agent key's Authorization header. */
async function mcp(
  fx: Fx,
  method: string,
  params: Record<string, unknown>,
  name?: string,
  auth: Record<string, string> = {},
) {
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
      ...auth,
    },
  )
  expect(status).toBe(200)
  return (JSON.parse(text) as { result: unknown }).result
}

const tool = (
  fx: Fx,
  name: string,
  args: Record<string, unknown>,
  auth: Record<string, string> = {},
) => mcp(fx, 'tools/call', { name, arguments: args }, name, auth) as Promise<ToolResult>

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
        { date: '2026-07-01', expected: { date: '2026-7-1' } },
        'set_milestone',
        { project: 'TBED', milestone, date: '2026-07-01', expected: { date: 'June' } },
        'expected.date must be a date as YYYY-MM-DD',
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
    // every write of a title has held this rule, so no task stores a blank
    // or longer one, unlike a team, project or milestone name
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
    const label = uuid()
    // only an organization admin reaches a label's body over REST
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
      await ctx.db.insert('labels', {
        id: label,
        org_id: fx.org.id,
        name: 'Hardware',
        name_lower: 'hardware',
        color: '#336699',
        created_at: NOW,
      })
    })
    const other: [string, Record<string, unknown>, string, Record<string, unknown>, string][] = [
      [
        `/v1/comments/${comment}`,
        { body: 'Second', expected: { body: ' ' } },
        'update_comment',
        { comment, body: 'Second', expected: { body: '' } },
        'expected.body must be a string that is not blank',
      ],
      [
        `/v1/labels/${label}`,
        { name: 'Firmware', expected: { name: 'x'.repeat(41) } },
        'set_label',
        { label, name: 'Firmware', expected: { name: '' } },
        'expected.name must be a string that is not blank, of at most 40 characters',
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

    // a milestone or project name and a comment body saved before their
    // caps compare too
    const milestone = uuid()
    const longer = `Prototype ${'validated '.repeat(9)}`.trim()
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('milestones', {
        id: milestone,
        project_id: fx.meta.id,
        name: longer,
        week: '2026-06-01',
        created_at: NOW,
      })
      await ctx.db.patch(fx.meta._id, { name: longer })
    })
    const milestonePath = `/v1/projects/TBED/milestones/${milestone}`
    expect(
      await send(fx, 'PATCH', milestonePath, { name: 'Pilot', expected: { name: longer } }, admin),
    ).toMatchObject({ status: 200 })
    expect(
      await send(
        fx,
        'PATCH',
        '/v1/projects/TBED',
        { name: 'Testbed', expected: { name: longer } },
        admin,
      ),
    ).toMatchObject({ status: 200 })
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const posted = await send(fx, 'POST', `/v1/tasks/${row.id}/comments`, { body: 'First' })
    const comment = (JSON.parse(posted.text) as { id: string }).id
    const body = 'x'.repeat(20_001)
    await fx.t.run(async (ctx) => {
      const stored = await byId(ctx, 'comments', comment)
      if (stored) await ctx.db.patch(stored._id, { body })
    })
    expect(
      await send(fx, 'PATCH', `/v1/comments/${comment}`, {
        body: 'Short',
        expected: { body: `${body}!` },
      }),
    ).toMatchObject({ status: 409 })
    expect(
      await send(fx, 'PATCH', `/v1/comments/${comment}`, { body: 'Short', expected: { body } }),
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

describe('values saved before their rule', () => {
  /* An organization admin's MCP token, which may rename teams and projects
   * over REST and MCP. */
  async function adminAuth(fx: Fx, secret: string): Promise<Record<string, string>> {
    const token_hash = await sha256hex(secret)
    await fx.t.run((ctx) =>
      ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: fx.admin.id,
        name: 'admin',
        token_prefix: secret.slice(0, 11),
        token_hash,
        access: 'write',
        created_at: NOW,
      }),
    )
    return { Authorization: `Bearer ${secret}` }
  }

  /* Until 2026-10-16 a team, project or milestone took any name, so a
   * stored one may be blank, and every read answers it as stored. */
  it('compares a blank name in the app, over REST and over MCP', async () => {
    const fx = await setup()
    const admin = await adminAuth(fx, `qvt_${'blanknam'.repeat(6)}`)
    const milestone = uuid()
    await fx.t.run((ctx) =>
      ctx.db.insert('milestones', {
        id: milestone,
        project_id: fx.meta.id,
        name: 'Prototype',
        week: '2026-06-01',
        created_at: NOW,
      }),
    )
    /* Stores blank names on the team, the project TBED and the milestone,
     * the team's only spaces, as a write before the rule could. */
    const blank = () =>
      fx.t.run(async (ctx) => {
        const team = await byId(ctx, 'teams', fx.team.id)
        const stored = await byId(ctx, 'milestones', milestone)
        if (team === null || stored === null) throw new Error('fixture rows are missing')
        await ctx.db.patch(team._id, { name: '  ' })
        await ctx.db.patch(fx.meta._id, { name: '' })
        await ctx.db.patch(stored._id, { name: '' })
      })
    const names = () =>
      fx.t.run(async (ctx) => [
        (await byId(ctx, 'teams', fx.team.id))?.name,
        (await byId(ctx, 'projects', fx.meta.id))?.name,
        (await byId(ctx, 'milestones', milestone))?.name,
      ])
    const teamPath = `/v1/teams/${fx.team.id}`
    const milestonePath = `/v1/projects/TBED/milestones/${milestone}`

    await blank()
    // a name read before someone blanked it is stale
    for (const [path, name] of [
      [teamPath, 'Firmware'],
      ['/v1/projects/TBED', 'Testbed'],
      [milestonePath, 'Pilot'],
    ]) {
      expect(
        await send(fx, 'PATCH', path, { name, expected: { name: 'Hardware' } }, admin),
        path,
      ).toMatchObject({ status: 409 })
    }
    expect(await names()).toEqual(['  ', '', ''])
    // a blank name gives the sentence nothing to quote, so it names the id
    const changed = (what: string, label: string) => ({
      status: 409,
      text: JSON.stringify({
        error: `${what} of ${label} changed since you read it, so nothing was saved; read ${label} again and resend your change`,
      }),
    })
    expect(
      await send(
        fx,
        'PATCH',
        teamPath,
        { name: 'Firmware', expected: { name: 'Hardware' } },
        admin,
      ),
    ).toEqual(changed('name', `team ${fx.team.id}`))
    expect(
      await send(fx, 'PATCH', milestonePath, { name: 'Pilot', expected: { name: 'Beta' } }, admin),
    ).toEqual(changed('name', `milestone ${milestone}`))
    // and so does the access of a team named blank
    expect(
      await send(
        fx,
        'PUT',
        `/v1/projects/TBED/access/teams/${fx.team.id}`,
        { level: 'viewer', expected: { level: 'user' } },
        admin,
      ),
    ).toEqual(changed('level', `the access of team ${fx.team.id} to project TBED`))

    // REST, blank as read or with spaces
    for (const [path, name, seen] of [
      [teamPath, 'Firmware', ''],
      ['/v1/projects/TBED', 'Testbed', ' '],
      [milestonePath, 'Pilot', ''],
    ]) {
      expect(
        await send(fx, 'PATCH', path, { name, expected: { name: seen } }, admin),
        path,
      ).toMatchObject({ status: 200 })
    }
    expect(await names()).toEqual(['Firmware', 'Testbed', 'Pilot'])
    // a name saved with spaces around it is quoted without them
    await fx.t.run(async (ctx) => {
      const team = await byId(ctx, 'teams', fx.team.id)
      if (team) await ctx.db.patch(team._id, { name: ' Hardware ' })
    })
    expect(
      await send(fx, 'PATCH', teamPath, { name: 'Firmware', expected: { name: 'Old' } }, admin),
    ).toEqual(changed('name', 'team "Hardware"'))

    await blank()
    const calls: [string, Record<string, unknown>][] = [
      ['set_team', { team_id: fx.team.id, name: 'Firmware 2' }],
      ['update_project', { project: 'TBED', name: 'Testbed 2' }],
      ['set_milestone', { project: 'TBED', milestone, name: 'Pilot 2' }],
    ]
    for (const [name, args] of calls) {
      const result = await tool(fx, name, { ...args, expected: { name: '' } }, admin)
      expect(result.isError, `${name} ${JSON.stringify(result)}`).toBeUndefined()
    }
    expect(await names()).toEqual(['Firmware 2', 'Testbed 2', 'Pilot 2'])

    // the app sends the name it shows
    await blank()
    const org_id = fx.org.id
    await as(fx.t, fx.admin).mutation(api.teams.update, {
      org_id,
      id: fx.team.id,
      patch: { name: 'Firmware 3' },
      expected: { name: '  ' },
    })
    await as(fx.t, fx.admin).mutation(api.projects.update, {
      org_id,
      id: fx.meta.id,
      patch: { name: 'Testbed 3' },
      expected: { name: '' },
    })
    await as(fx.t, fx.admin).mutation(api.projects.updateMilestone, {
      org_id,
      id: milestone,
      patch: { name: 'Pilot 3' },
      expected: { name: '' },
    })
    expect(await names()).toEqual(['Firmware 3', 'Testbed 3', 'Pilot 3'])
  })

  /* Until 2026-10-16 a milestone took any day written YYYY-MM-DD, one that
   * does not exist included, and REST and MCP read it back as its date. */
  it('compares a milestone date that does not exist, and refuses one of another shape', async () => {
    const fx = await setup()
    const milestone = uuid()
    await fx.t.run((ctx) =>
      ctx.db.insert('milestones', {
        id: milestone,
        project_id: fx.meta.id,
        name: 'Prototype',
        week: '2026-02-31',
        created_at: NOW,
      }),
    )
    const path = `/v1/projects/TBED/milestones/${milestone}`
    const week = () => fx.t.run(async (ctx) => (await byId(ctx, 'milestones', milestone))?.week)
    expect(
      await send(fx, 'PATCH', path, { date: '2026-03-02', expected: { date: '2026-02-30' } }),
    ).toMatchObject({ status: 409 })
    const error = 'expected.date must be a date as YYYY-MM-DD'
    expect(
      await send(fx, 'PATCH', path, { date: '2026-03-02', expected: { date: '2026-2-31' } }),
    ).toEqual({ status: 400, text: JSON.stringify({ error }) })
    expect(await week()).toBe('2026-02-31')
    expect(
      await send(fx, 'PATCH', path, { date: '2026-03-02', expected: { date: '2026-02-31' } }),
    ).toMatchObject({ status: 200 })
    expect(await week()).toBe('2026-03-02')

    await fx.t.run(async (ctx) => {
      const stored = await byId(ctx, 'milestones', milestone)
      if (stored) await ctx.db.patch(stored._id, { week: '2026-02-31' })
    })
    const args = { project: 'TBED', milestone, date: '2026-03-09' }
    expect(await tool(fx, 'set_milestone', { ...args, expected: { date: 'June' } })).toMatchObject(
      toolError(error),
    )
    const moved = await tool(fx, 'set_milestone', { ...args, expected: { date: '2026-02-31' } })
    expect(moved.isError, JSON.stringify(moved)).toBeUndefined()
    expect(await week()).toBe('2026-03-09')
  })

  /* Until 2026-10-19 the app took any string as the id of a new person,
   * project or task, so a task's people, parent and project and a
   * project's lead may name a row by an id that is not a uuid, and every
   * read answers it as stored. */
  it('compares an id that is not a uuid, as one made before ids had to be uuids', async () => {
    const fx = await setup()
    const admin = await adminAuth(fx, `qvt_${'legacyid'.repeat(6)}`)
    const ann = 'Legacy-Ann'
    await fx.t.run(async (ctx) => {
      const { _id, _creationTime, auth_user_id, ...guest } = fx.guest
      await ctx.db.insert('profiles', {
        ...guest,
        id: ann,
        email: 'ann@testbed.test',
        name: 'Ann',
      })
    })
    const old = await plantProject(fx.t, {
      org_id: fx.org.id,
      id: 'Project-Old',
      key: 'OLD',
      type: 'project',
      parent_id: fx.meta.id,
      lead_id: ann,
    })
    const [first, second] = await Promise.all(
      ['Task-First', 'Task-Second'].map((id) =>
        plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, id }),
      ),
    )
    const row = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: old.id,
      assignee_id: ann,
      reviewer_id: ann,
      parent_id: first.id,
    })
    const ref = `/v1/tasks/${key(row)}`
    const read = JSON.parse((await send(fx, 'GET', ref)).text) as Record<string, unknown>
    expect([read.assignee_id, read.reviewer_id, read.parent_id, read.project_id]).toEqual([
      ann,
      ann,
      first.id,
      old.id,
    ])
    const parentNow = (id: string) =>
      fx.t.run(async (ctx) => {
        const live = await byId(ctx, 'issues', row.id)
        if (live) await ctx.db.patch(live._id, { parent_id: id })
      })

    // a stale one is a conflict, the parent included when both are shown
    await parentNow(second.id)
    expect(
      await send(fx, 'PATCH', ref, {
        parent: null,
        expected: { parent_id: first.id, has_hidden_parent: false },
      }),
    ).toMatchObject({ status: 409 })
    expect(
      await send(fx, 'PATCH', ref, {
        assignee_id: null,
        expected: { assignee_id: 'Legacy-Bo' },
      }),
    ).toMatchObject({ status: 409 })
    expect((await task(fx, row.id))?.assignee_id).toBe(ann)
    await parentNow(first.id)

    // the values as read compare, in any case
    for (const [body, expected] of [
      [{ assignee_id: null }, { assignee_id: read.assignee_id }],
      [{ reviewer_id: null }, { reviewer_id: ann.toUpperCase() }],
      [{ parent: null }, { parent_id: read.parent_id, has_hidden_parent: false }],
      [{ project: 'TBED', sub_project: 'FW' }, { project_id: read.project_id }],
    ]) {
      expect(
        await send(fx, 'PATCH', ref, { ...body, expected }),
        JSON.stringify(body),
      ).toMatchObject({ status: 200 })
    }
    const saved = await task(fx, row.id)
    expect([saved?.assignee_id, saved?.reviewer_id, saved?.parent_id, saved?.project_id]).toEqual([
      undefined,
      undefined,
      undefined,
      fx.sub.id,
    ])
    expect(
      await send(
        fx,
        'PATCH',
        '/v1/projects/OLD',
        { lead_id: fx.admin.id, expected: { lead_id: ann } },
        admin,
      ),
    ).toMatchObject({ status: 200 })

    // over MCP alike
    await fx.t.run(async (ctx) => {
      const live = await byId(ctx, 'issues', row.id)
      const project = await byId(ctx, 'projects', old.id)
      if (live === null || project === null) throw new Error('fixture rows are missing')
      await ctx.db.patch(live._id, {
        assignee_id: ann,
        parent_id: first.id,
        project_id: old.id,
      })
      await ctx.db.patch(project._id, { lead_id: ann })
    })
    const update = (args: Record<string, unknown>) =>
      tool(fx, 'update_task', { ref: key(row), ...args })
    expect(
      await update({
        assignee_id: null,
        expected: { assignee_id: 'Legacy-Bo' },
      }),
    ).toMatchObject({ isError: true })
    for (const args of [
      { assignee_id: null, expected: { assignee_id: ann } },
      {
        parent: null,
        expected: { parent_id: first.id, has_hidden_parent: false },
      },
      { project: 'TBED', sub_project: 'FW', expected: { project_id: old.id } },
    ]) {
      const result = await update(args)
      expect(result.isError, JSON.stringify(result)).toBeUndefined()
    }
    const lead = await tool(
      fx,
      'update_project',
      { project: 'OLD', lead_id: fx.admin.id, expected: { lead_id: ann } },
      admin,
    )
    expect(lead.isError, JSON.stringify(lead)).toBeUndefined()

    // a value no id can be is still a 400
    for (const [body, error] of [
      [
        { assignee_id: null, expected: { assignee_id: 7 } },
        'expected.assignee_id must be a profile id or null',
      ],
      [
        { project: 'TBED', sub_project: 'PCB', expected: { project_id: null } },
        'expected.project_id must be a project id',
      ],
    ] as const) {
      expect(await send(fx, 'PATCH', ref, body), error).toEqual({
        status: 400,
        text: JSON.stringify({ error }),
      })
    }
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

  it('still sees a parent it was shown that moved to one it is not, by its id in any case', async () => {
    const fx = await setup()
    const shown = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const row = await plantIssue(fx.t, {
      org_id: fx.org.id,
      project_id: fx.sub.id,
      parent_id: shown.id,
    })
    const elsewhere = await plantProject(fx.t, { org_id: fx.org.id, key: 'HID' })
    const away = await plantProject(fx.t, {
      org_id: fx.org.id,
      key: 'HIDS',
      type: 'project',
      parent_id: elsewhere.id,
    })
    const hidden = (await plantIssue(fx.t, { org_id: fx.org.id, project_id: away.id })).id
    await fx.t.run(async (ctx) => {
      const live = await byId(ctx, 'issues', row.id)
      if (live) await ctx.db.patch(live._id, { parent_id: hidden })
    })
    for (const seen of [shown.id, shown.id.toUpperCase()]) {
      const probe = await send(fx, 'PATCH', `/v1/tasks/${key(row)}`, {
        parent: null,
        expected: { parent_id: seen, has_hidden_parent: false },
      })
      expect(probe.status, seen).toBe(409)
    }
  })
})

describe('parents made before ids had to be uuids', () => {
  /* Tasks made until 2026-10-19 may have ids that are not uuids, and two
   * of them may differ in case only. */
  async function legacy() {
    const fx = await setup()
    const elsewhere = await plantProject(fx.t, { org_id: fx.org.id, key: 'HID' })
    const away = await plantProject(fx.t, {
      org_id: fx.org.id,
      key: 'HIDS',
      type: 'project',
      parent_id: elsewhere.id,
    })
    const plant = (id: string, project_id: string) =>
      plantIssue(fx.t, { org_id: fx.org.id, project_id, id })
    const shown = await plant('Task-A', fx.sub.id)
    const twin = await plant('task-a', away.id)
    const other = await plant('Task-B', away.id)
    const row = await plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id })
    const parentNow = (id: string) =>
      fx.t.run(async (ctx) => {
        const live = await byId(ctx, 'issues', row.id)
        if (live) await ctx.db.patch(live._id, { parent_id: id })
      })
    const detach = (seen: string) =>
      send(fx, 'PATCH', `/v1/tasks/${key(row)}`, {
        parent: null,
        expected: { parent_id: seen, has_hidden_parent: false },
      })
    return { shown, twin, other, parentNow, detach }
  }

  it('answers alike whichever hidden task is the parent, and matches one that stayed in any case', async () => {
    const { shown, twin, other, parentNow, detach } = await legacy()
    for (const hidden of [twin.id, other.id]) {
      await parentNow(hidden)
      expect((await detach(shown.id)).status, hidden).toBe(409)
    }
    await parentNow(shown.id)
    expect((await detach(shown.id.toLowerCase())).status).toBe(200)
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
