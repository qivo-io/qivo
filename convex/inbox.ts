/* The inbox reads that need only inbox_items rows (model/inboxReads.ts).
 * The app does not call them yet. It keeps the workspace inbox part
 * (workspace.ts inbox) until a later release switches the badge and the
 * task window to these.
 *
 * - summary (across the caller's seats): each seat's organization, whether
 *   its items are complete (model/inboxItems.ts seatReady) and whether Mark
 *   all as read and Remove all read would change anything there, and the
 *   number of unread, unsnoozed items about tasks the caller is shown,
 *   exact up to 99 and then "more than 99" (`unread_more`), and a lower
 *   bound when `complete` is false, as where a check of the caller's access
 *   that a bound of their own reads stopped ends a seat's count
 *   (lib/access.ts accessUnchecked). Even with `complete` true it can count
 *   too few for a moment, never too many: an item whose task a move took
 *   into a project the caller can see counts once the move's background
 *   re-key reaches its row (model/inboxItems.ts rekeyItems). The two flags
 *   include messages about tasks the caller cannot see, as both actions
 *   reach those too, where the workspace inbox part offers them only for
 *   the rows it shows or leaves unexamined. It reads each seat's profile,
 *   inbox_state, first message and first unsnoozed unread and read
 *   messages, then the unread item rows project by project, each project
 *   with the caller's levels on it, and the task of each item it may
 *   count, at most model/inboxReads.ts SUMMARY.most (100) counted tasks in
 *   a run, where the workspace inbox part reads up to 2,000. So it reruns
 *   when one of those item rows, tasks, projects or access rows changes,
 *   when a seat's inbox_state changes, and when a seat's first unsnoozed
 *   unread or read message changes.
 * - item (per organization): the caller's item about one task, for the
 *   task window, or `building` while the seat is not ready. Its `through`
 *   is the item's newest _creationTime, which readItem and removeItem take
 *   so that they leave out what was stored after it by more than one
 *   mutation's run time. A message from a mutation that started before the
 *   read and committed after it can carry an earlier or equal
 *   _creationTime and is then taken too, until messages carry the planned
 *   commit timestamp (model/messages.ts itemMessages). It reads the
 *   item row, the task, its project and the caller's levels on it (no item
 *   where a bound stopped that check, as the task window then answers
 *   `unavailable`), the newest message by _creationTime, the oldest unread message, and for an
 *   item with an unread message and a change its read messages, one
 *   normally (model/inboxReads.ts unreadChange). It reruns when any of
 *   those change.
 *
 * Both show the working set as the workspace parts do (lib/access.ts
 * accessOf). Nothing here writes. The item actions are in messages.ts. */

import { v } from 'convex/values'
import { authedQuery, orgQuery } from './lib/functions'
import { readInboxItem, readInboxSummary } from './model/inboxReads'

export const summary = authedQuery({
  args: {},
  handler: async (ctx) => await readInboxSummary(ctx, [...ctx.myProfiles.values()]),
})

export const item = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => await readInboxItem(ctx, ctx.me, issue_id),
})
