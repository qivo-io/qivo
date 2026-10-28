/* The inbox reads that need only inbox_items rows (schema.ts), the capped
 * unread summary across a person's seats and one task's item for the task
 * window, which convex/inbox.ts serves. The app does not call them yet. It
 * reads the workspace inbox part (lib/workspaceParts.ts readInbox) until a
 * later release switches it.
 *
 * Both show the seat's working set, as readInbox does, which holds a task
 * that is not archived, in a project of the seat's organization that is
 * not archived and that the seat can see, navigation included
 * (lib/access.ts accessOf).
 * A row's project_id is only a hint (schema.ts inbox_items), so every item
 * a read counts or returns has its task read and checked by the task's own
 * project.
 *
 * A profile's rows are complete only once its inbox_state says so
 * (model/inboxItems.ts seatReady). Until then these reads say the seat is
 * not ready instead of answering from rows that may be missing. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { accessOf } from '../lib/access'
import { byId, usedMoreThan } from '../lib/db'
import { itemRow, seatReady } from './inboxItems'

/** The bounds of the unread summary. It counts at most `most` items, so the
 * badge can say "more than 99". It asks how much the transaction has read
 * before each `batch` of steps (a seat's four reads, a project check or a
 * task read; 16 tasks with 20,000-character descriptions in a three-byte
 * script are about 1 MB), and starts no further batch once the transaction
 * has used more than `room` of any of Convex's limits (lib/db.ts
 * usedMoreThan, which counts every read as the deployment does). It then
 * answers the count so far as a lower bound. Tests lower them. */
export const SUMMARY = { most: 100, batch: 16, room: 0.5 }

/** One seat's view of its inbox items, the tasks it is shown and the
 * projects that can hold them, each task and each project checked once
 * (lib/access.ts accessOf). */
export function inboxScope(ctx: QueryCtx, me: Doc<'profiles'>) {
  const access = accessOf(ctx, me)
  const tasks = new Map<string, Promise<Doc<'issues'> | null>>()
  const projects = new Map<string, Promise<boolean>>()
  return {
    /** Whether the project with this id can hold a task the seat is shown,
     * which needs it to be one of the seat's organization's, not archived
     * and visible to the seat. When it cannot, a reader skips its items
     * without reading their tasks. */
    holdsItems(projectId: string): Promise<boolean> {
      let known = projects.get(projectId)
      if (known === undefined) {
        known = access
          .live(projectId)
          .then(async (live) => live && (await access.visible(projectId)))
        projects.set(projectId, known)
      }
      return known
    },
    /** The task with this id when it is in the seat's working set, else
     * null. */
    shownTask(issueId: string): Promise<Doc<'issues'> | null> {
      let known = tasks.get(issueId)
      if (known === undefined) {
        known = byId(ctx, 'issues', issueId).then(async (task) =>
          task !== null && task.org_id === me.org_id && (await access.holds(task)) ? task : null,
        )
        tasks.set(issueId, known)
      }
      return known
    },
  }
}

/* The summary's budget. A step goes on while the transaction has room
 * (SUMMARY), asked before every SUMMARY.batch steps. Once a check finds no
 * room, no later step goes on. */
function stepBudget(ctx: QueryCtx): () => Promise<boolean> {
  let steps = 0
  let spent = false
  return async () => {
    if (spent) return false
    if (steps % SUMMARY.batch === 0 && (await usedMoreThan(ctx, SUMMARY.room))) {
      spent = true
      return false
    }
    steps += 1
    return true
  }
}

/** One seat of the summary, with its organization, whether its items are
 * complete (seatReady), and whether Mark all as read and Remove all read
 * would change anything there. */
export type SeatSummary = {
  org_id: string
  ready: boolean
  can_mark_all_read: boolean
  can_remove_read: boolean
}

/* Seat `me`'s line of the summary, four index ranges at most. The flags
 * read one unsnoozed message each, unread or read, which includes messages
 * about tasks the seat cannot see, as markAllMessagesRead and
 * removeReadMessages reach those too (model/messages.ts). */
async function seatLine(ctx: QueryCtx, me: Doc<'profiles'>): Promise<SeatSummary> {
  const awake = (read: boolean) =>
    ctx.db
      .query('messages')
      .withIndex('by_recipient_snoozed_read', (q) => {
        const seat = q.eq('recipient_id', me.id).eq('snoozed_until', undefined)
        return read ? seat.gt('read_at', undefined) : seat.eq('read_at', undefined)
      })
      .first()
  const [ready, unread, read] = await Promise.all([
    seatReady(ctx, me.id),
    awake(false),
    awake(true),
  ])
  return {
    org_id: me.org_id,
    ready,
    can_mark_all_read: unread !== null,
    can_remove_read: read !== null,
  }
}

/* Counts seat `me`'s unread, unsnoozed items about tasks it is shown, up to
 * `most`, in project order (inbox_items.by_recipient_unread_project). At
 * each new project it asks whether the project can hold such tasks, and if
 * not, skips the rest of the project's items with one new range, without
 * reading their tasks. Items without a project (a task that was not live
 * when the item was last built) sort first and have their tasks read. `stopped` says the
 * budget ended the walk, so `counted` is a lower bound. */
async function countSeat(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  most: number,
  step: () => Promise<boolean>,
): Promise<{ counted: number; stopped: boolean }> {
  const scope = inboxScope(ctx, me)
  const unread = (after: string | undefined) =>
    ctx.db.query('inbox_items').withIndex('by_recipient_unread_project', (q) => {
      const seat = q.eq('recipient_id', me.id).eq('unread', true).eq('snoozed', false)
      return after === undefined ? seat : seat.gt('project_id', after)
    })
  let counted = 0
  let after: string | undefined
  for (;;) {
    let project: string | undefined
    let skip: string | undefined
    for await (const item of unread(after)) {
      if (item.project_id !== undefined && item.project_id !== project) {
        project = item.project_id
        if (!(await step())) return { counted, stopped: true }
        if (!(await scope.holdsItems(project))) {
          skip = project
          break
        }
      }
      if (!(await step())) return { counted, stopped: true }
      if ((await scope.shownTask(item.issue_id)) !== null) {
        counted += 1
        if (counted === most) return { counted, stopped: false }
      }
    }
    if (skip === undefined) return { counted, stopped: false }
    after = skip
  }
}

/**
 * The unread summary of the seats `seats`, the caller's active profiles. It
 * holds each seat's line (SeatSummary), in organization id order, and the
 * number of unread, unsnoozed items about tasks the caller is shown, across
 * every ready seat, counted up to SUMMARY.most. `unread_more` says the count
 * reached SUMMARY.most, which the app shows as "99+" and means more than
 * 99. `complete` is false when a seat is not ready (it adds nothing to the
 * count) or the budget stopped the summary, so the count is a lower bound;
 * a seat the budget did not reach is left out of `seats`. With `complete`
 * true the count can still be short for a moment, never over, while a
 * move's re-key steps run (below). The count never comes from the
 * messages, a page of items or the workspace inbox part.
 *
 * A row's project_id is the task's project at the item's last arrival,
 * build or re-key; other writes keep it. A move re-keys it inline up to
 * REKEY.inline rows and the rest in background steps (model/inboxItems.ts
 * rekeyItems), so an item whose task moved from a project the seat cannot
 * see into one it can is left out until its step runs, also when
 * `complete` is true. That is a short undercount, never a task the seat is
 * not shown, because each counted item's task is checked by its own
 * project.
 *
 * It reads each seat's line, then at most SUMMARY.most tasks with their
 * item rows, one range and a project check for each project skipped, and
 * the tasks of items it does not count in projects it does not skip (a task
 * archived before the archive's read step, a task in Deleted items before
 * its drain).
 */
export async function readInboxSummary(ctx: QueryCtx, seats: readonly Doc<'profiles'>[]) {
  const ordered = [...seats].sort((a, b) => (a.org_id < b.org_id ? -1 : 1))
  const step = stepBudget(ctx)
  const lines: SeatSummary[] = []
  let complete = true
  for (const me of ordered) {
    if (!(await step())) {
      complete = false
      break
    }
    lines.push(await seatLine(ctx, me))
  }
  let count = 0
  for (const [i, line] of lines.entries()) {
    if (!line.ready) {
      complete = false
      continue
    }
    if (count === SUMMARY.most) continue
    const walked = await countSeat(ctx, ordered[i], SUMMARY.most - count, step)
    count += walked.counted
    if (walked.stopped) complete = false
  }
  return {
    seats: lines,
    unread_count: count,
    unread_more: count >= SUMMARY.most,
    complete,
  }
}

/** How many read messages of one item the item read takes to count its
 * read changes. The prune keeps at most one per item (model/messages.ts
 * pruneReadMessages), so more means an item kept from before that rule. */
const READ_PEEK = 8

/* Whether one of the item's unread messages is a change. The item counts
 * its changes read or not (`changes`), so the unread ones are those beyond
 * the read changes, which the prune keeps to at most one: the answer reads
 * the item's read messages, one normally. An item with more than READ_PEEK
 * read messages is walked unread first instead, up to its first change. */
async function unreadChange(
  ctx: QueryCtx,
  pair: { recipient_id: string; issue_id: string },
  row: Pick<Doc<'inbox_items'>, 'changes' | 'unread_count'>,
): Promise<boolean> {
  if (row.changes === 0 || row.unread_count === 0) return false
  const messages = (read: boolean) =>
    ctx.db.query('messages').withIndex('by_recipient_issue_read_order', (q) => {
      const item = q.eq('recipient_id', pair.recipient_id).eq('issue_id', pair.issue_id)
      return read ? item.gt('read_at', undefined) : item.eq('read_at', undefined)
    })
  const read = await messages(true).take(READ_PEEK + 1)
  if (read.length <= READ_PEEK)
    return row.changes > read.filter((message) => message.kind === 'change').length
  for await (const message of messages(false)) if (message.kind === 'change') return true
  return false
}

/**
 * Seat `me`'s item about task `issueId`, for the task window. `building`
 * while the seat is not ready (seatReady). Otherwise `item` is null when the
 * seat holds no item about the task or is not shown the task, and else
 * holds the item's counts, the oldest unread message's created_at
 * (`first_unread_at`, null when all are read), whether an unread message is
 * a change (`unread_change`), the newest message by (created_at, id) for
 * the row's second line, the item's snooze, and `through`, the
 * _creationTime of its newest message by insertion, which readItem and
 * removeItem take so that they leave out what was stored after this answer
 * (model/messages.ts itemMessages).
 *
 * It reads the item row, the seat's readiness (two ranges), the task with
 * its project and the seat's access rows, the newest message by insertion,
 * the oldest unread message, and for an item with an unread message and a
 * change its read messages (unreadChange), one normally, so its cost does
 * not grow with the item.
 */
export async function readInboxItem(ctx: QueryCtx, me: Doc<'profiles'>, issueId: string) {
  if (!(await seatReady(ctx, me.id))) return { state: 'building' as const }
  const pair = { recipient_id: me.id, issue_id: issueId }
  const row = await itemRow(ctx, pair)
  if (row === null || (await inboxScope(ctx, me).shownTask(issueId)) === null)
    return { state: 'ok' as const, item: null }
  // the newest message by insertion, which a later one, backdated or not,
  // always follows
  const newest = await ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) => q.eq('recipient_id', me.id).eq('issue_id', issueId))
    .order('desc')
    .first()
  if (newest === null) return { state: 'ok' as const, item: null }
  const firstUnread =
    row.unread_count === 0
      ? null
      : await ctx.db
          .query('messages')
          .withIndex('by_recipient_issue_read_order', (q) =>
            q.eq('recipient_id', me.id).eq('issue_id', issueId).eq('read_at', undefined),
          )
          .first()
  return {
    state: 'ok' as const,
    item: {
      unread_count: row.unread_count,
      dropped: row.dropped,
      first_unread_at: firstUnread?.created_at ?? null,
      unread_change: await unreadChange(ctx, pair, row),
      latest_id: row.latest_id,
      latest_at: row.latest_at,
      snoozed_until: row.snoozed_until ?? null,
      through: newest._creationTime,
    },
  }
}
