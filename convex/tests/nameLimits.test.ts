/* The 80-character cap on project, sub-project, team, milestone and
 * organization names and on agent key and personal token names
 * (lib/textLimits.ts NAME_MAX). Names count code points, so most single
 * emoji count once. The model layer enforces the cap for the app, REST and
 * MCP alike, and MCP's tool schemas declare it as maxLength. Rows named
 * before the cap are planted raw and keep their names through writes that
 * resend them. */

import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { NAME_MAX } from '../lib/textLimits'
import { sha256hex } from '../machine/auth'
import { MILESTONE_NAME_TOO_LONG } from '../model/milestones'
import { ORG_NAME_TOO_LONG } from '../model/orgs'
import { PROJECT_NAME_TOO_LONG } from '../model/projects'
import { TEAM_NAME_TOO_LONG } from '../model/teams'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const AT_CAP = 'a'.repeat(NAME_MAX)
const OVER = 'a'.repeat(NAME_MAX + 1)
// 80 code points that are 160 UTF-16 code units. A code unit count would
// refuse it.
const EMOJI_AT_CAP = '😀'.repeat(NAME_MAX)
const EMOJI_OVER = '😀'.repeat(NAME_MAX + 1)
const LEGACY = 'L'.repeat(120)

const sentence = (text: string) => new RegExp(`^${text}$`)

type Named = 'projects' | 'teams' | 'milestones' | 'organizations'

/* The stored row of `table` with uuid `id`, or null. */
const rowOf = <Table extends Named>(t: T, table: Table, id: string) =>
  t.run(
    async (ctx): Promise<Doc<Table> | null> =>
      (await ctx.db.query(table).collect()).find((row) => row.id === id) ?? null,
  )

/* Renames a stored row to `name` (LEGACY by default), as a write before the
 * cap could. */
const plantLegacyName = (t: T, table: Named, id: string, name = LEGACY) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.query(table).collect()).find((r) => r.id === id)
    if (row === undefined) throw new Error(`${table} ${id} missing`)
    await ctx.db.patch(row._id, { name })
  })

describe('project names', () => {
  const create = (t: T, f: OrgFixture, name: string, key: string) =>
    as(t, f.admin).mutation(api.projects.create, {
      org_id: f.org.id,
      id: uuid(),
      type: 'meta',
      key,
      name,
      sort_order: 9,
    })

  it('creates and renames with up to 80 code points and refuses 81', async () => {
    const t = newT()
    const f = await withOrg(t)
    const made = await create(t, f, ` ${AT_CAP} `, 'NA')
    expect((await rowOf(t, 'projects', made.id))?.name).toBe(AT_CAP)
    const emoji = await create(t, f, EMOJI_AT_CAP, 'NB')
    expect((await rowOf(t, 'projects', emoji.id))?.name).toBe(EMOJI_AT_CAP)
    const count = () => t.run(async (ctx) => (await ctx.db.query('projects').collect()).length)
    const before = await count()
    for (const name of [OVER, EMOJI_OVER]) {
      await expectRefusal(create(t, f, name, 'NC'), 'rule', sentence(PROJECT_NAME_TOO_LONG))
    }
    expect(await count()).toBe(before)
    const rename = (name: string) =>
      as(t, f.admin).mutation(api.projects.update, {
        org_id: f.org.id,
        id: made.id,
        patch: { name },
      })
    await expectRefusal(rename(OVER), 'rule', sentence(PROJECT_NAME_TOO_LONG))
    expect((await rowOf(t, 'projects', made.id))?.name).toBe(AT_CAP)
    await rename(EMOJI_AT_CAP)
    expect((await rowOf(t, 'projects', made.id))?.name).toBe(EMOJI_AT_CAP)
  })

  it('keeps a longer name stored before the cap until it is renamed', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLegacyName(t, 'projects', f.meta.id)
    const update = (patch: { name?: string; description?: string }) =>
      as(t, f.user).mutation(api.projects.update, { org_id: f.org.id, id: f.meta.id, patch })
    await update({ description: 'Other settings still save' })
    await update({ name: LEGACY, description: 'An identical name is no change' })
    expect(await rowOf(t, 'projects', f.meta.id)).toMatchObject({
      name: LEGACY,
      description: 'An identical name is no change',
    })
    await expectRefusal(update({ name: LEGACY.slice(1) }), 'rule', sentence(PROJECT_NAME_TOO_LONG))
    await update({ name: 'Testbed' })
    expect((await rowOf(t, 'projects', f.meta.id))?.name).toBe('Testbed')
  })

  it('compares a longer stored name with surrounding spaces trimmed', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLegacyName(t, 'projects', f.meta.id, `  ${LEGACY} `)
    // the app trims the name it shows before it sends it back
    await as(t, f.user).mutation(api.projects.update, {
      org_id: f.org.id,
      id: f.meta.id,
      patch: { name: LEGACY, description: 'Saved with the name' },
    })
    expect(await rowOf(t, 'projects', f.meta.id)).toMatchObject({
      name: LEGACY,
      description: 'Saved with the name',
    })
  })
})

describe('team names', () => {
  it('creates and renames with up to 80 code points and keeps a longer stored name', async () => {
    const t = newT()
    const f = await withOrg(t)
    const create = (name: string) =>
      as(t, f.admin).mutation(api.teams.create, { org_id: f.org.id, id: uuid(), name })
    const update = (patch: { name?: string; stale_days?: number }) =>
      as(t, f.user).mutation(api.teams.update, { org_id: f.org.id, id: f.team.id, patch })
    await create(AT_CAP)
    await create(EMOJI_AT_CAP)
    await expectRefusal(create(OVER), 'rule', sentence(TEAM_NAME_TOO_LONG))
    await expectRefusal(create(EMOJI_OVER), 'rule', sentence(TEAM_NAME_TOO_LONG))
    const names = await t.run(async (ctx) =>
      (await ctx.db.query('teams').collect()).map((team) => team.name),
    )
    expect(names).not.toContain(OVER)

    await plantLegacyName(t, 'teams', f.team.id)
    await update({ stale_days: 10 })
    await update({ name: LEGACY })
    expect(await rowOf(t, 'teams', f.team.id)).toMatchObject({ name: LEGACY, stale_days: 10 })
    await expectRefusal(update({ name: LEGACY.slice(1) }), 'rule', sentence(TEAM_NAME_TOO_LONG))
    await update({ name: EMOJI_AT_CAP })
    expect((await rowOf(t, 'teams', f.team.id))?.name).toBe(EMOJI_AT_CAP)
  })
})

describe('milestone names', () => {
  it('adds and renames with up to 80 code points and keeps a longer stored name on a move', async () => {
    const t = newT()
    const f = await withOrg(t)
    const add = (id: string, name: string) =>
      as(t, f.user).mutation(api.projects.addMilestone, {
        org_id: f.org.id,
        id,
        project_id: f.meta.id,
        name,
        week: '2026-01-05',
      })
    const id = uuid()
    await add(id, EMOJI_AT_CAP)
    await expectRefusal(add(uuid(), OVER), 'rule', sentence(MILESTONE_NAME_TOO_LONG))
    expect(await t.run(async (ctx) => (await ctx.db.query('milestones').collect()).length)).toBe(1)

    // the app's Milestones window always sends the name with the week
    await plantLegacyName(t, 'milestones', id)
    const update = (patch: { name?: string; week?: string }) =>
      as(t, f.user).mutation(api.projects.updateMilestone, { org_id: f.org.id, id, patch })
    await update({ name: LEGACY, week: '2026-01-12' })
    expect(await rowOf(t, 'milestones', id)).toMatchObject({ name: LEGACY, week: '2026-01-12' })
    await expectRefusal(
      update({ name: LEGACY.slice(1), week: '2026-01-19' }),
      'rule',
      sentence(MILESTONE_NAME_TOO_LONG),
    )
    expect((await rowOf(t, 'milestones', id))?.week).toBe('2026-01-12')
  })

  it('applies the same rule to roadmap changes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const user = as(t, f.user)
    const session_id = uuid()
    const id = uuid()
    await expectRefusal(
      user.mutation(api.roadmap.change, {
        session_id,
        operations: [
          { kind: 'milestone_create', id, project_id: f.meta.id, name: OVER, week: '2026-01-05' },
        ],
      }),
      'rule',
      sentence(MILESTONE_NAME_TOO_LONG),
    )
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [
        { kind: 'milestone_create', id, project_id: f.meta.id, name: AT_CAP, week: '2026-01-05' },
      ],
    })
    await plantLegacyName(t, 'milestones', id)
    await user.mutation(api.roadmap.change, {
      session_id,
      operations: [{ kind: 'milestone_update', id, patch: { name: LEGACY, week: '2026-02-02' } }],
    })
    expect(await rowOf(t, 'milestones', id)).toMatchObject({ name: LEGACY, week: '2026-02-02' })
    await expectRefusal(
      user.mutation(api.roadmap.change, {
        session_id,
        operations: [{ kind: 'milestone_update', id, patch: { name: OVER } }],
      }),
      'rule',
      sentence(MILESTONE_NAME_TOO_LONG),
    )
  })
})

describe('organization names', () => {
  it('renames with up to 80 code points, trimmed, and keeps a longer stored name', async () => {
    const t = newT()
    const f = await withOrg(t)
    const update = (patch: { name?: string; week_start?: number }) =>
      as(t, f.admin).mutation(api.orgs.update, { org_id: f.org.id, patch })
    await update({ name: ` ${EMOJI_AT_CAP} ` })
    expect((await rowOf(t, 'organizations', f.org.id))?.name).toBe(EMOJI_AT_CAP)
    await expectRefusal(update({ name: OVER }), 'rule', sentence(ORG_NAME_TOO_LONG))
    await plantLegacyName(t, 'organizations', f.org.id)
    await update({ name: LEGACY, week_start: 0 })
    expect(await rowOf(t, 'organizations', f.org.id)).toMatchObject({
      name: LEGACY,
      week_start: 0,
    })
    await expectRefusal(update({ name: LEGACY.slice(1) }), 'rule', sentence(ORG_NAME_TOO_LONG))
  })

  it('keeps a longer stored name with surrounding spaces when it is sent back unchanged', async () => {
    const t = newT()
    const f = await withOrg(t)
    // orgs.update stored names untrimmed before the cap
    const padded = ` ${LEGACY}  `
    await plantLegacyName(t, 'organizations', f.org.id, padded)
    await as(t, f.admin).mutation(api.orgs.update, {
      org_id: f.org.id,
      patch: { name: padded, week_start: 0 },
    })
    expect(await rowOf(t, 'organizations', f.org.id)).toMatchObject({
      name: LEGACY,
      week_start: 0,
    })
  })

  it('refuses an operator-created organization with a longer name and leaves nothing', async () => {
    const t = newT()
    const insert = (name: string) =>
      t.mutation(internal.adminOrgs.insertOrganization, {
        name,
        people: [],
        actor: { auth_user_id: 'operator-login', email: 'operator@platform.test' },
      })
    await expectRefusal(insert(OVER), 'rule', sentence(ORG_NAME_TOO_LONG))
    expect(await t.run((ctx) => ctx.db.query('organizations').collect())).toEqual([])
    const { org_id } = await insert(EMOJI_AT_CAP)
    expect((await rowOf(t, 'organizations', org_id))?.name).toBe(EMOJI_AT_CAP)
    // the starter team is named after the organization
    const teams = await t.run((ctx) => ctx.db.query('teams').collect())
    expect(teams.map((team) => team.name)).toEqual([EMOJI_AT_CAP])
  })
})

describe('agent key and personal token names', () => {
  const HEX64 = 'ab'.repeat(32)

  it('caps an agent key name, stores it trimmed and requires the display fingerprint', async () => {
    const t = newT()
    const f = await withOrg(t)
    const mint = (over: { name?: string; key_prefix?: string; key_hash?: string }) =>
      as(t, f.admin).mutation(api.tokens.createAgentKey, {
        org_id: f.org.id,
        id: uuid(),
        agent_id: f.agent.id,
        name: 'CI key',
        key_prefix: 'qva_012...abcde',
        key_hash: HEX64,
        ...over,
      })
    await expectRefusal(
      mint({ name: OVER }),
      'rule',
      sentence(`a key name must be at most ${NAME_MAX} characters`),
    )
    for (const key_prefix of [
      'qva_test',
      'qva_0123456789abcdef',
      'qva_012…abcde',
      'qvt_012...abcde',
    ]) {
      await expectRefusal(mint({ key_prefix }), 'bad_request', /^a key prefix is the first 7/)
    }
    expect(await t.run((ctx) => ctx.db.query('agent_keys').collect())).toEqual([])
    await mint({ name: ` ${EMOJI_AT_CAP} ` })
    const [key] = await t.run((ctx) => ctx.db.query('agent_keys').collect())
    expect(key).toMatchObject({ name: EMOJI_AT_CAP, key_prefix: 'qva_012...abcde' })
  })

  it('caps a personal token name, stores it trimmed and requires the display prefix', async () => {
    const t = newT()
    const f = await withOrg(t)
    const mint = (over: { name?: string; token_prefix?: string }) =>
      as(t, f.user).mutation(api.tokens.createMcpToken, {
        id: uuid(),
        profile_id: f.user.id,
        name: 'Laptop',
        token_prefix: 'qvt_0123456',
        token_hash: HEX64,
        access: 'write',
        ...over,
      })
    await expectRefusal(
      mint({ name: EMOJI_OVER }),
      'rule',
      sentence(`a token name must be at most ${NAME_MAX} characters`),
    )
    for (const token_prefix of ['qvt_test', 'qvt_01234567', 'qva_0123456', 'qvt_ABCDEF0']) {
      await expectRefusal(mint({ token_prefix }), 'bad_request', /^a token prefix is the first 11/)
    }
    expect(await t.run((ctx) => ctx.db.query('mcp_tokens').collect())).toEqual([])
    await mint({ name: ` ${AT_CAP} ` })
    const [token] = await t.run((ctx) => ctx.db.query('mcp_tokens').collect())
    expect(token).toMatchObject({ name: AT_CAP, token_prefix: 'qvt_0123456' })
  })
})

/* ------------------------------------------------------------- the wire */

const SECRET = `qva_${'1'.repeat(48)}`
type Wire = { status: number; json: unknown }

/* withOrg, with the fixture agent holding User on the TBED meta and an agent
 * key named `keyName`, so REST and MCP run over t.fetch as a client calls
 * them. */
async function wireOrg(t: T, keyName = 'limits'): Promise<OrgFixture> {
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
      name: keyName,
      key_prefix: 'qva_111...11111',
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
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: JSON.parse(await res.text()) }
}

describe('REST', () => {
  it('cuts a longer stored key name to 80 code points in the activity row of each write', async () => {
    const t = newT()
    const f = await wireOrg(t, 'k'.repeat(5_000))
    const created = await send(t, 'POST', '/v1/tasks', { project: f.sub.key, title: 'Signed' })
    expect(created.status).toBe(201)
    const events = await activityFor(t, f.org.id)
    expect(events.map((e) => e.detail)).toEqual([`via the REST API (${'k'.repeat(NAME_MAX)}…)`])
  })

  it('answers 400 with the milestone sentence for a longer name', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const add = (name: string) =>
      send(t, 'POST', `/v1/projects/${f.meta.key}/milestones`, { name, date: '2026-01-05' })
    expect(await add(OVER)).toEqual({ status: 400, json: { error: MILESTONE_NAME_TOO_LONG } })
    expect(await add(EMOJI_AT_CAP)).toMatchObject({ status: 201, json: { name: EMOJI_AT_CAP } })
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

const tooBig = (name: string, field: string, max: number): ToolResult => ({
  content: [
    {
      type: 'text',
      text: `Input validation error: Invalid arguments for tool ${name}: ${field}: Too big: expected string to have <=${max} characters`,
    },
  ],
  isError: true,
})

describe('MCP', () => {
  it('declares maxLength 80 on the name arguments', async () => {
    const t = newT()
    await wireOrg(t)
    const { tools } = (await mcp(t, 'tools/list', {})) as {
      tools: { name: string; inputSchema: { properties: Record<string, { maxLength?: number }> } }[]
    }
    const max = (name: string) =>
      tools.find((x) => x.name === name)?.inputSchema.properties.name?.maxLength
    expect(['create_project', 'update_project', 'set_milestone', 'set_team'].map(max)).toEqual([
      80, 80, 80, 80,
    ])
  })

  it('caps set_label names at 40 code points in the schema, as the server does', async () => {
    const t = newT()
    await wireOrg(t)
    const { tools } = (await mcp(t, 'tools/list', {})) as {
      tools: { name: string; inputSchema: { properties: Record<string, { maxLength?: number }> } }[]
    }
    const label = tools.find((x) => x.name === 'set_label')?.inputSchema.properties.name
    expect(label?.maxLength).toBe(40)
    const color = '#123ABC'
    expect(await tool(t, 'set_label', { name: '🚀'.repeat(41), color })).toMatchObject(
      tooBig('set_label', 'name', 40),
    )
    const made = await tool(t, 'set_label', { name: '🚀'.repeat(40), color })
    expect(made.isError).toBeUndefined()
    expect(JSON.parse(made.content[0].text)).toMatchObject({ name: '🚀'.repeat(40) })
  })

  it('counts code points for titles and names, as the server does', async () => {
    const t = newT()
    const f = await wireOrg(t)
    const made = await tool(t, 'create_task', { project: f.sub.key, title: EMOJI_AT_CAP })
    expect(made.isError).toBeUndefined()
    const { id } = JSON.parse(made.content[0].text) as { id: string }
    const task = await t.run((ctx) =>
      ctx.db
        .query('issues')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique(),
    )
    expect(task?.title).toBe(EMOJI_AT_CAP)
    expect(await tool(t, 'create_task', { project: f.sub.key, title: EMOJI_OVER })).toMatchObject(
      tooBig('create_task', 'title', 80),
    )
    const milestone = await tool(t, 'set_milestone', {
      project: f.meta.key,
      name: EMOJI_AT_CAP,
      date: '2026-01-05',
    })
    expect(milestone.isError).toBeUndefined()
    for (const name of [OVER, EMOJI_OVER]) {
      expect(
        await tool(t, 'set_milestone', { project: f.meta.key, name, date: '2026-01-05' }),
      ).toMatchObject(tooBig('set_milestone', 'name', 80))
    }
    expect(await t.run(async (ctx) => (await ctx.db.query('milestones').collect()).length)).toBe(1)
    // long text keeps counting UTF-16 code units
    expect(
      await tool(t, 'create_task', {
        project: f.sub.key,
        title: 'Units',
        description: '😀'.repeat(10_001),
      }),
    ).toMatchObject(tooBig('create_task', 'description', 20000))
  })
})
