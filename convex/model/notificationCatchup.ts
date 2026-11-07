/* The catch-up read behind notifications.ts claimSummary, which says
 * whether eligible unread activity arrived after a checkpoint, decided
 * from the stored inbox items (schema.ts inbox_items) under the rule
 * inbox.summary counts by (model/inboxReads.ts inboxScope), never from a
 * client's word or a difference of counts. It answers a state, and the
 * keys of the unread events of each item it counted in the last
 * NOTIFY.lag_ms for claimSummary to record, never a task or a count, and
 * writes nothing. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { isAccessUnchecked } from '../lib/access'
import { seatReady } from './inboxItems'
import { inboxScope, stepBudget } from './inboxReads'
import { ITEM_UNREAD_CAP } from './messages'

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
 * ranges. Tests lower these. */
export const CATCH_UP = { items: 2_000, batch: 16, room: 0.5 }

/** One item's newest unread event, with its key as the feed names it (a
 * message id, or `${issue_id}:${woke_at}` for a snooze return) and its
 * time. */
type Event = { key: string; at: string }

/* The newest unread event of item `item`, or null. That is its wake when
 * the wake is newer than every message, else the newer of its newest unread message
 * (one index read) and its wake. An item stays unread while any message
 * is, and its sort_at follows its newest message, read or not, so the item
 * alone cannot say that the unread activity is new. */
async function newestUnread(ctx: QueryCtx, item: Doc<'inbox_items'>): Promise<Event | null> {
  const wake =
    item.woke_at === undefined
      ? null
      : { key: `${item.issue_id}:${item.woke_at}`, at: item.woke_at }
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

/* The keys of item `item`'s unread events after `from`, or null when the
 * budget `step` ran out first. These are all its unread messages after it,
 * newest first, read in one index range whose every page of
 * ITEM_UNREAD_CAP messages is a step, and its wake when that is after
 * `from`. The read is whole, since an item holds more unread messages than
 * the cap while a fan-out's background trim waits (model/messages.ts
 * ItemTrims), and the cap serves only as the page size. */
async function unreadKeysAfter(
  ctx: QueryCtx,
  item: Doc<'inbox_items'>,
  from: string,
  step: () => Promise<boolean>,
): Promise<string[] | null> {
  if (!(await step())) return null
  const messages = ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q
        .eq('recipient_id', item.recipient_id)
        .eq('issue_id', item.issue_id)
        .eq('read_at', undefined)
        .gt('created_at', from),
    )
    .order('desc')
  const keys: string[] = []
  for await (const m of messages) {
    if (keys.length > 0 && keys.length % ITEM_UNREAD_CAP === 0 && !(await step())) return null
    keys.push(m.id)
  }
  if (item.woke_at !== undefined && item.woke_at > from)
    keys.push(`${item.issue_id}:${item.woke_at}`)
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
