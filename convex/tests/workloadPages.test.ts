/* REST GET /v1/workload and MCP get_workload, a page of people at a time
 * (planning.ts workloadPage over lib/ownerLoads.ts):
 *
 *   1. Arguments: `limit`, `offset` and `person` on both surfaces, and their
 *      refusals, MCP's schema first.
 *   2. Cursors: one list for both surfaces, sealed to the organization, the
 *      caller, the project and the window.
 *   3. Order and paging: name key byte order with the id breaking ties,
 *      every person once at any limit, the end only at the end.
 *   4. Inactive people, idle ones left out and unavailable ones listed.
 *   5. The hours equal the organization-wide fence's (orgLoad.setup.ts
 *      fenceWorkload) for random organizations, every reader shape and a
 *      project or none.
 *   6. Past a bound a person is unavailable with null hours, never zeros.
 *   7. The call's room ends a staff page before the person it cannot hold.
 *   8. A guest's or Viewer's page holds one person, so hidden work never
 *      moves its pages.
 *   9. Readiness, access, and reads that follow the page and not the
 *      organization.
 *  10. Reads at the design size, one figure a case, recorded in
 *      workloadPage's docstring. */

import { compareValues } from 'convex/values'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { canSeeProject, isOrgStaff, OWN_READS } from '../lib/access'
import { byId } from '../lib/db'
import type { Refusal, RefusalCode } from '../lib/functions'
import { DEFAULT_PAGE_SIZE, LIMITS } from '../lib/limits'
import { CURSOR_REFUSAL, offsetRefusal } from '../lib/listCursor'
import { nameKey } from '../lib/nameKey'
import { OWNER_LOADS } from '../lib/ownerLoads'
import { sha256hex } from '../machine/auth'
import { PERSON_NO_CURSOR, restWorkload } from '../machine/records'
import { NAMES_NOT_READY } from '../machine/shared'
import type { WorkloadJson } from '../planning'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'
import { fenceWorkload } from './orgLoad.setup'
import { restPage as restTaskPage } from './taskPages.setup'

const DEFAULT_LOADS = structuredClone(OWNER_LOADS)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(OWNER_LOADS, structuredClone(DEFAULT_LOADS))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

/* --------------------------------------------------------------- fixture */

/** The request's UTC day, a Wednesday, and the Monday of its week. */
const TODAY = '2026-09-09'
const WEEK = '2026-09-07'

type Fx = OrgFixture & {
  t: T
  /** a sub-project of TBED that neither the guest nor the viewer can see */
  sib: Doc<'projects'>
  /** an archived sub-project of TBED */
  shelf: Doc<'projects'>
  /** a sub-project of SKNK, which only the admin and the user see */
  away: Doc<'projects'>
  /** a staff user who sees TBED and not SKNK */
  user2: Doc<'profiles'>
}

/* withOrg, with the agent holding User on TBED, a sub-project of TBED
 * hidden from the guest and the viewer, an archived sub-project of TBED, a
 * sub-project of SKNK and a second staff user who sees only TBED, every
 * profile keyed as on a deployment (nameKeys.setup.ts keyOrg). */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  const sib = await plantHiddenSibling(t, f, f.guest)
  await plantHiddenSibling(t, f, f.viewer)
  const shelf = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.meta.id,
    key: 'SHELF',
    archived_at: NOW,
  })
  const away = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.hidden.id,
    key: 'AWAY',
  })
  const user2 = await plantSeat(t, { org_id: f.org.id, name: 'User Two' })
  await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: f.meta.id, profile_id: user2.id, level: 'user' }),
  )
  await keyOrg(t, f.org.id)
  return { t, ...f, sib, shelf, away, user2 }
}

const task = (fx: Fx, over: Partial<Doc<'issues'>> = {}) =>
  plantIssue(fx.t, { org_id: fx.org.id, project_id: fx.sub.id, ...over })

/* Scheduled with remaining hours over two weeks of September 2026. */
const plan = (hours = 3, start = WEEK, end = '2026-09-14') => ({
  start_week: start,
  end_week: end,
  remaining_hours: hours,
  remaining_set_at: NOW,
})

/* Task numbers for plantMany, clear of the fixtures' own. */
let bulkNum = 50_000

/* An ordinary title of about 80 characters. */
const titleOf = (n: number) =>
  `Check the supplier quotes against the budget and update the plan, step ${n}`

/* `count` active tasks in `project_id` without a text copy, in one
 * transaction. */
const plantMany = (
  t: T,
  orgId: string,
  count: number,
  over: Partial<Doc<'issues'>> & { project_id: string },
) =>
  t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('issues', {
        id: uuid(),
        org_id: orgId,
        num: bulkNum++,
        title: titleOf(bulkNum),
        status: 'todo',
        priority: 'medium',
        paused: false,
        created_at: NOW,
        updated_at: NOW,
        ...over,
      })
    }
  })

/* People of organization `orgId`, one profile each, in one transaction,
 * with these names, ids and fields. The caller keys them (keyOrg). */
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
        ...p,
      })
      out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    return out
  })

/** One REST workload page for `caller`, with query parameters `q`. */
const restPage = (fx: Pick<Fx, 't'>, caller: Doc<'profiles'>, q: Record<string, string> = {}) =>
  fx.t.query(internal.machine.records.restWorkload, {
    callerId: caller.id,
    access: 'read',
    today: TODAY,
    ...q,
  })

/** One MCP get_workload page for `caller`, with arguments `a`. */
const mcpPage = async (
  fx: Pick<Fx, 't'>,
  caller: Doc<'profiles'>,
  a: Record<string, unknown> = {},
): Promise<WorkloadJson> =>
  JSON.parse(
    await fx.t.query(internal.machine.records.mcpWorkload, {
      callerId: caller.id,
      access: 'read',
      today: TODAY,
      ...a,
    }),
  )

/** Every page `read` answers from the first, following next_cursor until
 * it is null, and every person on them in order. */
async function everyPage(read: (cursor: string | null) => Promise<WorkloadJson>, most = 2000) {
  const pages: WorkloadJson[] = []
  let cursor: string | null = null
  for (let n = 0; n < most; n++) {
    const page = await read(cursor)
    pages.push(page)
    if (page.next_cursor === null) return { pages, people: pages.flatMap((p) => p.people) }
    cursor = page.next_cursor
  }
  throw new Error(`the pages did not end after ${most}`)
}

/** Every REST page for `caller` with `q`, at `limit`. */
const restPages = (fx: Pick<Fx, 't'>, caller: Doc<'profiles'>, q: Record<string, string> = {}) =>
  everyPage((cursor) => restPage(fx, caller, cursor === null ? q : { ...q, cursor }))

/** Every MCP page for `caller` with `a`. */
const mcpPages = (fx: Pick<Fx, 't'>, caller: Doc<'profiles'>, a: Record<string, unknown> = {}) =>
  everyPage((cursor) => mcpPage(fx, caller, cursor === null ? a : { ...a, cursor }))

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

/* The profiles of organization `orgId` in the order the workload lists
 * them, by name key and then id, as Convex orders values. */
const nameOrder = (t: T, orgId: string) =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect()
    const key = (p: Doc<'profiles'>) => [nameKey(p.name), p.id]
    return rows.sort((a, b) => compareValues(key(a), key(b)))
  })

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

/** One REST page for `caller` with `q`, with what it read. */
const measuredPage = (t: T, caller: Doc<'profiles'>, q: Record<string, string>) =>
  t.query((ctx) =>
    readsOf(ctx, () =>
      handlerOf<Record<string, string>, WorkloadJson>(restWorkload)(ctx, {
        callerId: caller.id,
        access: 'read',
        today: TODAY,
        ...q,
      }),
    ),
  )

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
      name: 'Workload key',
      key_prefix: key.slice(0, 11),
      key_hash,
      created_at: NOW,
    }),
  )
  return key
}

/* get_workload over MCP's modern leg with `key`, answering the tool's
 * text and whether it is an error result. */
async function mcpTool(t: T, key: string, args: Record<string, unknown>) {
  const res = await fetchPath(t, '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'get_workload',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_workload',
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

/* ------------------------------------------------------------ 1. arguments */

describe('the arguments', () => {
  it('pages 50 people by default and 1 to 200 on request, and refuses another limit', async () => {
    const fx = await setup()
    await plantPeople(
      fx.t,
      fx.org.id,
      Array.from({ length: 50 }, (_, i) => ({ name: `Person ${i}` })),
    )
    await keyOrg(fx.t, fx.org.id)
    const first = await restPage(fx, fx.admin)
    expect(first.people).toHaveLength(DEFAULT_PAGE_SIZE)
    expect(first.next_cursor).toEqual(expect.any(String))
    expect((await mcpPage(fx, fx.admin)).people).toHaveLength(DEFAULT_PAGE_SIZE)
    expect((await restPage(fx, fx.admin, { limit: '200' })).people).toHaveLength(56)
    expect((await restPage(fx, fx.admin, { limit: '1' })).people).toHaveLength(1)
    for (const limit of ['0', '201', '1.5', 'x', ''])
      await refused(restPage(fx, fx.admin, { limit }), 'rule', LIMITS.listWorkload.refusal)
    for (const limit of [0, 201, 1.5])
      await refused(mcpPage(fx, fx.admin, { limit }), 'rule', LIMITS.listWorkload.refusal)
    expect(LIMITS.listWorkload.refusal).toBe(
      'limit must be a whole number of people from 1 to 200.',
    )
  })

  it('takes an offset of 0 and refuses any other with the sentence that names the cursor', async () => {
    const fx = await setup()
    const offset = offsetRefusal('workload')
    expect(offset).toBe('offset does not apply to workload; pass next_cursor as cursor')
    for (const zero of ['0', '00'])
      expect((await restPage(fx, fx.admin, { offset: zero, limit: '1' })).people).toHaveLength(1)
    for (const other of ['5', '-1', 'x', ''])
      await refused(restPage(fx, fx.admin, { offset: other }), 'bad_request', offset)
    expect((await mcpPage(fx, fx.admin, { offset: 0, limit: 1 })).people).toHaveLength(1)
    await refused(mcpPage(fx, fx.admin, { offset: 3 }), 'bad_request', offset)
  })

  it('checks a whole number in MCP’s schema before the server, and the range on the server', async () => {
    const fx = await setup()
    const key = await agentKeyOf(fx.t, fx.agent)
    const schema = (field: string, issue: string) =>
      `Input validation error: Invalid arguments for tool get_workload: ${field}: ${issue}`
    expect(await mcpTool(fx.t, key, { limit: 1.5 })).toEqual({
      isError: true,
      text: schema('limit', 'Invalid input: expected int, received number'),
    })
    expect(await mcpTool(fx.t, key, { limit: 'x' })).toEqual({
      isError: true,
      text: schema('limit', 'Invalid input: expected number, received string'),
    })
    expect(await mcpTool(fx.t, key, { offset: 1.5 })).toEqual({
      isError: true,
      text: schema('offset', 'Invalid input: expected int, received number'),
    })
    for (const [args, sentence] of [
      [{ limit: 0 }, LIMITS.listWorkload.refusal],
      [{ limit: 201 }, LIMITS.listWorkload.refusal],
      [{ offset: 3 }, offsetRefusal('workload')],
    ] as const) {
      const out = await mcpTool(fx.t, key, args)
      expect(out.isError, JSON.stringify(args)).toBe(true)
      expect(out.text, JSON.stringify(args)).toContain(sentence)
    }
    const page = await mcpTool(fx.t, key, { limit: 2, from_week: WEEK })
    expect(page.isError).toBe(false)
    const answer = JSON.parse(page.text) as WorkloadJson
    // the cursor first, so a truncated result still shows it
    expect(Object.keys(answer)).toEqual([
      'next_cursor',
      'week_starts',
      'project',
      'hidden',
      'people',
    ])
    expect(answer.people).toHaveLength(2)
  })

  it('answers one person with `person`, inactive or idle, alone and without a cursor', async () => {
    const fx = await setup()
    const [gone] = await plantPeople(fx.t, fx.org.id, [{ name: 'Gone', active: false }])
    await keyOrg(fx.t, fx.org.id)
    await task(fx, { assignee_id: fx.user.id, ...plan(6) })
    await task(fx, { project_id: fx.away.id, assignee_id: fx.user.id, ...plan(4) })
    const one = await restPage(fx, fx.admin, { person: fx.user.id, from_week: WEEK, weeks: '2' })
    expect(one.next_cursor).toBeNull()
    expect(one.people).toEqual([
      expect.objectContaining({
        id: fx.user.id,
        status: 'ok',
        hours: [5, 5],
        hidden_hours: [0, 0],
      }),
    ])
    // the id in any case, on MCP the same
    expect(
      await mcpPage(fx, fx.admin, { person: fx.user.id.toUpperCase(), from_week: WEEK, weeks: 2 }),
    ).toEqual(one)
    // with `project`, that project's work alone
    const fw = await restPage(fx, fx.admin, { person: fx.user.id, project: 'FW', weeks: '1' })
    expect(fw.people).toEqual([expect.objectContaining({ hours: [3], hidden_hours: [0] })])
    // an inactive person without hours is answered when asked for
    const idle = await restPage(fx, fx.admin, { person: gone?.id ?? '' })
    expect(idle.people).toEqual([
      expect.objectContaining({
        id: gone?.id,
        active: false,
        status: 'ok',
        hours: Array(8).fill(0),
      }),
    ])
    // limit and offset are not read with person, and a cursor is refused
    expect(
      (await restPage(fx, fx.admin, { person: fx.user.id, limit: '0', offset: '5' })).people,
    ).toHaveLength(1)
    const page = await restPage(fx, fx.admin, { limit: '1' })
    const cursor = page.next_cursor ?? ''
    await refused(
      restPage(fx, fx.admin, { person: fx.user.id, cursor }),
      'bad_request',
      PERSON_NO_CURSOR,
    )
    await refused(
      mcpPage(fx, fx.admin, { person: fx.user.id, cursor }),
      'bad_request',
      PERSON_NO_CURSOR,
    )
    // an unknown id, a ref that is no id and another organization's person
    for (const ref of [uuid(), 'nobody', fx.otherAdmin.id]) {
      await refused(restPage(fx, fx.admin, { person: ref }), 'not_found', 'person not found')
      await refused(
        mcpPage(fx, fx.admin, { person: ref }),
        'not_found',
        `person "${ref}" not found`,
      )
    }
  })
})

/* -------------------------------------------------------------- 2. cursors */

describe('the cursor', () => {
  it('continues on the other surface and opens only for its organization, caller, project and window', async () => {
    const fx = await setup()
    const [first, second, third] = await nameOrder(fx.t, fx.org.id)
    const q = { limit: '1', from_week: WEEK, weeks: '2' }
    const one = await restPage(fx, fx.admin, q)
    expect(one.people.map((p) => p.id)).toEqual([first?.id])
    const cursor = one.next_cursor ?? ''
    expect(cursor).not.toBe('')
    // MCP takes REST's cursor, and the limit may change between pages
    const two = await mcpPage(fx, fx.admin, { limit: 2, from_week: WEEK, weeks: 2, cursor })
    expect(two.people.map((p) => p.id)).toEqual([second?.id, third?.id])
    expect(
      (await restPage(fx, fx.admin, { ...q, cursor: two.next_cursor ?? '' })).people.map(
        (p) => p.id,
      ),
    ).toHaveLength(1)
    // another day of the same week is the same window, and so is today's
    // week with from_week left out
    expect(
      (await restPage(fx, fx.admin, { ...q, from_week: '2026-09-11', cursor })).people,
    ).toEqual(two.people.slice(0, 1))
    expect(
      (await restPage(fx, fx.admin, { limit: '1', weeks: '2', cursor })).people.map((p) => p.id),
    ).toEqual([second?.id])
    // another caller, project, first week or number of weeks starts another list
    for (const [caller, other] of [
      [fx.user, q],
      [fx.admin, { ...q, project: 'TBED' }],
      [fx.admin, { ...q, from_week: '2026-09-14' }],
      [fx.admin, { ...q, weeks: '3' }],
      // the default of eight weeks
      [fx.admin, { limit: '1', from_week: WEEK }],
    ] as const)
      await refused(restPage(fx, caller, { ...other, cursor }), 'bad_request', CURSOR_REFUSAL)
    await refused(
      mcpPage(fx, fx.user, { limit: 1, from_week: WEEK, weeks: 2, cursor }),
      'bad_request',
      CURSOR_REFUSAL,
    )
    // a changed cursor
    const changed = `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`
    await refused(restPage(fx, fx.admin, { ...q, cursor: changed }), 'bad_request', CURSOR_REFUSAL)
    // a cursor of the REST active task list
    await task(fx, {})
    await task(fx, {})
    const tasks = await restTaskPage(fx.t, { callerId: fx.admin.id, access: 'read', limit: '1' })
    expect(tasks.next_cursor).toEqual(expect.any(String))
    await refused(
      restPage(fx, fx.admin, { ...q, cursor: tasks.next_cursor ?? '' }),
      'bad_request',
      CURSOR_REFUSAL,
    )
    // a cursor of another organization's list
    await plantPeople(fx.t, fx.otherOrg.id, [{ name: 'Elsewhere one' }, { name: 'Elsewhere two' }])
    await keyOrg(fx.t, fx.otherOrg.id)
    const elsewhere = await restPage(fx, fx.otherAdmin, q)
    expect(elsewhere.next_cursor).toEqual(expect.any(String))
    await refused(
      restPage(fx, fx.admin, { ...q, cursor: elsewhere.next_cursor ?? '' }),
      'bad_request',
      CURSOR_REFUSAL,
    )
  })
})

/* ------------------------------------------------------- 3. order and paging */

describe('the order', () => {
  it('lists every person once, by name key bytes and then id, at any limit, and ends only at the end', async () => {
    const fx = await setup()
    const low = '00000000-0000-4000-8000-000000000000'
    const high = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
    // one name twice, a name with an accented capital beside its plain
    // lowercase form, which one key ties and the ids order, and a
    // character past U+FFFF beside one in U+E000 to U+FFFF
    await plantPeople(fx.t, fx.org.id, [
      { name: 'Sam Lee' },
      { name: 'Sam Lee' },
      { name: 'zoe', id: high },
      { name: 'Zoë', id: low },
      { name: '\u{1F600} Smile' },
      { name: ' Private' },
      { name: 'Émile' },
    ])
    await keyOrg(fx.t, fx.org.id)
    const order = (await nameOrder(fx.t, fx.org.id)).map((p) => p.id)
    expect(order.length).toBeGreaterThanOrEqual(12)
    const rows = await fx.t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
        .collect(),
    )
    const byLocale = [...rows]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((p) => p.id)
    // the roster tells the two orders apart
    expect(order).not.toEqual(byLocale)
    expect(order.indexOf(low)).toBeLessThan(order.indexOf(high))
    for (const limit of [1, 2, 5, 200]) {
      const { pages, people } = await restPages(fx, fx.admin, { limit: String(limit), weeks: '1' })
      expect(
        people.map((p) => p.id),
        `limit ${limit}`,
      ).toEqual(order)
      expect(pages.every((p) => p.people.length <= limit)).toBe(true)
      expect(pages.slice(0, -1).every((p) => p.next_cursor !== null)).toBe(true)
      expect(pages.length).toBe(Math.ceil(order.length / limit))
    }
    expect((await mcpPages(fx, fx.admin, { limit: 2, weeks: 1 })).people.map((p) => p.id)).toEqual(
      order,
    )
  })

  it('places a person renamed between pages where the new name puts them', async () => {
    const fx = await setup()
    const [a, b, c, d] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Aa first' },
      { name: 'Ab second' },
      { name: 'Zy last' },
      { name: 'Zz very last' },
    ])
    await keyOrg(fx.t, fx.org.id)
    const rename = (p: Doc<'profiles'> | undefined, name: string) =>
      fx.t.run(async (ctx) => {
        if (p !== undefined) await ctx.db.patch(p._id, { name, name_key: nameKey(name) })
      })
    const first = await restPage(fx, fx.admin, { limit: '2', weeks: '1' })
    expect(first.people.map((p) => p.id)).toEqual([a?.id, b?.id])
    // the second, read already, now sorts last; the last now sorts first
    await rename(b, 'Zzz renamed')
    await rename(d, 'Aaa renamed')
    const rest = await everyPage((cursor) =>
      restPage(fx, fx.admin, { limit: '2', weeks: '1', cursor: cursor ?? first.next_cursor ?? '' }),
    )
    const ids = rest.people.map((p) => p.id)
    expect(ids).not.toContain(d?.id)
    expect(ids.at(-1)).toBe(b?.id)
    expect(ids).toContain(c?.id)
  })
})

/* ------------------------------------------------------ 4. inactive people */

describe('inactive people', () => {
  it('lists one with hours in the window or unavailable, and leaves one without hours out', async () => {
    const fx = await setup()
    const [idle, busy, later] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Aaron idle', active: false },
      { name: 'Bea busy', active: false },
      { name: 'Cy later', active: false },
    ])
    await keyOrg(fx.t, fx.org.id)
    await task(fx, { assignee_id: busy?.id, ...plan(4) })
    await task(fx, { assignee_id: later?.id, ...plan(4, '2026-12-07', '2026-12-07') })
    // Backlog and unscheduled work of the idle person, no load
    await task(fx, { assignee_id: idle?.id, status: 'backlog' })
    await task(fx, { assignee_id: idle?.id })
    const q = { from_week: WEEK, weeks: '2' }
    const all = (await restPages(fx, fx.admin, q)).people
    const ids = all.map((p) => p.id)
    expect(ids).toContain(busy?.id)
    expect(ids).not.toContain(idle?.id)
    expect(ids).not.toContain(later?.id)
    expect(all.find((p) => p.id === busy?.id)).toMatchObject({ active: false, hours: [2, 2] })
    // the idle person sorts first. A staff page of one goes on to the next
    // person to list, and a Viewer's page, which reads one person, lists
    // nobody and goes on
    const [first, next] = await nameOrder(fx.t, fx.org.id)
    expect(first?.id).toBe(idle?.id)
    const one = await restPage(fx, fx.admin, { ...q, limit: '1' })
    expect(one.people.map((p) => p.id)).toEqual([next?.id])
    expect(one.next_cursor).toEqual(expect.any(String))
    const empty = await restPage(fx, fx.viewer, { ...q, limit: '1' })
    expect(empty.people).toEqual([])
    expect(empty.next_cursor).toEqual(expect.any(String))
    expect(
      (await restPage(fx, fx.viewer, { ...q, cursor: empty.next_cursor ?? '' })).people.map(
        (p) => p.id,
      ),
    ).toEqual([next?.id])
    // past the open-task bound the idle person's hours are not known, so
    // the page lists them, and everyone else as before
    Object.assign(OWNER_LOADS, { open: 1 })
    const bounded = (await restPages(fx, fx.admin, q)).people
    expect(bounded.find((p) => p.id === idle?.id)).toEqual(
      expect.objectContaining({
        active: false,
        status: 'unavailable',
        hours: null,
        hidden_hours: null,
      }),
    )
    expect(bounded.filter((p) => p.id !== idle?.id)).toEqual(all)
  })
})

/* ---------------------------------------------------------- 5. the hours */

describe('the hours', () => {
  it('equal the organization-wide fence’s for random organizations, every reader and a project or none', async () => {
    const people = ['user', 'user2', 'guest', 'viewer', 'agent', 'admin'] as const
    const projects = ['sub', 'sub2', 'sib', 'away', 'shelf'] as const
    const spec = fc.array(
      fc.record({
        owner: fc.constantFrom(...people, null),
        reviewer: fc.constantFrom(...people, null),
        project: fc.constantFrom(...projects),
        status: fc.constantFrom('backlog', 'todo', 'progress', 'review', 'done'),
        paused: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
        start: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null, freq: 4 }),
        length: fc.integer({ min: 0, max: 3 }),
        hours: fc.option(fc.constantFrom(0, 2, 5, 13), { nil: null, freq: 6 }),
        measured: fc.boolean(),
        parent: fc.option(fc.nat(), { nil: null, freq: 2 }),
        archived: fc.integer({ min: 0, max: 6 }).map((n) => n === 0),
      }),
      { minLength: 2, maxLength: 14 },
    )
    await fc.assert(
      fc.asyncProperty(spec, async (tasks) => {
        const fx = await setup()
        const who = {
          user: fx.user,
          user2: fx.user2,
          guest: fx.guest,
          viewer: fx.viewer,
          agent: fx.agent,
          admin: fx.admin,
        }
        const where = { sub: fx.sub, sub2: fx.sub2, sib: fx.sib, away: fx.away, shelf: fx.shelf }
        const planted: Doc<'issues'>[] = []
        for (const s of tasks) {
          const parent =
            s.parent === null || planted.length === 0
              ? undefined
              : planted[s.parent % planted.length]
          const over: Partial<Doc<'issues'>> = {
            project_id: where[s.project].id,
            status: s.status,
            paused: s.paused && s.status !== 'done' && s.status !== 'backlog',
          }
          if (s.owner !== null) over.assignee_id = who[s.owner].id
          if (s.reviewer !== null) over.reviewer_id = who[s.reviewer].id
          if (s.start !== null) {
            const week = (n: number) =>
              new Date(Date.parse(`${WEEK}T00:00:00.000Z`) + n * 7 * 86_400_000)
                .toISOString()
                .slice(0, 10)
            over.start_week = week(s.start)
            over.end_week = week(s.start + s.length)
          }
          if (s.hours !== null) {
            over.remaining_hours = s.hours
            over.remaining_set_at = s.measured ? '2026-09-15T09:00:00.000Z' : NOW
          }
          if (parent !== undefined) over.parent_id = parent.id
          // an archived task's subtasks are archived with it
          if (s.archived || parent?.archived_at !== undefined) over.archived_at = NOW
          planted.push(await task(fx, over))
        }
        for (const reader of [fx.admin, fx.user2, fx.viewer, fx.guest]) {
          for (const project of [null, fx.meta, fx.sub]) {
            const label = `${reader.name}, ${project?.key ?? 'every project'}`
            const q: Record<string, string> = { from_week: WEEK, weeks: '6' }
            if (project !== null) q.project = project.key
            const fence = await fx.t.run(async (ctx) => {
              const me = (await byId(ctx, 'profiles', reader.id)) as Doc<'profiles'>
              if (project !== null && !(await canSeeProject(ctx, me, project))) return null
              const out = await fenceWorkload(ctx, me, { fromDay: WEEK, weeks: 6, project })
              // a query answers Convex values, so the oracle's maps go as lists
              return { listed: [...out.listed].sort(), people: [...out.people.entries()] }
            })
            if (fence === null) {
              await refused(restPage(fx, reader, q), 'not_found', 'project not found')
              continue
            }
            const { pages, people: listed } = await restPages(fx, reader, q)
            expect(
              pages.every((p) => p.hidden === (isOrgStaff(reader) ? 'counted' : 'own_only')),
            ).toBe(true)
            if (!isOrgStaff(reader))
              expect(
                pages.every((p) => p.people.length <= 1),
                label,
              ).toBe(true)
            expect(listed.map((p) => p.id).sort(), label).toEqual(fence.listed)
            const oracle = new Map(fence.people)
            for (const person of listed) {
              if (person.status !== 'ok') throw new Error(`${person.name} is ${person.status}`)
              expect(
                { hours: person.hours, hidden_hours: person.hidden_hours },
                `${person.name} for ${label}`,
              ).toEqual(oracle.get(person.id))
            }
          }
        }
      }),
      { numRuns: 12 },
    )
  }, 60_000)
})

/* ------------------------------------------------------------ 6. bounds */

describe('past a bound', () => {
  it('answers that person unavailable with null hours while the others stay ok', async () => {
    const fx = await setup()
    const third = await plantProject(fx.t, {
      org_id: fx.org.id,
      type: 'project',
      parent_id: fx.meta.id,
    })
    await keyOrg(fx.t, fx.org.id)
    // the user has four planned tasks over three live projects and one
    // more in Backlog, and the guest one planned task
    for (const p of [fx.sub, fx.sub2, third, fx.sub])
      await task(fx, { project_id: p.id, assignee_id: fx.user.id, ...plan(2) })
    await task(fx, { assignee_id: fx.user.id, status: 'backlog' })
    await task(fx, { assignee_id: fx.guest.id, ...plan(4) })
    const q = { from_week: WEEK, weeks: '2' }
    const at = async () => {
      const people = (await restPages(fx, fx.admin, q)).people
      return {
        user: people.find((p) => p.id === fx.user.id),
        guest: people.find((p) => p.id === fx.guest.id),
      }
    }
    const before = await at()
    expect(before.user).toMatchObject({ status: 'ok', hours: [4, 4] })
    expect(before.guest).toMatchObject({ status: 'ok', hours: [2, 2] })
    const unavailable = { status: 'unavailable', hours: null, hidden_hours: null }
    for (const bound of [{ open: 4 }, { checks: 3 }, { projects: 2 }]) {
      Object.assign(OWNER_LOADS, structuredClone(DEFAULT_LOADS), bound)
      const after = await at()
      expect(after.user, JSON.stringify(bound)).toMatchObject(unavailable)
      expect(after.guest, JSON.stringify(bound)).toEqual(before.guest)
    }
    // at each bound itself the user is read
    for (const bound of [{ open: 5 }, { checks: 4 }, { projects: 3 }]) {
      Object.assign(OWNER_LOADS, structuredClone(DEFAULT_LOADS), bound)
      expect((await at()).user, JSON.stringify(bound)).toEqual(before.user)
    }
  })

  it('answers a person unavailable where a bound stopped a check of the caller’s own access', async () => {
    const fx = await setup()
    // a task stored under SKNK itself, which the guest asks about for
    // navigation, past the parent's sub-projects it may read
    await task(fx, { project_id: fx.hidden.id, assignee_id: fx.guest.id, ...plan(2) })
    await task(fx, { assignee_id: fx.guest.id, ...plan(3) })
    const own = () => restPage(fx, fx.guest, { person: fx.guest.id, from_week: WEEK, weeks: '1' })
    expect((await own()).people[0]).toMatchObject({ status: 'ok' })
    Object.assign(OWN_READS, { subProjects: 0 })
    expect((await own()).people).toEqual([
      expect.objectContaining({ id: fx.guest.id, status: 'unavailable', hours: null }),
    ])
  })
})

/* ------------------------------------------------------------- 7. the room */

describe('the call’s room', () => {
  it('ends a staff page before the person it cannot hold, who opens the next page with their own hours', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 30, {
      project_id: fx.sub.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    await plantMany(fx.t, fx.org.id, 30, {
      project_id: fx.sub2.id,
      assignee_id: fx.guest.id,
      ...plan(1),
    })
    const q = { from_week: WEEK, weeks: '2' }
    const whole = await restPages(fx, fx.admin, q)
    expect(whole.pages).toHaveLength(1)
    expect(whole.people.every((p) => p.status === 'ok')).toBe(true)
    const order = whole.people.map((p) => p.id)
    let cut = false
    let unread = false
    let opened = false
    const sizes = [8, ...Array.from({ length: 14 }, (_, i) => 140 + 20 * i)]
    for (const documents of sizes) {
      Object.assign(OWNER_LOADS, { call: { ...DEFAULT_LOADS.call, documents } })
      const { pages, people } = await restPages(fx, fx.admin, q)
      // nobody skipped, nobody twice
      expect(
        people.map((p) => p.id),
        `${documents} documents`,
      ).toEqual(order)
      if (pages.length > 1) cut = true
      for (const page of pages) {
        for (const [i, person] of page.people.entries()) {
          // a later page that opens with a person whose work did not fit
          // beside the people before them
          if (i === 0 && page !== pages[0] && person.status === 'ok' && person.hours[0] > 0)
            opened = true
          if (person.status === 'ok') {
            // the hours a person gets alone, never fewer
            expect(person, `${documents} documents`).toEqual(
              whole.people.find((p) => p.id === person.id),
            )
          } else {
            // only the first person of a page, who did not fit alone
            expect(i, `${documents} documents`).toBe(0)
            expect(person).toMatchObject({ hours: null, hidden_hours: null })
            unread = true
          }
        }
      }
    }
    // the bounds cut pages, a person cut off opened the next page with
    // their hours, and at the smallest a person did not fit alone
    expect(cut).toBe(true)
    expect(opened).toBe(true)
    expect(unread).toBe(true)
  })
})

/* -------------------------------------------------- 8. guests and Viewers */

describe('a guest’s or Viewer’s page', () => {
  it('reads one person, so their pages and where they end never follow hidden work', async () => {
    const fx = await setup()
    await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await task(fx, { assignee_id: fx.admin.id, ...plan(2) })
    // the guest's own work in the sibling they cannot see
    await task(fx, { project_id: fx.sib.id, assignee_id: fx.guest.id, ...plan(4) })
    const q = { from_week: WEEK, weeks: '2' }
    const shape = async (reader: Doc<'profiles'>) =>
      (await restPages(fx, reader, q)).pages.map((p) => ({
        hidden: p.hidden,
        people: p.people,
        more: p.next_cursor !== null,
      }))
    const before = { guest: await shape(fx.guest), viewer: await shape(fx.viewer) }
    for (const pages of Object.values(before)) {
      expect(pages.every((p) => p.people.length === 1 && p.hidden === 'own_only')).toBe(true)
      expect(pages.map((p) => p.more)).toEqual([...pages.slice(1).map(() => true), false])
    }
    // another person's hidden work never shows, so the user's sibling work
    // below reaches staff only
    const user = (pages: typeof before.guest) =>
      pages.flatMap((p) => p.people).find((p) => p.id === fx.user.id)
    expect(user(before.guest)).toMatchObject({ hours: [1.5, 1.5], hidden_hours: [0, 0] })
    // and the guest's own hidden work counts, unnamed
    const own = before.guest.flatMap((p) => p.people).find((p) => p.id === fx.guest.id)
    expect(own).toMatchObject({ hours: [2, 2], hidden_hours: [2, 2] })
    // much hidden open work for the first person and the user
    const [first] = await nameOrder(fx.t, fx.org.id)
    await plantMany(fx.t, fx.org.id, 40, {
      project_id: fx.sib.id,
      assignee_id: first?.id,
      ...plan(1),
    })
    await plantMany(fx.t, fx.org.id, 20, {
      project_id: fx.sib.id,
      assignee_id: first?.id,
      status: 'backlog',
    })
    await plantMany(fx.t, fx.org.id, 40, {
      project_id: fx.sib.id,
      assignee_id: fx.user.id,
      ...plan(1),
    })
    expect({ guest: await shape(fx.guest), viewer: await shape(fx.viewer) }).toEqual(before)
    // staff keep every person the room holds on a page, with that work
    const staff = await restPages(fx, fx.admin, q)
    expect(staff.pages).toHaveLength(1)
    expect(staff.pages[0]?.hidden).toBe('counted')
    expect(staff.people.find((p) => p.id === fx.user.id)).toMatchObject({
      hours: [21.5, 21.5],
      hidden_hours: [0, 0],
    })
  })
})

/* ------------------------------------- 9. readiness, access and the reads */

describe('readiness and access', () => {
  it('refuses a page until the organization’s names are ready, on both surfaces', async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      const ready = await ctx.db
        .query('org_ready')
        .withIndex('by_org', (q) => q.eq('org_id', fx.org.id))
        .unique()
      if (ready !== null) await ctx.db.patch(ready._id, { name_keys_at: undefined })
    })
    await refused(restPage(fx, fx.admin), 'rule', NAMES_NOT_READY)
    await refused(mcpPage(fx, fx.admin), 'rule', NAMES_NOT_READY)
    // one person reads no name index
    expect((await restPage(fx, fx.admin, { person: fx.user.id })).people).toHaveLength(1)
    await keyOrg(fx.t, fx.org.id)
    expect((await restPage(fx, fx.admin)).people.length).toBeGreaterThan(1)
  })

  it('answers a hidden project like an unknown one, also for a cursor taken before, and refuses a removed seat', async () => {
    const fx = await setup()
    await refused(restPage(fx, fx.user2, { project: 'SKNK' }), 'not_found', 'project not found')
    await refused(
      mcpPage(fx, fx.user2, { project: 'SKNK' }),
      'not_found',
      'project "SKNK" not found (or not visible to you)',
    )
    const q = { project: 'TBED', limit: '1' }
    const first = await restPage(fx, fx.user2, q)
    expect(first.next_cursor).toEqual(expect.any(String))
    await fx.t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (r) =>
          r.eq('project_id', fx.meta.id).eq('profile_id', fx.user2.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
    })
    await refused(
      restPage(fx, fx.user2, { ...q, cursor: first.next_cursor ?? '' }),
      'not_found',
      'project not found',
    )
    await fx.t.run((ctx) => ctx.db.delete(fx.user2._id))
    await expectRefusal(restPage(fx, fx.user2), 'forbidden', /unknown agent key/)
  })

  it('reads the same for a page however many tasks and projects people off it hold', async () => {
    const fx = await setup()
    const later = await plantPeople(fx.t, fx.org.id, [{ name: 'Zz one' }, { name: 'Zz two' }])
    await keyOrg(fx.t, fx.org.id)
    await task(fx, { assignee_id: fx.user.id, ...plan(3) })
    await task(fx, { project_id: fx.away.id, assignee_id: fx.admin.id, ...plan(2) })
    const order = await nameOrder(fx.t, fx.org.id)
    const q = { limit: '5', from_week: WEEK, weeks: '2' }
    const measure = async () => {
      const read = await measuredPage(fx.t, fx.admin, q)
      expect(read.out.people.map((p) => p.id)).toEqual(order.slice(0, 5).map((p) => p.id))
      expect(read.out.next_cursor).toEqual(expect.any(String))
      return read
    }
    const before = await measure()
    expect(later.every((p) => order.slice(5).some((o) => o.id === p.id))).toBe(true)
    // 40 more projects, and 300 tasks of the people off the page and of nobody
    const tops: Doc<'projects'>[] = []
    for (let i = 0; i < 20; i++) {
      const top = await plantProject(fx.t, { org_id: fx.org.id })
      tops.push(top)
      tops.push(await plantProject(fx.t, { org_id: fx.org.id, type: 'project', parent_id: top.id }))
    }
    for (const [i, person] of later.entries())
      await plantMany(fx.t, fx.org.id, 100, {
        project_id: (tops[2 * i + 1] as Doc<'projects'>).id,
        assignee_id: person.id,
        ...plan(1),
      })
    await plantMany(fx.t, fx.org.id, 100, { project_id: fx.sub.id })
    expect(await measure()).toEqual(before)
  })
})

/* --------------------------------------------------- 10. the design size */

/* A page's reads, logged as the design size cases measure them. */
type Measured = { ranges: number; documents: number; bytes: number; people: number }

/* Pages `caller`'s workload to its end with `q`, each page measured, and
 * logs the heaviest page's reads, the number of pages and the fewest and
 * most people a page held, under `name`. Every page stays inside Convex's
 * limits for one request and every person is `ok`. */
async function measurePages(
  t: T,
  caller: Doc<'profiles'>,
  q: Record<string, string>,
  name: string,
) {
  const reads: Measured[] = []
  const people: WorkloadJson['people'] = []
  let cursor: string | null = null
  for (let n = 0; n < 1000; n++) {
    const read = await measuredPage(t, caller, cursor === null ? q : { ...q, cursor })
    reads.push({
      ranges: read.ranges,
      documents: read.documents,
      bytes: read.bytes,
      people: read.out.people.length,
    })
    people.push(...read.out.people)
    cursor = read.out.next_cursor
    if (cursor === null) break
  }
  const most = (key: keyof Measured) => Math.max(...reads.map((r) => r[key]))
  const held = reads.slice(0, -1).map((r) => r.people)
  console.log(
    `[workload at the design size] ${name}: ${reads.length} pages, ${people.length} people, ` +
      `heaviest page ${most('ranges')} ranges, ${most('documents')} documents, ` +
      `${(most('bytes') / 1e6).toFixed(2)} MB; a page held ${Math.min(...(held.length > 0 ? held : [reads[0]?.people ?? 0]))} ` +
      `to ${most('people')} people`,
  )
  for (const read of reads) {
    expect(read.ranges).toBeLessThan(4096)
    expect(read.documents).toBeLessThan(32_000)
    expect(read.bytes).toBeLessThan(16 * 1024 * 1024)
  }
  expect(people.filter((p) => p.status !== 'ok')).toEqual([])
  return { reads, people }
}

/* `count` sub-projects, `per` under each of as many top-level projects as
 * that takes, in one transaction. */
const plantFamilies = (t: T, orgId: string, count: number, per = 3) =>
  t.run(async (ctx) => {
    const subs: Doc<'projects'>[] = []
    let top: Doc<'projects'> | null = null
    for (let i = 0; i < count; i++) {
      if (i % per === 0) {
        const id = uuid()
        const _id = await ctx.db.insert('projects', {
          id,
          org_id: orgId,
          type: 'meta',
          key: `T${bulkNum}`,
          name: `Programme ${bulkNum++}`,
          description: '',
          sort_order: i,
          num: bulkNum++,
          track_delay: false,
          created_at: NOW,
        })
        top = (await ctx.db.get(_id)) as Doc<'projects'>
      }
      const _id = await ctx.db.insert('projects', {
        id: uuid(),
        org_id: orgId,
        type: 'project',
        parent_id: top?.id,
        key: `S${bulkNum}`,
        name: `Workstream ${bulkNum++}`,
        description: '',
        sort_order: i,
        num: bulkNum++,
        track_delay: false,
        created_at: NOW,
      })
      subs.push((await ctx.db.get(_id)) as Doc<'projects'>)
    }
    return subs
  })

/* Planned tasks over the asked year, `count` of them for each person, in
 * blocks of `block` a sub-project, each block in the next of `subs`, in one
 * transaction. */
const plantPlans = (
  t: T,
  orgId: string,
  people: readonly Doc<'profiles'>[],
  subs: readonly Doc<'projects'>[],
  count: number,
  block: number,
) =>
  t.run(async (ctx) => {
    let at = 0
    for (const person of people) {
      for (let i = 0; i < count; i++) {
        if (i > 0 && i % block === 0) at++
        const sub = subs[at % subs.length] as Doc<'projects'>
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: orgId,
          project_id: sub.id,
          num: bulkNum++,
          title: titleOf(bulkNum),
          status: i % 3 === 0 ? 'progress' : 'todo',
          priority: 'medium',
          assignee_id: person.id,
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          start_week: WEEK,
          end_week: '2027-08-30',
          remaining_hours: 40,
          remaining_set_at: NOW,
        })
      }
      at++
    }
  })

/* A staff caller whose access to the top-level projects of `subs` comes
 * through `teams` teams, each sharing a share of those projects. */
async function teamCaller(t: T, orgId: string, subs: readonly Doc<'projects'>[], teams: number) {
  const [caller] = await plantPeople(t, orgId, [{ name: 'Aardvark caller' }])
  if (caller === undefined) throw new Error('no caller')
  const tops = [...new Set(subs.map((s) => s.parent_id ?? ''))]
  await t.run(async (ctx) => {
    for (let i = 0; i < teams; i++) {
      const team = uuid()
      await ctx.db.insert('teams', {
        id: team,
        org_id: orgId,
        name: `Delivery team ${i}`,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', {
        team_id: team,
        profile_id: caller.id,
        is_leader: false,
      })
      for (const [k, top] of tops.entries())
        if (k % teams === i)
          await ctx.db.insert('project_team_access', {
            project_id: top,
            team_id: team,
            level: 'user',
          })
    }
  })
  return caller
}

describe('at the design size', () => {
  it('pages 1,000 people at limit 200 and 52 weeks', async () => {
    const t = newT()
    const fx = await setup(t)
    const people = await plantPeople(
      t,
      fx.org.id,
      Array.from({ length: 1000 - 6 }, (_, i) => ({ name: `Colleague ${i}` })),
    )
    // the everyday tasks of three sub-projects, 30 each, owned by 30 people
    const subs = await plantFamilies(t, fx.org.id, 3)
    await plantPlans(t, fx.org.id, people.slice(0, 30), subs, 3, 3)
    await keyOrg(t, fx.org.id)
    const { people: listed } = await measurePages(
      t,
      fx.admin,
      { limit: '200', from_week: WEEK, weeks: '52' },
      '1,000 people, limit 200, 52 weeks',
    )
    expect(listed).toHaveLength(1000)
  }, 60_000)

  it('pages the organization’s 10,000 open tasks held by 50 people at limit 50 and 52 weeks', async () => {
    const t = newT()
    const fx = await setup(t)
    const people = await plantPeople(
      t,
      fx.org.id,
      Array.from({ length: 50 }, (_, i) => ({ name: `Busy ${i}` })),
    )
    // everyday sub-projects of 30 open tasks, 200 tasks a person over seven
    // of them
    const subs = await plantFamilies(t, fx.org.id, 350)
    await plantPlans(t, fx.org.id, people, subs, 200, 30)
    await keyOrg(t, fx.org.id)
    const { reads, people: listed } = await measurePages(
      t,
      fx.admin,
      { limit: '50', from_week: WEEK, weeks: '52' },
      '10,000 open tasks over 50 people, limit 50, 52 weeks',
    )
    expect(listed.length).toBe(56)
    expect(reads.length).toBeGreaterThan(1)
  }, 60_000)

  it('pages people for a caller who reads the 200 sub-projects they work in', async () => {
    const t = newT()
    const fx = await setup(t)
    const subs = await plantFamilies(t, fx.org.id, 200)
    const caller = await teamCaller(t, fx.org.id, subs, 3)
    const people = await plantPeople(
      t,
      fx.org.id,
      Array.from({ length: 50 }, (_, i) => ({ name: `Worker ${i}` })),
    )
    // each person's twelve tasks over four sub-projects, every sub-project
    // in someone's work
    await plantPlans(t, fx.org.id, people, subs, 12, 3)
    await keyOrg(t, fx.org.id)
    const { people: listed } = await measurePages(
      t,
      caller,
      { limit: '50', from_week: WEEK, weeks: '52' },
      'a caller who reads 200 sub-projects, limit 50, 52 weeks',
    )
    expect(listed.length).toBe(57)
  }, 60_000)

  it('pages people for a caller in 5 teams', async () => {
    const t = newT()
    const fx = await setup(t)
    const subs = await plantFamilies(t, fx.org.id, 60)
    const caller = await teamCaller(t, fx.org.id, subs, 5)
    const people = await plantPeople(
      t,
      fx.org.id,
      Array.from({ length: 100 }, (_, i) => ({ name: `Member ${i}` })),
    )
    await plantPlans(t, fx.org.id, people, subs, 3, 3)
    await keyOrg(t, fx.org.id)
    const { people: listed } = await measurePages(
      t,
      caller,
      { limit: '200', from_week: WEEK, weeks: '52' },
      'a caller in 5 teams, limit 200, 52 weeks',
    )
    expect(listed.length).toBe(107)
  }, 60_000)
})
