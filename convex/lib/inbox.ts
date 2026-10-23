/* The one bounded read of a recipient's inbox, shared by the app's inbox
 * part (lib/workspaceParts.ts readInbox) and the machine inbox
 * (machine/discussion.ts inboxItems). Both read with INBOX_LIMIT, so they
 * walk the same rows in the same order and keep the same ones. The machine
 * inbox folds all of them into items, and the app shows the first
 * LIMITS.inboxShown (lib/limits.ts) across a person's seats, unread rows
 * first (blendInbox), so the messages the app lists for a seat are always
 * among the ones the machine inbox lists for that profile.
 *
 * Unread rows are never retired by retention, and read rows stay while a
 * person keeps retention at Never, so an inbox nobody clears grows without
 * limit. Reading all of it would eventually pass Convex's per-transaction
 * limits (32,000 documents scanned, 16 MiB read) and fail the whole read,
 * which for the app means it cannot load at all. This read never
 * collects the recipient's rows. It walks two index ranges newest first and
 * stops at fixed bounds, so its cost depends on `limit` and `peek`, never on
 * the size of the inbox. src/ imports this module for blendInbox, so it
 * must stay free of server runtime: its imports are types. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/* INBOX_LIMIT (lib/limits.ts) is the most unread rows, and separately the
 * most read rows, that one inbox read keeps. The app (per seat) and the
 * machine inbox both read with it, so the two surfaces select alike.
 *
 * Each walk examines at most 2 * INBOX_LIMIT rows plus one that shows it
 * stopped early, so one read fetches at most 2,002 messages. The app's read
 * also looks past a walk's stop at up to INBOX_LIMIT snoozed rows (loadInbox
 * `peek`), so its read fetches at most 3,002. The machine
 * inbox reads a task for each new task id among the examined rows, so at
 * most 2,000 task lookups, plus a handful of access lookups per distinct
 * project, each project checked once. That stays well under Convex's 4,096
 * index ranges per transaction unless the examined rows span a few hundred
 * projects. Raising the limit raises those counts in step. */

/** Whether the reader is shown the task with this id, answered at once or
 * after a read (the machine inbox reads each task as it is asked). */
export type InboxShown = (issueId: string) => boolean | Promise<boolean>

/** What one bounded inbox read kept. */
export type InboxLoad = {
  /** unread rows about shown tasks, newest stored first */
  unread: Doc<'messages'>[]
  /** read rows about shown tasks, most recently read first */
  read: Doc<'messages'>[]
  /** whether the unread walk left unexamined rows that Mark all as read
   * (markAllMessagesRead) reaches. That action skips snoozed rows, so this
   * is false when every row left is snoozed, unless more than `peek` are. */
  unreadTruncated: boolean
  /** the same for the read walk and Remove all read (removeReadMessages),
   * which skips snoozed rows too */
  readTruncated: boolean
  /** whether some of the recipient's rows were left unexamined (either walk),
   * snoozed ones included */
  truncated: boolean
}

/* Keeps rows about shown tasks from `rows` until `limit` are kept, examining
 * at most `budget` of them, so rows about hidden or archived tasks cannot
 * make the walk unbounded. `truncated` is true when a row was left
 * unexamined; seeing that costs one extra row read. `actionable` narrows it
 * to an unexamined row that is not snoozed, the kind the bulk actions
 * reach. To tell, the walk reads on past up to `peek` snoozed rows. Once it
 * has passed that many and another row follows, it reports one as possible
 * without reading further. */
async function keepShown(
  rows: AsyncIterable<Doc<'messages'>>,
  isShown: InboxShown,
  limit: number,
  budget: number,
  peek: number,
): Promise<{ kept: Doc<'messages'>[]; truncated: boolean; actionable: boolean }> {
  const kept: Doc<'messages'>[] = []
  let examined = 0
  let snoozedPast = 0
  for await (const row of rows) {
    if (kept.length < limit && examined < budget) {
      examined += 1
      if (await isShown(row.issue_id)) kept.push(row)
      continue
    }
    if (row.snoozed_until === undefined || snoozedPast >= peek) {
      return { kept, truncated: true, actionable: true }
    }
    snoozedPast += 1
  }
  return { kept, truncated: snoozedPast > 0, actionable: false }
}

/**
 * Reads the recipient's inbox, bounded by `limit`, in two walks.
 *
 * Unread rows come from `by_recipient_read` with no `read_at`, newest
 * stored first (the index orders them by insertion, which matches
 * created_at for live arrivals; only a seed backdates one). Read rows come
 * from the same index with a `read_at`, most recently read first. Each walk
 * keeps rows whose task `isShown` until `limit` are kept and examines at most
 * 2 * limit rows, so at most 4 * limit + 2 messages are read however large
 * the inbox is. Rows about tasks the reader is not shown stay stored and
 * count toward the examination bound, so when enough of them are newer than
 * the shown ones to use it up, the older shown rows are not reached, which
 * is the accepted cost of the bound.
 *
 * The walks are bounded separately, so a backlog in one never hides the
 * other. A person with a thousand old unread rows about tasks they lost
 * access to still gets their recent read rows. Archiving a task marks its
 * rows read (model/messages.ts), so those count toward the read walk. The
 * cost is that a read row can come back while an older unread row about the
 * same task was not reached, and then both surfaces show that task as read,
 * alike.
 *
 * `peek` (0 by default) is how many snoozed rows a walk that stopped early
 * reads past its stop, looking for one the bulk actions reach, which decides
 * unreadTruncated and readTruncated. The app's read passes INBOX_LIMIT, so a
 * backlog of snoozed rows alone does not keep those actions available. With
 * 0 they equal each walk's truncation, at no extra read.
 */
export async function loadInbox(
  ctx: QueryCtx,
  recipientId: string,
  isShown: InboxShown,
  limit: number,
  peek = 0,
): Promise<InboxLoad> {
  const unread = await keepShown(
    ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', recipientId).eq('read_at', undefined),
      )
      .order('desc'),
    isShown,
    limit,
    2 * limit,
    peek,
  )
  const read = await keepShown(
    ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', recipientId).gt('read_at', undefined),
      )
      .order('desc'),
    isShown,
    limit,
    2 * limit,
    peek,
  )
  return {
    unread: unread.kept,
    read: read.kept,
    unreadTruncated: unread.actionable,
    readTruncated: read.actionable,
    truncated: unread.truncated || read.truncated,
  }
}

/** The message fields the inbox orders by. */
type Ordered = Pick<Doc<'messages'>, 'id' | 'created_at' | 'read_at'>

/** Newest first by created_at, the id breaking a tie, the total order the
 * prune uses. */
export const newestFirst = (a: Ordered, b: Ordered): number => {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1
}

/** Most recently read first, then newestFirst. */
export const recentlyReadFirst = (a: Ordered, b: Ordered): number => {
  const ra = a.read_at ?? ''
  const rb = b.read_at ?? ''
  if (ra !== rb) return ra < rb ? 1 : -1
  return newestFirst(a, b)
}

/** One seat's inbox as the app receives it (lib/workspaceParts.ts
 * readInbox): its kept unread and read rows in their orders, the read rows
 * it kept minus snoozed ones, and its read's truncation flags. */
export type SeatInbox<M> = {
  unread: M[]
  read: M[]
  readMessageCount: number
  unreadTruncated: boolean
  readTruncated: boolean
  truncated: boolean
}

/**
 * The inbox the app shows across a person's seats: one cap of `cap`
 * messages over all of them, unread rows first, newest first, then read
 * rows, most recently read first, as the list shows them.
 *
 * - readMessageCount adds up each seat's kept read rows minus snoozed ones,
 *   counted before the cut, so cleanup stays available when unread rows fill
 *   the cap. The app only asks whether it is above zero.
 * - unreadTruncated and readTruncated hold when a seat's bounded read left
 *   rows the bulk actions reach unexamined. When several seats keep unread
 *   rows, the cut can also drop some that Mark all as read reaches while
 *   every unread row shown is snoozed, which sets unreadTruncated too. Read
 *   rows it drops are in readMessageCount already.
 * - messagesCut holds when the Inbox lists fewer messages than the person
 *   has: a seat's read stopped early, snoozed rows included, or the cap
 *   dropped some.
 *
 * Each seat sends every unread row it kept, and ordering one seat's rows
 * alone never ranks a row higher than among all seats' rows, so this equals
 * one sort over every seat's rows.
 */
export function blendInbox<M extends Ordered & Pick<Doc<'messages'>, 'snoozed_until'>>(
  seats: readonly SeatInbox<M>[],
  cap: number,
) {
  const unread = seats.flatMap((s) => s.unread).sort(newestFirst)
  const read = seats.flatMap((s) => s.read).sort(recentlyReadFirst)
  const messages = [...unread, ...read].slice(0, cap)
  return {
    messages,
    readMessageCount: seats.reduce((n, s) => n + s.readMessageCount, 0),
    unreadTruncated:
      seats.some((s) => s.unreadTruncated) ||
      unread.slice(cap).some((message) => message.snoozed_until === undefined),
    readTruncated: seats.some((s) => s.readTruncated),
    messagesCut: seats.some((s) => s.truncated) || unread.length + read.length > cap,
  }
}
