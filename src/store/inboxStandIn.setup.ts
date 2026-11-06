/* A stand-in for the two inbox reads the app watches beside the workspace
   (convex/inbox.ts summary and item) that answers from a workspace the app
   holds, for the jsdom tests, whose live double answers both from the
   published whole (store/guard/liveDouble.setup.ts), and for the browser
   benchmark's server (scripts/perf/server.mjs), as
   store/projectNavStandIn.setup.ts answers the project picker.

   It folds the workspace's messages into items, one per seat and task, by
   the rule the server keeps its inbox_items rows to (convex/model/
   inboxItems.ts itemOf) and the app's groups follow (store/viewModels.ts
   shapeMessageGroup): the newest message by (created_at, id) is the item's
   latest and carries its snooze, and the unread count counts the unread
   messages.

   - The summary counts the unread items that are not snoozed, across the
     seats the workspace names, at most SUMMARY_MOST (100), with
     `unread_more` from there, and answers complete. Each seat's line holds
     its organization, ready, and the bulk actions' flags, true for an
     unsnoozed unread (read) message of the seat, or when the workspace's
     inbox part left unread (read) rows unexamined (unreadTruncated,
     readTruncated) or counts read rows it did not send (readMessageCount).
     The workspace sends messages about tasks the person is shown only, so
     the stand-in cannot see a message about a task the seat lost, which the
     server's flags count (src/store/inboxParity.test.ts names it).
   - The item answers the seat's item about one task with its counts, the
     oldest unread message's created_at, whether an unread message tells of
     a change (a change, or a mention in the description, as
     convex/model/inboxReads.ts tellsChange), the newest message and the
     item's snooze, and `through`, the newest message's _creationTime, or
     its created_at in ms where the row carries none, as the workspace's
     rows do not. A task with no message answers no item, and an
     organization the login holds no seat in the orgQuery's refusal.

   `force` makes them answer what a workspace cannot say: no answer at all
   (`loading`), a failure (`failed`), an incomplete count (`incomplete`), a
   count past 99 (`more`), a seat whose items are not complete
   (`notReady`), whose items then answer `building`, or a summary whose read
   budget stopped it before its last seat (`budget`), which it leaves out
   of `seats` and the count. It imports nothing the benchmark's worker
   cannot load. */

import { ConvexError } from 'convex/values'
import { newestFirst } from '../../convex/lib/inbox'
import { MENTION_DETAILS } from '../../convex/lib/messageDetails'
import type { Workspace } from '../../convex/lib/workspaceJoin'

/** The workspace sections the reads' rule reads. */
export type InboxWorkspace = Pick<
  Workspace,
  | 'myProfileIds'
  | 'profiles'
  | 'messages'
  | 'readMessageCount'
  | 'unreadTruncated'
  | 'readTruncated'
>

/** A state the stand-in answers whatever the workspace says. */
export type ForcedInbox = 'loading' | 'failed' | 'incomplete' | 'more' | 'notReady' | 'budget'

/** What a read answers when it never answers (`loading`): nothing is sent
    for it. */
export const INBOX_NO_ANSWER = Symbol('no inbox answer')

/** The most items the summary counts (convex/model/inboxReads.ts
    SUMMARY.most). */
export const SUMMARY_MOST = 100

type Message = Workspace['messages'][number] & { _creationTime?: number }

/** The summary as convex/inbox.ts summary answers it. */
export type SummaryAnswer = {
  seats: {
    org_id: string
    ready: boolean
    can_mark_all_read: boolean
    can_remove_read: boolean
  }[]
  unread_count: number
  unread_more: boolean
  complete: boolean
}

/** The item as convex/inbox.ts item answers it. */
export type ItemAnswer =
  | { state: 'building' }
  | {
      state: 'ok'
      item: {
        unread_count: number
        dropped: number
        first_unread_at: string | null
        unread_change: boolean
        latest_id: string
        latest_at: string
        snoozed_until: string | null
        through: number
      } | null
    }

/* The login's active seats, in organization id order, as the server reads
   ctx.myProfiles. */
function seatsOf(w: InboxWorkspace) {
  return w.profiles
    .filter((p) => w.myProfileIds.includes(p.id) && p.active !== false)
    .sort((a, b) => (a.org_id < b.org_id ? -1 : a.org_id > b.org_id ? 1 : 0))
}

/* The messages of `w` folded per seat and task, each list newest first. */
function itemsOf(w: InboxWorkspace): Map<string, Message[]> {
  const items = new Map<string, Message[]>()
  for (const m of w.messages as readonly Message[]) {
    const key = `${m.recipient_id}:${m.issue_id}`
    const list = items.get(key)
    if (list) list.push(m)
    else items.set(key, [m])
  }
  for (const list of items.values()) list.sort(newestFirst)
  return items
}

/* Whether `m` tells of a change the task window lists only under All. */
const tellsChange = (m: Message) =>
  m.kind === 'change' || (m.kind === 'mention' && m.detail === MENTION_DETAILS.description)

/** The unread summary of `w`'s seats (convex/inbox.ts summary), or
    INBOX_NO_ANSWER under `loading`. Throws under `failed`. */
export function inboxSummaryStandIn(
  w: InboxWorkspace,
  force?: ForcedInbox,
): SummaryAnswer | typeof INBOX_NO_ANSWER {
  if (force === 'loading') return INBOX_NO_ANSWER
  if (force === 'failed') throw new Error('the unread summary fails, as the test forces')
  const all = seatsOf(w)
  // the budget stops before the last seat, as the server leaves a seat it
  // did not reach out of `seats`
  const seats = force === 'budget' && all.length > 1 ? all.slice(0, -1) : all
  const items = itemsOf(w)
  const messages = w.messages as readonly Message[]
  const loadedRead = messages.filter((m) => m.read_at !== undefined && !m.snoozed_until).length
  const unreadLeft = w.unreadTruncated
  const readLeft = w.readTruncated || w.readMessageCount > loadedRead
  const lines = seats.map((seat, at) => {
    const mine = messages.filter((m) => m.recipient_id === seat.id && !m.snoozed_until)
    return {
      org_id: seat.org_id,
      // the first seat stands for one whose items are not complete
      ready: !(force === 'notReady' && at === 0),
      can_mark_all_read: unreadLeft || mine.some((m) => m.read_at === undefined),
      can_remove_read: readLeft || mine.some((m) => m.read_at !== undefined),
    }
  })
  const ready = new Set(lines.filter((line) => line.ready).map((line) => line.org_id))
  const counted = seats.filter((seat) => ready.has(seat.org_id)).map((seat) => seat.id)
  let count = 0
  for (const list of items.values()) {
    const latest = list[0]
    if (!counted.includes(latest.recipient_id) || latest.snoozed_until) continue
    if (list.some((m) => m.read_at === undefined)) count++
  }
  if (force === 'more') count = Math.max(count, SUMMARY_MOST)
  count = Math.min(count, SUMMARY_MOST)
  return {
    seats: lines,
    unread_count: count,
    unread_more: count >= SUMMARY_MOST,
    complete: force !== 'incomplete' && force !== 'notReady' && force !== 'budget',
  }
}

/** The seat's inbox item about task `args.issue_id` in organization
    `args.org_id` (convex/inbox.ts item), or INBOX_NO_ANSWER under
    `loading`. Throws under `failed`, and the orgQuery's refusal for an
    organization the login holds no seat in. */
export function inboxItemStandIn(
  w: InboxWorkspace,
  args: { org_id: string; issue_id: string },
  force?: ForcedInbox,
): ItemAnswer | typeof INBOX_NO_ANSWER {
  if (force === 'loading') return INBOX_NO_ANSWER
  if (force === 'failed') throw new Error('the inbox item fails, as the test forces')
  const seats = seatsOf(w)
  const seat = seats.find((s) => s.org_id === args.org_id)
  if (!seat)
    throw new ConvexError({ code: 'forbidden', message: 'no profile in this organization' })
  if (force === 'notReady' && seats[0] === seat) return { state: 'building' }
  const list = itemsOf(w).get(`${seat.id}:${args.issue_id}`)
  if (!list) return { state: 'ok', item: null }
  const latest = list[0]
  const unread = list.filter((m) => m.read_at === undefined)
  const oldest = unread.at(-1)
  return {
    state: 'ok',
    item: {
      unread_count: unread.length,
      dropped: unread.reduce((n, m) => n + (m.dropped ?? 0), 0),
      first_unread_at: oldest ? oldest.created_at : null,
      unread_change: unread.some(tellsChange),
      latest_id: latest.id,
      latest_at: latest.created_at,
      snoozed_until: latest.snoozed_until ?? null,
      through: Math.max(...list.map((m) => m._creationTime ?? Date.parse(m.created_at))),
    },
  }
}
