/* What the Inbox list (panels/Inbox.tsx) asks inbox.page and says about
   its answer, kept out of the panel so it stays pure: the page's
   arguments from the filters, the batch the page engine shows
   (lib/pagedList.ts usePagedPages), and the sentences of the notes and of
   the line that ends a page (components/pageFold.tsx PageFold), each only
   where the answer says it (convex/model/inboxPage.ts header). Nothing
   here filters, searches, sorts or counts rows: the server applies the
   order, the filters and the search before it cuts the page. Types come
   from inbox.page, so the list follows the server's answer. It imports
   nothing from the store. */

import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'

/** One answer of inbox.page. */
export type InboxPageAnswer = FunctionReturnType<typeof api.inbox.page>
/** One row of it, a task group. */
export type InboxPageRow = InboxPageAnswer['rows'][number]
/** A kind of message, as the kind filter names it. */
export type InboxKind = InboxPageRow['kinds'][number]

/** What the Inbox list is filtered by: the order, Unread only, Show
    snoozed, the kinds and the settled search text, '' for none. */
export type InboxFilters = {
  order: 'newest' | 'oldest'
  unreadOnly: boolean
  showSnoozed: boolean
  kinds: readonly InboxKind[]
  search: string
}

/** inbox.page's arguments for the page after `after` (null for the first)
    under `f`, in a fixed key order with empty fields left out: the kinds
    sorted and each once, the search only when it is not blank. It never
    sends `through`: the list reads the page on screen open and moves Next
    at its live `next`. */
export function inboxArgs(f: InboxFilters, after: string | null) {
  const search = f.search.trim()
  return {
    order: f.order,
    unread_only: f.unreadOnly,
    include_snoozed: f.showSnoozed,
    kinds: [...new Set(f.kinds)].sort(),
    ...(search === '' ? {} : { search }),
    ...(after === null ? {} : { after }),
  }
}

/** The page an answer holds, or null for one that holds nothing to show
    and cannot say the Inbox is empty, which the engine shows as `held`:
    no rows, no `next`, and a seat whose messages are being prepared or a
    group a check left out. A stopped answer with no rows and a `next`
    stays a page, which pageEnd ends with Next. The page is the engine's
    batch (lib/pagedList.ts ListBatch). */
export function inboxBatch(
  answer: InboxPageAnswer,
): { rows: readonly InboxPageRow[]; next: string | null; stopped: boolean } | null {
  if (
    answer.rows.length === 0 &&
    answer.next === null &&
    (answer.not_ready.length > 0 || answer.unchecked)
  )
    return null
  return { rows: answer.rows, next: answer.next, stopped: answer.stopped }
}

/** "A", "A and B", "A, B and C". */
function andList(parts: readonly string[]): string {
  if (parts.length < 2) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The note for the seats whose messages the page leaves out while they
    are prepared, naming each organization by `nameOf`, or null for none. */
export function notReadyLine(
  answer: Pick<InboxPageAnswer, 'not_ready'> | null,
  nameOf: (org: string) => string,
): string | null {
  if (answer === null || answer.not_ready.length === 0) return null
  return `Messages in ${andList(answer.not_ready.map(nameOf))} are still being prepared and are not listed yet.`
}

/** What an answer with no rows says, and whether Retry shows beside it
    (components/pageFold.tsx HeldLine). */
export type InboxHeldLine = { line: string; retry: boolean }

/** The sentences of a page's end (components/pageFold.tsx PageWords). */
export type InboxWords = {
  loading: string
  failed: string
  none: string
  empty: string
  nomore: string
  stopped: string
  stoppedEmpty: string
  stuck: string
}

/** The note for a group a check of the person's access left out. */
export const UNCHECKED_LINE = 'Some messages could not be checked and are not listed.'

/** What an answer with no rows says in place of the page (`held`), its
    notes as one line, with Retry, which reads the page again. */
export function heldLine(
  answer: Pick<InboxPageAnswer, 'not_ready' | 'unchecked'> | null,
  nameOf: (org: string) => string,
): InboxHeldLine {
  const lines = [notReadyLine(answer, nameOf), answer?.unchecked ? UNCHECKED_LINE : null].filter(
    (line): line is string => line !== null,
  )
  return { line: lines.join(' ') || "Couldn't load your messages.", retry: true }
}

/**
 * The sentences that end a page of the Inbox (PageFold), from the answer
 * on screen. A page the read budget stopped says how far back it looked,
 * or for Oldest first up to when, at `checked_to` written by `timeOf`, and
 * that Next looks further; one that cannot say how far, as when no group
 * it examined passed the kind filter and the access check, says it looked
 * through part of the Inbox. With a search it says it searched. A stopped
 * page with no rows says it has no match yet, or for a browse with no
 * filter, which never matches, nothing to list yet. `filtered` says a
 * search or a narrowing filter is on, which pageEnd answers `none` for;
 * `empty` is the sentence of an empty first page without one.
 */
export function inboxWords(
  answer: Pick<InboxPageAnswer, 'checked_to'> | null,
  o: {
    order: 'newest' | 'oldest'
    search: boolean
    filtered: boolean
    empty: string
    timeOf: (iso: string) => string
  },
): InboxWords {
  const checked = answer?.checked_to ?? null
  const further = 'Next looks further.'
  const blind = `Qivo looked through part of your Inbox. ${further}`
  const span =
    checked === null ? '' : `${o.order === 'newest' ? 'back to' : 'up to'} ${o.timeOf(checked)}`
  return {
    loading: 'Loading messages…',
    failed: "Couldn't load your messages.",
    none: 'No messages match the filters.',
    empty: o.empty,
    nomore: 'No more messages.',
    stopped:
      checked === null
        ? blind
        : `Qivo ${o.search ? 'searched' : 'looked through'} your messages ${span}. ${further}`,
    stoppedEmpty:
      checked === null
        ? blind
        : o.filtered
          ? `No matches yet in your messages ${span}. ${further}`
          : `Qivo looked through your messages ${span} and has nothing to list there. ${further}`,
    stuck: "Qivo couldn't look further through your Inbox.",
  }
}

/** The sentence of an empty first page with no search or narrowing
    filter: none yet, with `hint` when the person sees no project, unless
    Show snoozed is off and snoozed groups may exist (`snoozed`), which
    the page cannot list then, so it never calls the Inbox empty. */
export function emptyLine(o: { snoozed: boolean; hint: string | null }): string {
  if (o.snoozed) return 'No messages to show. Snoozed ones show with Show snoozed.'
  return o.hint ? `No messages yet. ${o.hint}` : 'No messages yet.'
}

/** Whether an answer of the first page read with Show snoozed on, while
    the list without it is empty, may hold a snoozed group: any row, a
    `next`, a stop, a seat being prepared or a group left out, since a
    page that cannot say none is never taken for none. */
export const maySnooze = (
  answer: Pick<InboxPageAnswer, 'rows' | 'next' | 'stopped' | 'not_ready' | 'unchecked'>,
): boolean =>
  answer.rows.length > 0 ||
  answer.next !== null ||
  answer.stopped ||
  answer.not_ready.length > 0 ||
  answer.unchecked
