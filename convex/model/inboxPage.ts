/* The Inbox as pages of task groups (inbox.page): one row a group, a
 * person's messages about one task, read from its inbox_items row
 * (schema.ts) across every seat of the login, with the order, Unread only,
 * Show snoozed, the kind filter and the search applied before the page is
 * cut, so a page holds up to INBOX_PAGE.rows groups whatever the filters
 * leave out. No app, REST or MCP caller reads it yet. The app lists the
 * workspace inbox part (lib/workspaceParts.ts readInbox) until a later
 * release switches its list to these pages, and REST and MCP are to page
 * with inboxWalk under their own cursors.
 *
 * Who sees what. Each seat reads only its own items (recipient_id), and a
 * group shows only when its task is in the seat's working set, the rule of
 * inbox.summary, inbox.item and the workspace inbox part (lib/access.ts
 * accessOf holds), the task read and checked by its own project. An item's
 * project_id is only a hint. A project the seat cannot hold items in lets
 * the walk skip the item without reading its task, and never shows one. So
 * an item whose task a move of more than model/inboxItems.ts REKEY.inline
 * rows took from a hidden project into a visible one shows once its re-key
 * step runs, seconds later, as the summary counts it. The project above a
 * sub-project is named without asking whether the seat sees it, as the
 * seat sees its sub-project, which shows the parent for navigation while
 * the reach rows are whole (lib/access.ts). Actors are named only by the
 * seat's own organization's profiles, whose roster every seat holds.
 *
 * The order. A page reads each ready seat's items in list time order
 * (sort_at, the newest message's time or a later wake), newest or oldest
 * first, from inbox_items.by_recipient_list, or by_recipient_unread_list
 * for Unread only, one stream for the unsnoozed range and, with Show
 * snoozed, one for the snoozed range, merged by lib/namedPages.ts in the
 * page's direction. A position is the list time, then the task id, then
 * the seat's profile id, which no two items share even where two
 * organizations hold one task id. Equal list times come in task id order,
 * descending newest first, the index's order, where the app sorted by id
 * ascending and reversed the list for Oldest first. A position is a value,
 * so the page is live. An item that gets a new message between pages moves,
 * newest first before the cursor and so onto an earlier page, oldest first
 * past it and so onto a later page again, and never shows twice on one
 * page. A page kept live beside the pages after it takes its own `next` as
 * `through` and then holds every group after its `after` up to and
 * including that position, so a group that moves or leaves changes only
 * the pages it moves between, and the loaded pages together hold every
 * group once, as the app's other live lists do (lib/namedPages.ts
 * listBatch). Such a page holds at most four times INBOX_PAGE.rows rows
 * and stops there as if the read budget stopped it, and the list splits
 * it.
 *
 * What the answer says. `stopped` is a page the read budget ended before it
 * held INBOX_PAGE.rows rows or reached `through`, whose rows are every
 * match up to `next`, possibly none; `next` then always moves forward.
 * `checked_to` is the list time of the last group the page examined whose
 * task the caller is shown, matched or not, so the list can say how far a
 * stopped search looked. The kind filter applies before the access check,
 * without a read, so a page the kind filter fills with misses can stop
 * with `checked_to` null, and the list then says it searched part of the
 * Inbox. `not_ready` names the seats whose items are not complete
 * (model/inboxItems.ts seatReady), which the page leaves out, and
 * `unchecked` says a check of the caller's access that a bound stopped
 * (lib/access.ts accessUnchecked, roomSpent included) left a group out.
 * Only a page with no rows, `next` null, no seat in `not_ready` and
 * `unchecked` false says that nothing matches, and on a page after the
 * first only that nothing more does.
 *
 * What a stop can tell. The page reads every item of a seat's range up to
 * where it ends, those about tasks the caller is not shown included, and
 * the task row of each whose project hint passes, such as an archived task
 * of a visible project or one a move took into a hidden project before its
 * re-key. So where a page stops can reflect how many such items the caller
 * holds, and whether those tasks' rows exist and how large they are. They
 * are the caller's own messages, received while they could see the task
 * (model/messages.ts postMessage), and the bulk actions reach them too.
 * The page reads no other person's item, and `checked_to` never names the
 * time of an item the caller is not shown. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { isAccessUnchecked } from '../lib/access'
import type { ReadCeiling } from '../lib/archivedTasks'
import { byId } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { badRequest } from '../lib/functions'
import { inboxSearchText, itemKinds, kindsMatch, messageLine } from '../lib/inbox'
import { limitedText } from '../lib/limitRules'
import { INBOX_PAGE_ROWS, LIMITS } from '../lib/limits'
import { filtersKey } from '../lib/listCursor'
import {
  compareIn,
  indexAfter,
  mergeNamed,
  NAMED_READ,
  type NamedAt,
  type NamedBatch,
  type NamedIndex,
  type NamedOrder,
  namedCeiling,
  namedCursor,
  openNamedCursor,
  type ReadGuard,
  readBatch,
} from '../lib/namedPages'
import { allWordsMatcher } from '../lib/search'
import { issueKey } from '../lib/taskRefs'
import { seatReady } from './inboxItems'
import { inboxScope, unreadChange } from './inboxReads'

/**
 * The bounds of one Inbox page, which tests lower and set back with
 * structuredClone. `rows`: the groups a page holds, the owner's 50
 * (lib/limits.ts INBOX_PAGE_ROWS, the registry's inboxPage).
 * `reads`: what one call may read, NAMED_READ's share (2,000 index ranges,
 * 8,000 documents and 4 MiB) for a subscription list that runs again on
 * every change of what it read, which lib/namedPages.ts namedCeiling also
 * keeps NAMED_RESERVE under the request's limits.
 *
 * The design size names no Inbox figure, so the cases raise one task
 * figure with a group on each of its tasks, open and Done tasks not yet
 * archived at their sum since one page reads both, or the item cap alone,
 * and assume an everyday Inbox of 60 groups over 3 sub-projects, a little
 * over one page. What one call reads, measured in
 * convex/tests/inboxPage.test.ts ("reads at the design size") in index
 * ranges and documents as Convex counts them, with the default bounds, for
 * a reader in 3 teams:
 * - the everyday Inbox: a browse 227 ranges and 237 documents for 50 rows;
 *   a search that matches nothing 207 ranges and 259 documents, one page;
 * - one sub-project's 450 groups, 300 of open tasks and 150 of Done ones:
 *   261 ranges and 258 documents newest first or Unread only, 271 and 268
 *   oldest first, with 50 actors on the page; a kind whose 10 matches are
 *   the oldest, 71 ranges and 507 documents, one page; a search that
 *   matches nothing or only the oldest group, 1,413 ranges and 1,858
 *   documents, one page;
 * - one project's 1,000 groups over 3 sub-projects, 800 of open tasks and
 *   200 of Done ones: the browse as above; a kind whose 10 matches are the
 *   oldest, 77 ranges and 1,059 documents; a search that matches nothing,
 *   2 pages, the first stopped at 2,002 ranges and 2,639 documents, the
 *   second 1,133 ranges and 1,479 documents;
 * - one project's 200 read groups of Done tasks: 118 ranges and 161
 *   documents;
 * - 6,000 groups over the 200 sub-projects one person can read (on
 *   demand, QIVO_INBOX_PERSON_READS=1): a browse 374 ranges and 345
 *   documents; Mentions whose 60 matches are the oldest, 50 rows on the
 *   first page with 429 ranges, 6,331 documents and 2.7 MB, as it passes
 *   every item row, and 10 on the second; a search that matches nothing,
 *   12 pages of about 500 groups, each stopped at about 2,000 ranges and
 *   2,500 documents;
 * - 800 groups of a project the reader no longer sees, newer than every
 *   visible one: 229 ranges and 1,014 documents for 50 rows, each hidden
 *   group one item row;
 * - a person in 5 teams with the everyday Inbox: 217 ranges and 210
 *   documents;
 * - 50 groups at the item cap, 51 messages each: a browse 212 ranges and
 *   258 documents; a search that matches only each group's oldest message,
 *   262 ranges, 2,808 documents and 1.3 MB; every unread message a mention
 *   in a comment, which unreadChange walks, 262 ranges and 2,758
 *   documents;
 * - a group of an archived task in a visible project costs one range and
 *   two documents, so a page passes about 2,000 of them, half a page for
 *   each 1,000 such groups. One sub-project's 3,000 such groups take about
 *   2 pages and one project's 10,000 about 5.
 * A page answers at most 50 rows in about 42 KB, and a page kept live with
 * `through` at most 200, under the same read budget. Every case answers
 * whole except the searches that say stopped above, which go on from
 * `next`.
 */
export const INBOX_PAGE: { rows: number; reads: ReadCeiling } = {
  rows: INBOX_PAGE_ROWS,
  reads: { ...NAMED_READ },
}

/** The list name the Inbox page seals its cursors with. REST and MCP name
 * their own (lib/listCursor.ts). */
export const INBOX_LIST = 'inbox.page'

/** The refusal of an `after` or `through` that is not a `next` of this
 * list. */
export const NOT_INBOX_CURSOR =
  'after and through must be cursors from an earlier Inbox page with the same order, filters and search; start again from the first page'

/* ------------------------------------------------------------- the order */

/** A page position's tie: the task id, then the seat's profile id. */
export type InboxTie = readonly [issue_id: string, recipient_id: string]

/* A range of one seat's items in one snoozed range: every item, the item
 * of one task at one list time, the items at one list time past one task,
 * or every list time past one, in the walk's direction. */
type Bound =
  | { at: 'all' }
  | { at: 'issue'; key: string; issue: string }
  | { at: 'rest'; key: string; issue: string }
  | { at: 'later'; key: string }

/** The items of seat `recipientId` in the snoozed range `snoozed` as a list
 * in `order` (lib/namedPages.ts NamedIndex), every one or with Unread only
 * the unread ones, positioned by list time, task id and the seat. After a
 * position it reads the item of the position's task at its time when this
 * seat comes after the position's seat (two organizations can hold one
 * task id), the rest of its time past its task, then every later time. */
export function itemIndex(
  ctx: QueryCtx,
  recipientId: string,
  a: { snoozed: boolean; unread_only: boolean; order: NamedOrder },
): NamedIndex<Doc<'inbox_items'>, InboxTie> {
  const asc = a.order === 'asc'
  const range = (b: Bound) => {
    const items = ctx.db.query('inbox_items')
    const q = a.unread_only
      ? items.withIndex('by_recipient_unread_list', (r) => {
          const s = r.eq('recipient_id', recipientId).eq('snoozed', a.snoozed).eq('unread', true)
          if (b.at === 'all') return s
          if (b.at === 'later') return asc ? s.gt('sort_at', b.key) : s.lt('sort_at', b.key)
          const t = s.eq('sort_at', b.key)
          if (b.at === 'issue') return t.eq('issue_id', b.issue)
          return asc ? t.gt('issue_id', b.issue) : t.lt('issue_id', b.issue)
        })
      : items.withIndex('by_recipient_list', (r) => {
          const s = r.eq('recipient_id', recipientId).eq('snoozed', a.snoozed)
          if (b.at === 'all') return s
          if (b.at === 'later') return asc ? s.gt('sort_at', b.key) : s.lt('sort_at', b.key)
          const t = s.eq('sort_at', b.key)
          if (b.at === 'issue') return t.eq('issue_id', b.issue)
          return asc ? t.gt('issue_id', b.issue) : t.lt('issue_id', b.issue)
        })
    return q.order(a.order)
  }
  return {
    all: () => range({ at: 'all' }),
    after: (at) => {
      const { key } = at
      const [issue] = at.tie
      const mine = compareIn(a.order, { key, tie: [issue, recipientId] }, at) > 0
      return [
        ...(mine ? [() => range({ at: 'issue', key, issue })] : []),
        () => range({ at: 'rest', key, issue }),
        () => range({ at: 'later', key }),
      ]
    },
    at: (item) => ({ key: item.sort_at, tie: [item.issue_id, item.recipient_id] }),
  }
}

/* ------------------------------------------------------------ the walk */

/** What a walk of the Inbox is asked, its arguments checked. */
export type InboxAsk = {
  /** desc for newest first, asc for oldest first */
  order: NamedOrder
  unread_only: boolean
  include_snoozed: boolean
  /** the kinds a group must hold one of, empty for every kind */
  kinds: readonly MessageKind[]
  /** the trimmed search, '' for none */
  search: string
}

/** A group the walk keeps, with what it read to judge it, which the caller
 * builds its row from. */
export type InboxGroup = {
  seat: Doc<'profiles'>
  item: Doc<'inbox_items'>
  task: Doc<'issues'>
  /** the task's project */
  project: Doc<'projects'>
  /** the project above a sub-project, null for a top-level one */
  parent: Doc<'projects'> | null
  /** the newest message by (created_at, id), the item's latest_id */
  latest: Doc<'messages'>
  /** the newest message's actor's name, null where the seat's organization
   * has no profile of that id (a machine caller or a removed profile) */
  actor_name: string | null
  /** the item's newest message's _creationTime, the cutoff readItem and
   * removeItem take (model/messages.ts itemMessages) */
  through: number
  /** the name of another actor of the seat's organization, read once a
   * page and counted, null as for actor_name */
  nameOf: (actorId: string | undefined) => Promise<string | null>
}

/** One walk of the Inbox (inboxWalk): the batch, and what it says about
 * the groups it could not judge or reach. */
export type InboxWalk<Out> = NamedBatch<Out> & {
  /** the list time of the last examined group whose task the caller is
   * shown, null when the walk examined none */
  checked_to: string | null
  /** the organizations of the seats whose items are not complete */
  not_ready: string[]
  /** whether a check of the caller's access that a bound stopped left a
   * group out */
  unchecked: boolean
}

/**
 * One batch of the Inbox of `seats`, the caller's active profiles, by
 * `ask`, after position `o.after`, holding up to `o.limit` rows, each what
 * `o.row` builds for a group the walk keeps, and none past position
 * `o.through` when it is not null (lib/namedPages.ts readBatch). REST and
 * MCP are to call it for one profile with their own limit, row and cursor
 * list.
 *
 * Each seat's readiness comes first (seatReady). A seat that is not ready
 * adds its organization to `not_ready` and no stream. Unlike
 * projectNav.page, which answers `not_ready` for the whole page, the walk
 * names a seat that is not ready and leaves it out while the other seats'
 * groups show, as inbox.summary counts them (design specification row
 * 387). The walk reads the ready seats' items in the order of `ask`
 * (itemIndex, merged by lib/namedPages.ts mergeNamed and batched by
 * readBatch under `o.ceiling`, so it always reads its first item, a stop
 * is never an end, and a full batch reads one item more to say whether it
 * ended). Each item is judged in order, each step reading only what the
 * one before let through:
 *
 * 1. the kind filter, on the item's counts, without a read;
 * 2. the hint, whether the item's project_id can hold a task the seat is
 *    shown (inboxScope holdsItems), else the item is left out unread;
 * 3. the task, read and checked by its own project (inboxScope shows),
 *    else left out; a group that passes sets `checked_to`;
 * 4. a check either step could not finish (accessUnchecked) leaves the
 *    group out and sets `unchecked`, and the walk goes on;
 * 5. the names: the task's project and the project above it, read by the
 *    checks or once a page, and the newest message's actor;
 * 6. the newest message by _creationTime (`through`), and the message the
 *    item names newest by (created_at, id) when a backdated one differs;
 *    an item with no message, between a teardown's deletes, is left out;
 * 7. with a search, every word of it in the group's text (lib/inbox.ts
 *    inboxSearchText), its messages read only when the title, key, second
 *    line and places miss a word;
 * 8. `o.row`, which reads what its row needs.
 *
 * Every read is counted by the batch's read guard: the task, the newest
 * messages, the actors and the searched messages one by one, and the
 * access checks' own reads by a look at the request's metrics after each
 * item whose checks asked about a project this seat had not asked about.
 */
export async function inboxWalk<Out>(
  ctx: QueryCtx,
  seats: readonly Doc<'profiles'>[],
  ask: InboxAsk,
  o: {
    after: NamedAt<InboxTie> | null
    through: NamedAt<InboxTie> | null
    limit: number
    ceiling: ReadCeiling
    row: (group: InboxGroup, guard: ReadGuard) => Promise<Out>
  },
): Promise<InboxWalk<Out>> {
  const ordered = [...seats].sort((x, y) =>
    x.org_id < y.org_id ? -1 : x.org_id > y.org_id ? 1 : 0,
  )
  const notReady: string[] = []
  const sights = new Map<string, Sight>()
  for (const seat of ordered) {
    if (await seatReady(ctx, seat.id)) sights.set(seat.id, sightOf(ctx, seat))
    else notReady.push(seat.org_id)
  }
  const snoozed = ask.include_snoozed ? [false, true] : [false]
  const streams = [...sights.values()].flatMap(({ seat }) =>
    snoozed.map((s) =>
      indexAfter(
        itemIndex(ctx, seat.id, { snoozed: s, unread_only: ask.unread_only, order: ask.order }),
        o.after,
        ask.order,
      ),
    ),
  )
  const matcher = ask.search === '' ? null : allWordsMatcher(ask.search)
  let checkedTo: string | null = null
  let unchecked = false

  const keep = async (item: Doc<'inbox_items'>, guard: ReadGuard): Promise<Out | null> => {
    const sight = sights.get(item.recipient_id)
    if (sight === undefined || !kindsMatch(item, ask.kinds)) return null
    const fresh = { asked: false }
    try {
      const group = await judge(ctx, sight, item, guard, fresh)
      if (group === null) return null
      checkedTo = item.sort_at
      const named = await nameGroup(ctx, sight, item, group, guard, fresh)
      if (named === null) return null
      if (matcher !== null && !(await matches(ctx, named, matcher, guard))) return null
      return await o.row(named, guard)
    } catch (e) {
      if (!isAccessUnchecked(e)) throw e
      unchecked = true
      return null
    } finally {
      // the access checks read projects and the seat's levels uncounted
      if (fresh.asked) await guard.settle()
    }
  }

  const batch = await readBatch(ctx, {
    stream: (reads) =>
      mergeNamed(
        streams.map((stream) => stream(reads)),
        { order: ask.order },
      ),
    keep,
    limit: o.limit,
    through: o.through,
    ceiling: o.ceiling,
    after: o.after,
    order: ask.order,
  })
  return { ...batch, checked_to: checkedTo, not_ready: notReady, unchecked }
}

/* One ready seat's view for a walk: its scope (model/inboxReads.ts
 * inboxScope), the projects its checks have asked about, and its actors'
 * names, each read once. */
type Sight = {
  seat: Doc<'profiles'>
  scope: ReturnType<typeof inboxScope>
  asked: Set<string>
  names: Map<string, Promise<string | null>>
}

const sightOf = (ctx: QueryCtx, seat: Doc<'profiles'>): Sight => ({
  seat,
  scope: inboxScope(ctx, seat),
  asked: new Set(),
  names: new Map(),
})

/* Notes that `sight`'s checks ask about project `id`, in `fresh` when they
 * had not before, so the walk looks at the request's metrics after the
 * item. */
function asking(sight: Sight, id: string, fresh: { asked: boolean }) {
  if (sight.asked.has(id)) return
  sight.asked.add(id)
  fresh.asked = true
}

/* Steps 2 and 3 of inboxWalk: the item's task when the seat is shown it,
 * with its project, else null. Rejects with accessUnchecked where a bound
 * stopped a check. */
async function judge(
  ctx: QueryCtx,
  sight: Sight,
  item: Doc<'inbox_items'>,
  guard: ReadGuard,
  fresh: { asked: boolean },
): Promise<{ task: Doc<'issues'>; project: Doc<'projects'> } | null> {
  const { scope } = sight
  if (item.project_id !== undefined) {
    asking(sight, item.project_id, fresh)
    if (!(await scope.holdsItems(item.project_id))) return null
  }
  const task = await scope.task(item.issue_id, (id) => guard.lookup(() => byId(ctx, 'issues', id)))
  if (task === null) return null
  asking(sight, task.project_id, fresh)
  if (!(await scope.shows(task))) return null
  const project = await scope.project(task.project_id)
  return project === null ? null : { task, project }
}

/* The name of actor `actorId` for `sight`'s seat, read once a page and
 * counted, or null where the seat's organization has no such profile. */
function nameOf(
  ctx: QueryCtx,
  sight: Sight,
  actorId: string | undefined,
  guard: ReadGuard,
): Promise<string | null> {
  if (actorId === undefined) return Promise.resolve(null)
  let known = sight.names.get(actorId)
  if (known === undefined) {
    known = guard
      .lookup(() => byId(ctx, 'profiles', actorId))
      .then((p) => (p !== null && p.org_id === sight.seat.org_id ? p.name : null))
    sight.names.set(actorId, known)
  }
  return known
}

/* Steps 5 and 6 of inboxWalk: the group's places, newest message and
 * actor, or null for an item with no message left. The project above a
 * sub-project is read uncounted, as the checks read projects, so `fresh`
 * notes it for the walk's look at the metrics. */
async function nameGroup(
  ctx: QueryCtx,
  sight: Sight,
  item: Doc<'inbox_items'>,
  judged: { task: Doc<'issues'>; project: Doc<'projects'> },
  guard: ReadGuard,
  fresh: { asked: boolean },
): Promise<InboxGroup | null> {
  const { seat, scope } = sight
  const { project } = judged
  let parent: Doc<'projects'> | null = null
  if (project.parent_id !== undefined) {
    asking(sight, project.parent_id, fresh)
    parent = await scope.project(project.parent_id)
  }
  const newest = await guard.lookup(() =>
    ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', seat.id).eq('issue_id', item.issue_id),
      )
      .order('desc')
      .first(),
  )
  if (newest === null) return null
  let latest = newest
  if (newest.id !== item.latest_id) {
    const named = await guard.lookup(() =>
      ctx.db
        .query('messages')
        .withIndex('by_uuid', (q) => q.eq('id', item.latest_id))
        .first(),
    )
    if (named !== null && named.recipient_id === seat.id && named.issue_id === item.issue_id)
      latest = named
  }
  return {
    seat,
    item,
    task: judged.task,
    project,
    parent,
    latest,
    actor_name: await nameOf(ctx, sight, latest.actor_id, guard),
    through: newest._creationTime,
    nameOf: (actorId) => nameOf(ctx, sight, actorId, guard),
  }
}

/* Step 7 of inboxWalk: whether every word of the search is in the group's
 * text. The fields without the messages come first, and the messages are
 * read, every one, only when those miss a word. */
async function matches(
  ctx: QueryCtx,
  group: InboxGroup,
  matcher: (hay: string) => boolean,
  guard: ReadGuard,
): Promise<boolean> {
  const fields = {
    title: group.task.title,
    key: issueKey(group.task.num),
    line: messageLine(group.latest, group.actor_name),
    places: [group.parent?.name, group.project.name],
  }
  if (matcher(inboxSearchText({ ...fields, messages: [] }))) return true
  await guard.range()
  const rows: Doc<'messages'>[] = []
  for await (const message of ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) =>
      q.eq('recipient_id', group.seat.id).eq('issue_id', group.item.issue_id),
    )) {
    await guard.document(message)
    rows.push(message)
  }
  const messages = []
  for (const m of rows)
    messages.push({ actor_name: await group.nameOf(m.actor_id), detail: m.detail })
  return matcher(inboxSearchText({ ...fields, messages }))
}

/* ------------------------------------------------------------- the page */

/** A project as an Inbox row names it: its name, and its number to tell two
 * of one name apart. */
export type InboxPlace = { id: string; num: number; name: string }

/** One row of an Inbox page, a task group. */
export type InboxRow = {
  org_id: string
  issue_id: string
  /** the task's number, its key is lib/taskRefs.ts issueKey(num) */
  num: number
  /** the task's live title */
  title: string
  project: InboxPlace
  /** the project above a sub-project, null for a top-level project */
  parent: InboxPlace | null
  /** the list time, the newest message's created_at or a later wake */
  sort_at: string
  latest_at: string
  woke_at: string | null
  /** the newest message by (created_at, id), for the row's second line
   * (lib/inbox.ts messageLine) */
  latest: {
    id: string
    kind: MessageKind
    detail: string
    actor_id: string | null
    /** null where Qivo cannot name the actor, which the line writes as
     * "Someone" */
    actor_name: string | null
  }
  unread_count: number
  /** the earlier unread updates the item cap deleted */
  dropped: number
  /** the item's messages */
  count: number
  /** the kinds of its messages, in MESSAGE_KINDS order */
  kinds: MessageKind[]
  snoozed_until: string | null
  /** the oldest unread message's created_at, null when all are read */
  first_unread_at: string | null
  /** whether an unread message tells of a change (model/inboxReads.ts
   * unreadChange) */
  unread_change: boolean
  /** the newest message's _creationTime, the cutoff readItem and
   * removeItem take */
  through: number
}

/** What inbox.page answers (model/inboxPage.ts header). */
export type InboxPage = {
  rows: InboxRow[]
  next: string | null
  stopped: boolean
  checked_to: string | null
  not_ready: string[]
  unchecked: boolean
}

/** What inbox.page is asked. `after` is the `next` of the page before,
 * absent for the first page, and `through` this page's own `next`, to keep
 * a loaded page live without its end moving. */
export type InboxPageArgs = {
  order: 'newest' | 'oldest'
  unread_only: boolean
  include_snoozed: boolean
  kinds: MessageKind[]
  search?: string
  after?: string
  through?: string
}

/* `p` as a row names it. */
const place = (p: Doc<'projects'>): InboxPlace => ({ id: p.id, num: p.num, name: p.name })

/* An Inbox row of `group`, with its unread fields: the oldest unread
 * message and whether an unread message tells of a change, read only for
 * an unread group. */
async function inboxRow(ctx: QueryCtx, group: InboxGroup, guard: ReadGuard): Promise<InboxRow> {
  const { seat, item, task, latest } = group
  const pair = { recipient_id: seat.id, issue_id: item.issue_id }
  const firstUnread =
    item.unread_count === 0
      ? null
      : await guard.lookup(() =>
          ctx.db
            .query('messages')
            .withIndex('by_recipient_issue_read_order', (q) =>
              q.eq('recipient_id', seat.id).eq('issue_id', item.issue_id).eq('read_at', undefined),
            )
            .first(),
        )
  return {
    org_id: seat.org_id,
    issue_id: item.issue_id,
    num: task.num,
    title: task.title,
    project: place(group.project),
    parent: group.parent === null ? null : place(group.parent),
    sort_at: item.sort_at,
    latest_at: item.latest_at,
    woke_at: item.woke_at ?? null,
    latest: {
      id: latest.id,
      kind: latest.kind,
      detail: latest.detail,
      actor_id: latest.actor_id ?? null,
      actor_name: group.actor_name,
    },
    unread_count: item.unread_count,
    dropped: item.dropped,
    count: item.mentions + item.changes + item.comments,
    kinds: itemKinds(item),
    snoozed_until: item.snoozed_until ?? null,
    first_unread_at: firstUnread?.created_at ?? null,
    unread_change: await unreadChange(ctx, pair, item, guard),
    through: group.through,
  }
}

/**
 * inbox.page for login `authUserId`, whose active seats are `seats`: one
 * page of at most INBOX_PAGE.rows task groups across every ready seat, in
 * `a.order` by list time, with Unread only, Show snoozed (without it a
 * snoozed group is left out), the kind filter (a group holding a message
 * of any kind named) and the search (lib/search.ts allWordsMatcher over
 * lib/inbox.ts inboxSearchText) applied before the page is cut
 * (inboxWalk), under INBOX_PAGE.reads.
 *
 * `next` is a cursor sealed with the login, the order and a digest of the
 * filters and search (lib/namedPages.ts namedCursor), null when no group of
 * the ready seats follows. With `a.through`, a cursor sealed the same way,
 * the page holds every match after `a.after` up to and including it, at most
 * four times INBOX_PAGE.rows, and answers `stopped` with a `next` before
 * `through` past that, as lib/namedPages.ts listBatch answers. Refuses a
 * kind named twice, a search past LIMITS.search with its sentence, an
 * `after` or `through` that is not the `next` of an earlier page of the
 * same login, order, filters and search (NOT_INBOX_CURSOR), after which the
 * list starts again from the first page, and a `through` that does not come
 * after `after` in the page's order. A blank search is no search. The
 * header above says what the answer means.
 */
export async function readInboxPage(
  ctx: QueryCtx,
  authUserId: string,
  seats: readonly Doc<'profiles'>[],
  a: InboxPageArgs,
): Promise<InboxPage> {
  const ceiling = await namedCeiling(ctx, INBOX_PAGE.reads)
  if (new Set(a.kinds).size !== a.kinds.length)
    throw badRequest('kinds must name each message kind at most once')
  const search = limitedText(LIMITS.search, a.search ?? '')
  const kinds = [...a.kinds].sort()
  const scope = [
    authUserId,
    a.order,
    await filtersKey({
      unread_only: a.unread_only,
      include_snoozed: a.include_snoozed,
      kinds,
      search: search === '' ? null : search,
    }),
  ]
  const order: NamedOrder = a.order === 'newest' ? 'desc' : 'asc'
  const after = a.after === undefined ? null : await openCursor(a.after, scope)
  const through = a.through === undefined ? null : await openCursor(a.through, scope)
  if (after !== null && through !== null && compareIn(order, through, after) <= 0)
    throw badRequest('through must be a cursor after the one in after')
  const walk = await inboxWalk(
    ctx,
    seats,
    {
      order,
      unread_only: a.unread_only,
      include_snoozed: a.include_snoozed,
      kinds,
      search,
    },
    {
      after,
      through,
      limit: through === null ? INBOX_PAGE.rows : 4 * INBOX_PAGE.rows,
      ceiling,
      row: (group, guard) => inboxRow(ctx, group, guard),
    },
  )
  // a page under `through` that stopped short of it holds too many rows
  const short = !walk.ended && through !== null && compareIn(order, walk.at, through) < 0
  return {
    rows: walk.rows,
    next: walk.ended ? null : await namedCursor(INBOX_LIST, scope, walk.at),
    stopped: walk.stopped || short,
    checked_to: walk.checked_to,
    not_ready: walk.not_ready,
    unchecked: walk.unchecked,
  }
}

/* The position cursor `text` names in the Inbox list with `scope`, or a
 * refusal (NOT_INBOX_CURSOR) for any other text or a tie of another
 * shape. */
async function openCursor(text: string, scope: readonly string[]): Promise<NamedAt<InboxTie>> {
  const at = await openNamedCursor(text, INBOX_LIST, scope)
  const [issue, recipient] = at?.tie ?? []
  if (
    at === null ||
    at.tie.length !== 2 ||
    typeof issue !== 'string' ||
    typeof recipient !== 'string'
  )
    throw badRequest(NOT_INBOX_CURSOR)
  return { key: at.key, tie: [issue, recipient] }
}
