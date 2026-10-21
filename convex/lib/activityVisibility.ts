/* Which task activity rows a member receives, the app's rule, and the pages
 * of one task's history it reads them in. The task window (snapshot.ts
 * commentThread and historyBefore), REST and MCP read the same pages
 * (taskHistoryPage below). Organization admins receive every task row;
 * memberSeesActivity decides for everyone else. Rows about anything but a
 * task reach no client; admins read them in the organization export. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId, usedMoreThan } from './db'
import { badRequest, rule } from './functions'
import { type OrgProjectView, orgProjectView } from './visibility'
import type { Shown } from './workingSet'

/* A project move written before related_project_id existed names a
 * destination that cannot be checked (model/issues.ts moveIssueCore writes
 * "to the <name> sub-project"; status and parent moves say "from" and
 * "under"), so only admins receive it. */
const isUnrecordedProjectMove = (ev: Doc<'activity_events'>): boolean =>
  ev.verb === 'moved' && ev.related_project_id === undefined && !!ev.detail?.startsWith('to the ')

/* Task archive rows used to say 'with N subtasks', counting subtasks in
 * projects a reader may not access (model/issues.ts archiveIssueCore no
 * longer writes it). Members other than admins get such rows without it. */
const LEGACY_SUBTASK_COUNT = /^with \d+ subtasks?$/
function withoutLegacySubtaskCount(ev: Doc<'activity_events'>): Doc<'activity_events'> {
  if (ev.target_type !== 'issue' || ev.verb !== 'archived') return ev
  if (!LEGACY_SUBTASK_COUNT.test(ev.detail ?? '')) return ev
  const { detail: _count, ...rest } = ev
  return rest
}

/* Members other than organization admins receive a task row only if the
 * task is in their working set, which keeps out the history of a task that
 * was deleted, archived or moved to a project the member cannot access, and
 * they can access every project the row names: the project it was filed
 * under and its related project, such as a move's destination. Seeing a
 * parent only to reach one of its sub-projects is not access. Deleting a
 * project clears project_id on its rows (model/deletedItems.ts
 * purgeActivity), so a task that moved out first keeps those rows. A row that
 * names another task (a parent change or a link) also needs access to that
 * task where it is now; one naming a deleted task reaches admins only. Task
 * rows list the tasks they name in named_task_nums, and one without the list
 * fails closed. Rows about anything but a task never reach a member. */
async function memberSeesActivity(
  ev: Doc<'activity_events'>,
  a: {
    view: OrgProjectView
    /* whether the task is in the member's working set */
    inWorkingSet: Shown
    /* the current project of the org's task with this number, if any */
    taskProject: (num: number) => Promise<string | undefined>
  },
): Promise<boolean> {
  if (ev.target_type !== 'issue') return false
  if (ev.related_project_id !== undefined && !a.view.accessible(ev.related_project_id)) return false
  if (!a.inWorkingSet(ev.target_id)) return false
  if (isUnrecordedProjectMove(ev)) return false
  if (ev.project_id !== undefined && !a.view.accessible(ev.project_id)) return false
  const named = ev.named_task_nums
  if (named === undefined) return false
  for (const num of named) {
    const projectId = await a.taskProject(num)
    if (projectId === undefined || !a.view.accessible(projectId)) return false
  }
  return true
}

/** How full a member's history page may get while it looks up the
 * tasks its rows name (lib/db.ts usedMoreThan). Each lookup reads a whole
 * task, and a row can name two. Past `room`, a row naming a task not yet
 * looked up is left out, so the read fails closed instead of failing on
 * Convex's limits. The rest serves the caller: commentThread has read its
 * comments already, and REST and MCP read one profile per actor next
 * (machine/records.ts activityOut). Tests may lower it. */
export const NAMED_TASK_ROOM = { room: 0.8 }

/** The most rows one page of a task's history holds. The task window shows
 * the newest page beside its comments and loads earlier pages on request,
 * and REST and MCP answer one page a call. */
export const HISTORY_PAGE_MAX = 500

/** How full a member's history page may get before it stops reading on
 * (lib/db.ts usedMoreThan). Rows a member does not receive are read and
 * left out, so a page reads on until it holds HISTORY_PAGE_MAX rows, the
 * history ends or the read passes `room`. Tests may lower it. */
export const HISTORY_ROOM = { room: 0.7 }

/** The refusal for a member's page that passed HISTORY_ROOM before it found
 * one row the member receives, so an empty page never claims the history
 * ends. Only thousands of rows in a row naming projects or tasks the member
 * cannot see lead to it. */
export const HISTORY_HIDDEN =
  "too many of this task's changes are hidden from you to read them at once; an organization admin can read them"

/** The refusal for a `before` that names no row of the task's history. */
export const BEFORE_NOT_A_CHANGE = "before must be the id of a row in this task's history"

/**
 * The history row `ref` names on task `issue`, as the `before` of a page of
 * earlier history. Accepts the id in any case. Refuses anything else, rows
 * of other tasks included, so a `before` reveals nothing about other tasks.
 */
export async function historyAnchor(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  ref: string,
): Promise<Doc<'activity_events'>> {
  const anchor = await byId(ctx, 'activity_events', ref.toLowerCase())
  if (
    anchor === null ||
    anchor.org_id !== issue.org_id ||
    anchor.target_type !== 'issue' ||
    anchor.target_id !== issue.id
  ) {
    throw badRequest(BEFORE_NOT_A_CHANGE)
  }
  return anchor
}

/* Reads the history rows of `issue` newest first in by_target order, which
 * is insertion order, from just below `before` or from the newest. Each call
 * of the answer returns the next `n` rows, fewer only where the history
 * ends. Rows that share a _creationTime are passed by count, as
 * model/comments.ts newestComments passes comments; the ones that share the
 * anchor's are read once, whole, to find where it stands among them. */
async function olderRows(
  ctx: QueryCtx,
  issue: Doc<'issues'>,
  before: Doc<'activity_events'> | undefined,
): Promise<(n: number) => Promise<Doc<'activity_events'>[]>> {
  // the task's rows, those at `time` or older than it (`lt`, `lte`), newest first
  const history = (time?: { at: number; op: 'eq' | 'lt' | 'lte' }) =>
    ctx.db
      .query('activity_events')
      .withIndex('by_target', (q) => {
        const own = q
          .eq('org_id', issue.org_id)
          .eq('target_type', 'issue')
          .eq('target_id', issue.id)
        if (time === undefined) return own
        if (time.op === 'eq') return own.eq('_creationTime', time.at)
        return time.op === 'lt'
          ? own.lt('_creationTime', time.at)
          : own.lte('_creationTime', time.at)
      })
      .order('desc')
  let queued: Doc<'activity_events'>[] = []
  // the _creationTime of the last row passed, how many rows at that time are
  // behind, and with `below`, that every row at that time is
  let at = before?._creationTime
  let passed = 0
  let below = false
  if (before !== undefined) {
    const tied = await history({ at: before._creationTime, op: 'eq' }).collect()
    queued = tied.slice(tied.findIndex((row) => row._id === before._id) + 1)
    below = true
  }
  return async (n) => {
    const out = queued.splice(0, n)
    if (out.length === n) return out
    const skip = below ? 0 : passed
    const from = at
    const under = below
    const rows = await history(
      from === undefined ? undefined : { at: from, op: under ? 'lt' : 'lte' },
    ).take(skip + n - out.length)
    below = false
    for (const row of rows.slice(skip)) {
      if (row._creationTime === at) passed += 1
      else {
        at = row._creationTime
        passed = 1
      }
      out.push(row)
    }
    return out
  }
}

/**
 * One page of the history of `issue` that `me` receives, the history the
 * task window shows beside its comments. It holds the newest
 * HISTORY_PAGE_MAX rows `me` receives, or with `before` the newest ones
 * before that row (historyAnchor), oldest first in insertion order, which
 * follows time, so the page's first row is the `before` of the page before
 * it. `earlier` says whether the history holds rows before the oldest row
 * the page read, which `me` may or may not receive. The caller has already resolved a task `me` can read (lib/core.ts
 * findIssue), which counts as the task being shown, as every machine read
 * counts the tasks it can read, archived ones included. Organization admins
 * receive every row; other members get the rows memberSeesActivity allows,
 * without legacy subtask counts. For members it also reads the
 * organization's projects and grants (lib/visibility.ts orgProjectView) and
 * one task for each distinct number the rows name, until the read passes
 * NAMED_TASK_ROOM; rows naming a task it could not look up are left out. A
 * member's page reads on past rows it leaves out until HISTORY_ROOM, and
 * refuses with HISTORY_HIDDEN when that leaves it empty with history left.
 */
export async function taskHistoryPage(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  issue: Doc<'issues'>,
  before?: Doc<'activity_events'>,
): Promise<{ rows: Doc<'activity_events'>[]; earlier: boolean }> {
  const read = await olderRows(ctx, issue, before)
  const admin = me.org_role === 'admin'
  let sees: ((ev: Doc<'activity_events'>) => Promise<boolean>) | undefined
  const newest: Doc<'activity_events'>[] = []
  let earlier = false
  for (;;) {
    // one row past the page tells whether the history goes on
    const n = HISTORY_PAGE_MAX - newest.length + 1
    const rows = await read(n)
    let full = false
    for (const ev of rows) {
      if (newest.length === HISTORY_PAGE_MAX) {
        full = true
        break
      }
      sees ??= admin ? async () => true : await memberSight(ctx, me, issue)
      if (await sees(ev)) newest.push(admin ? ev : withoutLegacySubtaskCount(ev))
    }
    if (full) {
      earlier = true
      break
    }
    if (rows.length < n) break
    if (!admin && (await usedMoreThan(ctx, HISTORY_ROOM.room))) {
      if (newest.length === 0) throw rule(HISTORY_HIDDEN)
      earlier = true
      break
    }
  }
  return { rows: newest.reverse(), earlier }
}

/** Which of `rows`, rows of the history of `issue`, `me` receives, in their
 * order: all of them for an organization admin, else those
 * memberSeesActivity allows (memberSight). */
export async function receivedRows(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  issue: Doc<'issues'>,
  rows: Doc<'activity_events'>[],
): Promise<Doc<'activity_events'>[]> {
  if (me.org_role === 'admin' || rows.length === 0) return rows
  const sees = await memberSight(ctx, me, issue)
  const out: Doc<'activity_events'>[] = []
  for (const ev of rows) if (await sees(ev)) out.push(ev)
  return out
}

/* Whether member `me` receives a row about `issue` (memberSeesActivity),
 * with the organization's projects read once and each named task looked up
 * once, until the read passes NAMED_TASK_ROOM. */
async function memberSight(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  issue: Doc<'issues'>,
): Promise<(ev: Doc<'activity_events'>) => Promise<boolean>> {
  const view = await orgProjectView(ctx, me)
  const projects = new Map<number, Promise<string | undefined>>()
  const taskProject = async (num: number): Promise<string | undefined> => {
    let found = projects.get(num)
    if (found === undefined) {
      // no room to look it up: unknown, so the row is left out
      if (await usedMoreThan(ctx, NAMED_TASK_ROOM.room)) return undefined
      found = ctx.db
        .query('issues')
        .withIndex('by_org_num', (q) => q.eq('org_id', issue.org_id).eq('num', num))
        .first()
        .then((task) => task?.project_id)
      projects.set(num, found)
    }
    return await found
  }
  return (ev) =>
    memberSeesActivity(ev, { view, inWorkingSet: (taskId) => taskId === issue.id, taskProject })
}
