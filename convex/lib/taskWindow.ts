/* The readers behind the task window's own queries (taskWindow.ts): the
 * opened task with its parent and subtasks (readWindowTask), its links
 * (readWindowLinks) and its attachment list (readWindowAttachments).
 *
 * Each reads the opened task by id, or by its number in the caller's
 * organization, the caller's access to it (lib/access.ts accessOf), and the
 * task's own index ranges with the tasks and projects their rows name:
 * its active subtasks (issues by_parent_archived), its links (issue_links
 * by_source and by_target), its labels, the caller's follow and its
 * attachments (by_issue, by_issue_profile). None reads the tasks of a
 * project or of the organization, so a task opens in a project of any size
 * and from a fresh app session. The caller's access reads the caller's own
 * grants, memberships and team shares, and the projects, grants and shares
 * of the projects asked about. Where a top-level project shows the caller
 * only for navigation, it also reads the caller's reach rows under it and
 * the sub-projects they name, once the organization's are complete, or
 * else that project's sub-projects and, for a caller in many teams, the
 * organization's teams (lib/access.ts projectLevelsOf), so an edit of those
 * reruns a read, as it reruns the workspace parts. No other edit elsewhere
 * in the organization does. A check of the caller's access that a bound of
 * those reads stopped (accessUnchecked) answers the opened task
 * `unavailable` where it is the task's or its parent's, and ends a list as
 * incomplete where it is a subtask's or a link end's.
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
 * bodies, and ask the caller's access about projects (PROJECT), only as far
 * as TASK_WINDOW allows. A read takes no more of them at a time than what
 * it has left holds at that size, in bytes, documents and index ranges
 * (budgetIn), as
 * model/comments.ts newestComments steps by bytes, and a list it stops
 * early answers `complete: false` with the rows it read, never an
 * error. Every row a list
 * answers has its group fact (groupsOf); a row whose fact the budget left
 * unread is left out of a list that says it is incomplete. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { descriptionOf } from '../model/descriptions'
import { type Access, accessOf, isAccessUnchecked, OWN_READS } from './access'
import { archivedRowOf } from './archivedTasks'
import { byId } from './db'
import type { AccessLevel } from './enums'
import { MIB, PROJECT_ROW_MAX_BYTES, TEAM_ROW_MAX_BYTES } from './limits'
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
 * `bytes` and `linkBytes` cap the bytes readWindowTask and readWindowLinks
 * read, and `documents` and `ranges` the documents and index ranges each
 * reads, not counting the caller's own grants, memberships and team shares
 * (lib/access.ts projectLevelsOf shared), which every read of theirs
 * repeats. A read looks at its budget before each step (budgetIn): a step
 * takes only the task bodies that fit whole, each up to Convex's 1 MiB,
 * and asks the caller's access about the projects it has not read yet one
 * at a time, each only while PROJECT fits (inOrder). Only a group check may
 * take one body more while some of every count is left. So a read passes
 * a cap by one task body at most, or by what the project it asked about
 * last reads past PROJECT: past the ten shares PROJECT's bytes hold at the
 * name caps, up to lib/access.ts OWN_READS.projectShares and one more on
 * the project and on its top-level project, about 1.3 MiB more at the
 * caps, and past those the caller's own rows, which count as shared.
 * Besides that, its worst case is the cap, 1 MiB past it and the shared
 * reads (OWN_READS states them): at most 266 ranges and 7,098 documents,
 * up to about 1.2 MiB of the organization's teams, which counts JSON, and
 * the person's own rows, a few hundred bytes each at ordinary name
 * lengths. A task's project is a sub-project, so the window navigates only
 * for a task an earlier version stored on a top-level project. With few of
 * those rows a task reads at most about 10 MiB and its links about 15.2 to
 * 15.5 MiB, under Convex's 16 MiB; a person with thousands of those rows
 * near the name caps can still make a read of links pass it. The shared
 * reads and the instance's own (at most 193 ranges and 705 documents)
 * count past `ranges` and `documents` too, under 4,096 and 32,000. At
 * the 20,000-character description cap in a three-byte script, 100
 * subtasks read about 6.1 MB, and fit in `bytes` with the task, its text
 * and its parent. A linked group also reads its first counting subtask
 * (groupsOf), so 100 linked groups at the cap read about 12.2 MB, which
 * `linkBytes` holds.
 *
 * `attachments` stops the attachment read: three times
 * LIMITS.attachments.max, for the counted rows, the description images a
 * save took out within the day (up to as many) and data stored before the
 * limit. Attachment rows are small (model/attachments.ts). */
export const TASK_WINDOW = {
  rows: 200,
  bytes: 8 * MIB,
  linkBytes: 13 * MIB,
  documents: 16_000,
  ranges: 2000,
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

/** Reads by Convex's counts of a transaction's reads. */
type Reads = { bytes: number; documents: number; ranges: number }

/** A task body, read by id or as the next row of a stream: one document of
 * up to Convex's size limit, and an index range for the stream it may
 * open. */
const BODY: Reads = { bytes: DOCUMENT_MAX_BYTES, documents: 1, ranges: 1 }

/** The team shares one question of lib/access.ts projectLevelsOf reads of
 * a project, and of its top-level project, before it turns to the caller's
 * own rows: OWN_READS.projectShares and the one more that tells it to. */
const SHARES = OWN_READS.projectShares + 1

/** The team shares PROJECT's bytes hold at the name caps, as
 * lib/archivedTasks.ts ARCHIVE_RESERVE holds a project shared with about ten
 * teams; at ordinary name lengths, about 300 bytes a row, they hold SHARES. */
const SHARE_BYTES = 10

/** What the caller's access reads for a project it has not read yet, one
 * question at its worst (lib/access.ts projectLevelsOf), on the project and
 * on its top-level project: the row, at most lib/limits.ts
 * PROJECT_ROW_MAX_BYTES, the caller's grant and the range of its team
 * shares, and for each of SHARES shares the share, the caller's membership
 * and the team, each read once a query. Its bytes count SHARE_BYTES of those
 * at TEAM_ROW_MAX_BYTES, so a project shared with more teams at the name
 * caps passes them by up to about 1.3 MiB, past which the access reads the
 * caller's own rows, counted as shared, or asks their teams one by one,
 * within OWN_READS.teamReads for the query. The next look at the budget
 * counts what it read, before the read asks about another project
 * (inOrder), as it counts navigation under a top-level project the caller
 * holds no level on. */
const PROJECT: Reads = {
  bytes: 2 * (PROJECT_ROW_MAX_BYTES + (1 + 3 * SHARE_BYTES) * TEAM_ROW_MAX_BYTES),
  documents: 2 * (2 + 3 * SHARES),
  ranges: 2 * (3 + 2 * SHARES),
}

/** What a list keeps back for the group check (groupsOf) of each row it
 * read, so the checks can run once the list's own reads have taken what
 * fits: the index range of the row's subtasks and the document of its first
 * one. A check's body bytes are not kept back, since a check takes one
 * while any bytes are left ('last'), and most rows have no subtasks. */
const CHECK = { documents: 1, ranges: 1 }

/** A read's budget `cap` (TASK_WINDOW) on its own reads: the transaction's
 * reads less `shared`, the caller's own rows that lib/access.ts
 * projectLevelsOf counts as it reads them (as lib/workspaceParts.ts
 * readPast leaves them out). It knows the projects whose access the read
 * has asked about, which cost nothing more to ask again. */
function budgetIn(ctx: QueryCtx, cap: Reads, shared: Reads) {
  const asked = new Set<string>()
  /** How many reads of `cost` the reads left under `cap` hold, on every
   * count, 0 once one is spent, keeping back CHECK for each of `checks`
   * group checks to come. A list's own rows and the projects read for them
   * take only what fits, so they never pass `cap` and leave room for the
   * group checks after them (groupsOf), most of which read no body. With
   * 'last', as a group check's body, one more while some of every count is
   * left, so those reads pass `cap` by one at most. */
  const fits = async (cost: Reads, last?: 'last', checks = 0): Promise<number> => {
    const m = await ctx.meta.getTransactionMetrics()
    const left = {
      bytes: cap.bytes - (m.bytesRead.used - shared.bytes),
      documents:
        cap.documents - (m.documentsRead.used - shared.documents) - checks * CHECK.documents,
      ranges: cap.ranges - (m.databaseQueries.used - shared.ranges) - checks * CHECK.ranges,
    }
    if (left.bytes <= 0 || left.documents <= 0 || left.ranges <= 0) return 0
    const whole = Math.min(
      Math.floor(left.bytes / cost.bytes),
      Math.floor(left.documents / cost.documents),
      Math.floor(left.ranges / cost.ranges),
    )
    return last === 'last' ? Math.max(1, whole) : whole
  }
  return {
    fits,
    /** Records that the caller's access has read the project with this
     * id. */
    asked(projectId: string) {
      asked.add(projectId)
    },
    /** `check` of each of `items` in order, a round at a time, while the
     * budget holds PROJECT for each project of theirs (`projectOf`,
     * undefined for none) the caller's access has not read yet, keeping
     * back CHECK for each of `checks` group checks to come. A round asks
     * about at most one such project, after a look at the budget, because
     * PROJECT's bytes hold fewer team shares than the access may read on one
     * project (lib/access.ts OWN_READS): a project shared with more teams
     * passes the budget by its own reads, and no other project's join them.
     * Answers the
     * results of a prefix of `items`, all of them unless the budget ran
     * out or a check of the caller's access that a bound stopped
     * (lib/access.ts accessUnchecked) ended it before that item, as a list
     * the budget stops says it is incomplete. */
    async inOrder<T, R>(
      items: readonly T[],
      projectOf: (item: T) => string | undefined,
      check: (item: T) => Promise<R>,
      checks = 0,
    ): Promise<R[]> {
      const out: R[] = []
      while (out.length < items.length) {
        // the items up to the second project not read yet, and the first
        // while PROJECT fits
        let fresh: string | undefined
        let end = out.length
        for (; end < items.length; end++) {
          const id = projectOf(items[end])
          if (id === undefined || asked.has(id) || id === fresh) continue
          if (fresh !== undefined || (await fits(PROJECT, undefined, checks)) === 0) break
          fresh = id
        }
        if (end === out.length) break
        if (fresh !== undefined) asked.add(fresh)
        const got = await Promise.all(
          items.slice(out.length, end).map((item) =>
            check(item).then(
              (result) => ({ result }),
              (e) => {
                if (!isAccessUnchecked(e)) throw e
                return null
              },
            ),
          ),
        )
        const stop = got.indexOf(null)
        for (const one of stop === -1 ? got : got.slice(0, stop))
          if (one !== null) out.push(one.result)
        if (stop !== -1) break
      }
      return out
    },
  }
}

/** What budgetIn answers. */
type Budget = ReturnType<typeof budgetIn>

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
 * the caller's working set (lib/workingSet.ts, Access.holds), else null,
 * also where a bound stopped that check (lib/access.ts accessUnchecked),
 * which the reads then answer `unavailable` as for every other reason. */
async function openedTask(ctx: QueryCtx, me: Doc<'profiles'>, issueId: string) {
  const task = await byId(ctx, 'issues', issueId)
  if (task === null || task.org_id !== me.org_id) return null
  const access = accessOf(ctx, me)
  return (await unlessUnchecked(access.holds(task), false)) ? { task, access } : null
}

/* `check`, or `refused` where a check of the caller's access that a bound
 * stopped (lib/access.ts accessUnchecked) ended it. */
async function unlessUnchecked<T, R>(check: Promise<T>, refused: R): Promise<T | R> {
  try {
    return await check
  } catch (e) {
    if (!isAccessUnchecked(e)) throw e
    return refused
  }
}

/** Whether a subtask follows those a read took (subtasksOf): 'none' when
 * the read reached the range's end, 'some' when it read one more it left
 * out, 'unknown' when it stopped before the next for want of room or at
 * its row stop. */
type Rest = 'none' | 'some' | 'unknown'

/** The first `most` active subtasks from `kids`, a stream of a task's active
 * subtasks oldest first, each with whether it counts toward the task (its
 * project is live, lib/liveTasks.ts countsAsSubtask) and whether the caller
 * is shown it. It reads them one at a time while a body fits in `budget`,
 * keeping back what the group check of each shown row needs, and checks
 * each as it is read while the budget holds its project (inOrder). `rest`
 * says whether more follow; the caller asks restOf when it is unknown,
 * after the group checks. */
async function subtasksOf(
  kids: AsyncIterator<Doc<'issues'>>,
  access: Access,
  budget: Budget,
  most: number,
): Promise<{ rows: { kid: Doc<'issues'>; counts: boolean; shown: boolean }[]; rest: Rest }> {
  const rows: { kid: Doc<'issues'>; counts: boolean; shown: boolean }[] = []
  // the rows the caller is shown, each of which a group check follows
  let checks = 0
  for (;;) {
    if (rows.length === most) return { rows, rest: 'unknown' }
    if ((await budget.fits(BODY, undefined, checks)) === 0) return { rows, rest: 'unknown' }
    const next = await kids.next()
    if (next.done === true) return { rows, rest: 'none' }
    const [row] = await budget.inOrder(
      [next.value],
      (kid) => kid.project_id,
      async (kid) => {
        const counts = await access.live(kid.project_id)
        return { kid, counts, shown: counts && (await access.visible(kid.project_id)) }
      },
      checks,
    )
    if (row === undefined) return { rows, rest: 'some' }
    rows.push(row)
    if (row.shown) checks += 1
  }
}

/** Whether another subtask follows in `kids` after subtasksOf stopped:
 * it reads the next one while some of every count of `budget` is left
 * ('last'), so a list that took the last row the budget held is still
 * complete, and a list is incomplete only when a row follows or the budget
 * cannot tell. */
async function restOf(kids: AsyncIterator<Doc<'issues'>>, budget: Budget): Promise<Rest> {
  if ((await budget.fits(BODY, 'last')) === 0) return 'unknown'
  return (await kids.next()).done === true ? 'none' : 'some'
}

/** The subtask list of the task with this id: its first TASK_WINDOW.rows
 * active subtasks and whether each counts and is shown (subtasksOf), the
 * shown ones as short rows (shortRows), and whether the list is complete:
 * the read reached the range's end, or the look for one more after the
 * group checks found none (restOf), and every shown row has its group
 * fact. */
async function subtaskList(ctx: QueryCtx, access: Access, budget: Budget, id: string) {
  const stream = activeKids(ctx, id)[Symbol.asyncIterator]()
  try {
    const kids = await subtasksOf(stream, access, budget, TASK_WINDOW.rows)
    const counting = kids.rows.filter((kid) => kid.counts)
    const shown = await shortRows(
      ctx,
      access,
      budget,
      counting.filter((kid) => kid.shown).map((kid) => kid.kid),
    )
    // the group checks come before the look for one more subtask, so the
    // budget they need is not spent on it
    const rest = kids.rest === 'unknown' ? await restOf(stream, budget) : kids.rest
    return { counting, rows: shown.rows, complete: rest === 'none' && shown.complete }
  } finally {
    await stream.return?.()
  }
}

/** The tasks with these ids that the caller is shown (Access.holds), in
 * order, read by id in steps of the bodies that fit in `budget`, each
 * step's tasks checked while the budget holds their projects (inOrder).
 * `complete` says it read and checked them all. */
async function shownByIds(
  ctx: QueryCtx,
  access: Access,
  budget: Budget,
  orgId: string,
  ids: readonly string[],
) {
  const shown: Doc<'issues'>[] = []
  // a task gone or of another organization needs no access read
  const ours = (task: Doc<'issues'> | null) =>
    task !== null && task.org_id === orgId ? task : undefined
  for (let at = 0; at < ids.length; ) {
    // each end the caller is shown is a row a group check follows
    const n = await budget.fits(BODY, undefined, shown.length)
    if (n === 0) return { shown, complete: false }
    const step = ids.slice(at, at + n)
    const tasks = await Promise.all(step.map((id) => byId(ctx, 'issues', id)))
    const held = await budget.inOrder(
      tasks,
      (task) => ours(task)?.project_id,
      async (task) => {
        const mine = ours(task)
        return mine !== undefined && (await access.holds(mine)) ? mine : null
      },
      shown.length,
    )
    shown.push(...held.filter((task) => task !== null))
    if (held.length < tasks.length) return { shown, complete: false }
    at += step.length
  }
  return { shown, complete: true }
}

/** Whether each of `tasks`, which the caller is shown, so active tasks in
 * live projects, is a group: whether an active subtask of it is in a live
 * project (lib/liveTasks.ts countsAsSubtask). Undefined where `budget` ran
 * out first. It reads each task's active subtasks, oldest first, only until
 * one counts: one index range and no body for a task without any, as most
 * subtasks are, and usually one body for a group. Each step reads the next
 * subtask of as many undecided tasks as `budget` holds bodies for, one
 * while some of every count is left ('last'), and checks their projects
 * while the budget holds them (inOrder); past that every task still open
 * stays undecided. */
async function groupsOf(
  ctx: QueryCtx,
  access: Access,
  budget: Budget,
  tasks: readonly Doc<'issues'>[],
): Promise<(boolean | undefined)[]> {
  const groups: (boolean | undefined)[] = tasks.map(() => undefined)
  const streams = new Map<number, AsyncIterator<Doc<'issues'>>>()
  let open = tasks.map((_, at) => at)
  try {
    while (open.length > 0) {
      const n = await budget.fits(BODY, 'last')
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
      const counts = await budget.inOrder(
        next,
        (kid) => (kid.done === true ? undefined : kid.value.project_id),
        async (kid) => kid.done !== true && (await access.live(kid.value.project_id)),
      )
      for (const [i, counted] of counts.entries()) {
        const at = step[i]
        const kid = next[i]
        if (kid.done !== true && !counted) {
          open.push(at)
          continue
        }
        groups[at] = kid.done !== true
        // a decided task's stream closes at once, so only undecided ones stay open
        await streams.get(at)?.return?.()
        streams.delete(at)
      }
      // a subtask read whose project the budget could not hold leaves its
      // task, and every task still open, undecided
      if (counts.length < step.length) break
    }
  } finally {
    await Promise.all([...streams.values()].map((kids) => kids.return?.()))
  }
  return groups
}

/** `tasks`, each shown to the caller, as short rows in their order. A task
 * whose group fact `budget` left unread (groupsOf), or whose level a bound
 * of the caller's access stopped (lib/access.ts accessUnchecked) after its
 * level inherited from the top-level project showed it, is left out, and
 * `complete` says none was. */
async function shortRows(
  ctx: QueryCtx,
  access: Access,
  budget: Budget,
  tasks: readonly Doc<'issues'>[],
) {
  const levels = await Promise.all(
    tasks.map((task) => unlessUnchecked(access.level(task.project_id), undefined)),
  )
  const groups = await groupsOf(ctx, access, budget, tasks)
  const rows: ShortRow[] = []
  for (const [i, task] of tasks.entries()) {
    const group = groups[i]
    const level = levels[i]
    if (group !== undefined && level !== null && level !== undefined)
      rows.push(shortRow(task, group, level))
  }
  return {
    rows,
    complete:
      groups.every((group) => group !== undefined) && levels.every((level) => level !== undefined),
  }
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
 *   the caller's level on its project, `labels` its label rows,
 *   `follow` the caller's follow or null, and `parent`
 *   the parent as a short row when the caller is shown it, else null.
 *   `subtasks.rows` are its active subtasks in live projects that the
 *   caller is shown, as short rows by number and then id. A subtask in an
 *   archived project is neither a row nor hidden. A live one the caller is
 *   not shown sets has_hidden_subtasks and sends no row.
 * - `{ state: 'archived', task, description, labels, level }` for an
 *   archived task of the organization whose project the caller sees
 *   (lib/archivedTasks.ts archivedTaskCore's rule, canSeeProject), so the
 *   window shows it read-only. That includes a task in an archived
 *   project, which the Archived tasks page leaves out until the project is
 *   restored. `task` is the page's row (ArchivedPageRow), which names no
 *   parent, `description` its text from its description row, `labels` its
 *   label rows and `level` the caller's level on its project, by which the
 *   app offers Restore. An answer from before this release
 *   holds only `task`. It asks with the caller's seat in this organization
 *   only, never another seat of the login (lib/functions.ts loadMember), so
 *   another organization's archived task answers unavailable.
 * - `{ state: 'unavailable' }` for everything else, alike, also where a
 *   bound stopped the check of the caller's access on the task, its project
 *   or its parent (lib/access.ts accessUnchecked), so the answer does not
 *   tell a refused check from a hidden task, and never leaves out a parent
 *   it could not check as hidden.
 *
 * The subtasks load with the task because the window needs the group facts
 * at once: the status control, the owner rule and the remaining total
 * depend on whether the task is a group. Past TASK_WINDOW, or at a subtask
 * whose access check a bound stopped, the subtasks answer `complete: false`
 * with the rows read before it; has_subtasks then says
 * whether one read counts, and has_hidden_subtasks is true, so the window
 * can say its completion is unknown. A subtask whose own has_subtasks is
 * true is a group stored before the rule of one level, and the answer holds
 * none of its subtasks, so the app must treat a remaining total or progress
 * that needs its leaves as unknown (src/store/planner.ts remainingOf and
 * progressOf walk every descendant).
 *
 * The labels, of an active or archived task, stop at TASK_WINDOW.rows. An
 * archived answer reads one description and those label rows besides the
 * page row, well inside TASK_WINDOW. A task carries at most
 * LIMITS.labels.max (model/labels.ts setTaskLabel), so only rows stored
 * against that rule could pass the stop, and those past it are left out.
 */
export const readWindowTask = (ctx: QueryCtx, me: Doc<'profiles'>, ref: string) =>
  unlessUnchecked(windowTask(ctx, me, ref), UNAVAILABLE)

/* readWindowTask's answer while the checks of the caller's access on the
 * task, its project and its parent finish; a subtask's that a bound stops
 * ends the subtask list instead (budgetIn inOrder). */
async function windowTask(ctx: QueryCtx, me: Doc<'profiles'>, ref: string) {
  const task = await taskByRef(ctx, me.org_id, ref)
  if (task === null) return UNAVAILABLE
  const access = accessOf(ctx, me)
  const labelRows = () =>
    ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .take(TASK_WINDOW.rows)
  const archived_at = task.archived_at
  if (archived_at !== undefined) {
    // archivedTaskCore's rule, the caller's seat in this organization sees
    // the task's project, through Access.visible: canSeeProject's walk of a
    // large parent's sub-projects can pass Convex's 4,096 index ranges, and
    // a broken tree (a missing parent, a cycle) makes it throw, where
    // Access.visible reads within bounds and answers false
    if (!(await access.visible(task.project_id))) return UNAVAILABLE
    // what the window shows of it read-only: its text, labels and the
    // caller's level, which says whether they may restore it
    const [row, description, labels, level] = await Promise.all([
      archivedRowOf(ctx, { ...task, archived_at }),
      descriptionOf(ctx.db, task),
      labelRows(),
      access.level(task.project_id),
    ])
    return {
      state: 'archived' as const,
      task: row,
      description,
      labels: labels.map(relationRow),
      level,
    }
  }
  if (!(await access.holds(task))) return UNAVAILABLE
  // the reads every answer needs, before the subtasks spend the rest
  const [level, labels, follow, parent, description] = await Promise.all([
    access.level(task.project_id),
    labelRows(),
    ctx.db
      .query('issue_subscriptions')
      .withIndex('by_issue_profile', (q) => q.eq('issue_id', task.id).eq('profile_id', me.id))
      .unique(),
    shownParent(ctx, access, task),
    descriptionOf(ctx.db, task),
  ])
  if (level === null) return UNAVAILABLE
  const { documents, ranges } = TASK_WINDOW
  const budget = budgetIn(ctx, { bytes: TASK_WINDOW.bytes, documents, ranges }, access.shared)
  budget.asked(task.project_id)
  const kids = await subtaskList(ctx, access, budget, task.id)
  const row: TaskRow = {
    ...taskFields(task),
    description,
    ...parentLink(task, () => parent !== null),
    has_subtasks: kids.counting.length > 0,
    has_hidden_subtasks: !kids.complete || kids.counting.some((kid) => !kid.shown),
  }
  return {
    state: 'ok' as const,
    task: row,
    level,
    labels: labels.map(relationRow),
    follow: follow === null ? null : relationRow(follow),
    parent,
    subtasks: { rows: kids.rows.sort(byNumber), complete: kids.complete },
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
 * Past TASK_WINDOW.rows links or TASK_WINDOW.linkBytes, or at an other end
 * whose access check a bound stopped (lib/access.ts accessUnchecked), it
 * answers `complete: false` with the links whose other end it read before.
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
  const { documents, ranges } = TASK_WINDOW
  const budget = budgetIn(ctx, { bytes: TASK_WINDOW.linkBytes, documents, ranges }, access.shared)
  budget.asked(task.project_id)
  const ends = await shownByIds(ctx, access, budget, me.org_id, [...new Set(read.map(otherEnd))])
  const shown = await shortRows(ctx, access, budget, ends.shown)
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
 * answers `complete: false` with the first of them, `count` then counting
 * only those.
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
