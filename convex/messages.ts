/* Inbox writes (phase 5): read_at, snoozed_until and delete, the client's
 * WHOLE message write surface, and bulkReach, the one read here, which
 * says before a bulk action starts how much it has to do. Rows are created
 * only by model/messages' notify family, and everything else is immutable
 * by not appearing in any validator. The app's current Inbox names the
 * rows by message id (markRead, markUnread, remove, snooze), the bulk
 * actions take none (markAllRead, removeRead), and the item actions name
 * one item by its task (readItem, unreadItem, removeItem, snoozeItem), so a
 * row the app did not load is reached too. Open old clients keep calling
 * the id actions.
 *
 * Own rows only, silently: the RLS filter's successor (model/messages.ts
 * ownMessages) skips non-own and unknown ids without a trace (the client
 * pre-filters anyway), so a probe learns nothing and a stale id is not an
 * error. An item action reads only the caller's own item
 * (model/messages.ts itemMessages), and a task without one, or an unknown
 * task id, changes nothing and raises nothing, except that snoozeItem
 * still refuses an `until` that snooze refuses.
 *
 * Each write is a model/messages.ts function the machine inbox
 * (machine/discussion.ts) runs too. markRead then restores 0109's invariant
 * per DISTINCT (recipient, issue) pair among the rows it marked, as the
 * statement trigger fired once per pair. markUnread prunes nothing.
 * markUnread and snooze refuse a message about an archived task.
 * markAllRead visits bounded batches beyond the snapshot cap, keeping the
 * first batch's server-selected cutoff, which the app asks bulkReach for
 * when the person presses the action. There is no boot
 * sweep_my_read_messages; the nightly sweep is phase 9's cron. The internal
 * readArchivedTasks and readArchivedProject steps mark an archived task's
 * messages read for every recipient. */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { authedQuery, orgMutation } from './lib/functions'
import { rekeyStep } from './model/inboxItems'
import {
  itemMessages,
  markAllMessagesRead,
  markMessagesRead,
  markMessagesUnread,
  notifyFollowersStep,
  notifyMentionsStep,
  ownMessages,
  readArchivedProjectMessages,
  readArchivedTaskMessages,
  readBulkReach,
  removeMessages,
  removeReadMessages,
  snoozeMessages,
  trimUnreadMessages,
  vFollowerStep,
  vMentionStep,
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
 * stamps stay intact. `ids` names the rows this batch marked, so the client
 * can paint exactly them again after a rollback. */
export const markAllRead = orgMutation({
  args: { before: v.optional(v.number()) },
  handler: async (ctx, { before }) => {
    const now = new Date().toISOString()
    const done = await markAllMessagesRead(ctx, ctx.me, before, now)
    return {
      marked: done.marked.length,
      ids: done.marked.map((row) => row.id),
      hasMore: done.hasMore,
      before: done.before,
    }
  },
})

/* How much Mark all as read (`read`) or Remove all read (`remove`) has to
 * do in each of the caller's seats: `none`, `one` batch or `many`, and for
 * Mark all as read the cutoff (`before`) a first markAllRead call would
 * choose now (model/messages.ts readBulkReach). The app asks it once when
 * the person presses the action, never as a subscription, which would run
 * again on every message write. It warns before an action of more than one
 * round, skips the seats with nothing to do, and passes each seat's
 * `before` to its first markAllRead call, so a seat that waits for a free
 * slot stops at what had arrived at the press. It reads at most
 * INBOX_BATCH + 2 messages a seat and answers `many` for the seats past
 * its budget. */
export const bulkReach = authedQuery({
  args: { action: v.union(v.literal('read'), v.literal('remove')) },
  handler: async (ctx, { action }) => ({
    seats: await readBulkReach(ctx, [...ctx.myProfiles.values()], action),
  }),
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
 * by another device survives. The caller repeats while hasMore is true.
 * `ids` names the rows this batch deleted, as markAllRead's does. */
export const removeRead = orgMutation({
  args: {},
  handler: async (ctx) => {
    const done = await removeReadMessages(ctx, ctx.me)
    return {
      removed: done.removed.length,
      ids: done.removed.map((row) => row.id),
      hasMore: done.hasMore,
    }
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

/* Where readItem and removeItem stop: the item's newest _creationTime as
 * the caller saw it (inbox.item `through`). The cutoff is not exact;
 * model/messages.ts itemMessages says what it leaves out and what it can
 * still take. */
const vThrough = v.number()

/* Marks the caller's item about one task read. It marks the unread
 * messages whose _creationTime is at most `through`, or all of them without
 * it, so a message stored after the caller's view by more than one
 * mutation's run time stays unread, a backdated follower or mention notice
 * included. A message from a mutation that started before the view and
 * committed after it can carry an earlier or equal _creationTime and is
 * then marked read with the rest, until messages carry the planned commit
 * timestamp (model/messages.ts itemMessages). The prune then keeps the
 * item's newest message
 * (model/messages.ts markMessagesRead), which is that later message when
 * there is one. That message keeps the dropped count the item cap moved
 * onto it (schema.ts messages.dropped), as markRead leaves it: a trim after
 * the caller's view can also have dropped messages stored after it, which
 * the count cannot tell apart, so the count stays until that message is
 * read.
 *
 * An item kept at the cap holds at most ITEM_UNREAD_CAP + 1 (51) messages.
 * One stored before the cap holds more. The backfill builds an item of up
 * to BUILD.pair_rows (1,000) messages as it is and trims only larger ones,
 * an arrival trims at most ITEM_TRIM_STEP (50), and on a seat not built yet
 * the item can be larger still, as it is for markRead's prune and for
 * snooze, which read the whole item too. A 1,000-message item costs about
 * 2,000 of Convex's 16,000 writes (1,000 patches and 999 deletes by the
 * prune), and each message is read up to four times (the item, the patch,
 * the prune's read and its delete): about 1.3 MB written and 5.3 MB read
 * at about 1.3 KB a message (convex/tests/inboxReads.test.ts), so an item
 * of about 3,000 such messages would pass Convex's 16 MiB read. */
export const readItem = orgMutation({
  args: { issue_id: v.string(), through: v.optional(vThrough) },
  handler: async (ctx, { issue_id, through }) => {
    const now = new Date().toISOString()
    await markMessagesRead(ctx, ctx.me, await itemMessages(ctx, ctx.me, issue_id, through), now)
    return null
  },
})

/* Marks the caller's item about one task unread, as markUnread does with
 * all its ids, which opens again the one read message the prune keeps. A
 * task that is archived or in an archived project refuses it with
 * markUnread's sentences (model/messages.ts refuseArchivedItems), and one
 * the caller can no longer see changes nothing. */
export const unreadItem = orgMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    await markMessagesUnread(ctx, ctx.me, await itemMessages(ctx, ctx.me, issue_id))
    return null
  },
})

/* Removes the caller's item about one task, the messages whose
 * _creationTime is at most `through` or all of them without it, so a
 * message stored after the caller's view by more than one mutation's run
 * time stays as the item's only one, a backdated notice included. A message
 * from a mutation that started before the view and committed after it can
 * carry an earlier or equal _creationTime and is then removed with the
 * rest, until messages carry the planned commit timestamp
 * (model/messages.ts itemMessages). That message keeps the
 * dropped count the item cap moved onto it, as for readItem. Its size
 * bounds are readItem's. */
export const removeItem = orgMutation({
  args: { issue_id: v.string(), through: v.optional(vThrough) },
  handler: async (ctx, { issue_id, through }) => {
    await removeMessages(ctx, await itemMessages(ctx, ctx.me, issue_id, through))
    return null
  },
})

/* Snoozes the caller's item about one task until `until`, or with null
 * lifts its snooze now, with snooze's checks, refusals and scheduled wake
 * (model/messages.ts snoozeMessages). An `until` that snooze refuses, in
 * the past or past LIMITS.snooze, is refused also when the caller holds no
 * item about the task, as snooze refuses it with no ids. */
export const snoozeItem = orgMutation({
  args: { issue_id: v.string(), until: v.union(v.string(), v.null()) },
  handler: async (ctx, { issue_id, until }) => {
    await snoozeMessages(ctx, ctx.me, await itemMessages(ctx, ctx.me, issue_id), until)
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

/* One background step that gives the inbox items of moved tasks their
 * tasks' projects, scheduled by name from a move and from itself
 * (model/inboxItems.ts rekeyItems, rekeyStep). */
export const rekeyItems = internalMutation({
  args: { issues: v.array(v.string()) },
  handler: async (ctx, a) => {
    await rekeyStep(ctx, a.issues)
    return null
  },
})

/* One background step of a comment's or a change's follower notices,
 * scheduled by name from the fan-outs and from itself (model/messages.ts
 * FOLLOWER_FANOUT). */
export const notifyFollowers = internalMutation({
  args: vFollowerStep,
  handler: async (ctx, a) => {
    await notifyFollowersStep(ctx, a)
    return null
  },
})

/* One background step of the mention notices a write left to steps,
 * scheduled by name from the fan-outs and from itself (model/messages.ts
 * tellMentioned). */
export const notifyMentions = internalMutation({
  args: vMentionStep,
  handler: async (ctx, a) => {
    await notifyMentionsStep(ctx, a)
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
    // the archived projects the chain walks after this one
    // (model/messages.ts ARCHIVED_READ_PROJECTS)
    rest: v.optional(v.array(v.string())),
    cursor: v.optional(v.string()),
    batch: v.optional(v.number()),
    tasks: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    await readArchivedProjectMessages(ctx, { ...a, now: new Date().toISOString() })
    return null
  },
})
