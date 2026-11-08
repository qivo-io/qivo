/* A stand-in for the three inbox reads the app watches (convex/inbox.ts
   summary, item and page) that answers from a workspace the app holds, for
   the jsdom tests, whose live double answers them from the published whole
   (store/guard/liveDouble.setup.ts), and for the browser benchmark's
   server (scripts/perf/server.mjs), as store/projectNavStandIn.setup.ts
   answers the project picker.

   It folds the workspace's messages into items, one per seat and task, by
   the rule the server keeps its inbox_items rows to (convex/model/
   inboxItems.ts itemOf): the newest message by (created_at, id) is the
   item's latest and carries its snooze, the unread count counts the unread
   messages, the dropped count adds up the unread ones', and the list time
   is the newest message's created_at or a later wake.

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
   - The page (inboxPageStandIn) lists the items of every seat whose task
     the workspace holds in the seat's organization, each with its task's
     number and live title, its project and the project above it, and its
     newest message's actor named by the seat's own organization's
     profiles, in list time order, then task id, then the seat, newest or
     oldest first, with Unread only, Show snoozed, the kind filter and the
     search (convex/lib/inbox.ts inboxSearchText) applied before it cuts
     INBOX_PAGE_ROWS rows, as convex/model/inboxPage.ts readInboxPage does.
     Its cursor is its own text, which it refuses with the server's
     bad_request and NOT_INBOX_CURSOR for another order, filters or
     search. It reads no budget unless a test lowers INBOX_STAND_IN.examine,
     the items one page examines, past which the page stops, says how far
     it looked (`checked_to`) and goes on from `next`, as the server's read
     budget stops a page. A task the workspace does not hold leaves its
     item out, as the server leaves out a task the seat is not shown.

   `force` makes them answer what a workspace cannot say: no answer at all
   (`loading`), a failure (`failed`), an incomplete count (`incomplete`), a
   count past 99 (`more`), a seat whose items are not complete
   (`notReady`), whose items then answer `building` and whose rows the page
   leaves out and names in `not_ready`, or a summary whose read budget
   stopped it before its last seat (`budget`), which it leaves out of
   `seats` and the count. For the page alone: a page stopped after
   STOPPED_AFTER items (`stopped`), the same with `checked_to` null
   (`blind`), as when no item it examined passed the kind filter and the
   access check, the first shown group left out by a check that could not
   finish (`unchecked`), every cursor refused (`badCursor`), and a page
   after the first that stopped without moving past its start (`stuck`),
   which the server's `next` never does, for the list's fail-safe. The
   summary and the item ignore those. It imports nothing the benchmark's
   worker cannot load. */

import { ConvexError } from 'convex/values'
import {
  inboxSearchText,
  itemKinds,
  type KindCounts,
  kindsMatch,
  messageLine,
  newestFirst,
} from '../../convex/lib/inbox'
import { INBOX_PAGE_ROWS, LIMITS } from '../../convex/lib/limits'
import { MENTION_DETAILS } from '../../convex/lib/messageDetails'
import { allWordsMatcher } from '../../convex/lib/search'
import { issueKey } from '../../convex/lib/taskRefs'
import type { Whole } from './guard/liveDouble.setup'

/** The workspace sections the reads' rule reads. The page reads `issues`
    and `projects` too, which a caller that answers only the summary and
    the item may leave out. */
export type InboxWorkspace = Pick<
  Whole,
  | 'myProfileIds'
  | 'profiles'
  | 'messages'
  | 'readMessageCount'
  | 'unreadTruncated'
  | 'readTruncated'
> &
  Partial<Pick<Whole, 'issues' | 'projects'>>

/** A state the stand-in answers whatever the workspace says. */
export type ForcedInbox =
  | 'loading'
  | 'failed'
  | 'incomplete'
  | 'more'
  | 'notReady'
  | 'budget'
  | 'stopped'
  | 'blind'
  | 'unchecked'
  | 'badCursor'
  | 'stuck'

/** What a read answers when it never answers (`loading`): nothing is sent
    for it. */
export const INBOX_NO_ANSWER = Symbol('no inbox answer')

/** The most items the summary counts (convex/model/inboxReads.ts
    SUMMARY.most). */
export const SUMMARY_MOST = 100

type Message = Whole['messages'][number] & { _creationTime?: number }

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

/* ------------------------------------------------------------- the page */

/** The bounds of the page's stand-in, which tests lower and set back:
    `examine`, the items one page examines before it stops, as the server's
    read budget stops a page (convex/model/inboxPage.ts INBOX_PAGE.reads),
    none by default. */
export const INBOX_STAND_IN = { examine: Number.POSITIVE_INFINITY }

/** The items a page forced `stopped` or `blind` examines. */
export const STOPPED_AFTER = 10

/** The server's refusal of a cursor of another list
    (convex/model/inboxPage.ts NOT_INBOX_CURSOR), which
    src/store/inboxParity.test.ts holds this copy to. */
export const NOT_INBOX_CURSOR =
  'after and through must be cursors from an earlier Inbox page with the same order, filters and search; start again from the first page'

/** What inbox.page is asked (convex/model/inboxPage.ts InboxPageArgs). */
export type PageArgs = {
  order: 'newest' | 'oldest'
  unread_only: boolean
  include_snoozed: boolean
  kinds: readonly Message['kind'][]
  search?: string
  after?: string
  through?: string
}

/** A project as a page row names it. */
type Place = { id: string; num: number; name: string }

/** One row of a page (convex/model/inboxPage.ts InboxRow). */
export type PageRow = {
  org_id: string
  issue_id: string
  num: number
  title: string
  project: Place
  parent: Place | null
  sort_at: string
  latest_at: string
  woke_at: string | null
  latest: {
    id: string
    kind: Message['kind']
    detail: string
    actor_id: string | null
    actor_name: string | null
  }
  unread_count: number
  dropped: number
  count: number
  kinds: Message['kind'][]
  snoozed_until: string | null
  first_unread_at: string | null
  unread_change: boolean
  through: number
}

/** What inbox.page answers (convex/model/inboxPage.ts InboxPage). */
export type PageAnswer = {
  rows: PageRow[]
  next: string | null
  stopped: boolean
  checked_to: string | null
  not_ready: string[]
  unchecked: boolean
}

/* A page position: the list time, the task id and the seat. */
type Position = [sort_at: string, issue_id: string, recipient_id: string]

/* -1, 0 or 1 as `a` comes before, with or after `b` in ascending order. */
function compare(a: Position, b: Position): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

const CURSOR = 'inbox-stand-in:'

/* The cursor text of `at` in the list `scope` names. */
const cursorOf = (scope: string, at: Position) => `${CURSOR}${JSON.stringify({ scope, at })}`

/* The position cursor `text` names in the list `scope`, or the server's
   refusal of any other text. */
function openCursor(text: string, scope: string): Position {
  const refused = new ConvexError({ code: 'bad_request', message: NOT_INBOX_CURSOR })
  let parsed: { scope?: unknown; at?: unknown } = {}
  try {
    if (text.startsWith(CURSOR)) parsed = JSON.parse(text.slice(CURSOR.length))
  } catch {
    throw refused
  }
  const at = parsed.at
  if (
    parsed.scope !== scope ||
    !Array.isArray(at) ||
    at.length !== 3 ||
    !at.every((part) => typeof part === 'string')
  )
    throw refused
  return at as Position
}

/* One seat's item about one task: its messages newest first, its newest
   one, its unread ones, its list time and its page position. */
type Item = {
  seat: Whole['profiles'][number]
  messages: Message[]
  latest: Message
  unread: Message[]
  sortAt: string
  wokeAt: string | null
  at: Position
}

/* The items of the seats `seats` in `w`, one per seat and task. */
function seatItems(w: InboxWorkspace, seats: readonly Whole['profiles'][number][]): Item[] {
  const bySeat = new Map(seats.map((seat) => [seat.id, seat]))
  const out: Item[] = []
  for (const list of itemsOf(w).values()) {
    const latest = list[0]
    const seat = bySeat.get(latest.recipient_id)
    if (!seat) continue
    let wokeAt: string | null = null
    for (const m of list)
      if (m.woke_at !== undefined && (wokeAt === null || m.woke_at > wokeAt)) wokeAt = m.woke_at
    const sortAt = wokeAt !== null && wokeAt > latest.created_at ? wokeAt : latest.created_at
    out.push({
      seat,
      messages: list,
      latest,
      unread: list.filter((m) => m.read_at === undefined),
      sortAt,
      wokeAt,
      at: [sortAt, latest.issue_id, seat.id],
    })
  }
  return out
}

/* What an item counts of each kind of message. */
function countsOf(item: Item): KindCounts {
  const counts = { mentions: 0, changes: 0, comments: 0 }
  for (const m of item.messages) {
    if (m.kind === 'mention') counts.mentions++
    else if (m.kind === 'change') counts.changes++
    else counts.comments++
  }
  return counts
}

/**
 * The page of `w`'s Inbox that `args` asks for (convex/inbox.ts page), or
 * INBOX_NO_ANSWER under `loading`, on the rule in the file comment. Throws
 * under `failed`, the server's refusals of a kind named twice, a search
 * past LIMITS.search and a cursor of another list, and a refusal of every
 * cursor under `badCursor`.
 */
export function inboxPageStandIn(
  w: InboxWorkspace,
  args: PageArgs,
  force?: ForcedInbox,
): PageAnswer | typeof INBOX_NO_ANSWER {
  if (force === 'loading') return INBOX_NO_ANSWER
  if (force === 'failed') throw new Error('the Inbox page fails, as the test forces')
  if (new Set(args.kinds).size !== args.kinds.length)
    throw new ConvexError({
      code: 'bad_request',
      message: 'kinds must name each message kind at most once',
    })
  const search = (args.search ?? '').trim()
  if (search.length > LIMITS.search.max)
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const kinds = [...args.kinds].sort()
  const scope = JSON.stringify([args.order, args.unread_only, args.include_snoozed, kinds, search])
  if (force === 'badCursor' && (args.after !== undefined || args.through !== undefined))
    throw new ConvexError({ code: 'bad_request', message: NOT_INBOX_CURSOR })
  const after = args.after === undefined ? null : openCursor(args.after, scope)
  if (args.through !== undefined) openCursor(args.through, scope)
  if (force === 'stuck' && args.after !== undefined)
    return {
      rows: [],
      next: args.after,
      stopped: true,
      checked_to: null,
      not_ready: [],
      unchecked: false,
    }
  const desc = args.order === 'newest'
  // the seats, the first one left out and named when it is not ready
  const seats = seatsOf(w)
  const notReady = force === 'notReady' && seats.length > 0 ? [seats[0]] : []
  const tasks = new Map((w.issues ?? []).map((task) => [`${task.org_id}:${task.id}`, task]))
  const projects = new Map((w.projects ?? []).map((p) => [`${p.org_id}:${p.id}`, p]))
  const nameOf = (orgId: string, actorId: string | undefined) =>
    actorId === undefined
      ? null
      : (w.profiles.find((p) => p.id === actorId && p.org_id === orgId)?.name ?? null)
  // the items of the index ranges the page reads, in its order, after `after`
  const walk = seatItems(
    w,
    seats.filter((seat) => !notReady.includes(seat)),
  )
    .filter((item) => !args.unread_only || item.unread.length > 0)
    .filter((item) => args.include_snoozed || item.latest.snoozed_until === undefined)
    .sort((a, b) => (desc ? compare(b.at, a.at) : compare(a.at, b.at)))
    .filter(
      (item) =>
        after === null || (desc ? compare(item.at, after) < 0 : compare(item.at, after) > 0),
    )
  const budget =
    force === 'stopped' || force === 'blind'
      ? Math.min(STOPPED_AFTER, INBOX_STAND_IN.examine)
      : INBOX_STAND_IN.examine
  const matcher = search === '' ? null : allWordsMatcher(search)
  const rows: PageRow[] = []
  let checkedTo: string | null = null
  let unchecked = false

  /* The answer with `next` at `last`, null at the list's end. */
  const answer = (last: Position | null, stopped: boolean): PageAnswer => ({
    rows,
    next: last === null ? null : cursorOf(scope, last),
    stopped,
    checked_to: force === 'blind' ? null : checkedTo,
    not_ready: notReady.map((seat) => seat.org_id),
    unchecked,
  })

  /* The row of `item`, or null for one the page leaves out: a kind the
     filter leaves out, a task the workspace does not hold, the group a
     forced unchecked check leaves out, and a search miss. */
  const rowOf = (item: Item): PageRow | null => {
    const counts = countsOf(item)
    if (!kindsMatch(counts, kinds)) return null
    const orgId = item.seat.org_id
    const task = tasks.get(`${orgId}:${item.latest.issue_id}`)
    const project = task && projects.get(`${orgId}:${task.project_id}`)
    if (!task || !project) return null
    if (force === 'unchecked' && !unchecked) {
      unchecked = true
      return null
    }
    checkedTo = item.sortAt
    const parent = project.parent_id ? projects.get(`${orgId}:${project.parent_id}`) : undefined
    const latest = item.latest
    const actorName = nameOf(orgId, latest.actor_id)
    if (
      matcher !== null &&
      !matcher(
        inboxSearchText({
          title: task.title,
          key: issueKey(task.num),
          line: messageLine(latest, actorName),
          places: [parent?.name, project.name],
          messages: item.messages.map((m) => ({
            actor_name: nameOf(orgId, m.actor_id),
            detail: m.detail,
          })),
        }),
      )
    )
      return null
    const place = (p: { id: string; num: number; name: string }): Place => ({
      id: p.id,
      num: p.num,
      name: p.name,
    })
    return {
      org_id: orgId,
      issue_id: task.id,
      num: task.num,
      title: task.title,
      project: place(project),
      parent: parent ? place(parent) : null,
      sort_at: item.sortAt,
      latest_at: latest.created_at,
      woke_at: item.wokeAt,
      latest: {
        id: latest.id,
        kind: latest.kind,
        detail: latest.detail,
        actor_id: latest.actor_id ?? null,
        actor_name: actorName,
      },
      unread_count: item.unread.length,
      dropped: item.unread.reduce((n, m) => n + (m.dropped ?? 0), 0),
      count: item.messages.length,
      kinds: itemKinds(counts),
      snoozed_until: latest.snoozed_until ?? null,
      first_unread_at: item.unread.at(-1)?.created_at ?? null,
      unread_change: item.unread.some(tellsChange),
      through: Math.max(...item.messages.map((m) => m._creationTime ?? Date.parse(m.created_at))),
    }
  }

  let last: Position | null = null
  for (const [index, item] of walk.entries()) {
    // a full page reads one item more, so a page that ends with the list
    // says so
    if (rows.length >= INBOX_PAGE_ROWS) return answer(last, false)
    last = item.at
    const row = rowOf(item)
    if (row !== null) rows.push(row)
    // the budget ends the page after the item that spent it, which is
    // never the list's end
    if (index + 1 >= budget) return answer(last, rows.length < INBOX_PAGE_ROWS)
  }
  return answer(null, false)
}
