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
 *   bound when `complete` is false. It reads each seat's profile,
 *   inbox_state, first message and first unsnoozed unread and read
 *   messages, then the unread item rows project by project, each project
 *   with the caller's levels on it, and the task of each item it may
 *   count, at most model/inboxReads.ts SUMMARY.most (100) counted tasks in
 *   a run, where the workspace inbox part reads up to 2,000. So it reruns
 *   when one of those item rows, tasks, projects or access rows changes,
 *   when a seat's inbox_state changes, and when a seat's first unsnoozed
 *   unread or read message changes.
 * - item (per organization): the caller's item about one task, for the
 *   task window, or `building` while the seat is not ready. It reads the
 *   item row, the task, its project and the caller's levels on it, and the
 *   item's unread messages oldest first, as far as the first unread change
 *   (only the first when the item holds no change). It reruns when any of
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
