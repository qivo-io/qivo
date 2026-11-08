/* The order of a recipient's inbox messages (newestFirst) and the rules of
 * an Inbox row's text and kinds (messageDetail, messageLine,
 * inboxSearchText, itemKinds, kindsMatch), which the Inbox page
 * (model/inboxPage.ts) applies on the server. The app's list shows the
 * page's rows and applies none of them itself; the app's stand-in of the
 * page (src/store/inboxStandIn.setup.ts) applies the same ones, so the two
 * find and show alike. src/ imports this module for these rules, so it must
 * stay free of server runtime, and its imports are types. */

import type { Doc } from '../_generated/dataModel'
import type { MessageKind } from './enums'

/** The message fields the inbox orders by. */
type Ordered = Pick<Doc<'messages'>, 'id' | 'created_at'>

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
 * the order of MESSAGE_KINDS (lib/enums.ts), as the Inbox's pages
 * (model/inboxPage.ts) and their stand-in (src/store/inboxStandIn.setup.ts)
 * answer them. */
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
