/* The REST and MCP Inbox (machine/discussion.ts inboxPage, GET /v1/inbox and
 * list_inbox): one page of the caller's inbox items through the Inbox's
 * walk (model/inboxPage.ts inboxWalk), with its arguments and refusals in
 * order, a sealed cursor that continues across both surfaces, the walk's
 * order, the same items the old whole read answered (inboxOracle.setup.ts),
 * who sees what, actors named by id, the refusals of a seat not ready and
 * of a stopped access check, the read budget's ends, and the answer of the
 * bulk change with `all` asked through one accessOf instance. The reads at
 * the design size are logged as inboxPage.test.ts logs the app's. */

import { ConvexError } from 'convex/values'
import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, accessUnchecked, OWN_READS } from '../lib/access'
import { newWindowKey } from '../lib/db'
import type { Refusal } from '../lib/functions'
import { LIMITS } from '../lib/limits'
import { CURSOR_REFUSAL, filtersKey, listCursorText, offsetRefusal } from '../lib/listCursor'
import { namedCursor } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { issueKey } from '../lib/taskRefs'
import { sha256hex } from '../machine/auth'
import {
  INBOX_NOT_READY,
  inboxPage,
  MACHINE_INBOX_LIST,
  mcpUpdateInbox,
} from '../machine/discussion'
import { pretty } from '../machine/shared'
import { TRASH_BUDGET } from '../model/deletedItems'
import { itemEdits, REKEY } from '../model/inboxItems'
import { INBOX_LIST, INBOX_PAGE } from '../model/inboxPage'
import { ITEM_UNREAD_CAP } from '../model/messages'
import {
  as,
  NOW,
  newT,
  plantHiddenSibling,
  plantIssue,
  plantMessage,
  plantProject,
  plantSeat,
  readableLiveSubProjects,
  type T,
  uuid,
  withOrg,
  withReadingAdmin,
} from './helpers.setup'
import {
  actors,
  at,
  deliver,
  drift,
  everyday,
  grant,
  measure,
  plantGroups,
  plantLegacy,
  plantRaw,
  reader,
} from './inboxItems.setup'
import { type OracleItem, oracleInbox } from './inboxOracle.setup'
import { plantNorthstar } from './northstar.setup'
import { deleteTask, installTrashTimers, itemFor, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULTS = {
  page: structuredClone(INBOX_PAGE),
  own: structuredClone(OWN_READS),
  rekey: { ...REKEY },
}
afterEach(() => {
  Object.assign(INBOX_PAGE, structuredClone(DEFAULTS.page))
  Object.assign(OWN_READS, structuredClone(DEFAULTS.own))
  Object.assign(REKEY, DEFAULTS.rekey)
})

/* ------------------------------------------------------------- the calls */

/** One page as REST and MCP answer it. */
type Page = { next_cursor: string | null; items: OracleItem[] }

/** The two filters, as a page takes them. */
type Filters = { unread_only?: boolean; include_snoozed?: boolean }

/** The four combinations of the two filters. */
const FILTERS: Filters[] = [
  {},
  { unread_only: true },
  { include_snoozed: true },
  { unread_only: true, include_snoozed: true },
]

/** GET /v1/inbox's internal query for `who`, its parameters as text. */
const rest = (t: T, who: Doc<'profiles'>, q: Record<string, string> = {}, access = 'write') =>
  t.query(internal.machine.discussion.restListInbox, {
    callerId: who.id,
    access: access as 'read',
    ...q,
  }) as Promise<Page>

/** list_inbox's internal query for `who`, its answer parsed. */
const mcp = async (
  t: T,
  who: Doc<'profiles'>,
  a: Record<string, unknown> = {},
  access = 'write',
): Promise<Page> =>
  JSON.parse(
    await t.query(internal.machine.discussion.mcpListInbox, {
      callerId: who.id,
      access: access as 'read',
      ...a,
    }),
  ) as Page

/** `filters` as REST's query parameters. */
const asText = (filters: Filters): Record<string, string> =>
  Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)]))

/** Every page of `who`'s inbox on `surface` at `limit`, from the first,
 * following next_cursor to its end; fails on a cursor that does not move. */
async function pages(
  t: T,
  who: Doc<'profiles'>,
  surface: 'rest' | 'mcp',
  limit: number,
  filters: Filters = {},
): Promise<Page[]> {
  const out: Page[] = []
  let cursor: string | null = null
  for (let i = 0; i < 2000; i++) {
    const page: Page =
      surface === 'rest'
        ? await rest(t, who, {
            ...asText(filters),
            limit: String(limit),
            ...(cursor === null ? {} : { cursor }),
          })
        : await mcp(t, who, { ...filters, limit, ...(cursor === null ? {} : { cursor }) })
    expect(page.items.length).toBeLessThanOrEqual(limit)
    out.push(page)
    if (page.next_cursor === null) return out
    expect(page.next_cursor).not.toBe(cursor)
    cursor = page.next_cursor
  }
  throw new Error('the pages did not end')
}

/** The task ids of every item of `ps`. */
const taskIds = (ps: readonly Page[]) => ps.flatMap((p) => p.items.map((i) => i.task.id))

/** The ids of `tasks`, newest first when they were planted oldest first. */
const newestFirst = (tasks: readonly Doc<'issues'>[]) => tasks.map((task) => task.id).reverse()

/** The refusal `p` rejects with. */
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  const e = await p.then(
    () => null,
    (error: unknown) => error,
  )
  expect(e).toBeInstanceOf(ConvexError)
  return (e as ConvexError<Refusal>).data
}

/** The sentence `p` is refused with. */
const sentence = async (p: Promise<unknown>) => (await refusal(p)).message

/** The access_unchecked refusal's sentence (lib/access.ts accessUnchecked). */
const ACCESS_SENTENCE = (accessUnchecked().data as Refusal).message

/** The scope a page of `who` seals its cursor with. */
const scopeOf = async (who: Doc<'profiles'>, filters: Filters = {}) => [
  who.org_id,
  who.id,
  await filtersKey({
    unread_only: filters.unread_only === true,
    include_snoozed: filters.include_snoozed === true,
  }),
]

/** Patches every stored message of `to` about `task` through the item
 * writer, as a snooze or a wake writes them. */
const restamp = (
  t: T,
  to: Doc<'profiles'>,
  task: Doc<'issues'>,
  fields: { snoozed_until?: string; woke_at?: string; read_at?: string },
) =>
  t.run(async (ctx) => {
    const edits = itemEdits(ctx)
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) => q.eq('recipient_id', to.id).eq('issue_id', task.id))
      .collect()
    for (const row of rows) await edits.patch(row, fields)
    await edits.flush()
  })

/** `n` tasks in `projectId`, each with one item of `to` at minute
 * `from + i`, oldest first. */
const plantItemsOf = (t: T, to: Doc<'profiles'>, n: number, projectId: string, from = 0) =>
  plantGroups(t, to, n, () => projectId, { sent: (i) => [{ minute: from + i }] })

/** A key of an agent for HTTP calls, as the app's key screen makes one. */
async function plantKey(t: T, agent: Doc<'profiles'>): Promise<string> {
  const secret = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const key_hash = await sha256hex(secret)
  await t.run((ctx) =>
    ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'Inbox key',
      key_prefix: secret.slice(0, 11),
      key_hash,
      created_at: NOW,
    }),
  )
  return secret
}

/* convex-test's HTTP door. */
const httpOf = (t: T) =>
  t as unknown as {
    fetch(
      path: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ): Promise<Response>
  }

/** One MCP tools/call over HTTP with `secret`, its result. */
async function callTool(t: T, secret: string, name: string, args: Record<string, unknown>) {
  const res = await httpOf(t).fetch('/mcp', {
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
  return (JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } }).result
}

/** The fixture's agent with a User grant on TBED, as discussion.test.ts
 * sets it up. */
async function agentOrg(t: T = newT()) {
  const f = await withReadingAdmin(t)
  await grant(t, f.agent, f.meta.id)
  return { t, f }
}

/* --------------------------------------------------------- the arguments */

describe('the arguments', () => {
  it('refuse a bad limit, offset, flag or cursor with its sentence, in that order, on REST and the MCP query', async () => {
    const { t, f } = await agentOrg()
    await plantItemsOf(t, f.agent, 3, f.sub.id)
    for (const limit of ['0', '201', '1.5', 'ten']) {
      expect(await sentence(rest(t, f.agent, { limit }))).toBe(LIMITS.listInbox.refusal)
      expect((await refusal(rest(t, f.agent, { limit }))).code).toBe('rule')
    }
    for (const limit of [0, 201, 1.5])
      expect(await sentence(mcp(t, f.agent, { limit }))).toBe(LIMITS.listInbox.refusal)
    for (const offset of ['1', '-1', '1.5', 'abc']) {
      const refused = await refusal(rest(t, f.agent, { offset }))
      expect(refused).toMatchObject({ code: 'bad_request', message: offsetRefusal('inbox items') })
    }
    for (const offset of [1, -1, 1.5])
      expect(await sentence(mcp(t, f.agent, { offset }))).toBe(offsetRefusal('inbox items'))
    // 0 in any spelling is no offset
    for (const offset of ['0', '00'])
      expect((await rest(t, f.agent, { offset })).items).toHaveLength(3)
    expect((await mcp(t, f.agent, { offset: 0 })).items).toHaveLength(3)
    expect(await sentence(rest(t, f.agent, { unread_only: 'yes' }))).toBe(
      'unread_only must be true or false',
    )
    expect(await sentence(rest(t, f.agent, { include_snoozed: '1' }))).toBe(
      'include_snoozed must be true or false',
    )
    // an empty REST cursor is absent; an empty MCP cursor is a cursor
    expect((await rest(t, f.agent, { cursor: '' })).items).toHaveLength(3)
    expect(await sentence(mcp(t, f.agent, { cursor: '' }))).toBe(CURSOR_REFUSAL)
    // the order: limit, offset, the flags, the cursor
    const all = { limit: '0', offset: '1', unread_only: 'yes', cursor: 'junk' }
    expect(await sentence(rest(t, f.agent, all))).toBe(LIMITS.listInbox.refusal)
    expect(await sentence(rest(t, f.agent, { ...all, limit: '1' }))).toBe(
      offsetRefusal('inbox items'),
    )
    expect(await sentence(rest(t, f.agent, { ...all, limit: '1', offset: '0' }))).toBe(
      'unread_only must be true or false',
    )
    expect(
      await sentence(rest(t, f.agent, { ...all, limit: '1', offset: '0', unread_only: 'true' })),
    ).toBe(CURSOR_REFUSAL)
    const mcpAll = { limit: 0, offset: 1, cursor: 'junk' }
    expect(await sentence(mcp(t, f.agent, mcpAll))).toBe(LIMITS.listInbox.refusal)
    expect(await sentence(mcp(t, f.agent, { ...mcpAll, limit: 1 }))).toBe(
      offsetRefusal('inbox items'),
    )
    expect(await sentence(mcp(t, f.agent, { ...mcpAll, limit: 1, offset: 0 }))).toBe(CURSOR_REFUSAL)
  })

  it("refuse over HTTP an unknown query parameter, and MCP's schema refuses type errors first", async () => {
    const { t, f } = await agentOrg()
    await plantItemsOf(t, f.agent, 2, f.sub.id)
    const secret = await plantKey(t, f.agent)
    const get = (query: string) =>
      httpOf(t).fetch(`/v1/inbox${query}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secret}` },
      })
    const unknown = await get('?page=2')
    expect(unknown.status).toBe(400)
    expect(JSON.parse(await unknown.text()).error).toBe(
      'unknown query parameter "page"; this request takes unread_only, include_snoozed, limit, cursor, offset',
    )
    const first = await get('?limit=1')
    expect(first.status).toBe(200)
    const { next_cursor } = JSON.parse(await first.text()) as Page
    const second = await get(`?limit=1&cursor=${encodeURIComponent(next_cursor as string)}`)
    expect(JSON.parse(await second.text())).toMatchObject({ next_cursor: null })
    for (const args of [
      { limit: 1.5 },
      { limit: 'ten' },
      { offset: 1.5 },
      { offset: 'abc' },
      { unread_only: 'yes' },
    ]) {
      const res = await callTool(t, secret, 'list_inbox', args)
      expect(res.isError, JSON.stringify(args)).toBe(true)
      expect(res.content[0].text).toMatch(/^Input validation error/)
    }
    // the schema's minimum, maximum and minLength are hints, so the tool's
    // own sentences decide
    expect(await callTool(t, secret, 'list_inbox', { offset: 1 })).toMatchObject({
      isError: true,
      content: [{ text: offsetRefusal('inbox items') }],
    })
    expect(await callTool(t, secret, 'list_inbox', { cursor: '' })).toMatchObject({
      isError: true,
      content: [{ text: CURSOR_REFUSAL }],
    })
    const page = await callTool(t, secret, 'list_inbox', { limit: 1 })
    // the cursor first, so a cut tool result still shows it
    expect(Object.keys(JSON.parse(page.content[0].text))).toEqual(['next_cursor', 'items'])
  })
})

/* ------------------------------------------------------------- cursors */

describe('cursors', () => {
  it('open only for their list, organization, caller and filters, and continue on the other surface', async () => {
    const { t, f } = await agentOrg()
    // the guest reads TBED through the fixture's grant
    const tasks = await plantItemsOf(t, f.agent, 5, f.sub.id)
    await plantItemsOf(t, f.guest, 2, f.sub.id)
    const plain = (await rest(t, f.agent, { limit: '1' })).next_cursor as string
    const cursors: Record<string, string> = {
      'another caller': (await rest(t, f.guest, { limit: '1' })).next_cursor as string,
      'another organization': await listCursorText(
        MACHINE_INBOX_LIST,
        [f.otherOrg.id, ...(await scopeOf(f.agent)).slice(1)],
        { key: at(3), tie: [tasks[3].id, f.agent.id] },
      ),
      'unread_only sent without it': (await rest(t, f.agent, { limit: '1', unread_only: 'true' }))
        .next_cursor as string,
      'include_snoozed sent without it': (
        await rest(t, f.agent, { limit: '1', include_snoozed: 'true' })
      ).next_cursor as string,
      'a users cursor': await listCursorText(
        'machine.users',
        [f.org.id, f.agent.id, await filtersKey([nameKey('')])],
        { key: 'relay', tie: [f.agent.id] },
      ),
      "the app's Inbox cursor": await namedCursor(INBOX_LIST, await scopeOf(f.agent), {
        key: at(3),
        tie: [tasks[3].id, f.agent.id],
      }),
      'a tie of another shape': await listCursorText(MACHINE_INBOX_LIST, await scopeOf(f.agent), {
        key: at(3),
        tie: [1, 2],
      }),
      'a tie of three': await listCursorText(MACHINE_INBOX_LIST, await scopeOf(f.agent), {
        key: at(3),
        tie: [tasks[3].id, f.agent.id, 'x'],
      }),
      changed: `${plain.slice(0, 20)}${plain[20] === 'A' ? 'B' : 'A'}${plain.slice(21)}`,
      junk: 'not a cursor',
    }
    for (const [how, cursor] of Object.entries(cursors)) {
      expect(await sentence(rest(t, f.agent, { cursor })), how).toBe(CURSOR_REFUSAL)
      expect(await sentence(mcp(t, f.agent, { cursor })), how).toBe(CURSOR_REFUSAL)
    }
    // the guest's own cursor opens for the guest
    expect((await rest(t, f.guest, { cursor: cursors['another caller'] })).items).toHaveLength(1)
    // a REST cursor continues on MCP and an MCP one on REST, limit changing
    const a = await rest(t, f.agent, { limit: '2' })
    const b = await mcp(t, f.agent, { limit: 1, cursor: a.next_cursor })
    const c = await rest(t, f.agent, { limit: '5', cursor: b.next_cursor as string })
    expect(taskIds([a, b, c])).toEqual(newestFirst(tasks))
    expect(c.next_cursor).toBeNull()
    // a cursor sealed by hand with the page's own scope and shape opens
    const handMade = await listCursorText(MACHINE_INBOX_LIST, await scopeOf(f.agent), {
      key: at(3),
      tie: [tasks[3].id, f.agent.id],
    })
    expect((await mcp(t, f.agent, { cursor: handMade })).items.map((i) => i.task.id)).toEqual(
      newestFirst(tasks.slice(0, 3)),
    )
  })
})

/* -------------------------------------------------- order and paging */

describe('order and paging', () => {
  it('pages 23 items at limits 1, 2, 7 and 50, each once, newest first, the cursor null only after the last', async () => {
    const { t, f } = await agentOrg()
    const tasks = await plantItemsOf(t, f.agent, 23, f.sub.id)
    for (const limit of [1, 2, 7, 50])
      for (const surface of ['rest', 'mcp'] as const) {
        const all = await pages(t, f.agent, surface, limit)
        expect(taskIds(all), `${surface} at ${limit}`).toEqual(newestFirst(tasks))
        // a full page reads one item more, so the last page ends the list
        expect(all).toHaveLength(Math.ceil(23 / limit))
        expect(all.slice(0, -1).every((p) => p.next_cursor !== null)).toBe(true)
      }
    expect(await drift(t)).toEqual([])
  })

  it('orders a woken item by its wake, equal times by task id descending, and a snoozed item only with include_snoozed, in its place', async () => {
    const { t, f } = await agentOrg()
    const [a, b, c, d] = await plantItemsOf(t, f.agent, 4, f.sub.id, 1)
    // two items at one time, which the walk orders by task id descending
    const [x, y] = await plantGroups(t, f.agent, 2, () => f.sub.id, {
      sent: () => [{ minute: 10 }],
    })
    const [high, low] = x.id > y.id ? [x, y] : [y, x]
    // the oldest wakes past everything
    await restamp(t, f.agent, a, { woke_at: at(20) })
    // the third is snoozed
    await restamp(t, f.agent, c, { snoozed_until: '2099-01-01T00:00:00.000Z' })
    const keys = (p: Page) => p.items.map((i) => i.task.id)
    const plain = await mcp(t, f.agent)
    expect(keys(plain)).toEqual([a.id, high.id, low.id, d.id, b.id])
    expect(plain.items[0].latest_at).toBe(at(20))
    expect(keys(await mcp(t, f.agent, { include_snoozed: true }))).toEqual([
      a.id,
      high.id,
      low.id,
      d.id,
      c.id,
      b.id,
    ])
    expect((await mcp(t, f.agent, { include_snoozed: true })).items[4].snoozed_until).toBe(
      '2099-01-01T00:00:00.000Z',
    )
    // one at a time across the tie
    expect(taskIds(await pages(t, f.agent, 'rest', 1, { include_snoozed: true }))).toEqual([
      a.id,
      high.id,
      low.id,
      d.id,
      c.id,
      b.id,
    ])
    expect(await drift(t)).toEqual([])
  })

  it('keeps unread items under unread_only, and an item read between two pages leaves while the next page goes on', async () => {
    const { t, f } = await agentOrg()
    const tasks = await plantItemsOf(t, f.agent, 6, f.sub.id)
    // one read, one snoozed
    await restamp(t, f.agent, tasks[1], { read_at: at(30) })
    await restamp(t, f.agent, tasks[4], { snoozed_until: '2099-01-01T00:00:00.000Z' })
    const [a, , c, d, , e] = tasks.map((task) => task.id)
    const ids = (p: Page) => p.items.map((i) => i.task.id)
    expect(ids(await mcp(t, f.agent, { unread_only: true }))).toEqual([e, d, c, a])
    expect(ids(await mcp(t, f.agent, { unread_only: true, include_snoozed: true }))).toEqual([
      e,
      tasks[4].id,
      d,
      c,
      a,
    ])
    const first = await rest(t, f.agent, { unread_only: 'true', limit: '2' })
    expect(ids(first)).toEqual([e, d])
    // c is read before the next page, which goes on past d without it
    await t.mutation(internal.machine.discussion.mcpUpdateInbox, {
      callerId: f.agent.id,
      access: 'write',
      action: 'read',
      tasks: [issueKey(tasks[2].num)],
    })
    const next = await mcp(t, f.agent, { unread_only: true, cursor: first.next_cursor })
    expect([ids(next), next.next_cursor]).toEqual([[a], null])
    expect(await drift(t)).toEqual([])
  })
})

/* ----------------------------------------------- parity with the old read */

describe('parity with the old read', () => {
  it("answers every Northstar person's and agent's items as the old whole read did, in each filter", async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    let compared = 0
    for (const who of profiles)
      for (const filters of FILTERS) {
        const want = await t.run((ctx) =>
          oracleInbox(ctx, who, {
            unreadOnly: filters.unread_only === true,
            includeSnoozed: filters.include_snoozed === true,
          }),
        )
        const label = `${who.name} ${JSON.stringify(filters)}`
        const viaRest = (await pages(t, who, 'rest', 7, filters)).flatMap((p) => p.items)
        expect(viaRest, label).toEqual(want)
        const viaMcp = (await pages(t, who, 'mcp', 7, filters)).flatMap((p) => p.items)
        expect(viaMcp, label).toEqual(want)
        compared += want.length
      }
    // the seed leaves items to compare
    console.log(`Northstar parity: ${compared} items compared in all`)
    expect(compared).toBeGreaterThan(0)
    expect(await drift(t)).toEqual([])
  })
})

/* -------------------------------------------------------- who sees what */

describe('who sees what', () => {
  it('leaves out items about tasks the caller is not shown, and brings them back with the access or the task', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = (project_id = f.sub.id) => plantIssue(t, { org_id: f.org.id, project_id })
    const shown = await task()
    await deliver(t, f.guest, shown, { minute: 1 })
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    const inLost = await task(lost.id)
    await deliver(t, f.guest, inLost, { minute: 2 })
    const shelved = await plantProject(t, { org_id: f.org.id })
    await grant(t, f.guest, shelved.id)
    const inShelved = await task(shelved.id)
    await deliver(t, f.guest, inShelved, { minute: 3 })
    const archived = await task()
    await deliver(t, f.guest, archived, { minute: 4 })
    const trashed = await task()
    await deliver(t, f.guest, trashed, { minute: 5 })
    // never shown: a task in a project the guest cannot read
    const secret = await task(f.hidden.id)
    await deliver(t, f.guest, secret, { minute: 6 })
    const listed = async () => taskIds(await pages(t, f.guest, 'mcp', 2, { include_snoozed: true }))
    expect(await listed()).toEqual(
      [shown, inLost, inShelved, archived, trashed].map((x) => x.id).reverse(),
    )
    await revoke()
    await t.run((ctx) => ctx.db.patch(shelved._id, { archived_at: NOW }))
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: archived.id })
    TRASH_BUDGET.rows = 1
    await deleteTask(t, f, trashed.id)
    // the deleted task's item waits for its teardown, and is not listed
    expect(await listed()).toEqual([shown.id])
    expect(
      (await rest(t, f.guest, { include_snoozed: 'true' })).items.map((i) => i.task.id),
    ).toEqual([shown.id])
    await runSteps(t)
    // access, the project and the task back: their items show again
    await grant(t, f.guest, lost.id)
    await t.run((ctx) => ctx.db.patch(shelved._id, { archived_at: undefined }))
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: archived.id })
    // a restore brings the task back without its messages, which the delete removed
    const item = await itemFor(t, trashed.id)
    await as(t, f.user).mutation(api.deletedItems.restore, { ids: [item.id], org_id: f.org.id })
    await runSteps(t)
    const back = await listed()
    expect(back).toEqual(expect.arrayContaining([shown.id, inLost.id, inShelved.id, archived.id]))
    expect(back).not.toContain(trashed.id)
    expect(back).not.toContain(secret.id)
    expect(await drift(t)).toEqual([])
  })

  it('leaves a task moved into a hidden project out at once, and shows one a large move took into a visible project once its re-key runs', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const hidden = await plantHiddenSibling(t, f, f.guest)
    const move = (id: string, project_id: string) =>
      as(t, f.admin).mutation(api.issues.move, { org_id: f.org.id, id, project_id })
    const listed = async () => (await rest(t, f.guest)).items.map((i) => i.task.id)
    const away = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deliver(t, f.guest, away, { minute: 1 })
    expect(await listed()).toEqual([away.id])
    REKEY.inline = 0
    await move(away.id, hidden.id)
    // its hint still names FW, and its task is checked by its own project
    expect(await rest(t, f.guest)).toEqual({ next_cursor: null, items: [] })
    await runSteps(t)
    expect(await listed()).toEqual([])
    const back = await plantIssue(t, { org_id: f.org.id, project_id: hidden.id })
    await deliver(t, f.guest, back, { minute: 2 })
    await move(back.id, f.sub2.id)
    // left out by its hint until the step runs, never a hidden task
    expect(await listed()).toEqual([])
    await runSteps(t)
    expect(await listed()).toEqual([back.id])
    expect(await drift(t)).toEqual([])
  })

  it('answers a guest, an organization Viewer, a Viewer agent, a read-only credential and an admin only their own items, the admin by its own access', async () => {
    const t = newT()
    const f = await withOrg(t)
    await grant(t, f.agent, f.meta.id)
    const viewerAgent = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Ledger',
      org_role: 'viewer',
      kind: 'agent',
      plannable_hours: undefined,
    })
    await grant(t, viewerAgent, f.meta.id)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const mine = new Map<string, string>()
    for (const who of [f.guest, f.viewer, viewerAgent, f.agent, f.admin]) {
      const [row] = await deliver(t, who, task, { minute: 1, body: `For ${who.name}` })
      mine.set(who.id, row.id)
    }
    for (const [who, access] of [
      [f.guest, 'write'],
      [f.viewer, 'write'],
      [viewerAgent, 'read'],
      [f.agent, 'read'],
    ] as const) {
      for (const page of [await rest(t, who, {}, access), await mcp(t, who, {}, access)]) {
        expect(
          page.items.map((i) => i.messages.map((m) => m.id)),
          who.name,
        ).toEqual([[mine.get(who.id)]])
      }
    }
    // an admin reads by the access rows it holds, like anyone else: none here
    expect(await rest(t, f.admin)).toEqual({ next_cursor: null, items: [] })
    await grant(t, f.admin, f.meta.id)
    expect((await mcp(t, f.admin)).items.map((i) => i.messages[0].id)).toEqual([
      mine.get(f.admin.id),
    ])
  })
})

/* ---------------------------------------------------------------- names */

describe('names', () => {
  it("names every message's actor from the caller's organization, null for another organization's profile or a removed one", async () => {
    const { t, f } = await agentOrg()
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const removed = await plantSeat(t, { org_id: f.org.id, name: 'Gone', accepted_at: NOW })
    await deliver(
      t,
      f.agent,
      task,
      { minute: 1, actor: f.user.id },
      { minute: 2, actor: f.otherAdmin.id },
      { minute: 3, actor: removed.id },
      { minute: 4, actor: f.admin.id },
      { minute: 5 },
    )
    await t.run((ctx) => ctx.db.delete(removed._id))
    for (const page of [await rest(t, f.agent), await mcp(t, f.agent)])
      expect(page.items[0].messages.map((m) => [m.actor_id, m.actor_name])).toEqual([
        [f.user.id, 'user'],
        [f.otherAdmin.id, null],
        [removed.id, null],
        [f.admin.id, 'admin'],
        [null, null],
      ])
  })

  it('reads one profile for each actor a page names, whatever the size of the roster', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const people = await actors(t, f, 3)
    const me = await reader(t, f, [f.sub], 'user')
    const twin = await reader(t, f, [f.sub], 'user')
    // 10 items each, the reader's messages by three people, the twin's by nobody
    await plantGroups(t, me, 10, () => f.sub.id, {
      sent: (i) => [{ minute: i, actor: people[i % 3].id }],
    })
    await plantGroups(t, twin, 10, () => f.sub.id, { sent: (i) => [{ minute: i }] })
    const read = (who: Doc<'profiles'>) =>
      measure(t, (ctx) =>
        inboxPage(ctx, who, {
          unread_only: false,
          include_snoozed: false,
          limit: 50,
          cursor: null,
        }),
      )
    const named = await read(me)
    const nameless = await read(twin)
    expect(named.answer.items).toHaveLength(10)
    expect(named.documents - nameless.documents).toBe(3)
    // an organization of 200 people reads the same
    await t.run(async (ctx) => {
      for (let i = 0; i < 190; i++)
        await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: f.org.id,
          name: `Engineer ${i + 100}`,
          initials: 'EN',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          plannable_hours: 40,
          accepted_at: NOW,
          created_at: NOW,
        })
    })
    expect((await read(me)).documents).toBe(named.documents)
  })
})

/* ------------------------------------------------- not ready and stopped */

describe('a seat not ready and a stopped check', () => {
  it('refuse a profile whose items are not built, never an empty inbox, and answer an empty inbox whole', async () => {
    const { t, f } = await agentOrg()
    // no message and no build state: an empty inbox, whole
    expect(await rest(t, f.agent)).toEqual({ next_cursor: null, items: [] })
    expect(await mcp(t, f.agent)).toEqual({ next_cursor: null, items: [] })
    // a message stored raw, as before the items: not ready
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.agent.id, issue_id: task.id })
    for (const p of [rest(t, f.agent), mcp(t, f.agent), rest(t, f.agent, { unread_only: 'true' })])
      expect(await refusal(p)).toMatchObject({ code: 'rule', message: INBOX_NOT_READY })
    // the backfill builds its items, and the inbox answers
    for (let i = 0; i < 5; i++) {
      const step = await t.mutation(internal.internal.inboxItemsBackfill.step, {
        profile_id: f.agent.id,
      })
      if (step.done) break
    }
    expect((await mcp(t, f.agent)).items.map((i) => i.task.id)).toEqual([task.id])
  })

  it('refuse a page whose access check a bound stopped with the access sentence, which the default bounds answer', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const me = await reader(t, f, [f.sub], 'user')
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    const [a, b] = await plantItemsOf(t, me, 2, f.sub.id)
    const [shared] = await plantItemsOf(t, me, 1, f.sub2.id, 5)
    expect(taskIds([await rest(t, me)])).toEqual([shared.id, b.id, a.id])
    // the check of PCB, shared with the seat's team, stops
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    for (const p of [rest(t, me), mcp(t, me)])
      expect(await refusal(p)).toMatchObject({
        code: 'rule',
        reason: ACCESS_UNCHECKED,
        message: ACCESS_SENTENCE,
      })
    Object.assign(OWN_READS, structuredClone(DEFAULTS.own))
    expect(taskIds([await mcp(t, me)])).toEqual([shared.id, b.id, a.id])
  })
})

/* ------------------------------------------------------ the read budget */

describe('the read budget', () => {
  it('ends pages short with cursors, each moving forward, every item once', async () => {
    const { t, f } = await agentOrg()
    const tasks = await plantItemsOf(t, f.agent, 23, f.sub.id)
    const usual = await mcp(t, f.agent, { limit: 50 })
    expect(usual.next_cursor).toBeNull()
    INBOX_PAGE.reads.documents = 12
    for (const surface of ['rest', 'mcp'] as const) {
      const all = await pages(t, f.agent, surface, 50)
      expect(all.length).toBeGreaterThan(2)
      expect(all.slice(0, -1).every((p) => p.items.length < 23)).toBe(true)
      expect(taskIds(all)).toEqual(newestFirst(tasks))
    }
  })

  it('answers an item at the item cap and one kept from before the cap whole, then stops', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await grant(t, f.agent, f.meta.id)
    // an item kept from before the cap, built by the backfill
    const legacy = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantLegacy(t, f, f.agent, legacy, 300, (i) => (i % 2 === 0 ? 'change' : 'comment'))
    for (let i = 0; i < 10; i++) {
      const step = await t.mutation(internal.internal.inboxItemsBackfill.step, {
        profile_id: f.agent.id,
      })
      if (step.done) break
    }
    // an item at the cap, newer, and two small ones, newest of all
    const capped = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deliver(
      t,
      f.agent,
      capped,
      { minute: 400, read: true },
      ...Array.from({ length: ITEM_UNREAD_CAP }, (_, j) => ({ minute: 401 + j })),
    )
    const small = await plantItemsOf(t, f.agent, 2, f.sub.id, 500)
    INBOX_PAGE.reads.documents = 20
    const all = await pages(t, f.agent, 'mcp', 50)
    expect(taskIds(all)).toEqual([small[1].id, small[0].id, capped.id, legacy.id])
    const of = (id: string) => all.flatMap((p) => p.items).find((i) => i.task.id === id)
    expect(of(capped.id)?.messages).toHaveLength(ITEM_UNREAD_CAP + 1)
    expect(of(legacy.id)?.messages).toHaveLength(300)
    // each large item ends its page
    for (const id of [capped.id, legacy.id]) {
      const page = all.find((p) => p.items.some((i) => i.task.id === id)) as Page
      expect(page.items.at(-1)?.task.id).toBe(id)
    }
    const oracle = await t.run((ctx) =>
      oracleInbox(ctx, f.agent, { unreadOnly: false, includeSnoozed: false }),
    )
    expect(all.flatMap((p) => p.items)).toEqual(oracle)
  })

  it('ends pages short and empty over 300 groups of archived tasks newer than the visible ones, until the visible items come', async () => {
    const { t, f } = await agentOrg()
    const visible = await plantItemsOf(t, f.agent, 3, f.sub.id)
    await plantGroups(t, f.agent, 300, () => f.sub.id, {
      task: () => ({ archived_at: NOW }),
      sent: (i) => [{ minute: 10 + i }],
    })
    INBOX_PAGE.reads.documents = 60
    const all = await pages(t, f.agent, 'rest', 50)
    expect(all.length).toBeGreaterThan(3)
    expect(all.slice(0, 2).every((p) => p.items.length === 0 && p.next_cursor !== null)).toBe(true)
    expect(taskIds(all)).toEqual(newestFirst(visible))
  })
})

/* -------------------------------------------------------- the sentences */

describe('the sentences', () => {
  it('are pinned, and the public docs quote them', () => {
    const sentences = {
      [offsetRefusal('inbox items')]:
        'offset does not apply to inbox items; pass next_cursor as cursor',
      [INBOX_NOT_READY]:
        'your inbox cannot be read until Qivo has finished preparing it. Try again in a few minutes, or contact support@qivo.io if it stays so.',
      [CURSOR_REFUSAL]: 'cursor must be the next_cursor of an earlier page',
    }
    for (const [sent, pinned] of Object.entries(sentences)) expect(sent).toBe(pinned)
    const docs = import.meta.glob(['../../docs/rest-api.md', '../../docs/mcp.md'], {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>
    expect(Object.keys(docs)).toHaveLength(2)
    for (const [path, text] of Object.entries(docs)) {
      // a wrapped line reads as one space
      const prose = text.replace(/\s+/g, ' ')
      for (const pinned of Object.values(sentences)) expect(prose, path).toContain(pinned)
    }
  })
})

/* ------------------------------------------------------ the bulk change */

/** update_inbox with `all` and `action` for `who`, its answer parsed. */
const changeAll = async (t: T, who: Doc<'profiles'>, action: 'read' | 'remove') =>
  JSON.parse(
    await t.mutation(internal.machine.discussion.mcpUpdateInbox, {
      callerId: who.id,
      access: 'write',
      action,
      all: true,
    }),
  ) as { action: string; tasks: string[]; has_more: boolean }

describe('the bulk change with all', () => {
  it('names exactly the tasks of projects the caller reads, sorted by number, never another organization’s', async () => {
    const { t, f } = await agentOrg()
    const tasks: Doc<'issues'>[] = []
    // twenty sub-projects the agent reads through TBED, and four of SKNK it
    // cannot read
    for (let i = 0; i < 24; i++) {
      const project = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: i < 20 ? f.meta.id : f.hidden.id,
      })
      tasks.push(await plantIssue(t, { org_id: f.org.id, project_id: project.id }))
    }
    for (const [i, task] of tasks.entries()) await deliver(t, f.agent, task, { minute: 24 - i })
    // a task of another organization whose project the agent holds a grant
    // on: never named, as the organization is checked before access
    const elsewhere = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await grant(t, f.agent, f.otherProject.id)
    await deliver(t, f.agent, elsewhere, { minute: 30 })
    const readable = tasks
      .slice(0, 20)
      .sort((a, b) => a.num - b.num)
      .map((task) => issueKey(task.num))
    expect(await changeAll(t, f.agent, 'read')).toMatchObject({ tasks: readable, has_more: false })
    const rows = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_recipient', (q) => q.eq('recipient_id', f.agent.id))
        .collect(),
    )
    expect(rows.every((m) => m.read_at !== undefined)).toBe(true)
    expect(await changeAll(t, f.agent, 'remove')).toMatchObject({ tasks: readable })
    expect(await drift(t)).toEqual([])
  })

  it('refuses the change whole where an access check stopped, and changes no message', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const me = await reader(t, f, [f.sub], 'user')
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await plantItemsOf(t, me, 2, f.sub.id)
    await plantItemsOf(t, me, 1, f.sub2.id, 5)
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    expect(await refusal(changeAll(t, me, 'read'))).toMatchObject({
      code: 'rule',
      reason: ACCESS_UNCHECKED,
      message: ACCESS_SENTENCE,
    })
    const rows = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_recipient', (q) => q.eq('recipient_id', me.id))
        .collect(),
    )
    expect(rows.map((m) => m.read_at)).toEqual([undefined, undefined, undefined])
    Object.assign(OWN_READS, structuredClone(DEFAULTS.own))
    expect((await changeAll(t, me, 'read')).tasks).toHaveLength(3)
  })
})

/* ------------------------------------------------ reads at the design size */

/** One page of `who`'s inbox read in one transaction, with what it read. */
const measuredPage = (
  t: T,
  who: Doc<'profiles'>,
  a: Filters & { limit?: number; cursor?: string | null } = {},
) =>
  measure(t, (ctx) =>
    inboxPage(ctx, who, {
      unread_only: a.unread_only === true,
      include_snoozed: a.include_snoozed === true,
      limit: a.limit ?? 50,
      cursor: a.cursor ?? null,
    }),
  )

type Measured = Awaited<ReturnType<typeof measuredPage>>

/** Logs one measured page with the answer's size on both surfaces and
 * checks it stayed inside Convex's limits for one call. A page that
 * answers was neither not ready nor stopped by an access check, which
 * refuse the call. */
function logged(label: string, r: Measured): Measured {
  const restBytes = JSON.stringify(r.answer).length
  const mcpBytes = pretty(r.answer).length
  console.log(
    `${label}: ${r.answer.items.length} items, ${r.ranges} ranges, ${r.documents} documents, ` +
      `${Math.round(r.bytes / 1024)} KB read, ${r.answer.next_cursor === null ? 'the end' : 'a cursor'}, ` +
      `answer ${Math.round(restBytes / 1024)} KB REST, ${Math.round(mcpBytes / 1024)} KB MCP`,
  )
  expect(r.ranges, label).toBeLessThan(4096)
  expect(r.documents, label).toBeLessThan(32_000)
  expect(r.bytes, label).toBeLessThan(16 * 1024 * 1024)
  return r
}

/** Every page of `who`'s inbox at `limit`, measured and logged. */
async function measuredPages(
  t: T,
  who: Doc<'profiles'>,
  label: string,
  a: Filters & { limit: number },
) {
  const out: Measured[] = []
  let cursor: string | null = null
  for (let i = 0; i < 200; i++) {
    const r: Measured = await measuredPage(t, who, { ...a, cursor })
    out.push(r)
    if (r.answer.next_cursor === null) break
    cursor = r.answer.next_cursor
  }
  out.forEach((r, i) => {
    logged(`${label}, page ${i + 1} of ${out.length}`, r)
  })
  return out
}

/** A title of about 80 characters, ordinary text. */
const title = (i: number) =>
  `Calibrate the bench fixture for board revision ${i} before the thermal soak run`

/** `n` people of `orgId` in one transaction, the actors of a case. */
const plantPeople = (t: T, orgId: string, n: number) =>
  t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (let i = 0; i < n; i++) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: orgId,
        name: `Engineer ${i}`,
        initials: 'EN',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        accepted_at: NOW,
        created_at: NOW,
      })
      out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    return out
  })

describe('reads at the design size', () => {
  it('1. the everyday Inbox, 60 groups over 3 sub-projects, at limits 50 and 200 with each filter', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f)
    const people = await actors(t, f, 10)
    const groups = await plantGroups(t, me, 60, (i) => subs[i % 3].id, {
      title,
      sent: (i) => [
        { minute: 2 * i, actor: people[i % 10].id, read: i % 4 === 0 },
        { minute: 2 * i + 1, kind: 'comment', body: 'New comment', actor: people[(i + 3) % 10].id },
      ],
    })
    for (const task of groups.slice(0, 5))
      await restamp(t, me, task, { snoozed_until: '2099-01-01T00:00:00.000Z' })
    for (const limit of [50, 200])
      for (const filters of FILTERS)
        await measuredPages(t, me, `everyday at ${limit}, ${JSON.stringify(filters)}`, {
          ...filters,
          limit,
        })
  })

  it('2. one sub-project’s 300 open and 150 Done tasks, a group each, paged at 200 to the end and unread only', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f)
    const people = await actors(t, f, 50)
    const done = (i: number) => i % 3 === 2
    const tasks = await plantGroups(t, me, 450, () => subs[0].id, {
      title,
      task: (i) => (done(i) ? { status: 'done', done_at: NOW } : {}),
      sent: (i) => [{ minute: i, actor: people[i % 50].id, read: done(i) }],
    })
    const all = await measuredPages(t, me, '450 in a sub-project at 200', { limit: 200 })
    expect(all.flatMap((r) => r.answer.items.map((i) => i.task.id))).toEqual(newestFirst(tasks))
    const unread = await measuredPages(t, me, '450 in a sub-project at 200, unread only', {
      limit: 200,
      unread_only: true,
    })
    expect(unread.flatMap((r) => r.answer.items)).toHaveLength(300)
  })

  it('3. one project’s 800 open and 200 Done tasks over 3 sub-projects, 1,000 groups, paged at 200 to the end', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f)
    const people = await actors(t, f, 50)
    const tasks = await plantGroups(t, me, 1000, (i) => subs[i % 3].id, {
      title,
      task: (i) => (i % 5 === 4 ? { status: 'done', done_at: NOW } : {}),
      sent: (i) => [{ minute: i, actor: people[i % 50].id }],
    })
    const all = await measuredPages(t, me, '1,000 in a project at 200', { limit: 200 })
    expect(all.flatMap((r) => r.answer.items.map((i) => i.task.id))).toEqual(newestFirst(tasks))
  })

  it('4. 60 groups at the item cap, 51 messages each, at limit 200, with the answer’s bytes', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f)
    const people = await actors(t, f, 10)
    await plantGroups(t, me, 60, (i) => subs[i % 3].id, {
      title,
      chunk: 10,
      sent: (i) => [
        { minute: 100 * i, read: true, actor: people[i % 10].id, body: 'Wired the zebra harness' },
        ...Array.from({ length: ITEM_UNREAD_CAP }, (_, j) => ({
          minute: 100 * i + 1 + j,
          kind: 'comment' as const,
          body: 'New comment',
          actor: people[(i + j) % 10].id,
        })),
      ],
    })
    const all = await measuredPages(t, me, '60 groups at the cap at 200', { limit: 200 })
    const items = all.flatMap((r) => r.answer.items)
    expect(items).toHaveLength(60)
    expect(items.every((i) => i.messages.length === ITEM_UNREAD_CAP + 1)).toBe(true)
  })

  it('5. 800 groups of a project the caller no longer sees, newer than every visible group, at limits 50 and 200', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f)
    const visible = await plantGroups(t, me, 60, (i) => subs[i % 3].id, { title })
    const parent = await plantProject(t, { org_id: f.org.id, name: 'Retired line' })
    const gone: Doc<'projects'>[] = []
    for (const name of ['Firmware', 'Hardware', 'Validation'])
      gone.push(
        await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: parent.id, name }),
      )
    await plantGroups(t, me, 800, (i) => gone[i % 3].id, {
      title,
      sent: (i) => [{ minute: 1000 + i }],
    })
    for (const limit of [50, 200]) {
      const all = await measuredPages(t, me, `800 hidden over 60 visible at ${limit}`, { limit })
      expect(all.flatMap((r) => r.answer.items.map((i) => i.task.id))).toEqual(newestFirst(visible))
    }
  })

  it('6. a person in 5 teams with an everyday Inbox', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f, 5)
    await plantGroups(t, me, 60, (i) => subs[i % 3].id, { title })
    for (const limit of [50, 200]) await measuredPages(t, me, `in 5 teams at ${limit}`, { limit })
  })

  it('7. an organization of 1,000 people whose everyday Inbox names 180 of them, at limit 200', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f)
    const seated = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    )
    const people = await plantPeople(t, f.org.id, 1000 - seated.length)
    // 60 groups of 3 messages, each group by 3 people of its own
    await plantGroups(t, me, 60, (i) => subs[i % 3].id, {
      title,
      sent: (i) => [0, 1, 2].map((j) => ({ minute: 3 * i + j, actor: people[3 * i + j].id })),
    })
    const [named] = await measuredPages(t, me, '1,000 people, 180 named, at 200', { limit: 200 })
    expect(named.answer.items).toHaveLength(60)
    // the same page with no actor named reads 180 documents fewer, one
    // profile for each person named, not the roster
    await t.run(async (ctx) => {
      for (const m of await ctx.db
        .query('messages')
        .withIndex('by_recipient', (q) => q.eq('recipient_id', me.id))
        .collect())
        await ctx.db.patch(m._id, { actor_id: undefined })
    })
    const [nameless] = await measuredPages(t, me, '1,000 people, none named, at 200', {
      limit: 200,
    })
    expect(named.documents - nameless.documents).toBe(180)
  })

  it('8. the 200 sub-projects one person can read, 30 groups each, one page at 200 and one at 50', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // 63 sub-projects through the person's 3 teams and 137 through grants
    // on 46 more, the last of them with 2, so exactly 200 in all
    const { me, subs } = await everyday(t, f, 3, 46, 2)
    expect(subs).toHaveLength(200)
    expect(await readableLiveSubProjects(t, me)).toBe(200)
    await plantRaw(t, me, 6000, (i) => subs[i % 200].id, {
      title,
      sent: (i) => ({
        minute: i,
        body: 'Status changed from Todo to In progress',
        actor: f.admin.id,
      }),
    })
    for (const limit of [200, 50]) {
      const page = logged(
        `6,000 over 200 sub-projects at ${limit}`,
        await measuredPage(t, me, { limit }),
      )
      expect(page.answer.items).toHaveLength(limit)
      expect(new Set(page.answer.items.map((i) => i.task.id)).size).toBe(limit)
    }
  })

  it('9. the bulk change with all over 160 messages on 160 tasks in 160 sub-projects the caller reads by grant', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    let num = 5000
    // 160 sub-projects under 54 top-level ones, each sub-project granted to `me`
    const granted = (me: Doc<'profiles'>) =>
      t.run(async (ctx) => {
        const out: Doc<'projects'>[] = []
        const project = async (parent: Doc<'projects'> | null, name: string) => {
          const _id = await ctx.db.insert('projects', {
            id: uuid(),
            org_id: f.org.id,
            type: parent === null ? 'meta' : 'project',
            ...(parent === null ? {} : { parent_id: parent.id }),
            key: `G${num}`,
            name,
            description: '',
            sort_order: num,
            num: num++,
            track_delay: false,
            created_at: NOW,
            window_key: newWindowKey(),
          })
          return (await ctx.db.get(_id)) as Doc<'projects'>
        }
        for (let i = 0; i < 54; i++) {
          const parent = await project(null, `Product line ${i}`)
          for (const name of ['Firmware', 'Hardware', 'Validation']) {
            if (out.length === 160) break
            const sub = await project(parent, `${name} ${i}`)
            await ctx.db.insert('project_access', {
              project_id: sub.id,
              profile_id: me.id,
              level: 'user',
            })
            out.push(sub)
          }
        }
        return out
      })
    const me = await reader(t, f, [], 'user')
    const twin = await reader(t, f, [], 'user')
    for (const who of [me, twin]) {
      const subs = await granted(who)
      expect(subs).toHaveLength(160)
      await plantGroups(t, who, 160, (i) => subs[i].id, { title })
    }
    const change = (me: Doc<'profiles'>, action: 'read' | 'remove') =>
      t.run(async (ctx) => {
        const answer = JSON.parse(
          await (
            mcpUpdateInbox as unknown as {
              _handler: (ctx: MutationCtx, args: Record<string, unknown>) => Promise<string>
            }
          )._handler(ctx, { callerId: me.id, access: 'write', action, all: true }),
        ) as { tasks: string[]; has_more: boolean }
        const m = await ctx.meta.getTransactionMetrics()
        return {
          answer,
          ranges: m.databaseQueries.used,
          documents: m.documentsRead.used,
          bytes: m.bytesRead.used,
        }
      })
    const read = await change(me, 'read')
    console.log(
      `bulk read over 160 sub-projects: ${read.answer.tasks.length} named, ${read.ranges} ranges, ${read.documents} documents, ${Math.round(read.bytes / 1024)} KB read`,
    )
    expect(read.answer.tasks).toHaveLength(160)
    const remove = await change(me, 'remove')
    console.log(
      `bulk remove over 160 sub-projects: ${remove.answer.tasks.length} named, ${remove.ranges} ranges, ${remove.documents} documents, ${Math.round(remove.bytes / 1024)} KB read`,
    )
    expect(remove.answer.tasks).toHaveLength(160)
    for (const r of [read, remove]) {
      expect(r.ranges).toBeLessThan(4096)
      expect(r.documents).toBeLessThan(32_000)
    }
    // 300 more projects of the organization, none of them the twin's, leave
    // the twin's change reading what the first one read
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++)
        await ctx.db.insert('projects', {
          id: uuid(),
          org_id: f.org.id,
          type: 'meta',
          key: `X${i}`,
          name: `Unrelated line ${i}`,
          description: '',
          sort_order: 9000 + i,
          num: 9000 + i,
          track_delay: false,
          created_at: NOW,
          window_key: newWindowKey(),
        })
    })
    const twinRead = await change(twin, 'read')
    expect(twinRead.answer.tasks).toHaveLength(160)
    expect([twinRead.ranges, twinRead.documents]).toEqual([read.ranges, read.documents])
  })

  it('reads one task for each group of an archived task it passes: 2,000 in one sub-project newer than an everyday Inbox, one page', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { me, subs } = await everyday(t, f)
    await plantGroups(t, me, 60, (i) => subs[i % 3].id, { title })
    await plantRaw(t, me, 2000, () => subs[0].id, {
      title,
      task: () => ({ archived_at: NOW }),
      sent: (i) => ({ minute: 1000 + i, actor: f.admin.id }),
    })
    for (const limit of [50, 200])
      logged(
        `2,000 archived over an everyday Inbox at ${limit}, the first page`,
        await measuredPage(t, me, { limit }),
      )
  })
})
