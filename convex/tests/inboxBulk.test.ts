/* The bulk inbox actions' planning read and their batch size
 * (convex/messages.ts bulkReach, model/messages.ts readBulkReach,
 * INBOX_BATCH). bulkReach says per seat whether Mark all as read or Remove
 * all read has nothing, one batch or more to do, on the ranges the batches
 * walk, and answers the cutoff a first Mark all as read batch would choose.
 * One batch at INBOX_BATCH stays below a quarter of every Convex limit in
 * the worst cases, with messages as long as the writers make them. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId, newWindowKey } from '../lib/db'
import { LIMITS, NAME_MAX } from '../lib/limits'
import { insertTask } from '../model/descriptions'
import { itemEdits } from '../model/inboxItems'
import {
  BULK_REACH,
  INBOX_BATCH,
  ITEM_UNREAD_CAP,
  markAllMessagesRead,
  removeReadMessages,
} from '../model/messages'
import { as, NOW, newT, type OrgFixture, plantSeat, type T, uuid, withOrg } from './helpers.setup'
import { at, drift } from './inboxItems.setup'

const DEFAULT_REACH = { ...BULK_REACH }
afterEach(() => {
  Object.assign(BULK_REACH, DEFAULT_REACH)
})

/* The caller's answer for `action`. */
const reachOf = (t: T, who: Doc<'profiles'>, action: 'read' | 'remove') =>
  as(t, who).query(api.messages.bulkReach, { action })

/** Stores `n` messages for `to` raw, each about a task of its own, unread
 * or read, `snoozed` or not, at minutes from `from`, 500 a transaction.
 * bulkReach reads the messages only, so no task or item is needed. */
async function plantRows(
  t: T,
  to: Doc<'profiles'>,
  n: number,
  a: { read?: boolean; snoozed?: boolean; from?: number } = {},
) {
  const from = a.from ?? 0
  for (let start = 0; start < n; start += 500)
    await t.run(async (ctx) => {
      for (let i = start; i < Math.min(n, start + 500); i++)
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: to.org_id,
          recipient_id: to.id,
          issue_id: uuid(),
          issue_title: 'Planted task',
          kind: 'change',
          detail: 'Status: To do → In progress',
          created_at: at(from + i),
          ...(a.read ? { read_at: NOW } : {}),
          ...(a.snoozed ? { snoozed_until: at(100_000) } : {}),
        })
    })
}

/** The fixture's admin and a second seat of the same login in the
 * fixture's other organization, in organization id order. */
async function twoSeats(t: T, f: OrgFixture) {
  const second = await plantSeat(t, {
    org_id: f.otherOrg.id,
    auth_user_id: f.admin.auth_user_id,
    name: 'admin',
  })
  return [f.admin, second].sort((a, b) => (a.org_id < b.org_id ? -1 : 1))
}

describe('bulkReach', () => {
  it(`answers none, one and many per seat at 0, ${INBOX_BATCH} and ${INBOX_BATCH + 1} rows of the walked range`, async () => {
    const t = newT()
    const f = await withOrg(t)
    const [first, second] = await twoSeats(t, f)
    for (const action of ['read', 'remove'] as const) {
      const answer = await reachOf(t, first, action)
      expect(answer.seats.map((s) => [s.org_id, s.reach])).toEqual([
        [first.org_id, 'none'],
        [second.org_id, 'none'],
      ])
    }
    const read = { read: true }
    await plantRows(t, first, INBOX_BATCH)
    await plantRows(t, second, INBOX_BATCH + 1)
    await plantRows(t, first, INBOX_BATCH + 1, read)
    // 0 read rows in the second seat
    // snoozed rows and other people's rows are not walked
    await plantRows(t, first, 40, { snoozed: true, from: 1_000 })
    await plantRows(t, first, 40, { snoozed: true, read: true, from: 1_000 })
    await plantRows(t, second, 40, { snoozed: true, read: true, from: 1_000 })
    await plantRows(t, f.user, 600)
    await plantRows(t, f.user, 600, read)
    await plantRows(t, f.otherAdmin, 600, read)
    expect((await reachOf(t, first, 'read')).seats.map((s) => s.reach)).toEqual(['one', 'many'])
    expect((await reachOf(t, second, 'remove')).seats.map((s) => s.reach)).toEqual(['many', 'none'])
    // Remove all read answers no cutoff
    for (const seat of (await reachOf(t, first, 'remove')).seats)
      expect(seat.before).toBeUndefined()
  })

  it('answers the cutoff a first markAllRead call chooses, which leaves a later arrival unread', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [first, second] = await twoSeats(t, f)
    await plantRows(t, first, 3)
    await plantRows(t, second, 2)
    // a snoozed unread row is the newest stored unread row of the first seat
    await plantRows(t, first, 1, { snoozed: true, from: 500 })
    const reach = await reachOf(t, first, 'read')
    expect(reach.seats).toEqual([
      { org_id: first.org_id, reach: 'one', before: expect.any(Number) },
      { org_id: second.org_id, reach: 'one', before: expect.any(Number) },
    ])
    // the first seat's first call chooses the same cutoff itself
    const unpassed = await as(t, first).mutation(api.messages.markAllRead, {
      org_id: first.org_id,
    })
    expect(unpassed).toMatchObject({ marked: 3, hasMore: false, before: reach.seats[0].before })
    // a message arrives after the press, then the second seat's first batch
    // goes with the cutoff the press answered
    await plantRows(t, second, 1, { from: 600 })
    const caller = as(t, second)
    const done = await caller.mutation(api.messages.markAllRead, {
      org_id: second.org_id,
      before: reach.seats[1].before,
    })
    expect(done).toMatchObject({ marked: 2, hasMore: false, before: reach.seats[1].before })
    const unread = await t.run((ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_recipient_read', (q) =>
          q.eq('recipient_id', second.id).eq('read_at', undefined),
        )
        .collect(),
    )
    expect(unread.map((r) => r.created_at)).toEqual([at(600)])
    // a first call without the cutoff would have marked it too
    expect(
      (await caller.mutation(api.messages.markAllRead, { org_id: second.org_id })).marked,
    ).toBe(1)
  })

  it('answers many for the seats past its budget, with the cutoff a first call chooses', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [first, second] = await twoSeats(t, f)
    await plantRows(t, first, INBOX_BATCH)
    await plantRows(t, second, 1)
    // the first seat's range passes a budget of 0.8 of its rows
    BULK_REACH.room = (INBOX_BATCH * 0.8) / 32_000
    const reach = (await reachOf(t, first, 'read')).seats
    expect(reach).toEqual([
      { org_id: first.org_id, reach: 'one', before: expect.any(Number) },
      { org_id: second.org_id, reach: 'many', before: expect.any(Number) },
    ])
    BULK_REACH.room = 0
    expect((await reachOf(t, first, 'remove')).seats).toEqual([
      { org_id: first.org_id, reach: 'many' },
      { org_id: second.org_id, reach: 'many' },
    ])
    // the skipped seat's cutoff is the one a first call there chooses, so a
    // message that arrives after the press stays unread
    Object.assign(BULK_REACH, DEFAULT_REACH)
    await plantRows(t, second, 1, { from: 900 })
    const done = await as(t, second).mutation(api.messages.markAllRead, {
      org_id: second.org_id,
      before: reach[1].before,
    })
    expect(done).toMatchObject({ marked: 1, hasMore: false, before: reach[1].before })
    expect((await reachOf(t, second, 'read')).seats[1]).toMatchObject({ reach: 'one' })
    // without the budget, Remove all read finds the message just marked
    expect((await reachOf(t, second, 'remove')).seats.map((s) => s.reach)).toEqual(['none', 'one'])
  })

  it('refuses a caller without a sign-in', async () => {
    const t = newT()
    await expect(t.query(api.messages.bulkReach, { action: 'read' })).rejects.toThrow(
      'not signed in',
    )
  })
})

/* --------------------------------------------------------- batch size */

/** A text of `n` characters in a three-byte script, the most bytes a
 * character-counted field holds (a four-byte character counts as two). */
const wide = (n: number) => '界'.repeat(n)

/** The longest detail a change notice can carry: every fragment
 * model/messages.ts notifyIssueUpdate writes at once, each name and title
 * at its longest in a three-byte script. An upper bound, as one change
 * writes fewer fragments. */
const LONGEST_DETAIL = [
  'Status: In progress → In review',
  'Priority: Urgent → Medium',
  `Title: “${wide(LIMITS.title.max)}” → “${wide(LIMITS.title.max)}”`,
  'Description updated',
  'Due: 30 Sep → 31 Dec',
  'Schedule: 30 Sep – 31 Dec → 30 Nov – 31 Dec',
  'Remaining: 1000 h → 2000 h',
  'Paused',
  `Moved to ${wide(NAME_MAX)}`,
  'Attached under a task in another sub-project',
  `Assigned to ${wide(NAME_MAX)}`,
  `Reviewer set to ${wide(NAME_MAX)}`,
].join('. ')

/** The fixture's admin's inbox: `items` tasks with the longest title, each
 * with `unread` unread messages and then `read` read ones, the newest, as
 * an item keeps them (model/messages.ts pruneReadMessages), every message
 * with the longest detail. Its inbox_items rows are complete and exact. */
async function plantInbox(
  t: T,
  f: OrgFixture,
  items: { unread: number; read: number }[],
): Promise<Doc<'profiles'>> {
  let minute = 0
  for (let start = 0; start < items.length; start += 32)
    await t.run(async (ctx) => {
      const edits = itemEdits(ctx)
      await edits.state(f.admin.id, 'ensure')
      for (const item of items.slice(start, start + 32)) {
        minute += item.unread + item.read
        await plantItem(ctx, f, edits, item, minute)
      }
      await edits.flush()
    })
  return f.admin
}

/* One task and its item for plantInbox, its messages at the minutes before
 * `end`. */
async function plantItem(
  ctx: MutationCtx,
  f: OrgFixture,
  edits: ReturnType<typeof itemEdits>,
  item: { unread: number; read: number },
  end: number,
) {
  const task = await plantTask(ctx, f, end)
  const count = item.unread + item.read
  for (let i = 0; i < count; i++)
    await plantLong(edits, f, task, {
      read: i >= item.unread,
      minute: end - count + i,
      woke: end,
      fresh: i === 0,
    })
}

/* A task with the longest title, numbered `num`. */
async function plantTask(ctx: MutationCtx, f: OrgFixture, num: number) {
  const task = {
    id: uuid(),
    org_id: f.org.id,
    project_id: f.sub.id,
    num,
    title: wide(LIMITS.title.max),
    description: '',
    status: 'todo' as const,
    priority: 'medium' as const,
    paused: false,
    created_at: NOW,
    updated_at: NOW,
    window_key: newWindowKey(),
  }
  await insertTask(ctx.db, task, 'restore')
  return task
}

/* One message to the fixture's admin about `task` with the longest detail,
 * read or unread, at `minute`, with the wake stamp of its item at minute
 * `woke` (a wake stamps every message of an item alike); `fresh` for the
 * first message of its item. */
async function plantLong(
  edits: ReturnType<typeof itemEdits>,
  f: OrgFixture,
  task: { id: string; title: string },
  m: { read: boolean; minute: number; woke: number; fresh: boolean },
) {
  await edits.insert(
    {
      id: uuid(),
      org_id: f.org.id,
      recipient_id: f.admin.id,
      actor_id: f.user.id,
      issue_id: task.id,
      issue_title: task.title,
      kind: 'change',
      detail: LONGEST_DETAIL,
      created_at: at(m.minute),
      // a woken item's stamp and the item cap's count, which an unread
      // message can carry too
      woke_at: at(m.woke),
      ...(m.read ? { read_at: NOW } : { dropped: 1_000_000 }),
    },
    f.sub.id,
    m.fresh,
  )
}

/** The fixture's admin's inbox as the costliest Mark all as read batch
 * meets it: `n` items, each with an older unread message, a newer unread
 * one and its newest message read, as an item keeps them
 * (model/messages.ts pruneReadMessages). Every older message is stored
 * before every newer one, so a batch takes only older ones. The batch then
 * reads each marked message four times (its range, its patch, the prune's
 * read and its delete) and, per item, the newer unread message, which the
 * prune seeks, and the read one. */
async function plantInterleaved(t: T, f: OrgFixture, n: number): Promise<Doc<'profiles'>> {
  const tasks: { id: string; title: string }[] = []
  for (const [pass, offset] of [
    ['older', 0],
    ['newer', 10_000],
    ['read', 20_000],
  ] as const)
    for (let start = 0; start < n; start += 32)
      await t.run(async (ctx) => {
        const edits = itemEdits(ctx)
        await edits.state(f.admin.id, 'ensure')
        for (let i = start; i < Math.min(n, start + 32); i++) {
          if (pass === 'older') tasks.push(await plantTask(ctx, f, i + 1))
          await plantLong(edits, f, tasks[i], {
            read: pass === 'read',
            minute: offset + i,
            woke: 30_000 + i,
            fresh: pass === 'older',
          })
        }
        await edits.flush()
      })
  return f.admin
}

/* Convex's limits for one transaction (docs.convex.dev/production/state/limits). */
const LIMIT = {
  bytesRead: 16 * 2 ** 20,
  documentsRead: 32_000,
  databaseQueries: 4_096,
  documentsWritten: 16_000,
  bytesWritten: 16 * 2 ** 20,
}

/** Runs `batch` once in a transaction of its own and answers what it
 * changed and the transaction's metrics. */
async function measure(
  t: T,
  who: Doc<'profiles'>,
  batch: (ctx: MutationCtx, me: Doc<'profiles'>) => Promise<number>,
) {
  return await t.run(async (ctx) => {
    const me = (await byId(ctx, 'profiles', who.id)) as Doc<'profiles'>
    const changed = await batch(ctx, me)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      changed,
      used: Object.fromEntries(
        (Object.keys(LIMIT) as (keyof typeof LIMIT)[]).map((key) => [key, m[key].used]),
      ) as Record<keyof typeof LIMIT, number>,
    }
  })
}

/* Each metric below a quarter of its limit. */
function expectQuarter(used: Record<keyof typeof LIMIT, number>) {
  for (const key of Object.keys(LIMIT) as (keyof typeof LIMIT)[])
    expect(used[key], key).toBeLessThan(LIMIT[key] / 4)
}

const markBatch = async (ctx: MutationCtx, me: Doc<'profiles'>) =>
  (await markAllMessagesRead(ctx, me, undefined, at(100_000))).marked.length
const removeBatch = async (ctx: MutationCtx, me: Doc<'profiles'>) =>
  (await removeReadMessages(ctx, me)).removed.length

describe('one batch at INBOX_BATCH', { timeout: 120_000 }, () => {
  it('stays below a quarter of every limit in its worst case, an older unread message in each item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const who = await plantInterleaved(t, f, INBOX_BATCH)
    const { changed, used } = await measure(t, who, markBatch)
    expect(changed).toBe(INBOX_BATCH)
    console.info(
      `Mark all as read, ${INBOX_BATCH} items of older unread, newer unread, newest read:`,
      used,
    )
    expectQuarter(used)
    expect(await drift(t)).toEqual([])
  })

  it('stays below a quarter of every limit when it marks one message in each of its items', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the prune then deletes the message the batch marked, as the item's
    // newest message is the read one
    const who = await plantInbox(
      t,
      f,
      Array.from({ length: INBOX_BATCH }, () => ({ unread: 1, read: 1 })),
    )
    const { changed, used } = await measure(t, who, markBatch)
    expect(changed).toBe(INBOX_BATCH)
    console.info(`Mark all as read, ${INBOX_BATCH} items of 1 unread and 1 read:`, used)
    expectQuarter(used)
    expect(await drift(t)).toEqual([])
  })

  it('stays below a quarter of every limit when it marks items of 51 messages', async () => {
    const t = newT()
    const f = await withOrg(t)
    // items at the cap (50 unread and the newest read), the batch's rows
    const full = Math.floor(INBOX_BATCH / ITEM_UNREAD_CAP)
    const rest = INBOX_BATCH - full * ITEM_UNREAD_CAP
    const who = await plantInbox(t, f, [
      ...Array.from({ length: full }, () => ({ unread: ITEM_UNREAD_CAP, read: 1 })),
      ...(rest > 0 ? [{ unread: rest, read: 1 }] : []),
    ])
    const { changed, used } = await measure(t, who, markBatch)
    expect(changed).toBe(INBOX_BATCH)
    console.info('Mark all as read, items of 51 messages:', used)
    expectQuarter(used)
    expect(await drift(t)).toEqual([])
  })

  it("stays below a quarter of every limit when it removes each of its items' newest message", async () => {
    const t = newT()
    const f = await withOrg(t)
    // each item then reads its newest remaining message
    const who = await plantInbox(
      t,
      f,
      Array.from({ length: INBOX_BATCH }, () => ({ unread: 1, read: 1 })),
    )
    const { changed, used } = await measure(t, who, removeBatch)
    expect(changed).toBe(INBOX_BATCH)
    console.info(`Remove all read, ${INBOX_BATCH} items losing their newest message:`, used)
    expectQuarter(used)
    expect(await drift(t)).toEqual([])
  })
})
