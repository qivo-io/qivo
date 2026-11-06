/* REST and MCP task details with the first page of each related list, and
 * the lists' own pages (lib/core.ts taskOut and relatedPage, REST GET
 * /v1/tasks/{ref}/subtasks, /links, /followers and /attachments, MCP
 * list_task_related):
 *
 *   1. Arguments on both surfaces and the order of refusals.
 *   2. Cursors: one list name for the details and both surfaces, sealed to
 *      the organization, the caller, the task, the list and the selection.
 *   3. Order and paging: every row once at any limit, the end only at the
 *      end, the documented orders with id ties, against creation order.
 *   4. Visibility: subtasks and links the caller can read, for every kind
 *      of caller, followers and attachments as before.
 *   5. Facts: `following` from the caller's own follow, the group's totals
 *      from its walk, the details' first pages against the lists'.
 *   6. Download links minted for the page in hand alone.
 *   7. An archived group's subtasks in number order through the index.
 *   8. Bounds and room: a list past RELATED_READ, a list the details had no
 *      room for, a write's answer.
 *   9. Access: one accessOf instance, its refusal, and reads that follow
 *      the task rather than the organization.
 *  10. Comment pages' names read by id.
 *  11. Reads at the design size, one figure a case, recorded in the
 *      budgets' docstrings (lib/core.ts RELATED_READ, SUBTASK_PAGE and
 *      TASK_DETAILS). */

import { compareValues } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, OWN_READS } from '../lib/access'
import {
  RELATED_LIMITS,
  RELATED_NOUNS,
  RELATED_READ,
  relatedTooMany,
  SUBTASK_PAGE,
  TASK_DETAILS,
  TASK_READ_RESERVE,
  type TaskRelatedList,
} from '../lib/core'
import { newWindowKey } from '../lib/db'
import type { Refusal, RefusalCode } from '../lib/functions'
import { DEFAULT_PAGE_SIZE, LIMITS } from '../lib/limits'
import { CURSOR_REFUSAL, listCursorText, offsetRefusal } from '../lib/listCursor'
import { nameKey } from '../lib/nameKey'
import { sha256hex } from '../machine/auth'
import { getIssue as mcpGetIssue, listComments as mcpListComments } from '../machine/mcp'
import {
  mcpTaskRelated,
  restListAttachments,
  restListFollowers,
  restListLinks,
  restListSubtasks,
} from '../machine/records'
import { getIssue as restGetIssue, listComments as restListComments } from '../machine/rest'
import { insertTask } from '../model/descriptions'
import {
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'

/* Every download link minted while a test runs (lib/fileTokens.ts
 * mintFileToken), so a test can tell how many a read minted. */
const minted = vi.hoisted(() => ({ count: 0 }))

vi.mock('../lib/fileTokens', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/fileTokens')>()
  return {
    ...real,
    mintFileToken: async (...a: Parameters<typeof real.mintFileToken>) => {
      minted.count++
      return await real.mintFileToken(...a)
    },
  }
})

const DEFAULTS = structuredClone({
  related: RELATED_READ,
  page: SUBTASK_PAGE,
  details: TASK_DETAILS,
  reserve: TASK_READ_RESERVE,
  own: OWN_READS,
})
afterEach(() => {
  const back = structuredClone(DEFAULTS)
  Object.assign(RELATED_READ, back.related)
  Object.assign(SUBTASK_PAGE, back.page)
  Object.assign(TASK_DETAILS, back.details)
  Object.assign(TASK_READ_RESERVE, back.reserve)
  Object.assign(OWN_READS, back.own)
  minted.count = 0
})

/* --------------------------------------------------------------- fixture */

type Fx = OrgFixture & {
  t: T
  /** a sub-project of SKNK, which the agent cannot read */
  hiddenSub: Doc<'projects'>
}

/* withOrg, with the agent holding Edit on TBED (FW and PCB) and SKS, a
 * sub-project of SKNK, that it cannot read. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  const hiddenSub = await plantProject(t, {
    org_id: f.org.id,
    type: 'project',
    parent_id: f.hidden.id,
    key: 'SKS',
    name: 'Skunk sub',
  })
  return { t, ...f, hiddenSub }
}

/* Task numbers no other planted task takes. */
let nextNum = 60_000

/* `count` tasks in FW unless `over` says otherwise, in one transaction, in
 * the order given, numbered in that order unless `nums` gives each its
 * number, with ordinary titles. */
const plantTasks = (
  fx: Fx,
  count: number,
  over: Partial<Doc<'issues'>> = {},
  nums?: readonly number[],
): Promise<Doc<'issues'>[]> =>
  fx.t.run(async (ctx) => {
    const out: Doc<'issues'>[] = []
    for (let i = 0; i < count; i++) {
      const _id = await insertTask(
        ctx.db,
        {
          id: uuid(),
          org_id: fx.org.id,
          project_id: fx.sub.id,
          num: nums?.[i] ?? nextNum++,
          title: `Related task ${i}`,
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          window_key: newWindowKey(),
          ...over,
        },
        'restore',
      )
      out.push((await ctx.db.get(_id)) as Doc<'issues'>)
    }
    return out
  })

/* Links from `task` to each of `others`, `task` blocking them, in one
 * transaction; with `asTarget` the others block `task` instead. */
const plantLinks = (
  fx: Fx,
  task: Doc<'issues'>,
  others: readonly Doc<'issues'>[],
  asTarget = false,
) =>
  fx.t.run(async (ctx) => {
    for (const other of others) {
      const [source, target] = asTarget ? [other, task] : [task, other]
      await ctx.db.insert('issue_links', {
        org_id: fx.org.id,
        id: uuid(),
        source_id: source.id,
        target_id: target.id,
        type: 'blocks',
        pair_key: [source.id, target.id].sort().join(':'),
        created_at: NOW,
      })
    }
  })

/* People named `names` in `fx`'s organization following `task`, in one
 * transaction, in that order. */
const plantFollowers = (fx: Fx, task: Doc<'issues'>, names: readonly string[]) =>
  fx.t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (const name of names) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: fx.org.id,
        name,
        initials: 'FO',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        plannable_hours: 40,
        created_at: NOW,
      })
      const profile = (await ctx.db.get(_id)) as Doc<'profiles'>
      await ctx.db.insert('issue_subscriptions', {
        issue_id: task.id,
        profile_id: profile.id,
        created_at: NOW,
      })
      out.push(profile)
    }
    return out
  })

/* A stored file of 12 bytes, which every planted attachment names. */
const storeFile = (t: T): Promise<Id<'_storage'>> =>
  t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(12)]) as never))

/* Attachments of `task`, one a `created_at` of `times`, in one transaction
 * in that order, each with its own over. */
async function plantAttachments(
  fx: Fx,
  task: Doc<'issues'>,
  times: readonly string[],
  over: Partial<Doc<'issue_attachments'>> = {},
): Promise<Doc<'issue_attachments'>[]> {
  const storage_id = await storeFile(fx.t)
  return await fx.t.run(async (ctx) => {
    const out: Doc<'issue_attachments'>[] = []
    for (const [i, created_at] of times.entries()) {
      const _id = await ctx.db.insert('issue_attachments', {
        id: uuid(),
        org_id: task.org_id,
        issue_id: task.id,
        name: `file-${i}.txt`,
        size_bytes: 12,
        mime: 'text/plain',
        storage_id,
        inline: false,
        uploaded_by: fx.user.id,
        created_at,
        ...over,
      })
      out.push((await ctx.db.get(_id)) as Doc<'issue_attachments'>)
    }
    return out
  })
}

/* An instant `n` seconds after NOW. */
const at = (n: number) => new Date(Date.parse(NOW) + n * 1000).toISOString()

/* ------------------------------------------------------------- the calls */

type Row = { id: string }
type Paged = { next_cursor: string | null; rows: Row[] }

const reader = (caller: Doc<'profiles'>) => ({ callerId: caller.id, access: 'read' as const })

/* REST GET /v1/tasks/{ref}/<list> by `caller` with query `q`. */
async function restList(
  fx: Fx,
  caller: Doc<'profiles'>,
  list: TaskRelatedList,
  ref: string,
  q: Record<string, string> = {},
): Promise<Paged> {
  const args = { ...reader(caller), ref, ...q }
  switch (list) {
    case 'subtasks': {
      const out = await fx.t.query(internal.machine.records.restListSubtasks, args)
      return { next_cursor: out.next_cursor, rows: out.subtasks }
    }
    case 'links': {
      const out = await fx.t.query(internal.machine.records.restListLinks, args)
      return { next_cursor: out.next_cursor, rows: out.links }
    }
    case 'followers': {
      const out = await fx.t.query(internal.machine.records.restListFollowers, args)
      return { next_cursor: out.next_cursor, rows: out.followers }
    }
    case 'attachments': {
      const out = await fx.t.query(internal.machine.records.restListAttachments, args)
      return { next_cursor: out.next_cursor, rows: out.attachments }
    }
  }
}

/* MCP list_task_related by `caller` with arguments `a`, its text parsed. */
async function mcpList(
  fx: Fx,
  caller: Doc<'profiles'>,
  list: TaskRelatedList,
  ref: string,
  a: Record<string, unknown> = {},
): Promise<Paged & { keys: string[] }> {
  const text = await fx.t.query(internal.machine.records.mcpTaskRelated, {
    ...reader(caller),
    ref,
    list,
    ...a,
  })
  const raw = JSON.parse(text) as Record<string, unknown>
  return {
    next_cursor: raw.next_cursor as string | null,
    rows: raw[list] as Row[],
    keys: Object.keys(raw),
  }
}

type Details = Record<string, unknown> & {
  following: boolean
  has_more_subtasks: boolean
  progress: unknown
  group_remaining_hours: number | null
}

/* REST GET /v1/tasks/{ref} by `caller`. */
const restDetails = (fx: Fx, caller: Doc<'profiles'>, ref: string) =>
  fx.t.query(internal.machine.rest.getIssue, { today: TODAY, ...reader(caller), ref })

/* MCP get_task by `caller`, its text parsed. */
const mcpDetails = async (fx: Fx, caller: Doc<'profiles'>, ref: string): Promise<Details> =>
  JSON.parse(
    await fx.t.query(internal.machine.mcp.getIssue, { today: TODAY, ...reader(caller), ref }),
  ) as Details

/* The first page of `list` in task details `d`. */
const detailsPage = (d: Record<string, unknown>, list: TaskRelatedList): Paged => ({
  next_cursor: d[`${list}_next_cursor`] as string | null,
  rows: d[list] as Row[],
})

/** Every page `read` answers from the first, following next_cursor until it
 * is null, failing on a cursor that does not move. */
async function everyPage(read: (cursor: string | null) => Promise<Paged>, most = 500) {
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

async function refused(p: Promise<unknown>, code: RefusalCode, sentence: string): Promise<void> {
  const e = await expectRefusal(p, code)
  expect((e.data as Refusal).message).toBe(sentence)
}

const ids = (rows: readonly Row[]) => rows.map((r) => r.id)

const LISTS: readonly TaskRelatedList[] = ['subtasks', 'links', 'followers', 'attachments']

/* A task in FW with `n` of each related list: `n` active subtasks in FW,
 * `n` links to tasks in FW, `n` followers and `n` attachments, each list
 * in its order, which the answer gives. */
async function related(fx: Fx, n: number, over: Partial<Doc<'issues'>> = {}) {
  const [task] = await plantTasks(fx, 1, { title: 'Related', ...over })
  const subtasks = await plantTasks(fx, n, {
    parent_id: task.id,
    archived_at: over.archived_at,
  })
  const others = await plantTasks(fx, n)
  await plantLinks(fx, task, others)
  const followers = await plantFollowers(
    fx,
    task,
    Array.from({ length: n }, (_, i) => `Follower ${String(i).padStart(3, '0')}`),
  )
  const attachments = await plantAttachments(
    fx,
    task,
    Array.from({ length: n }, (_, i) => at(i)),
  )
  return {
    task,
    order: {
      subtasks: ids(subtasks),
      links: ids(others),
      followers: ids(followers),
      attachments: ids(attachments),
    } satisfies Record<TaskRelatedList, string[]>,
  }
}

/* ----------------------------------------------------------- HTTP calls */

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

/* An agent key of `agent`, for requests made over HTTP. */
async function agentKeyOf(t: T, agent: Doc<'profiles'>): Promise<string> {
  const key = `qva_${uuid().replace(/-/g, '')}${'0'.repeat(16)}`
  const key_hash = await sha256hex(key)
  await t.run((ctx) =>
    ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: agent.id,
      name: 'Related key',
      key_prefix: key.slice(0, 11),
      key_hash,
      created_at: NOW,
    }),
  )
  return key
}

/* Tool `name` over MCP's modern leg with `key` and `args`: the tool's text
 * and whether it is an error result. */
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
async function httpGet(t: T, key: string, path: string) {
  const res = await fetchPath(t, path, { headers: { Authorization: `Bearer ${key}` } })
  return { status: res.status, body: JSON.parse(res.text) as Record<string, unknown> }
}

/* ------------------------------------------------------------ 1. arguments */

describe('the arguments', () => {
  it('pages 50 rows by default and 1 to 200 on request, and refuses another limit, on both surfaces', async () => {
    const fx = await setup()
    const { task } = await related(fx, 51)
    for (const list of LISTS) {
      const sentence = RELATED_LIMITS[list].refusal
      const first = await restList(fx, fx.agent, list, task.id)
      expect(first.rows, list).toHaveLength(DEFAULT_PAGE_SIZE)
      expect(first.next_cursor, list).toEqual(expect.any(String))
      expect((await mcpList(fx, fx.agent, list, task.id)).rows, list).toHaveLength(50)
      expect((await restList(fx, fx.agent, list, task.id, { limit: '1' })).rows).toHaveLength(1)
      const whole = await mcpList(fx, fx.agent, list, task.id, { limit: 200 })
      expect(whole.rows, list).toHaveLength(51)
      expect(whole.next_cursor, list).toBeNull()
      for (const limit of ['0', '201', '1.5', 'x', ''])
        await refused(restList(fx, fx.agent, list, task.id, { limit }), 'rule', sentence)
      for (const limit of [0, 201, 1.5])
        await refused(mcpList(fx, fx.agent, list, task.id, { limit }), 'rule', sentence)
    }
    expect(LIMITS.listSubtasks.refusal).toBe(
      'limit must be a whole number of subtasks from 1 to 200.',
    )
    expect(LIMITS.listLinks.refusal).toBe(
      'limit must be a whole number of linked tasks from 1 to 200.',
    )
    expect(LIMITS.listFollowers.refusal).toBe(
      'limit must be a whole number of followers from 1 to 200.',
    )
    expect(LIMITS.listAttachments.refusal).toBe(
      'limit must be a whole number of attachments from 1 to 200.',
    )
  })

  it('takes an offset of 0 and refuses any other with the sentence that names the cursor', async () => {
    const fx = await setup()
    const { task } = await related(fx, 2)
    for (const list of LISTS) {
      const sentence = offsetRefusal(RELATED_NOUNS[list])
      for (const zero of ['0', '00'])
        expect((await restList(fx, fx.agent, list, task.id, { offset: zero })).rows).toHaveLength(2)
      for (const other of ['1', '-1', 'x'])
        await refused(
          restList(fx, fx.agent, list, task.id, { offset: other }),
          'bad_request',
          sentence,
        )
      expect((await mcpList(fx, fx.agent, list, task.id, { offset: 0 })).rows).toHaveLength(2)
      await refused(mcpList(fx, fx.agent, list, task.id, { offset: 1 }), 'bad_request', sentence)
    }
    expect(offsetRefusal(RELATED_NOUNS.links)).toBe(
      'offset does not apply to linked tasks; pass next_cursor as cursor',
    )
  })

  it('checks the limit, then the offset, then the task, then the cursor', async () => {
    const fx = await setup()
    const { task } = await related(fx, 1)
    const hidden = (await plantTasks(fx, 1, { project_id: fx.hiddenSub.id }))[0]
    for (const list of LISTS) {
      const limit = RELATED_LIMITS[list].refusal
      await refused(
        restList(fx, fx.agent, list, hidden.id, { limit: '0', offset: '1' }),
        'rule',
        limit,
      )
      await refused(
        restList(fx, fx.agent, list, hidden.id, { offset: '1' }),
        'bad_request',
        offsetRefusal(RELATED_NOUNS[list]),
      )
      // a task the caller cannot read answers like an unknown one, before
      // the cursor is opened
      for (const ref of [hidden.id, 'QN-999999', 'not a ref']) {
        await refused(
          restList(fx, fx.agent, list, ref, { cursor: 'junk' }),
          'not_found',
          'task not found',
        )
        await refused(
          mcpList(fx, fx.agent, list, ref, { cursor: 'junk' }),
          'not_found',
          `task "${ref}" not found (or not visible to you)`,
        )
      }
      await refused(
        restList(fx, fx.agent, list, task.id, { cursor: 'junk' }),
        'bad_request',
        CURSOR_REFUSAL,
      )
      await refused(
        mcpList(fx, fx.agent, list, task.id, { cursor: 'junk', limit: 3 }),
        'bad_request',
        CURSOR_REFUSAL,
      )
    }
  })

  it('reads an empty REST cursor as absent, and refuses an empty MCP cursor', async () => {
    const fx = await setup()
    const { task } = await related(fx, 2)
    for (const list of LISTS) {
      const first = await restList(fx, fx.agent, list, task.id, { limit: '1' })
      expect(first.next_cursor, list).toEqual(expect.any(String))
      // cursors seal deterministically, so the same page answers the same one
      expect(await restList(fx, fx.agent, list, task.id, { limit: '1', cursor: '' })).toEqual(first)
      await refused(
        mcpList(fx, fx.agent, list, task.id, { cursor: '' }),
        'bad_request',
        CURSOR_REFUSAL,
      )
    }
  })

  it('refuses an unknown REST query parameter, a list outside the four and a fractional or text limit in MCP’s schema', async () => {
    const fx = await setup()
    const { task } = await related(fx, 1)
    const key = await agentKeyOf(fx.t, fx.agent)
    for (const list of LISTS) {
      const path = `/v1/tasks/QN-${task.num}/${list}`
      expect(await httpGet(fx.t, key, `${path}?page=2`)).toEqual({
        status: 400,
        body: { error: 'unknown query parameter "page"; this request takes limit, cursor, offset' },
      })
      const ok = await httpGet(fx.t, key, `${path}?limit=1&offset=0&cursor=`)
      expect(ok.status, path).toBe(200)
      expect(Object.keys(ok.body).sort()).toEqual([list, 'next_cursor'].sort())
      const tool = (args: Record<string, unknown>) =>
        mcpTool(fx.t, key, 'list_task_related', { ref: task.id, list, ...args })
      const schema = (issue: string) => ({
        text: `Input validation error: Invalid arguments for tool list_task_related: ${issue}`,
        isError: true,
      })
      expect(await tool({ limit: 1.5 })).toEqual(
        schema('limit: Invalid input: expected int, received number'),
      )
      expect(await tool({ limit: '1' })).toEqual(
        schema('limit: Invalid input: expected number, received string'),
      )
      expect(await tool({ limit: 0 })).toEqual({
        text: RELATED_LIMITS[list].refusal,
        isError: true,
      })
      // MCP's text puts the cursor first, before the rows
      const page = await tool({ limit: 1 })
      expect(page.isError).toBe(false)
      expect(Object.keys(JSON.parse(page.text))).toEqual(['next_cursor', list])
    }
    expect(await mcpTool(fx.t, key, 'list_task_related', { ref: task.id, list: 'labels' })).toEqual(
      {
        text: 'Input validation error: Invalid arguments for tool list_task_related: list: Invalid option: expected one of "subtasks"|"links"|"followers"|"attachments"',
        isError: true,
      },
    )
    expect((await mcpTool(fx.t, key, 'list_task_related', { ref: task.id })).isError).toBe(true)
  })
  it('refuses with pinned sentences, which the public docs quote', () => {
    const sentences = {
      [offsetRefusal('subtasks')]: 'offset does not apply to subtasks; pass next_cursor as cursor',
      [offsetRefusal('linked tasks')]:
        'offset does not apply to linked tasks; pass next_cursor as cursor',
      [offsetRefusal('followers')]:
        'offset does not apply to followers; pass next_cursor as cursor',
      [offsetRefusal('attachments')]:
        'offset does not apply to attachments; pass next_cursor as cursor',
      [relatedTooMany('subtasks')]:
        'this task has more subtasks than Qivo can list in one request. Contact support@qivo.io so we can help.',
      [relatedTooMany('linked tasks')]:
        'this task has more linked tasks than Qivo can list in one request. Contact support@qivo.io so we can help.',
      [relatedTooMany('followers')]:
        'this task has more followers than Qivo can list in one request. Contact support@qivo.io so we can help.',
      [relatedTooMany('attachments')]:
        'this task has more attachments than Qivo can list in one request. Contact support@qivo.io so we can help.',
      [CURSOR_REFUSAL]: 'cursor must be the next_cursor of an earlier page',
    }
    for (const [sent, pinned] of Object.entries(sentences)) expect(sent).toBe(pinned)
    expect(LISTS.map((list) => RELATED_NOUNS[list])).toEqual([
      'subtasks',
      'linked tasks',
      'followers',
      'attachments',
    ])
    const docs = import.meta.glob(['../../docs/rest-api.md', '../../docs/mcp.md'], {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>
    expect(Object.keys(docs)).toHaveLength(2)
    for (const [path, text] of Object.entries(docs)) {
      // a wrapped line reads as one space
      const prose = text.replace(/\s+/g, ' ')
      for (const pinned of [
        ...Object.values(sentences),
        ...LISTS.map((list) => RELATED_LIMITS[list].refusal),
      ])
        expect(prose, path).toContain(pinned)
    }
  })
})

/* -------------------------------------------------------------- 2. cursors */

describe('the cursors', () => {
  it('opens a cursor only for its list, task, caller, organization and selection', async () => {
    const fx = await setup()
    const a = await related(fx, 3)
    const b = await related(fx, 3)
    for (const list of LISTS) {
      const { next_cursor } = await restList(fx, fx.agent, list, a.task.id, { limit: '1' })
      const cursor = next_cursor as string
      // its own list and task continue
      expect(ids((await restList(fx, fx.agent, list, a.task.id, { cursor })).rows)).toEqual(
        a.order[list].slice(1),
      )
      const other = LISTS.find((l) => l !== list) as TaskRelatedList
      const changed = `${cursor.slice(0, -2)}${cursor.endsWith('aa') ? 'bb' : 'aa'}`
      for (const [what, read] of [
        ['another list', () => restList(fx, fx.agent, other, a.task.id, { cursor })],
        ['another task', () => restList(fx, fx.agent, list, b.task.id, { cursor })],
        ['another caller', () => restList(fx, fx.admin, list, a.task.id, { cursor })],
        ['a changed cursor', () => restList(fx, fx.agent, list, a.task.id, { cursor: changed })],
      ] as const) {
        await refused(read(), 'bad_request', CURSOR_REFUSAL).catch((e: Error) => {
          throw new Error(`${list}, ${what}: ${e.message}`)
        })
      }
    }
    // a cursor sealed for another organization, or with a position of
    // another shape, opens to a refusal
    const scope = (org: string, selection = '') => [org, fx.agent.id, a.task.id, selection]
    for (const [list, sealed] of [
      [
        'subtasks',
        await listCursorText('machine.task_subtasks', scope(fx.otherOrg.id, 'active'), {
          key: '',
          tie: [1],
        }),
      ],
      [
        'followers',
        await listCursorText('machine.task_followers', scope(fx.otherOrg.id), {
          key: 'a',
          tie: [uuid()],
        }),
      ],
      [
        'subtasks',
        await listCursorText('machine.task_subtasks', scope(fx.org.id, 'active'), {
          key: 'x',
          tie: [1],
        }),
      ],
      [
        'subtasks',
        await listCursorText('machine.task_subtasks', scope(fx.org.id, 'active'), {
          key: '',
          tie: ['1'],
        }),
      ],
      [
        'links',
        await listCursorText('machine.task_links', scope(fx.org.id), { key: '', tie: [1] }),
      ],
      [
        'attachments',
        await listCursorText('machine.task_attachments', scope(fx.org.id), { key: NOW, tie: [7] }),
      ],
    ] as const)
      await refused(
        restList(fx, fx.agent, list, a.task.id, { cursor: sealed }),
        'bad_request',
        CURSOR_REFUSAL,
      )
    // the same position, sealed rightly, opens
    const right = await listCursorText('machine.task_subtasks', scope(fx.org.id, 'active'), {
      key: '',
      tie: [0],
    })
    expect(
      ids((await restList(fx, fx.agent, 'subtasks', a.task.id, { cursor: right })).rows),
    ).toEqual(a.order.subtasks)
  })

  it('refuses a subtask cursor taken before the task was archived', async () => {
    const fx = await setup()
    const { task, order } = await related(fx, 3)
    const { next_cursor } = await restList(fx, fx.agent, 'subtasks', task.id, { limit: '1' })
    // the group and its subtasks archived, so the list is now all subtasks
    await fx.t.run(async (ctx) => {
      for (const id of [task.id, ...order.subtasks]) {
        const row = await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', id))
          .unique()
        if (row !== null) await ctx.db.patch(row._id, { archived_at: NOW })
      }
    })
    await refused(
      restList(fx, fx.agent, 'subtasks', task.id, { cursor: next_cursor as string }),
      'bad_request',
      CURSOR_REFUSAL,
    )
    // the links' cursors do not depend on it
    const links = await restList(fx, fx.agent, 'links', task.id, { limit: '1' })
    expect(links.rows).toHaveLength(1)
  })

  it('continues a details cursor on its list, a REST cursor on MCP, and lets limit change', async () => {
    const fx = await setup()
    const { task, order } = await related(fx, 55)
    const rest = await restDetails(fx, fx.agent, task.id)
    const mcp = await mcpDetails(fx, fx.agent, task.id)
    for (const list of LISTS) {
      const fromRest = detailsPage(rest, list)
      const fromMcp = detailsPage(mcp, list)
      expect(ids(fromRest.rows), list).toEqual(order[list].slice(0, 50))
      expect(fromMcp).toEqual(fromRest)
      const rest2 = await restList(fx, fx.agent, list, task.id, {
        cursor: fromRest.next_cursor as string,
      })
      expect(ids(rest2.rows), list).toEqual(order[list].slice(50))
      expect(rest2.next_cursor).toBeNull()
      expect(
        await mcpList(fx, fx.agent, list, task.id, { cursor: fromMcp.next_cursor as string }),
      ).toMatchObject({ next_cursor: null, rows: rest2.rows })
      // a REST page's cursor continues on MCP, with another limit
      const two = await restList(fx, fx.agent, list, task.id, { limit: '2' })
      const three = await mcpList(fx, fx.agent, list, task.id, {
        cursor: two.next_cursor,
        limit: 3,
      })
      expect(ids([...two.rows, ...three.rows])).toEqual(order[list].slice(0, 5))
      // and the first page of a list call is the details' first page
      expect(await restList(fx, fx.agent, list, task.id)).toEqual(fromRest)
    }
  })
})

/* ----------------------------------------------------- 3. order and paging */

describe('order and paging', () => {
  it('lists every row once at any limit, in its order, against creation order, the end only at the end', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1, { title: 'Ordered' })
    const n = 23
    // numbers given out of creation order, the last created the lowest, as
    // Deleted items restores a task with its old number
    const nums = Array.from({ length: n }, (_, i) => (i === n - 1 ? 1_000 : 2_000 + ((i * 7) % n)))
    const subtasks = await plantTasks(fx, n, { parent_id: task.id }, nums)
    const others = await plantTasks(
      fx,
      n,
      {},
      nums.map((x) => x + 10_000),
    )
    // a few as the target of the link, read from the other range
    await plantLinks(fx, task, others.slice(0, 15))
    await plantLinks(fx, task, others.slice(15), true)
    // names in no order: two with one name key, whose id breaks the tie,
    // and "ßanne", which sorts after "Tom" by bytes, where localeCompare
    // puts it before
    const names = Array.from(
      { length: n - 4 },
      (_, i) => `Person ${String((i * 5) % 19).padStart(2, '0')}`,
    )
    const followers = await plantFollowers(fx, task, [
      ...names,
      'Sam Lee',
      'sam  LEE',
      'ßanne',
      'Tom',
    ])
    expect('ßanne'.localeCompare('Tom')).toBeLessThan(0)
    // creation times in no order, two equal, the last stored the oldest, as
    // a restore writes it
    const times = Array.from({ length: n }, (_, i) => at(i === n - 1 ? -5 : (i * 3) % 11))
    const files = await plantAttachments(fx, task, times)
    const byNum = (rows: Doc<'issues'>[]) =>
      [...rows].sort((x, y) => x.num - y.num).map((r) => r.id)
    const expected: Record<TaskRelatedList, string[]> = {
      subtasks: byNum(subtasks),
      links: byNum(others),
      followers: [...followers]
        .sort((x, y) => compareValues([nameKey(x.name), x.id], [nameKey(y.name), y.id]))
        .map((p) => p.id),
      attachments: [...files]
        .sort((x, y) => compareValues([x.created_at, x.id], [y.created_at, y.id]))
        .map((f) => f.id),
    }
    expect(expected.subtasks[0]).toBe(subtasks[n - 1].id)
    expect(expected.attachments[0]).toBe(files[n - 1].id)
    expect(expected.followers.indexOf(followers.at(-1)?.id ?? '')).toBeLessThan(
      expected.followers.indexOf(followers.at(-2)?.id ?? ''),
    )
    for (const list of LISTS) {
      for (const limit of [1, 2, 7, 50]) {
        const rest = await everyPage((cursor) =>
          restList(fx, fx.agent, list, task.id, {
            limit: String(limit),
            ...(cursor === null ? {} : { cursor }),
          }),
        )
        expect(ids(rest.rows), `${list} at ${limit}`).toEqual(expected[list])
        expect(rest.pages).toHaveLength(Math.ceil(n / limit))
        for (const page of rest.pages.slice(0, -1)) expect(page.rows).toHaveLength(limit)
        const mcp = await everyPage((cursor) =>
          mcpList(fx, fx.agent, list, task.id, { limit, ...(cursor === null ? {} : { cursor }) }),
        )
        expect(ids(mcp.rows), `${list} at ${limit} on MCP`).toEqual(expected[list])
      }
    }
  })

  it('answers each list’s rows in the shape of the details', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1)
    const [kid] = await plantTasks(fx, 1, { parent_id: task.id, title: 'Kid', status: 'done' })
    const [blocker] = await plantTasks(fx, 1, { title: 'Blocker' })
    await plantLinks(fx, task, [blocker], true)
    const [person] = await plantFollowers(fx, task, ['Ada Lovelace'])
    const [file] = await plantAttachments(fx, task, [at(0)])
    const page = async (list: TaskRelatedList) => (await restList(fx, fx.agent, list, task.id)).rows
    expect(await page('subtasks')).toEqual([
      { id: kid.id, key: `QN-${kid.num}`, title: 'Kid', status: 'done' },
    ])
    expect(await page('links')).toEqual([
      {
        kind: 'blocked_by',
        id: blocker.id,
        key: `QN-${blocker.num}`,
        title: 'Blocker',
        status: 'todo',
      },
    ])
    expect(await page('followers')).toEqual([{ id: person.id, name: 'Ada Lovelace' }])
    expect(await page('attachments')).toEqual([
      expect.objectContaining({
        id: file.id,
        name: 'file-0.txt',
        size_bytes: 12,
        content_type: 'text/plain',
        inline: false,
        uploaded_by_id: fx.user.id,
        uploaded_by_name: 'user',
        created_at: at(0),
        url: expect.stringContaining(`/files/${file.id}?`),
      }),
    ])
    const details = await restDetails(fx, fx.agent, task.id)
    for (const list of LISTS) expect(details[list], list).toEqual(await page(list))
  })
})

/* ---------------------------------------------------------- 4. visibility */

describe('visibility', () => {
  it('lists subtasks and links only where the caller can read the other task, for every kind of caller', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1)
    const shownKids = await plantTasks(fx, 3, { parent_id: task.id })
    const hiddenKids = await plantTasks(fx, 3, { parent_id: task.id, project_id: fx.hiddenSub.id })
    const shownEnds = await plantTasks(fx, 3)
    const hiddenEnds = await plantTasks(fx, 3, { project_id: fx.hiddenSub.id })
    // a task of another organization, which only bad data could link
    const foreign = await plantIssue(fx.t, {
      org_id: fx.otherOrg.id,
      project_id: fx.otherProject.id,
    })
    await plantLinks(fx, task, [...shownEnds, ...hiddenEnds, foreign])
    const ownRows = { subtasks: ids(shownKids), links: ids(shownEnds) }
    const allRows = {
      subtasks: ids([...shownKids, ...hiddenKids]),
      links: ids([...shownEnds, ...hiddenEnds]),
    }
    // the guest and the viewer hold Edit on TBED, the agent too; the admin
    // reads every project of its organization
    for (const [caller, rows] of [
      [fx.agent, ownRows],
      [fx.guest, ownRows],
      [fx.viewer, ownRows],
      [fx.admin, allRows],
    ] as const) {
      for (const list of ['subtasks', 'links'] as const) {
        const got = await restList(fx, caller, list, task.id, { limit: '2' })
        // a hidden row takes no place on a page: two rows and a cursor
        expect(got.rows, `${caller.name} ${list}`).toHaveLength(2)
        const every = await everyPage((cursor) =>
          restList(fx, caller, list, task.id, {
            limit: '2',
            ...(cursor === null ? {} : { cursor }),
          }),
        )
        expect(ids(every.rows).sort(), `${caller.name} ${list}`).toEqual([...rows[list]].sort())
        const details = await restDetails(fx, caller, task.id)
        expect(ids(details[list]).sort()).toEqual([...rows[list]].sort())
      }
    }
    // a read-only credential reads the same rows
    const readOnly = await fx.t.query(internal.machine.records.restListLinks, {
      callerId: fx.agent.id,
      access: 'read',
      ref: task.id,
    })
    expect(ids(readOnly.links).sort()).toEqual([...ownRows.links].sort())
  })

  it('lists a follower who lost sight of the task, and leaves out a dropped description image', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1)
    const [kept] = await plantFollowers(fx, task, ['Kept'])
    // a follower of another organization is never listed, as before
    await fx.t.run(async (ctx) => {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: fx.otherOrg.id,
        name: 'Elsewhere',
        initials: 'EL',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
      const other = (await ctx.db.get(_id)) as Doc<'profiles'>
      await ctx.db.insert('issue_subscriptions', {
        issue_id: task.id,
        profile_id: other.id,
        created_at: NOW,
      })
    })
    // the guest follows, and then loses its grant on TBED
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('issue_subscriptions', {
        issue_id: task.id,
        profile_id: fx.guest.id,
        created_at: NOW,
      })
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', fx.meta.id).eq('profile_id', fx.guest.id),
        )
        .unique()
      if (grant !== null) await ctx.db.delete(grant._id)
    })
    const [image] = await plantAttachments(fx, task, [at(0)], { inline: true })
    const [file] = await plantAttachments(fx, task, [at(1)])
    await plantAttachments(fx, task, [at(2)], { inline: true, dropped_at: at(3) })
    const followers = await restList(fx, fx.agent, 'followers', task.id)
    expect(ids(followers.rows)).toEqual([fx.guest.id, kept.id])
    const files = await restList(fx, fx.agent, 'attachments', task.id)
    expect(ids(files.rows)).toEqual([image.id, file.id])
  })
})

/* --------------------------------------------------------------- 5. facts */

describe('the facts', () => {
  it('answers following from the caller’s own follow, past the first page of followers', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1)
    // 59 followers named before "Relay", the agent's name, so it is the 60th
    await plantFollowers(
      fx,
      task,
      Array.from({ length: 59 }, (_, i) => `Follower ${String(i).padStart(2, '0')}`),
    )
    const follow = (following: boolean) =>
      fx.t.mutation(internal.machine.discussion.mcpSetFollowing, {
        callerId: fx.agent.id,
        access: 'write',
        ref: task.id,
        following,
      })
    await fx.t.run((ctx) =>
      ctx.db.insert('issue_subscriptions', {
        issue_id: task.id,
        profile_id: fx.agent.id,
        created_at: NOW,
      }),
    )
    for (const details of [
      await restDetails(fx, fx.agent, task.id),
      await mcpDetails(fx, fx.agent, task.id),
    ]) {
      expect(details.following).toBe(true)
      expect(ids(details.followers as Row[])).not.toContain(fx.agent.id)
      expect(details.followers_next_cursor).toEqual(expect.any(String))
    }
    const rest = await restList(fx, fx.agent, 'followers', task.id, {
      cursor: (await restDetails(fx, fx.agent, task.id)).followers_next_cursor as string,
    })
    expect(ids(rest.rows)).toContain(fx.agent.id)
    await follow(false)
    expect((await restDetails(fx, fx.agent, task.id)).following).toBe(false)
    expect((await mcpDetails(fx, fx.agent, task.id)).following).toBe(false)
    // another caller follows nothing here
    expect((await restDetails(fx, fx.admin, task.id)).following).toBe(false)
  })

  it('takes progress and group_remaining_hours from the walk, not the first subtask page', async () => {
    const fx = await setup()
    const [group] = await plantTasks(fx, 1, { title: 'Group' })
    // 100 active subtasks, the stored limit, 10 Done, each with 2 hours
    const kids = await plantTasks(fx, 100, { parent_id: group.id, remaining_hours: 2 })
    await fx.t.run(async (ctx) => {
      for (const kid of kids.slice(90)) await ctx.db.patch(kid._id, { status: 'done' })
    })
    for (const details of [
      await restDetails(fx, fx.agent, group.id),
      await mcpDetails(fx, fx.agent, group.id),
    ]) {
      expect(details.progress).toEqual({ done: 10, total: 100, percent: 10, partial: false })
      expect(details.group_remaining_hours).toBe(180)
      expect(details.subtasks as Row[]).toHaveLength(50)
      expect(details.has_more_subtasks).toBe(true)
      expect(details.subtasks_next_cursor).toEqual(expect.any(String))
    }
  })
})

/* ------------------------------------------------------- 6. links minted */

describe('download links', () => {
  it('mints links for the rows of the page in hand only', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1)
    await plantAttachments(
      fx,
      task,
      Array.from({ length: 23 }, (_, i) => at(i)),
    )
    minted.count = 0
    const page = await restList(fx, fx.agent, 'attachments', task.id, { limit: '7' })
    expect(page.rows).toHaveLength(7)
    expect(minted.count).toBe(7)
    minted.count = 0
    await mcpList(fx, fx.agent, 'attachments', task.id, { limit: 7, cursor: page.next_cursor })
    expect(minted.count).toBe(7)
    // the details' first page of 50 of 60
    const [many] = await plantTasks(fx, 1)
    await plantAttachments(
      fx,
      many,
      Array.from({ length: 60 }, (_, i) => at(i)),
    )
    minted.count = 0
    const details = await restDetails(fx, fx.agent, many.id)
    expect(details.attachments).toHaveLength(50)
    expect(minted.count).toBe(50)
    // a list the details have no room for mints nothing
    TASK_DETAILS.ranges = 0
    minted.count = 0
    expect((await restDetails(fx, fx.agent, many.id)).attachments).toEqual([])
    expect(minted.count).toBe(0)
  })
})

/* --------------------------------------------------- 7. an archived group */

describe('an archived group’s subtasks', () => {
  it('page in number order through the index, short pages carrying cursors, to the end', async () => {
    const fx = await setup()
    const [group] = await plantTasks(fx, 1, { title: 'Archived group', archived_at: NOW })
    // 120 archived subtasks, alternately by number in FW, which the agent
    // reads, and SKS, which it does not, numbered against creation order
    const kids = [
      ...(await plantTasks(
        fx,
        60,
        { parent_id: group.id, archived_at: NOW },
        Array.from({ length: 60 }, (_, i) => 10_000 - 2 * i),
      )),
      ...(await plantTasks(
        fx,
        60,
        { parent_id: group.id, archived_at: NOW, project_id: fx.hiddenSub.id },
        Array.from({ length: 60 }, (_, i) => 9_999 - 2 * i),
      )),
    ]
    const byNum = [...kids].sort((a, b) => a.num - b.num)
    const shown = byNum.filter((k) => k.project_id === fx.sub.id).map((k) => k.id)
    // a page reads at most 30 documents past its start
    Object.assign(SUBTASK_PAGE, { documents: 30 })
    const pages = await everyPage((cursor) =>
      restList(fx, fx.agent, 'subtasks', group.id, {
        limit: '50',
        ...(cursor === null ? {} : { cursor }),
      }),
    )
    expect(ids(pages.rows)).toEqual(shown)
    // the budget ended each page short, with a cursor
    expect(pages.pages.length).toBeGreaterThan(3)
    for (const page of pages.pages.slice(0, -1)) {
      expect(page.rows.length).toBeLessThan(50)
      expect(page.next_cursor).toEqual(expect.any(String))
    }
    const mcp = await everyPage((cursor) =>
      mcpList(fx, fx.agent, 'subtasks', group.id, {
        limit: 50,
        ...(cursor === null ? {} : { cursor }),
      }),
    )
    expect(ids(mcp.rows)).toEqual(shown)
    // the admin reads both sub-projects
    Object.assign(SUBTASK_PAGE, structuredClone(DEFAULTS.page))
    const all = await everyPage((cursor) =>
      restList(fx, fx.admin, 'subtasks', group.id, {
        limit: '50',
        ...(cursor === null ? {} : { cursor }),
      }),
    )
    expect(ids(all.rows)).toEqual(byNum.map((k) => k.id))
    expect(all.pages).toHaveLength(3)
    // the details' first page, and has_more_subtasks follows its cursor
    const details = await restDetails(fx, fx.agent, group.id)
    expect(ids(details.subtasks)).toEqual(shown.slice(0, 50))
    expect(details.has_more_subtasks).toBe(details.subtasks_next_cursor !== null)
    expect(details.has_more_subtasks).toBe(true)
    expect(details.progress).toMatchObject({ total: 60, partial: true })
  })

  it('counts a subtask the caller may not be shown at a fixed size, so a hidden title moves no page end', async () => {
    const fx = await setup()
    // 20 hidden subtasks before one the agent reads, by number, with short
    // titles under one group and the longest titles under another
    const pagesFor = async (title: string) => {
      const [group] = await plantTasks(fx, 1, { archived_at: NOW })
      await plantTasks(fx, 20, {
        parent_id: group.id,
        archived_at: NOW,
        project_id: fx.hiddenSub.id,
        title,
      })
      const [shown] = await plantTasks(fx, 1, { parent_id: group.id, archived_at: NOW })
      const read = await everyPage((cursor) =>
        restList(fx, fx.agent, 'subtasks', group.id, cursor === null ? {} : { cursor }),
      )
      expect(ids(read.rows)).toEqual([shown.id])
      return read.pages.length
    }
    // room for a few hidden subtasks at lib/limits.ts TASK_ROW_MAX_BYTES
    Object.assign(SUBTASK_PAGE, { bytes: 10 * 1024 })
    const short = await pagesFor('x')
    const long = await pagesFor('x'.repeat(LIMITS.title.max))
    expect(short).toBeGreaterThan(3)
    expect(long).toBe(short)
  })

  it('reads the first row of a page whose budget is spent, so paging moves on', async () => {
    const fx = await setup()
    const [group] = await plantTasks(fx, 1, { archived_at: NOW })
    const kids = await plantTasks(fx, 5, { parent_id: group.id, archived_at: NOW })
    Object.assign(SUBTASK_PAGE, { ranges: 0, documents: 0, bytes: 0 })
    const pages = await everyPage((cursor) =>
      restList(fx, fx.agent, 'subtasks', group.id, cursor === null ? {} : { cursor }),
    )
    expect(ids(pages.rows)).toEqual(ids(kids))
    for (const page of pages.pages) expect(page.rows.length).toBeLessThanOrEqual(1)
    // a hidden first row moves the page on too, with no row
    const [hidden] = await plantTasks(fx, 1, { archived_at: NOW })
    await plantTasks(fx, 1, { parent_id: hidden.id, archived_at: NOW, project_id: fx.hiddenSub.id })
    const [shownKid] = await plantTasks(fx, 1, { parent_id: hidden.id, archived_at: NOW })
    const first = await restList(fx, fx.agent, 'subtasks', hidden.id)
    expect(first).toEqual({ next_cursor: expect.any(String), rows: [] })
    const second = await restList(fx, fx.agent, 'subtasks', hidden.id, {
      cursor: first.next_cursor as string,
    })
    expect(ids(second.rows)).toEqual([shownKid.id])
  })
})

/* ------------------------------------------------------ 8. bounds and room */

describe('bounds and room', () => {
  it('refuses a list past RELATED_READ with its sentence, and the details answer it with no rows and a cursor at its start', async () => {
    const fx = await setup()
    RELATED_READ.rows = 5
    const over = await related(fx, 6)
    const within = await related(fx, 5)
    // three links each way, six in all, past one bound over both ranges
    const [both] = await plantTasks(fx, 1)
    await plantLinks(fx, both, await plantTasks(fx, 3))
    await plantLinks(fx, both, await plantTasks(fx, 3), true)
    for (const list of LISTS) {
      const sentence = relatedTooMany(RELATED_NOUNS[list])
      await refused(restList(fx, fx.agent, list, over.task.id), 'rule', sentence)
      await refused(mcpList(fx, fx.agent, list, over.task.id), 'rule', sentence)
      for (const details of [
        await restDetails(fx, fx.agent, over.task.id),
        await mcpDetails(fx, fx.agent, over.task.id),
      ]) {
        const first = detailsPage(details, list)
        expect(first.rows, list).toEqual([])
        expect(first.next_cursor, list).toEqual(expect.any(String))
        // the cursor at its start says why on the list's own route
        await refused(
          restList(fx, fx.agent, list, over.task.id, { cursor: first.next_cursor as string }),
          'rule',
          sentence,
        )
      }
      expect(ids((await restList(fx, fx.agent, list, within.task.id)).rows)).toEqual(
        within.order[list],
      )
    }
    await refused(restList(fx, fx.agent, 'links', both.id), 'rule', relatedTooMany('linked tasks'))
    expect(relatedTooMany('followers')).toBe(
      'this task has more followers than Qivo can list in one request. Contact support@qivo.io so we can help.',
    )
  })

  it('answers a list the details had no room for with no rows and a cursor at its start, which the list call reads', async () => {
    const fx = await setup()
    const { task, order } = await related(fx, 3)
    // the followers fit, one range and one read each, and nothing more
    TASK_DETAILS.ranges = 4
    const details = await restDetails(fx, fx.agent, task.id)
    expect(ids(details.followers)).toEqual(order.followers)
    expect(details.followers_next_cursor).toBeNull()
    for (const list of ['links', 'attachments'] as const) {
      expect(details[list], list).toEqual([])
      const cursor = details[`${list}_next_cursor`]
      expect(cursor, list).toEqual(expect.any(String))
      expect(
        ids((await restList(fx, fx.agent, list, task.id, { cursor: cursor as string })).rows),
      ).toEqual(order[list])
    }
    // an active task's subtasks come from its walk, outside this room
    expect(ids(details.subtasks)).toEqual(order.subtasks)
    // an archived group's page reads its first row whatever the room says
    TASK_DETAILS.ranges = 0
    const archived = await related(fx, 3, { archived_at: NOW })
    const shelved = await restDetails(fx, fx.agent, archived.task.id)
    expect(ids(shelved.subtasks)).toEqual(archived.order.subtasks.slice(0, 1))
    expect(shelved.has_more_subtasks).toBe(true)
  })

  it('keeps a write’s answer within the room the write left', async () => {
    // the cascade reads each subtask twice, which leaves the answer little
    // room for its pages, as convex/tests/taskLists.test.ts's case does
    const fx = await setup(newT({ transactionLimits: { documentsRead: 800 } }))
    Object.assign(TASK_READ_RESERVE, { ranges: 16, documents: 500, bytes: 1 << 20 })
    const [group] = await plantTasks(fx, 1, { title: 'Group' })
    const kids = await plantTasks(fx, 100, { parent_id: group.id })
    await plantFollowers(fx, group, ['Ada', 'Bo', 'Cy'])
    const answer = await fx.t.mutation(internal.machine.rest.updateIssue, {
      callerId: fx.agent.id,
      access: 'write',
      keyName: 'related test',
      ref: group.id,
      body: JSON.stringify({ archived: true }),
    })
    expect(answer.archived_at).not.toBeNull()
    expect(answer.subtasks.length).toBeLessThan(50)
    expect(ids(answer.subtasks)).toEqual(ids(kids).slice(0, answer.subtasks.length))
    expect(answer.has_more_subtasks).toBe(true)
    // a list it had no room for is never shown as complete
    for (const list of LISTS) {
      const page = detailsPage(answer, list)
      if (page.next_cursor === null) expect(list).toBe('links')
    }
    expect(answer.followers.length === 3 || answer.followers_next_cursor !== null).toBe(true)
  })
})

/* --------------------------------------------------------------- 9. access */

describe('access', () => {
  /* A seat who reads FW through a grant and PCB through Hardware's share,
   * a task in FW with a subtask and a link in PCB. */
  async function shared(fx: Fx) {
    const me = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Shared seat', accepted_at: NOW })
    await fx.t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: fx.sub.id,
        profile_id: me.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: fx.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: fx.sub2.id,
        team_id: fx.team.id,
        level: 'user',
      })
    })
    const [task] = await plantTasks(fx, 1)
    const [kid] = await plantTasks(fx, 1, { parent_id: task.id, project_id: fx.sub2.id })
    const [end] = await plantTasks(fx, 1, { project_id: fx.sub2.id })
    await plantLinks(fx, task, [end])
    return { me, task, kid, end }
  }

  it('refuses the details and the list calls whole with the access sentence where a check stops', async () => {
    const fx = await setup()
    const { me, task, kid, end } = await shared(fx)
    expect(ids((await restDetails(fx, me, task.id)).subtasks)).toEqual([kid.id])
    expect(ids((await restList(fx, me, 'links', task.id)).rows)).toEqual([end.id])
    // the shares on PCB and the seat's own rows past the bounds, and no
    // room to ask a team by itself
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, teamReads: 0 })
    const refusal = async (p: Promise<unknown>) => {
      const e = await expectRefusal(p, 'rule')
      expect(e.data.reason).toBe(ACCESS_UNCHECKED)
      expect(e.data.message).toBe(
        'Qivo could not finish checking which projects you can see in one request. Contact support@qivo.io so we can help.',
      )
    }
    await refusal(restDetails(fx, me, task.id))
    await refusal(mcpDetails(fx, me, task.id))
    for (const list of ['subtasks', 'links'] as const) {
      await refusal(restList(fx, me, list, task.id))
      await refusal(mcpList(fx, me, list, task.id))
    }
    // a list that names no other task asks nothing and answers
    expect((await restList(fx, me, 'followers', task.id)).rows).toEqual([])
  })

  it('stops an archived walk before a question about a project its room no longer holds', async () => {
    // a request of 100 index ranges, of which the walk keeps 16 back
    const fx = await setup(newT({ transactionLimits: { databaseQueries: 100 } }))
    Object.assign(TASK_READ_RESERVE, { ranges: 16, documents: 64, bytes: 1 << 20 })
    // an archived group stored before the rule of one level: one subtask
    // in FW, and under it 30 more in 30 sub-projects of TBED, which only
    // the walk meets, each a question of a few ranges
    const [group] = await plantTasks(fx, 1, { archived_at: NOW })
    const [kid] = await plantTasks(fx, 1, { parent_id: group.id, archived_at: NOW })
    const subs = await plantSubProjects(fx, 30, { under: fx.meta })
    for (const sub of subs)
      await plantTasks(fx, 1, { parent_id: kid.id, archived_at: NOW, project_id: sub.id })
    for (const details of [
      await restDetails(fx, fx.agent, group.id),
      await mcpDetails(fx, fx.agent, group.id),
    ]) {
      // the walk stopped short of the request's limits, so the group's
      // facts say they are unknown and its first page still lists the kid
      expect(details.progress).toEqual({ done: 0, total: 0, percent: 0, partial: true })
      expect(ids(details.subtasks as Row[])).toEqual([kid.id])
    }
    // with room for every question the walk reads the group whole
    Object.assign(TASK_READ_RESERVE, structuredClone(DEFAULTS.reserve))
    const roomy = await setup()
    const [whole] = await plantTasks(roomy, 1, { archived_at: NOW })
    const [under] = await plantTasks(roomy, 1, { parent_id: whole.id, archived_at: NOW })
    for (const sub of await plantSubProjects(roomy, 30, { under: roomy.meta }))
      await plantTasks(roomy, 1, { parent_id: under.id, archived_at: NOW, project_id: sub.id })
    expect((await restDetails(roomy, roomy.agent, whole.id)).progress).toMatchObject({
      total: 30,
      partial: false,
    })
  })

  it('reads the projects an archived group’s subtree and links name, never the organization’s', async () => {
    const fx = await setup()
    const [group] = await plantTasks(fx, 1, { archived_at: NOW })
    await plantTasks(fx, 3, { parent_id: group.id, archived_at: NOW })
    await plantLinks(fx, group, await plantTasks(fx, 2, { project_id: fx.sub2.id }))
    const measure = () =>
      fx.t.query(async (ctx) => {
        const read = await readsOf(ctx, () =>
          handlerOf<Record<string, unknown>, unknown>(restGetIssue)(ctx, {
            today: TODAY,
            ...reader(fx.agent),
            ref: group.id,
          }),
        )
        return { ranges: read.ranges, documents: read.documents }
      })
    const before = await measure()
    // 300 more projects of the organization, which a read of the
    // catalogue read
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 300; i++)
        await ctx.db.insert('projects', {
          id: uuid(),
          org_id: fx.org.id,
          type: i % 2 === 0 ? 'meta' : 'project',
          key: `Z${i}`,
          name: `Elsewhere ${i}`,
          description: '',
          sort_order: 1_000 + i,
          num: 1_000 + i,
          track_delay: false,
          created_at: NOW,
        })
    })
    expect(await measure()).toEqual(before)
    expect(before.documents).toBeLessThan(100)
  })
})

/* ------------------------------------------------------------ 10. comments */

describe('comment pages', () => {
  it('names a page’s authors and editors from their own profiles, never the roster', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1)
    // an organization of 200 people
    const people = await plantFollowers(
      fx,
      (await plantTasks(fx, 1))[0],
      Array.from({ length: 195 }, (_, i) => `Person ${i}`),
    )
    const gone = uuid()
    const authors = [people[0].id, people[1].id, gone]
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 10; i++)
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: task.id,
          author: authors[i % 3],
          body: `Comment ${i}`,
          created_at: at(i),
          ...(i === 4 ? { edited_at: at(20), edited_by: people[2].id } : {}),
        })
    })
    const measure = (fn: unknown) =>
      fx.t.query(async (ctx) =>
        readsOf(ctx, () =>
          handlerOf<Record<string, unknown>, unknown>(fn)(ctx, {
            ...reader(fx.agent),
            ref: task.id,
          }),
        ),
      )
    const rest = await measure(restListComments)
    const rows = rest.out as {
      author_id: string | null
      author_name: string | null
      edited_by_name: string | null
    }[]
    expect(rows.map((c) => c.author_name)).toEqual(
      Array.from({ length: 10 }, (_, i) => [people[0].name, people[1].name, null][i % 3]),
    )
    expect(rows[4].edited_by_name).toBe(people[2].name)
    const mcp = await measure(mcpListComments)
    expect(JSON.parse(mcp.out as string)).toHaveLength(10)
    // the task, its comments and four people asked by id (one gone), where
    // the roster read 200 profiles
    for (const read of [rest, mcp]) expect(read.documents).toBeLessThan(40)
  })
})

/* ---------------------------------------------------- 11. the design size */

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

/* Each call by `caller` of `ref`, measured and logged under `name`: the
 * details on both surfaces, also with TASK_DETAILS at 0, whose difference
 * is what the first pages read, and each list at limit 200. Every read
 * stays inside Convex's limits for one request. */
async function measureTask(fx: Fx, caller: Doc<'profiles'>, ref: string, name: string) {
  const args = { ...reader(caller), ref }
  const read = (fn: unknown, more: Record<string, unknown> = {}) =>
    fx.t.query((ctx) =>
      readsOf(ctx, () =>
        handlerOf<Record<string, unknown>, unknown>(fn)(ctx, { ...args, ...more }),
      ),
    )
  const reads: Record<string, Awaited<ReturnType<typeof read>>> = {
    'REST details': await read(restGetIssue, { today: TODAY }),
    'MCP details': await read(mcpGetIssue, { today: TODAY }),
  }
  const details = structuredClone(TASK_DETAILS)
  Object.assign(TASK_DETAILS, { ranges: 0, documents: 0, bytes: 0 })
  const bare = await read(restGetIssue, { today: TODAY })
  Object.assign(TASK_DETAILS, details)
  reads['REST subtasks at 200'] = await read(restListSubtasks, { limit: '200' })
  reads['REST links at 200'] = await read(restListLinks, { limit: '200' })
  reads['REST followers at 200'] = await read(restListFollowers, { limit: '200' })
  reads['REST attachments at 200'] = await read(restListAttachments, { limit: '200' })
  reads['MCP links at 200'] = await read(mcpTaskRelated, { list: 'links', limit: 200 })
  const lines = Object.entries(reads).map(
    ([call, r]) =>
      `${call} ${r.ranges} ranges, ${r.documents} documents, ${(r.bytes / 1e6).toFixed(2)} MB`,
  )
  const pages = reads['REST details']
  lines.push(
    `first pages ${pages.ranges - bare.ranges} ranges, ${pages.documents - bare.documents} documents, ` +
      `${((pages.bytes - bare.bytes) / 1e6).toFixed(2)} MB`,
  )
  console.log(`[task details at the design size] ${name}: ${lines.join('; ')}`)
  for (const r of Object.values(reads)) {
    expect(r.ranges).toBeLessThan(4096)
    expect(r.documents).toBeLessThan(32_000)
    expect(r.bytes).toBeLessThan(16 * 1024 * 1024)
  }
  return {
    reads,
    firstPages: { ranges: pages.ranges - bare.ranges, documents: pages.documents - bare.documents },
  }
}

/* `count` sub-projects with `per` under each of as many top-level projects
 * as that takes, the first `archived` of them archived, in one
 * transaction; `under` puts them all under one top-level project. */
const plantSubProjects = (
  fx: Fx,
  count: number,
  o: { per?: number; archived?: number; under?: Doc<'projects'> } = {},
) =>
  fx.t.run(async (ctx) => {
    const subs: Doc<'projects'>[] = []
    let top = o.under ?? null
    for (let i = 0; i < count; i++) {
      if (o.under === undefined && i % (o.per ?? 3) === 0) {
        const _id = await ctx.db.insert('projects', {
          id: uuid(),
          org_id: fx.org.id,
          type: 'meta',
          key: `M${nextNum}`,
          name: `Family ${nextNum++}`,
          description: '',
          sort_order: nextNum,
          num: nextNum,
          track_delay: false,
          created_at: NOW,
        })
        top = (await ctx.db.get(_id)) as Doc<'projects'>
      }
      const _id = await ctx.db.insert('projects', {
        id: uuid(),
        org_id: fx.org.id,
        type: 'project',
        parent_id: top?.id,
        key: `S${nextNum}`,
        name: `Sub-project ${nextNum++}`,
        description: '',
        sort_order: nextNum,
        num: nextNum,
        track_delay: false,
        created_at: NOW,
        ...(i < (o.archived ?? 0) ? { archived_at: NOW } : {}),
      })
      subs.push((await ctx.db.get(_id)) as Doc<'projects'>)
    }
    return subs
  })

describe('reads at the design size', () => {
  it('the details of an active group at the four per-task limits’ sum, and each list at 200', async () => {
    const fx = await setup()
    const { task } = await related(fx, 100)
    // 20 labels, the label limit
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        const id = uuid()
        await ctx.db.insert('labels', {
          id,
          org_id: fx.org.id,
          name: `Label ${i}`,
          name_lower: `label ${i}`,
          color: '#4C9AFF',
          created_at: NOW,
        })
        await ctx.db.insert('issue_labels', { org_id: fx.org.id, issue_id: task.id, label_id: id })
      }
    })
    const { reads, firstPages } = await measureTask(
      fx,
      fx.agent,
      task.id,
      'a group at the four limits',
    )
    const details = reads['REST details'].out as Record<string, unknown>
    for (const list of LISTS) expect(details[list], list).toHaveLength(50)
    expect(details.labels).toHaveLength(20)
    expect(firstPages.ranges).toBeLessThan(TASK_DETAILS.ranges)
    expect(firstPages.documents).toBeLessThan(TASK_DETAILS.documents)
  })

  it('a task whose 100 links reach 100 sub-projects the caller reads by grant', async () => {
    const fx = await setup()
    const subs = await plantSubProjects(fx, 100)
    await fx.t.run(async (ctx) => {
      for (const sub of subs)
        await ctx.db.insert('project_access', {
          project_id: sub.id,
          profile_id: fx.agent.id,
          level: 'user',
        })
    })
    const [task] = await plantTasks(fx, 1)
    const ends = []
    for (const sub of subs) ends.push(...(await plantTasks(fx, 1, { project_id: sub.id })))
    await plantLinks(fx, task, ends)
    const { reads, firstPages } = await measureTask(
      fx,
      fx.agent,
      task.id,
      '100 links in 100 sub-projects',
    )
    expect((reads['REST links at 200'].out as { links: Row[] }).links).toHaveLength(100)
    expect((reads['REST details'].out as { links: Row[] }).links).toHaveLength(50)
    expect(firstPages.ranges).toBeLessThan(TASK_DETAILS.ranges)
  })

  it('an active group whose subtasks sit in 70 sub-projects of its project, 30 live and 40 archived', async () => {
    const fx = await setup()
    // 68 more under TBED beside FW and PCB, 40 of them archived
    const subs = [
      fx.sub,
      fx.sub2,
      ...(await plantSubProjects(fx, 68, { under: fx.meta, archived: 40 })),
    ]
    const [group] = await plantTasks(fx, 1)
    for (const [i, sub] of subs.entries())
      await plantTasks(fx, i < 30 ? 2 : 1, { parent_id: group.id, project_id: sub.id })
    const { reads } = await measureTask(
      fx,
      fx.agent,
      group.id,
      'an active group over 70 sub-projects',
    )
    const details = reads['REST details'].out as Details
    expect(details.progress).toMatchObject({ partial: false })
    expect((reads['REST subtasks at 200'].out as { subtasks: Row[] }).subtasks).toHaveLength(100)
  })

  it('an archived group whose subtasks sit in 70 sub-projects of its project, 30 live and 40 archived', async () => {
    const fx = await setup()
    const subs = [
      fx.sub,
      fx.sub2,
      ...(await plantSubProjects(fx, 68, { under: fx.meta, archived: 40 })),
    ]
    const [group] = await plantTasks(fx, 1, { archived_at: NOW })
    // three a sub-project, numbered so each page's rows come from all 70,
    // 210 in all, as far as a page at limit 200 reads
    for (let k = 0; k < 3; k++)
      for (const sub of subs)
        await plantTasks(fx, 1, { parent_id: group.id, project_id: sub.id, archived_at: NOW })
    const { reads } = await measureTask(
      fx,
      fx.agent,
      group.id,
      'an archived group over 70 sub-projects',
    )
    const page = reads['REST subtasks at 200'].out as {
      subtasks: Row[]
      next_cursor: string | null
    }
    expect(page.subtasks).toHaveLength(200)
    expect(page.next_cursor).toEqual(expect.any(String))
    const details = reads['REST details'].out as Details
    // in a live project's group, those in archived sub-projects do not count
    expect(details.progress).toMatchObject({ total: 90 })
    expect(details.subtasks as Row[]).toHaveLength(50)
  })

  it('a caller in 5 teams reading a task through a sub-project shared with 5 teams', async () => {
    const fx = await setup()
    const me = await plantSeat(fx.t, { org_id: fx.org.id, name: 'Teamed', accepted_at: NOW })
    const [sub] = await plantSubProjects(fx, 1, { under: fx.meta })
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: fx.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', { team_id: team, profile_id: me.id, is_leader: false })
        await ctx.db.insert('project_team_access', {
          project_id: sub.id,
          team_id: team,
          level: 'user',
        })
      }
    })
    // everyday values: a few subtasks, links, followers and files
    const [task] = await plantTasks(fx, 1, { project_id: sub.id })
    await plantTasks(fx, 3, { parent_id: task.id, project_id: sub.id })
    await plantLinks(fx, task, await plantTasks(fx, 3, { project_id: sub.id }))
    await plantFollowers(fx, task, ['Ada', 'Bo', 'Cy'])
    await plantAttachments(fx, task, [at(0), at(1), at(2)])
    const { reads } = await measureTask(
      fx,
      me,
      task.id,
      'a caller in 5 teams, a sub-project shared with 5',
    )
    const details = reads['REST details'].out as { subtasks: Row[]; links: Row[] }
    expect(details.subtasks).toHaveLength(3)
    expect(details.links).toHaveLength(3)
  })

  it('a comment page of 50 comments by 50 authors in an organization of 1,000 people', async () => {
    const fx = await setup()
    const [task] = await plantTasks(fx, 1)
    const people = await plantFollowers(
      fx,
      (await plantTasks(fx, 1))[0],
      Array.from({ length: 995 }, (_, i) => `Person ${String(i).padStart(3, '0')} Example`),
    )
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 50; i++)
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: task.id,
          author: people[i * 19].id,
          body: `An ordinary comment of a sentence or two, number ${i}.`,
          created_at: at(i),
        })
    })
    const lines: string[] = []
    for (const [call, fn] of [
      ['REST', restListComments],
      ['MCP', mcpListComments],
    ] as const) {
      const r = await fx.t.query((ctx) =>
        readsOf(ctx, () =>
          handlerOf<Record<string, unknown>, unknown>(fn)(ctx, {
            ...reader(fx.agent),
            ref: task.id,
          }),
        ),
      )
      lines.push(
        `${call} ${r.ranges} ranges, ${r.documents} documents, ${(r.bytes / 1e6).toFixed(2)} MB`,
      )
      expect(r.documents).toBeLessThan(200)
    }
    console.log(
      `[task details at the design size] a comment page of 50 by 50 authors of 1,000: ${lines.join('; ')}`,
    )
  })
})
