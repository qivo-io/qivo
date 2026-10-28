/* The bulk inbox actions' planning read (convex/messages.ts bulkReach,
 * model/messages.ts readBulkReach). It says per seat whether Mark all as
 * read or Remove all read has nothing, one batch or more to do, on the
 * ranges the batches walk, and answers the cutoff a first Mark all as read
 * batch would choose. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { BULK_REACH, INBOX_BATCH } from '../model/messages'
import { as, NOW, newT, type OrgFixture, plantSeat, type T, uuid, withOrg } from './helpers.setup'
import { at } from './inboxItems.setup'

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

  it('answers many without a cutoff for the seats past its budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [first, second] = await twoSeats(t, f)
    await plantRows(t, first, 200)
    await plantRows(t, second, 1)
    // 0.5% of 32,000 documents is 160: the first seat's rows pass it
    BULK_REACH.room = 0.005
    expect((await reachOf(t, first, 'read')).seats).toEqual([
      { org_id: first.org_id, reach: 'one', before: expect.any(Number) },
      { org_id: second.org_id, reach: 'many' },
    ])
    BULK_REACH.room = 0
    expect((await reachOf(t, first, 'remove')).seats).toEqual([
      { org_id: first.org_id, reach: 'many' },
      { org_id: second.org_id, reach: 'many' },
    ])
    // nothing to do in the second seat without the budget
    Object.assign(BULK_REACH, DEFAULT_REACH)
    expect((await reachOf(t, second, 'remove')).seats.map((s) => s.reach)).toEqual(['none', 'none'])
  })

  it('refuses a caller without a sign-in', async () => {
    const t = newT()
    await expect(t.query(api.messages.bulkReach, { action: 'read' })).rejects.toThrow(
      'not signed in',
    )
  })
})
