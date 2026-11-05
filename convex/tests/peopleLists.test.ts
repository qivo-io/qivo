/* REST and MCP lists of people, labels, teams and a team's members, a page
 * at a time in name order (lib/listCursor.ts namedListPage, from
 * lib/core.ts userPage, model/labels.ts labelPage and model/teams.ts
 * teamPage and memberPage, with machine/shared.ts namedPaging):
 *
 *   1. Arguments on both surfaces, MCP's schema first, and the rule for a
 *      placeholder sent to the three tools that took no arguments before.
 *   2. Cursors: one list for both surfaces, sealed to the organization, the
 *      caller, the search and the team.
 *   3. Order and paging: name key byte order with the id breaking ties
 *      (labels by name_lower, then creation), every row once at any limit,
 *      the end only at the end, and renames between pages.
 *   4. Search over the whole list on the server.
 *   5. Rows and audience: who is listed, with which fields, for whom.
 *   6. Counts: member_count from team_counts, null and never 0 without one.
 *   7. Readiness: the lists in name order refuse while names are not ready.
 *   8. Budget: a page the read budget ends is short with a cursor.
 *   9. Single reads and writes: one team or user by id, and team writes.
 *  10. Reads that follow the page and not the organization.
 *  11. Reads at the design size, one figure a case, recorded in the page
 *      functions' docstrings. */

import { compareValues } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { UsersPageJson } from '../lib/core'
import type { Refusal, RefusalCode } from '../lib/functions'
import { DEFAULT_PAGE_SIZE, LIMITS, type Limit } from '../lib/limits'
import { CURSOR_REFUSAL, NAMES_NOT_READY, namedScope, offsetRefusal } from '../lib/listCursor'
import { NAMED_READ, namedCursor } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { sha256hex } from '../machine/auth'
import { getUser, listLabels as restListLabels, listUsers as restListUsers } from '../machine/rest'
import { restListTeamMembers, restListTeams } from '../machine/teams'
import { ACCESS_FIRST_PASS } from '../model/cascade'
import type { LabelsPageJson } from '../model/labels'
import { UNKEYED_MOST } from '../model/projectSettings'
import { insertTeamCount } from '../model/teamCounts'
import type { TeamMembersPageJson, TeamsPageJson } from '../model/teams'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import { teamJson } from './teamMembers.setup'

const DEFAULT_NAMED_READ = { ...NAMED_READ }
const DEFAULT_UNKEYED = { ...UNKEYED_MOST }
const DEFAULT_FIRST_PASS = { ...ACCESS_FIRST_PASS }
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_NAMED_READ)
  Object.assign(UNKEYED_MOST, DEFAULT_UNKEYED)
  Object.assign(ACCESS_FIRST_PASS, DEFAULT_FIRST_PASS)
})

/* --------------------------------------------------------------- fixture */

type Fx = OrgFixture & { t: T }

/* withOrg with every row of both organizations keyed, as on a deployment
 * (nameKeys.setup.ts keyOrg), and Hardware counted with its two members,
 * the user, who leads it, and the admin. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) => insertTeamCount(ctx, f.team, 2))
  await keyOrg(t, f.org.id)
  await keyOrg(t, f.otherOrg.id)
  return { t, ...f }
}

/* People of organization `orgId`, one profile each with its name key, in
 * one transaction. */
const plantPeople = (
  t: T,
  orgId: string,
  people: (Partial<Doc<'profiles'>> & { name: string })[],
): Promise<Doc<'profiles'>[]> =>
  t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (const p of people) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: orgId,
        initials: 'PP',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        created_at: NOW,
        name_key: nameKey(p.name),
        ...p,
      })
      out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    return out
  })

/* An ordinary name of about 20 characters for person `n`. */
const personName = (n: number) => `Person ${String(n).padStart(4, '0')} Example`

/* `count` people named personName(from) and on. */
const plantMany = (t: T, orgId: string, count: number, from = 0) =>
  plantPeople(
    t,
    orgId,
    Array.from({ length: count }, (_, i) => ({ name: personName(from + i) })),
  )

/* Memberships of `team` for `profiles`, each with its copy of the person's
 * name key, planted raw in one transaction without moving the count. */
const plantMembers = (
  t: T,
  team: Doc<'teams'>,
  profiles: readonly Doc<'profiles'>[],
  over: Partial<Doc<'team_members'>> = {},
) =>
  t.run(async (ctx) => {
    for (const profile of profiles)
      await ctx.db.insert('team_members', {
        team_id: team.id,
        profile_id: profile.id,
        is_leader: false,
        name_key: nameKey(profile.name),
        ...over,
      })
  })

/* Counts `team` again as internal/teamCountsBackfill does, step by step,
 * and answers the count. */
async function recount(t: T, team: Doc<'teams'>): Promise<number> {
  const step = (restart: boolean) =>
    t.mutation(internal.internal.teamCountsBackfill.step, { team_id: team.id, restart })
  let got = await step(true)
  while (got === null) got = await step(false)
  if (got === 'skipped') throw new Error('the team is gone')
  return got
}

/* Teams of organization `orgId` with these names, keyed and counted with no
 * members, in one transaction. */
const plantTeams = (t: T, orgId: string, names: readonly string[]): Promise<Doc<'teams'>[]> =>
  t.run(async (ctx) => {
    const out: Doc<'teams'>[] = []
    for (const name of names) {
      const _id = await ctx.db.insert('teams', {
        id: uuid(),
        org_id: orgId,
        name,
        name_key: nameKey(name),
        track_delay_default: true,
        created_at: NOW,
      })
      const team = (await ctx.db.get(_id)) as Doc<'teams'>
      await insertTeamCount(ctx, team, 0)
      out.push(team)
    }
    return out
  })

/* Labels of organization `orgId` with these names, in one transaction,
 * with name_lower as a writer stores it. */
const plantLabels = (t: T, orgId: string, names: readonly string[]): Promise<Doc<'labels'>[]> =>
  t.run(async (ctx) => {
    const out: Doc<'labels'>[] = []
    for (const name of names) {
      const _id = await ctx.db.insert('labels', {
        id: uuid(),
        org_id: orgId,
        name,
        name_lower: name.toLowerCase(),
        color: '#4C9AFF',
        created_at: NOW,
      })
      out.push((await ctx.db.get(_id)) as Doc<'labels'>)
    }
    return out
  })

/* ------------------------------------------------------------- the lists */

/** A row of any of the four lists. */
type Row = { id: string; name: string }

/** A page of any of the four lists, its rows under one name. */
type Paged = { next_cursor: string | null; rows: Row[]; raw: Record<string, unknown> }

/** One of the four lists, read over REST (query parameters as text) or
 * MCP (arguments as JSON values), by one caller. */
type List = {
  name: 'users' | 'labels' | 'teams' | 'members'
  limit: Limit & { readonly min: number }
  noun: string
  rest: (caller: Doc<'profiles'>, q?: Record<string, string>) => Promise<Paged>
  mcp: (caller: Doc<'profiles'>, a?: Record<string, unknown>) => Promise<Paged>
}

const reader = (caller: Doc<'profiles'>) => ({ callerId: caller.id, access: 'read' as const })

/* The page `raw` with its rows under `field`. */
const paged = (raw: Record<string, unknown>, field: string): Paged => ({
  next_cursor: raw.next_cursor as string | null,
  rows: raw[field] as Row[],
  raw,
})

/** REST GET /v1/users and MCP list_users. */
const usersList = (fx: Pick<Fx, 't'>): List => ({
  name: 'users',
  limit: LIMITS.listUsers,
  noun: 'users',
  rest: async (c, q = {}) =>
    paged(await fx.t.query(internal.machine.rest.listUsers, { ...reader(c), ...q }), 'users'),
  mcp: async (c, a = {}) =>
    paged(
      JSON.parse(
        await fx.t.query(internal.machine.mcp.listUsers, { ...reader(c), ...a }),
      ) as UsersPageJson,
      'users',
    ),
})

/** REST GET /v1/labels and MCP list_labels. */
const labelsList = (fx: Pick<Fx, 't'>): List => ({
  name: 'labels',
  limit: LIMITS.listLabels,
  noun: 'labels',
  rest: async (c, q = {}) =>
    paged(await fx.t.query(internal.machine.rest.listLabels, { ...reader(c), ...q }), 'labels'),
  mcp: async (c, a = {}) =>
    paged(
      JSON.parse(
        await fx.t.query(internal.machine.mcp.listLabels, { ...reader(c), ...a }),
      ) as LabelsPageJson,
      'labels',
    ),
})

/** REST GET /v1/teams and MCP list_teams. */
const teamsList = (fx: Pick<Fx, 't'>): List => ({
  name: 'teams',
  limit: LIMITS.listTeams,
  noun: 'teams',
  rest: async (c, q = {}) =>
    paged(await fx.t.query(internal.machine.teams.restListTeams, { ...reader(c), ...q }), 'teams'),
  mcp: async (c, a = {}) =>
    paged(
      JSON.parse(
        await fx.t.query(internal.machine.mcp.listTeams, { ...reader(c), ...a }),
      ) as TeamsPageJson,
      'teams',
    ),
})

/** REST GET /v1/teams/{id}/members and MCP list_team_members for `team`. */
const membersList = (fx: Pick<Fx, 't'>, team: { id: string }): List => ({
  name: 'members',
  limit: LIMITS.listTeamMembers,
  noun: 'team members',
  rest: async (c, q = {}) =>
    paged(
      await fx.t.query(internal.machine.teams.restListTeamMembers, {
        ...reader(c),
        ref: team.id,
        ...q,
      }),
      'members',
    ),
  mcp: async (c, a = {}) =>
    paged(
      JSON.parse(
        await fx.t.query(internal.machine.mcp.listTeamMembers, {
          ...reader(c),
          team_id: team.id,
          ...a,
        }),
      ) as TeamMembersPageJson,
      'members',
    ),
})

/** The four lists, the members of `team`. */
const everyList = (fx: Fx, team: { id: string } = fx.team): List[] => [
  usersList(fx),
  labelsList(fx),
  teamsList(fx),
  membersList(fx, team),
]

/** Every page `read` answers from the first, following next_cursor until it
 * is null, and every row on them in order. */
async function everyPage(read: (cursor: string | null) => Promise<Paged>, most = 2000) {
  const pages: Paged[] = []
  let cursor: string | null = null
  for (let n = 0; n < most; n++) {
    const page = await read(cursor)
    pages.push(page)
    if (page.next_cursor === null) return { pages, rows: pages.flatMap((p) => p.rows) }
    expect(page.next_cursor).not.toBe(cursor)
    cursor = page.next_cursor
  }
  throw new Error(`the pages did not end after ${most}`)
}

/** Every REST page of `list` for `caller` with `q`. */
const restPages = (list: List, caller: Doc<'profiles'>, q: Record<string, string> = {}) =>
  everyPage((cursor) => list.rest(caller, cursor === null ? q : { ...q, cursor }))

/** Every MCP page of `list` for `caller` with `a`. */
const mcpPages = (list: List, caller: Doc<'profiles'>, a: Record<string, unknown> = {}) =>
  everyPage((cursor) => list.mcp(caller, cursor === null ? a : { ...a, cursor }))

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

/* `rows` in name key byte order with the id breaking ties, as Convex
 * orders values. */
const nameOrder = <R extends Row>(rows: readonly R[]): R[] =>
  [...rows].sort((a, b) => compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id]))

/* The profiles of organization `orgId` in name order. */
const peopleInOrder = (t: T, orgId: string) =>
  t.run(async (ctx) =>
    nameOrder(
      await ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    ),
  )

/* A public or internal function's handler, run inside `ctx`, so a test can
 * read the transaction's metrics after it. */
const handlerOf = <Args, Out>(fn: unknown) =>
  (fn as { _handler: (ctx: QueryCtx, args: Args) => Promise<Out> })._handler

/* What `run` read, by Convex's counts. */
async function readsOf<R>(ctx: QueryCtx, run: () => Promise<R>) {
  const before = await ctx.meta.getTransactionMetrics()
  const out = await run()
  const after = await ctx.meta.getTransactionMetrics()
  return {
    out,
    ranges: after.databaseQueries.used - before.databaseQueries.used,
    documents: after.documentsRead.used - before.documentsRead.used,
    bytes: after.bytesRead.used - before.bytesRead.used,
  }
}

/** One REST call of the internal query `fn` with `args`, with what it read. */
const measured = <Out>(t: T, fn: unknown, args: Record<string, unknown>) =>
  t.query((ctx) => readsOf(ctx, () => handlerOf<Record<string, unknown>, Out>(fn)(ctx, args)))

/* --------------------------------------------------------- MCP over HTTP */

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }

/* One request to the deployment's HTTP router. */
async function fetchPath(t: T, path: string, init: FetchInit = {}) {
  const res = await (
    t as unknown as {
      fetch(path: string, init?: FetchInit): Promise<{ status: number; text(): Promise<string> }>
    }
  ).fetch(path, init)
  return { status: res.status, text: await res.text() }
}

/* An agent key of `agent`, for the requests made over HTTP. */
async function agentKeyOf(t: T, agent: Doc<'profiles'>): Promise<string> {
  const key = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const key_hash = await sha256hex(key)
  await t.run((ctx) =>
    ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'People key',
      key_prefix: key.slice(0, 11),
      key_hash,
      created_at: NOW,
    }),
  )
  return key
}

/* Tool `name` over MCP's modern leg with `key` and `args`, answering the
 * tool's text and whether it is an error result. */
async function mcpTool(t: T, key: string, name: string, args: unknown) {
  const res = await fetchPath(t, '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })
  expect(res.status, res.text).toBe(200)
  const { result } = JSON.parse(res.text) as {
    result: { content: { text: string }[]; isError?: boolean }
  }
  return { text: result.content[0].text, isError: result.isError === true }
}

/* A REST GET of `path` with `key`, with the parsed body. */
async function restGet(t: T, key: string, path: string) {
  const res = await fetchPath(t, path, { headers: { Authorization: `Bearer ${key}` } })
  return { status: res.status, body: JSON.parse(res.text) as Record<string, unknown> }
}

/* ------------------------------------------------------------ 1. arguments */

describe('the arguments', () => {
  it('pages 50 rows by default and 1 to 200 on request, and refuses another limit, on both surfaces', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 55)
    await plantLabels(
      fx.t,
      fx.org.id,
      Array.from({ length: 55 }, (_, i) => `Label ${i}`),
    )
    await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 55 }, (_, i) => `Team ${i}`),
    )
    await plantMembers(fx.t, fx.team, people)
    for (const list of everyList(fx)) {
      expect((await list.rest(fx.admin)).rows, list.name).toHaveLength(DEFAULT_PAGE_SIZE)
      expect((await list.mcp(fx.admin)).rows, list.name).toHaveLength(DEFAULT_PAGE_SIZE)
      expect((await list.rest(fx.admin, { limit: '1' })).rows, list.name).toHaveLength(1)
      expect((await list.mcp(fx.admin, { limit: 200 })).next_cursor, list.name).toBeNull()
      for (const limit of ['0', '201', '1.5', 'x', ''])
        await refused(list.rest(fx.admin, { limit }), 'rule', list.limit.refusal)
      for (const limit of [0, 201, 1.5])
        await refused(list.mcp(fx.admin, { limit }), 'rule', list.limit.refusal)
    }
    expect(LIMITS.listUsers.refusal).toBe('limit must be a whole number of users from 1 to 200.')
    expect(LIMITS.listLabels.refusal).toBe('limit must be a whole number of labels from 1 to 200.')
    expect(LIMITS.listTeams.refusal).toBe('limit must be a whole number of teams from 1 to 200.')
    expect(LIMITS.listTeamMembers.refusal).toBe(
      'limit must be a whole number of members from 1 to 200.',
    )
  })

  it('takes an offset of 0 and refuses any other with the sentence that names the cursor', async () => {
    const fx = await setup()
    await plantLabels(fx.t, fx.org.id, ['Red'])
    for (const list of everyList(fx)) {
      const sentence = offsetRefusal(list.noun)
      for (const zero of ['0', '00'])
        expect((await list.rest(fx.admin, { offset: zero, limit: '1' })).rows).toHaveLength(1)
      for (const other of ['1', '-1', 'x', ''])
        await refused(list.rest(fx.admin, { offset: other }), 'bad_request', sentence)
      expect((await list.mcp(fx.admin, { offset: 0, limit: 1 })).rows).toHaveLength(1)
      await refused(list.mcp(fx.admin, { offset: 1 }), 'bad_request', sentence)
    }
    expect(offsetRefusal('team members')).toBe(
      'offset does not apply to team members; pass next_cursor as cursor',
    )
  })

  it('checks the limit, then the offset, then the search, then the cursor', async () => {
    const fx = await setup()
    const long = 'word '.repeat(41)
    for (const list of everyList(fx)) {
      await refused(list.rest(fx.admin, { limit: '0', offset: '1' }), 'rule', list.limit.refusal)
      await refused(
        list.rest(fx.admin, { offset: '1', search: long }),
        'bad_request',
        offsetRefusal(list.noun),
      )
      // a search past 200 characters is refused before the cursor is opened
      await refused(
        list.rest(fx.admin, { search: long, cursor: 'junk' }),
        'rule',
        LIMITS.search.refusal,
      )
      await refused(
        list.mcp(fx.admin, { search: long, cursor: 'junk' }),
        'rule',
        LIMITS.search.refusal,
      )
      // trimmed first, so 200 characters with blanks around them pass
      expect((await list.rest(fx.admin, { search: `  ${'a'.repeat(200)}  ` })).rows).toEqual([])
    }
    expect(LIMITS.search.refusal).toBe(
      'a search must be at most 200 characters. Search for fewer words.',
    )
  })

  it('reads an empty REST cursor or search as absent, and refuses an empty MCP cursor', async () => {
    const fx = await setup()
    await plantLabels(fx.t, fx.org.id, ['Red', 'Blue'])
    await plantTeams(fx.t, fx.org.id, ['Assembly'])
    for (const list of everyList(fx)) {
      const first = await list.rest(fx.admin, { limit: '1' })
      expect(first.next_cursor, list.name).toEqual(expect.any(String))
      // cursors seal deterministically, so the same page answers the same one
      expect(await list.rest(fx.admin, { limit: '1', cursor: '', search: '' }), list.name).toEqual(
        first,
      )
      await refused(list.mcp(fx.admin, { cursor: '' }), 'bad_request', CURSOR_REFUSAL)
      expect((await list.mcp(fx.admin, { limit: 1, search: '' })).rows, list.name).toEqual(
        first.rows,
      )
    }
  })

  it('refuses an unknown REST query parameter, and checks a whole number in MCP’s schema first', async () => {
    const fx = await setup()
    const key = await agentKeyOf(fx.t, fx.agent)
    const takes = 'this request takes search, limit, cursor, offset'
    for (const path of [
      '/v1/users',
      '/v1/labels',
      '/v1/teams',
      `/v1/teams/${fx.team.id}/members`,
    ]) {
      expect(await restGet(fx.t, key, `${path}?page=2`), path).toEqual({
        status: 400,
        body: { error: `unknown query parameter "page"; ${takes}` },
      })
      // REST sends JSON with its keys in Convex's sorted order, so the
      // cursor's place in the text varies; MCP's text puts it first
      const ok = await restGet(fx.t, key, `${path}?limit=1&offset=0&search=&cursor=`)
      expect(ok.status, path).toBe(200)
      expect(ok.body.next_cursor, path).toBeDefined()
    }
    for (const [tool, base] of [
      ['list_users', {}],
      ['list_labels', {}],
      ['list_teams', {}],
      ['list_team_members', { team_id: fx.team.id }],
    ] as const) {
      const schema = (field: string, issue: string) =>
        `Input validation error: Invalid arguments for tool ${tool}: ${field}: ${issue}`
      expect(await mcpTool(fx.t, key, tool, { ...base, limit: 1.5 })).toEqual({
        isError: true,
        text: schema('limit', 'Invalid input: expected int, received number'),
      })
      expect(await mcpTool(fx.t, key, tool, { ...base, search: 7 })).toEqual({
        isError: true,
        text: schema('search', 'Invalid input: expected string, received number'),
      })
      const range = await mcpTool(fx.t, key, tool, { ...base, limit: 201 })
      expect(range.isError, tool).toBe(true)
      expect(range.text, tool).toContain('limit must be a whole number of')
      const page = await mcpTool(fx.t, key, tool, { ...base, limit: 1 })
      expect(page.isError, page.text).toBe(false)
      // the cursor first, so a truncated result still shows it
      expect(Object.keys(JSON.parse(page.text))[0], tool).toBe('next_cursor')
    }
    expect(await mcpTool(fx.t, key, 'list_team_members', {})).toEqual({
      isError: true,
      text: 'Input validation error: Invalid arguments for tool list_team_members: team_id: Invalid input: expected string, received undefined',
    })
    const missing = uuid()
    expect(await mcpTool(fx.t, key, 'list_team_members', { team_id: missing })).toEqual({
      isError: true,
      text: `team "${missing}" not found in your organization`,
    })
  })

  it('answers a placeholder sent alone as a call of the older catalogue, and refuses it beside a real argument', async () => {
    const fx = await setup()
    const key = await agentKeyOf(fx.t, fx.agent)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      for (const tool of ['list_users', 'list_labels', 'list_teams']) {
        const unknown = `Input validation error: Invalid arguments for tool ${tool}: Unrecognized key`
        // a placeholder alone answers the first page, and its name is logged
        const alone = await mcpTool(fx.t, key, tool, { random_string: 'x' })
        expect(alone.isError, alone.text).toBe(false)
        expect(JSON.parse(alone.text)).toEqual(
          JSON.parse((await mcpTool(fx.t, key, tool, {})).text),
        )
        expect(info).toHaveBeenCalledWith('MCP call dropped unknown arguments', {
          tool,
          keys: ['random_string'],
          count: 1,
        })
        // beside a real argument it is refused, as on every other tool
        expect(await mcpTool(fx.t, key, tool, { random_string: 'x', limit: 1 })).toEqual({
          isError: true,
          text: `${unknown}: "random_string"`,
        })
        // the answer's own next_cursor is refused even alone, so a loop that
        // sends it back under that name never reads page 1 again
        expect(await mcpTool(fx.t, key, tool, { next_cursor: 'abc' })).toEqual({
          isError: true,
          text: `${unknown}: "next_cursor"`,
        })
        expect(await mcpTool(fx.t, key, tool, { random_string: 'x', next_cursor: 'abc' })).toEqual({
          isError: true,
          text: `${unknown}s: "random_string", "next_cursor"`,
        })
        // arguments that are not an object are refused now these tools take some
        expect(await mcpTool(fx.t, key, tool, 'x')).toEqual({
          isError: true,
          text: `Input validation error: Invalid arguments for tool ${tool}: Invalid input: expected object, received string`,
        })
      }
      // list_team_members never took no arguments, so it refuses a placeholder
      const members = await mcpTool(fx.t, key, 'list_team_members', {
        team_id: fx.team.id,
        random_string: 'x',
      })
      expect(members).toEqual({
        isError: true,
        text: 'Input validation error: Invalid arguments for tool list_team_members: Unrecognized key: "random_string"',
      })
      // get_me takes none and still ignores whatever it is sent
      for (const args of [{ random_string: 'x' }, 'x']) {
        const me = await mcpTool(fx.t, key, 'get_me', args)
        expect(me.isError).toBe(false)
      }
    } finally {
      info.mockRestore()
    }
  })
})

/* -------------------------------------------------------------- 2. cursors */

describe('the cursors', () => {
  it('refuses a cursor of another list, organization, caller, search or team, a changed one and junk', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 4)
    await plantLabels(fx.t, fx.org.id, ['One', 'Two', 'Three'])
    const [assembly] = await plantTeams(fx.t, fx.org.id, ['Assembly', 'Brakes'])
    await plantMembers(fx.t, fx.team, people)
    await plantMembers(fx.t, assembly, people)
    const others = await plantMany(fx.t, fx.otherOrg.id, 3)
    const lists = everyList(fx)
    const cursorOf = async (list: List, caller = fx.admin, q: Record<string, string> = {}) => {
      const page = await list.rest(caller, { limit: '1', ...q })
      expect(page.next_cursor, list.name).toEqual(expect.any(String))
      return page.next_cursor as string
    }
    for (const list of lists) {
      const mine = await cursorOf(list)
      // another list's, the workload's included
      for (const other of lists.filter((l) => l.name !== list.name))
        await refused(
          list.rest(fx.admin, { cursor: await cursorOf(other) }),
          'bad_request',
          CURSOR_REFUSAL,
        )
      const workload = await fx.t.query(internal.machine.records.restWorkload, {
        ...reader(fx.admin),
        today: '2026-09-09',
        limit: '1',
      })
      await refused(
        list.rest(fx.admin, { cursor: workload.next_cursor as string }),
        'bad_request',
        CURSOR_REFUSAL,
      )
      // another caller's
      await refused(list.rest(fx.user, { cursor: mine }), 'bad_request', CURSOR_REFUSAL)
      // another search's, with the search it came from accepted
      const searched = await cursorOf(list, fx.admin, { search: 'e' })
      await refused(list.rest(fx.admin, { cursor: searched }), 'bad_request', CURSOR_REFUSAL)
      await refused(
        list.rest(fx.admin, { cursor: searched, search: 'o' }),
        'bad_request',
        CURSOR_REFUSAL,
      )
      expect(
        (await list.rest(fx.admin, { cursor: searched, search: 'e' })).rows.length,
      ).toBeLessThanOrEqual(50)
      // a changed one and junk
      const flipped = `${mine.slice(0, -1)}${mine.endsWith('0') ? '1' : '0'}`
      for (const cursor of [flipped, 'junk', `${mine}0`])
        await refused(list.rest(fx.admin, { cursor }), 'bad_request', CURSOR_REFUSAL)
      await refused(list.mcp(fx.admin, { cursor: 'junk' }), 'bad_request', CURSOR_REFUSAL)
    }
    // another organization's, whose admin pages its own roster
    const foreign = await usersList(fx).rest(fx.otherAdmin, { limit: '1' })
    expect(foreign.rows.every((r) => [fx.otherAdmin, ...others].some((p) => p.id === r.id))).toBe(
      true,
    )
    await refused(
      usersList(fx).rest(fx.admin, { cursor: foreign.next_cursor as string }),
      'bad_request',
      CURSOR_REFUSAL,
    )
    // another team's members
    const hardware = await cursorOf(membersList(fx, fx.team))
    await refused(
      membersList(fx, assembly).rest(fx.admin, { cursor: hardware }),
      'bad_request',
      CURSOR_REFUSAL,
    )
  })

  it('continues a cursor on the other surface, takes a new limit on each page, and shares one between "Café" and "cafe"', async () => {
    const fx = await setup()
    const people = await plantPeople(fx.t, fx.org.id, [
      { name: 'Café Owner' },
      { name: 'cafe Clerk' },
      { name: 'CAFÉ Cook' },
      { name: 'Barista' },
    ])
    await plantLabels(fx.t, fx.org.id, ['Café one', 'cafe two', 'Café three', 'Tea'])
    await plantTeams(fx.t, fx.org.id, ['Café crew', 'cafe staff', 'CAFE bar', 'Kitchen'])
    await plantMembers(fx.t, fx.team, people)
    for (const list of everyList(fx)) {
      const all = (await restPages(list, fx.admin, { limit: '200' })).rows
      // REST then MCP then REST, a different limit each time
      const one = await list.rest(fx.admin, { limit: '1' })
      const two = await list.mcp(fx.admin, { limit: 2, cursor: one.next_cursor })
      const rest = await restPages(list, fx.admin, {
        limit: '3',
        ...(two.next_cursor === null ? {} : { cursor: two.next_cursor }),
      })
      const joined = [...one.rows, ...two.rows, ...(two.next_cursor === null ? [] : rest.rows)]
      expect(
        joined.map((r) => r.id),
        list.name,
      ).toEqual(all.map((r) => r.id))
      // two searches with one name key share cursors
      const cafe = await list.rest(fx.admin, { limit: '1', search: 'Café' })
      expect(cafe.next_cursor, list.name).toEqual(expect.any(String))
      const next = await list.mcp(fx.admin, { cursor: cafe.next_cursor, search: 'cafe' })
      const whole = await restPages(list, fx.admin, { search: 'CAFE' })
      expect([...cafe.rows, ...next.rows], list.name).toEqual(whole.rows)
      expect(whole.rows.length, list.name).toBe(3)
    }
  })

  it('refuses a sealed cursor whose tie is not the list’s', async () => {
    const fx = await setup()
    const scope = await namedScope(fx.admin, '')
    // a label tie is a creation time and an _id, a person's one id
    for (const [list, tie] of [
      ['machine.labels', ['x', 'y']],
      ['machine.labels', [1]],
      ['machine.users', [1]],
      ['machine.users', ['a', 'b']],
      ['machine.teams', [2]],
    ] as const) {
      const cursor = await namedCursor(list, scope, { key: 'a', tie: [...tie] })
      const target =
        list === 'machine.labels'
          ? labelsList(fx)
          : list === 'machine.users'
            ? usersList(fx)
            : teamsList(fx)
      await refused(target.rest(fx.admin, { cursor }), 'bad_request', CURSOR_REFUSAL)
    }
    // the right shape opens
    const ok = await namedCursor('machine.labels', scope, { key: 'a', tie: [0, 'x'] })
    expect((await labelsList(fx).rest(fx.admin, { cursor: ok })).next_cursor).toBeNull()
  })
})

/* ----------------------------------------------------- 3. order and paging */

describe('the order and the pages', () => {
  it('lists every row once at limits 1, 2, 7 and 50, in name order, the end only at the end', async () => {
    const fx = await setup()
    // 23 people (the fixture's 5 and 18 more), 23 labels, 23 teams and a
    // team of 23 members
    const people = await plantMany(fx.t, fx.org.id, 18)
    await plantLabels(
      fx.t,
      fx.org.id,
      Array.from({ length: 23 }, (_, i) => `Label ${String.fromCharCode(97 + ((i * 7) % 23))}${i}`),
    )
    const teams = await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 22 }, (_, i) => `Team ${String.fromCharCode(97 + ((i * 5) % 22))}${i}`),
    )
    const [crew] = teams
    const roster = await peopleInOrder(fx.t, fx.org.id)
    expect(roster).toHaveLength(23)
    const guestless = roster.filter((p) => p.org_role !== 'guest')
    await plantMembers(fx.t, crew, [...guestless, (await plantMany(fx.t, fx.org.id, 1, 900))[0]])
    expect(people).toHaveLength(18)
    const labels = await fx.t.run(async (ctx) =>
      (
        await ctx.db
          .query('labels')
          .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
          .collect()
      ).sort((a, b) =>
        compareValues(
          [a.name_lower, a._creationTime, a._id],
          [b.name_lower, b._creationTime, b._id],
        ),
      ),
    )
    const allTeams = await fx.t.run(async (ctx) =>
      nameOrder(
        await ctx.db
          .query('teams')
          .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
          .collect(),
      ),
    )
    const members = nameOrder(await peopleInOrder(fx.t, fx.org.id)).filter(
      (p) => p.org_role !== 'guest',
    )
    const wanted: Record<List['name'], string[]> = {
      users: (await peopleInOrder(fx.t, fx.org.id)).map((p) => p.id),
      labels: labels.map((l) => l.id),
      teams: allTeams.map((t) => t.id),
      members: members.map((p) => p.id),
    }
    for (const list of everyList(fx, crew)) {
      expect(wanted[list.name], list.name).toHaveLength(list.name === 'users' ? 24 : 23)
      for (const limit of [1, 2, 7, 50]) {
        const { pages, rows } = await restPages(list, fx.admin, { limit: String(limit) })
        expect(
          rows.map((r) => r.id),
          `${list.name} at ${limit}`,
        ).toEqual(wanted[list.name])
        // no budget stops a page this small, so every page but the last is full
        const n = wanted[list.name].length
        expect(pages, `${list.name} at ${limit}`).toHaveLength(Math.ceil(n / limit))
        for (const page of pages.slice(0, -1)) expect(page.rows).toHaveLength(limit)
        const mcp = await mcpPages(list, fx.admin, { limit })
        expect(mcp.rows.map((r) => r.id)).toEqual(wanted[list.name])
      }
    }
  })

  it('orders equal name keys by id, and by bytes where localeCompare differs', async () => {
    const fx = await setup()
    const twins = await plantPeople(fx.t, fx.org.id, [{ name: 'Sam Lee' }, { name: 'sam  LEE' }])
    // ß is two bytes, C3 9F, so its key sorts after "t" by bytes, while
    // localeCompare puts it with "ss", before "t"
    const [strasse, tom] = await plantPeople(fx.t, fx.org.id, [{ name: 'ßanne' }, { name: 'Tom' }])
    expect('ßanne'.localeCompare('Tom')).toBeLessThan(0)
    const [one, two] = await plantTeams(fx.t, fx.org.id, ['Ops', 'ops'])
    await plantMembers(fx.t, fx.team, [...twins, strasse, tom])
    const ids = (rows: Row[]) => rows.map((r) => r.id)
    const users = ids((await restPages(usersList(fx), fx.admin)).rows)
    const byIdOrder = [...twins].sort((a, b) => compareValues(a.id, b.id)).map((p) => p.id)
    expect(users.filter((id) => byIdOrder.includes(id))).toEqual(byIdOrder)
    expect(users.indexOf(tom.id)).toBeLessThan(users.indexOf(strasse.id))
    expect(users.at(-1)).toBe(strasse.id)
    const teams = ids((await restPages(teamsList(fx), fx.admin)).rows)
    const opsOrder = [one, two].sort((a, b) => compareValues(a.id, b.id)).map((t) => t.id)
    expect(teams.filter((id) => opsOrder.includes(id))).toEqual(opsOrder)
    const members = ids((await restPages(membersList(fx, fx.team), fx.admin)).rows)
    expect(members.filter((id) => byIdOrder.includes(id))).toEqual(byIdOrder)
    expect(members.at(-1)).toBe(strasse.id)
  })

  it('orders labels as Settings › Labels does: "Éclair" after "zebra", and one name_lower by creation', async () => {
    const fx = await setup()
    const [eclair, zebra, apple] = await plantLabels(fx.t, fx.org.id, ['Éclair', 'zebra', 'Apple'])
    // two labels stored with one name_lower before names were unique, in
    // two transactions so their creation times differ
    const [legacyA] = await plantLabels(fx.t, fx.org.id, ['Legacy'])
    const [legacyB] = await plantLabels(fx.t, fx.org.id, ['LEGACY'])
    const rows = (await restPages(labelsList(fx), fx.admin, { limit: '1' })).rows
    expect(rows.map((r) => r.id)).toEqual([apple.id, legacyA.id, legacyB.id, zebra.id, eclair.id])
    // the app's Settings > Labels reads the same order
    const settings = await as(fx.t, fx.admin).query(api.labels.settingsPage, { org_id: fx.org.id })
    expect(settings.rows.map((r: { id: string }) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('places a row renamed between pages by its new name, and a member by the copy of its key', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 18)
    await plantMembers(fx.t, fx.team, people)
    const rename = (p: Doc<'profiles'>, name: string, copies: boolean) =>
      fx.t.run(async (ctx) => {
        await ctx.db.patch(p._id, { name, name_key: nameKey(name) })
        if (!copies) return
        const rows = await ctx.db
          .query('team_members')
          .withIndex('by_profile', (q) => q.eq('profile_id', p.id))
          .collect()
        for (const row of rows) await ctx.db.patch(row._id, { name_key: nameKey(name) })
      })
    const users = usersList(fx)
    const first = await users.rest(fx.admin, { limit: '5' })
    const before = (await peopleInOrder(fx.t, fx.org.id)).map((p) => p.id)
    // one already read moves past the cursor, one not yet read moves later
    const read = people.find((p) => first.rows.some((r) => r.id === p.id)) as Doc<'profiles'>
    const unread = people.at(-1) as Doc<'profiles'>
    expect(first.rows.some((r) => r.id === unread.id)).toBe(false)
    await rename(read, 'Zz Read Again', true)
    await rename(unread, 'Zzz Unread Later', true)
    const rest = await restPages(users, fx.admin, { cursor: first.next_cursor as string })
    const seen = [...first.rows, ...rest.rows].map((r) => r.id)
    // every row once, but the one read before the rename shows twice
    expect(seen.filter((id) => id === read.id)).toHaveLength(2)
    expect(new Set(seen)).toEqual(new Set(before))
    expect(rest.rows.slice(-2).map((r) => r.name)).toEqual(['Zz Read Again', 'Zzz Unread Later'])
    // a member renamed whose copy trails sorts by the earlier name and
    // shows the new one
    const trailing = people[5]
    const wasAt = (await restPages(membersList(fx, fx.team), fx.admin)).rows.findIndex(
      (r) => r.id === trailing.id,
    )
    await rename(trailing, 'Aaa Renamed', false)
    const after = (await restPages(membersList(fx, fx.team), fx.admin, { limit: '4' })).rows
    expect(after.findIndex((r) => r.id === trailing.id)).toBe(wasAt)
    expect(after.find((r) => r.id === trailing.id)?.name).toBe('Aaa Renamed')
    // a search by the new name misses it until the copy is in line, and
    // one by the earlier name still finds it
    expect((await membersList(fx, fx.team).rest(fx.admin, { search: 'aaa renamed' })).rows).toEqual(
      [],
    )
    expect(
      (await membersList(fx, fx.team).rest(fx.admin, { search: personName(5) })).rows.map(
        (r) => r.id,
      ),
    ).toEqual([trailing.id])
    // the teams list places a renamed team by its new name
    const [late] = await plantTeams(fx.t, fx.org.id, ['Zulu'])
    const teams = teamsList(fx)
    const head = await teams.rest(fx.admin, { limit: '1' })
    await fx.t.run((ctx) => ctx.db.patch(late._id, { name: 'Alpha', name_key: nameKey('Alpha') }))
    const tail = await restPages(teams, fx.admin, { cursor: head.next_cursor as string })
    expect([...head.rows, ...tail.rows].map((r) => r.name)).toEqual(['Hardware'])
    expect((await restPages(teams, fx.admin)).rows.map((r) => r.name)).toEqual([
      'Alpha',
      'Hardware',
    ])
  })
})

/* ----------------------------------------------------------------- 4. search */

describe('the search', () => {
  it('keeps every word in any order, ignoring case and accents, over the whole list', async () => {
    const fx = await setup()
    const people = await plantPeople(fx.t, fx.org.id, [
      { name: 'Ada Lovelace' },
      { name: 'Grace Hopper' },
      { name: 'Ada Hopper' },
      { name: 'Zoë Ångström' },
      ...Array.from({ length: 30 }, (_, i) => ({ name: personName(i) })),
    ])
    const [adaHopper, zoe] = [people[2], people[3]]
    await plantLabels(fx.t, fx.org.id, ['Étiquette rouge', 'Rouge', 'Bleu'])
    await plantTeams(fx.t, fx.org.id, ['Field Ops', 'Ops Field North', 'Finance'])
    await plantMembers(fx.t, fx.team, people)
    const users = usersList(fx)
    expect((await users.rest(fx.admin, { search: 'hopper ADA' })).rows.map((r) => r.id)).toEqual([
      adaHopper.id,
    ])
    expect((await users.mcp(fx.admin, { search: 'zoe angstrom' })).rows.map((r) => r.id)).toEqual([
      zoe.id,
    ])
    // a match past the first page of the whole roster is found on the first
    expect(
      (await users.rest(fx.admin, { search: personName(29), limit: '1' })).rows.map((r) => r.name),
    ).toEqual([personName(29)])
    // a blank search browses
    const all = (await restPages(users, fx.admin)).rows
    expect((await restPages(users, fx.admin, { search: '   ' })).rows).toEqual(all)
    expect(all).toHaveLength(39)
    expect(
      (await labelsList(fx).rest(fx.admin, { search: 'ROUGE etiquette' })).rows.map((r) => r.name),
    ).toEqual(['Étiquette rouge'])
    expect((await labelsList(fx).rest(fx.admin, { search: 'rouge' })).rows).toHaveLength(2)
    expect(
      (await teamsList(fx).mcp(fx.admin, { search: 'field ops' })).rows.map((r) => r.name),
    ).toEqual(['Field Ops', 'Ops Field North'])
    const members = membersList(fx, fx.team)
    expect(
      (await members.rest(fx.admin, { search: 'ångström ZOË' })).rows.map((r) => r.id),
    ).toEqual([zoe.id])
    // a member search stays within its team
    const [other] = await plantTeams(fx.t, fx.org.id, ['Other'])
    expect((await membersList(fx, other).rest(fx.admin, { search: 'zoe' })).rows).toEqual([])
    await plantMembers(fx.t, other, [fx.viewer])
    expect((await members.rest(fx.admin, { search: 'viewer' })).rows).toEqual([])
    expect((await membersList(fx, other).rest(fx.admin, { search: 'view' })).rows).toEqual([
      { id: fx.viewer.id, name: 'viewer', leader: false },
    ])
  })
})

/* ------------------------------------------------------ 5. rows and audience */

describe('the rows and who reads them', () => {
  it('lists every profile as userJson, inactive people, agents, Viewers, guests and unclaimed seats included', async () => {
    const fx = await setup()
    const [gone, seat] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Former Staff', active: false },
      { name: 'Invited Seat', email: 'seat@testbed.test' },
    ])
    const rows = (await mcpPages(usersList(fx), fx.admin)).rows as unknown as UsersPageJson['users']
    expect(rows.map((r) => r.id).sort()).toEqual(
      [fx.admin, fx.user, fx.viewer, fx.guest, fx.agent, gone, seat].map((p) => p.id).sort(),
    )
    for (const row of rows)
      expect(Object.keys(row)).toEqual([
        'id',
        'name',
        'org_role',
        'kind',
        'active',
        'plannable_hours',
      ])
    expect(rows.find((r) => r.id === gone.id)).toMatchObject({ active: false })
    expect(rows.find((r) => r.id === fx.agent.id)).toMatchObject({
      kind: 'agent',
      plannable_hours: null,
    })
    expect(rows.find((r) => r.id === fx.guest.id)).toMatchObject({ org_role: 'guest' })
    expect(JSON.stringify(rows)).not.toContain('@testbed.test')
    // nobody of the other organization
    expect(rows.some((r) => r.id === fx.otherAdmin.id)).toBe(false)
  })

  it('answers a guest, a Viewer, an agent and a read-only credential the pages an admin reads', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 9)
    await plantLabels(fx.t, fx.org.id, ['Red', 'Green', 'Blue', 'Amber'])
    await plantTeams(fx.t, fx.org.id, ['Assembly', 'Brakes', 'Chassis'])
    await plantMembers(fx.t, fx.team, people)
    for (const list of everyList(fx)) {
      const admin = await restPages(list, fx.admin, { limit: '3' })
      for (const who of [fx.guest, fx.viewer, fx.agent, fx.user]) {
        const theirs = await restPages(list, who, { limit: '3' })
        expect(
          theirs.pages.map((p) => p.rows),
          `${list.name} for ${who.name}`,
        ).toEqual(admin.pages.map((p) => p.rows))
      }
    }
    // a write credential reads them too
    const page = await fx.t.query(internal.machine.rest.listUsers, {
      callerId: fx.agent.id,
      access: 'write',
    })
    expect(page.users).toHaveLength(14)
  })

  it('leaves out a guest’s stale membership, a removed profile’s leftover and another organization’s profile', async () => {
    const fx = await setup()
    const [kept] = await plantMany(fx.t, fx.org.id, 1)
    // every one with a copy, so the list walks past it
    await plantMembers(fx.t, fx.team, [kept, fx.guest, fx.otherAdmin])
    await fx.t.run((ctx) =>
      ctx.db.insert('team_members', {
        team_id: fx.team.id,
        profile_id: uuid(),
        is_leader: false,
        name_key: 'aaa removed',
      }),
    )
    const rows = (await restPages(membersList(fx, fx.team), fx.admin)).rows
    expect(rows.map((r) => r.id)).toEqual([fx.admin.id, kept.id, fx.user.id])
    // the old whole-team reader lists the same members
    expect(await fx.t.run(async (ctx) => (await teamJson(ctx, fx.team)).members)).toEqual(rows)
  })

  it('answers leader false for a leader row an agent or a Viewer holds', async () => {
    const fx = await setup()
    await plantMembers(fx.t, fx.team, [fx.agent, fx.viewer], { is_leader: true })
    const rows = (await membersList(fx, fx.team).mcp(fx.guest)).rows
    expect(rows).toEqual([
      { id: fx.admin.id, name: 'admin', leader: false },
      { id: fx.agent.id, name: 'Relay', leader: false },
      { id: fx.user.id, name: 'user', leader: true },
      { id: fx.viewer.id, name: 'viewer', leader: false },
    ])
  })
})

/* ------------------------------------------------------------------ 6. counts */

describe('the member counts', () => {
  it('answers each team’s count as its member pages count it, and keeps it whole beside a search', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 6)
    const ids = [uuid(), uuid()]
    for (const [i, id] of ids.entries())
      await as(fx.t, fx.admin).mutation(api.teams.create, {
        org_id: fx.org.id,
        id,
        name: `Crew ${i}`,
      })
    for (const person of people.slice(0, 4))
      await as(fx.t, fx.admin).mutation(api.teams.addMember, {
        org_id: fx.org.id,
        team_id: ids[0],
        profile_id: person.id,
      })
    for (const person of [...people.slice(3), fx.viewer, fx.agent])
      await as(fx.t, fx.admin).mutation(api.teams.addMember, {
        org_id: fx.org.id,
        team_id: ids[1],
        profile_id: person.id,
      })
    const teams = (await restPages(teamsList(fx), fx.viewer))
      .rows as unknown as TeamsPageJson['teams']
    expect(teams.map((t) => [t.name, t.member_count])).toEqual([
      ['Crew 0', 4],
      ['Crew 1', 5],
      ['Hardware', 2],
    ])
    for (const team of teams) {
      const pages = await restPages(membersList(fx, team), fx.viewer, { limit: '2' })
      expect(pages.rows, team.name).toHaveLength(team.member_count as number)
      for (const page of pages.pages)
        expect((page.raw as TeamMembersPageJson).team, team.name).toEqual(team)
      // a search narrows the members, never the count
      const one = await membersList(fx, team).rest(fx.viewer, { search: 'user' })
      expect((one.raw as TeamMembersPageJson).team.member_count).toBe(team.member_count)
    }
  })

  it('answers null, never 0, without a count row, while one is counted and for another organization’s', async () => {
    const fx = await setup()
    const summary = async () =>
      (
        await fx.t.query(internal.machine.teams.restGetTeam, {
          ...reader(fx.admin),
          ref: fx.team.id,
        })
      ).member_count
    expect(await summary()).toBe(2)
    const row = (
      await fx.t.run((ctx) =>
        ctx.db
          .query('team_counts')
          .withIndex('by_team', (q) => q.eq('team_id', fx.team.id))
          .unique(),
      )
    )?._id
    if (row === undefined) throw new Error('Hardware has no count row')
    // a backfill counting the team
    await fx.t.run((ctx) => ctx.db.patch(row, { through: 0 }))
    expect(await summary()).toBeNull()
    // a row of another organization, as only a delete by an earlier release leaves
    await fx.t.run((ctx) => ctx.db.patch(row, { through: undefined, org_id: fx.otherOrg.id }))
    expect(await summary()).toBeNull()
    // no row at all
    await fx.t.run((ctx) => ctx.db.delete(row))
    expect(await summary()).toBeNull()
    const teams = (await teamsList(fx).rest(fx.admin)).raw as TeamsPageJson
    expect(teams.teams).toEqual([{ id: fx.team.id, name: 'Hardware', member_count: null }])
    const members = (await membersList(fx, fx.team).mcp(fx.admin)).raw as TeamMembersPageJson
    expect(members.team.member_count).toBeNull()
    expect(members.members).toHaveLength(2)
    // counted again, it answers the members
    expect(await recount(fx.t, fx.team)).toBe(2)
    expect(await summary()).toBe(2)
  })

  it('answers a new team’s count as 0, from its own row', async () => {
    const fx = await setup()
    const created = await fx.t.mutation(internal.machine.teams.restCreateTeam, {
      callerId: fx.admin.id,
      access: 'write',
      body: JSON.stringify({ name: 'Fresh' }),
    })
    expect(created).toEqual({ id: created.id, name: 'Fresh', member_count: 0 })
    const made = JSON.parse(
      await fx.t.mutation(internal.machine.teams.mcpSetTeam, {
        callerId: fx.admin.id,
        access: 'write',
        name: 'Newer',
      }),
    )
    expect(made).toEqual({ id: made.id, name: 'Newer', member_count: 0, created: true })
    expect(Object.keys(made)).toEqual(['id', 'name', 'member_count', 'created'])
  })

  it('counts a removed person’s leftover memberships for a moment, higher than the members listed', async () => {
    vi.useFakeTimers()
    try {
      const fx = await setup()
      ACCESS_FIRST_PASS.rows = 2
      const person = await plantSeat(fx.t, {
        org_id: fx.org.id,
        name: 'Busy',
        email: 'busy@testbed.test',
      })
      await keyOrg(fx.t, fx.org.id)
      const ids: string[] = []
      for (let n = 0; n < 4; n++) {
        const id = uuid()
        await as(fx.t, fx.admin).mutation(api.teams.create, {
          org_id: fx.org.id,
          id,
          name: `Team ${n}`,
        })
        await as(fx.t, fx.admin).mutation(api.teams.addMember, {
          org_id: fx.org.id,
          team_id: id,
          profile_id: person.id,
        })
        ids.push(id)
      }
      await as(fx.t, fx.admin).mutation(api.profiles.remove, { org_id: fx.org.id, id: person.id })
      const shown = []
      for (const id of ids) {
        const page = (await membersList(fx, { id }).rest(fx.admin)).raw as TeamMembersPageJson
        shown.push([page.team.member_count, page.members.length])
      }
      // the first pass took two off; the two it left still count, though
      // no member list shows them
      expect(shown).toEqual([
        [0, 0],
        [0, 0],
        [1, 0],
        [1, 0],
      ])
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

/* --------------------------------------------------------------- 7. readiness */

describe('readiness', () => {
  it('refuses users, teams and members until the names are ready, and answers labels', async () => {
    const fx = await setup()
    await plantLabels(fx.t, fx.org.id, ['Red'])
    await fx.t.run(async (ctx) => {
      const ready = await ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
        .unique()
      if (ready !== null) await ctx.db.patch(ready._id, { name_keys_at: undefined })
    })
    for (const list of [usersList(fx), teamsList(fx), membersList(fx, fx.team)]) {
      await refused(list.rest(fx.admin), 'rule', NAMES_NOT_READY)
      await refused(list.mcp(fx.admin), 'rule', NAMES_NOT_READY)
    }
    expect((await labelsList(fx).rest(fx.admin)).rows.map((r) => r.name)).toEqual(['Red'])
    // the single reads need no name keys
    expect(
      await fx.t.query(internal.machine.teams.restGetTeam, {
        ...reader(fx.admin),
        ref: fx.team.id,
      }),
    ).toEqual({ id: fx.team.id, name: 'Hardware', member_count: 2 })
    expect(
      (await fx.t.query(internal.machine.rest.getUser, { ...reader(fx.admin), ref: fx.user.id }))
        .id,
    ).toBe(fx.user.id)
  })

  it('refuses members while a membership without a copy may be a real one, and passes removed people’s', async () => {
    const fx = await setup()
    const members = membersList(fx, fx.team)
    const unkeyed = (profileId: string) =>
      fx.t.run((ctx) =>
        ctx.db.insert('team_members', {
          team_id: fx.team.id,
          profile_id: profileId,
          is_leader: false,
        }),
      )
    // leftovers of removed people, which the list leaves out anyway
    for (let n = 0; n < 3; n++) await unkeyed(uuid())
    expect((await members.rest(fx.admin)).rows).toHaveLength(2)
    // another organization's profile is no member either
    await unkeyed(fx.otherAdmin.id)
    expect((await members.rest(fx.admin)).rows).toHaveLength(2)
    // more of them than the check reads fails closed
    UNKEYED_MOST.rows = 3
    await refused(members.rest(fx.admin), 'rule', NAMES_NOT_READY)
    UNKEYED_MOST.rows = 4
    expect((await members.rest(fx.admin)).rows).toHaveLength(2)
    // one of a profile in the organization, a guest's included, fails closed
    for (const who of [fx.viewer, fx.guest]) {
      const _id = await unkeyed(who.id)
      UNKEYED_MOST.rows = 64
      await refused(members.rest(fx.admin), 'rule', NAMES_NOT_READY)
      await refused(members.mcp(fx.admin), 'rule', NAMES_NOT_READY)
      await fx.t.run((ctx) => ctx.db.delete(_id))
      expect((await members.rest(fx.admin)).rows).toHaveLength(2)
    }
  })
})

/* ------------------------------------------------------------------ 8. budget */

describe('the read budget', () => {
  it('ends a page short with a cursor once the budget is spent, and the next pages find the rest', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 18)
    await plantLabels(
      fx.t,
      fx.org.id,
      Array.from({ length: 23 }, (_, i) => `Label ${i}`),
    )
    await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 22 }, (_, i) => `Team ${i}`),
    )
    await plantMembers(fx.t, fx.team, people)
    const whole: Record<string, Row[]> = {}
    for (const list of everyList(fx))
      whole[list.name] = (await restPages(list, fx.admin, { limit: '200' })).rows
    NAMED_READ.documents = 6
    for (const list of everyList(fx)) {
      const { pages, rows } = await restPages(list, fx.admin, { limit: '50' })
      expect(rows, list.name).toEqual(whole[list.name])
      expect(pages.length, list.name).toBeGreaterThan(2)
      // a short page carries a cursor; only the last is null
      for (const page of pages.slice(0, -1)) {
        expect(page.rows.length, list.name).toBeLessThan(50)
        expect(page.next_cursor, list.name).toEqual(expect.any(String))
      }
    }
  })

  it('answers a search that matches nothing over a stopped list with short pages and cursors, and null only at the end', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 18)
    await plantLabels(
      fx.t,
      fx.org.id,
      Array.from({ length: 23 }, (_, i) => `Label ${i}`),
    )
    await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 22 }, (_, i) => `Team ${i}`),
    )
    await plantMembers(fx.t, fx.team, people)
    NAMED_READ.documents = 6
    for (const list of everyList(fx)) {
      const { pages, rows } = await mcpPages(list, fx.admin, { search: 'nobody by this name' })
      expect(rows, list.name).toEqual([])
      expect(pages.length, list.name).toBeGreaterThan(2)
      for (const page of pages.slice(0, -1))
        expect(page.next_cursor, list.name).toEqual(expect.any(String))
    }
  })

  it('reads the first row of a page with the budget already spent, so every page moves on', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 4)
    await plantLabels(fx.t, fx.org.id, ['A', 'B', 'C'])
    await plantTeams(fx.t, fx.org.id, ['T1', 'T2'])
    await plantMembers(fx.t, fx.team, people)
    const whole: Record<string, Row[]> = {}
    for (const list of everyList(fx)) whole[list.name] = (await restPages(list, fx.admin)).rows
    Object.assign(NAMED_READ, { ranges: 0, documents: 0, bytes: 0 })
    for (const list of everyList(fx)) {
      const { pages, rows } = await restPages(list, fx.admin)
      expect(rows, list.name).toEqual(whole[list.name])
      // one row a page, then an empty last page that reads past the end
      expect(
        pages.map((p) => p.rows.length),
        list.name,
      ).toEqual([...whole[list.name].map(() => 1), 0])
    }
  })
})

/* ----------------------------------------------- 9. single reads and writes */

describe('single reads and writes', () => {
  it('reads one user by id in any case, and answers one 404 for an unknown, foreign or no uuid, reading a handful of rows', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 195)
    const read = (ref: string) =>
      measured<{ id: string }>(fx.t, getUser, { ...reader(fx.agent), ref })
    const one = await read(fx.user.id.toUpperCase())
    expect(one.out.id).toBe(fx.user.id)
    // the caller and the person, not the roster
    expect(one.documents).toBeLessThanOrEqual(6)
    for (const ref of [uuid(), fx.otherAdmin.id, 'user', 'not-a-uuid'])
      await refused(
        fx.t.query(internal.machine.rest.getUser, { ...reader(fx.agent), ref }),
        'not_found',
        'user not found',
      )
    const patched = await fx.t.mutation(internal.machine.rest.updateUser, {
      callerId: fx.admin.id,
      access: 'write',
      ref: fx.user.id.toUpperCase(),
      body: JSON.stringify({ plannable_hours: 30 }),
    })
    expect(patched).toMatchObject({ id: fx.user.id, plannable_hours: 30 })
    for (const ref of [uuid(), fx.otherAdmin.id, 'user'])
      await refused(
        fx.t.mutation(internal.machine.rest.updateUser, {
          callerId: fx.admin.id,
          access: 'write',
          ref,
          body: JSON.stringify({ plannable_hours: 30 }),
        }),
        'not_found',
        'user not found',
      )
  })

  it('answers every team read and write as a summary, without members', async () => {
    const fx = await setup()
    const summary = { id: fx.team.id, name: 'Hardware', member_count: 2 }
    expect(
      await fx.t.query(internal.machine.teams.restGetTeam, {
        ...reader(fx.guest),
        ref: fx.team.id,
      }),
    ).toEqual(summary)
    const renamed = await fx.t.mutation(internal.machine.teams.restUpdateTeam, {
      callerId: fx.admin.id,
      access: 'write',
      ref: fx.team.id,
      body: JSON.stringify({ name: 'Hardware 2' }),
    })
    expect(renamed).toEqual({ ...summary, name: 'Hardware 2' })
    const mcp = JSON.parse(
      await fx.t.mutation(internal.machine.teams.mcpSetTeam, {
        callerId: fx.admin.id,
        access: 'write',
        team_id: fx.team.id,
        name: 'Hardware',
      }),
    )
    expect(mcp).toEqual({ ...summary, created: false })
    for (const out of [renamed, mcp]) expect('members' in out).toBe(false)
  })
})

/* ------------------------------------------------ 10. reads follow the page */

describe('reads that follow the page', () => {
  /* A REST users page of 10 for the admin of an organization of `size`
   * people, with what it read. */
  async function usersPageOf(size: number) {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, size - 5)
    return await measured<UsersPageJson>(fx.t, restListUsers, {
      ...reader(fx.admin),
      limit: '10',
    })
  }

  it('reads about 11 profiles for a users page of 10, in an organization of 200 people and of 1,000', async () => {
    const small = await usersPageOf(200)
    const large = await usersPageOf(1000)
    expect(small.out.users).toHaveLength(10)
    expect(large.out.users).toHaveLength(10)
    expect(small.documents).toBeLessThanOrEqual(15)
    expect(large.documents).toBe(small.documents)
    expect(large.ranges).toBe(small.ranges)
  }, 60_000)

  it('reads one count row a team for a page of teams, and no profile for a member search that misses', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 40)
    await plantMembers(fx.t, fx.team, people)
    await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 9 }, (_, i) => `Team ${i}`),
    )
    const page = await measured<TeamsPageJson>(fx.t, restListTeams, reader(fx.admin))
    expect(page.out.teams).toHaveLength(10)
    await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 5 }, (_, i) => `Team ${i + 9}`),
    )
    const more = await measured<TeamsPageJson>(fx.t, restListTeams, reader(fx.admin))
    expect(more.out.teams).toHaveLength(15)
    // each team more is its row and its count row, one lookup range each
    expect(more.documents - page.documents).toBe(10)
    expect(more.ranges - page.ranges).toBe(5)
    const miss = await measured<TeamMembersPageJson>(fx.t, restListTeamMembers, {
      ...reader(fx.admin),
      ref: fx.team.id,
      search: 'nobody by this name',
    })
    expect(miss.out.members).toEqual([])
    const hit = await measured<TeamMembersPageJson>(fx.t, restListTeamMembers, {
      ...reader(fx.admin),
      ref: fx.team.id,
    })
    expect(hit.out.members).toHaveLength(42)
    // the members' profiles, which the miss did not read
    expect(hit.documents - miss.documents).toBe(42)
    expect(hit.ranges - miss.ranges).toBe(42)
  })
})

/* ------------------------------------------------------ 11. the design size */

/* A page's reads, logged as the design size cases measure them. */
type Measured = { ranges: number; documents: number; bytes: number; rows: number }

/* Pages `fn` to its end for `args`, each page measured, and logs the
 * heaviest page's reads and the number of pages and rows under `name`.
 * Every page stays inside Convex's limits for one request. */
async function measurePages(
  t: T,
  fn: unknown,
  field: string,
  args: Record<string, unknown>,
  name: string,
) {
  const reads: Measured[] = []
  const rows: Row[] = []
  let cursor: string | null = null
  for (let n = 0; n < 1000; n++) {
    const read = await measured<Record<string, unknown>>(
      t,
      fn,
      cursor === null ? args : { ...args, cursor },
    )
    const page = paged(read.out, field)
    reads.push({
      ranges: read.ranges,
      documents: read.documents,
      bytes: read.bytes,
      rows: page.rows.length,
    })
    rows.push(...page.rows)
    cursor = page.next_cursor
    if (cursor === null) break
  }
  const most = (key: keyof Measured) => Math.max(...reads.map((r) => r[key]))
  console.log(
    `[people lists at the design size] ${name}: ${reads.length} pages, ${rows.length} rows, ` +
      `heaviest page ${most('ranges')} ranges, ${most('documents')} documents, ` +
      `${(most('bytes') / 1e6).toFixed(2)} MB`,
  )
  for (const read of reads) {
    expect(read.ranges).toBeLessThan(4096)
    expect(read.documents).toBeLessThan(32_000)
    expect(read.bytes).toBeLessThan(16 * 1024 * 1024)
  }
  return { reads, rows }
}

/* The organization of the people figure: withOrg's 5 and 995 more, 1,000
 * people at the design size, everything else at everyday values. The
 * coordinator's timing plants it too. */
async function plantRoster(fx: Fx) {
  return await plantMany(fx.t, fx.org.id, 995)
}

/* The organization of the teams figure: 50 teams, Hardware with its 2
 * members and 49 more with 3 to 10 members each, in an organization of 300
 * people, about one team a person, so no other figure is at its design
 * size. Answers each team's id with its members. */
async function plantTeamsFigure(fx: Fx): Promise<Map<string, number>> {
  const people = await plantMany(fx.t, fx.org.id, 295)
  const teams = await plantTeams(
    fx.t,
    fx.org.id,
    Array.from({ length: 49 }, (_, i) => `Team ${String(i).padStart(2, '0')} Operations`),
  )
  const sizes = new Map([[fx.team.id, 2]])
  for (const [i, team] of teams.entries()) {
    const size = 3 + (i % 8)
    await plantMembers(
      fx.t,
      team,
      Array.from({ length: size }, (_, k) => people[(i * 6 + k) % people.length]),
    )
    expect(await recount(fx.t, team)).toBe(size)
    sizes.set(team.id, size)
  }
  return sizes
}

/* The team of the people figure: Hardware with 1,000 members, every person
 * of an organization of 1,000 people (withOrg's guest taken out, since a
 * guest is never a member), every other figure at its everyday value. */
async function plantBigTeam(fx: Fx) {
  await fx.t.run((ctx) => ctx.db.delete(fx.guest._id))
  const people = await plantMany(fx.t, fx.org.id, 996)
  await plantMembers(fx.t, fx.team, [...people, fx.viewer, fx.agent])
  expect(await recount(fx.t, fx.team)).toBe(1000)
  return people
}

/* The labels of the timing's label case: 60 labels of ordinary names,
 * the most a test case holds, since labels have no design-size figure. */
const plantLabelsFigure = (fx: Fx) =>
  plantLabels(
    fx.t,
    fx.org.id,
    Array.from({ length: 60 }, (_, i) => `Label ${String(i).padStart(2, '0')} Review`),
  )

describe('at the design size', () => {
  it('pages 1,000 people at limit 200, and a search that matches nobody over them', async () => {
    const fx = await setup()
    await plantRoster(fx)
    const all = await measurePages(
      fx.t,
      restListUsers,
      'users',
      { ...reader(fx.admin), limit: '200' },
      '1,000 people at limit 200',
    )
    expect(all.reads).toHaveLength(5)
    expect(all.rows).toHaveLength(1000)
    expect(all.rows.map((r) => r.id)).toEqual(
      (await peopleInOrder(fx.t, fx.org.id)).map((p) => p.id),
    )
    const none = await measurePages(
      fx.t,
      restListUsers,
      'users',
      { ...reader(fx.admin), limit: '200', search: 'nobody by this name' },
      'a search that matches none of 1,000 people',
    )
    expect(none.reads).toHaveLength(1)
    expect(none.rows).toEqual([])
    // MCP answers the same pages
    expect((await mcpPages(usersList(fx), fx.admin, { limit: 200 })).rows).toEqual(all.rows)
  }, 60_000)

  it('pages the 50 teams at limit 200, and a search that matches no team', async () => {
    const fx = await setup()
    const sizes = await plantTeamsFigure(fx)
    const all = await measurePages(
      fx.t,
      restListTeams,
      'teams',
      { ...reader(fx.admin), limit: '200' },
      '50 teams at limit 200',
    )
    expect(all.reads).toHaveLength(1)
    expect(all.rows).toHaveLength(50)
    const counted = all.rows as unknown as TeamsPageJson['teams']
    for (const team of counted) expect(team.member_count, team.name).toBe(sizes.get(team.id))
    const none = await measurePages(
      fx.t,
      restListTeams,
      'teams',
      { ...reader(fx.admin), limit: '200', search: 'nobody by this name' },
      'a search that matches none of 50 teams',
    )
    expect(none.rows).toEqual([])
    expect(none.reads[0].documents).toBeLessThan(all.reads[0].documents)
  }, 60_000)

  it('pages a team of 1,000 members at limit 200, and a member search that matches nobody', async () => {
    const fx = await setup()
    await plantBigTeam(fx)
    const all = await measurePages(
      fx.t,
      restListTeamMembers,
      'members',
      { ...reader(fx.admin), ref: fx.team.id, limit: '200' },
      'a team of 1,000 members at limit 200',
    )
    expect(all.reads).toHaveLength(5)
    expect(all.rows).toHaveLength(1000)
    const page = await fx.t.query(internal.machine.teams.restListTeamMembers, {
      ...reader(fx.admin),
      ref: fx.team.id,
      limit: '1',
    })
    expect(page.team.member_count).toBe(1000)
    // the members are those the old whole-team reader lists, in name order
    const whole = await fx.t.run(async (ctx) => (await teamJson(ctx, fx.team)).members)
    expect(new Set(all.rows.map((r) => r.id))).toEqual(new Set(whole.map((m) => m.id)))
    expect(all.rows.map((r) => r.id)).toEqual(nameOrder(whole).map((m) => m.id))
    const none = await measurePages(
      fx.t,
      restListTeamMembers,
      'members',
      { ...reader(fx.admin), ref: fx.team.id, limit: '200', search: 'nobody by this name' },
      'a member search that matches none of 1,000',
    )
    expect(none.reads).toHaveLength(1)
    expect(none.rows).toEqual([])
  }, 60_000)

  it('pages 60 labels, the most a case holds, and a search that matches none', async () => {
    // labels have no design-size figure, so a case holds at most 60
    const fx = await setup()
    await plantLabelsFigure(fx)
    const all = await measurePages(
      fx.t,
      restListLabels,
      'labels',
      { ...reader(fx.admin), limit: '200' },
      '60 labels at limit 200',
    )
    expect(all.reads).toHaveLength(1)
    expect(all.rows).toHaveLength(60)
    const none = await measurePages(
      fx.t,
      restListLabels,
      'labels',
      { ...reader(fx.admin), limit: '200', search: 'nobody by this name' },
      'a search that matches none of 60 labels',
    )
    expect(none.rows).toEqual([])
  })

  it('finds a person in 5 teams in each team’s member pages', async () => {
    const fx = await setup()
    const people = await plantMany(fx.t, fx.org.id, 60)
    const busy = people[30]
    const teams = await plantTeams(
      fx.t,
      fx.org.id,
      Array.from({ length: 5 }, (_, i) => `Shift ${i}`),
    )
    for (const [i, team] of teams.entries()) {
      // 20 everyday members each, the busy person among them
      const crew = people.slice(i * 8, i * 8 + 20).filter((p) => p.id !== busy.id)
      await plantMembers(fx.t, team, [...crew, busy])
      await recount(fx.t, team)
    }
    for (const team of teams) {
      const pages = await restPages(membersList(fx, team), fx.agent, { limit: '7' })
      expect(
        pages.rows.filter((r) => r.id === busy.id),
        team.name,
      ).toHaveLength(1)
      expect((pages.pages[0].raw as TeamMembersPageJson).team.member_count).toBe(pages.rows.length)
    }
  }, 60_000)
})
