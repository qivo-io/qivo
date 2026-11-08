/* The two reads of a person's new unread Inbox activity, both from the
 * stored inbox items (schema.ts inbox_items) under the rule inbox.summary
 * counts by (model/inboxReads.ts inboxScope), and neither writing.
 *
 * - missedActivity, the catch-up behind notifications.ts claimSummary,
 *   says whether eligible unread activity arrived after a checkpoint,
 *   never from a client's word or a difference of counts. It answers a
 *   state, and the keys of the unread events of each item it counted in
 *   the last NOTIFY.lag_ms for claimSummary to record, never a task or a
 *   count.
 * - readInboxFeed, behind inbox.feed, answers the newest unread events
 *   after a floor the client sends, at most FEED.events, with the text an
 *   alert shows, for the app's desktop alerts (src/lib/notificationFeed.ts),
 *   which the claims then grant to one session. It reads no notification
 *   row.
 *
 * Both read an item's unread messages after a time in one index range
 * (unreadMessagesAfter) and name a snooze return by wakeKey, so the feed
 * offers exactly the keys the catch-up records. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { isAccessUnchecked } from '../lib/access'
import { byId } from '../lib/db'
import { messageDetail } from '../lib/inbox'
import { seatReady } from './inboxItems'
import { inboxScope, stepBudget } from './inboxReads'
import { ITEM_UNREAD_CAP } from './messages'
import { NOTIFY } from './notificationSessions'

/** The bounds of one catch-up. It examines at most `items` unread items
 * across the seats, and asks how much the transaction has read before each
 * `batch` of steps (an item, a task check, a message read, a page of an
 * item's unread messages or a record read), starting none once more than
 * `room` of any of Convex's limits is used, as the unread summary does
 * (model/inboxReads.ts SUMMARY). Past either it answers `stopped`, also
 * after it found activity, never a summary it could not confirm or whose
 * records it could not complete.
 *
 * The slowest case at the design size is the project figure behind a
 * hint: 1,000 unread items after the checkpoint (800 open and 200 Done
 * tasks of one project, one range) about a project the seat no longer
 * sees, each one index entry passed without reading its task. 2,000 holds
 * it with room. Measured in tests/notifications.test.ts "inside Convex's
 * limits", that case reads 1,012 documents in 17 ranges, 448 KiB, and
 * answers whole (`none`); the everyday Inbox, 60 groups over 3
 * sub-projects with 10 new, and 300 groups of one sub-project, all new,
 * each answer `summary` after 15 documents in 16 ranges, and the same 300
 * groups all before the checkpoint answer `none` after 8 documents in 9
 * ranges. convex-test's counts leave out the nested Better Auth session
 * lookup of claimSummary's wrapper, so a real backend reads two documents
 * more a call (NOTIFY's docstring says the same). Tests lower these. */
export const CATCH_UP = { items: 2_000, batch: 16, room: 0.5 }

/** One item's newest unread event, with its key as the feed names it (a
 * message id, or `${issue_id}:${woke_at}` for a snooze return) and its
 * time. */
type Event = { key: string; at: string }

/* The key of the snooze return at `wokeAt` of item `item`, as the feed and
 * the claims name it (notifications.ts header): its task's id and woke_at
 * exactly as stored. */
const wakeKey = (item: Doc<'inbox_items'>, wokeAt: string): string => `${item.issue_id}:${wokeAt}`

/* The newest unread event of item `item`, or null. That is its wake when
 * the wake is newer than every message, else the newer of its newest unread message
 * (one index read) and its wake. An item stays unread while any message
 * is, and its sort_at follows its newest message, read or not, so the item
 * alone cannot say that the unread activity is new. */
async function newestUnread(ctx: QueryCtx, item: Doc<'inbox_items'>): Promise<Event | null> {
  const wake =
    item.woke_at === undefined ? null : { key: wakeKey(item, item.woke_at), at: item.woke_at }
  if (wake !== null && wake.at > item.latest_at) return wake
  const newest = await ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q
        .eq('recipient_id', item.recipient_id)
        .eq('issue_id', item.issue_id)
        .eq('read_at', undefined),
    )
    .order('desc')
    .first()
  if (newest === null) return wake
  if (wake !== null && wake.at > newest.created_at) return wake
  return { key: newest.id, at: newest.created_at }
}

/* Item `item`'s unread messages after `from`, newest first, or null when
 * the budget `step` ran out first. They are read in one index range whose
 * every page of ITEM_UNREAD_CAP messages is a step. The read is whole,
 * since an item holds more unread messages than the cap while a fan-out's
 * background trim waits (model/messages.ts ItemTrims), and the cap serves
 * only as the page size. */
async function unreadMessagesAfter(
  ctx: QueryCtx,
  item: Doc<'inbox_items'>,
  from: string,
  step: () => Promise<boolean>,
): Promise<Doc<'messages'>[] | null> {
  if (!(await step())) return null
  const rows = ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q
        .eq('recipient_id', item.recipient_id)
        .eq('issue_id', item.issue_id)
        .eq('read_at', undefined)
        .gt('created_at', from),
    )
    .order('desc')
  const messages: Doc<'messages'>[] = []
  for await (const m of rows) {
    if (messages.length > 0 && messages.length % ITEM_UNREAD_CAP === 0 && !(await step()))
      return null
    messages.push(m)
  }
  return messages
}

/* The keys of item `item`'s unread events after `from`, or null when the
 * budget `step` ran out first: all its unread messages after it, newest
 * first (unreadMessagesAfter), and its wake when that is after `from`. */
async function unreadKeysAfter(
  ctx: QueryCtx,
  item: Doc<'inbox_items'>,
  from: string,
  step: () => Promise<boolean>,
): Promise<string[] | null> {
  const messages = await unreadMessagesAfter(ctx, item, from, step)
  if (messages === null) return null
  const keys = messages.map((m) => m.id)
  if (item.woke_at !== undefined && item.woke_at > from) keys.push(wakeKey(item, item.woke_at))
  return keys
}

/* Whether item `item` holds an unread event after `from`, other than
 * `newest`, that `recorded` does not hold, or null when the budget `step`
 * ran out first. The keys' read (unreadKeysAfter) and each key's record
 * check are steps, and the first key without a record ends it. */
async function missedBelow(
  ctx: QueryCtx,
  item: Doc<'inbox_items'>,
  from: string,
  newest: string,
  recorded: (key: string) => Promise<boolean>,
  step: () => Promise<boolean>,
): Promise<boolean | null> {
  const keys = await unreadKeysAfter(ctx, item, from, step)
  if (keys === null) return null
  for (const key of keys) {
    if (key === newest) continue
    if (!(await step())) return null
    if (!(await recorded(key))) return true
  }
  return false
}

/** A catch-up's answer and the keys of the unread events after `recent` of
 * the items it counted, for the summary records (notifications.ts
 * claimSummary). */
export type Missed = { state: 'found' | 'none' | 'stopped'; keys: string[] }

/**
 * Whether the seats `seats`, the caller's, hold eligible unread activity
 * after `after`: an unread, unsnoozed item whose newest unread event (its
 * newest unread message, or its wake) is later than `after`, about a task
 * the seat is shown, with an unread event after `after` that `recorded`
 * does not hold. That is its newest event, or when a session alerted that
 * one, an earlier one, such as a notice a background step stored late with
 * its write's earlier time. `recorded` answers whether a session already
 * alerted or summarized the event (model/notificationSessions.ts
 * recorded), so the read can reach back before the checkpoint for items
 * stored late without counting what was announced. Times are epoch
 * milliseconds, compared with the items' ISO times.
 *
 * Seats go in organization id order. A seat that is not ready
 * (model/inboxItems.ts seatReady) is noted and skipped. Each ready seat's
 * items are read newest first from inbox_items.by_recipient_unread_list.
 * An item whose project the seat's scope says cannot hold its tasks is
 * passed without reading its task (inboxScope holdsItems); any other has
 * its task read and checked by its own project (shownTask), so a move's
 * re-key that has not yet run can only leave an item out for a moment.
 * Items without a project have their task read, as the unread summary
 * does.
 *
 * The first eligible item decides `found`. The read then goes on only
 * through items newer than `recent`, in every seat, so `keys` holds every
 * unread event of that last stretch of each eligible item, all its unread
 * messages and its wake there, not only the newest. Marking only the
 * newest read then leaves no older one unrecorded, which a later catch-up
 * reading back over the stretch would count again or a live claim would
 * grant. A key may already hold a record, which a second record does not
 * change.
 *
 * It answers `none` when every seat was read to its end and nothing was
 * eligible, and `stopped` when a seat that is not ready or a check of the
 * seat's access that a bound stopped (lib/access.ts accessUnchecked) ended
 * it before it found one, or when the budget (CATCH_UP) ended it at any
 * point, so `found` comes with the keys of the whole last stretch of every
 * seat it read to its end. A seat not ready, or a stopped access check
 * after a find, leaves that seat's keys out, or the rest of them.
 *
 * It reads each seat's readiness (two ranges at most) and its items after
 * `after`, a project check for each project, the task of each item its
 * project lets through, for each shown item its newest unread message and
 * its records, one or two ranges, when that newest event holds a record
 * the item's unread messages after `after` and their records until one
 * has none, and for each eligible item in the last stretch its unread
 * messages there, one range read whole. Measured reads at the design size
 * are in CATCH_UP's docstring.
 */
export async function missedActivity(
  ctx: QueryCtx,
  seats: readonly Doc<'profiles'>[],
  after: number,
  recent: number,
  recorded: (key: string) => Promise<boolean>,
): Promise<Missed> {
  const ordered = [...seats].sort((a, b) => (a.org_id < b.org_id ? -1 : 1))
  const step = stepBudget(ctx, CATCH_UP)
  const afterAt = new Date(after).toISOString()
  const recentAt = new Date(recent).toISOString()
  const keys: string[] = []
  let items = 0
  let found = false
  // a seat not ready or a stopped check of its access, after which an item
  // found elsewhere still answers found
  let stopped = false
  // the budget ran out, which may leave the last stretch's keys incomplete,
  // so it answers stopped even after a find
  let spent = false
  walk: for (const me of ordered) {
    if (!(await step())) {
      spent = true
      break
    }
    if (!(await seatReady(ctx, me.id))) {
      stopped = true
      continue
    }
    const scope = inboxScope(ctx, me)
    // once an item is found, only the last stretch's events need reading
    const from = found && recentAt > afterAt ? recentAt : afterAt
    const unread = ctx.db
      .query('inbox_items')
      .withIndex('by_recipient_unread_list', (q) =>
        q.eq('recipient_id', me.id).eq('snoozed', false).eq('unread', true).gt('sort_at', from),
      )
      .order('desc')
    try {
      for await (const item of unread) {
        if (found && item.sort_at <= recentAt) break
        if (items === CATCH_UP.items || !(await step())) {
          spent = true
          break walk
        }
        items += 1
        if (item.project_id !== undefined && !(await scope.holdsItems(item.project_id))) continue
        if (!(await step())) {
          spent = true
          break walk
        }
        if ((await scope.shownTask(item.issue_id)) === null) continue
        if (!(await step())) {
          spent = true
          break walk
        }
        const event = await newestUnread(ctx, item)
        if (event === null || event.at <= afterAt) continue
        if (!(await step())) {
          spent = true
          break walk
        }
        const alerted = await recorded(event.key)
        if (alerted) {
          // a notice stored late with an earlier time can sit under a newer
          // event a session alerted, and nobody alerted it
          const missed = await missedBelow(ctx, item, afterAt, event.key, recorded, step)
          if (missed === null) {
            spent = true
            break walk
          }
          if (!missed) continue
        }
        found = true
        if (event.at <= recentAt) continue
        if (!alerted) keys.push(event.key)
        const stretch = await unreadKeysAfter(ctx, item, recentAt, step)
        if (stretch === null) {
          spent = true
          break walk
        }
        for (const key of stretch) if (key !== event.key) keys.push(key)
      }
    } catch (e) {
      if (!isAccessUnchecked(e)) throw e
      stopped = true
    }
  }
  return { state: spent ? 'stopped' : found ? 'found' : stopped ? 'stopped' : 'none', keys }
}

/* ------------------------------------------------------------ the feed */

/** The bounds of one inbox.feed answer (readInboxFeed). It answers at most
 * `events` events, NOTIFY.claim_keys, so one claim takes one answer. It
 * examines at most `items` unread items across the seats, and asks how
 * much the transaction has read before each `batch` of steps (a seat, an
 * item, a task check, a page of an item's unread messages, the newest
 * unread message a wake's detail needs, or an actor's profile), starting
 * none once more than `room` of any of Convex's limits is used, as
 * CATCH_UP does. Past either it answers `more`, never a shorter list as
 * whole.
 *
 * The slowest case at the design size is CATCH_UP's, the project figure
 * behind a hint: 1,000 unread items after the floor (800 open and 200 Done
 * tasks of one project, one range) about a project the seat no longer
 * sees, each one index entry passed without reading its task. 2,000 holds
 * it with room. Measured in tests/inboxFeed.test.ts "inside Convex's
 * limits", that case reads 1,006 documents in 12 ranges, 447 KiB, and
 * answers whole with no event. The everyday Inbox, 60 groups over 3
 * sub-projects with 10 new, answers its 10 events whole after 38 documents
 * in 33 ranges, 14 KiB; one sub-project's 300 groups, all new, answer 50
 * events and `more` after 157 documents in 109 ranges, 61 KiB, and the same
 * 300 before the floor answer none after 2 documents in 4 ranges; one
 * task's 50 unread messages and its wake answer 50 events and `more` after
 * 58 documents in 11 ranges; 200 sub-projects the person reads with a new
 * group each from 50 actors answer 50 events and `more` after 257
 * documents in 237 ranges, 92 KiB; and 10 new items beside 1,000 other
 * people's 10,000 read exactly what they read alone, 36 documents in 29
 * ranges. Tests lower these. */
export const FEED = { events: 50, items: 2_000, batch: 16, room: 0.5 }

/** One event of the feed: a new unread message, or a snooze return. */
export type FeedEvent = {
  /** the message's id, or `${issue_id}:${woke_at}` with woke_at as stored */
  key: string
  /** the message's created_at, or the wake's woke_at, in epoch ms */
  at: number
  kind: Doc<'messages'>['kind'] | 'wake'
  /** the task's live title */
  title: string
  /** a message's actor in the seat's organization, else null; null for a
   * wake */
  actor_name: string | null
  /** the message's detail as the Inbox shows it (lib/inbox.ts
   * messageDetail); for a wake, its item's newest unread message's */
  detail: string
}

/** What inbox.feed answers. */
export type Feed = {
  /** newest first, then by key, at most FEED.events */
  events: FeedEvent[]
  /** the newest event's `at`, never below the floor; the floor itself when
   * the answer holds none */
  through: number
  /** whether an event newer than the floor may be missing from `events`:
   * the cap dropped it, or the cap, the budget or a check a bound stopped
   * ended the read before an item that may hold one */
  more: boolean
}

/* The feed's read stopped, by FEED.items or the budget. */
class FeedStop extends Error {}

/** The feed's order: newest first, then by key, last first. */
export const newerEvent = (a: Pick<FeedEvent, 'at' | 'key'>, b: Pick<FeedEvent, 'at' | 'key'>) =>
  b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)

/* Item `item`'s newest unread message, one index read. */
const newestUnreadMessage = (ctx: QueryCtx, item: Doc<'inbox_items'>) =>
  ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q
        .eq('recipient_id', item.recipient_id)
        .eq('issue_id', item.issue_id)
        .eq('read_at', undefined),
    )
    .order('desc')
    .first()

/**
 * The newest unread Inbox events of the seats `seats`, the caller's, after
 * the floor `after` (epoch ms), for the app's desktop alerts
 * (src/lib/notificationFeed.ts): each unread message of an unread,
 * unsnoozed item about a task the seat is shown, and each such item's
 * snooze return, with the text an alert shows. A query cannot read the
 * time, so the client sends the floor, a server time it already has (its
 * first beat's `now` less lib/limits.ts ALERT_WINDOW_MS at a start, then
 * each answer's `through`), and the read reaches NOTIFY.lag_ms further
 * back, so a notice a background step stored late with an earlier time is
 * still answered, as the claims' floors allow (notifications.ts
 * claimAlerts). An older floor only reads further back into the caller's
 * own Inbox, to the cap and the budget.
 *
 * Seats go in organization id order. A seat that is not ready
 * (model/inboxItems.ts seatReady) is skipped and does not set `more`: its
 * activity waits in the Inbox and the badge, which say it is being
 * prepared, and a `more` there would turn every answer into a summary that
 * answers `unchecked`. Each ready seat's items are read newest first from
 * inbox_items.by_recipient_unread_list after the floor less the minute. An
 * item whose project the seat's scope says cannot hold its tasks is passed
 * without reading its task (inboxScope holdsItems); any other has its task
 * read and checked by its own project (shownTask). An item without a
 * project has its task read too. A shown item answers one event for each
 * unread message after the floor less the minute (every one, not only the
 * newest, as a catch-up counts each) and one for its wake when woke_at is
 * after that time, whose detail is the item's newest unread message's. An
 * actor is named from the profile by id in the seat's organization, else
 * null, as the Inbox page names one (model/inboxPage.ts nameOf), each actor
 * read once a seat.
 *
 * It holds the FEED.events newest events so far, and once it holds that
 * many it passes, with the rest of its seat, an item whose sort_at is
 * before the oldest of them, since an item's events are never later than
 * its sort_at and the items after it sort earlier; so it answers the
 * newest events exactly. It stops once it has examined FEED.items items or
 * the budget says no room, and a check a bound stopped (lib/access.ts
 * accessUnchecked) ends that seat and keeps nothing of its item. `more` is
 * set only where an event newer than `after` itself may be missing, never
 * for the minute read back alone: an item passed so, or one a stop came
 * before, whose sort_at is after the floor, a stopped check of such an
 * item, a budget that ended the read before a seat, and an event after the
 * floor that the cap dropped. So a burst inside the minute before a floor
 * the client moved past it does not answer `more` again.
 *
 * The floor is the safeguard for restored tasks and tasks newly in view: a
 * stored unread message about such a task is answered only when it is
 * newer than the floor less the minute, and the client keeps its floor no
 * further back than ALERT_WINDOW_MS before its latest beat. So such a
 * message under ten minutes old that no session alerted is offered and
 * raises one alert, an older one raises none, and the claims' records
 * refuse what a session alerted. A notice stored more than the minute late,
 * behind a newer event the floor moved past, is never answered, though a
 * claim would grant it within ten minutes (NOTIFY.lag_ms).
 *
 * It writes nothing and reads no notification row. It reads each seat's
 * readiness (two ranges at most), its items after the floor less the
 * minute, a project check a project, the task of each item its project
 * lets through, for each shown item its unread messages after that time
 * (one range) and, for a wake with none there, its newest unread message
 * (one range), and the profiles of the actors. So it reruns when one of
 * those changes, and when an item's sort_at crosses the floor less the
 * minute.
 */
export async function readInboxFeed(
  ctx: QueryCtx,
  seats: readonly Doc<'profiles'>[],
  after: number,
): Promise<Feed> {
  const ordered = [...seats].sort((a, b) => (a.org_id < b.org_id ? -1 : 1))
  const step = stepBudget(ctx, FEED)
  const from = new Date(after - NOTIFY.lag_ms).toISOString()
  const floor = new Date(after).toISOString()
  // the newest events so far, newest first, at most FEED.events
  let held: FeedEvent[] = []
  let items = 0
  let more = false
  /* whether `item` may hold an event newer than the floor itself */
  const late = (item: Doc<'inbox_items'> | null) => item === null || item.sort_at > floor
  /* Whether `item` can hold no event the answer keeps: FEED.events are
     held, and its sort_at, which no event of it is later than, is before
     the oldest of them. The items after it in its seat sort earlier. */
  const past = (item: Doc<'inbox_items'>) =>
    held.length === FEED.events && item.sort_at < new Date(held[FEED.events - 1].at).toISOString()
  /* Takes `events` into the newest held, saying more when the cap drops
     one newer than the floor. */
  const take = (events: FeedEvent[]) => {
    const all = [...held, ...events].sort(newerEvent)
    if (all.slice(FEED.events).some((e) => e.at > after)) more = true
    held = all.slice(0, FEED.events)
  }
  walk: for (const [place, me] of ordered.entries()) {
    if (!(await step())) {
      // the seats left may hold anything
      more = true
      break
    }
    if (!(await seatReady(ctx, me.id))) continue
    const scope = inboxScope(ctx, me)
    const names = new Map<string, Promise<string | null>>()
    /* the name of actor `id` in the seat's organization, a step a new one */
    const nameOf = async (id: string | undefined): Promise<string | null> => {
      if (id === undefined) return null
      let known = names.get(id)
      if (known === undefined) {
        if (!(await step())) throw new FeedStop()
        known = byId(ctx, 'profiles', id).then((p) =>
          p !== null && p.org_id === me.org_id ? p.name : null,
        )
        names.set(id, known)
      }
      return await known
    }
    const unread = ctx.db
      .query('inbox_items')
      .withIndex('by_recipient_unread_list', (q) =>
        q.eq('recipient_id', me.id).eq('snoozed', false).eq('unread', true).gt('sort_at', from),
      )
      .order('desc')
    // the item being read, which a stop names
    let current: Doc<'inbox_items'> | null = null
    try {
      for await (const item of unread) {
        current = item
        if (past(item)) {
          // the cap: this item, and the items after it in this seat, hold
          // only events the cap drops, so it says whether one after the
          // floor may wait there, and the next seat goes on
          if (late(item)) more = true
          continue walk
        }
        if (items === FEED.items || !(await step())) throw new FeedStop()
        items += 1
        if (item.project_id !== undefined && !(await scope.holdsItems(item.project_id))) continue
        if (!(await step())) throw new FeedStop()
        const task = await scope.shownTask(item.issue_id)
        if (task === null) continue
        const messages = await unreadMessagesAfter(ctx, item, from, step)
        if (messages === null) throw new FeedStop()
        const events: FeedEvent[] = []
        for (const m of messages)
          events.push({
            key: m.id,
            at: Date.parse(m.created_at),
            kind: m.kind,
            title: task.title,
            actor_name: await nameOf(m.actor_id),
            detail: messageDetail(m.detail),
          })
        if (item.woke_at !== undefined && item.woke_at > from) {
          let newest: Doc<'messages'> | null = messages[0] ?? null
          if (newest === null) {
            if (!(await step())) throw new FeedStop()
            newest = await newestUnreadMessage(ctx, item)
          }
          events.push({
            key: wakeKey(item, item.woke_at),
            at: Date.parse(item.woke_at),
            kind: 'wake',
            title: task.title,
            actor_name: null,
            detail: newest === null ? '' : messageDetail(newest.detail),
          })
        }
        take(events)
        current = null
      }
    } catch (e) {
      if (e instanceof FeedStop) {
        // the item it stopped at, and every seat after this one
        if (late(current) || place < ordered.length - 1) more = true
        break
      }
      if (!isAccessUnchecked(e)) throw e
      // keep nothing of the unchecked item, and go on with the next seat
      if (late(current)) more = true
    }
  }
  return { events: held, through: Math.max(after, held[0]?.at ?? after), more }
}
