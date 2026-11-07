/* The inbox reads that need only inbox_items rows (model/inboxReads.ts,
 * model/inboxPage.ts). The app watches the summary from the start beside
 * the workspace's parts, for its Inbox badge and the availability of Mark
 * all as read and Remove all read, and the item beside the open task's
 * thread, for the task window's New divider and its read on open
 * (messages.ts readItem). The Inbox list reads the page while it shows,
 * one page at a time, and its row actions are the item actions. The
 * workspace inbox part (workspace.ts inbox) stays for the desktop alerts.
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
 *   `unavailable`), the newest message by _creationTime, the oldest unread
 *   message, and for an item with an unread message and a change or a
 *   mention its read messages, one normally (model/inboxReads.ts
 *   unreadChange), and the unread ones up to the first mention in the
 *   description only when no change is unread and a mention is, at most
 *   1,000 of them (internal/inboxItemsBackfill.ts BUILD.pair_rows, the most
 *   messages the backfill builds an item of). An item with more unread
 *   messages, none of the first 1,000 a change, answers `unread_change`
 *   true, since the rest may tell of one. `unread_change` says whether an
 *   unread message tells of a change, a change or a mention in the
 *   description, the app's rule (src/lib/spine.ts UnreadStart). It reruns
 *   when any of those change.
 * - page (across the caller's seats): one page of at most 50 task groups,
 *   newest or oldest first by list time, with Unread only, Show snoozed,
 *   the kind filter and the search applied before the page is cut, and a
 *   sealed `next` that continues after the last group it examined
 *   (model/inboxPage.ts). A loaded page stays live without its end moving
 *   when it passes its own `next` back as the `through` cursor. It then
 *   holds every group up to that position, at most 200, so the loaded
 *   pages hold every group once as groups move. Each row names its task,
 *   its project and the project above it, its newest message with its
 *   actor, its counts, kinds and snooze, its oldest unread time,
 *   `unread_change` as item answers it and the row's `through`, the cutoff
 *   the item actions take. `stopped` says the read budget ended the page
 *   before it was full or reached the `through` cursor, `checked_to` how
 *   far it looked, `not_ready` which seats' items are not complete and
 *   `unchecked` that a check a bound stopped left a group out, so an
 *   unfinished read never answers as an empty Inbox. It reads each seat's
 *   readiness and its items up to where the page ends, the task, project
 *   and access rows of each item its project lets through, and the newest
 *   messages, actors and unread fields of each group it examines, and with
 *   a search every message of a group whose title, key, second line and
 *   places miss a word. It reruns when any of those change.
 *
 * All three show the working set as the workspace parts do (lib/access.ts
 * accessOf). Nothing here writes. The item actions are in messages.ts. */

import { v } from 'convex/values'
import { vMessageKind } from './lib/enums'
import { authedQuery, orgQuery } from './lib/functions'
import { readInboxPage } from './model/inboxPage'
import { readInboxItem, readInboxSummary } from './model/inboxReads'

export const summary = authedQuery({
  args: {},
  handler: async (ctx) => await readInboxSummary(ctx, [...ctx.myProfiles.values()]),
})

export const item = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => await readInboxItem(ctx, ctx.me, issue_id),
})

export const page = authedQuery({
  args: {
    order: v.union(v.literal('newest'), v.literal('oldest')),
    unread_only: v.boolean(),
    include_snoozed: v.boolean(),
    kinds: v.array(vMessageKind),
    search: v.optional(v.string()),
    after: v.optional(v.string()),
    through: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    await readInboxPage(ctx, ctx.authUserId, [...ctx.myProfiles.values()], args),
})
