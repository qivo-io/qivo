/* The one bounded read of a recipient's inbox, which no surface reads any
 * more. The app's Inbox list reads inbox.page, its desktop alerts read
 * inbox.feed, and REST GET /v1/inbox and MCP list_inbox page the stored
 * inbox items through model/inboxPage.ts inboxWalk. Only tests call
 * loadInbox.
 *
 * Unread rows are never retired by retention, and read rows stay while a
 * person keeps retention at Never, so an inbox nobody clears grows without
 * limit. Reading all of it would eventually pass Convex's per-transaction
 * limits (32,000 documents scanned, 16 MiB read) and fail the whole read,
 * which for the app means it cannot load at all. This read never
 * collects the recipient's rows. It walks two index ranges newest first and
 * stops at fixed bounds, so its cost depends on `limit` and `peek`, never on
 * the size of the inbox. src/ imports this module for the rules below, so
 * it must stay free of server runtime: its imports are types.
 *
 * It also holds the rules of an Inbox row's text and kinds (messageDetail,
 * messageLine, inboxSearchText, itemKinds, kindsMatch), which the Inbox
 * page (model/inboxPage.ts) applies on the server. The app's list shows
 * the page's rows and applies none of them itself; the app's stand-in of
 * the page (src/store/inboxStandIn.setup.ts) applies the same ones, so the
 * two find and show alike. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { MessageKind } from './enums'

/* INBOX_LIMIT (lib/limits.ts) is the most unread rows, and separately the
 * most read rows, that one inbox read keeps.
 *
 * Each walk examines at most 2 * INBOX_LIMIT rows plus one that shows it
 * stopped early, so one read fetches at most 2,002 messages, and a read
 * that passes `peek` looks past a walk's stop at up to that many snoozed
 * rows more (loadInbox). Raising the limit raises those counts in step. */

/** Whether the reader is shown the task with this id, answered at once or
 * after a read. */
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
 * `peek` is how many snoozed rows a walk that stopped early
 * reads past its stop, looking for one the bulk actions reach, which decides
 * unreadTruncated and readTruncated, so a backlog of snoozed rows alone does
 * not keep those actions available. With 0, the default, they equal each
 * walk's truncation, at no extra read.
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

/* ------------------------------------------------------ an Inbox row's text */

/** What an inbox item counts of each kind of message (schema.ts
 * inbox_items). */
export type KindCounts = Pick<Doc<'inbox_items'>, 'mentions' | 'changes' | 'comments'>

/* The count of each kind, written in the order of lib/enums.ts
 * MESSAGE_KINDS, which this module cannot import, because lib/enums.ts
 * loads convex-helpers at run time. */
const KIND_COUNT = {
  mention: 'mentions',
  change: 'changes',
  comment: 'comments',
} as const satisfies Record<MessageKind, keyof KindCounts>

/** The kinds of an item's messages, those it counts at least one of, in
 * the order of MESSAGE_KINDS (lib/enums.ts). The app (store/viewModels.ts
 * shapeMessageGroup `kinds`) gathers the same kinds in the order of their
 * oldest messages. */
export const itemKinds = (counts: KindCounts): MessageKind[] =>
  (Object.keys(KIND_COUNT) as MessageKind[]).filter((kind) => counts[KIND_COUNT[kind]] > 0)

/** Whether an item passes the Inbox's kind filter `kinds`: it holds a
 * message of one of them, so a mention behind a newer change still
 * matches Mentions. An empty filter passes every item. */
export const kindsMatch = (counts: KindCounts, kinds: readonly MessageKind[]): boolean =>
  kinds.length === 0 || kinds.some((kind) => counts[KIND_COUNT[kind]] > 0)

/** A message's detail as the Inbox shows and searches it (messageLine,
 * inboxSearchText), on the server (model/inboxPage.ts), in the app's rows
 * (src/store/viewModels.ts shapeInboxRow) and in the page's stand-in
 * (src/store/inboxStandIn.setup.ts). Migration 0075 stored one
 * privacy-fenced fallback with the former noun, which reads "a task in
 * another project" here. */
export const messageDetail = (detail: string): string =>
  detail.replace('an issue in another project', 'a task in another project')

/** The second line of an Inbox row, from its newest message, which the
 * page's search reads on the server (model/inboxPage.ts) and in its
 * stand-in (src/store/inboxStandIn.setup.ts), and the app's row shows
 * (src/store/viewModels.ts shapeInboxRow): "from @Name" for a mention, with
 * "Someone" where Qivo cannot name the actor (a machine caller or a
 * removed profile), "New comment" for a comment, and a change's detail. */
export function messageLine(
  message: { kind: MessageKind; detail: string },
  actorName: string | null,
): string {
  if (message.kind === 'mention') return `from @${actorName ?? 'Someone'}`
  if (message.kind === 'comment') return 'New comment'
  return messageDetail(message.detail)
}

/** What an Inbox search reads of one row. */
export type InboxSearchFields = {
  /** the task's live title */
  title: string
  /** the task ID, such as QN-12 (lib/taskRefs.ts issueKey) */
  key: string
  /** the row's second line (messageLine) */
  line: string
  /** the names of the project above the task's project, if any, and of
   * the task's project */
  places: readonly (string | null | undefined)[]
  /** the item's messages, each with its actor's name, null where Qivo
   * cannot name one */
  messages: readonly { actor_name: string | null; detail: string }[]
}

/** The text an Inbox search matches against for one row, one field a line,
 * in the order src/panels/Inbox.tsx joins them: the title, the key, the
 * second line, the places and then each message as its actor's name
 * ("API" without one) and its detail. Empty fields are left out. A search
 * word holds no whitespace (lib/search.ts allWordsMatcher), so it never
 * spans two lines, and a caller may match the fields without the messages
 * first and add them only when those miss a word. */
export function inboxSearchText(o: InboxSearchFields): string {
  return [o.title, o.key, o.line, ...o.places]
    .concat(o.messages.map((m) => `${m.actor_name ?? 'API'}\n${messageDetail(m.detail)}`))
    .filter(Boolean)
    .join('\n')
}
