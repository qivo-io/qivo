/* The inbox reads that need only inbox_items rows (schema.ts), the capped
 * unread summary across a person's seats and one task's item for the task
 * window, which convex/inbox.ts serves. The Inbox's pages
 * (model/inboxPage.ts) judge their rows with the same scope (inboxScope)
 * and answer the same unread change (unreadChange). The app's Inbox badge
 * and its bulk actions' availability read the summary, and its task window
 * reads the item for its New divider and its read on open. The app's Inbox
 * list reads the workspace inbox part (lib/workspaceParts.ts readInbox)
 * until a later release switches it.
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
import { BUILD } from '../internal/inboxItemsBackfill'
import { accessOf, isAccessUnchecked } from '../lib/access'
import { byId, usedMoreThan } from '../lib/db'
import { MENTION_DETAILS } from '../lib/messageDetails'
import type { ReadGuard } from '../lib/namedPages'
import { itemRow, seatReady } from './inboxItems'
import { bulkRows } from './messages'

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
 * projects that can hold them, each task read once and each project checked
 * once (lib/access.ts accessOf). Every answer rejects with accessUnchecked
 * where a bound stopped the check. */
export function inboxScope(ctx: QueryCtx, me: Doc<'profiles'>) {
  const access = accessOf(ctx, me)
  const tasks = new Map<string, Promise<Doc<'issues'> | null>>()
  const projects = new Map<string, Promise<boolean>>()
  /* the task with this id, read once, by `read` the first time */
  const task = (
    issueId: string,
    read: (id: string) => Promise<Doc<'issues'> | null> = (id) => byId(ctx, 'issues', id),
  ): Promise<Doc<'issues'> | null> => {
    let known = tasks.get(issueId)
    if (known === undefined) {
      known = read(issueId)
      tasks.set(issueId, known)
    }
    return known
  }
  /* whether `t` is in the seat's working set */
  const shows = async (t: Doc<'issues'>): Promise<boolean> =>
    t.org_id === me.org_id && (await access.holds(t))
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
    async shownTask(issueId: string): Promise<Doc<'issues'> | null> {
      const t = await task(issueId)
      return t !== null && (await shows(t)) ? t : null
    },
    /** The task with this id, of any organization and whether shown or
     * not, or null. `read` reads it the first time, such as through a
     * walk's read guard (lib/namedPages.ts ReadGuard lookup), so the walk
     * counts it. */
    task,
    /** Whether task `t`, read by `task`, is in the seat's working set: of
     * the seat's organization, not archived, in a project of it that is
     * not archived and that the seat can see (lib/access.ts accessOf
     * holds). */
    shows,
    /** The project with this id, of any organization, or null, read once
     * for every answer here (lib/access.ts accessOf project), so a reader
     * names the project of a task the scope showed without reading it
     * again. */
    project: access.project,
  }
}

/** A read's step budget, SUMMARY's by default. A step goes on while the
 * transaction has used no more than `bounds.room` of any of Convex's
 * limits, asked before every `bounds.batch` steps (lib/db.ts
 * usedMoreThan). Once a check finds no room, no later step goes on. The
 * summary and the catch-up (model/notificationCatchup.ts CATCH_UP) use it,
 * each with its own bounds, read at every check, so a test can lower them. */
export function stepBudget(
  ctx: QueryCtx,
  bounds: { batch: number; room: number } = SUMMARY,
): () => Promise<boolean> {
  let steps = 0
  let spent = false
  return async () => {
    if (spent) return false
    if (steps % bounds.batch === 0 && (await usedMoreThan(ctx, bounds.room))) {
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
 * read the first message of the range each action walks (model/messages.ts
 * bulkRows), which includes messages about tasks the seat cannot see, as
 * markAllMessagesRead and removeReadMessages reach those too. */
async function seatLine(ctx: QueryCtx, me: Doc<'profiles'>): Promise<SeatSummary> {
  const [ready, unread, read] = await Promise.all([
    seatReady(ctx, me.id),
    bulkRows(ctx, me.id, 'read').first(),
    bulkRows(ctx, me.id, 'remove').first(),
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
 * budget ended the walk, or a check of the seat's access that a bound
 * stopped (lib/access.ts accessUnchecked), so `counted` is a lower bound. */
async function countSeat(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  most: number,
  step: () => Promise<boolean>,
): Promise<{ counted: number; stopped: boolean }> {
  const walk = { counted: 0 }
  try {
    return await walkSeat(ctx, me, most, step, walk)
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return { counted: walk.counted, stopped: true }
  }
}

/* countSeat's walk, which keeps its count in `walk` as it goes, so a
 * refused access check stops it with what it counted. */
async function walkSeat(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  most: number,
  step: () => Promise<boolean>,
  walk: { counted: number },
): Promise<{ counted: number; stopped: boolean }> {
  const scope = inboxScope(ctx, me)
  const unread = (after: string | undefined) =>
    ctx.db.query('inbox_items').withIndex('by_recipient_unread_project', (q) => {
      const seat = q.eq('recipient_id', me.id).eq('unread', true).eq('snoozed', false)
      return after === undefined ? seat : seat.gt('project_id', after)
    })
  let after: string | undefined
  for (;;) {
    let project: string | undefined
    let skip: string | undefined
    for await (const item of unread(after)) {
      if (item.project_id !== undefined && item.project_id !== project) {
        project = item.project_id
        if (!(await step())) return { counted: walk.counted, stopped: true }
        if (!(await scope.holdsItems(project))) {
          skip = project
          break
        }
      }
      if (!(await step())) return { counted: walk.counted, stopped: true }
      if ((await scope.shownTask(item.issue_id)) !== null) {
        walk.counted += 1
        if (walk.counted === most) return { counted: walk.counted, stopped: false }
      }
    }
    if (skip === undefined) return { counted: walk.counted, stopped: false }
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

/* The task with this id when `scope`'s seat is shown it, else null, also
 * where a bound stopped the check of the seat's access (lib/access.ts
 * accessUnchecked): the task window answers `unavailable` for that task
 * then (lib/taskWindow.ts), so no item of it shows either. */
async function shownOrUnchecked(scope: ReturnType<typeof inboxScope>, issueId: string) {
  try {
    return await scope.shownTask(issueId)
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return null
  }
}

/** How many read messages of one item the item read takes to count its
 * read changes. The prune keeps at most one per item (model/messages.ts
 * pruneReadMessages), so more means an item kept from before that rule. */
const READ_PEEK = 8

/* Whether `message` tells of a change the task window lists only under
 * All: a change, or a mention in the description, which comes with the
 * description's edit (src/lib/spine.ts UnreadStart). */
const tellsChange = (message: Pick<Doc<'messages'>, 'kind' | 'detail'>): boolean =>
  message.kind === 'change' ||
  (message.kind === 'mention' && message.detail === MENTION_DETAILS.description)

/**
 * Whether one of the item's unread messages tells of a change, by the app's
 * rule (src/lib/spine.ts UnreadStart): a change, or a mention in the
 * description. The item counts its changes and mentions read or not, so
 * the unread ones are those beyond the read ones, which the prune keeps to
 * at most one, so the answer reads the item's read messages, one normally,
 * and, only when no change is unread and a mention is, walks the unread
 * messages up to the first mention in the description. An item with more
 * than READ_PEEK read messages, kept from before that rule, is walked
 * unread first instead, up to its first such message.
 *
 * A walk reads at most BUILD.pair_rows (1,000) unread messages, the most
 * messages internal/inboxItemsBackfill.ts builds an item of. An item the
 * cap keeps holds at most ITEM_UNREAD_CAP (model/messages.ts) unread
 * messages, and one kept from before the cap as many as the backfill built
 * it with, which later arrivals trim toward the cap. When an item holds
 * more unread messages than the walk read and none of those it read tells
 * of a change, it answers true, since the messages it left may, and the
 * task window then names the All filter rather than hide a change.
 * `guard`, when given, counts every range and message read
 * (lib/namedPages.ts ReadGuard), as a page's walk needs.
 */
export async function unreadChange(
  ctx: QueryCtx,
  pair: { recipient_id: string; issue_id: string },
  row: Pick<Doc<'inbox_items'>, 'changes' | 'mentions' | 'unread_count'>,
  guard?: ReadGuard,
): Promise<boolean> {
  if (row.unread_count === 0 || (row.changes === 0 && row.mentions === 0)) return false
  const messages = (read: boolean) =>
    ctx.db.query('messages').withIndex('by_recipient_issue_read_order', (q) => {
      const item = q.eq('recipient_id', pair.recipient_id).eq('issue_id', pair.issue_id)
      return read ? item.gt('read_at', undefined) : item.eq('read_at', undefined)
    })
  // the unread messages, up to the first that tells of a change, at most
  // BUILD.pair_rows of them
  const walk = async (): Promise<boolean> => {
    await guard?.range()
    let seen = 0
    for await (const message of messages(false)) {
      await guard?.document(message)
      if (tellsChange(message)) return true
      seen += 1
      // the unread messages past the bound may tell of one
      if (seen === BUILD.pair_rows) return row.unread_count > seen
    }
    return false
  }
  await guard?.range()
  const read = await messages(true).take(READ_PEEK + 1)
  for (const message of read) await guard?.document(message)
  if (read.length > READ_PEEK) return await walk()
  const readOf = (kind: Doc<'messages'>['kind']) => read.filter((m) => m.kind === kind).length
  if (row.changes > readOf('change')) return true
  return row.mentions > readOf('mention') && (await walk())
}

/**
 * Seat `me`'s item about task `issueId`, for the task window. `building`
 * while the seat is not ready (seatReady). Otherwise `item` is null when the
 * seat holds no item about the task or is not shown the task, or when a
 * bound stopped that check, where the task window answers `unavailable`
 * for the same task (shownOrUnchecked), and else
 * holds the item's counts, the oldest unread message's created_at
 * (`first_unread_at`, null when all are read), whether an unread message
 * tells of a change, a change or a mention in the description
 * (`unread_change`, unreadChange), the newest message by (created_at, id) for
 * the row's second line, the item's snooze, and `through`, the item's
 * newest _creationTime, which readItem and removeItem take so that they
 * leave out what was stored after this answer by more than one mutation's
 * run time, backdated notices included. A message from a mutation that
 * started before this read and committed after it can carry an earlier or
 * equal _creationTime and is then taken too, until messages carry the
 * planned commit timestamp (model/messages.ts itemMessages).
 *
 * It reads the item row, the seat's readiness (two ranges), the task with
 * its project and the seat's access rows, the newest message by
 * _creationTime, the oldest unread message, and for an item with an unread
 * message and a change or a mention its read messages (unreadChange), one
 * normally, and the unread ones up to the first mention in the description
 * only when no change is unread and a mention is, at most BUILD.pair_rows
 * (1,000) of them. An item with more, none of those a change, answers
 * `unread_change` true (unreadChange).
 */
export async function readInboxItem(ctx: QueryCtx, me: Doc<'profiles'>, issueId: string) {
  if (!(await seatReady(ctx, me.id))) return { state: 'building' as const }
  const pair = { recipient_id: me.id, issue_id: issueId }
  const row = await itemRow(ctx, pair)
  if (row === null || (await shownOrUnchecked(inboxScope(ctx, me), issueId)) === null)
    return { state: 'ok' as const, item: null }
  // the newest message by _creationTime, the cutoff the item actions take
  // (model/messages.ts itemMessages)
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
