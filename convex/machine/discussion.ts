/* Comments, the inbox and follows over REST and MCP. A caller edits and
 * deletes comments, reads and changes its own inbox, and follows tasks.
 *
 * DISCUSSION_TOOLS and DISCUSSION_ROUTES are registry entries
 * (machine/registry.ts) that machine/mcp.ts TOOLS and machine/rest.ts ROUTES
 * spread in, so tools/list, the OAuth step-up and REST routing treat them
 * like the rest. This module imports only types from those two, so neither
 * is loaded through it.
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
 * cannot read answers like an unknown one, and a read or a bulk inbox change
 * names only tasks the caller can read (lib/workingSet.ts with the machine
 * Shown, lib/core.ts machineShown). The inbox shows the live task title and
 * key, never the title stored on the message. */

import { type ConvexError, v } from 'convex/values'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import {
  asMachineCaller,
  type Caller,
  commentOut,
  findIssue,
  issueKey,
  listUsersCore,
  machineShown,
  projectReader,
  type RestCommentJson,
  type TaskRefJson,
  taskRefOf,
  UUID,
} from '../lib/core'
import { byId } from '../lib/db'
import { vCredentialAccess } from '../lib/enums'
import { badRequest, notFound, type Refusal } from '../lib/functions'
import { aboutShownTasks } from '../lib/workingSet'
import { deleteComment, editComment } from '../model/comments'
import {
  followTask,
  itemMessages,
  markAllMessagesRead,
  markMessagesRead,
  markMessagesUnread,
  removeMessages,
  removeReadMessages,
  snoozeMessages,
  unfollowTask,
} from '../model/messages'
import type { TOOLS } from './mcp'
import type { ROUTES, route as restRoute } from './rest'

type McpTool = (typeof TOOLS)[number]
type RestRoute = (typeof ROUTES)[number]

/* machine/rest.ts route(), which types each `run`'s params from its path.
 * Only its type is imported, so this module does not load rest.ts. */
const route: typeof restRoute = (declared) => declared

/* MCP's result text: 2-space pretty JSON, stringified inside the internal
 * function so the projection's key order is the wire's. */
const pretty = (value: unknown): string => JSON.stringify(value, null, 2)

/* MCP's uniform not-found sentences. */
const mcpTaskMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`task "${ref}" not found (or not visible to you)`)
const mcpCommentMissing = (ref: string): ConvexError<Refusal> =>
  notFound(`comment "${ref}" not found (or not visible to you)`)

/* A REST request body, parsed like machine/rest.ts needJson. */
function jsonBody(raw: string): Record<string, unknown> {
  let body: unknown = null
  try {
    body = JSON.parse(raw)
  } catch {
    body = null
  }
  if (body === null || typeof body !== 'object') throw badRequest('request body must be JSON')
  return body as Record<string, unknown>
}

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
  /** the newest message's instant, or the end of a snooze when later */
  latest_at: string
  snoozed_until: string | null
  /** oldest first */
  messages: InboxMessageJson[]
}

/* (created_at, id), the total order the app and the prune use. */
const newerThan = (a: Doc<'messages'>, b: Doc<'messages'>): boolean =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id)

/**
 * The caller's inbox items about tasks it can read, the latest activity
 * first, as the app folds its messages into items (src/store/viewModels.ts
 * shapeMessageGroup). Rows about a task it cannot read stay stored and come
 * back if it can read the task again. A snoozed item is left out unless
 * `includeSnoozed`, and `unreadOnly` keeps items with an unread message.
 */
async function inboxItems(
  ctx: QueryCtx,
  me: Caller,
  o: { unreadOnly: boolean; includeSnoozed: boolean; limit: number; offset: number },
): Promise<InboxItemJson[]> {
  const rows = await ctx.db
    .query('messages')
    .withIndex('by_recipient', (q) => q.eq('recipient_id', me.id))
    .collect()
  const tasks = new Map<string, Doc<'issues'>>()
  for (const id of new Set(rows.map((row) => row.issue_id))) {
    const task = await byId(ctx, 'issues', id)
    if (task !== null) tasks.set(id, task)
  }
  const shown = await machineShown(tasks.values(), me, projectReader(ctx, me))
  const byTask = new Map<string, Doc<'messages'>[]>()
  for (const row of aboutShownTasks(rows, shown)) {
    const list = byTask.get(row.issue_id)
    if (list === undefined) byTask.set(row.issue_id, [row])
    else list.push(row)
  }
  const names = new Map((await listUsersCore(ctx, me)).map((p) => [p.id, p.name]))
  const items: InboxItemJson[] = []
  for (const [taskId, list] of byTask) {
    const task = tasks.get(taskId)
    if (task === undefined) continue // unreachable: shown tasks were loaded
    list.sort((a, b) => (newerThan(a, b) ? 1 : newerThan(b, a) ? -1 : 0))
    const latest = list[list.length - 1]
    // every row of an item carries the same stamp; the newest decides
    const snoozed_until = latest.snoozed_until ?? null
    if (snoozed_until !== null && !o.includeSnoozed) continue
    const unread_count = list.filter((m) => m.read_at === undefined).length
    if (o.unreadOnly && unread_count === 0) continue
    let latest_at = latest.created_at
    for (const m of list) {
      if (m.woke_at !== undefined && m.woke_at > latest_at) latest_at = m.woke_at
    }
    items.push({
      task: taskRefOf(task),
      unread_count,
      latest_at,
      snoozed_until,
      messages: list.map((m) => ({
        id: m.id,
        kind: m.kind,
        detail: m.detail,
        actor_id: m.actor_id ?? null,
        actor_name: m.actor_id === undefined ? null : (names.get(m.actor_id) ?? null),
        created_at: m.created_at,
        read_at: m.read_at ?? null,
      })),
    })
  }
  items.sort((a, b) =>
    a.latest_at === b.latest_at
      ? a.task.id.localeCompare(b.task.id)
      : a.latest_at < b.latest_at
        ? 1
        : -1,
  )
  return items.slice(o.offset, o.offset + o.limit)
}

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
 */
function inboxRequest(
  action: InboxAction,
  b: { tasks?: unknown; all?: unknown; until?: unknown },
): { refs: string[] | null; until: string | null } {
  if (b.all !== undefined && typeof b.all !== 'boolean')
    throw badRequest('all must be true or false')
  const all = b.all === true
  let refs: string[] | null = null
  if (b.tasks !== undefined) {
    const tasks = b.tasks
    if (!Array.isArray(tasks) || tasks.length === 0 || tasks.some((t) => typeof t !== 'string')) {
      throw badRequest('tasks must be a non-empty list of task refs')
    }
    refs = tasks as string[]
  }
  if (all && refs !== null) throw badRequest('name tasks or set all, not both')
  if (!all && refs === null) throw badRequest('name the inbox items with tasks, or set all to true')
  if (all && action !== 'read' && action !== 'remove') {
    throw badRequest('all applies to read and remove only')
  }
  if (action !== 'snooze') {
    if (b.until !== undefined) throw badRequest('until applies to snooze only')
    return { refs, until: null }
  }
  const until = b.until
  if (until === null) return { refs, until: null }
  if (typeof until !== 'string') {
    throw badRequest('snooze needs until, an ISO date-time, or null to end the snooze')
  }
  return { refs, until }
}

/** What an inbox change did, as the keys of the tasks whose items it
 * changed and whether `all` left rows for another call. */
type InboxChangeJson = { action: InboxAction; tasks: string[]; has_more: boolean }

/**
 * Applies `action` to the caller's inbox items about the named tasks, or
 * with `all` to every item, as the app's Mark all as read and Remove all
 * read notifications do, one bounded batch per call and rows about tasks the
 * caller cannot read included. The answer names only tasks the caller can
 * read. A ref the caller cannot read refuses the whole change with
 * `unknownTask`.
 */
async function changeInbox(
  ctx: MutationCtx,
  me: Caller,
  action: InboxAction,
  req: { refs: string[] | null; until: string | null },
  unknownTask: (ref: string) => ConvexError<Refusal>,
): Promise<InboxChangeJson> {
  const now = new Date().toISOString()
  if (req.refs === null) {
    let done: { rows: Doc<'messages'>[]; more: boolean }
    if (action === 'read') {
      const marked = await markAllMessagesRead(ctx, me, undefined, now)
      done = { rows: marked.marked, more: marked.hasMore }
    } else {
      const removed = await removeReadMessages(ctx, me)
      done = { rows: removed.removed, more: removed.hasMore }
    }
    const touched: Doc<'issues'>[] = []
    for (const id of new Set(done.rows.map((row) => row.issue_id))) {
      const task = await byId(ctx, 'issues', id)
      if (task !== null) touched.push(task)
    }
    const shown = await machineShown(touched, me, projectReader(ctx, me))
    return {
      action,
      tasks: touched
        .filter((task) => shown(task.id))
        .sort((a, b) => a.num - b.num)
        .map((task) => issueKey(task.num)),
      has_more: done.more,
    }
  }
  const named: Doc<'issues'>[] = []
  for (const ref of req.refs) {
    const issue = await findIssue(ctx, me, ref)
    if (issue === null) throw unknownTask(ref)
    if (!named.some((n) => n.id === issue.id)) named.push(issue)
  }
  const rows: Doc<'messages'>[] = []
  for (const issue of named) rows.push(...(await itemMessages(ctx, me, issue.id)))
  const changed =
    action === 'read'
      ? await markMessagesRead(ctx, me, rows, now)
      : action === 'unread'
        ? await markMessagesUnread(ctx, rows)
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

/* A whole-number REST query parameter from `min` to `max`; absent is
 * `fallback`. */
function wholeParam(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
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
  args: { callerId: v.string(), access: vCredentialAccess, comment: v.string(), body: v.string() },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const found = await findComment(ctx, me, a.comment)
    if (found === null) throw mcpCommentMissing(a.comment)
    const now = new Date().toISOString()
    const { comment, changed } = await editComment(ctx, { me, ...found, body: a.body, now })
    const { id, ...out } = await commentOut(ctx, comment, { surface: 'mcp' })
    return pretty({ id, task: issueKey(found.issue.num), changed, ...out })
  },
})

/* delete_comment runs model/comments.ts deleteComment, by the same rule. */
export const mcpDeleteComment = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, comment: v.string() },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const found = await findComment(ctx, me, a.comment)
    if (found === null) throw mcpCommentMissing(a.comment)
    await deleteComment(ctx, { me, ...found })
    return pretty({ deleted: true, id: found.comment.id, task: issueKey(found.issue.num) })
  },
})

/* list_inbox answers the caller's items, 50 by default and at most 200. */
export const mcpListInbox = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    unread_only: v.optional(v.boolean()),
    include_snoozed: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<string> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const items = await inboxItems(ctx, me, {
      unreadOnly: a.unread_only === true,
      includeSnoozed: a.include_snoozed === true,
      limit: Math.min(a.limit ?? 50, 200),
      offset: a.offset ?? 0,
    })
    return pretty(items)
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
    const b = jsonBody(a.body)
    if (typeof b.body !== 'string') throw badRequest('body must be a non-empty string')
    const now = new Date().toISOString()
    const { comment } = await editComment(ctx, { me, ...found, body: b.body, now })
    return (await commentOut(ctx, comment, { surface: 'rest' })) as RestCommentJson
  },
})

/* DELETE /v1/comments/{id}. */
export const restDeleteComment = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, ref: v.string() },
  handler: async (ctx, a): Promise<{ deleted: true; id: string; task_id: string }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const found = await findComment(ctx, me, a.ref)
    if (found === null) throw notFound('comment not found')
    await deleteComment(ctx, { me, ...found })
    return { deleted: true, id: found.comment.id, task_id: found.issue.id }
  },
})

/* GET /v1/inbox?unread_only=&include_snoozed=&limit=&offset= */
export const restListInbox = internalQuery({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    unread_only: v.optional(v.string()),
    include_snoozed: v.optional(v.string()),
    limit: v.optional(v.string()),
    offset: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<InboxItemJson[]> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    return await inboxItems(ctx, me, {
      unreadOnly: flagParam(a.unread_only, 'unread_only'),
      includeSnoozed: flagParam(a.include_snoozed, 'include_snoozed'),
      limit: wholeParam(a.limit, 'limit', 50, 1, 200),
      offset: wholeParam(a.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
    })
  },
})

/* POST /v1/inbox/{read|unread|remove|snooze} {tasks | all, until?}. A body
 * ref the caller cannot read is a 400, like other refs in a REST body. */
export const restUpdateInbox = internalMutation({
  args: { callerId: v.string(), access: vCredentialAccess, action: vInboxAction, body: v.string() },
  handler: async (ctx, a): Promise<InboxChangeJson> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const req = inboxRequest(a.action, jsonBody(a.body))
    return await changeInbox(ctx, me, a.action, req, () =>
      badRequest('tasks must name tasks by key, number or uuid'),
    )
  },
})

/* PUT (following) and DELETE (not following) /v1/tasks/{ref}/following. */
export const restSetFollowing = internalMutation({
  args: {
    callerId: v.string(),
    access: vCredentialAccess,
    ref: v.string(),
    following: v.boolean(),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ id: string; key: string; following: boolean; changed: boolean }> => {
    const me = await asMachineCaller(ctx, a.callerId, a.access)
    const issue = await findIssue(ctx, me, a.ref)
    if (issue === null) throw notFound('task not found')
    const changed = await setFollowing(ctx, me, issue, a.following)
    return { id: issue.id, key: issueKey(issue.num), following: a.following, changed }
  },
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
        "Replace a comment's markdown `body`. `comment` is the comment's id from list_comments. You may edit your own comments, and a project lead any comment in the project. People the edit newly mentions are notified.",
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
          },
        },
        required: ['comment', 'body'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.discussion.mcpUpdateComment, {
        callerId,
        access,
        ...(args as { comment: string; body: string }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'delete_comment',
      title: 'Delete comment',
      description:
        'Delete a comment by its id from list_comments. You may delete your own comments, and a project lead any comment in the project.',
      inputSchema: {
        type: 'object',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          comment: {
            type: 'string',
          },
        },
        required: ['comment'],
      },
    },
    run: (r, { callerId, access, args }) =>
      r.runMutation(internal.machine.discussion.mcpDeleteComment, {
        callerId,
        access,
        ...(args as { comment: string }),
      }),
  },
  {
    access: 'read',
    def: {
      name: 'list_inbox',
      title: 'List inbox',
      description:
        'Your inbox: one item per task you can still read, with its unread count and messages (oldest first), latest activity first. `unread_only` keeps items with unread messages. Snoozed items are left out unless `include_snoozed`. `limit` (50 by default) and `offset` page through the items.',
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
            minimum: 1,
            maximum: 200,
          },
          offset: {
            type: 'integer',
            minimum: 0,
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
        }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'update_inbox',
      title: 'Update inbox',
      description:
        'Apply `action` to your inbox items about `tasks` (task refs): `read`, `unread`, `remove` or `snooze`. With `all: true` instead, `read` marks every item read and `remove` removes every read item; repeat while `has_more` is true. `snooze` needs `until`, an ISO date-time at most a year ahead, or null to bring the items back now; a snoozed item returns unread. The result lists the tasks whose items changed.',
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
          },
          all: {
            type: 'boolean',
          },
          until: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
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
        }),
      }),
  },
  {
    access: 'write',
    def: {
      name: 'set_following',
      title: 'Follow task',
      description:
        'Follow a task (`following: true`) to receive its updates in your inbox, or stop following it. `ref` is a task ID like QN-482 (bare 482 works too) or a uuid. get_task shows `following` and `followers`.',
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

/** The REST routes of this domain. The four inbox actions share one
 * internal function, and so do PUT and DELETE on a task's following. */
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
    run: (r, { callerId, access, param }) =>
      r.runMutation(internal.machine.discussion.restDeleteComment, {
        callerId,
        access,
        ref: param('ref'),
      }),
  }),
  route({
    method: 'GET',
    path: 'inbox',
    access: 'read',
    status: 200,
    run: (r, { callerId, access, query }) =>
      r.runQuery(internal.machine.discussion.restListInbox, {
        callerId,
        access,
        unread_only: query('unread_only'),
        include_snoozed: query('include_snoozed'),
        limit: query('limit'),
        offset: query('offset'),
      }),
  }),
  ...INBOX_ACTIONS.map((action) =>
    route({
      method: 'POST',
      path: `inbox/${action}`,
      access: 'write',
      status: 200,
      run: (r, { callerId, access, body }) =>
        r.runMutation(internal.machine.discussion.restUpdateInbox, {
          callerId,
          access,
          action,
          body,
        }),
    }),
  ),
  route({
    method: 'PUT',
    path: 'tasks/:ref/following',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runMutation(internal.machine.discussion.restSetFollowing, {
        callerId,
        access,
        ref: param('ref'),
        following: true,
      }),
  }),
  route({
    method: 'DELETE',
    path: 'tasks/:ref/following',
    access: 'write',
    status: 200,
    run: (r, { callerId, access, param }) =>
      r.runMutation(internal.machine.discussion.restSetFollowing, {
        callerId,
        access,
        ref: param('ref'),
        following: false,
      }),
  }),
]
