/* The Inbox feed (inbox.feed, model/notificationCatchup.ts readInboxFeed):
 * its argument checks, the events it answers with their keys, times and
 * text, its floor and the minute it reads back, the access each event
 * needs, the seats it reads and skips, its cap, budgets and stopped checks
 * with what `more` says, its agreement with the catch-up, that it writes
 * nothing, and its reads at the design size. Time is fake and starts at
 * helpers.setup.ts NOW, the time the inbox fixtures post at
 * (inboxItems.setup.ts at), so an event's time and a floor compare. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import * as inbox from '../inbox'
import { OWN_READS } from '../lib/access'
import { newWindowKey } from '../lib/db'
import { ALERT_WINDOW_MS } from '../lib/limits'
import { insertTask } from '../model/descriptions'
import { markMessagesRead, postMessage } from '../model/messages'
import { FEED, type Feed, missedActivity } from '../model/notificationCatchup'
import { NOTIFY } from '../model/notificationSessions'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { archiveRaw, at, drift, grant, plantItems, post } from './inboxItems.setup'

const MINUTE = 60_000
const DAY = 86_400_000
const START = Date.parse(NOW)
const DEFAULT_FEED = structuredClone(FEED)
const DEFAULT_NOTIFY = structuredClone(NOTIFY)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)

beforeEach(() => {
  vi.useFakeTimers()
  clock(0)
})
afterEach(() => {
  Object.assign(FEED, structuredClone(DEFAULT_FEED))
  Object.assign(NOTIFY, structuredClone(DEFAULT_NOTIFY))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** Sets the server's time to `minutes` after NOW. */
function clock(minutes: number): void {
  vi.setSystemTime(START + minutes * MINUTE)
}

/** The epoch time `minutes` after NOW. */
const minute = (minutes: number) => START + minutes * MINUTE

/** `who`'s feed after the floor `after`. */
const feedOf = (t: T, who: Doc<'profiles'>, after: number): Promise<Feed> =>
  as(t, who).query(api.inbox.feed, { after })

/** The keys of a feed answer, newest first. */
const keys = (feed: Feed) => feed.events.map((e) => e.key)

/** A new task in `project_id` (the guest's first sub-project) with one
 * message to the guest, made `minutes` after NOW, and that message. */
async function newsAt(t: T, f: OrgFixture, minutes: number, project_id = f.sub.id) {
  const task = await plantIssue(t, { org_id: f.org.id, project_id, title: `Task at ${minutes}` })
  const message = await post(t, f, { to: f.guest, task, minute: minutes })
  if (message === null) throw new Error('no message was stored')
  return { task, message }
}

/** The message, item and build state rows, which the feed must not
 * change. */
const inboxRows = (t: T) =>
  t.run(async (ctx) => ({
    messages: await ctx.db.query('messages').collect(),
    items: await ctx.db.query('inbox_items').collect(),
    states: await ctx.db.query('inbox_state').collect(),
  }))

/** The feed of the profiles of login `who` read in one transaction, with
 * what the transaction read, as Convex counts it. */
const measured = (t: T, who: Doc<'profiles'>, after: number) =>
  as(t, who).run(async (ctx) => {
    const answer = (await (
      inbox.feed as unknown as {
        _handler: (ctx: unknown, args: { after: number }) => Promise<Feed>
      }
    )._handler(ctx, { after })) as Feed
    const m = await ctx.meta.getTransactionMetrics()
    return {
      answer,
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      bytes: m.bytesRead.used,
    }
  })

/* -------------------------------------------------------------- arguments */

describe('arguments and the caller', () => {
  it.each([
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['past the last four-digit year', Date.parse('9999-12-31T23:59:59.999Z') + 1],
    ['past the largest time a Date holds', 8.64e15],
  ])('refuses a floor that is %s', async (_, after) => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await newsAt(t, f, 1)
    await expectRefusal(feedOf(t, f.guest, after), 'bad_request', /epoch milliseconds/)
  })

  it('takes the earliest time and the last of a four-digit year', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { message } = await newsAt(t, f, 1)
    expect(keys(await feedOf(t, f.guest, 0))).toEqual([message.id])
    const latest = Date.parse('9999-12-31T23:59:59.999Z')
    expect(await feedOf(t, f.guest, latest)).toEqual({
      events: [],
      through: latest,
      more: false,
    })
  })

  it('needs a sign-in, and on the demo an active demo', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await expectRefusal(t.query(api.inbox.feed, { after: 0 }), 'forbidden', /not signed in/)
    vi.stubEnv('APP_MODE', 'demo')
    const receipt = await t.run((ctx) =>
      ctx.db.insert('demo_sessions', {
        id: uuid(),
        auth_user_id: f.guest.auth_user_id as string,
        org_id: f.org.id,
        status: 'ready',
        created_at: Date.now(),
        expires_at: Date.now() + DAY,
      }),
    )
    await newsAt(t, f, 1)
    expect((await feedOf(t, f.guest, 0)).events).toHaveLength(1)
    await t.run((ctx) => ctx.db.patch(receipt, { expires_at: Date.now() }))
    await expectRefusal(feedOf(t, f.guest, 0), 'forbidden', /expired/)
  })

  it('answers only the caller’s own items, whatever another login holds', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { message } = await newsAt(t, f, 1)
    // the viewer sees the same project and has a message about another task
    const other = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const theirs = await post(t, f, { to: f.viewer, task: other, minute: 2 })
    expect(keys(await feedOf(t, f.guest, 0))).toEqual([message.id])
    expect(keys(await feedOf(t, f.viewer, 0))).toEqual([theirs?.id])
    expect((await feedOf(t, f.otherAdmin, 0)).events).toEqual([])
  })
})

/* ----------------------------------------------------------------- events */

describe('events', () => {
  it('answers a new message with its key, time, kind, the live title, the actor and the detail', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { task, message } = await newsAt(t, f, 1)
    await t.run((ctx) => ctx.db.patch(task._id, { title: 'Renamed since' }))
    const mention = await post(t, f, {
      to: f.guest,
      task,
      minute: 2,
      kind: 'mention',
      body: 'Look at this',
    })
    const got = await feedOf(t, f.guest, minute(0))
    expect(got).toEqual({
      events: [
        {
          key: mention?.id,
          at: minute(2),
          kind: 'mention',
          title: 'Renamed since',
          actor_name: 'admin',
          detail: mention?.detail,
        },
        {
          key: message.id,
          at: minute(1),
          kind: 'change',
          title: 'Renamed since',
          actor_name: 'admin',
          detail: message.detail,
        },
      ],
      through: minute(2),
      more: false,
    })
  })

  it('names no actor for a machine caller, a removed profile or a profile of another organization', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const postAs = (actor_id: string | undefined, minutes: number) =>
      t.run((ctx) =>
        postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: f.guest.id,
          issue_id: task.id,
          kind: 'comment',
          body: `From ${actor_id ?? 'a machine'}`,
          actor_id,
          now: at(minutes),
        }),
      )
    await postAs(undefined, 1)
    await postAs(f.otherAdmin.id, 2)
    await postAs(f.user.id, 3)
    expect((await feedOf(t, f.guest, 0)).events.map((e) => e.actor_name)).toEqual([
      'user',
      null,
      null,
    ])
    await t.run((ctx) => ctx.db.delete(f.user._id))
    expect((await feedOf(t, f.guest, 0)).events.map((e) => e.actor_name)).toEqual([
      null,
      null,
      null,
    ])
  })

  it('answers the alert’s detail as the Inbox shows it', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      await postMessage(ctx, {
        org_id: f.org.id,
        recipient_id: f.guest.id,
        issue_id: task.id,
        kind: 'change',
        body: 'Moved to an issue in another project',
        actor_id: f.admin.id,
        now: at(1),
      })
    })
    expect((await feedOf(t, f.guest, 0)).events[0].detail).toBe(
      'Moved to a task in another project',
    )
  })

  it('answers every unread message after the floor less a minute, and only those', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { task, message: first } = await newsAt(t, f, 1)
    const second = await post(t, f, { to: f.guest, task, minute: 2 })
    const third = await post(t, f, { to: f.guest, task, minute: 3 })
    // three unread messages on one task answer three events
    expect((await feedOf(t, f.guest, minute(0))).events).toHaveLength(3)
    // the floor at minute 2 reads back to minute 1, which it does not take
    expect(keys(await feedOf(t, f.guest, minute(2)))).toEqual([third?.id, second?.id])
    // a message in the minute before the floor answers
    expect(keys(await feedOf(t, f.guest, minute(3.5)))).toEqual([third?.id])
    // one before the floor less the minute does not
    expect(keys(await feedOf(t, f.guest, minute(4)))).toEqual([])
    // the newest read, the older two stay unread and answer
    await t.run(async (ctx) => {
      await markMessagesRead(ctx, f.guest, [(await ctx.db.get(third!._id))!], at(4))
    })
    expect(keys(await feedOf(t, f.guest, minute(0)))).toEqual([second?.id, first.id])
    expect(await drift(t)).toEqual([])
  })

  it('answers no snoozed item, and a scheduled wake as its own event with the newest unread message’s detail', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const guest = as(t, f.guest)
    const { task, message } = await newsAt(t, f, 1)
    const until = new Date(minute(5)).toISOString()
    await guest.mutation(api.messages.snoozeItem, { org_id: f.org.id, issue_id: task.id, until })
    expect(keys(await feedOf(t, f.guest, minute(0)))).toEqual([])
    clock(5)
    await t.mutation(internal.messages.wake, { recipient_id: f.guest.id, issue_id: task.id, until })
    const woke = await t.run(async (ctx) => (await ctx.db.get(message._id))?.woke_at)
    expect(woke).toBe(new Date(minute(5)).toISOString())
    // the wake is after the floor, the message long before it
    expect(await feedOf(t, f.guest, minute(4))).toEqual({
      events: [
        {
          key: `${task.id}:${woke}`,
          at: minute(5),
          kind: 'wake',
          title: task.title,
          actor_name: null,
          detail: message.detail,
        },
      ],
      through: minute(5),
      more: false,
    })
    // a manual Unsnooze is no wake event
    const { task: other } = await newsAt(t, f, 6)
    await guest.mutation(api.messages.snoozeItem, {
      org_id: f.org.id,
      issue_id: other.id,
      until: new Date(minute(30)).toISOString(),
    })
    clock(7)
    await guest.mutation(api.messages.snoozeItem, {
      org_id: f.org.id,
      issue_id: other.id,
      until: null,
    })
    // the message itself still answers, and no wake beside it
    expect((await feedOf(t, f.guest, minute(4.5))).events.map((e) => [e.title, e.kind])).toEqual([
      [other.title, 'change'],
      [task.title, 'wake'],
    ])
  })

  it('answers through as the newest event’s time, never below the floor', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    expect(await feedOf(t, f.guest, minute(0))).toEqual({
      events: [],
      through: minute(0),
      more: false,
    })
    await newsAt(t, f, 1)
    await newsAt(t, f, 2)
    expect((await feedOf(t, f.guest, minute(0))).through).toBe(minute(2))
    // only the minute before the floor holds events
    const back = await feedOf(t, f.guest, minute(2.5))
    expect(back.events).toHaveLength(1)
    expect(back.through).toBe(minute(2.5))
  })
})

/* ----------------------------------------------------------------- access */

describe('access', () => {
  it('passes an item about a project the seat no longer sees without reading its task', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    await plantItems(t, f, f.guest, 20, lost.id)
    const shown = await measured(t, f.guest, minute(-1))
    expect(shown.answer.events).toHaveLength(20)
    await revoke()
    const hidden = await measured(t, f.guest, minute(-1))
    expect(hidden.answer).toEqual({ events: [], through: minute(-1), more: false })
    // 20 index entries and a project check, no task or message read
    expect(hidden.documents).toBeLessThan(shown.documents - 40)
    expect(hidden.documents).toBeLessThan(40)
  })

  it('answers nothing about an archived task or a project outside a guest’s shares', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { task } = await newsAt(t, f, 1)
    const { message: kept } = await newsAt(t, f, 2)
    const elsewhere = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, elsewhere.id)
    await newsAt(t, f, 3, elsewhere.id)
    await revoke()
    await archiveRaw(t, [task])
    expect(keys(await feedOf(t, f.guest, 0))).toEqual([kept.id])
  })

  it('reads and checks the task of an item without a project', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { task, message } = await newsAt(t, f, 1)
    await t.run(async (ctx) => {
      const item = await ctx.db
        .query('inbox_items')
        .withIndex('by_recipient_issue', (q) =>
          q.eq('recipient_id', f.guest.id).eq('issue_id', task.id),
        )
        .unique()
      await ctx.db.patch(item!._id, { project_id: undefined })
    })
    expect(keys(await feedOf(t, f.guest, 0))).toEqual([message.id])
    await t.run((ctx) => ctx.db.patch(task._id, { project_id: f.hidden.id }))
    expect(keys(await feedOf(t, f.guest, 0))).toEqual([])
  })

  it('leaves out an item whose check a bound stopped, says more, and keeps the other seats', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // a seat that sees PCB only through its team, as in the summary's case
    const me = await plantLogin(t, await plantSeat(t, { org_id: f.org.id, accepted_at: NOW }))
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
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const shared = await post(t, f, { to: me, task, minute: 1 })
    // the login's second seat, read after the first, an admin who leads its
    // project, as admin status alone shows no project, with two events
    const later = await laterOrg(t, f.org.id)
    const second = await plantSeat(t, {
      org_id: later.id,
      auth_user_id: me.auth_user_id,
      org_role: 'admin',
      accepted_at: NOW,
    })
    const elsewhere = await plantProject(t, { org_id: later.id, lead_id: second.id })
    const there: (Doc<'messages'> | null)[] = []
    for (const minutes of [4, 5]) {
      const other = await plantIssue(t, { org_id: later.id, project_id: elsewhere.id })
      there.push(
        await post(t, { org: later, admin: f.admin }, { to: second, task: other, minute: minutes }),
      )
    }
    const theirs = [there[1]?.id, there[0]?.id]
    expect(keys(await feedOf(t, me, 0))).toEqual([...theirs, shared?.id])
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    // the stopped check ends its own seat only, and the next seat answers
    const stopped = await feedOf(t, me, 0)
    expect(keys(stopped)).toEqual(theirs)
    expect(stopped).toMatchObject({ through: minute(5), more: true })
    // an item from before the floor, read back in its minute, whose check
    // stops asks for no summary
    const before = await feedOf(t, me, minute(1.5))
    expect(keys(before)).toEqual(theirs)
    expect(before).toMatchObject({ through: minute(5), more: false })
  })
})

/** A new organization whose id sorts after `than`, so the feed reads a
 * seat of it after one of `than`'s. */
async function laterOrg(t: T, than: string) {
  let id = uuid()
  while (id <= than) id = uuid()
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('organizations', {
      id,
      name: 'Later',
      slug: `later-${id.slice(0, 8)}`,
      created_at: NOW,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
    })
    await ctx.db.insert('org_counters', { org_id: id, next_issue_num: 1, next_project_num: 2 })
    return (await ctx.db.get(_id)) as Doc<'organizations'>
  })
}

/* ------------------------------------------------------------------ seats */

describe('seats', () => {
  /** A second seat of the guest's login in the other organization, granted
   * its project. */
  async function secondSeat(t: T, f: OrgFixture) {
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.guest.auth_user_id,
      org_role: 'guest',
      name: 'guest',
    })
    await grant(t, elsewhere, f.otherProject.id)
    return elsewhere
  }

  it('answers both organizations’ events, newest first', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const elsewhere = await secondSeat(t, f)
    const { message: here } = await newsAt(t, f, 1)
    const task = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    const there = await post(
      t,
      { org: f.otherOrg, admin: f.otherAdmin },
      {
        to: elsewhere,
        task,
        minute: 2,
      },
    )
    const got = await feedOf(t, f.guest, 0)
    expect(keys(got)).toEqual([there?.id, here.id])
    expect(got.events[0].actor_name).toBe('otherAdmin')
  })

  it('skips a seat that is not ready without saying more, and leaves out an organization being deleted', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const elsewhere = await secondSeat(t, f)
    const { message: here } = await newsAt(t, f, 1)
    const task = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await post(t, { org: f.otherOrg, admin: f.otherAdmin }, { to: elsewhere, task, minute: 2 })
    const state = await t.run((ctx) =>
      ctx.db
        .query('inbox_state')
        .withIndex('by_profile', (q) => q.eq('profile_id', elsewhere.id))
        .unique(),
    )
    await t.run((ctx) => ctx.db.patch(state!._id, { built: false }))
    expect(await feedOf(t, f.guest, 0)).toEqual({
      events: [expect.objectContaining({ key: here.id })],
      through: minute(1),
      more: false,
    })
    await t.run((ctx) => ctx.db.patch(state!._id, { built: true }))
    expect((await feedOf(t, f.guest, 0)).events).toHaveLength(2)
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.otherOrg.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      }),
    )
    expect(keys(await feedOf(t, f.guest, 0))).toEqual([here.id])
  })
})

/* ----------------------------------------------------------------- bounds */

describe('the cap, the budgets and more', () => {
  it('answers the 50 newest of 51 events and more, and exactly 50 whole', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const tasks = await plantItems(t, f, f.guest, 51, f.sub.id)
    const all = await feedOf(t, f.guest, minute(-10))
    expect(all.events).toHaveLength(50)
    expect(all.more).toBe(true)
    expect(all.through).toBe(minute(50))
    expect(all.events.at(-1)?.title).toBe(tasks[1].title)
    // the oldest after a floor that leaves exactly 50 events
    const fifty = await feedOf(t, f.guest, minute(1.5))
    expect(fifty.events).toHaveLength(50)
    expect(fifty.more).toBe(false)
  })

  it('says more for the read-back minute never alone', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // a burst of 60 over three tasks, all within half a minute
    const tasks = [
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }),
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }),
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }),
    ]
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++)
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: f.guest.id,
          issue_id: tasks[i % 3].id,
          kind: 'comment',
          body: `Burst ${i}`,
          actor_id: f.admin.id,
          now: new Date(minute(1) + i * 500).toISOString(),
        })
    })
    const before = await feedOf(t, f.guest, minute(0.5))
    expect(before.events).toHaveLength(50)
    expect(before.more).toBe(true)
    // a floor past the burst reads it back whole as the minute before it,
    // and the cap's cut there asks for nothing
    const past = await feedOf(t, f.guest, minute(1.6))
    expect(past.events).toHaveLength(50)
    expect(past.more).toBe(false)
    // a floor inside the burst says more only for what is newer than it
    expect((await feedOf(t, f.guest, minute(1.25))).more).toBe(false)
    expect((await feedOf(t, f.guest, minute(1.05))).more).toBe(true)
  })

  it('says more at a pass or a stop only for an item newer than the floor', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // 52 items with one message each, all in the minute before the floor
    await t.run(async (ctx) => {
      for (let i = 0; i < 52; i++) {
        const id = uuid()
        await insertTask(
          ctx.db,
          {
            id,
            org_id: f.org.id,
            project_id: f.sub.id,
            num: 80_000 + i,
            title: `Read back ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
          },
          'restore',
        )
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: f.guest.id,
          issue_id: id,
          kind: 'comment',
          body: `Read back ${i}`,
          actor_id: f.admin.id,
          now: new Date(minute(1.1) + i * 1_000).toISOString(),
        })
      }
    })
    // the cap passes the two oldest items, which only the minute read back holds
    expect(await feedOf(t, f.guest, minute(2))).toMatchObject({ more: false })
    expect((await feedOf(t, f.guest, minute(2))).events).toHaveLength(50)
    // a floor before them says more for the items the cap passed
    expect(await feedOf(t, f.guest, minute(1))).toMatchObject({ more: true })
    // a stop at an item the minute read back holds asks for nothing
    FEED.items = 10
    expect(await feedOf(t, f.guest, minute(2))).toMatchObject({ more: false })
    expect(await feedOf(t, f.guest, minute(1))).toMatchObject({ more: true })
  })

  it('stops at FEED.items, at the budget and before a seat it did not reach, saying more', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { message } = await newsAt(t, f, 1)
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    // five newer items about a project the guest no longer sees
    for (let i = 0; i < 5; i++) await newsAt(t, f, 2 + i, lost.id)
    await revoke()
    expect(await feedOf(t, f.guest, 0)).toEqual({
      events: [expect.objectContaining({ key: message.id })],
      through: minute(1),
      more: false,
    })
    FEED.items = 3
    expect(await feedOf(t, f.guest, 0)).toEqual({ events: [], through: 0, more: true })
    // a stop at an item from before the floor asks for nothing: the read
    // from minute 2.9 examines the items of minutes 6, 5 and 4 and stops at
    // minute 3's, which sorts before the floor
    expect(await feedOf(t, f.guest, minute(3.9))).toEqual({
      events: [],
      through: minute(3.9),
      more: false,
    })
    Object.assign(FEED, structuredClone(DEFAULT_FEED))
    // a budget with no room from the start
    FEED.room = 0
    expect(await feedOf(t, f.guest, 0)).toEqual({ events: [], through: 0, more: true })
  })

  it('pins its cap to a claim’s and its window to the claims’', () => {
    expect(FEED.events).toBe(NOTIFY.claim_keys)
    expect(NOTIFY.live_window_ms).toBe(ALERT_WINDOW_MS)
  })
})

/* ---------------------------------------------- agreement with the catch-up */

describe('the catch-up', () => {
  it('answers events for the items missedActivity counts after the same time', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const guest = as(t, f.guest)
    // before the time, an item with a newer message after it, a wake after
    // it, a snoozed item, a hidden project, an archived task and a read one
    await newsAt(t, f, 1)
    const { task: busy } = await newsAt(t, f, 2)
    await post(t, f, { to: f.guest, task: busy, minute: 6 })
    await post(t, f, { to: f.guest, task: busy, minute: 7 })
    const { task: dozing } = await newsAt(t, f, 3)
    const until = new Date(minute(8)).toISOString()
    await guest.mutation(api.messages.snoozeItem, { org_id: f.org.id, issue_id: dozing.id, until })
    clock(8)
    await t.mutation(internal.messages.wake, {
      recipient_id: f.guest.id,
      issue_id: dozing.id,
      until,
    })
    const { task: sleeping } = await newsAt(t, f, 9)
    await guest.mutation(api.messages.snoozeItem, {
      org_id: f.org.id,
      issue_id: sleeping.id,
      until: new Date(minute(60)).toISOString(),
    })
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    await newsAt(t, f, 10, lost.id)
    await revoke()
    const { task: archived } = await newsAt(t, f, 11)
    await archiveRaw(t, [archived])
    const { message: read } = await newsAt(t, f, 12)
    await t.run(async (ctx) => {
      await markMessagesRead(ctx, f.guest, [(await ctx.db.get(read._id))!], at(13))
    })
    await newsAt(t, f, 14)
    const time = minute(5)
    const caught = await t.run(async (ctx) => {
      const seats = await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', f.guest.auth_user_id))
        .collect()
      return await missedActivity(ctx, seats, time, time, async () => false)
    })
    expect(caught.state).toBe('found')
    const fed = await feedOf(t, f.guest, time + NOTIFY.lag_ms)
    expect(fed.more).toBe(false)
    expect(keys(fed).sort()).toEqual([...caught.keys].sort())
    expect(fed.events).toHaveLength(4)
  })
})

/* -------------------------------------------------------- nothing written */

describe('the feed', () => {
  it('writes nothing', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await newsAt(t, f, 1)
    await plantItems(t, f, f.guest, 60, f.sub.id)
    const before = await inboxRows(t)
    await feedOf(t, f.guest, 0)
    await feedOf(t, f.guest, minute(30))
    expect(await inboxRows(t)).toEqual(before)
  })
})

/* ------------------------------------------------- inside Convex's limits */

/** Logs one measured read of a design size case and checks it stayed well
 * inside Convex's limits for one call. */
function logged(label: string, r: Awaited<ReturnType<typeof measured>>) {
  console.log(
    `${label}: ${r.answer.events.length} events, more ${r.answer.more}, ${r.ranges} ranges, ${r.documents} documents, ${(r.bytes / 1024).toFixed(0)} KiB read`,
  )
  expect(r.ranges, label).toBeLessThan(4096 / 2)
  expect(r.documents, label).toBeLessThan(32_000 / 2)
  expect(r.bytes, label).toBeLessThan(8 * 1024 * 1024)
  return r
}

/** `n` sub-projects of a new top-level project the guest is granted, and a
 * function that takes the grant away. */
async function grantedProject(t: T, f: OrgFixture, n: number) {
  const top = await plantProject(t, { org_id: f.org.id })
  const subs: Doc<'projects'>[] = []
  for (let i = 0; i < n; i++)
    subs.push(await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: top.id }))
  return { subs, revoke: await grant(t, f.guest, top.id) }
}

/** `n` sub-projects the guest reads, at most 3 under each new top-level
 * project the guest is granted, the everyday count, so a case raises only
 * the person's figure. */
async function grantedSpread(t: T, f: OrgFixture, n: number) {
  const subs: Doc<'projects'>[] = []
  while (subs.length < n)
    subs.push(...(await grantedProject(t, f, Math.min(3, n - subs.length))).subs)
  return subs
}

describe('inside Convex’s limits', () => {
  it('answers the everyday Inbox’s new activity whole: 60 groups over 3 sub-projects, 10 new', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const { subs } = await grantedProject(t, f, 3)
    // 50 groups (minutes 0 to 16) before the floor less its minute
    for (const [i, sub] of subs.entries())
      await plantItems(t, f, f.guest, i === 2 ? 16 : 17, sub.id)
    for (let i = 0; i < 10; i++) await newsAt(t, f, 20 + i, subs[i % 3].id)
    const r = logged('feed, the everyday Inbox', await measured(t, f.guest, minute(19)))
    expect(r.answer.events).toHaveLength(10)
    expect(r.answer.more).toBe(false)
  })

  it('passes 1,000 groups of a project the seat no longer sees without reading their tasks', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // the project figure: 800 open and 200 Done tasks over its 3
    // sub-projects, a group each, all after the floor
    const { subs, revoke } = await grantedProject(t, f, 3)
    for (const [i, sub] of subs.entries()) {
      await plantItems(t, f, f.guest, i === 2 ? 266 : 267, sub.id)
      await plantItems(t, f, f.guest, i === 2 ? 66 : 67, sub.id, { status: 'done' })
    }
    await revoke()
    const r = logged(
      'feed, 1,000 groups of a hidden project',
      await measured(t, f.guest, minute(-10)),
    )
    expect(r.answer).toEqual({ events: [], through: minute(-10), more: false })
    expect(r.documents).toBeGreaterThan(1000)
    expect(r.documents).toBeLessThan(1100)
  })

  it('answers one sub-project’s 300 open groups cut at 50, or from one empty range', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await plantItems(t, f, f.guest, 300, f.sub.id)
    const cut = logged('feed, 300 groups after the floor', await measured(t, f.guest, minute(-10)))
    expect(cut.answer.events).toHaveLength(50)
    expect(cut.answer.more).toBe(true)
    const none = logged(
      'feed, 300 groups before the floor',
      await measured(t, f.guest, minute(400)),
    )
    expect(none.answer).toEqual({ events: [], through: minute(400), more: false })
    expect(none.documents).toBeLessThan(20)
  })

  it('answers one task’s 50 unread messages and its wake, cut at 50', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const guest = as(t, f.guest)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++)
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: f.guest.id,
          issue_id: task.id,
          kind: 'comment',
          body: `Comment ${i}`,
          actor_id: f.admin.id,
          now: at(i * 0.1),
        })
    })
    const until = new Date(minute(10)).toISOString()
    await guest.mutation(api.messages.snoozeItem, { org_id: f.org.id, issue_id: task.id, until })
    clock(10)
    await t.mutation(internal.messages.wake, { recipient_id: f.guest.id, issue_id: task.id, until })
    const r = logged(
      'feed, one task’s 50 unread messages and its wake',
      await measured(t, f.guest, minute(-10)),
    )
    expect(r.answer.events).toHaveLength(50)
    expect(r.answer.events[0].kind).toBe('wake')
    expect(r.answer.more).toBe(true)
  })

  it('cuts 200 sub-projects’ new groups at 50, each with its own actor', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // the person figure, 200 sub-projects the guest reads, 3 under each of
    // 67 granted projects, a new group in each from one of 50 actors
    const subs = await grantedSpread(t, f, 200)
    expect(new Set(subs.map((s) => s.parent_id)).size).toBe(67)
    const actors: Doc<'profiles'>[] = []
    for (let i = 0; i < 50; i++)
      actors.push(await plantSeat(t, { org_id: f.org.id, name: `Actor ${i}` }))
    for (let from = 0; from < 200; from += 50)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 50; i++) {
          const id = uuid()
          await insertTask(
            ctx.db,
            {
              id,
              org_id: f.org.id,
              project_id: subs[i].id,
              num: 90_000 + i,
              title: `Spread ${i}`,
              description: '',
              status: 'todo',
              priority: 'medium',
              paused: false,
              created_at: NOW,
              updated_at: NOW,
              window_key: newWindowKey(),
            },
            'restore',
          )
          await postMessage(ctx, {
            org_id: f.org.id,
            recipient_id: f.guest.id,
            issue_id: id,
            kind: 'comment',
            body: `Spread ${i}`,
            actor_id: actors[i % 50].id,
            now: at(i * 0.1),
          })
        }
      })
    const r = logged(
      'feed, 200 sub-projects’ new groups, 50 actors',
      await measured(t, f.guest, minute(-10)),
    )
    expect(r.answer.events).toHaveLength(50)
    expect(r.answer.more).toBe(true)
    expect(new Set(r.answer.events.map((e) => e.actor_name)).size).toBe(50)
  })

  it('reads exactly what it reads alone beside 1,000 other people’s new items', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    for (let i = 0; i < 10; i++) await newsAt(t, f, 1 + i)
    const alone = await measured(t, f.guest, minute(0))
    // 1,000 other people, each with 10 new unread items
    for (let from = 0; from < 1000; from += 100)
      await t.run(async (ctx) => {
        for (let p = from; p < from + 100; p++)
          for (let k = 0; k < 10; k++) {
            const issue_id = `task-${k}`
            const id = uuid()
            await ctx.db.insert('messages', {
              id,
              org_id: f.org.id,
              recipient_id: `person-${p}`,
              actor_id: f.admin.id,
              issue_id,
              issue_title: 'Theirs',
              kind: 'comment',
              detail: 'Theirs',
              created_at: at(1 + k),
            })
            await ctx.db.insert('inbox_items', {
              recipient_id: `person-${p}`,
              issue_id,
              project_id: f.sub.id,
              sort_at: at(1 + k),
              latest_id: id,
              latest_at: at(1 + k),
              unread: true,
              unread_count: 1,
              dropped: 0,
              mentions: 0,
              changes: 0,
              comments: 1,
              snoozed: false,
              woke_rows: 0,
            })
          }
      })
    const crowded = logged(
      'feed, 10 new items beside 1,000 people’s',
      await measured(t, f.guest, minute(0)),
    )
    expect(crowded.answer).toEqual(alone.answer)
    expect(crowded.documents).toBe(alone.documents)
    expect(crowded.ranges).toBe(alone.ranges)
  })
})
