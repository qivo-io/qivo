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
 * `batch` of steps (an item, a task check, a message read or a record
 * read), starting none once more than `room` of any of Convex's limits is
 * used, as the unread summary does (model/inboxReads.ts SUMMARY). Past
 * either it answers `stopped`, never a summary it could not confirm.
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

/* The keys of item `item`'s unread events after `from`: its unread
 * messages after it, newest first, at most ITEM_UNREAD_CAP of them, the
 * most an item keeps unread (model/messages.ts), in one index read, and its
 * wake when that is after `from`. */
async function unreadKeysAfter(
  ctx: QueryCtx,
  item: Doc<'inbox_items'>,
  from: string,
): Promise<string[]> {
  const messages = await ctx.db
    .query('messages')
    .withIndex('by_recipient_issue_read_order', (q) =>
      q
        .eq('recipient_id', item.recipient_id)
        .eq('issue_id', item.issue_id)
        .eq('read_at', undefined)
        .gt('created_at', from),
    )
    .order('desc')
    .take(ITEM_UNREAD_CAP)
  const keys = messages.map((m) => m.id)
  if (item.woke_at !== undefined && item.woke_at > from)
    keys.push(`${item.issue_id}:${item.woke_at}`)
  return keys
}

/** A catch-up's answer and the keys of the unread events after `recent` of
 * the items it counted, for the summary records (notifications.ts
 * claimSummary). */
export type Missed = { state: 'found' | 'none' | 'stopped'; keys: string[] }

/**
 * Whether the seats `seats`, the caller's, hold eligible unread activity
 * after `after`: an unread, unsnoozed item whose newest unread event (its
 * newest unread message, or its wake) is later than `after`, about a task
 * the seat is shown, and whose event `recorded` does not hold. `recorded`
 * answers whether a session already alerted or summarized the event
 * (model/notificationSessions.ts recorded), so the read can reach back
 * before the checkpoint for items stored late without counting what was
 * announced. Times are epoch milliseconds, compared with the items' ISO
 * times.
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
 * unread event of that last stretch of each eligible item: its unread
 * messages and its wake there, not only the newest. Marking only the
 * newest read then leaves no older one unrecorded, which a later catch-up
 * reading back over the stretch would count again. A key may already hold
 * a record, which a second record does not change.
 *
 * It answers `none` when every seat was read to its end and nothing was
 * eligible, and `stopped` when the budget (CATCH_UP), a seat that is not
 * ready or a check of the seat's access that a bound stopped
 * (lib/access.ts accessUnchecked) ended it before it found one.
 *
 * It reads each seat's readiness (two ranges at most) and its items after
 * `after`, a project check for each project, the task of each item its
 * project lets through, for each shown item its newest unread message and
 * its records, one or two ranges, and for each eligible item in the last
 * stretch its unread messages there, one range. Measured reads at the
 * design size are in CATCH_UP's docstring.
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
  let stopped = false
  walk: for (const me of ordered) {
    if (!(await step())) {
      stopped = true
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
          stopped = true
          break walk
        }
        items += 1
        if (item.project_id !== undefined && !(await scope.holdsItems(item.project_id))) continue
        if (!(await step())) {
          stopped = true
          break walk
        }
        if ((await scope.shownTask(item.issue_id)) === null) continue
        if (!(await step())) {
          stopped = true
          break walk
        }
        const event = await newestUnread(ctx, item)
        if (event === null || event.at <= afterAt) continue
        if (!(await step())) {
          stopped = true
          break walk
        }
        if (await recorded(event.key)) continue
        found = true
        if (event.at <= recentAt) continue
        keys.push(event.key)
        if (!(await step())) {
          stopped = true
          break walk
        }
        for (const key of await unreadKeysAfter(ctx, item, recentAt))
          if (key !== event.key) keys.push(key)
      }
    } catch (e) {
      if (!isAccessUnchecked(e)) throw e
      stopped = true
    }
  }
  return { state: found ? 'found' : stopped ? 'stopped' : 'none', keys }
}
