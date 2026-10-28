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
    batches confirmed and the refusal's sentence. */
export type BulkStop = Readonly<{ org: string; done: number; reason: string }>

/** A bulk Inbox action (P.inboxBulk). It lives in the store, not in the
    Inbox, so leaving the Inbox, or the kept Inbox being let go, loses
    nothing. */
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
  },
  remove: {
    name: 'Remove all read',
    running: 'Removing read notifications',
    row: ['read notification', 'read notifications'],
    rest: 'The rest stay in the Inbox.',
    none: 'before it removed any notification. They stay in the Inbox.',
  },
} as const

/* `n` rows of `action`, as "1 message" or "512 messages". */
const rows = (action: BulkAction, n: number) =>
  `${n.toLocaleString('en-US')} ${WORDS[action].row[n === 1 ? 0 : 1]}`

/** The action's name, as its button says it. */
export const bulkName = (action: BulkAction) => WORDS[action].name

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

/** The sticky toast of a seat a refusal stopped, in organization `orgName`:
    what was done there, what was not, then the refusal's sentence. */
export function bulkStopText(action: BulkAction, stop: BulkStop, orgName: string): string {
  const words = WORDS[action]
  const what =
    stop.done === 0
      ? `${words.name} stopped in ${orgName} ${words.none}`
      : `${words.name} stopped after ${rows(action, stop.done)} in ${orgName}. ${words.rest}`
  return `${what} ${stop.reason}`
}
