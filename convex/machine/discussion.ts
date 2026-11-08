/* Comments, the inbox and follows over REST and MCP. A caller edits and
 * deletes comments, reads and changes its own inbox, and follows tasks.
 *
 * DISCUSSION_TOOLS and DISCUSSION_ROUTES are registry entries
 * (machine/registry.ts) that machine/mcp.ts TOOLS and machine/rest.ts ROUTES
 * spread in, so tools/list, the OAuth step-up and REST routing treat them
 * like the rest. This module imports only types from those two, so neither
 * is loaded through it. The body parser and MCP text it shares with them
 * come from machine/shared.ts.
 *
 * Each action is one shared model function the app runs too
 * (model/comments.ts editComment and deleteComment, model/messages.ts
 * followTask, unfollowTask and the inbox writes). The internal functions
 * below are thin per-surface wrappers, `mcp*` and `rest*`: each starts from
 * asMachineCaller, which refuses a read-only credential before anything
 * resolves, parses its surface's input, calls the model and encodes the
 * result. MCP answers pretty-printed text, stringified here so the key order
 * survives the function boundary; REST answers objects.
 *
 * Visibility: a comment, a follow or an inbox item about a task the caller
 * cannot read answers like an unknown one, and a bulk inbox change names
 * only tasks the caller can read, asked through one lib/access.ts accessOf
 * instance (lib/core.ts machineShown). The inbox is read a page at a time
 * through the app's Inbox walk (model/inboxPage.ts inboxWalk), from the
 * caller's stored items, with the walk's rule of who sees what
 * (model/inboxReads.ts inboxScope): the items about tasks in the caller's
 * working set, so an archived task's item leaves it until a restore, and
 * `unread` and `snooze` refuse such a task, so its messages stay read. It
 * shows the live task title and key, never the title stored on the
 * message. */

import { type ConvexError, type ObjectType, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { accessOf, accessUnchecked } from '../lib/access'
import {
  asMachineCaller,
  type Caller,
  commentOut,
  findIssue,
  issueKey,
  machineShown,
  type RestCommentJson,
  type TaskRefJson,
  taskRefOf,
  UUID,
} from '../lib/core'
import { byId } from '../lib/db'
import { vCredentialAccess } from '../lib/enums'
import { badRequest, notFound, type Refusal, rule } from '../lib/functions'
import { DEFAULT_PAGE_SIZE, LIMITS } from '../lib/limits'
import { CURSOR_REFUSAL, filtersKey, listCursorText, openListCursor } from '../lib/listCursor'
import { type NamedAt, namedCeiling, type ReadGuard } from '../lib/namedPages'
import { COMMENT_FIELDS, deleteComment, editComment } from '../model/comments'
import {
  EXPECTED_DELETE_SENTENCE,
  EXPECTED_SENTENCE,
  expectedSchema,
  parseExpected,
  sentKeys,
  vExpected,
} from '../model/expected'
import { INBOX_PAGE, type InboxGroup, type InboxTie, inboxTie, inboxWalk } from '../model/inboxPage'
import {
  followTask,
  ITEM_UNREAD_CAP,
  itemMessages,
  markAllMessagesRead,
  markMessagesRead,
  markMessagesUnread,
  refuseArchivedItems,
  removeMessages,
  removeReadMessages,
  snoozeMessages,
  unfollowTask,
} from '../model/messages'
import type { TOOLS } from './mcp'
import type { ROUTES, route as restRoute } from './rest'
import { cursorPaging, needJson, optionalJson, pretty, refuseUnknownFields } from './shared'

type McpTool = (typeof TOOLS)[number]
type RestRoute = (typeof ROUTES)[number]

/* machine/rest.ts route(), which types each `run`'s params from its path.
 * Only its type is imported, so this module does not load rest.ts. */
const route: typeof restRoute = (declared) => declared

/* MCP's uniform not-found sentences. */
const mcpTaskMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`task "${ref}" not found (or not visible to you)`)
const mcpCommentMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`comment "${ref}" not found (or not visible to you)`)

/* --------------------------------------------------------------- comments */

/**
 * The comment `ref` (its uuid) and its task, when the caller can read the
 * task (findIssue's rule), else null. A comment on a hidden task reads like
 * an unknown one.
 */
async function findComment(
  ctx: QueryCtx,
  me: Caller,
  ref: string,
): Promise<{ comment: Doc<'comments'>; issue: Doc<'issues'> } | null> {
  if (!UUID.test(ref)) return null
  const comment = await byId(ctx, 'comments', ref.toLowerCase())
  if (comment === null) return null
  const issue = await findIssue(ctx, me, comment.issue_id)
  return issue === null ? null : { comment, issue }
}

/* ------------------------------------------------------------------ inbox */

/** One message of an inbox item. */
type InboxMessageJson = {
  id: string
  kind: Doc<'messages'>['kind']
  detail: string
  actor_id: string | null
  actor_name: string | null
  created_at: string
  read_at: string | null
}

/** One inbox item, the unit the app's Inbox lists, which holds the caller's
 * messages about one task. */
type InboxItemJson = {
  /** the task as it is now */
  task: TaskRefJson
  unread_count: number
  /** how many earlier unread messages the item no longer holds, because an
   * item keeps at most ITEM_UNREAD_CAP unread ones (model/messages.ts) */
  dropped_count: number
  /** the newest message's instant, or the end of a snooze when later */
  latest_at: string
  snoozed_until: string | null
  /** oldest first */
  messages: InboxMessageJson[]
}

/** One page of the caller's inbox items, as REST GET /v1/inbox and MCP
 * list_inbox answer it, the cursor first. */
type InboxPageJson = { next_cursor: string | null; items: InboxItemJson[] }

/* (created_at, id), the total order the app and the prune use. */
const newerThan = (a: Doc<'messages'>, b: Doc<'messages'>): boolean =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id)

/** The list name REST GET /v1/inbox and MCP list_inbox seal their cursors
 * with (lib/listCursor.ts). Both answer the same rows, so a cursor of one
 * continues on the other. */
export const MACHINE_INBOX_LIST = 'machine.inbox'

/** The refusal of a page for a seat whose inbox items Qivo has not finished
 * building (model/inboxItems.ts seatReady), so an inbox is never answered
 * as empty or whole before its items are. Every seat that the inbox items
 * backfill built, and every new one, is ready; a seat it left stuck stays
 * refused until support helps. */
export const INBOX_NOT_READY =
  'your inbox cannot be read until Qivo has finished preparing it. Try again in a few minutes, or contact support@qivo.io if it stays so.'

/* One inbox item as a machine row: the item's counts and every message the
 * caller holds about its task, oldest first, each actor named from the
 * caller's organization by id (InboxGroup nameOf, one profile read once a
 * page). It reads the item's messages in one range, each counted by the
 * page's guard; the walk already read the task and the item. A row is read
 * whole once the walk starts it, so an item at the item cap, or one kept
 * from before the cap, is answered whole and the page stops after it. */
async function inboxItemOf(
  ctx: QueryCtx,
  group: InboxGroup,
  guard: ReadGuard,
): Promise<InboxItemJson> {
  await guard.range()
  const rows: Doc<'messages'>[] = []
  const stored = ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) =>
      q.eq('recipient_id', group.seat.id).eq('issue_id', group.item.issue_id),
    )
  for await (const row of stored) {
    await guard.document(row)
    rows.push(row)
  }
  rows.sort((a, b) => (newerThan(a, b) ? 1 : newerThan(b, a) ? -1 : 0))
  const messages: InboxMessageJson[] = []
  for (const m of rows)
    messages.push({
      id: m.id,
      kind: m.kind,
      detail: m.detail,
      actor_id: m.actor_id ?? null,
      actor_name: await group.nameOf(m.actor_id),
      created_at: m.created_at,
      read_at: m.read_at ?? null,
    })
  return {
    task: taskRefOf(group.task),
    unread_count: group.item.unread_count,
    dropped_count: group.item.dropped,
    latest_at: group.item.sort_at,
    snoozed_until: group.item.snoozed_until ?? null,
    messages,
  }
}

/**
 * One page of `me`'s inbox items for REST GET /v1/inbox and MCP list_inbox,
 * after `a.cursor`, the next_cursor of an earlier page, at most `a.limit`
 * of them, read through the Inbox's walk (model/inboxPage.ts inboxWalk) from
 * the caller's own stored items (inbox_items), with `unread_only` and
 * `include_snoozed` applied before the page is cut.
 *
 * An item shows only when its task is in the caller's working set, the
 * rule of the app's Inbox (model/inboxReads.ts inboxScope, lib/access.ts
 * accessOf holds): a task of the caller's organization, not archived, in a
 * live project they can see. Each row is inboxItemOf. The order is the
 * walk's, the latest activity first (an item's newest message's time, or a
 * later wake), equal times by task id descending.
 *
 * The page reads within INBOX_PAGE.reads past what the call read before it
 * (lib/namedPages.ts namedCeiling), always reads its first item, and stops
 * early with a cursor once the budget is spent, so a short or empty page is
 * never the end and next_cursor is null only once the walk ended. The
 * cursor is sealed with the organization, `me` and a digest of the two
 * filters, so it opens only for that list, on either surface; any other
 * cursor is refused with CURSOR_REFUSAL. Pages are not a snapshot. A seat
 * whose items are not built is refused with INBOX_NOT_READY, and a check a
 * bound of lib/access.ts OWN_READS stopped refuses the whole page with
 * accessUnchecked, never a page missing an item.
 *
 * What one page reads, measured in convex/tests/machineInbox.test.ts
 * ("reads at the design size"), one figure raised at a time beside an
 * everyday reader (3 teams, 63 sub-projects):
 * - the everyday Inbox, 60 groups of 2 messages over 3 sub-projects: 176
 *   index ranges and 269 documents for a page of 50, and all 60 at limit
 *   200 in 207 ranges and 318 documents, answered in 44 KB of JSON (63 KB
 *   as MCP's text); in 5 teams, 196 ranges and 248 documents;
 * - a page of 200 over one sub-project's 450 groups (300 open and 150 Done
 *   tasks) or one project's 1,000 (800 and 200 over 3 sub-projects): at
 *   most 667 ranges and 859 documents, 107 KB (149 KB);
 * - 60 groups at the item cap, 51 messages each, at limit 200: 206 ranges,
 *   3,258 documents and 1.4 MiB read, the largest answer, 667 KB of JSON
 *   and 979 KB as MCP's text;
 * - 800 groups of a project the reader no longer sees, newer than 60
 *   visible ones: 178 ranges and 1,013 documents at 50, 208 and 1,052 at
 *   200, the hint skipping the hidden items without their tasks;
 * - an organization of 1,000 people whose 60 groups name 180 of them: 376
 *   ranges and 548 documents at 200, exactly 180 of each more than the
 *   same page naming nobody;
 * - the 200 sub-projects one person can read, 6,000 groups: 1,037 ranges
 *   and 1,208 documents at 200 and 323 and 344 at 50, with no check
 *   stopped by OWN_READS;
 * - 2,000 groups of archived tasks in one visible sub-project, newer than
 *   an everyday Inbox: a first page of no items, stopped with a cursor at
 *   2,001 ranges and 3,988 documents (1.8 MiB), one task read for each
 *   group it passes.
 */
export async function inboxPage(
  ctx: QueryCtx,
  me: Caller,
  a: { unread_only: boolean; include_snoozed: boolean; limit: number; cursor: string | null },
): Promise<InboxPageJson> {
  const scope = [
    me.org_id,
    me.id,
    await filtersKey({ unread_only: a.unread_only, include_snoozed: a.include_snoozed }),
  ]
  let after: NamedAt<InboxTie> | null = null
  if (a.cursor !== null) {
    const at = await openListCursor(a.cursor, MACHINE_INBOX_LIST, scope, 2)
    const tie = inboxTie(at)
    if (tie === null) throw badRequest(CURSOR_REFUSAL)
    after = { key: at.key, tie }
  }
  const walk = await inboxWalk(
    ctx,
    [me],
    {
      order: 'desc',
      unread_only: a.unread_only,
      include_snoozed: a.include_snoozed,
      kinds: [],
      search: '',
    },
    {
      after,
      through: null,
      limit: a.limit,
      ceiling: await namedCeiling(ctx, INBOX_PAGE.reads),
      row: (group, guard) => inboxItemOf(ctx, group, guard),
    },
  )
  if (walk.not_ready.length > 0) throw rule(INBOX_NOT_READY)
  if (walk.unchecked) throw accessUnchecked()
  return {
    next_cursor: walk.ended ? null : await listCursorText(MACHINE_INBOX_LIST, scope, walk.at),
    items: walk.rows,
  }
}

/**
 * The most task refs one inbox change may name, which keeps a call well
 * inside Convex's transaction limits. An item holds at most
 * ITEM_UNREAD_CAP + 1 = 51 rows (model/messages.ts). Mark read patches up
 * to 51 of them and its prune then deletes up to 50, which Convex counts
 * as more writes, and the item's inbox_items row is written once more
 * (model/inboxItems.ts), so 100 items write at most 100 * 102 = 10,200 of
 * the 16,000 allowed. Unread, remove and snooze write at most 52 rows per
 * item. Resolving a ref (lib/core.ts findIssue) reads the task, its
 * project, the root project and the caller's grant and team grants on
 * both, 7 index ranges plus 2 per team granted either project. The item
 * read, the prune's or snooze's second read and the item's inbox_items row
 * add 3, and the caller's build state one for the call, so 100 refs use
 * about 1,000 of the 4,096 index ranges and stay inside with up to 15 such
 * teams. Unread and snooze also read each task and its project twice to
 * refuse an archived one (model/messages.ts refuseArchivedItems), once for
 * the refs and once for the rows, so they use about 1,400 and stay inside
 * with up to 13 such teams. Snooze schedules one wake per item, 100 of the
 * 1,000 allowed. Duplicate refs count too. The value is the registry's
 * (lib/limits.ts).
 */
export const INBOX_TASKS_MAX = LIMITS.inboxTasks.max

/** What an inbox change does to the items it names. */
const INBOX_ACTIONS = ['read', 'unread', 'remove', 'snooze'] as const
type InboxAction = (typeof INBOX_ACTIONS)[number]
const vInboxAction = v.union(
  v.literal('read'),
  v.literal('unread'),
  v.literal('remove'),
  v.literal('snooze'),
)

/**
 * An inbox change's targets, checked alike on both surfaces. `refs` holds
 * task refs, or null for every item (`all: true`, for read and remove only),
 * and `until` the snooze instant, an ISO string or null to end the snooze.
 * `before` is the cutoff a read of every item answered on its first call
 * and the caller passes back to later ones, absent on the first call. Any
 * finite number from 0 up is accepted, since a cutoff only selects the
 * caller's own unread rows.
 */
function inboxRequest(
  action: InboxAction,
  b: { tasks?: unknown; all?: unknown; until?: unknown; before?: unknown },
): { refs: string[] | null; until: string | null; before: number | undefined } {
  if (b.all !== undefined && typeof b.all !== 'boolean')
    throw badRequest('all must be true or false')
  const all = b.all === true
  let refs: string[] | null = null
  if (b.tasks !== undefined) {
    const tasks = b.tasks
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.some((t) => typeof t !== 'string')) {
      throw badRequest('tasks must be a non-empty list of task refs')
    }
    if (tasks.length > INBOX_TASKS_MAX) throw rule(LIMITS.inboxTasks.refusal)
    refs = tasks as string[]
  }
  if (all && refs !== null) throw badRequest('name tasks or set all, not both')
  if (!all && refs === null) throw badRequest('name the inbox items with tasks, or set all to true')
  if (all && action !== 'read' && action !== 'remove') {
    throw badRequest('all applies to read and remove only')
  }
  let before: number | undefined
  if (b.before !== undefined) {
    if (!all || action !== 'read') throw badRequest('before applies to read with all only')
    if (typeof b.before !== 'number' || !Number.isFinite(b.before) || b.before < 0) {
      throw badRequest('before must be the number an earlier call returned')
    }
    before = b.before
  }
  if (action !== 'snooze') {
    if (b.until !== undefined) throw badRequest('until applies to snooze only')
    return { refs, until: null, before }
  }
  const until = b.until
  if (until === null) return { refs, until: null, before }
  if (typeof until !== 'string') {
    throw badRequest('snooze needs until, an ISO date-time, or null to end the snooze')
  }
  return { refs, until, before }
}

/** What an inbox change did, as the keys of the tasks whose items it
 * changed and whether `all` left rows for another call. A read with `all`
 * also answers `before`, the cutoff its first call chose, which the caller
 * passes back to each later call. */
type InboxChangeJson = {
  action: InboxAction
  tasks: string[]
  has_more: boolean
  before?: number
}

/**
 * Applies `action` to the caller's inbox items about the named tasks, or
 * with `all` to every item, as the app's Mark all as read and Remove all
 * read notifications do, one bounded batch per call and rows about tasks the
 * caller cannot read included. The answer names only tasks of the caller's
 * organization whose project one lib/access.ts accessOf instance shows
 * them (visible), each distinct project asked once; a check a bound of
 * OWN_READS stopped refuses the whole change, which Convex then rolls back,
 * rather than name fewer tasks than it changed. A ref the caller cannot read refuses the whole change with
 * `unknownTask`. Every ref is resolved before anything else, so that
 * refusal comes first. Then `unread` and `snooze` refuse the whole change
 * when a named task is archived or in an archived project, whether or not
 * the caller holds messages about it (model/messages.ts
 * refuseArchivedItems). `read` and `remove` still work there.
 *
 * With `all`, a batch of INBOX_BATCH messages on as many tasks in as many
 * sub-projects the caller reads by grant read 1,108 index ranges and 1,499
 * documents for `read` and 787 and 1,338 for `remove`, all 160 named, and
 * the same with 300 more projects in the organization
 * (convex/tests/machineInbox.test.ts, "reads at the design size").
 */
async function changeInbox(
  ctx: MutationCtx,
  me: Caller,
  action: InboxAction,
  req: { refs: string[] | null; until: string | null; before: number | undefined },
  unknownTask: (ref: string) => ConvexError<Refusal>,
): Promise<InboxChangeJson> {
  const now = new Date().toISOString()
  if (req.refs === null) {
    let done: { rows: Doc<'messages'>[]; more: boolean; before?: number }
    if (action === 'read') {
      // Like the app's Mark all as read, the first call chooses the cutoff
      // and later calls pass it back, so messages that arrive between the
      // batches stay unread.
      const marked = await markAllMessagesRead(ctx, me, req.before, now)
      done = { rows: marked.marked, more: marked.hasMore, before: marked.before }
    } else {
      const removed = await removeReadMessages(ctx, me)
      done = { rows: removed.removed, more: removed.hasMore }
    }
    const touched: Doc<'issues'>[] = []
    for (const id of new Set(done.rows.map((row) => row.issue_id))) {
      const task = await byId(ctx, 'issues', id)
      if (task !== null) touched.push(task)
    }
    const access = accessOf(ctx, me)
    const shown = await machineShown(touched, me, (projectId) => access.visible(projectId))
    return {
      action,
      tasks: touched
        .filter((task) => shown(task.id))
        .sort((a, b) => a.num - b.num)
        .map((task) => issueKey(task.num)),
      has_more: done.more,
      ...(done.before === undefined ? {} : { before: done.before }),
    }
  }
  const named: Doc<'issues'>[] = []
  for (const ref of req.refs) {
    const issue = await findIssue(ctx, me, ref)
    if (issue === null) throw unknownTask(ref)
    if (!named.some((n) => n.id === issue.id)) named.push(issue)
  }
  if (action === 'unread' || action === 'snooze') {
    await refuseArchivedItems(
      ctx,
      me,
      named.map((issue) => issue.id),
    )
  }
  const rows: Doc<'messages'>[] = []
  for (const issue of named) rows.push(...(await itemMessages(ctx, me, issue.id)))
  const changed =
    action === 'read'
      ? await markMessagesRead(ctx, me, rows, now)
      : action === 'unread'
        ? await markMessagesUnread(ctx, me, rows)
        : action === 'remove'
          ? await removeMessages(ctx, rows)
          : await snoozeMessages(ctx, me, rows, req.until)
  return {
    action,
    tasks: named.filter((issue) => changed.has(issue.id)).map((issue) => issueKey(issue.num)),
    has_more: false,
  }
}

/* A true/false REST query parameter; absent is false. */
function flagParam(raw: string | undefined, name: string): boolean {
  if (raw === undefined) return false
  if (raw !== 'true' && raw !== 'false') throw badRequest(`${name} must be true or false`)
  return raw === 'true'
}

/* ---------------------------------------------------------------- follows */

/* Starts or stops the caller following `issue`. Returns whether that
 * changed anything. */
const setFollowing = async (
  ctx: MutationCtx,
  me: Caller,
  issue: Doc<'issues'>,
  following: boolean,
): Promise<boolean> =>
  following
    ? await followTask(ctx, { me, issue, now: new Date().toISOString() })
    : await unfollowTask(ctx, { me, issueId: issue.id })

/* ------------------------------------------------------ MCP internal fns */

/* update_comment runs model/comments.ts editComment, for the author or a
 * project lead. Answers the comment with its task's key and whether it
 * changed. */
export const mcpUpdateComment = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    comment: v.string(),
    body: v.string(),
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const found = await findComment(ctx, me, a.comment)
    if (found === null) throw mcpCommentMissing(a.comment)
    const now = new Date().toISOString()
    const { comment, changed } = await editComment(ctx, {
      me,
      ...found,
      body: a.body,
      now,
      expected: a.expected,
      view: 'machine',
    })
    const { id, ...out } = await commentOut(ctx, comment, { surface: 'mcp' })
    return pretty({ id, task: issueKey(found.issue.num), changed, ...out })
  },
})

/* delete_comment runs model/comments.ts deleteComment, by the same rule. */
export const mcpDeleteComment = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    comment: v.string(),
    expected: v.optional(vExpected),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const found = await findComment(ctx, me, a.comment)
    if (found === null) throw mcpCommentMissing(a.comment)
    await deleteComment(ctx, { me, ...found, expected: a.expected, view: 'machine' })
    return pretty({ deleted: true, id: found.comment.id, task: issueKey(found.issue.num) })
  },
})

/* list_inbox answers one page of the caller's items (inboxPage), the
 * cursor first, so a cut tool result still shows it, its `limit` and
 * `offset` checked as REST checks them (shared.ts cursorPaging). */
export const mcpListInbox = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    unread_only: v.optional(v.boolean()),
    include_snoozed: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const paging = cursorPaging(LIMITS.listInbox, 'inbox items', a)
    const page = await inboxPage(ctx, me, {
      ...paging,
      unread_only: a.unread_only === true,
      include_snoozed: a.include_snoozed === true,
    })
    return pretty(page)
  },
})

/* update_inbox applies one action to the named items, or to every item. */
export const mcpUpdateInbox = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    action: vInboxAction,
    tasks: v.optional(v.array(v.string())),
    all: v.optional(v.boolean()),
    until: v.optional(v.union(v.string(), v.null())),
    before: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const req = inboxRequest(a.action, a)
    return pretty(await changeInbox(ctx, me, a.action, req, mcpTaskMissing))
  },
})

/* set_following follows or stops following one task. */
export const mcpSetFollowing = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    following: v.boolean(),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw mcpTaskMissing(a.ref)
    const changed = await setFollowing(ctx, me, issue, a.following)
    return pretty({ key: issueKey(issue.num), following: a.following, changed })
  },
})

/* ----------------------------------------------------- REST internal fns */

/* PATCH /v1/comments/{id} {body}: the edited comment. */
export const restUpdateComment = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<RestCommentJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const found = await findComment(ctx, me, a.ref)
    if (found === null) throw notFound('comment not found')
    const b = needJson(a.body)
    refuseUnknownFields(b, ['body', 'expected'])
    if (typeof b.body !== 'string') throw badRequest('body must be a non-empty string')
    const expected = parseExpected(COMMENT_FIELDS, b.expected, sentKeys(COMMENT_FIELDS, b))
    const now = new Date().toISOString()
    const { comment } = await editComment(ctx, {
      me,
      ...found,
      body: b.body,
      now,
      expected,
      view: 'machine',
    })
    return (await commentOut(ctx, comment, { surface: 'rest' })) as RestCommentJson
  },
})

/* DELETE /v1/comments/{id}, with an optional body {expected}: the body the
 * caller read, because Deleted items cannot bring a comment back. */
export const restDeleteComment = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ deleted: true; id: string; task_id: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const found = await findComment(ctx, me, a.ref)
    if (found === null) throw notFound('comment not found')
    const b = optionalJson(a.body ?? '')
    refuseUnknownFields(b, ['expected'])
    const expected = parseExpected(COMMENT_FIELDS, b.expected, Object.keys(COMMENT_FIELDS))
    await deleteComment(ctx, { me, ...found, expected, view: 'machine' })
    return { deleted: true, id: found.comment.id, task_id: found.issue.id }
  },
})

/* GET /v1/inbox?unread_only=&include_snoozed=&limit=&cursor=&offset= —
 * one page of the caller's items (inboxPage), checked in the order the
 * docs give: `limit` and `offset` (cursorPaging), the two flags, then the
 * page's own refusals. An empty cursor is taken as absent. */
export const restListInbox = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    unread_only: v.optional(v.string()),
    include_snoozed: v.optional(v.string()),
    limit: v.optional(v.string()),
    offset: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<InboxPageJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const paging = cursorPaging(LIMITS.listInbox, 'inbox items', {
      ...a,
      cursor: a.cursor || undefined,
    })
    const unread_only = flagParam(a.unread_only, 'unread_only')
    const include_snoozed = flagParam(a.include_snoozed, 'include_snoozed')
    return await inboxPage(ctx, me, { ...paging, unread_only, include_snoozed })
  },
})

/* The arguments of each POST /v1/inbox/{action} function. */
const vRestInboxArgs = { callerId: v.string(), access: vCredentialAccess, body: v.string() }

/* POST /v1/inbox/{read|unread|remove|snooze} {tasks | all, until?,
 * before?}, which each action's own internal function below runs, so every
 * route reaches exactly one function. A body ref the caller cannot read is a
 * 400, like other refs in a REST body. */
async function restChangeInbox(
  ctx: MutationCtx,
  a: ObjectType<typeof vRestInboxArgs>,
  action: InboxAction,
): Promise<InboxChangeJson> {
  const me = await asMachineCaller(ctx, a.callerId, a.access)
  const b = needJson(a.body)
  refuseUnknownFields(b, ['tasks', 'all', 'until', 'before'])
  const req = inboxRequest(action, b)
  return await changeInbox(ctx, me, action, req, () =>
    badRequest('tasks must name tasks by key, number or uuid'),
  )
}

/* POST /v1/inbox/read. */
export const restReadInbox = internalMutation({
  args: vRestInboxArgs,
  handler: (ctx, a) => restChangeInbox(ctx, a, 'read'),
})

/* POST /v1/inbox/unread. */
export const restUnreadInbox = internalMutation({
  args: vRestInboxArgs,
  handler: (ctx, a) => restChangeInbox(ctx, a, 'unread'),
})

/* POST /v1/inbox/remove. */
export const restRemoveInbox = internalMutation({
  args: vRestInboxArgs,
  handler: (ctx, a) => restChangeInbox(ctx, a, 'remove'),
})

/* POST /v1/inbox/snooze. */
export const restSnoozeInbox = internalMutation({
  args: vRestInboxArgs,
  handler: (ctx, a) => restChangeInbox(ctx, a, 'snooze'),
})

/* The arguments of PUT and DELETE /v1/tasks/{ref}/following. */
const vRestFollowingArgs = {
  callerId: v.string(),
  access: vCredentialAccess,
  ref: v.string(),
  body: v.optional(v.string()),
}

/* Sets the caller following the task `ref` or not, for restFollowTask and
 * restUnfollowTask. Neither route takes a body. */
async function restFollowing(
  ctx: MutationCtx,
  a: ObjectType<typeof vRestFollowingArgs>,
  following: boolean,
): Promise<{ id: string; key: string; following: boolean; changed: boolean }> {
  const me = await asMachineCaller(ctx, a.callerId, a.access)
  const issue = await findIssue(ctx, me, a.ref)
  if (issue === null) throw notFound('task not found')
  refuseUnknownFields(optionalJson(a.body ?? ''), [])
  const changed = await setFollowing(ctx, me, issue, following)
  return { id: issue.id, key: issueKey(issue.num), following, changed }
}

/* PUT /v1/tasks/{ref}/following. */
export const restFollowTask = internalMutation({
  args: vRestFollowingArgs,
  handler: (ctx, a) => restFollowing(ctx, a, true),
})

/* DELETE /v1/tasks/{ref}/following. */
export const restUnfollowTask = internalMutation({
  args: vRestFollowingArgs,
  handler: (ctx, a) => restFollowing(ctx, a, false),
})

/* ------------------------------------------------------- registry entries */

/** The MCP tools of this domain, in tools/list order after mcp.ts's own. */
export const DISCUSSION_TOOLS: McpTool[] = [
  {
    access: 'write',
    def: {
      name: 'update_comment',
      title: 'Edit comment',
      description:
        "Replace a comment's markdown `body`. `comment` is the comment's id from list_comments. You may edit your own comments, and a project lead any comment in the project. People the edit newly mentions are notified. " +
        EXPECTED_SENTENCE,
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          comment: {
            type: 'string',
          },
          body: {
            type: 'string',
            minLength: 1,
            maxLength: LIMITS.comment.max,
          },
          expected: expectedSchema(COMMENT_FIELDS),
        },
        required: ['comment', 'body'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as { comment: string; body: string; expected?: unknown }
      return r.runMutation(internal.machine.discussion.mcpUpdateComment, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(COMMENT_FIELDS, expected, sentKeys(COMMENT_FIELDS, rest)),
      })
    },
  },
  {
    access: 'write',
    def: {
      name: 'delete_comment',
      title: 'Delete comment',
      description:
        'Delete a comment by its id from list_comments. You may delete your own comments, and a project lead any comment in the project. ' +
        EXPECTED_DELETE_SENTENCE,
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          comment: {
            type: 'string',
          },
          expected: expectedSchema(COMMENT_FIELDS),
        },
        required: ['comment'],
      },
    },
    run: (r, { callerId, access, args }) => {
      const { expected, ...rest } = args as { comment: string; expected?: unknown }
      return r.runMutation(internal.machine.discussion.mcpDeleteComment, {
        callerId,
        access,
        ...rest,
        expected: parseExpected(COMMENT_FIELDS, expected, Object.keys(COMMENT_FIELDS)),
      })
    },
  },
  {
    access: 'read',
    def: {
      name: 'list_inbox',
      title: 'List inbox',
      description: `Your inbox as the app shows it, one page at a time. The answer is \`{next_cursor, items}\`. \`items\` holds one item per active task you can read, latest activity first, each with its unread count, every message (oldest first) and \`dropped_count\`, how many earlier unread messages it no longer holds because an item keeps at most ${ITEM_UNREAD_CAP} unread. \`unread_only\` keeps items with unread messages. Snoozed items are left out unless \`include_snoozed\`. A page holds at most \`limit\` items (${DEFAULT_PAGE_SIZE} by default, at most ${LIMITS.listInbox.max}), and can hold fewer, even none, while \`next_cursor\` is set; pass \`next_cursor\` as \`cursor\` with the same filters until it is null. \`offset\` is refused unless 0. Mark items read to shrink the inbox.`,
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          unread_only: {
            type: 'boolean',
          },
          include_snoozed: {
            type: 'boolean',
          },
          limit: {
            type: 'integer',
            minimum: LIMITS.listInbox.min,
            maximum: LIMITS.listInbox.max,
          },
          offset: {
            type: 'integer',
            minimum: 0,
            maximum: 0,
          },
          cursor: {
            type: 'string',
            minLength: 1,
          },
        },
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runQuery(internal.machine.discussion.mcpListInbox, {
        callerId,
        access,
        ...(args as {
          unread_only?: boolean
          include_snoozed?: boolean
          limit?: number
          offset?: number
          cursor?: string
        }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'update_inbox',
      title: 'Update inbox',
      description: `Apply \`action\` to your inbox items about \`tasks\` (up to ${INBOX_TASKS_MAX} task refs): \`read\`, \`unread\`, \`remove\` or \`snooze\`. With \`all: true\` instead, \`read\` marks every item read and \`remove\` removes every read item; repeat while \`has_more\` is true, and with \`read\` pass back the \`before\` each answer returns, so messages that arrive meanwhile stay unread. \`snooze\` needs \`until\`, an ISO date-time at most ${LIMITS.snooze.max} days ahead, or null to bring the items back now; a snoozed item returns unread. The result lists the tasks whose items changed.`,
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          action: {
            type: 'string',
            enum: [...INBOX_ACTIONS],
          },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: INBOX_TASKS_MAX,
          },
          all: {
            type: 'boolean',
          },
          until: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          before: {
            type: 'number',
            minimum: 0,
          },
        },
        required: ['action'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.discussion.mcpUpdateInbox, {
        callerId,
        access,
        ...(args as {
          action: InboxAction
          tasks?: string[]
          all?: boolean
          until?: string | null
          before?: number
        }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'set_following',
      title: 'Follow task',
      description: `Follow a task (\`following: true\`) to receive its updates in your inbox, or stop following it. \`ref\` is a task ID like QN-482 (bare 482 works too) or a uuid. A task has at most ${LIMITS.followers.max} followers, so following one that has ${LIMITS.followers.max} is refused. get_task shows \`following\` and the first followers, and list_task_related the rest.`,
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          ref: {
            type: 'string',
          },
          following: {
            type: 'boolean',
          },
        },
        required: ['ref', 'following'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.discussion.mcpSetFollowing, {
        callerId,
        access,
        ...(args as { ref: string; following: boolean }),
      }),
  },
]

/** The REST routes of this domain, each with its own internal function. */
export const DISCUSSION_ROUTES: RestRoute[] = [
  route({
    method: 'PATCH',
    path: 'comments/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.discussion.restUpdateComment, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'comments/:ref',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.discussion.restDeleteComment, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'GET',
    path: 'inbox',
    access: 'read',
    status: 200,
    query: ['unread_only', 'include_snoozed', 'limit', 'cursor', 'offset'],
    run: (r, { callerId, access, query }) =>
      r.runQuery(internal.machine.discussion.restListInbox, {
        callerId,
        access,
        unread_only: query('unread_only'),
        include_snoozed: query('include_snoozed'),
        limit: query('limit'),
        cursor: query('cursor'),
        offset: query('offset'),
      }),
  }),
  route({
    method: 'POST',
    path: 'inbox/read',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, body }) =>
      r.runMutation(internal.machine.discussion.restReadInbox, { callerId, access, body }),
  }),
  route({
    method: 'POST',
    path: 'inbox/unread',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, body }) =>
      r.runMutation(internal.machine.discussion.restUnreadInbox, { callerId, access, body }),
  }),
  route({
    method: 'POST',
    path: 'inbox/remove',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, body }) =>
      r.runMutation(internal.machine.discussion.restRemoveInbox, { callerId, access, body }),
  }),
  route({
    method: 'POST',
    path: 'inbox/snooze',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, body }) =>
      r.runMutation(internal.machine.discussion.restSnoozeInbox, { callerId, access, body }),
  }),
  route({
    method: 'PUT',
    path: 'tasks/:ref/following',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.discussion.restFollowTask, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'tasks/:ref/following',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param, body }) =>
      r.runMutation(internal.machine.discussion.restUnfollowTask, {
        callerId,
        access,
        ref: param('ref'),
        body,
      }),
  }),
]
