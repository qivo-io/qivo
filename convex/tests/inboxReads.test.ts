/* The inbox reads over inbox_items (model/inboxReads.ts, convex/inbox.ts)
 * and the item actions (convex/messages.ts readItem, unreadItem,
 * removeItem, snoozeItem). The summary counts exactly the unread,
 * unsnoozed items of the caller's working set across their seats, up to
 * SUMMARY.most, says when a seat is not ready or a budget stopped it, and
 * stays inside Convex's limits. The item read answers one task's item, and
 * the item actions change only the caller's own item, up to the newest
 * message the caller saw. Every case that writes ends with drift() empty. */

import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { BUILD } from '../internal/inboxItemsBackfill'
import { byId, newWindowKey } from '../lib/db'
import { LIMITS } from '../lib/limits'
import { TRASH_BUDGET } from '../model/deletedItems'
import { insertTask } from '../model/descriptions'
import { itemEdits, REKEY } from '../model/inboxItems'
import { readInboxItem, readInboxSummary, SUMMARY } from '../model/inboxReads'
import { ITEM_UNREAD_CAP, itemMessages, markMessagesRead, postMessage } from '../model/messages'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantMessage,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { at, drift, post } from './inboxItems.setup'
import { plantNorthstar } from './northstar.setup'
import { DAY, deleteTask, installTrashTimers, runSteps, START } from './trash.setup'

installTrashTimers()
const DEFAULT_SUMMARY = { ...SUMMARY }
const DEFAULT_REKEY = { ...REKEY }
afterEach(() => {
  Object.assign(SUMMARY, DEFAULT_SUMMARY)
  Object.assign(REKEY, DEFAULT_REKEY)
})

/* The caller's unread summary. */
const summaryOf = (t: T, who: Doc<'profiles'>) => as(t, who).query(api.inbox.summary, {})

/* The caller's item about one task in the fixture's organization. */
const itemFor = (t: T, f: OrgFixture, who: Doc<'profiles'>, issue_id: string) =>
  as(t, who).query(api.inbox.item, { org_id: f.org.id, issue_id })

/* The summary of the login of `who` read as the query reads it, in one
 * transaction, with what the transaction read in all. */
const measured = (t: T, who: Doc<'profiles'>) =>
  t.run(async (ctx) => {
    const seats = await ctx.db
      .query('profiles')
      .withIndex('by_auth', (q) => q.eq('auth_user_id', who.auth_user_id))
      .collect()
    const answer = await readInboxSummary(
      ctx,
      seats.filter((s) => s.active),
    )
    const m = await ctx.meta.getTransactionMetrics()
    return {
      answer,
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      bytes: m.bytesRead.used,
    }
  })

/* The stored item of one pair, or null. */
const storedItem = (t: T, recipient_id: string, issue_id: string) =>
  t.run((ctx) =>
    ctx.db
      .query('inbox_items')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', recipient_id).eq('issue_id', issue_id),
      )
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

/* Gives `who` a grant on project `projectId` and answers a function that
 * takes it away again. */
async function grant(t: T, who: Doc<'profiles'>, projectId: string) {
  const _id = await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: projectId, profile_id: who.id, level: 'user' }),
  )
  return () => t.run((ctx) => ctx.db.delete(_id))
}

let planted = 50_000

/** `n` new tasks in project `projectId` with fields `task`, each with one
 * message to `to` from the fixture's admin, `chunk` tasks a transaction.
 * Answers the tasks in the order planted. */
async function plantItems(
  t: T,
  f: Pick<OrgFixture, 'org' | 'admin'>,
  to: Doc<'profiles'>,
  n: number,
  projectId: string,
  task: Partial<Doc<'issues'>> = {},
  chunk = 50,
): Promise<Doc<'issues'>[]> {
  const out: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += chunk) {
    const made = await t.run(async (ctx) => {
      const rows: Doc<'issues'>[] = []
      for (let i = from; i < Math.min(n, from + chunk); i++) {
        // with its description row and the used_ids row of its id, as every
        // writer stores a task
        const _id = await insertTask(
          ctx.db,
          {
            id: uuid(),
            org_id: f.org.id,
            project_id: projectId,
            num: planted++,
            title: `Item ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...task,
          },
          'restore',
        )
        const issue = (await ctx.db.get(_id)) as Doc<'issues'>
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: to.id,
          issue_id: issue.id,
          kind: 'change',
          body: `Update ${i}`,
          actor_id: f.admin.id,
          now: at(i),
        })
        rows.push(issue)
      }
      return rows
    })
    out.push(...made)
  }
  return out
}

/* Runs internal/inboxItemsBackfill until it answers done. */
async function backfillAll(t: T) {
  for (let cursor: string | null = null, n = 0; ; n++) {
    if (n === 100) throw new Error('the backfill did not finish')
    const got: { done: boolean; cursor: string | null } = await t.action(
      internal.internal.inboxItemsBackfill.run,
      { dry_run: false, cursor },
    )
    if (got.done) return
    cursor = got.cursor
  }
}

/* Stores `n` messages of `kind` for `to` about `task` raw, as releases
 * before the item cap and the items stored them, so `to` has no build
 * state. Each is about 1 KB, a long change line. */
async function plantLegacy(
  t: T,
  f: OrgFixture,
  to: Doc<'profiles'>,
  task: Doc<'issues'>,
  n: number,
  kind: (i: number) => 'change' | 'comment',
) {
  for (let from = 0; from < n; from += 500)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 500); i++)
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: f.org.id,
          recipient_id: to.id,
          issue_id: task.id,
          issue_title: task.title,
          kind: kind(i),
          detail: `Legacy update ${i}: ${'a long change line '.repeat(50)}`,
          created_at: at(i),
        })
    })
}

/* Archives the tasks without the archive's read steps, as a task archived
 * before its step ran is, so their messages stay unread. */
const archiveRaw = (t: T, tasks: readonly Doc<'issues'>[]) =>
  t.run(async (ctx) => {
    for (const task of tasks) await ctx.db.patch(task._id, { archived_at: NOW })
  })

describe('the unread summary', () => {
  it('counts what the workspace inbox part shows, for every person of Northstar', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    let total = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined)) {
      const caller = t.withIdentity({ subject: person.auth_user_id as string })
      const part = await caller.query(api.workspace.inbox, { org_id: org.id })
      if (part.state !== 'ok') throw new Error(part.state)
      // Northstar holds far fewer than 500 messages, so the part is complete
      expect(part.truncated, person.name).toBe(false)
      const groups = new Set(
        part.unread.filter((m) => m.snoozed_until === undefined).map((m) => m.issue_id),
      )
      const summary = await caller.query(api.inbox.summary, {})
      expect(summary, person.name).toMatchObject({
        seats: [{ org_id: org.id, ready: true }],
        unread_count: groups.size,
        unread_more: false,
        complete: true,
      })
      total += groups.size
    }
    // the seed leaves unread items, so the comparison counts something
    expect(total).toBeGreaterThan(0)
    expect(await drift(t)).toEqual([])
  })

  it('is exact up to 99, says more than 99 from 100, and reads no task past the cap', async () => {
    const t = newT()
    const f = await withOrg(t)
    const expectCount = async (count: number, more: boolean) =>
      expect(await summaryOf(t, f.guest)).toEqual({
        seats: [
          { org_id: f.org.id, ready: true, can_mark_all_read: count > 0, can_remove_read: false },
        ],
        unread_count: count,
        unread_more: more,
        complete: true,
      })
    await expectCount(0, false)
    await plantItems(t, f, f.guest, 1, f.sub.id)
    await expectCount(1, false)
    await plantItems(t, f, f.guest, 98, f.sub.id)
    await expectCount(99, false)
    await plantItems(t, f, f.guest, 1, f.sub.id)
    await expectCount(100, true)
    const atCap = await measured(t, f.guest)
    await plantItems(t, f, f.guest, 50, f.sub.id)
    await expectCount(100, true)
    // with 150 items the walk stops where it stopped with 100
    const past = await measured(t, f.guest)
    expect(past.documents).toBe(atCap.documents)
    expect(past.ranges).toBe(atCap.ranges)
    expect(await drift(t)).toEqual([])
  })

  it('counts no item that is read, snoozed, archived, hidden, in Deleted items or another login’s', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const task = (project_id = f.sub.id) => plantIssue(t, { org_id: f.org.id, project_id })
    const shown = await task()
    await post(t, f, { to: f.guest, task: shown, minute: 1 })
    // read
    const read = await task()
    const readRow = (await post(t, f, { to: f.guest, task: read, minute: 2 }))!
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [readRow.id] })
    // snoozed
    const snoozed = await task()
    const snoozedRow = (await post(t, f, { to: f.guest, task: snoozed, minute: 3 }))!
    await guest.mutation(api.messages.snooze, {
      org_id: f.org.id,
      ids: [snoozedRow.id],
      until: new Date(START + DAY).toISOString(),
    })
    // archived before the archive's read step ran, which fake timers hold
    const archived = await task()
    await post(t, f, { to: f.guest, task: archived, minute: 4 })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: archived.id })
    expect((await pairRows(t, f.guest.id, archived.id))[0].read_at).toBeUndefined()
    // in an archived project
    const shelved = await plantProject(t, { org_id: f.org.id })
    await grant(t, f.guest, shelved.id)
    const inShelved = await task(shelved.id)
    await post(t, f, { to: f.guest, task: inShelved, minute: 5 })
    await t.run((ctx) => ctx.db.patch(shelved._id, { archived_at: NOW }))
    // in a project the guest lost access to after the message
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    const inLost = await task(lost.id)
    await post(t, f, { to: f.guest, task: inLost, minute: 6 })
    // moved to Deleted items, before its drain
    const trashed = await task()
    await post(t, f, { to: f.guest, task: trashed, minute: 7 })
    // another login's item
    const theirs = await task()
    await post(t, f, { to: f.user, task: theirs, minute: 8 })
    // before the last changes, the guest counts the lost and trashed ones too
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 3, complete: true })
    await revoke()
    // a budget too small for the drain inside the delete leaves it to steps
    TRASH_BUDGET.rows = 1
    await deleteTask(t, f, trashed.id)
    expect(await t.run((ctx) => byId(ctx, 'issues', trashed.id))).toBeNull()
    expect(await storedItem(t, f.guest.id, trashed.id)).not.toBeNull()
    expect(await summaryOf(t, f.guest)).toMatchObject({
      unread_count: 1,
      unread_more: false,
      complete: true,
      seats: [{ can_mark_all_read: true, can_remove_read: true }],
    })
    expect(await summaryOf(t, f.user)).toMatchObject({ unread_count: 1, complete: true })
    // the drain deletes the trashed task's item after its messages
    await runSteps(t)
    expect(await storedItem(t, f.guest.id, trashed.id)).toBeNull()
    expect(await drift(t)).toEqual([])
  })

  it('leaves out a moved task until its re-key says its project, and never counts a hidden one', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a sub-project the guest cannot see, as tasks live in sub-projects
    const hidden = await plantHiddenSibling(t, f, f.guest)
    const move = (id: string, project_id: string) =>
      as(t, f.admin).mutation(api.issues.move, { org_id: f.org.id, id, project_id })
    // from a project the guest sees into one they do not
    const away = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.guest, task: away, minute: 1 })
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 1 })
    REKEY.inline = 0
    await move(away.id, hidden.id)
    expect((await storedItem(t, f.guest.id, away.id))?.project_id).toBe(f.sub.id)
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 0, complete: true })
    await runSteps(t)
    expect((await storedItem(t, f.guest.id, away.id))?.project_id).toBe(hidden.id)
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 0, complete: true })
    // from a project the guest does not see into one they do, keyed to the
    // hidden project inline and then moved back while the re-key waits
    const back = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.guest, task: back, minute: 2 })
    REKEY.inline = DEFAULT_REKEY.inline
    await move(back.id, hidden.id)
    expect((await storedItem(t, f.guest.id, back.id))?.project_id).toBe(hidden.id)
    REKEY.inline = 0
    await move(back.id, f.sub2.id)
    // a short undercount until the step runs
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 0, complete: true })
    await runSteps(t)
    expect((await storedItem(t, f.guest.id, back.id))?.project_id).toBe(f.sub2.id)
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 1, complete: true })
    expect(await drift(t)).toEqual([])
  })

  it('skips a hidden project with one seek, not a task read for each of its items', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantItems(t, f, f.guest, 3, f.sub.id)
    const before = await measured(t, f.guest)
    expect(before.answer.unread_count).toBe(3)
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    await plantItems(t, f, f.guest, 300, lost.id)
    await revoke()
    const after = await measured(t, f.guest)
    expect(after.answer).toMatchObject({ unread_count: 3, unread_more: false, complete: true })
    // its first item, the project and the guest's levels on it, and the seek
    expect(after.ranges - before.ranges).toBeLessThan(8)
    expect(after.documents - before.documents).toBeLessThan(8)
    expect(await drift(t)).toEqual([])
  })

  it('answers a lower bound with complete false when the budget stops it, never a false zero', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 200 items of tasks archived before their read steps, then 5 it counts
    await archiveRaw(t, await plantItems(t, f, f.guest, 200, f.sub.id))
    await plantItems(t, f, f.guest, 5, f.sub.id)
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 5, complete: true })
    // a budget used up before the first counted task
    Object.assign(SUMMARY, { batch: 4, room: 0.01 })
    expect(await summaryOf(t, f.guest)).toEqual({
      seats: [{ org_id: f.org.id, ready: true, can_mark_all_read: true, can_remove_read: false }],
      unread_count: 0,
      unread_more: false,
      complete: false,
    })
    // and one used up before anything, the seats included
    SUMMARY.room = 0
    expect(await summaryOf(t, f.guest)).toEqual({
      seats: [],
      unread_count: 0,
      unread_more: false,
      complete: false,
    })
    expect(await drift(t)).toEqual([])
  })

  it('stops part way with a count below the true one when the room is lowered', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantItems(t, f, f.guest, 60, f.sub.id)
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 60, complete: true })
    Object.assign(SUMMARY, { batch: 4, room: 0.01 })
    const cut = await summaryOf(t, f.guest)
    expect(cut.complete).toBe(false)
    expect(cut.unread_more).toBe(false)
    expect(cut.unread_count).toBeGreaterThan(0)
    expect(cut.unread_count).toBeLessThan(60)
    expect(await drift(t)).toEqual([])
  })

  it('reads less than half of Convex’s limits for 100 tasks with the largest descriptions', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 20,000 characters of three bytes each, about 60 KB a task
    const description = '語'.repeat(20_000)
    await plantItems(t, f, f.guest, 100, f.sub.id, { description }, 10)
    const read = await measured(t, f.guest)
    expect(read.answer).toMatchObject({ unread_count: 100, unread_more: true, complete: true })
    expect(read.bytes).toBeGreaterThan(100 * 60_000)
    expect(read.bytes).toBeLessThan(8 * 1024 * 1024)
    expect(read.ranges).toBeLessThan(2048)
    expect(read.documents).toBeLessThan(16_000)
    expect(await drift(t)).toEqual([])
  })

  it('adds up the seats of one login and says which are not ready', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a second seat of the guest's login in the other organization
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.guest.auth_user_id,
      org_role: 'guest',
      name: 'guest',
    })
    await grant(t, elsewhere, f.otherProject.id)
    const other = { org: f.otherOrg, admin: f.otherAdmin }
    const seats = (rows: { org_id: string; ready: boolean }[]) =>
      rows.sort((a, b) => (a.org_id < b.org_id ? -1 : 1))
    // a seat with no state and no message is ready with nothing to count
    expect(await summaryOf(t, f.guest)).toMatchObject({
      seats: seats([
        { org_id: f.org.id, ready: true },
        { org_id: f.otherOrg.id, ready: true },
      ]),
      unread_count: 0,
      complete: true,
    })
    await plantItems(t, f, f.guest, 2, f.sub.id)
    await plantItems(t, other, elsewhere, 3, f.otherProject.id)
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 5, complete: true })
    // a seat still being built is not ready and adds nothing
    const state = await t.run((ctx) =>
      ctx.db
        .query('inbox_state')
        .withIndex('by_profile', (q) => q.eq('profile_id', elsewhere.id))
        .unique(),
    )
    await t.run((ctx) => ctx.db.patch(state!._id, { built: false }))
    expect(await summaryOf(t, f.guest)).toMatchObject({
      seats: seats([
        { org_id: f.org.id, ready: true },
        { org_id: f.otherOrg.id, ready: false },
      ]),
      unread_count: 2,
      complete: false,
    })
    // and so is one with messages from before its state
    await t.run((ctx) => ctx.db.delete(state!._id))
    expect(await summaryOf(t, f.guest)).toMatchObject({
      seats: seats([
        { org_id: f.org.id, ready: true },
        { org_id: f.otherOrg.id, ready: false },
      ]),
      unread_count: 2,
      complete: false,
    })
    // another login in the other organization counts none of them
    expect(await summaryOf(t, f.otherAdmin)).toMatchObject({ unread_count: 0, complete: true })
    // built again, its items were kept exact all along
    await t.run((ctx) => ctx.db.insert('inbox_state', { profile_id: elsewhere.id, built: true }))
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 5, complete: true })
    expect(await drift(t)).toEqual([])
  })

  it('offers the bulk actions when they would change anything, hidden tasks included', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const flags = async () => {
      const got = await summaryOf(t, f.guest)
      return [got.seats[0].can_mark_all_read, got.seats[0].can_remove_read]
    }
    expect(await flags()).toEqual([false, false])
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    const [hidden] = await plantItems(t, f, f.guest, 1, lost.id)
    await revoke()
    // an unread row about a task the guest cannot see
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 0 })
    expect(await flags()).toEqual([true, false])
    // once read, only Remove all read reaches it
    const [row] = await pairRows(t, f.guest.id, hidden.id)
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [row.id] })
    expect(await flags()).toEqual([false, true])
    await guest.mutation(api.messages.remove, { org_id: f.org.id, ids: [row.id] })
    // snoozed rows are out of both actions' reach, read or not
    const [task] = await plantItems(t, f, f.guest, 1, f.sub.id)
    const [snoozed] = await pairRows(t, f.guest.id, task.id)
    await guest.mutation(api.messages.snooze, {
      org_id: f.org.id,
      ids: [snoozed.id],
      until: new Date(START + DAY).toISOString(),
    })
    expect(await flags()).toEqual([false, false])
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [snoozed.id] })
    expect((await pairRows(t, f.guest.id, task.id))[0]).toMatchObject({
      read_at: expect.any(String),
      snoozed_until: expect.any(String),
    })
    expect(await flags()).toEqual([false, false])
    expect(await drift(t)).toEqual([])
  })
})

describe('one task’s item', () => {
  it('answers counts, the oldest unread message, the newest one and whether a change is unread', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // three messages, the oldest read and pruned away
    const a = await task()
    const first = (await post(t, f, { to: f.guest, task: a, minute: 1, kind: 'comment' }))!
    await post(t, f, { to: f.guest, task: a, minute: 2, kind: 'comment' })
    const newest = (await post(t, f, { to: f.guest, task: a, minute: 3, kind: 'change' }))!
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [first.id] })
    expect(await itemFor(t, f, f.guest, a.id)).toEqual({
      state: 'ok',
      item: {
        unread_count: 2,
        dropped: 0,
        first_unread_at: at(2),
        unread_change: true,
        latest_id: newest.id,
        latest_at: at(3),
        snoozed_until: null,
        through: newest._creationTime,
      },
    })
    // the item cap's dropped updates; the cap keeps the oldest unread
    // message, where the New divider goes
    const busy = await task()
    for (let i = 0; i < ITEM_UNREAD_CAP + 3; i++)
      await post(t, f, { to: f.guest, task: busy, minute: 10 + i, kind: 'comment' })
    expect(await itemFor(t, f, f.guest, busy.id)).toMatchObject({
      item: {
        unread_count: ITEM_UNREAD_CAP,
        dropped: 3,
        first_unread_at: at(10),
        unread_change: false,
      },
    })
    // the only change read, as the newest message the prune keeps
    const seen = await task()
    for (let i = 0; i < 5; i++)
      await post(t, f, { to: f.guest, task: seen, minute: 100 + i, kind: 'comment' })
    const change = (await post(t, f, { to: f.guest, task: seen, minute: 110, kind: 'change' }))!
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [change.id] })
    expect(await storedItem(t, f.guest.id, seen.id)).toMatchObject({ changes: 1, unread_count: 5 })
    expect(await itemFor(t, f, f.guest, seen.id)).toMatchObject({
      item: { unread_count: 5, first_unread_at: at(100), unread_change: false },
    })
    // neither walks the five unread messages: with no change it reads the
    // first unread one, and with a read change that read one besides
    const quiet = await task()
    for (let i = 0; i < 5; i++)
      await post(t, f, { to: f.guest, task: quiet, minute: 200 + i, kind: 'comment' })
    const documents = (issueId: string) =>
      t.run(async (ctx) => {
        const me = (await byId(ctx, 'profiles', f.guest.id))!
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        const answer = await readInboxItem(ctx, me, issueId)
        return {
          answer,
          read: (await ctx.meta.getTransactionMetrics()).documentsRead.used - before,
        }
      })
    const [withRead, one] = [await documents(seen.id), await documents(quiet.id)]
    expect(one.answer).toMatchObject({ item: { first_unread_at: at(200), unread_change: false } })
    expect(withRead.read - one.read).toBe(1)
    // a snoozed item says until when
    const until = new Date(START + DAY).toISOString()
    const ids = (await pairRows(t, f.guest.id, quiet.id)).map((m) => m.id)
    await guest.mutation(api.messages.snooze, { org_id: f.org.id, ids, until })
    expect(await itemFor(t, f, f.guest, quiet.id)).toMatchObject({ item: { snoozed_until: until } })
    expect(await drift(t)).toEqual([])
  })

  it('says whether a change is unread from the item’s counts, without walking a large item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await plantLegacy(t, f, f.guest, task, BUILD.pair_rows, () => 'comment')
    await backfillAll(t)
    // a change arrives last, trimming the oldest comments toward the cap
    const change = (await post(t, f, { to: f.guest, task, minute: 2000, kind: 'change' }))!
    const read = () =>
      t.run(async (ctx) => {
        const me = (await byId(ctx, 'profiles', f.guest.id))!
        const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        const answer = await readInboxItem(ctx, me, task.id)
        if (answer.state !== 'ok' || answer.item === null) throw new Error('no item')
        const after = (await ctx.meta.getTransactionMetrics()).documentsRead.used
        return {
          change: answer.item.unread_change,
          unread: answer.item.unread_count,
          documents: after - before,
        }
      })
    const unread = await read()
    expect(unread.change).toBe(true)
    expect(unread.unread).toBeGreaterThan(900)
    // the item row, the task and the access reads, and three messages at most
    expect(unread.documents).toBeLessThan(20)
    await as(t, f.guest).mutation(api.messages.markRead, { org_id: f.org.id, ids: [change.id] })
    const seen = await read()
    expect(seen.change).toBe(false)
    expect(seen.documents).toBeLessThan(20)
    expect(await drift(t)).toEqual([])
  })

  it('is null without an item, for a hidden task and for another person’s item, and building while not ready', async () => {
    const t = newT()
    const f = await withOrg(t)
    const none = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    expect(await itemFor(t, f, f.guest, none.id)).toEqual({ state: 'ok', item: null })
    expect(await itemFor(t, f, f.guest, uuid())).toEqual({ state: 'ok', item: null })
    // another person's item
    await post(t, f, { to: f.user, task: none, minute: 1 })
    expect(await itemFor(t, f, f.guest, none.id)).toEqual({ state: 'ok', item: null })
    expect(await itemFor(t, f, f.user, none.id)).toMatchObject({ item: { unread_count: 1 } })
    // a task the guest no longer sees
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    const [hidden] = await plantItems(t, f, f.guest, 1, lost.id)
    expect(await itemFor(t, f, f.guest, hidden.id)).toMatchObject({ item: { unread_count: 1 } })
    await revoke()
    expect(await itemFor(t, f, f.guest, hidden.id)).toEqual({ state: 'ok', item: null })
    // a seat with messages from before its state is not ready
    await plantMessage(t, { org_id: f.org.id, recipient_id: f.viewer.id, issue_id: none.id })
    expect(await itemFor(t, f, f.viewer, none.id)).toEqual({ state: 'building' })
    expect(await summaryOf(t, f.viewer)).toMatchObject({
      seats: [{ ready: false }],
      unread_count: 0,
      complete: false,
    })
    expect(await drift(t)).toEqual([])
  })
})

describe('the item actions', () => {
  it('readItem reads up to the newest message the caller saw, and only the caller’s item', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.guest, task: a, minute: 1 })
    await post(t, f, { to: f.guest, task: a, minute: 2, kind: 'comment' })
    await post(t, f, { to: f.user, task: a, minute: 2 })
    const view = await itemFor(t, f, f.guest, a.id)
    if (view.state !== 'ok' || view.item === null) throw new Error('no item')
    // a message arrives after the caller's view
    const later = (await post(t, f, { to: f.guest, task: a, minute: 3 }))!
    const { through } = view.item
    expect(
      await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: a.id, through }),
    ).toBeNull()
    // the prune deleted the rows read, as the arrival is the newest
    const left = await pairRows(t, f.guest.id, a.id)
    expect(left.map((m) => [m.id, m.read_at ?? null])).toEqual([[later.id, null]])
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({
      unread_count: 1,
      latest_id: later.id,
    })
    expect(await storedItem(t, f.user.id, a.id)).toMatchObject({ unread_count: 1 })
    expect(await drift(t)).toEqual([])
    // without through, all of it, the newest kept read
    await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: a.id })
    expect(await pairRows(t, f.guest.id, a.id)).toEqual([
      expect.objectContaining({ id: later.id, read_at: expect.any(String) }),
    ])
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({ unread_count: 0 })
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 0, complete: true })
    // a task only someone else holds an item about, and an unknown task
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.user, task: b, minute: 4 })
    await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: b.id })
    expect(
      await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: uuid() }),
    ).toBeNull()
    expect(await storedItem(t, f.user.id, b.id)).toMatchObject({ unread_count: 1 })
    expect(await summaryOf(t, f.user)).toMatchObject({ unread_count: 2 })
    expect(await drift(t)).toEqual([])
  })

  it('removeItem keeps a message that arrived after the caller’s view as the item’s only one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.guest, task: a, minute: 1, kind: 'comment' })
    await post(t, f, { to: f.guest, task: a, minute: 2 })
    const view = await itemFor(t, f, f.guest, a.id)
    if (view.state !== 'ok' || view.item === null) throw new Error('no item')
    const later = (await post(t, f, { to: f.guest, task: a, minute: 3, kind: 'mention' }))!
    await guest.mutation(api.messages.removeItem, {
      org_id: f.org.id,
      issue_id: a.id,
      through: view.item.through,
    })
    expect((await pairRows(t, f.guest.id, a.id)).map((m) => m.id)).toEqual([later.id])
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({
      latest_id: later.id,
      unread_count: 1,
      mentions: 1,
      comments: 0,
      changes: 0,
    })
    expect(await drift(t)).toEqual([])
    // without through the item goes
    await guest.mutation(api.messages.removeItem, { org_id: f.org.id, issue_id: a.id })
    expect(await storedItem(t, f.guest.id, a.id)).toBeNull()
    expect(await drift(t)).toEqual([])
  })

  it('readItem and removeItem leave out a later notice that carries an earlier time or a lower id', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const view = async (task: Doc<'issues'>) => {
      const got = await itemFor(t, f, f.guest, task.id)
      if (got.state !== 'ok' || got.item === null) throw new Error('no item')
      return got.item
    }
    // what a background step stores after the caller's view: a follower
    // notice with its write's earlier time, and one of the same instant
    // whose id sorts below the newest one's
    const lateNotices = async (task: Doc<'issues'>, seen: { latest_at: string }) => {
      const earlier = (await post(t, f, { to: f.guest, task, minute: 0, kind: 'comment' }))!
      const tied = await t.run(async (ctx) => {
        const edits = itemEdits(ctx)
        const row = {
          id: '00000000-0000-4000-8000-000000000000',
          org_id: f.org.id,
          recipient_id: f.guest.id,
          actor_id: f.admin.id,
          issue_id: task.id,
          issue_title: task.title,
          kind: 'comment' as const,
          detail: 'Tied',
          created_at: seen.latest_at,
        }
        await edits.insert(row, task.project_id)
        await edits.flush()
        return row
      })
      return [earlier.id, tied.id]
    }
    const unreadIds = async (task: Doc<'issues'>) =>
      (await pairRows(t, f.guest.id, task.id))
        .filter((m) => m.read_at === undefined)
        .map((m) => m.id)
        .sort()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.guest, task: a, minute: 1 })
    await post(t, f, { to: f.guest, task: a, minute: 2 })
    const seenA = await view(a)
    const lateA = await lateNotices(a, seenA)
    // they sort at or below the newest message the caller saw
    expect((await view(a)).latest_id).toBe(seenA.latest_id)
    await guest.mutation(api.messages.readItem, {
      org_id: f.org.id,
      issue_id: a.id,
      through: seenA.through,
    })
    expect(await unreadIds(a)).toEqual([...lateA].sort())
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({ unread_count: 2 })
    expect(await drift(t)).toEqual([])
    const b = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.guest, task: b, minute: 1 })
    await post(t, f, { to: f.guest, task: b, minute: 2 })
    const seenB = await view(b)
    const lateB = await lateNotices(b, seenB)
    await guest.mutation(api.messages.removeItem, {
      org_id: f.org.id,
      issue_id: b.id,
      through: seenB.through,
    })
    expect((await pairRows(t, f.guest.id, b.id)).map((m) => m.id).sort()).toEqual([...lateB].sort())
    expect(await drift(t)).toEqual([])
  })

  it('unreadItem and snoozeItem refuse an archived task as the id actions do, and skip a hidden one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const until = new Date(START + DAY).toISOString()
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const row = (await post(t, f, { to: f.guest, task: a, minute: 1 }))!
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [row.id] })
    // before the archive, unreadItem opens the item again
    await guest.mutation(api.messages.unreadItem, { org_id: f.org.id, issue_id: a.id })
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({ unread_count: 1 })
    await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: a.id })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: a.id })
    const byIds = await expectRefusal(
      guest.mutation(api.messages.markUnread, { org_id: f.org.id, ids: [row.id] }),
      'rule',
      /is archived and must be restored first$/,
    )
    const byItem = await expectRefusal(
      guest.mutation(api.messages.unreadItem, { org_id: f.org.id, issue_id: a.id }),
      'rule',
    )
    expect(byItem.data.message).toBe(byIds.data.message)
    const snoozeIds = await expectRefusal(
      guest.mutation(api.messages.snooze, { org_id: f.org.id, ids: [row.id], until }),
      'rule',
    )
    const snoozeItem = await expectRefusal(
      guest.mutation(api.messages.snoozeItem, { org_id: f.org.id, issue_id: a.id, until }),
      'rule',
    )
    expect(snoozeItem.data.message).toBe(snoozeIds.data.message)
    // an archived task the guest no longer sees changes nothing, silently
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    const [hidden] = await plantItems(t, f, f.guest, 1, lost.id)
    await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: hidden.id })
    await revoke()
    await archiveRaw(t, [hidden])
    const before = await pairRows(t, f.guest.id, hidden.id)
    expect(
      await guest.mutation(api.messages.unreadItem, { org_id: f.org.id, issue_id: hidden.id }),
    ).toBeNull()
    expect(
      await guest.mutation(api.messages.snoozeItem, {
        org_id: f.org.id,
        issue_id: hidden.id,
        until,
      }),
    ).toBeNull()
    expect(await pairRows(t, f.guest.id, hidden.id)).toEqual(before)
    expect(await drift(t)).toEqual([])
  })

  it('snoozeItem snoozes the whole item until its wake and refuses a time past or too far ahead', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const a = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await post(t, f, { to: f.guest, task: a, minute: 1 })
    await post(t, f, { to: f.guest, task: a, minute: 2 })
    const snooze = (until: string | null) =>
      guest.mutation(api.messages.snoozeItem, { org_id: f.org.id, issue_id: a.id, until })
    await expectRefusal(
      snooze(new Date(START - DAY).toISOString()),
      'bad_request',
      /until must be in the future/,
    )
    await expectRefusal(
      snooze(new Date(START + (LIMITS.snooze.max + 1) * DAY).toISOString()),
      'rule',
      new RegExp(LIMITS.snooze.refusal.replace(/[.]/g, '\\.')),
    )
    const until = new Date(START + DAY).toISOString()
    expect(await snooze(until)).toBeNull()
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({
      snoozed: true,
      snoozed_until: until,
      unread_count: 2,
    })
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 0 })
    const wakes = await t.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name.includes('wake') && job.state.kind === 'pending',
      ),
    )
    expect(wakes).toEqual([
      expect.objectContaining({
        scheduledTime: START + DAY,
        args: [{ recipient_id: f.guest.id, issue_id: a.id, until }],
      }),
    ])
    await runSteps(t)
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({
      snoozed: false,
      unread_count: 2,
      woke_rows: 2,
    })
    expect(await summaryOf(t, f.guest)).toMatchObject({ unread_count: 1 })
    // null lifts a snooze early
    await snooze(new Date(START + 2 * DAY).toISOString())
    await snooze(null)
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({ snoozed: false })
    expect(await drift(t)).toEqual([])
  })

  it('reads a legacy item of 1,000 messages the backfill built inside Convex’s limits', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b] = [
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }),
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }),
    ]
    for (const task of [a, b])
      await plantLegacy(t, f, f.guest, task, BUILD.pair_rows, (i) =>
        i % 2 === 0 ? 'change' : 'comment',
      )
    expect(await itemFor(t, f, f.guest, a.id)).toEqual({ state: 'building' })
    await backfillAll(t)
    expect(await storedItem(t, f.guest.id, a.id)).toMatchObject({ unread_count: BUILD.pair_rows })
    expect(await itemFor(t, f, f.guest, a.id)).toMatchObject({
      item: { unread_count: BUILD.pair_rows, first_unread_at: at(0), unread_change: true },
    })
    // the handler's reads and writes, measured in one transaction
    const used = await t.run(async (ctx) => {
      const me = (await byId(ctx, 'profiles', f.guest.id))!
      await markMessagesRead(ctx, me, await itemMessages(ctx, me, a.id), at(2000))
      return await ctx.meta.getTransactionMetrics()
    })
    // 1,000 patches, 999 deletes by the prune, the item row and the sweep row
    expect(used.documentsWritten.used).toBeGreaterThan(1990)
    expect(used.documentsWritten.used).toBeLessThan(16_000 / 4)
    expect(used.bytesWritten.used).toBeLessThan(4 * 1024 * 1024)
    expect(used.bytesRead.used).toBeLessThan(8 * 1024 * 1024)
    expect(used.databaseQueries.used).toBeLessThan(100)
    expect(await pairRows(t, f.guest.id, a.id)).toHaveLength(1)
    // and the mutation itself on the other one
    await as(t, f.guest).mutation(api.messages.readItem, { org_id: f.org.id, issue_id: b.id })
    expect(await pairRows(t, f.guest.id, b.id)).toHaveLength(1)
    expect(await storedItem(t, f.guest.id, b.id)).toMatchObject({ unread_count: 0 })
    expect(await drift(t)).toEqual([])
  })
})
