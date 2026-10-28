/* The readers behind the task window's own queries (taskWindow.ts): the
 * opened task with its parent and subtasks (readWindowTask), its links
 * (readWindowLinks) and its attachment list (readWindowAttachments).
 *
 * Each reads the opened task by id, or by its number in the caller's
 * organization, the caller's access to it (lib/access.ts accessOf), and the
 * task's own index ranges with the tasks and projects their rows name:
 * its active subtasks (issues by_parent_archived), its links (issue_links
 * by_source and by_target), its labels, the caller's follow and its
 * attachments (by_issue, by_issue_profile). None reads a range of the
 * organization or of a project, so a task opens in a project of any size
 * and from a fresh app session, and an edit elsewhere in the organization
 * reruns none of them.
 *
 * They say of a task what the tasks part says of it
 * (lib/workspaceParts.ts readTasks), under the same rules
 * (lib/workingSet.ts): a task outside the caller's working set answers
 * `unavailable` alike for every reason, and a parent, subtask or link end
 * goes out only when the caller is shown it. A hidden subtask only sets
 * has_hidden_subtasks, and a link to a task the caller is not shown is left
 * out with its id and the other end's.
 *
 * A task body is one document of up to Convex's 1 MiB while descriptions
 * stay on task rows, so the subtask read and the read of link ends take
 * bodies only as far as TASK_WINDOW allows. A read takes no more bodies at
 * a time than its unspent bytes hold at that size (Room), as
 * model/comments.ts newestComments steps, and a list it stops early answers
 * `complete: false` with the rows it read, never an error. Every row a list
 * answers has its group fact (groupsOf); a row whose fact the budget left
 * unread is left out of a list that says it is incomplete. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { descriptionOf } from '../model/descriptions'
import { type Access, accessOf } from './access'
import { archivedTaskCore } from './archivedTasks'
import { byId } from './db'
import type { AccessLevel } from './enums'
import { MIB } from './limits'
import { parseIssueRef } from './taskRefs'
import { linkShown, parentLink } from './workingSet'
import { relationRow, type TaskRow, taskFields } from './workspaceParts'

/** The task window's read budgets, which tests lower.
 *
 * `rows` stops the subtask read and the read of link ends, twice
 * LIMITS.subtasks.max and LIMITS.links.max (100 each), room for data stored
 * before those limits. Label rows stop there too, ten times
 * LIMITS.labels.max.
 *
 * `bytes` and `linkBytes` cap what readWindowTask and readWindowLinks read,
 * not counting the caller's own grants, memberships and team shares
 * (lib/access.ts projectLevelsOf shared), which every read of theirs
 * repeats. A read passes its cap by one task body at most, in its last
 * group check (Room), so its worst case is the cap, one row near 1 MiB and
 * those shared reads (well under 1 MiB, OWN_READS): about 9.5 MiB for a
 * task and 14.5 MiB for its links, under Convex's 16 MiB. At the 20,000-character description cap in
 * a three-byte script, 100 subtasks read about 6.1 MB, and fit in `bytes`
 * with the task, its text and its parent. A linked group also reads its
 * first counting subtask (groupsOf), so 100 linked groups at the cap read
 * about 12.2 MB, which `linkBytes` holds.
 *
 * `attachments` stops the attachment read: three times
 * LIMITS.attachments.max, for the counted rows, the description images a
 * save took out within the day (up to as many) and data stored before the
 * limit. Attachment rows are small (model/attachments.ts). */
export const TASK_WINDOW = {
  rows: 200,
  bytes: 8 * MIB,
  linkBytes: 13 * MIB,
  attachments: 300,
}

/** A task in one of the window's lists: the row the tasks part sends
 * (TaskRow) without its text, parent and hidden facts, with whether it is a
 * group (an active subtask in a live project makes it one,
 * lib/liveTasks.ts countsAsSubtask) and the caller's level on its project.
 * Status, owners, dates, remaining hours and pause stay, because the window
 * computes a group's progress, remaining total and plan span from its
 * subtasks. */
export type ShortRow = Omit<
  TaskRow,
  'description' | 'parent_id' | 'has_hidden_parent' | 'has_hidden_subtasks' | 'has_subtasks'
> & { has_subtasks: boolean; level: AccessLevel }

/** What a read answers for a task the caller may not open, alike for every
 * reason. */
const UNAVAILABLE = { state: 'unavailable' as const }

/** How many task bodies a read may take before it asks again: as many as
 * the unspent bytes hold at Convex's document size limit. With `last`, one
 * more while any bytes are unspent, so those reads pass the budget by one
 * body at most. A list's own rows take bodies without `last`, so they
 * never pass the budget and leave room for the group checks after them
 * (groupsOf), most of which read no body, and which take `last`. */
type Room = (last?: 'last') => Promise<number>

/** A Room for `bytes` of the transaction's reads, less `shared`, the
 * caller's own rows that lib/access.ts projectLevelsOf counts as it reads
 * them (as lib/workspaceParts.ts readPast leaves them out). */
function roomIn(ctx: QueryCtx, bytes: number, shared: { bytes: number }): Room {
  return async (last) => {
    const m = await ctx.meta.getTransactionMetrics()
    const left = bytes - (m.bytesRead.used - shared.bytes)
    const whole = Math.floor(left / DOCUMENT_MAX_BYTES)
    return left <= 0 ? 0 : last === 'last' ? Math.max(1, whole) : whole
  }
}

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order, as
 * src/store/taskIndex.ts byThenId compares. */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/* Rows by created_at, then id, as src/store/taskIndex.ts orders links and
 * attachments. */
const byCreation = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  order(a.created_at, b.created_at) || order(a.id, b.id)

/* Tasks by number, then id, as src/store/taskIndex.ts childKeysOf orders
 * subtasks. */
const byNumber = (a: ShortRow, b: ShortRow) => a.num - b.num || order(a.id, b.id)

/* The active subtasks of the task with this id, oldest first. */
const activeKids = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('issues')
    .withIndex('by_parent_archived', (q) => q.eq('parent_id', id).eq('archived_at', undefined))

/* `task`, which the caller is shown, as a ShortRow. */
const shortRow = (task: Doc<'issues'>, has_subtasks: boolean, level: AccessLevel): ShortRow => ({
  ...taskFields(task),
  has_subtasks,
  level,
})

/** The task `ref` names in organization `orgId`: a uuid in any case, or its
 * number, bare or as QN-12 (lib/taskRefs.ts parseIssueRef). A number names
 * a task of that organization only, never another's with the same number,
 * and a uuid of another organization's task names none. */
async function taskByRef(ctx: QueryCtx, orgId: string, ref: string) {
  const parsed = parseIssueRef(ref)
  if (parsed === null) return null
  const task =
    'uuid' in parsed
      ? await byId(ctx, 'issues', parsed.uuid)
      : await ctx.db
          .query('issues')
          .withIndex('by_org_num', (q) => q.eq('org_id', orgId).eq('num', parsed.num))
          .unique()
  return task !== null && task.org_id === orgId ? task : null
}

/** The task with id `issueId` and the caller's access, when the task is in
 * the caller's working set (lib/workingSet.ts, Access.holds), else null. */
async function openedTask(ctx: QueryCtx, me: Doc<'profiles'>, issueId: string) {
  const task = await byId(ctx, 'issues', issueId)
  if (task === null || task.org_id !== me.org_id) return null
  const access = accessOf(ctx, me)
  return (await access.holds(task)) ? { task, access } : null
}

/** The first `most` active subtasks of the task with this id, oldest
 * first, read one at a time while `room` allows. `complete` says they are
 * all of them: the read reached the range's end, not the row past `most`
 * or the end of the room. */
async function subtasksOf(ctx: QueryCtx, id: string, room: Room, most: number) {
  const rows: Doc<'issues'>[] = []
  let left = await room()
  if (left === 0) return { rows, complete: false }
  for await (const kid of activeKids(ctx, id)) {
    if (rows.length === most) return { rows, complete: false }
    rows.push(kid)
    left -= 1
    if (left === 0) left = await room()
    if (left === 0) return { rows, complete: false }
  }
  return { rows, complete: true }
}

/** The tasks with these ids, by id and in order, null for one that is
 * gone, in steps `room` allows. `complete` says it read them all. */
async function tasksById(ctx: QueryCtx, ids: readonly string[], room: Room) {
  const tasks: (Doc<'issues'> | null)[] = []
  while (tasks.length < ids.length) {
    const n = await room()
    if (n === 0) return { tasks, complete: false }
    const step = ids.slice(tasks.length, tasks.length + n)
    tasks.push(...(await Promise.all(step.map((id) => byId(ctx, 'issues', id)))))
  }
  return { tasks, complete: true }
}

/** Whether each of `tasks`, which the caller is shown, so active tasks in
 * live projects, is a group: whether an active subtask of it is in a live
 * project (lib/liveTasks.ts countsAsSubtask). Undefined where `room` ran
 * out first. It reads each task's active subtasks, oldest first, only until
 * one counts: one index range and no body for a task without any, as most
 * subtasks are, and usually one body for a group. Each step reads the next
 * subtask of as many undecided tasks as `room` allows, one while any bytes
 * are unspent ('last'). */
async function groupsOf(
  ctx: QueryCtx,
  access: Access,
  tasks: readonly Doc<'issues'>[],
  room: Room,
): Promise<(boolean | undefined)[]> {
  const groups: (boolean | undefined)[] = tasks.map(() => undefined)
  const streams = new Map<number, AsyncIterator<Doc<'issues'>>>()
  let open = tasks.map((_, at) => at)
  try {
    while (open.length > 0) {
      const n = await room('last')
      if (n === 0) break
      const step = open.slice(0, n)
      open = open.slice(n)
      const next = await Promise.all(
        step.map((at) => {
          let kids = streams.get(at)
          if (kids === undefined) {
            kids = activeKids(ctx, tasks[at].id)[Symbol.asyncIterator]()
            streams.set(at, kids)
          }
          return kids.next()
        }),
      )
      const counts = await Promise.all(
        next.map((kid) => (kid.done === true ? false : access.live(kid.value.project_id))),
      )
      for (const [i, at] of step.entries()) {
        if (next[i].done === true) groups[at] = false
        else if (counts[i]) groups[at] = true
        else open.push(at)
      }
    }
  } finally {
    await Promise.all([...streams.values()].map((kids) => kids.return?.()))
  }
  return groups
}

/** `tasks`, each shown to the caller, as short rows in their order. A task
 * whose group fact `room` left unread (groupsOf) is left out, and
 * `complete` says none was. The levels are those the caller's access read
 * when it found the tasks shown. */
async function shortRows(
  ctx: QueryCtx,
  access: Access,
  tasks: readonly Doc<'issues'>[],
  room: Room,
) {
  const levels = await Promise.all(tasks.map((task) => access.level(task.project_id)))
  const groups = await groupsOf(ctx, access, tasks, room)
  const rows: ShortRow[] = []
  for (const [i, task] of tasks.entries()) {
    const group = groups[i]
    const level = levels[i]
    if (group !== undefined && level !== null) rows.push(shortRow(task, group, level))
  }
  return { rows, complete: groups.every((group) => group !== undefined) }
}

/** The parent of `task` as a short row when the caller is shown it, else
 * null. `task` is in the caller's working set, so an active subtask in a
 * live project, which makes a parent the caller is shown a group without
 * another read. */
async function shownParent(
  ctx: QueryCtx,
  access: Access,
  task: Doc<'issues'>,
): Promise<ShortRow | null> {
  if (task.parent_id === undefined) return null
  const parent = await byId(ctx, 'issues', task.parent_id)
  if (parent === null || parent.org_id !== task.org_id || !(await access.holds(parent))) return null
  const level = await access.level(parent.project_id)
  return level === null ? null : shortRow(parent, true, level)
}

/**
 * The task window's task: the task `ref` names in the caller's
 * organization (taskByRef) with what the window shows beside it.
 *
 * - `{ state: 'ok', task, level, labels, follow, parent, subtasks }` for a
 *   task in the caller's working set. `task` is the row the tasks part
 *   sends for it (TaskRow): its text from its description row
 *   (model/descriptions.ts descriptionOf, as every reader takes it since
 *   the second release of the move), its parent's id only when the caller
 *   is shown the parent, has_subtasks and has_hidden_subtasks. `level` is
 *   the caller's level on its project, `labels` its label rows (at most
 *   TASK_WINDOW.rows), `follow` the caller's follow or null, and `parent`
 *   the parent as a short row when the caller is shown it, else null.
 *   `subtasks.rows` are its active subtasks in live projects that the
 *   caller is shown, as short rows by number and then id. A subtask in an
 *   archived project is neither a row nor hidden. A live one the caller is
 *   not shown sets has_hidden_subtasks and sends no row.
 * - `{ state: 'archived', task }` for an archived task of the organization
 *   that the Archived tasks page lists for the caller (lib/archivedTasks.ts
 *   archivedTaskCore), with that page's row, which holds no text. It asks
 *   with the caller's seat in this organization only, never another seat
 *   of the login (lib/functions.ts loadMember), so another organization's
 *   archived task answers unavailable.
 * - `{ state: 'unavailable' }` for everything else, alike.
 *
 * The subtasks load with the task because the window needs the group facts
 * at once: the status control, the owner rule and the remaining total
 * depend on whether the task is a group. Past TASK_WINDOW the subtasks
 * answer `complete: false` with the rows read; has_subtasks then says
 * whether one read counts, and has_hidden_subtasks is true, so the window
 * can say its completion is unknown. A subtask whose own has_subtasks is
 * true is a group stored before the rule of one level, and the answer holds
 * none of its subtasks, so the app must treat a remaining total or progress
 * that needs its leaves as unknown (src/store/planner.ts remainingOf and
 * progressOf walk every descendant).
 */
export async function readWindowTask(ctx: QueryCtx, me: Doc<'profiles'>, ref: string) {
  const task = await taskByRef(ctx, me.org_id, ref)
  if (task === null) return UNAVAILABLE
  if (task.archived_at !== undefined) {
    const row = await archivedTaskCore(ctx, new Map([[me.org_id, me]]), task.id)
    return row === null ? UNAVAILABLE : { state: 'archived' as const, task: row }
  }
  const access = accessOf(ctx, me)
  if (!(await access.holds(task))) return UNAVAILABLE
  // the reads every answer needs, before the subtasks spend the rest
  const [level, labels, follow, parent, description] = await Promise.all([
    access.level(task.project_id),
    ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .take(TASK_WINDOW.rows),
    ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_profile', (q) => q.eq('issue_id', task.id).eq('profile_id', me.id))
      .unique(),
    shownParent(ctx, access, task),
    descriptionOf(ctx.db, task),
  ])
  if (level === null) return UNAVAILABLE
  const room = roomIn(ctx, TASK_WINDOW.bytes, access.shared)
  const kids = await subtasksOf(ctx, task.id, room, TASK_WINDOW.rows)
  const live = await Promise.all(kids.rows.map((kid) => access.live(kid.project_id)))
  const counting = kids.rows.filter((_, i) => live[i])
  const seen = await Promise.all(counting.map((kid) => access.visible(kid.project_id)))
  const shown = await shortRows(
    ctx,
    access,
    counting.filter((_, i) => seen[i]),
    room,
  )
  const complete = kids.complete && shown.complete
  const row: TaskRow = {
    ...taskFields(task),
    description,
    ...parentLink(task, () => parent !== null),
    has_subtasks: counting.length > 0,
    has_hidden_subtasks: !complete || seen.some((visible) => !visible),
  }
  return {
    state: 'ok' as const,
    task: row,
    level,
    labels: labels.map(relationRow),
    follow: follow === null ? null : relationRow(follow),
    parent,
    subtasks: { rows: shown.rows.sort(byNumber), complete },
  }
}

/**
 * The task window's links of the task with id `issueId`.
 *
 * - `{ state: 'ok', links, tasks, complete }` for a task in the caller's
 *   working set. `links` are its link rows as source and as target whose
 *   other end the caller is shown (lib/workingSet.ts linkShown), by
 *   created_at and then id, from which the app derives each link's
 *   direction and type. `tasks` holds each such other end once, as a short
 *   row. Both ranges are read whatever their rows' archive marks, because
 *   the other end's check decides: a link to a hidden, archived or deleted
 *   task or one in an archived project is left out, and neither its id nor
 *   the other end's is in the answer. A link grants no access.
 * - `{ state: 'unavailable' }` otherwise, alike for every reason.
 *
 * Past TASK_WINDOW.rows links or TASK_WINDOW.linkBytes it answers
 * `complete: false` with the links whose other end it read.
 */
export async function readWindowLinks(ctx: QueryCtx, me: Doc<'profiles'>, issueId: string) {
  const opened = await openedTask(ctx, me, issueId)
  if (opened === null) return UNAVAILABLE
  const { task, access } = opened
  const [outgoing, incoming] = await Promise.all([
    ctx.db
      .query('issue_links')
      .withIndex('by_source', (q) => q.eq('source_id', task.id))
      .take(TASK_WINDOW.rows + 1),
    ctx.db
      .query('issue_links')
      .withIndex('by_target', (q) => q.eq('target_id', task.id))
      .take(TASK_WINDOW.rows + 1),
  ])
  const all = [...outgoing, ...incoming].sort(byCreation)
  const read = all.slice(0, TASK_WINDOW.rows)
  const otherEnd = (link: Doc<'issue_links'>) =>
    link.source_id === task.id ? link.target_id : link.source_id
  const room = roomIn(ctx, TASK_WINDOW.linkBytes, access.shared)
  const ends = await tasksById(ctx, [...new Set(read.map(otherEnd))], room)
  const held = await Promise.all(
    ends.tasks.map(async (end) => end !== null && end.org_id === me.org_id && access.holds(end)),
  )
  const shown = await shortRows(
    ctx,
    access,
    ends.tasks.filter((end, i): end is Doc<'issues'> => end !== null && held[i]),
    room,
  )
  const ids = new Set([task.id, ...shown.rows.map((row) => row.id)])
  return {
    state: 'ok' as const,
    links: read.filter((link) => linkShown(link, (id) => ids.has(id))).map(relationRow),
    tasks: shown.rows,
    complete: all.length <= TASK_WINDOW.rows && ends.complete && shown.complete,
  }
}

/**
 * The task window's attachment list of the task with id `issueId`.
 *
 * - `{ state: 'ok', rows, count, complete }` for a task in the caller's
 *   working set. `rows` are its attachment rows, files and description
 *   images, those a description save took out within the day (dropped_at)
 *   included, oldest first by created_at and then id. `count` is the number
 *   without dropped_at, the one LIMITS.attachments.max counts. No file
 *   contents and no URLs: the app mints those for the rows it opens
 *   (files.ts mintUrls).
 * - `{ state: 'unavailable' }` otherwise, alike for every reason.
 *
 * It reads one by_issue range, and past TASK_WINDOW.attachments rows
 * answers `complete: false` with the first of them.
 */
export async function readWindowAttachments(ctx: QueryCtx, me: Doc<'profiles'>, issueId: string) {
  const opened = await openedTask(ctx, me, issueId)
  if (opened === null) return UNAVAILABLE
  const read = await ctx.db
    .query('issue_attachments')
    .withIndex('by_issue', (q) => q.eq('issue_id', opened.task.id))
    .take(TASK_WINDOW.attachments + 1)
  const rows = read.slice(0, TASK_WINDOW.attachments).sort(byCreation)
  return {
    state: 'ok' as const,
    rows: rows.map(relationRow),
    count: rows.filter((row) => row.dropped_at === undefined).length,
    complete: read.length <= TASK_WINDOW.attachments,
  }
}
