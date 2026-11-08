/* REST GET /v1/projects and MCP list_projects a page at a time in tree
 * order (machine/projects.ts projectPage), with their search, cursors and
 * refusals, and the project routes that read one project's access instead
 * of the organization's catalogue (projectRead, lib/core.ts
 * projectCompletion). The old whole read, kept for the task routes, is the
 * oracle (machineProjects.setup.ts). Every fixture holds the reach rows and
 * archive states every deployment holds (projectReach.setup.ts withReach),
 * written after its last planted project, grant or share. The cases at the
 * design size raise one figure, or the sum a list covers, and print what
 * each page read. */

import { ConvexError } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, accessOf, accessUnchecked, OWN_READS } from '../lib/access'
import {
  COMPLETION_RESERVE,
  type CompletionJson,
  NO_TASKS,
  projectCompletion,
  UNAVAILABLE_COMPLETION,
} from '../lib/core'
import { byId } from '../lib/db'
import { ORG_ROLES } from '../lib/enums'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import {
  CURSOR_REFUSAL,
  listCursorText,
  namedScope,
  offsetRefusal,
  PROJECTS_NOT_READY,
} from '../lib/listCursor'
import { NAMED_READ } from '../lib/namedPages'
import { sha256hex } from '../machine/auth'
import {
  managedProject,
  PROJECTS_LIST,
  type ProjectsPageJson,
  projectPage,
  projectRead,
  restUpdateProject,
} from '../machine/projects'
import { pretty } from '../machine/shared'
import { PROJECT_NAV } from '../model/projectNavReads'
import { SHAPES } from './accessShapes.setup'
import {
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import {
  everyPage,
  type ListAsk,
  mcpPage,
  oracleRead,
  oracleRows,
  oracleSight,
  type ProjectRow,
  restPage,
} from './machineProjects.setup'
import { keyOrg } from './nameKeys.setup'
import { plantNorthstar } from './northstar.setup'
import { countOrg } from './overviewCounts.setup'
import {
  measured,
  names,
  person,
  plantGrants,
  plantMetas,
  plantShares,
  plantSubs,
  plantTeam,
  type Read,
  ready,
} from './projectNavFixtures.setup'
import { withReach } from './projectReach.setup'

const DEFAULTS = {
  named: structuredClone(NAMED_READ),
  own: structuredClone(OWN_READS),
  nav: structuredClone(PROJECT_NAV),
  completion: structuredClone(COMPLETION_RESERVE),
}
afterEach(() => {
  Object.assign(NAMED_READ, structuredClone(DEFAULTS.named))
  Object.assign(OWN_READS, structuredClone(DEFAULTS.own))
  Object.assign(PROJECT_NAV, structuredClone(DEFAULTS.nav))
  Object.assign(COMPLETION_RESERVE, structuredClone(DEFAULTS.completion))
})

const ACCESS_SENTENCE =
  'Qivo could not finish checking which projects you can see in one request. Contact support@qivo.io so we can help.'

/* The sentence a refused call carries. */
async function sentence(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (error: unknown) => error,
  )
  if (!(e instanceof ConvexError)) throw new Error(`expected a refusal, got ${String(e)}`)
  return (e.data as Refusal).message
}

/* The keys of a page's rows. */
const keys = (rows: readonly { key: string }[]) => rows.map((r) => r.key)

/* Every row of one list on one surface, `limit` a page. */
const restAll = (t: T, me: Doc<'profiles'>, access: 'read' | 'write', ask: ListAsk = {}) =>
  everyPage((cursor) => restPage(t, me, access, { ...ask, cursor }))
const mcpAll = (t: T, me: Doc<'profiles'>, access: 'read' | 'write', ask: ListAsk = {}) =>
  everyPage((cursor) => mcpPage(t, me, access, { ...ask, cursor }))

/* Distinct numbers for the projects this suite plants with chosen keys. */
let num = 50_000

/* A top-level meta of `orgId` with `key`, planted raw. */
const meta = (t: T, orgId: string, key: string, extra: Partial<Doc<'projects'>> = {}) =>
  plantProject(t, { org_id: orgId, key, name: `Project ${key}`, num: num++, ...extra })

/* A sub-project of `parent` with `key`, planted raw. */
const sub = (t: T, parent: Doc<'projects'>, key: string, extra: Partial<Doc<'projects'>> = {}) =>
  plantProject(t, {
    org_id: parent.org_id,
    type: 'project',
    parent_id: parent.id,
    key,
    name: `Sub ${key}`,
    num: num++,
    ...extra,
  })

/* A user grant of `me` on `project`, planted raw. */
const grant = (
  t: T,
  project: Doc<'projects'>,
  me: Doc<'profiles'>,
  level: 'user' | 'viewer' = 'user',
) => plantGrants(t, me, [project], level)

/* An agent key of `agent` for the HTTP cases. */
async function agentKey(t: T, agent: Doc<'profiles'>): Promise<string> {
  const secret = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const key_hash = await sha256hex(secret)
  await t.run(async (ctx) => {
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'Default key',
      key_prefix: secret.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  return secret
}

type Http = {
  fetch(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response>
}

/* REST over HTTP: the status and the parsed body. */
async function httpRest(t: T, secret: string, path: string) {
  const res = await (t as unknown as Http).fetch(path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  })
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> }
}

/* An MCP tools/call over HTTP: whether it is an error and its text. */
async function httpTool(t: T, secret: string, name: string, args: Record<string, unknown>) {
  const res = await (t as unknown as Http).fetch('/mcp', {
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
  const result = (
    JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } }
  ).result
  return { isError: result.isError === true, text: result.content[0].text }
}

/* --------------------------------------------------------------- fixtures */

/* withOrg with Mara, an agent of the organization, who holds User grants on
 * seven top-level projects whose keys mix digits and capital letters and
 * lengths, each with 0 to 4 sub-projects she inherits, and NAV, a project
 * she sees only for navigation through the two sub-projects she holds
 * grants on, beside a third she cannot see. */
async function tree() {
  const t = newT()
  const f = await withOrg(t)
  const mara = await plantSeat(t, { org_id: f.org.id, name: 'Mara', kind: 'agent' })
  const shape: [string, string[]][] = [
    ['A', []],
    ['A1', ['A1B', 'A10']],
    ['AB', ['AB1']],
    ['B2', ['B2B', 'B21', 'B2A', 'B22']],
    ['Z', ['ZA', 'Z9', 'Z0']],
    ['9X', ['9XA', '9X1']],
    ['ZZ', ['ZZ1']],
  ]
  for (const [top, kids] of shape) {
    const p = await meta(t, f.org.id, top)
    // Z's sub-projects are named against their keys' order
    for (const [i, k] of kids.entries())
      await sub(t, p, k, top === 'Z' ? { name: `Sub ${'abc'[i]}` } : {})
    await grant(t, p, mara)
  }
  const nav = await meta(t, f.org.id, 'NAV')
  for (const k of ['NV2', 'NV1']) await grant(t, await sub(t, nav, k), mara)
  await sub(t, nav, 'NV3')
  await withReach(t)
  // the tree order: each top-level project by key in byte order, then its
  // sub-projects by key
  const order = [
    '9X',
    '9X1',
    '9XA',
    'A',
    'A1',
    'A10',
    'A1B',
    'AB',
    'AB1',
    'B2',
    'B21',
    'B22',
    'B2A',
    'B2B',
    'NAV',
    'NV1',
    'NV2',
    'Z',
    'Z0',
    'Z9',
    'ZA',
    'ZZ',
    'ZZ1',
  ]
  return { t, f, mara, order }
}

/* ------------------------------------------------------------- arguments */

describe('the arguments', () => {
  it('refuses a limit, an offset, a search and archived out of range, in that order, on both surfaces', async () => {
    const { t, mara } = await tree()
    const rest = (a: Record<string, string>) =>
      t.query(internal.machine.rest.listProjects, { callerId: mara.id, access: 'read', ...a })
    const mcp = (a: Record<string, unknown>) =>
      t.query(internal.machine.mcp.listProjects, { callerId: mara.id, access: 'read', ...a })
    const LIMIT = LIMITS.listProjects.refusal
    expect(LIMIT).toBe('limit must be a whole number of projects from 1 to 200.')
    const OFFSET = offsetRefusal('projects')
    expect(OFFSET).toBe('offset does not apply to projects; pass next_cursor as cursor')
    for (const limit of ['0', '201', '1.5', 'ten'])
      expect(await sentence(rest({ limit }))).toBe(LIMIT)
    for (const limit of [0, 201, 1.5]) expect(await sentence(mcp({ limit }))).toBe(LIMIT)
    for (const offset of ['1', '-1', '1.5', 'abc'])
      expect(await sentence(rest({ offset }))).toBe(OFFSET)
    for (const offset of [1, -1, 1.5]) expect(await sentence(mcp({ offset }))).toBe(OFFSET)
    for (const offset of ['0', '00']) expect((await rest({ offset })).next_cursor).toBeNull()
    expect(JSON.parse(await mcp({ offset: 0 })).next_cursor).toBeNull()
    const long = 'x'.repeat(LIMITS.search.max + 1)
    expect(await sentence(rest({ search: long }))).toBe(LIMITS.search.refusal)
    expect(await sentence(mcp({ search: long }))).toBe(LIMITS.search.refusal)
    expect(await sentence(rest({ archived: 'maybe' }))).toBe('archived must be true or false')
    // the order: limit, offset, search, archived, then the cursor
    expect(
      await sentence(
        rest({ limit: '0', offset: '1', search: long, archived: 'x', cursor: 'junk' }),
      ),
    ).toBe(LIMIT)
    expect(await sentence(rest({ offset: '1', search: long, archived: 'x', cursor: 'junk' }))).toBe(
      OFFSET,
    )
    expect(await sentence(rest({ search: long, archived: 'x', cursor: 'junk' }))).toBe(
      LIMITS.search.refusal,
    )
    expect(await sentence(rest({ archived: 'x', cursor: 'junk' }))).toBe(
      'archived must be true or false',
    )
    expect(await sentence(rest({ cursor: 'junk' }))).toBe(CURSOR_REFUSAL)
    expect(await sentence(mcp({ limit: 0, offset: 1, search: long, cursor: 'junk' }))).toBe(LIMIT)
    expect(await sentence(mcp({ offset: 1, search: long, cursor: 'junk' }))).toBe(OFFSET)
    // REST takes an empty cursor or search as absent; MCP refuses an empty cursor
    const first = await rest({})
    expect(await rest({ cursor: '', search: '' })).toEqual(first)
    expect(await sentence(mcp({ cursor: '' }))).toBe(CURSOR_REFUSAL)
  })

  it('refuses over HTTP an unknown REST query parameter, and MCP schema type errors before the tool runs', async () => {
    const { t, mara } = await tree()
    const secret = await agentKey(t, mara)
    expect(await httpRest(t, secret, '/v1/projects?page=2')).toMatchObject({ status: 400 })
    const ok = await httpRest(t, secret, '/v1/projects?limit=2&offset=0')
    expect(ok.status).toBe(200)
    expect(keys(ok.body.projects as ProjectRow[])).toEqual(['9X', '9X1'])
    for (const limit of ['0', '1.5']) {
      const refused = await httpRest(t, secret, `/v1/projects?limit=${limit}`)
      expect(refused).toEqual({ status: 400, body: { error: LIMITS.listProjects.refusal } })
    }
    const offset = await httpRest(t, secret, '/v1/projects?offset=1')
    expect(offset).toEqual({ status: 400, body: { error: offsetRefusal('projects') } })
    for (const args of [{ limit: 1.5 }, { limit: 'ten' }, { offset: 'abc' }, { archived: 'yes' }]) {
      const res = await httpTool(t, secret, 'list_projects', args)
      expect(res.isError, JSON.stringify(args)).toBe(true)
      expect(res.text).toMatch(/^Input validation error/)
    }
    const page = await httpTool(t, secret, 'list_projects', { limit: 2 })
    expect(page.isError).toBe(false)
    // MCP's text keeps the cursor first
    expect(Object.keys(JSON.parse(page.text))).toEqual(['next_cursor', 'projects'])
  })
})

/* --------------------------------------------------------------- cursors */

describe('the cursors', () => {
  it('open only for their list, organization, caller, side and search, and continue on the other surface', async () => {
    const { t, f, mara, order } = await tree()
    // a second caller with the same grants
    const ivo = await plantSeat(t, { org_id: f.org.id, name: 'Ivo', kind: 'agent' })
    await t.run(async (ctx) => {
      const grants = await ctx.db
        .query('project_access')
        .withIndex('by_profile', (q) => q.eq('profile_id', mara.id))
        .collect()
      for (const { _id, _creationTime, ...g } of grants)
        await ctx.db.insert('project_access', { ...g, profile_id: ivo.id })
    })
    await withReach(t)
    const page = await restPage(t, mara, 'read', { limit: 2 })
    const cursor = page.next_cursor as string
    expect(typeof cursor).toBe('string')
    const refused = async (me: Doc<'profiles'>, ask: ListAsk) => {
      expect(await sentence(restPage(t, me, 'read', ask))).toBe(CURSOR_REFUSAL)
      expect(await sentence(mcpPage(t, me, 'read', ask))).toBe(CURSOR_REFUSAL)
    }
    await refused(ivo, { cursor })
    await refused(f.otherAdmin, { cursor })
    await refused(mara, { cursor, archived: true })
    await refused(mara, { cursor, search: 'project' })
    const searched = (await restPage(t, mara, 'read', { search: 'project', limit: 1 }))
      .next_cursor as string
    await refused(mara, { cursor: searched })
    await refused(mara, { cursor: searched, search: 'projects' })
    // hand-sealed positions of other lists and of other shapes
    const scope = await namedScope(mara, '', ['active'])
    const at = { key: 'A1', tie: [page.projects[0].id, '', ''] }
    const tie = (t3: string[]) => listCursorText(PROJECTS_LIST, scope, { key: 'A1', tie: t3 })
    for (const other of [
      await listCursorText('machine.users', scope, at),
      await listCursorText('machine.task_links', scope, at),
      await tie([page.projects[0].id, '']),
      await tie([page.projects[0].id, 'A10', '']),
      await tie([page.projects[0].id, '', page.projects[1].id]),
      `${cursor.slice(0, -2)}${cursor.slice(-2) === 'aa' ? 'bb' : 'aa'}`,
      'junk',
    ])
      await refused(mara, { cursor: other })
    // a well-formed hand-sealed position opens
    expect(
      (await restPage(t, mara, 'read', { cursor: await listCursorText(PROJECTS_LIST, scope, at) }))
        .projects.length,
    ).toBeGreaterThan(0)
    // REST's cursor goes on over MCP and the reverse, at any limit
    const rows: ProjectRow[] = [...page.projects]
    let next: string | null = cursor
    let surface = 0
    while (next !== null) {
      const limit = 1 + (surface % 3)
      const p: ProjectsPageJson =
        surface % 2 === 0
          ? await mcpPage(t, mara, 'read', { cursor: next, limit })
          : await restPage(t, mara, 'read', { cursor: next, limit })
      rows.push(...p.projects)
      next = p.next_cursor
      surface += 1
    }
    expect(keys(rows)).toEqual(order)
    // "Café" and "cafe" share cursors
    await t.run(async (ctx) => {
      const a = await ctx.db
        .query('projects')
        .withIndex('by_org_key', (q) => q.eq('org_id', f.org.id).eq('key', 'A'))
        .unique()
      const b = await ctx.db
        .query('projects')
        .withIndex('by_org_key', (q) => q.eq('org_id', f.org.id).eq('key', 'B2'))
        .unique()
      if (a === null || b === null) throw new Error('fixture')
      await ctx.db.patch(a._id, { name: 'Café one' })
      await ctx.db.patch(b._id, { name: 'Cafe two' })
    })
    await withReach(t)
    const café = await restPage(t, mara, 'read', { search: 'Café', limit: 1 })
    expect(keys(café.projects)).toEqual(['A'])
    const rest = await mcpPage(t, mara, 'read', {
      search: 'cafe',
      cursor: café.next_cursor as string,
    })
    expect(keys(rest.projects)).toEqual(['B2'])
  })

  it('continue past a stored project and sub-project whose ids are not UUIDs', async () => {
    const { t, f, mara, order } = await tree()
    // ids an app create stored as the client sent them, before
    // lib/db.ts assertNewRowId
    const legacy = await meta(t, f.org.id, 'L', { id: 'legacy-project' })
    await sub(t, legacy, 'L1', { id: 'Legacy sub 1' })
    await sub(t, legacy, 'L2')
    await grant(t, legacy, mara)
    await withReach(t)
    const expected = [...order]
    expected.splice(expected.indexOf('NAV'), 0, 'L', 'L1', 'L2')
    // every page cut, at limit 1, also at the two ids
    for (const all of [restAll, mcpAll])
      expect(keys((await all(t, mara, 'read', { limit: 1 })).rows)).toEqual(expected)
  })
})

/* -------------------------------------------------------- order and paging */

describe('the order and the pages', () => {
  it('lists every row once in tree order at every limit, the cursor null only after the last', async () => {
    const { t, mara, order } = await tree()
    for (const limit of [1, 2, 3, 7, 50]) {
      for (const all of [restAll, mcpAll]) {
        const { rows, pages } = await all(t, mara, 'read', { limit })
        expect(keys(rows), `limit ${limit}`).toEqual(order)
        expect(pages.slice(0, -1).every((p) => p.next_cursor !== null)).toBe(true)
        expect(pages.at(-1)?.next_cursor).toBeNull()
        for (const p of pages) expect(p.projects.length).toBeLessThanOrEqual(limit)
      }
    }
    // a page that ends inside a project's sub-projects goes on after them
    const second = await restPage(t, mara, 'read', {
      limit: 2,
      cursor: (await restPage(t, mara, 'read', { limit: 5 })).next_cursor as string,
    })
    expect(keys(second.projects)).toEqual(['A10', 'A1B'])
    // byte order and the old key order agree on these keys
    const tops = ['9X', 'A', 'A1', 'AB', 'B2', 'NAV', 'Z', 'ZZ']
    expect([...tops].sort((a, b) => a.localeCompare(b))).toEqual(tops)
    // the flags: a project seen only for navigation reads, its sub-projects
    // with grants write, and the third is not listed
    const { rows } = await restAll(t, mara, 'write', { limit: 50 })
    const writes = Object.fromEntries(rows.map((r) => [r.key, r.access.write]))
    expect(writes).toMatchObject({ NAV: false, NV1: true, NV2: true, A: true, A10: true })
    expect(rows.every((r) => r.access.read)).toBe(true)
  })

  it('moves a project to its new key between pages, as pages are not a snapshot', async () => {
    const { t, f, mara, order } = await tree()
    const first = await restPage(t, mara, 'read', { limit: 3 })
    expect(keys(first.projects)).toEqual(['9X', '9X1', '9XA'])
    await t.run(async (ctx) => {
      const zz = await ctx.db
        .query('projects')
        .withIndex('by_org_key', (q) => q.eq('org_id', f.org.id).eq('key', 'ZZ'))
        .unique()
      if (zz === null) throw new Error('fixture')
      await ctx.db.patch(zz._id, { key: 'AA' })
    })
    await withReach(t)
    const { rows } = await everyPage((cursor) =>
      restPage(t, mara, 'read', { limit: 4, cursor: cursor ?? (first.next_cursor as string) }),
    )
    // ZZ, now AA, comes with its sub-project before AB
    const expected = order.slice(3).filter((k) => k !== 'ZZ' && k !== 'ZZ1')
    expected.splice(expected.indexOf('AB'), 0, 'AA', 'ZZ1')
    expect(keys(rows)).toEqual(expected)
  })

  it('reads within NAMED_READ, ending pages short with a cursor that moves, every row once', async () => {
    const { t, mara, order } = await tree()
    // a page always reads its first row, and here every row the walk
    // hands out is listed, so every page but the last holds one, and there
    // is at most one page more than there are rows
    const short = (pages: ProjectsPageJson[]) => {
      expect(pages.slice(0, -1).map((p) => p.projects.length > 0)).not.toContain(false)
      expect(pages.length).toBeLessThanOrEqual(order.length + 1)
    }
    Object.assign(NAMED_READ, { ranges: 3 })
    const ranged = await restAll(t, mara, 'read', { limit: 50 })
    short(ranged.pages)
    expect(keys(ranged.rows)).toEqual(order)
    expect(ranged.pages.length).toBeGreaterThan(3)
    Object.assign(NAMED_READ, { ranges: 1, documents: 1 })
    const least = await mcpAll(t, mara, 'read', { limit: 50 })
    short(least.pages)
    expect(keys(least.rows)).toEqual(order)
    // one read a page leaves room for the first row alone
    expect(least.pages.length).toBeGreaterThanOrEqual(order.length)
  })
})

/* ---------------------------------------------------------- who sees what */

describe('who is listed', () => {
  it('lists every project the caller sees as the catalogue did, for every Northstar person and agent', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    await withReach(t)
    let seen = 0
    for (const me of profiles) {
      for (const archived of [false, true]) {
        for (const access of ['read', 'write'] as const) {
          const expected = await t.run((ctx) => oracleRows(ctx, me, access, archived))
          const { rows } = await restAll(t, me, access, { archived, limit: 7 })
          expect(rows, `${me.name} ${access} archived ${archived}`).toEqual(expected)
          seen += rows.length
        }
        const { rows } = await mcpAll(t, me, 'read', { archived, limit: 7 })
        expect(rows).toEqual(await t.run((ctx) => oracleRows(ctx, me, 'read', archived)))
      }
    }
    expect(seen).toBeGreaterThan(0)
  })

  it('lists what the catalogue listed for every grant shape, role and credential', async () => {
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      // an archived sub-project of TBED and an archived top-level project
      // with the subject's grants, so both sides of the axis hold rows
      const old = await sub(t, f.meta, uuid().slice(0, 5).toUpperCase().replace(/-/g, 'X'), {
        archived_at: NOW,
      })
      await grant(t, old, subject, 'viewer')
      await withReach(t)
      for (const org_role of ORG_ROLES) {
        await t.run((ctx) => ctx.db.patch(subject._id, { org_role }))
        const me = { ...subject, org_role }
        for (const archived of [false, true])
          for (const access of ['read', 'write'] as const)
            expect(
              (await restAll(t, me, access, { archived, limit: 3 })).rows,
              `${name} as ${org_role}, ${access}, archived ${archived}`,
            ).toEqual(await t.run((ctx) => oracleRows(ctx, me, access, archived)))
      }
      for (const me of [f.admin, f.user, f.viewer, f.guest, f.agent, f.otherAdmin])
        for (const archived of [false, true])
          expect((await restAll(t, me, 'read', { archived })).rows, `${name}: ${me.name}`).toEqual(
            await t.run((ctx) => oracleRows(ctx, me, 'read', archived)),
          )
    }
  }, 60_000)

  it('keeps out what the caller cannot see, and never writes past the credential or the level', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    // NAV seen through a live sub-project; ARC only through an archived one
    const nav = await meta(t, f.org.id, 'NAV')
    const nv1 = await sub(t, nav, 'NV1')
    await sub(t, nav, 'NV2')
    await grant(t, nv1, pia)
    const arc = await meta(t, f.org.id, 'ARC')
    const ar1 = await sub(t, arc, 'AR1', { archived_at: NOW })
    await grant(t, ar1, pia)
    // a guest's team share gives nothing; a Viewer's User grant reads only
    const gus = await person(t, f.org.id, 'Gus', { org_role: 'guest' })
    const shared = await meta(t, f.org.id, 'TSH')
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [gus]), [shared])
    const vic = await person(t, f.org.id, 'Vic', { org_role: 'viewer' })
    const viewerAgent = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Ledger',
      org_role: 'viewer',
      kind: 'agent',
    })
    await grant(t, shared, vic)
    await grant(t, shared, viewerAgent)
    // a lead the Viewer kept on a sub-project writes reach rows and gives
    // no access, so neither the sub-project nor its parent is listed
    await sub(t, await meta(t, f.org.id, 'VLM'), 'VLD', { lead_id: vic.id })
    // a project outside a meta's tree with a grant, and another
    // organization's project
    const loose = await meta(t, f.org.id, 'LOOSE', { type: 'project' })
    await grant(t, loose, pia)
    await withReach(t)
    const active = await restAll(t, pia, 'write')
    expect(keys(active.rows)).toEqual(['ARC', 'NAV', 'NV1'])
    expect(active.rows.map((r) => r.access.write)).toEqual([false, false, true])
    expect(keys((await restAll(t, pia, 'write', { archived: true })).rows)).toEqual(['AR1'])
    // a read-only credential writes nowhere
    expect((await restAll(t, pia, 'read')).rows.every((r) => !r.access.write)).toBe(true)
    expect(keys((await restAll(t, gus, 'write')).rows)).toEqual([])
    for (const v of [vic, viewerAgent]) {
      const { rows } = await mcpAll(t, v, 'write')
      expect(keys(rows)).toEqual(['TSH'])
      expect(rows[0].access).toEqual({ read: true, write: false })
    }
    // an organization admin without a lead, grant or share lists nothing
    expect(keys((await restAll(t, f.admin, 'write')).rows)).toEqual([])
    expect(keys((await restAll(t, f.otherAdmin, 'write')).rows)).toEqual(['OTH'])
    // a reach row whose copies differ from its project shows nothing at
    // either place, a row naming another organization's project or a
    // project that is gone shows nothing, and a raw root row on a project
    // outside a meta's tree shows nothing
    const gone = await meta(t, f.org.id, 'GONE')
    await grant(t, gone, pia)
    await withReach(t)
    expect(keys((await restAll(t, pia, 'read')).rows)).toEqual(['ARC', 'GONE', 'NAV', 'NV1'])
    const childRow = () =>
      t.run(
        async (ctx) =>
          (await ctx.db
            .query('project_reach')
            .withIndex('by_project_grantee', (q) =>
              q.eq('project_id', nv1.id).eq('grantee_kind', 'profile').eq('grantee_id', pia.id),
            )
            .unique()) as Doc<'project_reach'>,
      )
    const nv1Row = await childRow()
    await t.run((ctx) => ctx.db.patch(nv1Row._id, { key: 'QQQQQ' }))
    expect(keys((await restAll(t, pia, 'read')).rows)).toEqual(['ARC', 'GONE', 'NAV'])
    await t.run((ctx) => ctx.db.patch(nv1Row._id, { key: nv1.key }))
    await t.run(async (ctx) => {
      const rowOf = async (projectId: string) =>
        (await ctx.db
          .query('project_reach')
          .withIndex('by_project_grantee', (q) =>
            q.eq('project_id', projectId).eq('grantee_kind', 'profile').eq('grantee_id', pia.id),
          )
          .unique()) as Doc<'project_reach'>
      await ctx.db.patch((await rowOf(nav.id))._id, { key: 'ZZZZZ' })
      await ctx.db.delete(gone._id)
      const base = await rowOf(arc.id)
      const { _id, _creationTime, ...copy } = base
      await ctx.db.insert('project_reach', {
        ...copy,
        project_id: f.otherProject.id,
        root_id: f.otherProject.id,
        key: f.otherProject.key,
        name_key: 'elsewhere',
        live: true,
      })
      await ctx.db.insert('project_reach', {
        ...copy,
        project_id: loose.id,
        root_id: loose.id,
        key: loose.key,
        name_key: 'project loose',
        on_root: true,
      })
    })
    const after = await restAll(t, pia, 'read', { limit: 1 })
    expect(keys(after.rows)).toEqual(['ARC'])
  })

  it('reads no sub-project of a project seen only for navigation that no row of theirs names', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [wide] = await plantMetas(t, f.org.id, ['Wide'])
    const subs = await plantSubs(t, wide, names('Sub ', 40))
    await plantGrants(t, pia, [subs[20]])
    await ready(t, f)
    const { out, read } = await measured(t, (ctx) =>
      projectPage(ctx, pia, 'read', { archived: false, search: '', limit: 50, cursor: null }),
    )
    expect(out.projects.map((p) => p.id)).toEqual([wide.id, subs[20].id])
    // the 39 sub-projects without a row of hers are never read
    expect(read.documents).toBeLessThan(25)
  })

  it('reads no task', async () => {
    const { t, mara, order } = await tree()
    const shown = await t.run(async (ctx) => {
      const db = new Proxy(ctx.db, {
        get(target, prop) {
          if (prop !== 'query') {
            const value = Reflect.get(target, prop, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
          return (table: string) => {
            if (table === 'issues' || table === 'issue_texts' || table === 'attachments')
              throw new Error(`the page read ${table}`)
            return target.query(table as never)
          }
        },
      })
      const page = await projectPage({ ...ctx, db } as QueryCtx, mara, 'read', {
        archived: false,
        search: 'zzz',
        limit: 200,
        cursor: null,
      })
      const all = await projectPage({ ...ctx, db } as QueryCtx, mara, 'read', {
        archived: false,
        search: '',
        limit: 200,
        cursor: null,
      })
      return { none: page.projects.length, all: keys(all.projects) }
    })
    expect(shown).toEqual({ none: 0, all: order })
  })
})

/* ------------------------------------------------------- the archived list */

describe('the archived list', () => {
  it('holds an archived project with its sub-projects, and an active project’s archived sub-projects at its place', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const old = await meta(t, f.org.id, 'OLD', { archived_at: NOW })
    for (const k of ['OL2', 'OL1']) await sub(t, old, k, { archived_at: NOW })
    const live = await meta(t, f.org.id, 'LIV')
    await sub(t, live, 'LV1', { archived_at: NOW })
    await sub(t, live, 'LV2')
    await plantGrants(t, pia, [old, live])
    await withReach(t)
    expect(keys((await restAll(t, pia, 'read', { archived: true })).rows)).toEqual([
      'LV1',
      'OLD',
      'OL1',
      'OL2',
    ])
    expect(keys((await restAll(t, pia, 'read')).rows)).toEqual(['LIV', 'LV2'])
    // a cursor on the live parent's archived sub-project goes on
    const one = await mcpAll(t, pia, 'read', { archived: true, limit: 1 })
    expect(keys(one.rows)).toEqual(['LV1', 'OLD', 'OL1', 'OL2'])
  })
})

/* ------------------------------------------------------------- the search */

describe('the search', () => {
  it('matches a project by every word of its own name or by its key, before the cut', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const cafe = await meta(t, f.org.id, 'CAFE', { name: 'Café Rénovation' })
    const tele = await meta(t, f.org.id, 'QX7', { name: 'Telemetry' })
    const optics = await meta(t, f.org.id, 'OPT', { name: 'Optics' })
    await sub(t, optics, 'LNS', { name: 'Lens' })
    await sub(t, optics, 'MNT', { name: 'Mount for optics' })
    await plantGrants(t, pia, [cafe, tele, optics])
    await withReach(t)
    const found = async (search: string) =>
      keys((await restAll(t, pia, 'read', { search, limit: 1 })).rows)
    expect(await found('cafe renovation')).toEqual(['CAFE'])
    expect(await found('RENOVATION café')).toEqual(['CAFE'])
    expect(await found('qx7')).toEqual(['QX7'])
    // a key matches only as the whole search
    expect(await found('qx')).toEqual([])
    // a matching parent brings no sub-projects; a matching sub-project
    // shows without its parent's row
    expect(await found('optics')).toEqual(['OPT', 'MNT'])
    expect(await found('lens')).toEqual(['LNS'])
    // blank browses
    expect(await found('   ')).toEqual(['CAFE', 'OPT', 'LNS', 'MNT', 'QX7'])
    expect(keys((await mcpAll(t, pia, 'read', { search: '  ' })).rows)).toEqual([
      'CAFE',
      'OPT',
      'LNS',
      'MNT',
      'QX7',
    ])
    // a search that matches nothing under a small budget answers empty
    // pages with cursors to the end, never a false end
    Object.assign(NAMED_READ, { ranges: 2 })
    const none = await restAll(t, pia, 'read', { search: 'nothing here' })
    expect(none.rows).toEqual([])
    expect(none.pages.length).toBeGreaterThan(1)
    expect(none.pages.slice(0, -1).every((p) => p.next_cursor !== null)).toBe(true)
  })
})

/* -------------------------------------------------------------- refusals */

describe('refusals', () => {
  it('refuses an organization whose reach rows are not ready, before it opens a cursor', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grant(t, f.meta, f.user)
    for (const cursor of [undefined, 'junk']) {
      expect(await sentence(restPage(t, f.user, 'read', { cursor }))).toBe(PROJECTS_NOT_READY)
      expect(await sentence(mcpPage(t, f.user, 'read', { cursor }))).toBe(PROJECTS_NOT_READY)
    }
    expect(PROJECTS_NOT_READY).toBe(
      "this list cannot be read until this organization's projects are ready; try again in a few minutes",
    )
    await withReach(t)
    expect(keys((await restPage(t, f.user, 'read')).projects)).toEqual([
      'SKNK',
      'TBED',
      'FW',
      'PCB',
    ])
  })

  it('refuses the whole call where a check stopped, and past PROJECT_NAV.teams teams', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    // two of her teams share one project, so its check asks two
    // memberships, and the second cannot finish under the lowered bounds
    const shared = await meta(t, f.org.id, 'SHR')
    for (const name of ['Red', 'Blue'])
      await plantShares(t, await plantTeam(t, f.org.id, name, [pia]), [shared])
    await withReach(t)
    expect(keys((await restPage(t, pia, 'read')).projects)).toEqual(['SHR'])
    Object.assign(OWN_READS, { lookups: 0, members: 0 })
    const refused = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => null,
        (error: unknown) => error,
      )
      expect(e).toBeInstanceOf(ConvexError)
      expect((e as ConvexError<Refusal>).data).toMatchObject({
        code: 'rule',
        reason: ACCESS_UNCHECKED,
        message: ACCESS_SENTENCE,
      })
    }
    await refused(restPage(t, pia, 'read'))
    await refused(mcpPage(t, pia, 'read'))
    Object.assign(OWN_READS, structuredClone(DEFAULTS.own))
    Object.assign(PROJECT_NAV, { teams: 1 })
    await refused(restPage(t, pia, 'read'))
    await refused(mcpPage(t, pia, 'read'))
    Object.assign(PROJECT_NAV, { teams: 2 })
    expect(keys((await mcpPage(t, pia, 'read')).projects)).toEqual(['SHR'])
  })

  it('pins its sentences, and both API docs carry them', () => {
    const docs = import.meta.glob(['../../docs/rest-api.md', '../../docs/mcp.md'], {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>
    expect(Object.keys(docs)).toHaveLength(2)
    for (const [path, text] of Object.entries(docs)) {
      // a wrapped line reads as one space
      const prose = text.replace(/\s+/g, ' ')
      for (const s of [
        offsetRefusal('projects'),
        PROJECTS_NOT_READY,
        CURSOR_REFUSAL,
        LIMITS.listProjects.refusal,
      ])
        expect(prose, path).toContain(s)
    }
  })
})

/* ------------------------------------------- the single read and the writes */

/* What a route answered: its rows, or the code and sentence it refused the
 * call with. */
const outcome = (call: Promise<unknown>) =>
  call.then(
    (out) => ({ out }),
    (e: unknown) => {
      if (!(e instanceof ConvexError)) throw e
      const { code, message } = e.data as Refusal
      return { code, message }
    },
  )

/* REST's one 404 for a project the caller may not name. */
const REST_MISSING = { code: 'not_found', message: 'project not found' }

/* How many of the calls answered, were refused, and answered a project the
 * caller manages without reading it. */
type Shown = { answered: number; refused: number; managedOnly: number }

/* For `me` on each of `projects`, by key: REST GET /v1/projects/{ref} and
 * get_project answer what the catalogue answered, and so do the grant
 * lists (GET /access/users and /access/teams, list_project_related's
 * grants), where the catalogue showed the project as read or managed
 * (oracleSight), and refuse it as an unknown project exactly where it did
 * not; the milestone lists and the project users routes answer only where
 * the caller reads it. The organization's names are keyed, which the grant
 * lists and the users read. */
async function sameSight(
  t: T,
  me: Doc<'profiles'>,
  projects: readonly Doc<'projects'>[],
  shown: Shown,
) {
  const ask = { callerId: me.id, access: 'write' as const }
  for (const p of projects) {
    const label = `${me.name} (${me.org_role}) on ${p.key}`
    const { reads, manages } = await t.run((ctx) => oracleSight(ctx, me, p))
    const MCP_MISSING = {
      code: 'not_found',
      message: `project "${p.key}" not found (or not visible to you)`,
    }
    const related = (list: 'milestones' | 'user_grants' | 'team_grants') =>
      outcome(
        t.query(internal.machine.projects.mcpProjectRelated, { ...ask, project: p.key, list }),
      )
    const rest = await outcome(t.query(internal.machine.rest.getProject, { ...ask, ref: p.key }))
    const mcp = await outcome(
      t.query(internal.machine.projects.mcpGetProject, { ...ask, project: p.key }),
    )
    const routes = {
      userGrants: await outcome(
        t.query(internal.machine.projects.restListUserGrants, { ...ask, ref: p.key }),
      ),
      teamGrants: await outcome(
        t.query(internal.machine.projects.restListTeamGrants, { ...ask, ref: p.key }),
      ),
      milestones: await outcome(
        t.query(internal.machine.projects.restListMilestones, { ...ask, ref: p.key }),
      ),
      users: await outcome(t.query(internal.machine.rest.listProjectUsers, { ...ask, ref: p.key })),
      mcpUserGrants: await related('user_grants'),
      mcpTeamGrants: await related('team_grants'),
      mcpMilestones: await related('milestones'),
      mcpUsers: await outcome(
        t.query(internal.machine.mcp.listProjectUsers, { ...ask, project: p.key }),
      ),
    }
    // each route answers where `answers`, else refuses as REST or MCP does
    const expectRoutes = (names: (keyof typeof routes)[], answers: boolean) => {
      for (const name of names) {
        const missing = name.startsWith('mcp') ? MCP_MISSING : REST_MISSING
        if (answers) expect(routes[name], `${label}: ${name}`).not.toHaveProperty('code')
        else expect(routes[name], `${label}: ${name}`).toEqual(missing)
      }
    }
    expectRoutes(['userGrants', 'teamGrants', 'mcpUserGrants', 'mcpTeamGrants'], reads || manages)
    expectRoutes(['milestones', 'users', 'mcpMilestones', 'mcpUsers'], reads)
    if (!(reads || manages)) {
      shown.refused += 1
      expect(rest, label).toEqual(REST_MISSING)
      expect(mcp, label).toEqual(MCP_MISSING)
      continue
    }
    shown.answered += 1
    if (!reads) shown.managedOnly += 1
    expect(rest, label).toEqual({ out: await t.run((ctx) => oracleRead(ctx, me, p, 'write')) })
    expect(JSON.parse((mcp as { out: string }).out), label).toEqual((rest as { out: unknown }).out)
  }
}

describe('the single read and the write answers', () => {
  it('answer what the catalogue answered, flags and completion included', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    await withReach(t)
    await countOrg(t, profiles[0].org_id)
    await keyOrg(t, profiles[0].org_id)
    const projects = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', profiles[0].org_id))
        .collect(),
    )
    const shown = { answered: 0, refused: 0, managedOnly: 0 }
    for (const me of profiles) await sameSight(t, me, projects, shown)
    console.log(`the single read over Northstar: ${JSON.stringify(shown)}`)
    expect(shown.answered).toBeGreaterThan(profiles.length)
  })

  it('refuse a project exactly where the catalogue did not answer it, for every grant shape and role', async () => {
    const shown = { answered: 0, refused: 0, managedOnly: 0 }
    for (const [name, plant] of SHAPES) {
      const t = newT()
      const f = await withOrg(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: `Subject, ${name}` })
      await t.run((ctx) => plant(ctx, f, subject))
      await withReach(t)
      await countOrg(t, f.org.id)
      await keyOrg(t, f.org.id)
      const projects = await t.run(
        async (ctx) =>
          await ctx.db
            .query('projects')
            .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
            .collect(),
      )
      for (const org_role of ORG_ROLES) {
        await t.run((ctx) => ctx.db.patch(subject._id, { org_role }))
        await sameSight(t, { ...subject, org_role }, projects, shown)
      }
      for (const me of [f.admin, f.guest, f.agent]) await sameSight(t, me, projects, shown)
    }
    // every outcome came up: answered, refused, and managed without reading
    console.log(`the single read over the grant shapes: ${JSON.stringify(shown)}`)
    expect(shown.refused).toBeGreaterThan(0)
    expect(shown.managedOnly).toBeGreaterThan(0)
  }, 60_000)

  it('counts a top-level project’s sub-projects the caller reads in part, and a sub-project itself', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await grant(t, f.sub, pia)
    // one Done task in FW, which Pia reads, and two To Do in PCB, which she
    // does not
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, status: 'done' })
    for (let i = 0; i < 2; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, status: 'todo' })
    await withReach(t)
    await countOrg(t, f.org.id)
    for (const p of [f.meta, f.sub]) {
      const rest = await t.query(internal.machine.rest.getProject, {
        callerId: pia.id,
        access: 'read',
        ref: p.key,
      })
      expect(rest).toEqual(await t.run((ctx) => oracleRead(ctx, pia, p, 'read')))
      expect(rest.completion).toEqual({ status: 'ok', done: 1, total: 1, percent: 100 })
    }
    // the lead of TBED reads both
    expect(
      (
        await t.query(internal.machine.rest.getProject, {
          callerId: f.user.id,
          access: 'read',
          ref: 'TBED',
        })
      ).completion,
    ).toEqual({ status: 'ok', done: 1, total: 3, percent: 33 })
    expect(
      await t
        .query(internal.machine.rest.getProject, { callerId: pia.id, access: 'read', ref: 'PCB' })
        .catch((e: ConvexError<Refusal>) => e.data),
    ).toEqual({ code: 'not_found', message: 'project not found' })
  })

  it('refuses a read and a PATCH whole where the level check stopped, and answers unavailable where the completion’s did', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    // SHR is shared with two of the teams of Pia and of the admin, so its
    // check asks two memberships, and the second cannot finish under the
    // lowered bounds; NAV Pia sees for navigation through NV1
    const shared = await meta(t, f.org.id, 'SHR')
    const nav = await meta(t, f.org.id, 'NAV')
    await grant(t, await sub(t, nav, 'NV1'), pia)
    await sub(t, nav, 'NV2')
    for (const name of ['Red', 'Blue'])
      await plantShares(t, await plantTeam(t, f.org.id, name, [pia, f.admin]), [shared])
    await withReach(t)
    await countOrg(t, f.org.id)
    const read = (me: Doc<'profiles'>, ref: string) =>
      t.query(internal.machine.rest.getProject, { callerId: me.id, access: 'read', ref })
    expect((await read(pia, 'NAV')).completion).toEqual(NO_TASKS)
    Object.assign(OWN_READS, { lookups: 0, members: 0 })
    expect(await sentence(read(pia, 'SHR'))).toBe(ACCESS_SENTENCE)
    expect(
      await sentence(
        t.query(internal.machine.projects.mcpGetProject, {
          callerId: pia.id,
          access: 'read',
          project: 'SHR',
        }),
      ),
    ).toBe(ACCESS_SENTENCE)
    // the admin manages SHR, so the PATCH applies, and its answer's level
    // check stops, which rolls the change back
    const patched = t.mutation(internal.machine.projects.restUpdateProject, {
      callerId: f.admin.id,
      access: 'write',
      ref: 'SHR',
      body: JSON.stringify({ description: 'Changed' }),
      keyName: null,
    })
    expect(await sentence(patched)).toBe(ACCESS_SENTENCE)
    expect((await t.run((ctx) => byId(ctx, 'projects', shared.id)))?.description).toBe('')
    Object.assign(OWN_READS, structuredClone(DEFAULTS.own))
    // a check of a sub-project that stops inside the completion of NAV,
    // which Pia sees only for navigation, answers unavailable
    const stopped = await t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', pia.id)) as Doc<'profiles'>
      const project = (await byId(ctx, 'projects', nav.id)) as Doc<'projects'>
      const access = accessOf(ctx, me, [project])
      const failing = {
        ...access,
        visible: async () => {
          throw accessUnchecked()
        },
      }
      return {
        ok: await projectCompletion(ctx, project, access),
        stopped: await projectCompletion(ctx, project, failing),
      }
    })
    expect(stopped).toEqual({ ok: NO_TASKS, stopped: UNAVAILABLE_COMPLETION })
    // a room too small for the sub-projects answers unavailable too
    Object.assign(COMPLETION_RESERVE, { ranges: 1_000_000 })
    expect((await read(pia, 'NAV')).completion).toEqual(UNAVAILABLE_COMPLETION)
  })

  it('answers the writes as the catalogue answered them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await countOrg(t, f.org.id)
    await withReach(t)
    const created = JSON.parse(
      await t.mutation(internal.machine.projects.mcpCreateProject, {
        callerId: f.user.id,
        access: 'write',
        name: 'Optics',
        parent: 'TBED',
      }),
    ) as { key: string; completion: CompletionJson }
    expect(created.completion).toEqual(NO_TASKS)
    for (const archived of [true, false]) {
      const answer = await t.mutation(internal.machine.projects.restUpdateProject, {
        callerId: f.user.id,
        access: 'write',
        ref: 'TBED',
        body: JSON.stringify({ archived }),
        keyName: null,
      })
      const stored = (await t.run((ctx) => byId(ctx, 'projects', f.meta.id))) as Doc<'projects'>
      expect(answer).toEqual(await t.run((ctx) => oracleRead(ctx, f.user, stored, 'write')))
    }
    const mcp = JSON.parse(
      await t.mutation(internal.machine.projects.mcpUpdateProject, {
        callerId: f.user.id,
        access: 'write',
        project: created.key,
        description: 'Lenses',
      }),
    )
    const optics = await t.run(async (ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org_key', (q) => q.eq('org_id', f.org.id).eq('key', created.key))
        .unique(),
    )
    expect(mcp).toEqual(
      await t.run((ctx) => oracleRead(ctx, f.user, optics as Doc<'projects'>, 'write')),
    )
  })

  it('resolves the project user routes without the catalogue, with their sentences', async () => {
    const t = newT()
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    await grant(t, f.sub, pia)
    await withReach(t)
    for (const ref of ['NOPE', 'PCB', f.otherProject.id]) {
      expect(
        await t
          .query(internal.machine.rest.listProjectUsers, { callerId: pia.id, access: 'read', ref })
          .catch((e: ConvexError<Refusal>) => e.data),
      ).toEqual({ code: 'not_found', message: 'project not found' })
      expect(
        await sentence(
          t.query(internal.machine.mcp.listProjectUsers, {
            callerId: pia.id,
            access: 'read',
            project: ref,
          }),
        ),
      ).toBe(`project "${ref}" not found (or not visible to you)`)
    }
    // the list walks the roster in name order, which every deployment keys
    await keyOrg(t, f.org.id)
    const { users } = await t.query(internal.machine.rest.listProjectUsers, {
      callerId: pia.id,
      access: 'read',
      ref: 'FW',
    })
    expect(users.map((r) => r.id)).toContain(pia.id)
  })
})

/* ------------------------------------------------------- the design size */

type PageReads = Read & { rows: number; next: boolean; bytes: number; mcpBytes: number }

/* Every page of one list for `me` from its start, each in its own
 * transaction with what it read, and the bytes of its answer on both
 * surfaces. */
async function measuredPages(t: T, me: Doc<'profiles'>, ask: Omit<ListAsk, 'cursor'>) {
  const pages: PageReads[] = []
  const rows: ProjectRow[] = []
  let cursor: string | null = null
  for (let n = 0; n < 100; n++) {
    const { out, read } = await measured(t, (ctx) =>
      projectPage(ctx, me, 'read', {
        archived: ask.archived === true,
        search: ask.search ?? '',
        limit: ask.limit ?? 50,
        cursor,
      }),
    )
    pages.push({
      ...read,
      rows: out.projects.length,
      next: out.next_cursor !== null,
      bytes: JSON.stringify(out).length,
      mcpBytes: pretty(out).length,
    })
    rows.push(...out.projects)
    if (out.next_cursor === null) return { pages, rows }
    cursor = out.next_cursor
  }
  throw new Error('the list did not end')
}

/* Prints a case's pages and checks that each stayed inside NAMED_READ. */
function logged(what: string, pages: PageReads[]) {
  console.log(
    `${what}: ${pages.length} pages; ${pages
      .map(
        (p) =>
          `${p.rows} rows ${p.ranges}r ${p.documents}d ${(p.bytes / 1024).toFixed(1)}/${(p.mcpBytes / 1024).toFixed(1)} KB`,
      )
      .join('; ')}`,
  )
  for (const p of pages) {
    expect(p.ranges).toBeLessThan(NAMED_READ.ranges + 64)
    expect(p.documents).toBeLessThan(NAMED_READ.documents + 64)
  }
}

/* The live and archived top-level projects and sub-projects of `orgId`,
 * counted whole, which a case at the catalogue's sum asserts before it
 * measures. */
const totals = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const all = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const count = (top: boolean, archived: boolean) =>
      all.filter(
        (p) => (p.parent_id === undefined) === top && (p.archived_at !== undefined) === archived,
      ).length
    return {
      live: count(true, false),
      archived: count(true, true),
      liveSubs: count(false, false),
      archivedSubs: count(false, true),
    }
  })

/* withOrg with Pia, an everyday person with grants on three top-level
 * projects of three sub-projects each, and with `big` the organization at
 * the catalogue's sum, the four figures together (200 and 300 top-level
 * projects, 500 and 1,000 sub-projects), the read the catalogue made
 * before. withOrg's TBED with FW and PCB and SKNK, and Pia's projects,
 * count towards those figures. Each is seeded once and shared by the cases
 * below, which leave it as they found it. */
const catalogueOrgs = new Map<boolean, ReturnType<typeof seedCatalogueOrg>>()
const catalogueOrg = (big: boolean) => {
  let made = catalogueOrgs.get(big)
  if (made === undefined) {
    made = seedCatalogueOrg(big)
    catalogueOrgs.set(big, made)
  }
  return made
}
async function seedCatalogueOrg(big: boolean) {
  const t = newT({ transactionLimits: true })
  const f = await withOrg(t)
  if (big) {
    // withOrg's 2 and Pia's 3 make 200 live top-level projects, and
    // withOrg's FW and PCB and Pia's 9 make 500 live sub-projects
    const live = await plantMetas(t, f.org.id, names('Live ', 195))
    const old = await plantMetas(t, f.org.id, names('Old ', 300), { archived_at: NOW })
    for (const p of live.slice(0, 163)) await plantSubs(t, p, names(`${p.name} sub `, 3))
    for (const p of old.slice(0, 250))
      await plantSubs(t, p, names(`${p.name} sub `, 4), { archived_at: NOW })
  }
  const pia = await person(t, f.org.id, 'Pia')
  const mine = await plantMetas(t, f.org.id, ['Mine A', 'Mine B', 'Mine C'])
  for (const p of mine) await plantSubs(t, p, names(`${p.name} sub `, 3))
  await plantGrants(t, pia, mine)
  await ready(t, f)
  expect(await totals(t, f.org.id)).toEqual(
    big
      ? { live: 200, archived: 300, liveSubs: 500, archivedSubs: 1000 }
      : { live: 5, archived: 0, liveSubs: 11, archivedSubs: 0 },
  )
  return { t, f, pia }
}

describe('reads at the design size', () => {
  /* Pia with grants on 200 top-level projects (withOrg's two and 198) and
   * the 200 live sub-projects she reads beneath 67 of them. */
  it('pages the active list at the sum of a person’s top-level projects and the sub-projects they read', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const tops = await plantMetas(t, f.org.id, names('Top ', 198))
    for (const p of tops.slice(0, 66)) await plantSubs(t, p, names(`${p.name} sub `, 3))
    await plantGrants(t, pia, [f.meta, f.hidden, ...tops])
    await ready(t, f)
    for (const limit of [50, 200]) {
      const { pages, rows } = await measuredPages(t, pia, { limit })
      expect(rows.length).toBe(400)
      logged(`case 1, limit ${limit}`, pages)
    }
    const none = await measuredPages(t, pia, { limit: 200, search: 'nothing' })
    expect(none.rows).toEqual([])
    logged('case 1, a search that matches nothing', none.pages)
  })

  it('pages 200 sub-projects through grants on them beneath 67 projects seen only for navigation', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 67))
    const subs: Doc<'projects'>[] = []
    for (const [i, p] of parents.entries())
      subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, i < 66 ? 3 : 2))))
    await plantGrants(t, pia, subs)
    await ready(t, f)
    const { pages, rows } = await measuredPages(t, pia, { limit: 200 })
    expect(rows.length).toBe(267)
    logged('case 2, limit 200', pages)
    const none = await measuredPages(t, pia, { limit: 200, search: 'nothing' })
    logged('case 2, a search that matches nothing', none.pages)
  })

  it('pages the archived list at its sum, inherited and through grants on the archived sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const ivo = await person(t, f.org.id, 'Ivo')
    const live = await plantMetas(t, f.org.id, names('Live ', 198))
    const archived = await plantMetas(t, f.org.id, names('Old ', 300), { archived_at: NOW })
    const subs: Doc<'projects'>[] = []
    // 250 archived sub-projects under live parents, 250 under archived ones
    for (const p of [...live.slice(0, 125), ...archived.slice(0, 125)])
      subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 2), { archived_at: NOW })))
    expect(subs.length).toBe(500)
    await plantGrants(t, pia, [f.meta, f.hidden, ...live, ...archived])
    await plantGrants(t, ivo, subs)
    await ready(t, f)
    const pages = await measuredPages(t, pia, { archived: true, limit: 200 })
    expect(pages.rows.length).toBe(800)
    logged('case 3, inherited, limit 200', pages.pages)
    logged(
      'case 3, inherited, a search that matches nothing',
      (await measuredPages(t, pia, { archived: true, limit: 200, search: 'nothing' })).pages,
    )
    const through = await measuredPages(t, ivo, { archived: true, limit: 200 })
    expect(through.rows.length).toBe(625)
    logged('case 3, through grants, limit 200', through.pages)
    logged(
      'case 3, through grants, a search that matches nothing',
      (await measuredPages(t, ivo, { archived: true, limit: 200, search: 'nothing' })).pages,
    )
  })

  it('pages a team sharing 50 live and 150 archived projects, and 5 teams each sharing 20 sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const live = await plantMetas(t, f.org.id, names('Live ', 50))
    const old = await plantMetas(t, f.org.id, names('Old ', 150), { archived_at: NOW })
    for (const p of live) await plantSubs(t, p, names(`${p.name} sub `, 3))
    for (const p of old) await plantSubs(t, p, names(`${p.name} sub `, 3), { archived_at: NOW })
    await plantShares(t, await plantTeam(t, f.org.id, 'Red', [pia]), [...live, ...old])
    const ivo = await person(t, f.org.id, 'Ivo')
    const parents = await plantMetas(t, f.org.id, names('Parent ', 34))
    const subs: Doc<'projects'>[] = []
    for (const p of parents) subs.push(...(await plantSubs(t, p, names(`${p.name} sub `, 3))))
    for (let i = 0; i < 5; i++)
      await plantShares(
        t,
        await plantTeam(t, f.org.id, `Team ${i}`, [ivo]),
        subs.slice(i * 20, i * 20 + 20),
      )
    await ready(t, f)
    for (const archived of [false, true]) {
      const { pages, rows } = await measuredPages(t, pia, { archived, limit: 200 })
      expect(rows.length).toBe(archived ? 600 : 200)
      logged(`case 4, one team, archived ${archived}`, pages)
    }
    const five = await measuredPages(t, ivo, { limit: 200 })
    expect(five.rows.length).toBe(100 + 34)
    logged('case 5, five teams', five.pages)
    logged(
      'case 5, a search that matches nothing',
      (await measuredPages(t, ivo, { limit: 200, search: 'nothing' })).pages,
    )
  })

  it('pages one project with 30 live and 40 archived sub-projects, at limit 1 into them and at 200', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const pia = await person(t, f.org.id, 'Pia')
    const [p] = await plantMetas(t, f.org.id, ['Wide'])
    await plantSubs(t, p, names('Live sub ', 30))
    await plantSubs(t, p, names('Old sub ', 40), { archived_at: NOW })
    await plantGrants(t, pia, [p])
    await ready(t, f)
    for (const archived of [false, true])
      for (const limit of [1, 200]) {
        const { pages, rows } = await measuredPages(t, pia, { archived, limit })
        expect(rows.length).toBe(archived ? 40 : 31)
        logged(
          `case 6, archived ${archived}, limit ${limit}`,
          limit === 1 ? pages.slice(0, 3) : pages,
        )
      }
  })

  it('reads the same for an everyday person whatever the organization holds', async () => {
    const reads = async (big: boolean) => {
      const { t, pia } = await catalogueOrg(big)
      const active = await measuredPages(t, pia, { limit: 50 })
      const archived = await measuredPages(t, pia, { archived: true, limit: 50 })
      expect(active.rows.length).toBe(12)
      return {
        active: active.pages.map((p) => [p.ranges, p.documents]),
        archived: archived.pages.map((p) => [p.ranges, p.documents]),
      }
    }
    const everyday = await reads(false)
    const sum = await reads(true)
    console.log(`case 7: everyday ${JSON.stringify(everyday)}, at the sum ${JSON.stringify(sum)}`)
    expect(sum).toEqual(everyday)
  })

  it('reads the same for the single read and an update that archives and restores, whatever the organization holds', async () => {
    const reads = async (big: boolean) => {
      const { t, f } = await catalogueOrg(big)
      await countOrg(t, f.org.id)
      // TBED's lead reads it and archives and restores it, with FW and PCB
      const single = await measured(t, async (ctx) => {
        const me = (await byId(ctx, 'profiles', f.user.id)) as Doc<'profiles'>
        const project = await managedProject(ctx, me, 'TBED')
        if (project === null) throw new Error('fixture')
        return await projectRead(ctx, me, project, 'read')
      })
      expect(single.out.completion).toMatchObject({ status: 'ok' })
      const updates: [number, number][] = []
      for (const archived of [true, false]) {
        const { out, read } = await measured(t, (ctx) =>
          (
            restUpdateProject as unknown as {
              _handler: (c: QueryCtx, a: unknown) => Promise<{ archived: boolean }>
            }
          )._handler(ctx, {
            callerId: f.user.id,
            access: 'write',
            ref: 'TBED',
            body: JSON.stringify({ archived }),
            keyName: null,
          }),
        )
        expect(out.archived).toBe(archived)
        updates.push([read.ranges, read.documents])
      }
      return { single: [single.read.ranges, single.read.documents], updates }
    }
    const everyday = await reads(false)
    const sum = await reads(true)
    console.log(
      `case 7, the single read and the update: everyday ${JSON.stringify(everyday)}, at the sum ${JSON.stringify(sum)}`,
    )
    expect(sum).toEqual(everyday)
  })

  it('reads one project’s access for the single read and an update that archives and restores it', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await plantSubs(t, f.meta, names('Live sub ', 28))
    await ready(t, f)
    await countOrg(t, f.org.id)
    const single = await measured(t, async (ctx) => {
      const me = (await byId(ctx, 'profiles', f.user.id)) as Doc<'profiles'>
      const project = await managedProject(ctx, me, 'TBED')
      if (project === null) throw new Error('fixture')
      return await projectRead(ctx, me, project, 'read')
    })
    const old = await measured(t, async (ctx) => {
      const me = (await byId(ctx, 'profiles', f.user.id)) as Doc<'profiles'>
      return await oracleRead(ctx, me, f.meta, 'read')
    })
    expect(single.out).toEqual(old.out)
    expect(single.out.completion).toMatchObject({ status: 'ok' })
    const updates: Read[] = []
    for (const archived of [true, false]) {
      const { out, read } = await measured(t, (ctx) =>
        (
          restUpdateProject as unknown as {
            _handler: (c: QueryCtx, a: unknown) => Promise<{ archived: boolean }>
          }
        )._handler(ctx, {
          callerId: f.user.id,
          access: 'write',
          ref: 'TBED',
          body: JSON.stringify({ archived }),
          keyName: null,
        }),
      )
      expect(out.archived).toBe(archived)
      updates.push(read)
    }
    console.log(
      `case 8: GET /v1/projects/{ref} ${JSON.stringify(single.read)}, the catalogue's ${JSON.stringify(old.read)}; PATCH archive ${JSON.stringify(updates[0])}, restore ${JSON.stringify(updates[1])}`,
    )
    expect(single.read.ranges).toBeLessThan(old.read.ranges + 40)
  })
})
