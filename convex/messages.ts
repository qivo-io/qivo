/* Inbox writes (phase 5): read_at, snoozed_until and delete, the client's
 * WHOLE message write surface. Rows are created only by model/messages'
 * notify family, and everything else is immutable by not appearing in any
 * validator.
 *
 * Own rows only, silently: the RLS filter's successor (model/messages.ts
 * ownMessages) skips non-own and unknown ids without a trace (the client
 * pre-filters anyway), so a probe learns nothing and a stale id is not an
 * error.
 *
 * Each write is a model/messages.ts function the machine inbox
 * (machine/discussion.ts) runs too. markRead then restores 0109's invariant
 * per DISTINCT (recipient, issue) pair among the rows it marked, as the
 * statement trigger fired once per pair. markUnread prunes nothing.
 * markUnread and snooze refuse a message about an archived task.
 * markAllRead visits bounded batches beyond the snapshot cap, keeping the
 * first batch's server-selected cutoff. There is no boot
 * sweep_my_read_messages; the nightly sweep is phase 9's cron. The internal
 * readArchivedTasks and readArchivedProject steps mark an archived task's
 * messages read for every recipient. */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { orgMutation } from './lib/functions'
import {
  markAllMessagesRead,
  markMessagesRead,
  markMessagesUnread,
  ownMessages,
  readArchivedProjectMessages,
  readArchivedTaskMessages,
  removeMessages,
  removeReadMessages,
  snoozeMessages,
  trimUnreadMessages,
  wakeSnoozedItem,
} from './model/messages'

/* P.markMessagesRead. One `now` stamps every row of the act. */
export const markRead = orgMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const now = new Date().toISOString()
    await markMessagesRead(ctx, ctx.me, await ownMessages(ctx, ctx.me, ids), now)
    return null
  },
})

/* P.markAllMessagesRead. The cutoff is the newest stored unread row at the
 * first call, not the browser clock or the notification's narrated date.
 * Reusing it across batches leaves later arrivals unread. Already-read
 * stamps stay intact. */
export const markAllRead = orgMutation({
  args: { before: v.optional(v.number()) },
  handler: async (ctx, { before }) => {
    const now = new Date().toISOString()
    const done = await markAllMessagesRead(ctx, ctx.me, before, now)
    return { marked: done.marked.length, hasMore: done.hasMore, before: done.before }
  },
})

/* P.markMessagesUnread, the same column the other way. A message about an
 * archived task refuses the whole act (model/messages.ts
 * refuseArchivedItems), and the client rolls back. */
export const markUnread = orgMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    await markMessagesUnread(ctx, ctx.me, await ownMessages(ctx, ctx.me, ids))
    return null
  },
})

/* P.deleteMessages. Removing an item removes every message in it, so the
 * caller passes the whole list (P.messageGroups' ids). */
export const remove = orgMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    await removeMessages(ctx, await ownMessages(ctx, ctx.me, ids))
    return null
  },
})

/* Read cleanup is independent of the snapshot's 500-message display limit.
 * Each bounded batch selects the current read rows, so a message reopened
 * by another device survives. The caller repeats while hasMore is true. */
export const removeRead = orgMutation({
  args: {},
  handler: async (ctx) => {
    const done = await removeReadMessages(ctx, ctx.me)
    return { removed: done.removed.length, hasMore: done.hasMore }
  },
})

/* P.snoozeMessages. Hides an item until `until` on every client at once, or
 * lifts the snooze early (null). The ids name the item; the write covers the
 * WHOLE (recipient, issue) pair, loaded or not (model/messages.ts
 * snoozeMessages). The return trip is the scheduled wake below, a server
 * event, so the laptop that snoozed and the phone that did not see the row
 * come back at the same instant, and a closed phone finds it back the
 * moment it opens. An archived task refuses it like markUnread. */
export const snooze = orgMutation({
  args: { ids: v.array(v.string()), until: v.union(v.string(), v.null()) },
  handler: async (ctx, { ids, until }) => {
    await snoozeMessages(ctx, ctx.me, await ownMessages(ctx, ctx.me, ids), until)
    return null
  },
})

/* The scheduled end of a snooze. model/messages.ts schedules it by name
 * ('messages:wake'), as roadmap:expire is, to keep this module's own
 * `internal` type out of its own inference. */
export const wake = internalMutation({
  args: { recipient_id: v.string(), issue_id: v.string(), until: v.string() },
  handler: async (ctx, a) => {
    await wakeSnoozedItem(ctx, a, new Date().toISOString())
    return null
  },
})

/* One background step that trims the inbox items of a fan-out's later
 * recipients about one task toward the item cap, scheduled by name from the
 * fan-outs (model/messages.ts scheduleItemTrims). */
export const trimItems = internalMutation({
  args: { issue_id: v.string(), recipients: v.array(v.string()) },
  handler: async (ctx, a) => {
    for (const recipient_id of a.recipients) {
      await trimUnreadMessages(ctx, { recipient_id, issue_id: a.issue_id })
    }
    return null
  },
})

/* One background step that marks archived tasks' messages read for every
 * recipient, scheduled by name from the archive paths and from itself
 * (model/messages.ts scheduleArchivedReads). `batch` lowers the rows per
 * step in tests. */
export const readArchivedTasks = internalMutation({
  args: { issues: v.array(v.string()), batch: v.optional(v.number()) },
  handler: async (ctx, a) => {
    await readArchivedTaskMessages(ctx, { ...a, now: new Date().toISOString() })
    return null
  },
})

/* The same for the active tasks of an archived project, one page per step
 * from `cursor`, a pagination cursor. `tasks` lowers the page size in tests. */
export const readArchivedProject = internalMutation({
  args: {
    project_id: v.string(),
    cursor: v.optional(v.string()),
    batch: v.optional(v.number()),
    tasks: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    await readArchivedProjectMessages(ctx, { ...a, now: new Date().toISOString() })
    return null
  },
})
