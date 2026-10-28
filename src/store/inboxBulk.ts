/* A bulk Inbox action, Mark all as read or Remove all read, as the store
   runs it (planner.ts bulkInboxAction): its state, which the Inbox shows,
   and the sentences of its progress line and its toasts. */

import type { FunctionArgs } from 'convex/server'
import type { api } from '../../convex/_generated/api'

/** Mark all as read (`read`) or Remove all read (`remove`). */
export type BulkAction = FunctionArgs<typeof api.messages.bulkReach>['action']

/** The most seats a bulk Inbox action sends batches to at once. Each seat's
    batches go one after another, so the action has at most this many
    writes in flight however many organizations the person belongs to. */
export const BULK_SEATS = 2

/** A seat a refusal stopped: its organization's id, the rows its accepted
    batches confirmed, the refusal's sentence, and whether the refusal was
    the pause (offline, a slow save, a lost seat or sign-in), which stops
    every seat at once. */
export type BulkStop = Readonly<{ org: string; done: number; reason: string; paused: boolean }>

/** Why an action needs the keep-open notice: a seat has more than one
    batch to do (`many`), or more seats have work than run at once
    (`seats`). */
export type BulkWhy = 'many' | 'seats'

/** A bulk Inbox action (P.inboxBulk). It lives in the store, not in the
    Inbox, so leaving the Inbox loses nothing once the action runs. A press
    still waiting for its notice ends when no Inbox shows it
    (P.hostInboxNotice). */
export type InboxBulk = Readonly<{
  action: BulkAction
  /** `asking` waits for messages.bulkReach, `notice` for the person's answer
      to the keep-open notice (P.answerInboxNotice). `finished` says every
      seat with work answered that nothing is left; `stopped` that a refusal
      stopped at least one seat, after the others finished. */
  state: 'asking' | 'notice' | 'running' | 'finished' | 'stopped'
  /** Whether the action takes more than one round: it needed the notice, or
      a batch answered that more was left. Only such an action shows its
      progress and ends with a toast. */
  long: boolean
  /** Why the plan needed the notice, or null for an action of one round. */
  why: BulkWhy | null
  /** Rows the server confirmed, the sum of the answers' marked or removed. */
  done: number
  /** The seats with work, and how many of them answered that nothing is
      left. */
  seats: number
  seatsDone: number
  stops: readonly BulkStop[]
}>

/** Whether `bulk` still goes on, so neither action may start. */
export const bulkBusy = (bulk: InboxBulk | null): boolean =>
  bulk !== null && (bulk.state === 'asking' || bulk.state === 'notice' || bulk.state === 'running')

/* What each action's sentences call it and its rows. */
const WORDS = {
  read: {
    name: 'Mark all as read',
    running: 'Marking messages read',
    row: ['message', 'messages'],
    rest: 'The rest stay unread.',
    none: 'before it marked any message. They stay unread.',
    covers: 'messages',
  },
  remove: {
    name: 'Remove all read notifications',
    running: 'Removing read notifications',
    row: ['read notification', 'read notifications'],
    rest: 'The rest stay in the Inbox.',
    none: 'before it removed any notification. They stay in the Inbox.',
    covers: 'read notifications',
  },
} as const

/* `n` rows of `action`, as "1 message" or "512 messages". */
const rows = (action: BulkAction, n: number) =>
  `${n.toLocaleString('en-US')} ${WORDS[action].row[n === 1 ? 0 : 1]}`

/** The action's name, as its toolbar button and menu item say it. */
export const bulkName = (action: BulkAction) => WORDS[action].name

/** What the keep-open notice says about `bulk`, for the reason it needs
    more than one round (InboxBulk.why). */
export function bulkNoticeText(bulk: InboxBulk): string {
  const { name, covers } = WORDS[bulk.action]
  const why =
    bulk.why === 'seats'
      ? `${name} covers ${covers} in ${bulk.seats} organizations and runs in steps.`
      : `${name} covers many ${covers} and runs in steps.`
  return `${why} Keep Qivo open until it finishes. Closing or reloading Qivo stops it, and the steps already done stay done.`
}

/** The Inbox's progress line while `bulk` runs, such as "Marking messages
    read, 512 done, 1 of 2 organizations finished". */
export function bulkProgressText(bulk: InboxBulk): string {
  const line = `${WORDS[bulk.action].running}, ${bulk.done.toLocaleString('en-US')} done`
  return bulk.seats > 1
    ? `${line}, ${bulk.seatsDone} of ${bulk.seats} organizations finished`
    : line
}

/** The toast of a long action that finished, such as "Marked 812 messages
    as read." */
export const bulkDoneText = (bulk: InboxBulk): string =>
  bulk.action === 'read'
    ? `Marked ${rows('read', bulk.done)} as read.`
    : `Removed ${rows('remove', bulk.done)}.`

/** The toast of a press that could not learn how much `action` has to do
    (messages.bulkReach failed or did not answer in time), so it changed
    nothing. */
export function bulkUncheckedText(action: BulkAction): string {
  const { name, covers } = WORDS[action]
  return `Couldn't check how many ${covers} ${name} covers, so nothing changed. Try again.`
}

/* "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** The sticky toast of the seats one refusal stopped, each with its
    organization's name and the rows done there: what was done, what was
    not, then the refusal's sentence. A refusal of one organization names
    it; the pause, which stops every seat, names those where something was
    done. */
export function bulkStopText(
  action: BulkAction,
  parts: readonly { orgName: string; done: number }[],
  reason: string,
): string {
  const words = WORDS[action]
  const did = parts.filter((part) => part.done > 0)
  const what =
    did.length === 0
      ? `${words.name} stopped${parts.length === 1 ? ` in ${parts[0].orgName}` : ''} ${words.none}`
      : `${words.name} stopped after ${listed(did.map((part) => `${rows(action, part.done)} in ${part.orgName}`))}. ${words.rest}`
  return `${what} ${reason}`
}
