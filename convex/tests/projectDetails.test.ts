/* REST and MCP project details with the first pages of their milestones,
 * user grants and team grants (machine/projects.ts projectDetail), those
 * lists a page at a time (GET /v1/projects/{ref}/milestones, /access/users
 * and /access/teams, MCP list_project_related), and a project's users a
 * page at a time (lib/core.ts projectUserPage, GET /v1/projects/{ref}/users
 * and list_project_users). The reads these lists made before they paged,
 * each list whole, are the oracle (projectDetails.setup.ts). Every fixture
 * keys its organization's names (nameKeys.setup.ts keyOrg) after its last
 * planted profile, team, membership, grant or share, as every deployment
 * holds them; a profile planted after it would make the user walk throw on
 * a profile without a key, and a grant planted after it turns the grant
 * lists not ready. The cases at the design size raise one figure, or the
 * sum one read covers, and print what each call read. */

import type { FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { OWN_READS } from '../lib/access'
import {
  NO_TASKS,
  PROJECT_DETAILS,
  PROJECT_USERS_TOO_LARGE,
  type ProjectUserJson,
  projectUserPage,
} from '../lib/core'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { CURSOR_REFUSAL, listCursorText, NAMES_NOT_READY, offsetRefusal } from '../lib/listCursor'
import { NAMED_READ } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { sha256hex } from '../machine/auth'
import {
  grantRows,
  milestoneRows,
  PROJECT_LIST_NAMES,
  type ProjectRelatedList,
  projectRead,
  restUpdateProject,
} from '../machine/projects'
import { pretty } from '../machine/shared'
import { MILESTONE_READ } from '../model/milestones'
import { PICKERS } from '../model/pickers'
import { UNKEYED_MOST } from '../model/projectSettings'
import { NOW, newT, plantProject, plantSeat, type T, uuid, withOrg } from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import { plantNorthstar } from './northstar.setup'
import { countOrg } from './overviewCounts.setup'
import { perProfileUsers, wholeRelated } from './projectDetails.setup'
import {
  measured,
  names,
  person,
  plantGrants,
  plantShares,
  plantSubs,
  plantTeam,
  type Read,
} from './projectNavFixtures.setup'

const DEFAULTS = {
  details: structuredClone(PROJECT_DETAILS),
  named: structuredClone(NAMED_READ),
  own: structuredClone(OWN_READS),
  rule: structuredClone(PICKERS.rule),
  milestones: structuredClone(MILESTONE_READ),
  unkeyed: structuredClone(UNKEYED_MOST),
}
afterEach(() => {
  Object.assign(PROJECT_DETAILS, structuredClone(DEFAULTS.details))
  Object.assign(NAMED_READ, structuredClone(DEFAULTS.named))
  Object.assign(OWN_READS, structuredClone(DEFAULTS.own))
  Object.assign(PICKERS.rule, structuredClone(DEFAULTS.rule))
  Object.assign(MILESTONE_READ, structuredClone(DEFAULTS.milestones))
  Object.assign(UNKEYED_MOST, structuredClone(DEFAULTS.unkeyed))
})

/* The sentence a refused call carries. */
async function sentence(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (error: unknown) => error,
  )
  if (!(e instanceof ConvexError)) throw new Error(`expected a refusal, got ${String(e)}`)
  return (e.data as Refusal).message
}

type Row = { id: string; name: string } & Record<string, unknown>
type Page = { next_cursor: string | null; rows: Row[] }
/* A page asked over REST, whose parameters are text, or MCP. */
type RestAsk = { limit?: number | string; cursor?: string; offset?: number | string }
type Ask = { limit?: number; cursor?: string; offset?: number }

/* One page of a related list over REST, `ask` sent as text. */
async function restList(
  t: T,
  me: Doc<'profiles'>,
  list: ProjectRelatedList,
  ref: string,
  ask: RestAsk = {},
): Promise<Page> {
  const args = {
    callerId: me.id,
    access: 'read' as const,
    ref,
    ...(ask.limit === undefined ? {} : { limit: String(ask.limit) }),
    ...(ask.cursor === undefined ? {} : { cursor: ask.cursor }),
    ...(ask.offset === undefined ? {} : { offset: String(ask.offset) }),
  }
  if (list === 'milestones') {
    const p = await t.query(internal.machine.projects.restListMilestones, args)
    return { next_cursor: p.next_cursor, rows: p.milestones }
  }
  if (list === 'user_grants') {
    const p = await t.query(internal.machine.projects.restListUserGrants, args)
    return { next_cursor: p.next_cursor, rows: p.user_grants }
  }
  const p = await t.query(internal.machine.projects.restListTeamGrants, args)
  return { next_cursor: p.next_cursor, rows: p.team_grants }
}

/* One page of a related list over MCP, and its text's keys. */
async function mcpList(
  t: T,
  me: Doc<'profiles'>,
  list: ProjectRelatedList,
  project: string,
  ask: Ask = {},
): Promise<Page & { keys: string[] }> {
  const page = JSON.parse(
    await t.query(internal.machine.projects.mcpProjectRelated, {
      callerId: me.id,
      access: 'read',
      project,
      list,
      ...ask,
    }),
  ) as Record<string, unknown>
  return {
    next_cursor: page.next_cursor as string | null,
    rows: page[list] as Row[],
    keys: Object.keys(page),
  }
}

/* Every page of one list, following its cursors from `first`. */
async function walk(
  read: (cursor: string | undefined) => Promise<Page>,
  first?: string,
  most = 2000,
): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = []
  let cursor = first
  for (let n = 1; n <= most; n++) {
    const page = await read(cursor)
    rows.push(...page.rows)
    if (page.next_cursor === null) return { rows, pages: n }
    if (page.next_cursor === cursor) throw new Error('a page answered its own cursor')
    cursor = page.next_cursor
  }
  throw new Error('the list did not end')
}

/* One page of a project's users on either surface. */
async function usersPage(
  t: T,
  me: Doc<'profiles'>,
  ref: string,
  ask: Ask,
  surface: 'rest' | 'mcp',
): Promise<{ next_cursor: string | null; rows: ProjectUserJson[] }> {
  if (surface === 'rest') {
    const p = await t.query(internal.machine.rest.listProjectUsers, {
      callerId: me.id,
      access: 'read',
      ref,
      ...(ask.limit === undefined ? {} : { limit: String(ask.limit) }),
      ...(ask.cursor === undefined ? {} : { cursor: ask.cursor }),
    })
    return { next_cursor: p.next_cursor, rows: p.users }
  }
  const p = JSON.parse(
    await t.query(internal.machine.mcp.listProjectUsers, {
      callerId: me.id,
      access: 'read',
      project: ref,
      ...ask,
    }),
  ) as { next_cursor: string | null; users: ProjectUserJson[] }
  return { next_cursor: p.next_cursor, rows: p.users }
}

const restDetail = (t: T, me: Doc<'profiles'>, ref: string) =>
  t.query(internal.machine.rest.getProject, { callerId: me.id, access: 'read', ref })
const mcpDetailText = (t: T, me: Doc<'profiles'>, project: string) =>
  t.query(internal.machine.projects.mcpGetProject, { callerId: me.id, access: 'read', project })

/* A milestone of `project` on `week`, planted raw. */
const milestone = (t: T, project: Doc<'projects'>, name: string, week: string) =>
  t.run((ctx) =>
    ctx.db.insert('milestones', {
      id: uuid(),
      project_id: project.id,
      name,
      week,
      created_at: NOW,
    }),
  )

/* withOrg with Pia (User on FW), Zed (a Viewer with a User grant on FW),
 * Hardware and Blue (with Gus, a guest, and Pia) sharing FW, Gus, and three
 * milestones on TBED, two of them on one day, beside one stored on FW. */
async function detailsOrg() {
  const t = newT()
  const f = await withOrg(t)
  const pia = await person(t, f.org.id, 'Pia')
  const zed = await person(t, f.org.id, 'Zed', { org_role: 'viewer' })
  const gus = await person(t, f.org.id, 'Gus', { org_role: 'guest' })
  await plantGrants(t, pia, [f.sub])
  await plantGrants(t, zed, [f.sub])
  const blue = await plantTeam(t, f.org.id, 'Blue', [gus, pia])
  await plantShares(t, f.team.id, [f.sub])
  await plantShares(t, blue, [f.sub])
  await milestone(t, f.meta, 'Launch', '2026-06-01')
  await milestone(t, f.meta, 'Beta', '2026-06-01')
  await milestone(t, f.meta, 'Alpha', '2026-03-02')
  await milestone(t, f.sub, 'Stored on FW', '2026-04-06')
  await keyOrg(t, f.org.id)
  return { t, f, pia, zed, gus, blue }
}

const LISTS: ProjectRelatedList[] = ['milestones', 'user_grants', 'team_grants']
const NOUNS = { milestones: 'milestones', user_grants: 'user grants', team_grants: 'team grants' }
const RANGES = {
  milestones: LIMITS.listMilestones,
  user_grants: LIMITS.listUserGrants,
  team_grants: LIMITS.listTeamGrants,
}

/* --------------------------------------------------------------- details */

describe('the details', () => {
  it('hold the first page of each list with its cursor, in MCP right before what it continues', async () => {
    const { t, f, pia } = await detailsOrg()
    const text = await mcpDetailText(t, pia, 'FW')
    const detail = JSON.parse(text)
    expect(Object.keys(detail).slice(-6)).toEqual([
      'completion',
      'milestones_next_cursor',
      'milestones',
      'user_grants_next_cursor',
      'team_grants_next_cursor',
      'grants',
    ])
    // milestones by stored day, then name key, then id; a sub-project's are
    // its parent's, and one stored on the sub-project is left out
    expect(detail.milestones.map((m: Row) => m.name)).toEqual(['Alpha', 'Beta', 'Launch'])
    expect(detail.grants.users.map((g: Row) => g.name)).toEqual(['Pia', 'Zed'])
    expect(detail.grants.teams.map((g: Row) => g.name)).toEqual(['Blue', 'Hardware'])
    expect([
      detail.milestones_next_cursor,
      detail.user_grants_next_cursor,
      detail.team_grants_next_cursor,
    ]).toEqual([null, null, null])
    // REST's answer is the same, its keys in Convex's order
    expect(await restDetail(t, pia, 'FW')).toEqual(detail)
    // each first page equals the old whole read's
    const old = await t.run((ctx) => wholeRelated(ctx, f.sub))
    expect({
      milestones: detail.milestones,
      user_grants: detail.grants.users,
      team_grants: detail.grants.teams,
    }).toEqual(old)
  })

  it('answer the first 50 and a cursor that the list calls continue on either surface', async () => {
    const { t, f, pia } = await detailsOrg()
    const extra = await t.run(async (ctx) => {
      const out: string[] = []
      for (let i = 0; i < 60; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `Person ${String(i).padStart(2, '0')}`,
          initials: 'PE',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          created_at: NOW,
        })
        await ctx.db.insert('project_access', {
          project_id: f.sub.id,
          profile_id: id,
          level: 'user',
        })
        out.push(id)
      }
      return out
    })
    await keyOrg(t, f.org.id)
    const detail = await restDetail(t, pia, 'FW')
    expect(detail.grants.users).toHaveLength(50)
    const cursor = detail.user_grants_next_cursor as string
    expect(typeof cursor).toBe('string')
    const old = (await t.run((ctx) => wholeRelated(ctx, f.sub))).user_grants
    expect(detail.grants.users).toEqual(old.slice(0, 50))
    // the details' cursor goes on over REST, and REST's over MCP
    const restNext = await restList(t, pia, 'user_grants', 'FW', { cursor, limit: 5 })
    const mcpRest = await walk(
      (c) => mcpList(t, pia, 'user_grants', 'FW', { cursor: c, limit: 3 }),
      restNext.next_cursor as string,
    )
    expect([...detail.grants.users, ...restNext.rows, ...mcpRest.rows]).toEqual(old)
    expect(old).toHaveLength(extra.length + 2)
    // the same cursor on another list, another project or another caller is refused
    for (const [list, ref, me] of [
      ['team_grants', 'FW', pia],
      ['milestones', 'FW', pia],
      ['user_grants', 'TBED', pia],
      ['user_grants', 'FW', f.user],
    ] as const)
      expect(await sentence(restList(t, me, list, ref, { cursor }))).toBe(CURSOR_REFUSAL)
  })

  it('answer a list the bound leaves no room for as no rows and a cursor at its start, which the list call reads whole', async () => {
    const { t, f, pia } = await detailsOrg()
    // one range: the milestones read their first day whatever the bound,
    // within the request's own room, and the grants find none left
    Object.assign(PROJECT_DETAILS, { ranges: 1 })
    const one = await restDetail(t, pia, 'FW')
    expect(one.milestones?.map((m) => m.name)).toEqual(['Alpha'])
    expect(typeof one.milestones_next_cursor).toBe('string')
    expect([one.grants.users, one.grants.teams]).toEqual([[], []])
    // none: every list answers no rows and a cursor at its start
    Object.assign(PROJECT_DETAILS, { ranges: 0 })
    const detail = await restDetail(t, pia, 'FW')
    expect([detail.milestones, detail.grants.users, detail.grants.teams]).toEqual([[], [], []])
    for (const [list, cursor] of [
      ['milestones', detail.milestones_next_cursor],
      ['user_grants', detail.user_grants_next_cursor],
      ['team_grants', detail.team_grants_next_cursor],
    ] as const) {
      expect(typeof cursor).toBe('string')
      const page = await restList(t, pia, list, 'FW', { cursor: cursor as string })
      expect(page.rows.length, list).toBeGreaterThan(0)
      expect(page.next_cursor).toBeNull()
    }
    // a write's answer does the same, and the write commits
    const answer = await t.mutation(internal.machine.projects.restUpdateProject, {
      callerId: f.user.id,
      access: 'write',
      ref: 'FW',
      body: JSON.stringify({ description: 'Tight' }),
      keyName: null,
    })
    expect(answer.grants.users).toEqual([])
    expect(answer.description).toBe('Tight')
    Object.assign(PROJECT_DETAILS, structuredClone(DEFAULTS.details))
    // a not-ready organization answers both grant lists so, and its list
    // calls refuse
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .unique()
      if (row !== null) await ctx.db.patch(row._id, { name_keys_at: undefined })
    })
    const unready = await restDetail(t, pia, 'FW')
    expect(unready.milestones?.length).toBe(3)
    expect([unready.grants.users, unready.grants.teams]).toEqual([[], []])
    expect(typeof unready.user_grants_next_cursor).toBe('string')
    for (const list of ['user_grants', 'team_grants'] as const) {
      expect(await sentence(restList(t, pia, list, 'FW'))).toBe(NAMES_NOT_READY)
      expect(await sentence(mcpList(t, pia, list, 'FW'))).toBe(NAMES_NOT_READY)
    }
    expect(await sentence(usersPage(t, pia, 'FW', {}, 'rest'))).toBe(NAMES_NOT_READY)
    // the milestones need no names
    expect((await restList(t, pia, 'milestones', 'FW')).rows).toHaveLength(3)
  })

  it('answer a project the caller manages without reading with its grants and no milestones', async () => {
    const { t, f, zed } = await detailsOrg()
    await plantGrants(t, zed, [f.hidden], 'viewer')
    await milestone(t, f.hidden, 'Hidden launch', '2026-07-06')
    await keyOrg(t, f.org.id)
    const detail = await restDetail(t, f.admin, 'SKNK')
    expect(detail).toMatchObject({
      access: { read: false, write: false },
      milestones: null,
      milestones_next_cursor: null,
    })
    expect(detail.grants.users.map((g) => g.name)).toEqual(['Zed'])
    // the admin pages the grants it manages, and not the milestones
    expect((await restList(t, f.admin, 'user_grants', 'SKNK')).rows.map((g) => g.name)).toEqual([
      'Zed',
    ])
    expect(await sentence(restList(t, f.admin, 'milestones', 'SKNK'))).toBe('project not found')
    expect(await sentence(mcpList(t, f.admin, 'milestones', 'SKNK'))).toBe(
      'project "SKNK" not found (or not visible to you)',
    )
    // a project they neither read nor manage answers like an unknown one
    expect(await sentence(restList(t, f.guest, 'user_grants', 'SKNK'))).toBe('project not found')
  })

  it('answer a sub-project created and a top-level project archived with their first pages', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantSubs(t, f.meta, names('Live sub ', 28))
    await milestone(t, f.meta, 'Freeze', '2026-03-09')
    await keyOrg(t, f.org.id)
    await countOrg(t, f.org.id)
    const created = JSON.parse(
      await t.mutation(internal.machine.projects.mcpCreateProject, {
        callerId: f.user.id,
        access: 'write',
        name: 'Optics',
        parent: 'TBED',
      }),
    )
    expect(created.milestones.map((m: Row) => m.name)).toEqual(['Freeze'])
    expect(created.completion).toEqual(NO_TASKS)
    const archived = await t.mutation(internal.machine.projects.restUpdateProject, {
      callerId: f.user.id,
      access: 'write',
      ref: 'TBED',
      body: JSON.stringify({ archived: true }),
      keyName: null,
    })
    expect(archived).toMatchObject({ archived: true, milestones_next_cursor: null })
    expect(archived.milestones?.map((m) => m.name)).toEqual(['Freeze'])
  })
})

/* ------------------------------------------------------------- the lists */

describe('the list calls', () => {
  it('refuse a limit, an offset, the project, unready names and a cursor, in that order', async () => {
    const { t, f, pia } = await detailsOrg()
    for (const list of LISTS) {
      const range = RANGES[list]
      for (const limit of ['0', '201', '1.5', 'ten'])
        expect(await sentence(restList(t, pia, list, 'FW', { limit }))).toBe(range.refusal)
      for (const limit of [0, 201])
        expect(await sentence(mcpList(t, pia, list, 'FW', { limit }))).toBe(range.refusal)
      const OFFSET = offsetRefusal(NOUNS[list])
      for (const offset of ['1', '-1', '1.5', 'abc'])
        expect(await sentence(restList(t, pia, list, 'FW', { offset }))).toBe(OFFSET)
      expect(await sentence(mcpList(t, pia, list, 'FW', { offset: 1 }))).toBe(OFFSET)
      for (const offset of ['0', '00'])
        expect((await restList(t, pia, list, 'FW', { offset })).next_cursor).toBeNull()
      // the order: limit, offset, project, cursor
      expect(
        await sentence(restList(t, pia, list, 'NOPE', { limit: 0, offset: 1, cursor: 'x' })),
      ).toBe(range.refusal)
      expect(await sentence(restList(t, pia, list, 'NOPE', { offset: 1, cursor: 'x' }))).toBe(
        OFFSET,
      )
      expect(await sentence(restList(t, pia, list, 'NOPE', { cursor: 'x' }))).toBe(
        'project not found',
      )
      expect(await sentence(restList(t, pia, list, 'FW', { cursor: 'x' }))).toBe(CURSOR_REFUSAL)
      // REST takes an empty cursor as absent; the internal MCP query refuses it
      expect(await restList(t, pia, list, 'FW', { cursor: '' })).toEqual(
        await restList(t, pia, list, 'FW'),
      )
      expect(await sentence(mcpList(t, pia, list, 'FW', { cursor: '' }))).toBe(CURSOR_REFUSAL)
    }
    // the users list refuses the same way, with its own nouns
    expect(await sentence(usersPage(t, pia, 'FW', { limit: 0 }, 'rest'))).toBe(
      LIMITS.listProjectUsers.refusal,
    )
    expect(await sentence(usersPage(t, pia, 'FW', { offset: 1 }, 'mcp'))).toBe(
      offsetRefusal('project users'),
    )
    expect(await sentence(usersPage(t, pia, 'NOPE', {}, 'mcp'))).toBe(
      'project "NOPE" not found (or not visible to you)',
    )
    expect(await sentence(usersPage(t, f.guest, 'SKNK', {}, 'rest'))).toBe('project not found')
    // a users cursor opens only for its project and caller
    const users = await usersPage(t, pia, 'FW', { limit: 1 }, 'rest')
    const cursor = users.next_cursor as string
    expect(typeof cursor).toBe('string')
    expect(await sentence(usersPage(t, f.user, 'TBED', { cursor }, 'rest'))).toBe(CURSOR_REFUSAL)
    expect(await sentence(usersPage(t, pia, 'TBED', { cursor }, 'mcp'))).toBe(CURSOR_REFUSAL)
    expect(await sentence(usersPage(t, f.user, 'FW', { cursor }, 'mcp'))).toBe(CURSOR_REFUSAL)
    expect((await usersPage(t, pia, 'FW', { cursor }, 'mcp')).rows.length).toBeGreaterThan(0)
  })

  it('refuse over HTTP an unknown query parameter and MCP schema type errors', async () => {
    const { t, f } = await detailsOrg()
    // the fixture's agent with a User grant on FW and a key, the names keyed again
    await plantGrants(t, f.agent, [f.sub])
    await keyOrg(t, f.org.id)
    const secret = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
    const key_hash = await sha256hex(secret)
    await t.run((ctx) =>
      ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'Default key',
        key_prefix: secret.slice(0, 11),
        key_hash,
        created_at: NOW,
      }),
    )
    const http = t as unknown as {
      fetch(
        path: string,
        init: { method: string; headers: Record<string, string>; body?: string },
      ): Promise<Response>
    }
    for (const path of ['users', 'milestones', 'access/users', 'access/teams']) {
      const res = await http.fetch(`/v1/projects/FW/${path}?page=2`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secret}` },
      })
      expect(res.status, path).toBe(400)
      expect(JSON.parse(await res.text()).error).toBe(
        'unknown query parameter "page"; this request takes limit, cursor, offset',
      )
      const ok = await http.fetch(`/v1/projects/FW/${path}?limit=1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secret}` },
      })
      expect(ok.status, path).toBe(200)
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await http.fetch('/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      const text = await res.text()
      const data = text.startsWith('event: message\ndata: ')
        ? text.slice('event: message\ndata: '.length)
        : text
      return (JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } })
        .result
    }
    for (const args of [
      { project: 'FW', list: 'labels' },
      { project: 'FW', list: 'milestones', limit: 1.5 },
      { project: 'FW', list: 'milestones', offset: 'abc' },
    ]) {
      const res = await call('list_project_related', args)
      expect(res.isError, JSON.stringify(args)).toBe(true)
      expect(res.content[0].text).toMatch(/^Input validation error/)
    }
    // the schema's minLength is a hint, so an empty cursor reaches the tool,
    // which refuses it with its own sentence
    const empty = await call('list_project_related', {
      project: 'FW',
      list: 'milestones',
      cursor: '',
    })
    expect(empty).toMatchObject({ isError: true, content: [{ text: CURSOR_REFUSAL }] })
    const page = await call('list_project_related', { project: 'FW', list: 'team_grants' })
    expect(Object.keys(JSON.parse(page.content[0].text))).toEqual(['next_cursor', 'team_grants'])
    const users = await call('list_project_users', { project: 'FW', limit: 1 })
    expect(Object.keys(JSON.parse(users.content[0].text))).toEqual(['next_cursor', 'users'])
  })

  it('open only cursors of their list, organization, caller and project, start positions included', async () => {
    const { t, f, pia } = await detailsOrg()
    const scope = [f.org.id, pia.id, f.sub.id]
    for (const list of LISTS) {
      const start = list === 'milestones' ? { key: '', tie: ['', ''] } : { key: '', tie: [''] }
      const opened = await restList(t, pia, list, 'FW', {
        cursor: await listCursorText(PROJECT_LIST_NAMES[list], scope, start),
      })
      expect(opened.rows.length, list).toBeGreaterThan(0)
      const wrong = list === 'milestones' ? { key: '', tie: [''] } : { key: '', tie: ['', ''] }
      for (const cursor of [
        await listCursorText(PROJECT_LIST_NAMES[list], scope, wrong),
        await listCursorText(PROJECT_LIST_NAMES[list], scope, { key: '', tie: [1] }),
        await listCursorText('machine.users', scope, start),
        await listCursorText('machine.projects', scope, start),
        await listCursorText(PROJECT_LIST_NAMES[list], [f.org.id, pia.id, f.meta.id], start),
        await listCursorText(PROJECT_LIST_NAMES[list], [f.otherOrg.id, pia.id, f.sub.id], start),
        'junk',
      ])
        expect(await sentence(restList(t, pia, list, 'FW', { cursor })), list).toBe(CURSOR_REFUSAL)
      // a changed cursor
      const page = await restList(t, pia, list, 'FW', { limit: 1 })
      const c = page.next_cursor as string
      expect(
        await sentence(
          restList(t, pia, list, 'FW', {
            cursor: `${c.slice(0, -2)}${c.endsWith('aa') ? 'bb' : 'aa'}`,
          }),
        ),
      ).toBe(CURSOR_REFUSAL)
      // every row once at any limit, REST and MCP alternating
      const all = (await restList(t, pia, list, 'FW', { limit: 200 })).rows
      const rows: Row[] = [...page.rows]
      let cursor: string | null = c
      let n = 0
      while (cursor !== null) {
        const next: Page =
          n % 2 === 0
            ? await mcpList(t, pia, list, 'FW', { cursor, limit: 1 + (n % 3) })
            : await restList(t, pia, list, 'FW', { cursor, limit: 2 })
        rows.push(...next.rows)
        cursor = next.next_cursor
        n += 1
      }
      expect(rows, list).toEqual(all)
    }
  })

  it('page the milestones in the app order, and leave out what is not the top-level project’s', async () => {
    const { t, f, pia } = await detailsOrg()
    // a sub-project's list is its parent's
    const viaSub = (await restList(t, pia, 'milestones', 'FW', { limit: 1 })).rows
    expect(viaSub.map((m) => m.name)).toEqual(['Alpha'])
    const all = await walk((c) => restList(t, pia, 'milestones', 'FW', { cursor: c, limit: 1 }))
    expect(all.rows.map((m) => m.name)).toEqual(['Alpha', 'Beta', 'Launch'])
    expect(all.rows).toEqual((await t.run((ctx) => wholeRelated(ctx, f.sub))).milestones)
    // an archived project's milestones are listed
    await t.mutation(internal.machine.projects.restUpdateProject, {
      callerId: f.user.id,
      access: 'write',
      ref: 'TBED',
      body: JSON.stringify({ archived: true }),
      keyName: null,
    })
    expect((await restList(t, f.user, 'milestones', 'TBED')).rows).toHaveLength(3)
    // within a lowered MILESTONE_READ the pages move on to the end
    Object.assign(MILESTONE_READ, { ranges: 1, documents: 1 })
    const tight = await walk((c) => mcpList(t, f.user, 'milestones', 'TBED', { cursor: c }))
    expect(tight.rows.map((m) => m.name)).toEqual(['Alpha', 'Beta', 'Launch'])
  })

  it('page the grants of holders of the project’s organization alone, by their name copies', async () => {
    const { t, f, pia } = await detailsOrg()
    // a grant of a profile that is gone and of another organization's, and
    // a renamed person whose copy has not followed yet
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: f.otherAdmin.id,
        level: 'user',
        name_key: 'aaa other',
      })
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: uuid(),
        level: 'user',
        name_key: 'aaa gone',
      })
      await ctx.db.patch(pia._id, { name: 'Zoe', name_key: nameKey('Zoe') })
    })
    const page = await restList(t, pia, 'user_grants', 'FW')
    // Pia, now Zoe, stays at her copy's place until the copy follows
    expect(page.rows.map((g) => g.name)).toEqual(['Zoe', 'Zed'])
    expect(page.rows.map((g) => g.id)).not.toContain(f.otherAdmin.id)
    // an unkeyed grant of a holder outside the organization does not
    // refuse; a keyed holder's grant without its copy does, and so does
    // more than UNKEYED_MOST unkeyed grants
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: f.otherAdmin.id,
        level: 'viewer',
      }),
    )
    expect((await restList(t, pia, 'user_grants', 'FW')).rows).toHaveLength(2)
    Object.assign(UNKEYED_MOST, { rows: 0 })
    expect(await sentence(restList(t, pia, 'user_grants', 'FW'))).toBe(NAMES_NOT_READY)
    Object.assign(UNKEYED_MOST, structuredClone(DEFAULTS.unkeyed))
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: f.user.id,
        level: 'viewer',
      }),
    )
    expect(await sentence(mcpList(t, pia, 'user_grants', 'FW'))).toBe(NAMES_NOT_READY)
  })

  it('page within NAMED_READ, every row once to the end', async () => {
    const { t, pia } = await detailsOrg()
    const whole = (await restList(t, pia, 'user_grants', 'FW')).rows
    const users = await walk(async (c) => {
      const p = await usersPage(t, pia, 'FW', { cursor: c }, 'rest')
      return { next_cursor: p.next_cursor, rows: p.rows }
    })
    Object.assign(NAMED_READ, { ranges: 1, documents: 1 })
    expect((await walk((c) => restList(t, pia, 'user_grants', 'FW', { cursor: c }))).rows).toEqual(
      whole,
    )
    const tight = await walk(async (c) => {
      const p = await usersPage(t, pia, 'FW', { cursor: c }, 'mcp')
      return { next_cursor: p.next_cursor, rows: p.rows }
    })
    expect(tight.rows).toEqual(users.rows)
    expect(tight.pages).toBeGreaterThan(users.pages)
  })
})

/* ------------------------------------------------------- the users list */

describe('the users list', () => {
  it('lists whom the project admits and marks assignable before the cut', async () => {
    const { t, f, pia, zed, gus } = await detailsOrg()
    const inactive = await plantSeat(t, { org_id: f.org.id, name: 'Ina', active: false })
    const viewerAgent = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Ledger',
      org_role: 'viewer',
      kind: 'agent',
    })
    const subOnly = await person(t, f.org.id, 'Sol')
    await plantGrants(t, inactive, [f.sub])
    await plantGrants(t, viewerAgent, [f.sub])
    await plantGrants(t, subOnly, [f.sub2])
    await keyOrg(t, f.org.id)
    const all = async (ref: string, me: Doc<'profiles'>, limit = 1) =>
      (
        await walk(async (c) => {
          const p = await usersPage(
            t,
            me,
            ref,
            { cursor: c, limit },
            c === undefined ? 'rest' : 'mcp',
          )
          return { next_cursor: p.next_cursor, rows: p.rows as unknown as Row[] }
        })
      ).rows as unknown as ProjectUserJson[]
    const fw = await all('FW', pia)
    const assignable = Object.fromEntries(fw.map((u) => [u.name, u.assignable]))
    expect(assignable).toEqual({
      admin: true, // a member of Hardware, which shares FW at User
      guest: true, // a User grant on TBED, FW's parent
      Ina: false, // inactive
      Ledger: false, // a Viewer agent
      Pia: true,
      user: true, // TBED's lead
      viewer: false, // an organization Viewer
      Zed: false, // an organization Viewer with a User grant
    })
    // Gus, a guest in Blue, gets nothing through the team; Sol reaches only PCB
    expect(fw.map((u) => u.id)).not.toContain(gus.id)
    expect(fw.map((u) => u.id)).not.toContain(subOnly.id)
    expect(fw.map((u) => u.id)).not.toContain(f.otherAdmin.id)
    // a parent lists only people with standing on it, not those who reach
    // it through a sub-project
    const tbed = await all('TBED', f.user)
    expect(tbed.map((u) => u.name).sort()).toEqual(['guest', 'user', 'viewer'])
    expect(tbed.map((u) => u.id)).not.toContain(pia.id)
    // equal to the old per-profile walk, field for field, in name order
    expect(fw).toEqual(await t.run((ctx) => perProfileUsers(ctx, f.admin, f.sub)))
    expect(await t.run((ctx) => perProfileUsers(ctx, zed, f.sub))).toEqual(fw)
  })

  it('refuses whole past PICKERS.rule, and where a check of the resolve stopped', async () => {
    const { t, pia } = await detailsOrg()
    Object.assign(PICKERS.rule, { ranges: 1 })
    expect(await sentence(usersPage(t, pia, 'FW', {}, 'rest'))).toBe(PROJECT_USERS_TOO_LARGE)
    expect(await sentence(usersPage(t, pia, 'FW', {}, 'mcp'))).toBe(PROJECT_USERS_TOO_LARGE)
    expect(PROJECT_USERS_TOO_LARGE).toBe(
      "this project's access is too large to check in one request, so Qivo cannot list its users. Contact support@qivo.io so we can help.",
    )
    Object.assign(PICKERS.rule, structuredClone(DEFAULTS.rule))
    expect((await usersPage(t, pia, 'FW', {}, 'rest')).rows.length).toBeGreaterThan(0)
  })

  it('lists every Northstar project’s people and related lists as the old reads did', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    await keyOrg(t, org.id)
    const projects = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .collect(),
    )
    let checked = 0
    for (const p of projects) {
      let me: Doc<'profiles'> | undefined
      for (const who of profiles) {
        const reads = await usersPage(t, who, p.key, { limit: 7 }, 'rest').then(
          () => true,
          () => false,
        )
        if (reads) {
          me = who
          break
        }
      }
      if (me === undefined) continue
      const reader = me
      const users = await walk(async (c) => {
        const page = await usersPage(t, reader, p.key, { cursor: c, limit: 7 }, 'rest')
        return { next_cursor: page.next_cursor, rows: page.rows as unknown as Row[] }
      })
      expect(users.rows, p.key).toEqual(await t.run((ctx) => perProfileUsers(ctx, reader, p)))
      const old = await t.run((ctx) => wholeRelated(ctx, p))
      for (const list of LISTS)
        expect(
          (await walk((c) => restList(t, reader, list, p.key, { cursor: c, limit: 7 }))).rows,
          `${p.key} ${list}`,
        ).toEqual(old[list])
      checked += 1
    }
    expect(checked).toBeGreaterThan(0)
  })
})

/* ----------------------------------------------------------- the sentences */

describe('the sentences', () => {
  it('are pinned, and both API docs carry them', () => {
    const sentences = [
      ...LISTS.map((list) => offsetRefusal(NOUNS[list])),
      offsetRefusal('project users'),
      LIMITS.listMilestones.refusal,
      LIMITS.listUserGrants.refusal,
      LIMITS.listTeamGrants.refusal,
      LIMITS.listProjectUsers.refusal,
      PROJECT_USERS_TOO_LARGE,
    ]
    expect(sentences.slice(0, 4)).toEqual([
      'offset does not apply to milestones; pass next_cursor as cursor',
      'offset does not apply to user grants; pass next_cursor as cursor',
      'offset does not apply to team grants; pass next_cursor as cursor',
      'offset does not apply to project users; pass next_cursor as cursor',
    ])
    const docs = import.meta.glob(['../../docs/rest-api.md', '../../docs/mcp.md'], {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>
    expect(Object.keys(docs)).toHaveLength(2)
    for (const [path, text] of Object.entries(docs)) {
      const prose = text.replace(/\s+/g, ' ')
      for (const s of sentences) expect(prose, path).toContain(s)
    }
  })
})

/* -------------------------------------------------- the duplicate grants */

describe('internal/duplicateGrants:count', () => {
  it('finds two grants of one holder on one project, across pages, and counts them by organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++)
        await ctx.db.insert('project_access', {
          project_id: f.sub.id,
          profile_id: f.user.id,
          level: 'user',
        })
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: f.user.id,
        level: 'user',
      })
      for (let i = 0; i < 2; i++)
        await ctx.db.insert('project_team_access', {
          project_id: f.sub.id,
          team_id: f.team.id,
          level: 'user',
        })
    })
    const count = async (table: 'project_access' | 'project_team_access', pageSize: number) => {
      const found: string[][] = []
      const byOrg: Record<string, number> = {}
      let cursor: string | null = null
      let last: { id: string; project_id: string; holder_id: string } | null = null
      for (;;) {
        const page: FunctionReturnType<typeof internal.internal.duplicateGrants.count> =
          await t.query(internal.internal.duplicateGrants.count, {
            table,
            cursor,
            page_size: pageSize,
            last,
          })
        found.push(...page.duplicates.map((d) => d.ids))
        for (const [org, n] of Object.entries(page.by_org)) byOrg[org] = (byOrg[org] ?? 0) + n
        if (page.done) return { found, byOrg }
        cursor = page.cursor
        last = page.last
      }
    }
    for (const size of [1, 2, 100]) {
      const grants = await count('project_access', size)
      expect(grants.byOrg, `page size ${size}`).toEqual({ [f.org.id]: 2 })
      const shares = await count('project_team_access', size)
      expect(shares.byOrg).toEqual({ [f.org.id]: 1 })
      expect(shares.found.flat().length).toBeGreaterThanOrEqual(2)
    }
    await expect(
      t.query(internal.internal.duplicateGrants.count, {
        table: 'project_access',
        cursor: null,
        page_size: 0,
      }),
    ).rejects.toThrow(/page_size/)
  })
})

/* ------------------------------------------------------ the design size */

/* Prints what one read took. */
const show = (what: string, r: Read, more = '') =>
  console.log(
    `${what}: ${r.ranges} ranges, ${r.documents} documents, ${(r.bytes / 1024).toFixed(0)} KB${more}`,
  )

/* Every page of a project's users read in its own transaction. */
async function measuredUsers(t: T, me: Doc<'profiles'>, project: Doc<'projects'>, limit: number) {
  const reads: (Read & { rows: number; answer: number })[] = []
  let rows = 0
  let cursor: string | null = null
  for (let n = 0; n < 50; n++) {
    const { out, read } = await measured(t, (ctx) =>
      projectUserPage(ctx, me, project, { limit, cursor }),
    )
    reads.push({ ...read, rows: out.users.length, answer: pretty(out).length })
    rows += out.users.length
    if (out.next_cursor === null) return { reads, rows }
    cursor = out.next_cursor
  }
  throw new Error('the list did not end')
}

/* `n` people of `orgId`, planted raw. */
const crowd = (t: T, orgId: string, n: number) =>
  t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (let i = 0; i < n; i++) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: orgId,
        name: `Person ${String(i).padStart(4, '0')}`,
        initials: 'PE',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        created_at: NOW,
      })
      out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    return out
  })

describe('reads at the design size', () => {
  it('reads the details at the sum, 1,000 grants, 5 shares and 260 weekly milestones, and the lists over them', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const people = await crowd(t, f.org.id, 995)
    await t.run(async (ctx) => {
      for (const p of [...people, f.admin, f.user, f.viewer, f.guest, f.agent])
        await ctx.db.insert('project_access', {
          project_id: f.sub.id,
          profile_id: p.id,
          level: 'user',
        })
      for (let w = 0; w < 260; w++) {
        const day = new Date(Date.UTC(2022, 0, 3 + 7 * w)).toISOString().slice(0, 10)
        await ctx.db.insert('milestones', {
          id: uuid(),
          project_id: f.meta.id,
          name: `Milestone ${w}`,
          week: day,
          created_at: NOW,
        })
      }
    })
    for (let i = 0; i < 4; i++)
      await plantShares(t, await plantTeam(t, f.org.id, `Team ${i}`), [f.sub])
    await plantShares(t, f.team.id, [f.sub])
    await keyOrg(t, f.org.id)
    await countOrg(t, f.org.id)
    const me = f.user
    const detail = await measured(t, (ctx) => projectRead(ctx, me, f.sub, 'read'))
    expect(detail.out.grants.users).toHaveLength(50)
    expect(detail.out.milestones).toHaveLength(50)
    expect(detail.out.grants.teams).toHaveLength(5)
    expect(detail.out.team_grants_next_cursor).toBeNull()
    show(
      'case 1, the details',
      detail.read,
      `, ${(pretty(detail.out).length / 1024).toFixed(1)} KB as MCP text`,
    )
    const patch = await measured(t, (ctx) =>
      (
        restUpdateProject as unknown as {
          _handler: (
            c: QueryCtx,
            a: unknown,
          ) => Promise<{ name: string; grants: { users: unknown[] } }>
        }
      )._handler(ctx, {
        callerId: f.user.id,
        access: 'write',
        ref: 'FW',
        body: JSON.stringify({ name: 'Firmware renamed' }),
        keyName: null,
      }),
    )
    expect(patch.out.grants.users).toHaveLength(50)
    show('case 1, PATCH renaming it', patch.read)
    for (const limit of [50, 200]) {
      let cursor: string | null = null
      let rows = 0
      const reads: Read[] = []
      do {
        const { out, read } = await measured(t, (ctx) =>
          grantRows(ctx, me, f.sub, 'user_grants', { limit, cursor }),
        )
        reads.push(read)
        rows += out.rows.length
        cursor = out.next
      } while (cursor !== null)
      expect(rows).toBe(1000)
      show(
        `case 6, user grants at ${limit}, ${reads.length} pages, the heaviest`,
        reads.reduce((a, b) => (b.ranges > a.ranges ? b : a)),
      )
      cursor = null
      rows = 0
      const ms: Read[] = []
      do {
        const { out, read } = await measured(t, (ctx) =>
          milestoneRows(ctx, me, f.sub, { limit, cursor }),
        )
        ms.push(read)
        rows += out.rows.length
        cursor = out.next
      } while (cursor !== null)
      expect(rows).toBe(260)
      show(
        `case 7, milestones at ${limit}, ${ms.length} pages, the heaviest`,
        ms.reduce((a, b) => (b.documents > a.documents ? b : a)),
      )
    }
    const teams = await measured(t, (ctx) =>
      grantRows(ctx, me, f.sub, 'team_grants', { limit: 200, cursor: null }),
    )
    expect(teams.out.rows).toHaveLength(5)
    show('case 6, team grants at 200', teams.read)
    const users = await measuredUsers(t, me, f.sub, 200)
    expect(users.rows).toBe(1000)
    show(
      `case 4, users of a project with 1,000 grants at 200, ${users.reads.length} pages, the heaviest`,
      users.reads.reduce((a, b) => (b.documents > a.documents ? b : a)),
      `, the largest answer ${(Math.max(...users.reads.map((r) => r.answer)) / 1024).toFixed(1)} KB as MCP text`,
    )
  })

  it('pages the users of a project 995 of 1,000 people reach through one team, and of one 3 reach by grants', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const people = await crowd(t, f.org.id, 995)
    const team = await plantTeam(t, f.org.id, 'Crowd', people)
    await plantShares(t, team, [f.sub])
    const few = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
      key: 'FEW',
    })
    await plantGrants(t, people[10], [few])
    await plantGrants(t, people[500], [few])
    await plantGrants(t, people[990], [few])
    await keyOrg(t, f.org.id)
    for (const limit of [50, 200]) {
      const crowdPages = await measuredUsers(t, f.user, f.sub, limit)
      // the crowd, and TBED's lead and its two grants
      expect(crowdPages.rows).toBe(995 + 3)
      show(
        `case 2, at ${limit}, ${crowdPages.reads.length} pages, the heaviest`,
        crowdPages.reads.reduce((a, b) => (b.documents > a.documents ? b : a)),
      )
    }
    const sparse = await measuredUsers(t, f.user, few, 50)
    // SKNK's lead and the three grants
    expect(sparse.rows).toBe(4)
    show(`case 3, ${sparse.reads.length} pages, the first`, sparse.reads[0])
  })

  it('works out the rule for a sub-project shared with 5 teams under a project shared with 5 others', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const people = await crowd(t, f.org.id, 995)
    const everyone = [...people, f.admin, f.user, f.viewer, f.guest, f.agent]
    const teams: string[] = []
    for (let i = 0; i < 10; i++) teams.push(await plantTeam(t, f.org.id, `Team ${i}`))
    await t.run(async (ctx) => {
      // each person in 5 of the 10 teams, the design size's 5,000 memberships
      for (const [n, p] of everyone.entries())
        for (let k = 0; k < 5; k++)
          await ctx.db.insert('team_members', {
            team_id: teams[(n + 2 * k) % 10],
            profile_id: p.id,
            is_leader: false,
          })
      // 1,000 grants on each of the two projects
      for (const p of everyone)
        for (const project of [f.meta, f.sub])
          await ctx.db.insert('project_access', {
            project_id: project.id,
            profile_id: p.id,
            level: 'viewer',
          })
    })
    await plantShares(t, teams[0], [f.sub])
    for (let i = 1; i < 5; i++) await plantShares(t, teams[i], [f.sub])
    for (let i = 5; i < 10; i++) await plantShares(t, teams[i], [f.meta])
    await keyOrg(t, f.org.id)
    const users = await measuredUsers(t, f.user, f.sub, 200)
    expect(users.rows).toBe(1000)
    show(`case 5, ${users.reads.length} pages, the first`, users.reads[0])
  })
})
