/* Inbox items (schema.ts inbox_items and inbox_state, model/inboxItems.ts):
 * every message write keeps a built recipient's items equal to what their
 * messages make (itemOf), the build state decides which items are kept,
 * every teardown deletes them with the messages, and
 * internal/inboxItemsBackfill builds the items of messages stored before
 * them. Each case compares every stored item with a build from the
 * messages (drift), so a write that leaves one item wrong fails. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { BUILD, RUN } from '../internal/inboxItemsBackfill'
import { byId } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { deleteOrgDeep } from '../model/cascade'
import { covers, type ItemFields, itemEdits, itemOf, REKEY } from '../model/inboxItems'
import {
  INLINE_TRIMS,
  ITEM_UNREAD_CAP,
  markAllMessagesRead,
  markMessagesRead,
  markMessagesUnread,
  newItemTrims,
  postMessage,
  readArchivedProjectMessages,
  readArchivedTaskMessages,
  removeMessages,
  removeReadMessages,
  snoozeMessages,
  wakeSnoozedItem,
} from '../model/messages'
import { wipeWorkStep } from '../model/orgDeletion'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantMessage,
  plantProject,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'
import { assertNoDanglingRefs } from './refs.setup'
import { deleteProject, deleteTask, installTrashTimers, itemFor, runSteps } from './trash.setup'

installTrashTimers()
const DEFAULT_BUILD = { ...BUILD }
const DEFAULT_RUN = { ...RUN }
const DEFAULT_REKEY = { ...REKEY }
afterEach(() => {
  Object.assign(BUILD, DEFAULT_BUILD)
  Object.assign(RUN, DEFAULT_RUN)
  Object.assign(REKEY, DEFAULT_REKEY)
})

const MINUTE = 60_000

/* An ISO instant `minutes` after NOW. */
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * MINUTE).toISOString()

/* The key of one item. */
const keyOf = (pair: { recipient_id: string; issue_id: string }) =>
  `${pair.recipient_id}:${pair.issue_id}`

/** Every difference between the stored items and what the messages make,
 * for every pair a recipient's build state covers, and every stored item
 * that no covered pair makes or that has a twin. [] when all are exact. */
const drift = (t: T): Promise<string[]> =>
  t.run(async (ctx) => {
    const out: string[] = []
    const states = new Map(
      (await ctx.db.query('inbox_state').collect()).map((s) => [s.profile_id, s] as const),
    )
    const pairs = new Map<string, Doc<'messages'>[]>()
    for (const m of await ctx.db.query('messages').collect()) {
      const rows = pairs.get(keyOf(m)) ?? []
      rows.push(m)
      pairs.set(keyOf(m), rows)
    }
    const items = new Map<string, Doc<'inbox_items'>>()
    for (const item of await ctx.db.query('inbox_items').collect()) {
      if (items.has(keyOf(item))) out.push(`twin ${keyOf(item)}`)
      items.set(keyOf(item), item)
      if (!covers(states.get(item.recipient_id) ?? null, item.issue_id))
        out.push(`uncovered ${keyOf(item)}`)
      if (!pairs.has(keyOf(item))) out.push(`no messages ${keyOf(item)}`)
    }
    for (const [key, rows] of pairs) {
      const pair = { recipient_id: rows[0].recipient_id, issue_id: rows[0].issue_id }
      if (!covers(states.get(pair.recipient_id) ?? null, pair.issue_id)) continue
      const task = await byId(ctx, 'issues', pair.issue_id)
      const want = itemOf(pair, rows, task?.project_id) as ItemFields
      const got = items.get(key)
      if (got === undefined) {
        out.push(`missing ${key}`)
        continue
      }
      for (const field of Object.keys(want) as (keyof ItemFields)[])
        if (want[field] !== got[field])
          out.push(`${key} ${field}: ${String(got[field])}, not ${String(want[field])}`)
    }
    return out
  })

/* The stored item of one pair, or null. */
const itemOfPair = (t: T, recipient_id: string, issue_id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('inbox_items')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', recipient_id).eq('issue_id', issue_id),
      )
      .unique(),
  )

/* The recipient's build state, or null. */
const stateOf = (t: T, profile_id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('inbox_state')
      .withIndex('by_profile', (q) => q.eq('profile_id', profile_id))
      .unique(),
  )

/* The pair's messages, oldest stored first. */
const pairRows = (t: T, recipient_id: string, issue_id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', recipient_id).eq('issue_id', issue_id),
      )
      .collect(),
  )

/** Posts one message through postMessage, the single insert path, at
 * minute `minute`, and answers its row. */
async function post(
  t: T,
  f: OrgFixture,
  a: { to: Doc<'profiles'>; task: Doc<'issues'>; minute: number; kind?: MessageKind },
): Promise<Doc<'messages'> | null> {
  return await t.run(async (ctx) => {
    const posted = await postMessage(ctx, {
      org_id: f.org.id,
      recipient_id: a.to.id,
      issue_id: a.task.id,
      kind: a.kind ?? 'change',
      body: `Update ${a.minute}`,
      actor_id: f.admin.id,
      now: at(a.minute),
    })
    if (!posted) return null
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', a.to.id).eq('issue_id', a.task.id),
      )
      .collect()
    return rows.reduce((newest, r) => (r._creationTime > newest._creationTime ? r : newest))
  })
}

const backfill = (t: T, args: { dry_run: boolean; rebuild?: boolean; cursor?: string | null }) =>
  t.action(internal.internal.inboxItemsBackfill.run, args)

/* Calls the backfill until it answers done, passing each cursor back as it
 * came, and answers every call's result. */
async function backfillAll(t: T, args: { dry_run: boolean; rebuild?: boolean }) {
  const calls = []
  let cursor: string | null = null
  for (let n = 0; n < 500; n++) {
    const got = await backfill(t, { ...args, cursor })
    calls.push(got)
    if (got.done) {
      expect(got.cursor).toBeNull()
      return calls
    }
    expect(got.cursor).not.toBeNull()
    cursor = got.cursor
  }
  throw new Error('the backfill did not finish in 500 calls')
}

/* The sum of `field` over the calls' results. */
const sum = <K extends string>(calls: Record<K, number>[], field: K) =>
  calls.reduce((n, c) => n + c[field], 0)

const check = (t: T, profile_id: string, after?: string) =>
  t.query(internal.internal.inboxItemsBackfill.check, { profile_id, after })

/* Two tasks in the fixture's sub-project, sorted by id, which is the
 * order the backfill builds items in. */
async function tasks(t: T, f: OrgFixture, n = 2): Promise<Doc<'issues'>[]> {
  const out: Doc<'issues'>[] = []
  for (let i = 0; i < n; i++)
    out.push(await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }))
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

describe('the item a message makes', () => {
  it('counts each kind, the unread messages and the newest one, and fails when a row is wrong', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [task] = await tasks(t, f, 1)
    expect(await stateOf(t, f.user.id)).toBeNull()
    await post(t, f, { to: f.user, task, minute: 1, kind: 'mention' })
    await post(t, f, { to: f.user, task, minute: 2, kind: 'comment' })
    const newest = await post(t, f, { to: f.user, task, minute: 3, kind: 'change' })
    // the first message to an empty inbox built its state
    expect(await stateOf(t, f.user.id)).toMatchObject({ built: true })
    expect(await itemOfPair(t, f.user.id, task.id)).toMatchObject({
      project_id: f.sub.id,
      latest_id: newest?.id,
      latest_at: at(3),
      sort_at: at(3),
      unread: true,
      unread_count: 3,
      dropped: 0,
      mentions: 1,
      comments: 1,
      changes: 1,
      snoozed: false,
      woke_rows: 0,
    })
    expect(await drift(t)).toEqual([])
    // the check fails a wrong count, a missing row and a row with no messages
    await t.run(async (ctx) => {
      const item = (await ctx.db.query('inbox_items').first())!
      await ctx.db.patch(item._id, { unread_count: 2 })
    })
    expect(await drift(t)).toEqual([expect.stringMatching(/unread_count: 2, not 3$/)])
    const found = await check(t, f.user.id)
    expect(found).toMatchObject({
      checked: 1,
      differ: [{ issue_id: task.id, fields: ['unread_count'] }],
    })
  })

  it('posts nothing to a hidden task and keeps no item for it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    expect(await post(t, f, { to: f.guest, task: hidden, minute: 1 })).toBeNull()
    expect(await itemOfPair(t, f.guest.id, hidden.id)).toBeNull()
    expect(await drift(t)).toEqual([])
  })
})

describe('every message write keeps the items exact', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('mark read, mark unread and remove, by the app and by the machine inbox', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    const a1 = (await post(t, f, { to: f.user, task: a, minute: 1 }))!
    const a2 = (await post(t, f, { to: f.user, task: a, minute: 2 }))!
    await post(t, f, { to: f.user, task: a, minute: 3, kind: 'comment' })
    const b1 = (await post(t, f, { to: f.user, task: b, minute: 4 }))!
    const user = as(t, f.user)
    await user.mutation(api.messages.markRead, { org_id: f.org.id, ids: [a1.id, a2.id] })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ unread_count: 1 })
    expect(await drift(t)).toEqual([])
    await user.mutation(api.messages.markUnread, { org_id: f.org.id, ids: [a1.id] })
    expect(await drift(t)).toEqual([])
    await user.mutation(api.messages.remove, { org_id: f.org.id, ids: [b1.id] })
    expect(await itemOfPair(t, f.user.id, b.id)).toBeNull()
    expect(await drift(t)).toEqual([])
    // the machine inbox acts on every row of the item (machine/discussion.ts)
    await t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', f.user.id))!
      const rows = () =>
        ctx.db
          .query('messages')
          .withIndex('by_recipient_issue', (q) => q.eq('recipient_id', me.id).eq('issue_id', a.id))
          .collect()
      await markMessagesRead(ctx, me, await rows(), at(10))
      await markMessagesUnread(ctx, me, await rows())
      await removeMessages(ctx, (await rows()).slice(0, 1))
    })
    expect(await drift(t)).toEqual([])
    await t.run(async (ctx) => {
      await removeMessages(ctx, await ctx.db.query('messages').collect())
    })
    expect(await t.run((ctx) => ctx.db.query('inbox_items').collect())).toEqual([])
  })

  it('the prune keeps the newest row, and a read newest row gives way to an arrival', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a] = await tasks(t, f, 1)
    const first = (await post(t, f, { to: f.user, task: a, minute: 1 }))!
    await as(t, f.user).mutation(api.messages.markRead, { org_id: f.org.id, ids: [first.id] })
    // a later arrival prunes the read row
    const next = (await post(t, f, { to: f.user, task: a, minute: 2 }))!
    expect((await pairRows(t, f.user.id, a.id)).map((m) => m.id)).toEqual([next.id])
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({
      latest_id: next.id,
      unread_count: 1,
    })
    // an arrival stored older than the read newest row is deleted at once
    await as(t, f.user).mutation(api.messages.markRead, { org_id: f.org.id, ids: [next.id] })
    await t.run(async (ctx) => {
      await ctx.db.patch(a._id, { archived_at: at(3) })
      await postMessage(ctx, {
        org_id: f.org.id,
        recipient_id: f.user.id,
        issue_id: a.id,
        kind: 'change',
        body: 'Older notice',
        actor_id: f.admin.id,
        now: at(0),
      })
    })
    expect((await pairRows(t, f.user.id, a.id)).map((m) => m.id)).toEqual([next.id])
    expect(await drift(t)).toEqual([])
  })

  it('snooze, the scheduled wake, an arrival, the early return and the nightly fallback', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a] = await tasks(t, f, 1)
    const one = (await post(t, f, { to: f.user, task: a, minute: 1 }))!
    await post(t, f, { to: f.user, task: a, minute: 2 })
    const user = as(t, f.user)
    const until = new Date(Date.now() + 3_600_000).toISOString()
    await user.mutation(api.messages.snooze, { org_id: f.org.id, ids: [one.id], until })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({
      snoozed: true,
      snoozed_until: until,
    })
    expect(await drift(t)).toEqual([])
    // the scheduled wake floats the item to the wake
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const woken = (await itemOfPair(t, f.user.id, a.id))!
    expect(woken).toMatchObject({ snoozed: false, woke_rows: 2 })
    expect(woken.sort_at).toBe(woken.woke_at)
    expect(await drift(t)).toEqual([])
    // read, then news: the read rows that carried the stamp go, and so does it
    const ids = (await pairRows(t, f.user.id, a.id)).map((m) => m.id)
    await user.mutation(api.messages.markRead, { org_id: f.org.id, ids })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ woke_rows: 1 })
    const news = (await post(t, f, { to: f.user, task: a, minute: 30 }))!
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({
      latest_id: news.id,
      woke_rows: 0,
      sort_at: at(30),
    })
    expect((await itemOfPair(t, f.user.id, a.id))?.woke_at).toBeUndefined()
    expect(await drift(t)).toEqual([])
    // an arrival wakes a snoozed item
    const later = new Date(Date.now() + 7_200_000).toISOString()
    await user.mutation(api.messages.snooze, { org_id: f.org.id, ids: [news.id], until: later })
    await post(t, f, { to: f.user, task: a, minute: 31 })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ snoozed: false })
    expect(await drift(t)).toEqual([])
    // the early return, and the nightly fallback for a wake that was lost
    await user.mutation(api.messages.snooze, { org_id: f.org.id, ids: [news.id], until: later })
    await user.mutation(api.messages.snooze, { org_id: f.org.id, ids: [news.id], until: null })
    expect(await drift(t)).toEqual([])
    await user.mutation(api.messages.snooze, { org_id: f.org.id, ids: [news.id], until: later })
    await t.mutation(internal.jobs.wakeSnoozes, {
      now: new Date(Date.parse(later) + 1).toISOString(),
      woken: 0,
    })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ snoozed: false })
    expect(await drift(t)).toEqual([])
  })

  it('a wake of an archived task keeps only the newest row, read', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a] = await tasks(t, f, 1)
    const one = (await post(t, f, { to: f.user, task: a, minute: 1 }))!
    await post(t, f, { to: f.user, task: a, minute: 2 })
    const until = new Date(Date.now() + 3_600_000).toISOString()
    await as(t, f.user).mutation(api.messages.snooze, { org_id: f.org.id, ids: [one.id], until })
    await t.run(async (ctx) => {
      await ctx.db.patch(a._id, { archived_at: at(5) })
      await wakeSnoozedItem(ctx, { recipient_id: f.user.id, issue_id: a.id }, at(6))
    })
    expect(await pairRows(t, f.user.id, a.id)).toHaveLength(1)
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ unread: false, snoozed: false })
    expect(await drift(t)).toEqual([])
  })

  it('the item cap trims an arrival inline and in the background step, counting what it dropped', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    for (let i = 0; i < ITEM_UNREAD_CAP + 3; i++)
      await post(t, f, { to: f.user, task: a, minute: i })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({
      unread_count: ITEM_UNREAD_CAP,
      dropped: 3,
    })
    expect(await drift(t)).toEqual([])
    // a fan-out past its inline trims leaves the trim to a background step
    await t.run(async (ctx) => {
      for (let i = 0; i < ITEM_UNREAD_CAP + 2; i++) {
        const trims = { ...newItemTrims(), inline: INLINE_TRIMS }
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: f.user.id,
          issue_id: b.id,
          kind: 'comment',
          body: `Busy ${i}`,
          actor_id: f.admin.id,
          now: at(100 + i),
          trims,
        })
      }
    })
    expect(await itemOfPair(t, f.user.id, b.id)).toMatchObject({
      unread_count: ITEM_UNREAD_CAP + 2,
    })
    expect(await drift(t)).toEqual([])
    await t.mutation(internal.messages.trimItems, { issue_id: b.id, recipients: [f.user.id] })
    expect(await itemOfPair(t, f.user.id, b.id)).toMatchObject({
      unread_count: ITEM_UNREAD_CAP,
      dropped: 2,
    })
    expect(await drift(t)).toEqual([])
  })

  it('mark all read keeps its first cutoff across batches, and remove read deletes read rows in batches', async () => {
    const t = newT()
    const f = await withOrg(t)
    const all = await tasks(t, f, 6)
    // 300 unread rows, more than one batch (INBOX_BATCH is 256)
    for (let i = 0; i < 300; i++) await post(t, f, { to: f.user, task: all[i % 6], minute: i })
    const user = as(t, f.user)
    const first = await user.mutation(api.messages.markAllRead, { org_id: f.org.id })
    expect(first.hasMore).toBe(true)
    expect(await drift(t)).toEqual([])
    // an arrival after the cutoff stays unread
    await post(t, f, { to: f.user, task: all[0], minute: 400 })
    const second = await user.mutation(api.messages.markAllRead, {
      org_id: f.org.id,
      before: first.before,
    })
    expect(second.hasMore).toBe(false)
    expect(await itemOfPair(t, f.user.id, all[0].id)).toMatchObject({ unread_count: 1 })
    expect(await drift(t)).toEqual([])
    await t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', f.user.id))!
      await markAllMessagesRead(ctx, me, undefined, at(500))
    })
    for (let more = true; more; ) {
      more = (await user.mutation(api.messages.removeRead, { org_id: f.org.id })).hasMore
      expect(await drift(t)).toEqual([])
    }
    expect(await t.run((ctx) => ctx.db.query('inbox_items').collect())).toEqual([])
    // a batch of many items at once, through the model the machine inbox runs
    for (let i = 0; i < 6; i++) await post(t, f, { to: f.user, task: all[i], minute: 600 + i })
    await t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', f.user.id))!
      await markAllMessagesRead(ctx, me, undefined, at(700))
      await removeReadMessages(ctx, me)
    })
    expect(await drift(t)).toEqual([])
  })

  it('the archive read steps, for a task and for a project, step by step', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    for (const to of [f.user, f.guest])
      for (let i = 0; i < 3; i++) {
        await post(t, f, { to, task: a, minute: i })
        await post(t, f, { to, task: b, minute: 10 + i })
      }
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const snoozed = (await pairRows(t, f.guest.id, a.id))[0]
    await as(t, f.guest).mutation(api.messages.snooze, {
      org_id: f.org.id,
      ids: [snoozed.id],
      until,
    })
    // two rows a step, so a step stops inside an item and the next goes on
    await t.run(async (ctx) => {
      await ctx.db.patch(a._id, { archived_at: at(20) })
      await readArchivedTaskMessages(ctx, { issues: [a.id], batch: 2, now: at(21) })
    })
    expect(await drift(t)).toEqual([])
    await runSteps(t)
    expect(await drift(t)).toEqual([])
    expect(await itemOfPair(t, f.guest.id, a.id)).toMatchObject({ unread: false, snoozed: false })
    await t.run(async (ctx) => {
      await ctx.db.patch(f.sub._id, { archived_at: at(30) })
      await readArchivedProjectMessages(ctx, {
        project_id: f.sub.id,
        batch: 2,
        tasks: 1,
        now: at(31),
      })
    })
    expect(await drift(t)).toEqual([])
    await runSteps(t)
    expect(await itemOfPair(t, f.user.id, b.id)).toMatchObject({ unread: false })
    expect(await drift(t)).toEqual([])
  })

  it('an archive read step over 500 tasks of 500 people stays inside the real limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // one unread message each, on a task each: a row, a task and an item, a
    // recipient's state and sweep row for every row the step marks
    const list: Doc<'issues'>[] = []
    for (let i = 0; i < 500; i += 100)
      await t.run(async (ctx) => {
        for (let j = i; j < i + 100; j++) {
          const id = uuid()
          await ctx.db.insert('profiles', {
            id,
            org_id: f.org.id,
            name: `Reader ${j}`,
            initials: 'RE',
            color: '#7a7ad0',
            org_role: 'admin',
            active: true,
            kind: 'person',
            created_at: NOW,
            message_retention_days: 30,
          })
          const issue = await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 10_000 + j,
            title: `Task ${j}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
          const task = (await ctx.db.get(issue))!
          list.push(task)
          await postMessage(ctx, {
            org_id: f.org.id,
            recipient_id: id,
            issue_id: task.id,
            kind: 'change',
            body: 'Update',
            actor_id: f.admin.id,
            now: at(1),
          })
        }
      })
    const used = await t.run(async (ctx) => {
      await ctx.db.patch(f.sub._id, { archived_at: at(2) })
      await readArchivedProjectMessages(ctx, { project_id: f.sub.id, now: at(3) })
      return await ctx.meta.getTransactionMetrics()
    })
    // about 3,000 of Convex's 4,096 (model/messages.ts ARCHIVED_READ_BATCH)
    expect(used.databaseQueries.used).toBeLessThan(3100)
    await runSteps(t)
    expect(await drift(t)).toEqual([])
    expect(
      (await t.run((ctx) => ctx.db.query('inbox_items').collect())).filter((i) => i.unread),
    ).toEqual([])
  }, 120_000)

  it('a nightly wake leg over hundreds of people stays inside the real limits', async () => {
    // about 2,100 ranges a leg (jobs.ts SWEEP_LIMITS.wakeItems)
    const t = newT({ transactionLimits: { databaseQueries: 2400 } })
    const f = await withOrg(t)
    // one snoozed message each, on a task each, archived since, so each
    // wake also notes the row's sweep: the most ranges a woken item costs
    const until = new Date(Date.now() + 3_600_000).toISOString()
    for (let i = 0; i < 500; i += 100)
      await t.run(async (ctx) => {
        for (let j = i; j < i + 100; j++) {
          const id = uuid()
          const _id = await ctx.db.insert('profiles', {
            id,
            org_id: f.org.id,
            name: `Sleeper ${j}`,
            initials: 'SL',
            color: '#7a7ad0',
            org_role: 'admin',
            active: true,
            kind: 'person',
            created_at: NOW,
            message_retention_days: 30,
          })
          const issue = await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 20_000 + j,
            title: `Task ${j}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
          const task = (await ctx.db.get(issue))!
          await postMessage(ctx, {
            org_id: f.org.id,
            recipient_id: id,
            issue_id: task.id,
            kind: 'change',
            body: 'Update',
            actor_id: f.admin.id,
            now: at(1),
          })
          const me = (await ctx.db.get(_id))!
          const rows = await ctx.db
            .query('messages')
            .withIndex('by_recipient', (q) => q.eq('recipient_id', id))
            .collect()
          await snoozeMessages(ctx, me, rows, until)
          await ctx.db.patch(issue, { archived_at: at(2) })
        }
      })
    await t.mutation(internal.jobs.wakeSnoozes, {
      now: new Date(Date.parse(until) + 1).toISOString(),
      woken: 0,
    })
    await runSteps(t)
    expect(
      (await t.run((ctx) => ctx.db.query('inbox_items').collect())).filter((i) => i.snoozed),
    ).toEqual([])
    expect(await drift(t)).toEqual([])
  }, 120_000)

  it('an archive read step over a list of 500 tasks stays inside the real limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // 170 tasks with nothing to mark come first, so the step visits all of
    // them, then 330 with one unread row each for a person of its own
    const empty: string[] = []
    const marked: string[] = []
    for (let i = 0; i < 500; i += 100)
      await t.run(async (ctx) => {
        for (let j = i; j < i + 100; j++) {
          const issue = await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 30_000 + j,
            title: `Task ${j}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
          })
          const task = (await ctx.db.get(issue))!
          if (j < 170) {
            empty.push(task.id)
            continue
          }
          marked.push(task.id)
          const id = uuid()
          await ctx.db.insert('profiles', {
            id,
            org_id: f.org.id,
            name: `Reader ${j}`,
            initials: 'RE',
            color: '#7a7ad0',
            org_role: 'admin',
            active: true,
            kind: 'person',
            created_at: NOW,
            message_retention_days: 30,
          })
          await postMessage(ctx, {
            org_id: f.org.id,
            recipient_id: id,
            issue_id: task.id,
            kind: 'change',
            body: 'Update',
            actor_id: f.admin.id,
            now: at(1),
          })
        }
      })
    const used = await t.run(async (ctx) => {
      for (const id of [...empty, ...marked]) {
        const task = (await byId(ctx, 'issues', id))!
        await ctx.db.patch(task._id, { archived_at: at(2) })
      }
      return null
    })
    expect(used).toBeNull()
    const ranges = await t.run(async (ctx) => {
      await readArchivedTaskMessages(ctx, { issues: [...empty, ...marked], now: at(3) })
      return (await ctx.meta.getTransactionMetrics()).databaseQueries.used
    })
    // about 3,480 (model/messages.ts ARCHIVED_READ_BATCH)
    expect(ranges).toBeLessThan(3600)
    expect(
      (await t.run((ctx) => ctx.db.query('inbox_items').collect())).filter((i) => i.unread),
    ).toEqual([])
    expect(await drift(t)).toEqual([])
  }, 120_000)

  it('the retention sweep deletes read rows, the newest included, and the items follow', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    const old = (await post(t, f, { to: f.user, task: a, minute: 1 }))!
    const keep = (await post(t, f, { to: f.user, task: b, minute: 2 }))!
    const newest = (await post(t, f, { to: f.user, task: b, minute: 3 }))!
    await t.run(async (ctx) => {
      await ctx.db.patch(f.user._id, { message_retention_days: 1 })
      const me = (await byId(ctx, 'profiles', f.user.id))!
      // read only the newest row of b, so the sweep deletes the newest row
      await markMessagesRead(ctx, me, [old, newest], at(5))
    })
    expect(await itemOfPair(t, f.user.id, b.id)).toMatchObject({ latest_id: newest.id })
    await t.mutation(internal.jobs.sweepDueProfiles, {
      profiles: [f.user.id],
      now: at(5 + 2 * 24 * 60),
      deleted: 0,
    })
    expect(await itemOfPair(t, f.user.id, a.id)).toBeNull()
    expect(await itemOfPair(t, f.user.id, b.id)).toMatchObject({
      latest_id: keep.id,
      unread_count: 1,
    })
    expect(await drift(t)).toEqual([])
  })

  it('a move re-keys the items to the new project, the rest in background steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a] = await tasks(t, f, 1)
    for (const to of [f.user, f.guest]) await post(t, f, { to, task: a, minute: 1 })
    // nobody follows the task, so the move's notices refresh no item
    Object.assign(REKEY, { inline: 1, step: 1 })
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: a.id,
      project_id: f.sub2.id,
    })
    const keyed = async () =>
      (await t.run((ctx) => ctx.db.query('inbox_items').collect())).map((i) => i.project_id)
    expect((await keyed()).sort()).toEqual([f.sub.id, f.sub2.id].sort())
    await runSteps(t)
    expect(await keyed()).toEqual([f.sub2.id, f.sub2.id])
    expect(await drift(t)).toEqual([])
    // moved twice before the first move's step runs: the step reads the
    // task's project when it runs, so the later move wins, one task a step
    REKEY.bytes = 1
    const move = (project_id: string) =>
      as(t, f.admin).mutation(api.issues.move, { org_id: f.org.id, id: a.id, project_id })
    await move(f.sub.id)
    await move(f.sub2.id)
    await move(f.sub.id)
    await runSteps(t)
    expect(await keyed()).toEqual([f.sub.id, f.sub.id])
    expect(await drift(t)).toEqual([])
  })

  it('a move to another top-level project re-keys its carried subtasks, in steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const ops = await plantProject(t, { org_id: f.org.id, name: 'Operations' })
    const dest = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: ops.id,
      name: 'Field work',
    })
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const kids: Doc<'issues'>[] = []
    for (let i = 0; i < 3; i++)
      kids.push(
        await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id }),
      )
    for (const task of [parent, ...kids])
      for (const to of [f.user, f.guest]) await post(t, f, { to, task, minute: 1 })
    Object.assign(REKEY, { inlineTasks: 1, tasks: 1 })
    await as(t, f.admin).mutation(api.issues.move, {
      org_id: f.org.id,
      id: parent.id,
      project_id: dest.id,
    })
    const keyed = async () =>
      (await t.run((ctx) => ctx.db.query('inbox_items').collect())).filter(
        (i) => i.project_id === dest.id,
      ).length
    // the parent's rows inline, the subtasks' in steps of one task
    expect(await keyed()).toBe(2)
    expect(
      (await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())).filter((job) =>
        job.name.includes('rekeyItems'),
      ),
    ).not.toEqual([])
    await runSteps(t)
    expect(await keyed()).toBe(8)
    expect(await drift(t)).toEqual([])
  })
})

describe('a random sequence of every inbox write', () => {
  /* mulberry32, exact in 32-bit integer arithmetic, so a failing seed
   * repeats and every value is as likely as the others. */
  const random = (seed: number) => {
    let a = seed >>> 0
    return (n: number) => {
      a = (a + 0x6d2b79f5) >>> 0
      let x = Math.imul(a ^ (a >>> 15), a | 1)
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
      return ((x ^ (x >>> 14)) >>> 0) % n
    }
  }

  for (const seed of [1, 7, 42])
    it(`keeps every item exact after each write, seed ${seed}`, async () => {
      const t = newT()
      const f = await withOrg(t)
      const list = await tasks(t, f, 3)
      const people = [f.user, f.guest]
      await t.run((ctx) => ctx.db.patch(f.user._id, { message_retention_days: 1 }))
      // an item past the cap for each, which dropped three, so the writes
      // below move a dropped count that is not zero
      for (const to of people)
        for (let i = 0; i < ITEM_UNREAD_CAP + 3; i++)
          await post(t, f, { to, task: list[0], minute: -100 + i })
      const pick = random(seed)
      const kinds: MessageKind[] = ['mention', 'change', 'comment']
      let minute = 0
      const whom = new Set<string>()
      const choices = new Set<number>()
      let partial = 0
      const dropped = new Set<number>()
      for (let op = 0; op < 120; op++) {
        const who = people[pick(2)]
        const task = list[pick(3)]
        const choice = pick(11)
        minute += 1
        whom.add(who.id)
        choices.add(choice)
        if (choice === 10)
          await t.mutation(internal.jobs.sweepDueProfiles, {
            profiles: [who.id],
            now: at(minute + 2 * 24 * 60),
            deleted: 0,
          })
        const subset = await t.run(async (ctx) => {
          const me = (await byId(ctx, 'profiles', who.id))!
          const mine = await ctx.db
            .query('messages')
            .withIndex('by_recipient', (q) => q.eq('recipient_id', me.id))
            .collect()
          const some = mine.filter(() => pick(2) === 0)
          const pair = { recipient_id: me.id, issue_id: task.id }
          const part = some.length > 0 && some.length < mine.length
          switch (choice) {
            case 0:
            case 1:
            case 2:
              // a background notice keeps its write's time, so some are older
              await postMessage(ctx, {
                org_id: f.org.id,
                recipient_id: me.id,
                issue_id: task.id,
                kind: kinds[pick(3)],
                body: `Op ${op}`,
                actor_id: f.admin.id,
                now: at(pick(4) === 0 ? minute - 30 : minute),
              })
              break
            case 3:
              await markMessagesRead(ctx, me, some, at(minute))
              break
            case 4:
              await markMessagesUnread(ctx, me, some)
              break
            case 5:
              await removeMessages(ctx, some.slice(0, 2))
              break
            case 6:
              await snoozeMessages(
                ctx,
                me,
                mine.filter((m) => m.issue_id === task.id),
                pick(3) === 0 ? null : new Date(Date.now() + 3_600_000).toISOString(),
              )
              break
            case 7:
              await wakeSnoozedItem(ctx, pair, at(minute))
              break
            case 8:
              await markAllMessagesRead(ctx, me, undefined, at(minute))
              break
            case 9:
              await removeReadMessages(ctx, me)
              break
            default:
            // the sweep ran above, in a transaction of its own
          }
          return part && [3, 4, 5].includes(choice)
        })
        if (subset) partial++
        const off = await drift(t)
        if (off.length > 0) throw new Error(`op ${op} (${choice}): ${off.join('; ')}`)
        for (const item of await t.run((ctx) => ctx.db.query('inbox_items').collect()))
          if (item.issue_id === list[0].id) dropped.add(item.dropped)
      }
      // both people, every write and partial selections of rows came up,
      // and the writes moved the full item's dropped count
      expect(dropped.size).toBeGreaterThan(1)
      expect(whom.size).toBe(2)
      expect(choices.size).toBe(11)
      expect(partial).toBeGreaterThan(5)
    })
})

describe('the teardowns delete the items and the build state with the messages', () => {
  it('a task or profile id used again after a purge or a removal starts with no item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a] = await tasks(t, f, 1)
    for (let i = 0; i < 3; i++) await post(t, f, { to: f.user, task: a, minute: i })
    await deleteTask(t, f, a.id)
    await runSteps(t)
    await as(t, f.admin).mutation(api.deletedItems.purge, {
      org_id: f.org.id,
      ids: [(await itemFor(t, a.id)).id],
    })
    await runSteps(t)
    // the same uuid, in this organization and in another one
    const again = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, id: a.id })
    await post(t, f, { to: f.user, task: again, minute: 10 })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ unread_count: 1, changes: 1 })
    await as(t, f.admin).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: a.id })
    await runSteps(t)
    await as(t, f.admin).mutation(api.deletedItems.purge, {
      org_id: f.org.id,
      ids: [(await itemFor(t, a.id)).id],
    })
    await runSteps(t)
    const elsewhere = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      id: a.id,
    })
    await t.run((ctx) =>
      postMessage(ctx, {
        org_id: f.otherOrg.id,
        recipient_id: f.otherAdmin.id,
        issue_id: elsewhere.id,
        kind: 'comment',
        body: 'Elsewhere',
        actor_id: undefined,
        now: at(20),
      }),
    )
    expect(
      (await t.run((ctx) => ctx.db.query('inbox_items').collect())).map((i) => [
        i.recipient_id,
        i.unread_count,
      ]),
    ).toEqual([[f.otherAdmin.id, 1]])
    // a removed profile's id, taken by a new profile
    const [b] = await tasks(t, f, 1)
    await post(t, f, { to: f.guest, task: b, minute: 30 })
    await post(t, f, { to: f.guest, task: b, minute: 31 })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.guest.id })
    await runSteps(t)
    const { _id, _creationTime, ...guest } = f.guest
    void _id
    void _creationTime
    // an admin, who sees the task without the grants the removal deleted
    await t.run((ctx) =>
      ctx.db.insert('profiles', { ...guest, name: 'New admin', org_role: 'admin' }),
    )
    expect(await stateOf(t, f.guest.id)).toBeNull()
    await post(t, f, { to: f.guest, task: b, minute: 40 })
    expect(await itemOfPair(t, f.guest.id, b.id)).toMatchObject({ unread_count: 1 })
    expect(await stateOf(t, f.guest.id)).toMatchObject({ built: true })
    expect(await drift(t)).toEqual([])
  })

  it('a task or project moved to Deleted items takes its items, and a restore brings none back', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    for (const to of [f.user, f.guest]) {
      await post(t, f, { to, task: a, minute: 1 })
      await post(t, f, { to, task: b, minute: 2 })
    }
    await deleteTask(t, f, a.id)
    await runSteps(t)
    expect(await itemOfPair(t, f.user.id, a.id)).toBeNull()
    expect(await drift(t)).toEqual([])
    await as(t, f.admin).mutation(api.deletedItems.restore, {
      org_id: f.org.id,
      ids: [(await itemFor(t, a.id)).id],
    })
    await runSteps(t)
    expect(await itemOfPair(t, f.user.id, a.id)).toBeNull()
    await deleteProject(t, f, f.sub.id)
    await runSteps(t)
    expect(await t.run((ctx) => ctx.db.query('inbox_items').collect())).toEqual([])
    expect(await drift(t)).toEqual([])
  })

  it('a removed profile loses its items and its build state', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a] = await tasks(t, f, 1)
    await post(t, f, { to: f.user, task: a, minute: 1 })
    await post(t, f, { to: f.guest, task: a, minute: 1 })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.user.id })
    await runSteps(t)
    expect(await itemOfPair(t, f.user.id, a.id)).toBeNull()
    expect(await stateOf(t, f.user.id)).toBeNull()
    expect(await itemOfPair(t, f.guest.id, a.id)).not.toBeNull()
    expect(await drift(t)).toEqual([])
    await assertNoDanglingRefs(t, 'profile removal')
  })

  it('a deep delete takes them at once, and the work wipe in batches keeps the profiles built', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    for (const to of [f.user, f.guest]) {
      await post(t, f, { to, task: a, minute: 1 })
      await post(t, f, { to, task: b, minute: 2 })
    }
    for (let done = false; !done; )
      done = await t.run((ctx) =>
        wipeWorkStep(ctx, f.org.id, [f.user.id, f.guest.id], { rows: 2, bytes: 1 << 20 }),
      )
    expect(await t.run((ctx) => ctx.db.query('inbox_items').collect())).toEqual([])
    expect(await stateOf(t, f.user.id)).toMatchObject({ built: true })
    const [c] = await tasks(t, f, 1)
    await post(t, f, { to: f.user, task: c, minute: 3 })
    expect(await drift(t)).toEqual([])
    await t.run(async (ctx) => deleteOrgDeep(ctx, (await byId(ctx, 'organizations', f.org.id))!))
    expect(await t.run((ctx) => ctx.db.query('inbox_items').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('inbox_state').collect())).toEqual([])
    await assertNoDanglingRefs(t, 'deep delete')
  })
})

describe('the build gate', () => {
  it('a recipient with messages from before keeps no items until the backfill builds them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a] = await tasks(t, f, 1)
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.user.id, issue_id: a.id })
    await post(t, f, { to: f.user, task: a, minute: 1 })
    expect(await stateOf(t, f.user.id)).toBeNull()
    expect(await itemOfPair(t, f.user.id, a.id)).toBeNull()
    expect(await t.query(internal.internal.inboxItemsBackfill.remaining, {})).toMatchObject({
      profiles: 1,
      listed: [{ profile_id: f.user.id, built: false, has_messages: true }],
    })
    await backfill(t, { dry_run: false })
    expect(await stateOf(t, f.user.id)).toMatchObject({ built: true })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ unread_count: 2 })
    expect(await t.query(internal.internal.inboxItemsBackfill.remaining, {})).toMatchObject({
      profiles: 0,
    })
    expect(await drift(t)).toEqual([])
  })

  it('writes between build steps keep the built tasks and leave the rest to the later steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b, c] = await tasks(t, f, 3)
    for (const task of [a, b, c])
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.user.id, issue_id: task.id })
    BUILD.pairs = 1
    const step = () =>
      t.mutation(internal.internal.inboxItemsBackfill.step, { profile_id: f.user.id })
    expect(await step()).toMatchObject({ items: 1, done: false })
    expect(await stateOf(t, f.user.id)).toMatchObject({ built: false, built_through: a.id })
    // a write to the built task keeps its item, one to the others does not
    await post(t, f, { to: f.user, task: a, minute: 1 })
    await post(t, f, { to: f.user, task: c, minute: 2 })
    await t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', f.user.id))!
      const rows = await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) => q.eq('recipient_id', me.id).eq('issue_id', b.id))
        .collect()
      await markMessagesRead(ctx, me, rows, at(3))
    })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ unread_count: 2 })
    expect(await itemOfPair(t, f.user.id, c.id)).toBeNull()
    expect(await drift(t)).toEqual([])
    // a new task below the built ones is covered, and is built from its rows
    const below = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      id: `00000000-0000-4000-8000-${'0'.repeat(12)}`,
    })
    await post(t, f, { to: f.user, task: below, minute: 4 })
    expect(await itemOfPair(t, f.user.id, below.id)).toMatchObject({ unread_count: 1 })
    while (!(await step()).done) {}
    expect(await stateOf(t, f.user.id)).toMatchObject({ built: true })
    expect(await itemOfPair(t, f.user.id, b.id)).toMatchObject({ unread: false })
    expect(await itemOfPair(t, f.user.id, c.id)).toMatchObject({ unread_count: 2 })
    expect(await drift(t)).toEqual([])
  })

  it('a half-built profile whose messages all went is due until a step marks it built', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b, c] = await tasks(t, f, 3)
    for (const task of [a, b, c])
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.user.id, issue_id: task.id })
    BUILD.pairs = 1
    await t.mutation(internal.internal.inboxItemsBackfill.step, { profile_id: f.user.id })
    expect(await stateOf(t, f.user.id)).toMatchObject({ built: false, built_through: a.id })
    await t.run(async (ctx) =>
      removeMessages(ctx, await ctx.db.query('messages').collect()).then(() => null),
    )
    // no message left, but the profile is not built
    expect(await t.query(internal.internal.inboxItemsBackfill.remaining, {})).toMatchObject({
      profiles: 1,
      listed: [{ profile_id: f.user.id, has_state: true, has_messages: false }],
    })
    expect(await backfill(t, { dry_run: false })).toMatchObject({ profiles: 1, done: true })
    expect(await stateOf(t, f.user.id)).toMatchObject({ built: true })
    expect(await t.query(internal.internal.inboxItemsBackfill.remaining, {})).toMatchObject({
      profiles: 0,
    })
    // a later message about a task past the old built_through keeps its item
    await post(t, f, { to: f.user, task: c, minute: 1 })
    expect(await itemOfPair(t, f.user.id, c.id)).toMatchObject({ unread_count: 1 })
    expect(await drift(t)).toEqual([])
  })

  it('a step keeps built_through until the rows no message makes are gone, a few a step', async () => {
    const t = newT()
    const f = await withOrg(t)
    const list = await tasks(t, f, 6)
    for (const task of [list[3], list[5]])
      await plantMessage(t, { org_id: f.org.id, recipient_id: f.user.id, issue_id: task.id })
    // rows from a build before: three below the first task with messages and
    // one between the two, whose messages are gone, and a stale row for the
    // last task, which a write between steps leaves alone, because the
    // state does not cover it yet
    await t.run(async (ctx) => {
      for (const task of [list[0], list[1], list[2], list[4], list[5]])
        await ctx.db.insert('inbox_items', {
          recipient_id: f.user.id,
          issue_id: task.id,
          project_id: f.sub.id,
          sort_at: NOW,
          latest_id: uuid(),
          latest_at: NOW,
          unread: true,
          unread_count: 9,
          dropped: 0,
          mentions: 0,
          changes: 9,
          comments: 0,
          snoozed: false,
          woke_rows: 0,
        })
      await ctx.db.insert('inbox_state', { profile_id: f.user.id, built: false })
    })
    BUILD.pairs = 1
    const step = () =>
      t.mutation(internal.internal.inboxItemsBackfill.step, { profile_id: f.user.id })
    const states: (string | undefined)[] = []
    for (let n = 0; n < 20; n++) {
      const got = await step()
      const state = await stateOf(t, f.user.id)
      states.push(state?.built ? 'built' : state?.built_through)
      if (n === 0) await post(t, f, { to: f.user, task: list[5], minute: 1 })
      if (got.done) break
    }
    // one stale row a step: the state holds until the three are gone
    expect(states).toEqual([undefined, undefined, list[3].id, list[5].id, 'built'])
    expect(await t.run((ctx) => ctx.db.query('inbox_items').collect())).toHaveLength(2)
    expect(await itemOfPair(t, f.user.id, list[5].id)).toMatchObject({ unread_count: 2 })
    expect(await drift(t)).toEqual([])
  })

  it('one ItemEdits shared by many messages reads each item once, in its one flush', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    await post(t, f, { to: f.user, task: a, minute: 0 })
    await post(t, f, { to: f.user, task: b, minute: 0 })
    const reads = await t.run(async (ctx) => {
      const items = itemEdits(ctx)
      for (let i = 1; i <= 3; i++)
        for (const task of [a, b])
          await postMessage(ctx, {
            org_id: f.org.id,
            recipient_id: f.user.id,
            issue_id: task.id,
            kind: 'comment',
            body: `Shared ${i}`,
            actor_id: f.admin.id,
            now: at(i),
            items,
          })
      const before = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
      await items.flush()
      return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before
    })
    // the two rows; the state was read once, before the first insert
    expect(reads).toBe(2)
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({ unread_count: 4 })
    expect(await drift(t)).toEqual([])
  })
})

describe('the backfill', () => {
  /* Planted messages from before the items: two profiles, three tasks. */
  async function legacy(t: T, f: OrgFixture) {
    const list = await tasks(t, f, 3)
    for (const [i, task] of list.entries()) {
      for (const to of [f.user, f.guest])
        await plantMessage(t, {
          org_id: f.org.id,
          recipient_id: to.id,
          issue_id: task.id,
          kind: i === 0 ? 'mention' : 'change',
          created_at: at(i),
        })
      await plantMessage(t, {
        org_id: f.org.id,
        recipient_id: f.user.id,
        issue_id: task.id,
        read_at: at(10),
        created_at: at(5 + i),
      })
    }
    return list
  }

  it('reports in a dry run without writing, builds in a run, and builds nothing again', async () => {
    const t = newT()
    const f = await withOrg(t)
    await legacy(t, f)
    const dry = await backfill(t, { dry_run: true })
    expect(dry).toMatchObject({
      dry_run: true,
      profiles: 2,
      items: 6,
      build: 6,
      messages: 9,
      differing: 0,
      oversized: 0,
      orphan_rows: 0,
      done: true,
      cursor: null,
    })
    expect(await t.run((ctx) => ctx.db.query('inbox_items').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('inbox_state').collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query('platform_audit_log').collect())).toEqual([])
    const run = await backfill(t, { dry_run: false })
    expect(run).toMatchObject({ profiles: 2, items: 6, trimmed: 0, stuck: 0, done: true })
    expect(await drift(t)).toEqual([])
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit).toMatchObject([
      { action: 'inbox_items_backfill', actor_email: 'system', detail: { profiles: 2, items: 6 } },
    ])
    expect(await backfill(t, { dry_run: false })).toMatchObject({ profiles: 0, items: 0 })
    for (const p of [f.user, f.guest])
      expect(await check(t, p.id)).toMatchObject({
        built: true,
        checked: 3,
        differ: [],
        missing: [],
        extra: [],
        done: true,
      })
  })

  it('a dry run, a run and a rebuild resume inside a profile past RUN.ms and each finish', async () => {
    const t = newT()
    const f = await withOrg(t)
    await legacy(t, f)
    const one = await backfill(t, { dry_run: true })
    Object.assign(RUN, { ms: 0, profiles: 1 })
    Object.assign(BUILD, { pairs: 1, room: 0 })
    // the dry run counts every item once over all its calls
    const dry = await backfillAll(t, { dry_run: true })
    expect(dry.length).toBeGreaterThan(3)
    for (const field of ['profiles', 'items', 'build', 'messages'] as const)
      expect(sum(dry, field)).toBe(one[field])
    const run = await backfillAll(t, { dry_run: false })
    expect(run.length).toBeGreaterThan(3)
    expect(sum(run, 'items')).toBe(6)
    expect(await drift(t)).toEqual([])
    // a rebuild resets each profile once: its build only moves on
    await t.run(async (ctx) => {
      for (const item of await ctx.db.query('inbox_items').collect())
        await ctx.db.patch(item._id, { unread_count: 7 })
    })
    const through = new Map<string, string[]>()
    let cursor: string | null = null
    for (let n = 0; n < 100; n++) {
      const got = await backfill(t, { dry_run: false, rebuild: true, cursor })
      for (const p of [f.user, f.guest]) {
        const state = await stateOf(t, p.id)
        const seen = through.get(p.id) ?? []
        seen.push(state?.built ? 'built' : (state?.built_through ?? ''))
        through.set(p.id, seen)
      }
      if (got.done) break
      cursor = got.cursor
    }
    for (const seen of through.values()) {
      const started = seen.findIndex((x) => x !== 'built')
      const after = seen.slice(started)
      // after its reset, a profile's build never starts over
      expect(after.filter((x, i) => i > 0 && x === '' && after[i - 1] !== '')).toEqual([])
      expect(seen.at(-1)).toBe('built')
    }
    expect(await drift(t)).toEqual([])
    // one audit row for each call that wrote, the last with no cursor
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit.at(-1)).toMatchObject({ detail: { rebuild: true, cursor: null } })
    // a cursor the run did not answer is refused
    await expect(backfill(t, { dry_run: true, cursor: 'nonsense' })).rejects.toThrow(/cursor/)
  })

  it('records what committed in its audit row when a step throws', async () => {
    // a step reads one whole item at least, so an item larger than the
    // limit makes the second profile's step throw
    const t = newT({ transactionLimits: { documentsRead: 50 } })
    const f = await withOrg(t)
    const small = `00000000-0000-4000-8000-${'1'.repeat(12)}`
    const big = `00000000-0000-4000-8000-${'2'.repeat(12)}`
    for (const id of [small, big])
      await t.run(async (ctx) => {
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `Reader ${id.slice(-1)}`,
          initials: 'RE',
          color: '#7a7ad0',
          org_role: 'admin',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
      })
    const [task] = await tasks(t, f, 1)
    await plantMessage(t, { org_id: f.org.id, recipient_id: small, issue_id: task.id })
    for (let i = 0; i < 60; i++)
      await plantMessage(t, { org_id: f.org.id, recipient_id: big, issue_id: task.id })
    await expect(backfill(t, { dry_run: false })).rejects.toThrow(/documents/)
    const audit = await t.run((ctx) => ctx.db.query('platform_audit_log').collect())
    expect(audit).toHaveLength(1)
    expect(audit[0].detail).toMatchObject({
      items: 1,
      cursor: expect.stringContaining(small),
      error: expect.stringMatching(/documents/),
    })
    expect(await stateOf(t, small)).toMatchObject({ built: true })
    expect(await stateOf(t, big)).toBeNull()
  })

  it('finds and deletes the rows of profiles that are gone, inside one in steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    const list = await tasks(t, f, 3)
    // before every live profile, so the steps meet it first
    const gone = `00000000-0000-4000-8000-${'0'.repeat(11)}1`
    // rows an earlier release left when it removed a profile
    await t.run(async (ctx) => {
      for (const task of list)
        await ctx.db.insert('inbox_items', {
          recipient_id: gone,
          issue_id: task.id,
          project_id: f.sub.id,
          sort_at: NOW,
          latest_id: uuid(),
          latest_at: NOW,
          unread: false,
          unread_count: 0,
          dropped: 0,
          mentions: 0,
          changes: 1,
          comments: 0,
          snoozed: false,
          woke_rows: 0,
        })
      await ctx.db.insert('inbox_state', { profile_id: gone, built: true })
    })
    await post(t, f, { to: f.user, task: list[0], minute: 1 })
    expect(await backfill(t, { dry_run: true })).toMatchObject({ orphan_rows: 4, orphans: [gone] })
    Object.assign(RUN, { ms: 0 })
    Object.assign(BUILD, { pairs: 1, room: 0 })
    const dry = await backfillAll(t, { dry_run: true })
    expect(sum(dry, 'orphan_rows')).toBe(4)
    // a run that stops inside the gone profile, which someone then creates
    // again, leaves the rows to the new profile's own build
    let cursor: string | null = null
    let deleted = 0
    for (let n = 0; n < 50; n++) {
      const got = await backfill(t, { dry_run: false, cursor })
      deleted += got.orphan_rows
      cursor = got.cursor
      if (cursor !== null && JSON.parse(cursor).at?.id === gone) break
    }
    expect(deleted).toBe(1)
    await t.run(async (ctx) => {
      await ctx.db.insert('profiles', {
        id: gone,
        org_id: f.org.id,
        name: 'Same id',
        initials: 'SI',
        color: '#7a7ad0',
        org_role: 'admin',
        active: true,
        kind: 'person',
        created_at: NOW,
      })
    })
    const rest = await backfill(t, { dry_run: false, cursor })
    expect(rest).toMatchObject({ orphan_rows: 0 })
    expect(
      (await t.run((ctx) => ctx.db.query('inbox_items').collect())).filter(
        (i) => i.recipient_id === gone,
      ),
    ).toHaveLength(2)
    // with the profile gone again, a run deletes them all
    await t.run(async (ctx) => {
      const p = await byId(ctx, 'profiles', gone)
      if (p) await ctx.db.delete(p._id)
    })
    const run = await backfillAll(t, { dry_run: false })
    expect(sum(run, 'orphan_rows')).toBe(3)
    const left = await t.run(async (ctx) => [
      ...(await ctx.db.query('inbox_items').collect()).map((i) => i.recipient_id),
      ...(await ctx.db.query('inbox_state').collect()).map((s) => s.profile_id),
    ])
    expect(left).toEqual([f.user.id, f.user.id])
    expect(await drift(t)).toEqual([])
  })

  it('a dry run finds rows an earlier release left behind its messages, and a rebuild mends them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    await post(t, f, { to: f.user, task: a, minute: 1 })
    await post(t, f, { to: f.guest, task: a, minute: 1 })
    expect(await backfill(t, { dry_run: true })).toMatchObject({ differing: 0, drifted: [] })
    // an earlier release wrote messages without their items
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.user.id, issue_id: a.id })
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.user.id, issue_id: b.id })
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      differing: 1,
      missing: 1,
      drifted: [f.user.id],
    })
    await backfill(t, { dry_run: false, rebuild: true })
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      differing: 0,
      missing: 0,
      extra: 0,
      drifted: [],
    })
    expect(await drift(t)).toEqual([])
  })

  it('stops at RUN.ms on pages of profiles it only skips', async () => {
    const t = newT()
    await withOrg(t)
    const profiles = (await t.run((ctx) => ctx.db.query('profiles').collect())).length
    Object.assign(RUN, { ms: 0, profiles: 1 })
    for (const dry_run of [false, true]) {
      // no profile has messages or a state, so a call finds nothing to do
      const first = await backfill(t, { dry_run })
      expect(first).toMatchObject({ done: false, profiles: 0 })
      expect(first.cursor).not.toBeNull()
      expect((await backfillAll(t, { dry_run })).length).toBeGreaterThanOrEqual(profiles)
    }
  })

  it('a check counts every row no message makes, however many there are', async () => {
    const t = newT()
    const f = await withOrg(t)
    const list = await tasks(t, f, 11)
    await post(t, f, { to: f.user, task: list[5], minute: 1 })
    // ten rows with no message, more than one page reads
    await t.run(async (ctx) => {
      for (const task of list)
        if (task !== list[5])
          await ctx.db.insert('inbox_items', {
            recipient_id: f.user.id,
            issue_id: task.id,
            project_id: f.sub.id,
            sort_at: NOW,
            latest_id: uuid(),
            latest_at: NOW,
            unread: false,
            unread_count: 0,
            dropped: 0,
            mentions: 0,
            changes: 1,
            comments: 0,
            snoozed: false,
            woke_rows: 0,
          })
    })
    Object.assign(BUILD, { pairs: 2 })
    Object.assign(RUN, { listed: 2 })
    let extra = 0
    let checked = 0
    let after: string | undefined
    for (let n = 0; n < 20; n++) {
      const page = await check(t, f.user.id, after)
      extra += page.found.extra
      checked += page.checked
      if (page.done) break
      after = page.next ?? undefined
    }
    expect({ extra, checked }).toEqual({ extra: 10, checked: 1 })
    expect(await backfill(t, { dry_run: true })).toMatchObject({ extra: 10, differing: 0 })
  })

  it('a rebuild resets no profile that is gone', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.mutation(internal.internal.inboxItemsBackfill.reset, { profile_id: uuid() })
    await t.mutation(internal.internal.inboxItemsBackfill.reset, { profile_id: f.user.id })
    expect(
      (await t.run((ctx) => ctx.db.query('inbox_state').collect())).map((s) => s.profile_id),
    ).toEqual([f.user.id])
  })

  it('trims an item too large for one step toward the cap first, and lists one it cannot shrink', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = await tasks(t, f)
    BUILD.pair_rows = ITEM_UNREAD_CAP + 10
    BUILD.trims = 1
    await t.run(async (ctx) => {
      for (let i = 0; i < ITEM_UNREAD_CAP + 80; i++)
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: f.org.id,
          recipient_id: f.user.id,
          issue_id: a.id,
          issue_title: a.title,
          kind: 'change',
          detail: `Legacy ${i}`,
          created_at: at(i),
        })
    })
    expect(await backfill(t, { dry_run: true })).toMatchObject({
      oversized: 1,
      oversized_items: [{ recipient_id: f.user.id, issue_id: a.id }],
    })
    expect(await pairRows(t, f.user.id, a.id)).toHaveLength(ITEM_UNREAD_CAP + 80)
    const run = await backfill(t, { dry_run: false })
    expect(run).toMatchObject({ trimmed: 80, stuck: 0, done: true })
    expect(await itemOfPair(t, f.user.id, a.id)).toMatchObject({
      unread_count: ITEM_UNREAD_CAP,
      dropped: 80,
    })
    expect(await drift(t)).toEqual([])
    // read rows no trim deletes, from before the prune, stop their profile
    await t.run(async (ctx) => {
      for (let i = 0; i < ITEM_UNREAD_CAP + 11; i++)
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: f.org.id,
          recipient_id: f.guest.id,
          issue_id: b.id,
          issue_title: b.title,
          kind: 'change',
          detail: `Read ${i}`,
          created_at: at(i),
          read_at: at(200),
        })
    })
    expect(await backfill(t, { dry_run: false })).toMatchObject({
      stuck: 1,
      stuck_items: [{ recipient_id: f.guest.id, issue_id: b.id }],
    })
    expect(await stateOf(t, f.guest.id)).toMatchObject({ built: false })
    expect(await t.query(internal.internal.inboxItemsBackfill.remaining, {})).toMatchObject({
      profiles: 1,
    })
  })

  it('the check lists rows that differ, are missing or have no messages, page by page', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b, c] = await legacy(t, f)
    await backfill(t, { dry_run: false })
    await t.run(async (ctx) => {
      const items = await ctx.db.query('inbox_items').collect()
      const of = (task: Doc<'issues'>) =>
        items.find((i) => i.recipient_id === f.user.id && i.issue_id === task.id)!
      await ctx.db.patch(of(a)._id, { comments: 4, sort_at: at(99) })
      await ctx.db.delete(of(b)._id)
      // a row whose messages are gone
      for (const m of await ctx.db
        .query('messages')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', f.user.id).eq('issue_id', c.id),
        )
        .collect())
        await ctx.db.delete(m._id)
    })
    BUILD.pairs = 1
    const pages = []
    let after: string | undefined
    for (;;) {
      const page = await check(t, f.user.id, after)
      pages.push(page)
      if (page.done) break
      after = page.next ?? undefined
    }
    expect(pages.flatMap((p) => p.differ)).toEqual([
      { issue_id: a.id, fields: ['comments', 'sort_at'] },
    ])
    expect(pages.flatMap((p) => p.missing)).toEqual([b.id])
    expect(pages.flatMap((p) => p.extra)).toEqual([c.id])
    // a run leaves a built profile alone, and a rebuild mends every row
    expect(await backfill(t, { dry_run: false })).toMatchObject({ profiles: 0 })
    expect(await drift(t)).not.toEqual([])
    const rebuilt = await t.action(internal.internal.inboxItemsBackfill.run, {
      dry_run: false,
      rebuild: true,
    })
    expect(rebuilt).toMatchObject({ profiles: 2, items: 5, done: true })
    expect(await drift(t)).toEqual([])
    expect(await check(t, f.user.id)).toMatchObject({ differ: [], missing: [], extra: [] })
  })
})

describe('the Northstar seed', () => {
  it('keeps the item of every notice it posts through its one shared ItemEdits', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    const items = await t.run((ctx) => ctx.db.query('inbox_items').collect())
    expect(items.length).toBeGreaterThan(50)
    expect(await t.run((ctx) => ctx.db.query('inbox_state').collect())).toHaveLength(
      new Set(items.map((i) => i.recipient_id)).size,
    )
    expect(new Set(items.map((i) => i.recipient_id)).size).toBeLessThanOrEqual(profiles.length)
    expect(await drift(t)).toEqual([])
  })
})
