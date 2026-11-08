/* The inbox reads' stand-in (store/inboxStandIn.setup.ts) against the real
 * queries (convex/inbox.ts summary, item, page and feed, model/inboxReads.ts,
 * model/inboxPage.ts and model/notificationCatchup.ts) on convex-test, as
 * the other parity suites hold their stand-ins to the server. The stand-in
 * reads the messages the whole holds, here a seat's messages about the
 * tasks it is shown as the test oracle folds them
 * (convex/tests/inboxOracle.setup.ts). For every Northstar person with a
 * login it compares the summary, the item of every task they hold a
 * message about, the Inbox page in each order and filter, and the feed
 * after a floor before their newest message and after it, and for planted
 * cases a
 * snoozed group, a read group, a mention in the description alone and a
 * comment mention alone, a burst of 70 messages over 7 groups that the
 * feed cuts at its cap, with floors that leave 51, 50 and 49 events after
 * them, and an everyday Inbox of 60 groups over 3
 * projects, which holds a second page, a woken group and two groups at one
 * time, asked also with Unread only beside Show snoozed and beside a kind
 * filter, with a search by a task ID, a sub-project's name, a change
 * detail only an older message holds and the actor's name. A page's cursors differ by design, so the comparison
 * asks only whether one follows, and each side reads its second page at its
 * own `next`. `through` is the newest message's
 * _creationTime on the server, which the workspace's rows do not carry, so
 * the stand-in takes the created_at's ms and the comparison only asks for
 * a number. One difference is named. A message about a task the seat can
 * no longer see or an archived task, which neither counts, sets the
 * server's flag of the action that reaches it, as markAllRead and
 * removeRead do, and not the stand-in's, which sees only the shown
 * messages it is given; convex/tests/inboxReads.test.ts holds the server's
 * flags. So the comparison takes each flag the stand-in raises as one the
 * server raises, and each flag only the server raises as one a message
 * the oracle leaves out explains. Everyday sizes. */

import { describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { MENTION_DETAILS } from '../../convex/lib/messageDetails'
import { NOT_INBOX_CURSOR as SERVER_NOT_INBOX_CURSOR } from '../../convex/model/inboxPage'
import { wakeSnoozedItem } from '../../convex/model/messages'
import { FEED } from '../../convex/model/notificationCatchup'
import { NOTIFY } from '../../convex/model/notificationSessions'
import {
  as,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  wholeOf,
  withOrg,
} from '../../convex/tests/helpers.setup'
import { at, grant, markRead, post, snoozeIds } from '../../convex/tests/inboxItems.setup'
import { oracleInbox } from '../../convex/tests/inboxOracle.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import type { Whole } from './guard/liveDouble.setup'
import {
  FEED_EVENTS,
  FEED_LAG_MS,
  INBOX_NO_ANSWER,
  inboxFeedStandIn,
  inboxItemStandIn,
  inboxPageStandIn,
  inboxSummaryStandIn,
  NOT_INBOX_CURSOR,
  type PageAnswer,
  type PageArgs,
  type SummaryAnswer,
} from './inboxStandIn.setup'

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= 'inbox-parity-secret-not-a-deployment-key'
})

/** The whole the stand-in reads for `who`: the workspace `who` holds, and
    the messages about the tasks `who` is shown, as the oracle folds them,
    or a failure. */
async function workspace(
  t: T,
  who: Doc<'profiles'>,
): Promise<Whole & Pick<Required<Whole>, 'messages'>> {
  const ws = await wholeOf(t, who)
  if (!ws) throw new Error(`no workspace for ${who.name}`)
  const { unread, read } = await oracleInbox(t, who)
  const messages = [...unread, ...read].map(({ _id, ...m }) => m)
  return { ...ws, messages }
}

/** The unsnoozed messages of `who`, read (`read`) or not, as the server
    holds them, and as the stand-in reads them. */
async function unsnoozed(t: T, who: Doc<'profiles'>, ws: Whole, read: boolean) {
  const all = await t.run((ctx) =>
    ctx.db
      .query('messages')
      .withIndex('by_recipient', (q) => q.eq('recipient_id', who.id))
      .collect(),
  )
  const keep = (m: { snoozed_until?: string; read_at?: string }) =>
    m.snoozed_until === undefined && (m.read_at !== undefined) === read
  return {
    server: all.filter(keep).map((m) => m.id),
    shown: (ws.messages ?? []).filter(keep).map((m) => m.id),
  }
}

/** An item answer with its `through` replaced by whether it is a number. */
function shape(answer: unknown) {
  if (answer === INBOX_NO_ANSWER || !answer || typeof answer !== 'object') return answer
  if (!('item' in answer) || !answer.item || typeof answer.item !== 'object') return answer
  const { through, ...item } = answer.item as { through: unknown }
  return { ...answer, item: { ...item, through: typeof through } }
}

/** The server's summary and item answers for `who` and the stand-in's, over
    the tasks `tasks`. */
async function both(t: T, who: Doc<'profiles'>, tasks: readonly string[]) {
  const ws = await workspace(t, who)
  const caller = as(t, who)
  const summary = {
    server: await caller.query(api.inbox.summary, {}),
    stand: inboxSummaryStandIn(ws),
  }
  const items = []
  for (const issue_id of tasks) {
    const args = { org_id: who.org_id, issue_id }
    items.push({
      task: issue_id,
      server: shape(await caller.query(api.inbox.item, args)),
      stand: shape(inboxItemStandIn(ws, args)),
    })
  }
  return { summary, items, ws }
}

describe("the inbox reads' stand-in", () => {
  it('answers the summary and every item as the server does, for every Northstar person', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    let counted = 0
    let items = 0
    let named = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined)) {
      const ws = await workspace(t, person)
      const tasks = [...new Set(ws.messages.map((m) => m.issue_id))]
      const got = await both(t, person, tasks)
      const { seats: standSeats, ...stand } = got.summary.stand as SummaryAnswer
      const { seats: serverSeats, ...server } = got.summary.server
      expect(stand, person.name).toEqual(server)
      expect(standSeats.map((line) => [line.org_id, line.ready])).toEqual(
        serverSeats.map((line) => [line.org_id, line.ready]),
      )
      for (const [at, line] of serverSeats.entries())
        for (const [flag, read] of [
          ['can_mark_all_read', false],
          ['can_remove_read', true],
        ] as const) {
          const what = `${person.name} ${flag}`
          // the server's flag is whether such a message exists at all
          const rows = await unsnoozed(t, person, ws, read)
          expect(line[flag], what).toBe(rows.server.length > 0)
          if (standSeats[at][flag] === line[flag]) continue
          // only the server raises it, for messages the oracle leaves out
          expect(line[flag], what).toBe(true)
          const left = rows.server.filter((id) => !rows.shown.includes(id))
          expect(left.length, what).toBeGreaterThan(0)
          named++
        }
      for (const item of got.items)
        expect(item.stand, `${person.name} ${item.task}`).toEqual(item.server)
      counted += got.summary.server.unread_count
      items += got.items.filter((i) => (i.server as { item: unknown }).item !== null).length
    }
    // the seed leaves unread items, so the comparison counts something, and
    // read messages about archived tasks, which only the server's flag sees
    expect(counted).toBeGreaterThan(0)
    expect(items).toBeGreaterThanOrEqual(counted)
    expect(named).toBeGreaterThan(0)
  })

  it('answers a snoozed group, a read group and mentions in the description and in a comment alike', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const [unread, read, snoozed, described, mentioned, mixed] = [
      await task(),
      await task(),
      await task(),
      await task(),
      await task(),
      await task(),
    ]
    await post(t, f, { to: f.guest, task: unread, minute: 1 })
    await post(t, f, { to: f.guest, task: unread, minute: 2, kind: 'comment', body: 'New comment' })
    const readRow = await post(t, f, { to: f.guest, task: read, minute: 3 })
    if (!readRow) throw new Error('no message')
    await markRead(t, f.guest, [readRow.id])
    const snoozedRow = await post(t, f, { to: f.guest, task: snoozed, minute: 4 })
    if (!snoozedRow) throw new Error('no message')
    await snoozeIds(t, f.guest, [snoozedRow.id], new Date(Date.now() + 86_400_000).toISOString())
    // a mention in the description alone tells of a change, a comment's not
    await post(t, f, {
      to: f.guest,
      task: described,
      minute: 5,
      kind: 'mention',
      body: MENTION_DETAILS.description,
    })
    await post(t, f, {
      to: f.guest,
      task: mentioned,
      minute: 6,
      kind: 'mention',
      body: MENTION_DETAILS.comment,
    })
    // a read change and an unread comment mention, so nothing unread tells of one
    const change = await post(t, f, { to: f.guest, task: mixed, minute: 7 })
    if (!change) throw new Error('no message')
    await markRead(t, f.guest, [change.id])
    await post(t, f, {
      to: f.guest,
      task: mixed,
      minute: 8,
      kind: 'mention',
      body: MENTION_DETAILS.comment,
    })
    const tasks = [unread, read, snoozed, described, mentioned, mixed].map((x) => x.id)
    const got = await both(t, f.guest, [...tasks, (await task()).id])
    expect(got.summary.stand).toEqual(got.summary.server)
    expect(got.summary.server).toMatchObject({ unread_count: 4, complete: true })
    for (const item of got.items) expect(item.stand, item.task).toEqual(item.server)
    const change_ = (n: number) =>
      (got.items[n].server as { item: { unread_change: boolean } | null }).item?.unread_change
    expect([change_(0), change_(3), change_(4), change_(5)]).toEqual([true, true, false, false])
    // a task with no message holds no item
    expect(got.items[6].server).toEqual({ state: 'ok', item: null })
  })

  it('counts no message about a task the seat lost, where only the server flags it', async () => {
    const t = newT()
    const f: OrgFixture = await withOrg(t)
    const under = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const lost = await plantIssue(t, { org_id: f.org.id, project_id: under.id })
    const revoke = await grant(t, f.guest, f.hidden.id)
    await post(t, f, { to: f.guest, task: lost, minute: 1 })
    await revoke()
    const got = await both(t, f.guest, [lost.id])
    // neither counts it, and neither answers an item the seat is not shown
    expect(got.ws.messages).toEqual([])
    expect(got.summary.server).toMatchObject({ unread_count: 0, complete: true })
    expect(got.summary.stand).toMatchObject({ unread_count: 0, complete: true })
    expect(got.items[0].server).toEqual({ state: 'ok', item: null })
    expect(got.items[0].stand).toEqual({ state: 'ok', item: null })
    // the named difference: Mark all as read reaches it on the server
    expect(got.summary.server.seats).toEqual([
      { org_id: f.org.id, ready: true, can_mark_all_read: true, can_remove_read: false },
    ])
    expect(got.summary.stand).toMatchObject({
      seats: [{ org_id: f.org.id, ready: true, can_mark_all_read: false, can_remove_read: false }],
    })
  })
})

/* ------------------------------------------------------------- the page */

/** What a page answer says, its rows with `through` as its type and its
    `next` as whether one follows, since the cursors differ by design. */
function pageShape(answer: unknown) {
  if (answer === INBOX_NO_ANSWER || !answer || typeof answer !== 'object') return answer
  const { rows, next, ...rest } = answer as PageAnswer
  return {
    ...rest,
    next: next !== null,
    rows: rows.map((row) => ({ ...row, through: typeof row.through })),
  }
}

/** The order and filter sets every page comparison runs: each order with
    no filter, Unread only, Show snoozed and two kind filters. */
const PAGE_ASKS: PageArgs[] = (['newest', 'oldest'] as const).flatMap((order) => [
  { order, unread_only: false, include_snoozed: false, kinds: [] },
  { order, unread_only: true, include_snoozed: false, kinds: [] },
  { order, unread_only: false, include_snoozed: true, kinds: [] },
  { order, unread_only: false, include_snoozed: false, kinds: ['mention'] },
  { order, unread_only: false, include_snoozed: true, kinds: ['comment', 'change'] },
])

/** Unread only together with Show snoozed and with a kind filter, which
    the planted everyday Inbox asks besides PAGE_ASKS. */
const COMBINED_ASKS: PageArgs[] = (['newest', 'oldest'] as const).flatMap((order) => [
  { order, unread_only: true, include_snoozed: true, kinds: [] },
  { order, unread_only: true, include_snoozed: false, kinds: ['comment', 'change'] },
])

/** The server's first two pages for `who` with `args` and the stand-in's,
    each second page read at its own side's `next`. */
async function pagesOf(t: T, who: Doc<'profiles'>, args: PageArgs) {
  const ws = await workspace(t, who)
  const caller = as(t, who)
  const ask = { ...args, kinds: [...args.kinds] }
  const server = [await caller.query(api.inbox.page, ask)]
  const stand = [inboxPageStandIn(ws, ask) as PageAnswer]
  const serverNext = server[0].next
  const standNext = stand[0].next
  if (serverNext !== null)
    server.push(await caller.query(api.inbox.page, { ...ask, after: serverNext }))
  if (standNext !== null)
    stand.push(inboxPageStandIn(ws, { ...ask, after: standNext }) as PageAnswer)
  return { server: server.map(pageShape), stand: stand.map(pageShape) }
}

describe("the Inbox page's stand-in", () => {
  it('answers every Northstar person in each order and filter as the server does', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    let rows = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined))
      for (const args of PAGE_ASKS) {
        const got = await pagesOf(t, person, args)
        expect(got.stand, `${person.name} ${JSON.stringify(args)}`).toEqual(got.server)
        rows += (got.server[0] as { rows: unknown[] }).rows.length
      }
    // the seed leaves groups, so the comparison compares rows
    expect(rows).toBeGreaterThan(0)
  })

  it('answers an everyday Inbox of 60 groups over 3 projects on its first and second page, with a woken group and two at one time, and finds a row by its task ID, its project, a change detail and an actor', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const places = [f.sub, f.sub2, f.meta]
    const tasks: Doc<'issues'>[] = []
    for (let n = 0; n < 60; n++) {
      const task = await plantIssue(t, {
        org_id: f.org.id,
        project_id: places[n % 3].id,
        title: `Calibrate sensor ${n}`,
      })
      tasks.push(task)
      const kind = n % 5 === 0 ? 'mention' : n % 5 === 1 ? 'comment' : 'change'
      const body =
        kind === 'mention'
          ? MENTION_DETAILS.comment
          : kind === 'comment'
            ? 'New comment'
            : `Status ${n}`
      // an older change whose detail only the search of every message finds
      if (n === 12)
        await post(t, f, { to: f.guest, task, minute: -5, body: 'Firmware freeze approved' })
      // groups 30 and 31 at one time, which the order ties by task
      const minute = n === 31 ? 30 : n
      const row = await post(t, f, { to: f.guest, task, minute, kind, body })
      if (!row) throw new Error('no message')
      // every seventh group read, every eleventh snoozed
      if (n % 7 === 3) await markRead(t, f.guest, [row.id])
      if (n % 11 === 4)
        await snoozeIds(t, f.guest, [row.id], new Date(Date.now() + 86_400_000).toISOString())
    }
    // group 20 snoozed and woken after every other message, so its list
    // time is the wake's
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await guest.mutation(api.messages.snoozeItem, {
      org_id: f.org.id,
      issue_id: tasks[20].id,
      until,
    })
    await t.run((ctx) =>
      wakeSnoozedItem(ctx, { recipient_id: f.guest.id, issue_id: tasks[20].id, until }, at(90)),
    )
    for (const args of [...PAGE_ASKS, ...COMBINED_ASKS]) {
      const got = await pagesOf(t, f.guest, args)
      expect(got.stand, JSON.stringify(args)).toEqual(got.server)
    }
    // the browse holds a full first page and a second, the woken group first
    const browse = await pagesOf(t, f.guest, PAGE_ASKS[0])
    expect(browse.server).toHaveLength(2)
    const first = browse.server[0] as { rows: { issue_id: string; woke_at: string | null }[] }
    expect(first.rows).toHaveLength(50)
    expect(first.rows[0]).toMatchObject({ issue_id: tasks[20].id, woke_at: at(90) })
    // a search by a task ID, a sub-project's name, a change detail of an
    // older message and the actor's name
    for (const search of [`QN-${tasks[41].num}`, f.sub2.name, 'freeze approved', f.admin.name]) {
      const got = await pagesOf(t, f.guest, { ...PAGE_ASKS[0], search })
      expect(got.stand, search).toEqual(got.server)
      expect((got.server[0] as { rows: unknown[] }).rows.length, search).toBeGreaterThan(0)
    }
  })

  it('refuses a cursor of another list with the server’s sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ws = await workspace(t, f.guest)
    expect(NOT_INBOX_CURSOR).toBe(SERVER_NOT_INBOX_CURSOR)
    const ask = PAGE_ASKS[0]
    const refusal = (run: () => unknown) => {
      try {
        run()
      } catch (error) {
        return (error as { data?: unknown }).data
      }
      return null
    }
    expect(refusal(() => inboxPageStandIn(ws, { ...ask, after: 'not a cursor' }))).toEqual({
      code: 'bad_request',
      message: NOT_INBOX_CURSOR,
    })
    await expect(
      as(t, f.guest).query(api.inbox.page, { ...ask, kinds: [], after: 'not a cursor' }),
    ).rejects.toThrow(SERVER_NOT_INBOX_CURSOR)
  })
})

/* ------------------------------------------------------------- the feed */

describe("the feed's stand-in", () => {
  it('answers every Northstar person after a floor before their newest message and after it, as the server does', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    let events = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined)) {
      const ws = await workspace(t, person)
      const newest = Math.max(0, ...ws.messages.map((m) => Date.parse(m.created_at)))
      for (const after of [0, newest - 60 * 60_000, newest + 60_000]) {
        const server = await as(t, person).query(api.inbox.feed, { after })
        const stand = inboxFeedStandIn(ws, { after })
        expect(stand, `${person.name} after ${after}`).toEqual(server)
        events += server.events.length
      }
    }
    // the seed leaves unread events, so the comparison compares some
    expect(events).toBeGreaterThan(0)
  })

  it('cuts a burst over several groups at the server’s cap, with more only for an event after the floor', async () => {
    // the stand-in's copies of the server's bounds
    expect(FEED_EVENTS).toBe(FEED.events)
    expect(FEED_LAG_MS).toBe(NOTIFY.lag_ms)
    const t = newT()
    const f = await withOrg(t)
    const tasks: Doc<'issues'>[] = []
    for (let i = 0; i < 7; i++)
      tasks.push(await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }))
    // 70 messages over 7 groups, 600 ms apart from minute 10 on
    for (let i = 0; i < 70; i++)
      await post(t, f, { to: f.guest, task: tasks[i % 7], minute: 10 + 0.01 * i })
    const ws = await workspace(t, f.guest)
    // floors with 51, 50 and 49 events after them, the rest inside the
    // minute read back
    for (const [minute, more] of [
      [10.185, true],
      [10.195, false],
      [10.205, false],
    ] as const) {
      const after = Date.parse(at(minute))
      const server = await as(t, f.guest).query(api.inbox.feed, { after })
      expect(server.events, String(minute)).toHaveLength(FEED.events)
      expect(server.more, String(minute)).toBe(more)
      expect(inboxFeedStandIn(ws, { after }), String(minute)).toEqual(server)
    }
  })

  it('answers a woken group, a snoozed one, a read one and a mention as the server does', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const [woken, snoozed, read, mentioned] = [
      await task(),
      await task(),
      await task(),
      await task(),
    ]
    await post(t, f, { to: f.guest, task: woken, minute: 1 })
    const asleep = await post(t, f, { to: f.guest, task: snoozed, minute: 2 })
    const done = await post(t, f, { to: f.guest, task: read, minute: 3 })
    await post(t, f, { to: f.guest, task: mentioned, minute: 4, kind: 'mention' })
    if (!asleep || !done) throw new Error('no message')
    await markRead(t, f.guest, [done.id])
    const until = new Date(Date.now() + 86_400_000).toISOString()
    await snoozeIds(t, f.guest, [asleep.id], until)
    await as(t, f.guest).mutation(api.messages.snoozeItem, {
      org_id: f.org.id,
      issue_id: woken.id,
      until,
    })
    await t.run((ctx) =>
      wakeSnoozedItem(ctx, { recipient_id: f.guest.id, issue_id: woken.id, until }, at(90)),
    )
    const ws = await workspace(t, f.guest)
    for (const after of [Date.parse(at(-10)), Date.parse(at(3.5)), Date.parse(at(89.5))]) {
      const server = await as(t, f.guest).query(api.inbox.feed, { after })
      expect(inboxFeedStandIn(ws, { after }), String(after)).toEqual(server)
    }
    const all = await as(t, f.guest).query(api.inbox.feed, { after: Date.parse(at(-10)) })
    expect(all.events.map((e) => e.kind)).toEqual(['wake', 'mention', 'change'])
  })
})
