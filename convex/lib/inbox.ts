/* The one bounded read of a recipient's inbox, shared by the app's snapshot
 * (convex/snapshot.ts forMe) and the machine inbox (machine/discussion.ts
 * inboxItems). Both walk the same rows in the same order and list read rows
 * only once every unread row was examined, so when the inbox outgrows what
 * they deliver, the messages the app lists for a seat are among the ones
 * the machine inbox lists for that profile.
 *
 * Unread rows are never retired by retention, and read rows stay while a
 * person keeps retention at Never, so an inbox nobody clears grows without
 * limit. Reading all of it would eventually pass Convex's per-transaction
 * limits (32,000 documents scanned, 16 MiB read) and fail the whole read,
 * which for the snapshot means the app cannot load at all. This read never
 * collects the recipient's rows. It walks two index ranges newest first and
 * stops at fixed bounds, so its cost depends on `limit`, never on the size
 * of the inbox. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'

/** Whether the reader is shown the task with this id, answered at once or
 * after a read (the machine inbox reads each task as it is asked). */
export type InboxShown = (issueId: string) => boolean | Promise<boolean>

/** What one bounded inbox read kept. */
export type InboxLoad = {
  /** unread rows about shown tasks, newest stored first */
  unread: Doc<'messages'>[]
  /** read rows about shown tasks, most recently read first */
  read: Doc<'messages'>[]
  /** whether some unread rows were left unexamined. A list that puts unread
   * rows first then cannot show `read` without showing read rows ahead of
   * unread ones this read never reached. */
  unreadTruncated: boolean
  /** whether some of the recipient's rows were left unexamined */
  truncated: boolean
}

/* Keeps rows about shown tasks from `rows` until `limit` are kept, examining
 * at most `budget` of them, so rows about hidden or archived tasks cannot
 * make the walk unbounded. `truncated` is true when a row was left
 * unexamined; seeing that costs one extra row read. */
async function keepShown(
  rows: AsyncIterable<Doc<'messages'>>,
  isShown: InboxShown,
  limit: number,
  budget: number,
): Promise<{ kept: Doc<'messages'>[]; examined: number; truncated: boolean }> {
  const kept: Doc<'messages'>[] = []
  let examined = 0
  for await (const row of rows) {
    if (kept.length >= limit || examined >= budget) return { kept, examined, truncated: true }
    examined += 1
    if (await isShown(row.issue_id)) kept.push(row)
  }
  return { kept, examined, truncated: false }
}

/**
 * Reads the recipient's inbox, bounded by `limit`, unread rows first.
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
 * `limit` bounds each walk separately, so a reader whose unread rows fill
 * the limit still learns of its read rows (the snapshot counts them for
 * Remove all read, and lists them only when `unreadTruncated` is false).
 * With `shared`, both walks share one limit and one examination bound. Read
 * rows then only fill the room the unread rows left, at most `limit` rows
 * come back, at most 2 * limit + 2 are read, and no read row comes back
 * while `unreadTruncated` (the machine inbox, whose `isShown` reads a task
 * per new task id).
 */
export async function loadInbox(
  ctx: QueryCtx,
  recipientId: string,
  isShown: InboxShown,
  limit: number,
  { shared = false }: { shared?: boolean } = {},
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
  )
  const read = await keepShown(
    ctx.db
      .query('messages')
      .withIndex('by_recipient_read', (q) =>
        q.eq('recipient_id', recipientId).gt('read_at', undefined),
      )
      .order('desc'),
    isShown,
    shared ? limit - unread.kept.length : limit,
    shared ? 2 * limit - unread.examined : 2 * limit,
  )
  return {
    unread: unread.kept,
    read: read.kept,
    unreadTruncated: unread.truncated,
    truncated: unread.truncated || read.truncated,
  }
}
