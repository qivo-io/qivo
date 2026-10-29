/* Archived tasks in archive order, read a page at a time by REST
 * GET /v1/tasks?archived=true and MCP list_tasks with `archived: true`
 * (lib/core.ts listArchivedIssuesCore) and by the app's Archived tasks page
 * (issues.archivedPage, archivedPageCore below). The order is the one of the
 * archive indexes read backwards, most recently archived first and tasks
 * archived at the same moment newest created first, merged across the
 * projects a list covers. Convex does not promise distinct creation times,
 * so tasks that share both keys follow the indexes' last key, the document
 * id, which sorts like its text. A cursor names a position in that order, so
 * a page reads only what follows it, whatever the size of the archive.
 * Callers get the position sealed (archiveCursorText), since it can be a task
 * of a project they cannot see. The task window looks up its own task in the
 * archive by id instead (issues.archivedTask, archivedTaskCore below).
 *
 * Both surfaces page through archivedTasksPage, under one read budget, and
 * search with archivedTaskMatcher, the task search rule (lib/search.ts
 * taskSearchText) that reads a task's labels and subtasks only when they can
 * change the answer. The organization's matching labels and roster names
 * that a search reads live here too, and active task lists use them. */

import type { TransactionMetric, TransactionMetrics } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { descriptionOf } from '../model/descriptions'
import { canSeeProject } from './access'
import { openCursorText, sealCursorText } from './archiveCursorSeal'
import { byId } from './db'
import { allWordsMatcher, searchPieces, type TaskSearchFields, taskSearchText } from './search'
import { issueKey, STATUS_NAMES } from './taskRefs'

/** A task that has been archived. */
export type ArchivedTask = Doc<'issues'> & { archived_at: string }

const isArchived = (task: Doc<'issues'>): task is ArchivedTask => task.archived_at !== undefined

/** A position in archive order, just after the task with these keys. */
export type ArchiveCursor = { created: number; id: string; archived_at: string }

/** The cursor just after `task`. */
export const cursorAfter = (task: ArchivedTask): ArchiveCursor => ({
  created: task._creationTime,
  id: task._id,
  archived_at: task.archived_at,
})

/* A position as text, `<_creationTime>~<_id>~<archived_at>`, with the
 * timestamp last and verbatim, so any stored format pages correctly. */
const positionText = (c: ArchiveCursor): string => `${c.created}~${c.id}~${c.archived_at}`

const POSITION_TEXT = /^(\d+(?:\.\d+)?)~([0-9a-z]{1,64})~(.{1,64})$/s

/* What a cursor seals, `<project uuid>~<position>`: the project whose list
 * the cursor came from, and where that list goes on. */
const SEALED_TEXT = /^([0-9a-z-]{1,64})~(.+)$/s

/* The longest `2~` cursor archiveCursorText writes: a project uuid of at most
 * 64 bytes and a `~`, a position of at most 26 + 1 + 64 + 1 + 192 bytes, since
 * the 64 UTF-16 code units POSITION_TEXT allows an archive time take up to 192
 * bytes as UTF-8, and the 16-byte tag, as hex. */
const SEALED_MAX = 2 + 2 * (65 + 284 + 16)

/** A cursor as callers see it, `2~` and the position sealed
 * (lib/archiveCursorSeal.ts) together with `projectId`, the project whose
 * list it came from. The position is the last task a page looked at, which in
 * a read of the organization's whole archive can belong to a project the
 * caller cannot see, so callers never see its id or times. */
export const archiveCursorText = async (c: ArchiveCursor, projectId: string): Promise<string> =>
  `2~${await sealCursorText(`${projectId}~${positionText(c)}`)}`

const positionOf = (text: string): ArchiveCursor | null => {
  const m = POSITION_TEXT.exec(text)
  if (m === null) return null
  const created = Number(m[1])
  return Number.isFinite(created) ? { created, id: m[2], archived_at: m[3] } : null
}

/** The position `text` names for the list of `projectId`, or null when it
 * is not a cursor archiveCursorText wrote for that project. Only sealed
 * cursors page. A position the caller could choose, such as a plain
 * `1~<position>` cursor from before sealing, would let it probe the
 * organization's whole archive: whether a page from that position ends inside
 * its task budget tells it how many hidden tasks follow, and so their archive
 * times. A list paged across the change starts again. A cursor from another
 * project's list is refused too, since it would start this list part way and
 * skip its newer tasks. */
export async function parseArchiveCursor(
  text: string,
  projectId: string,
): Promise<ArchiveCursor | null> {
  if (!text.startsWith('2~') || text.length > SEALED_MAX) return null
  const opened = await openCursorText(text.slice(2))
  const m = opened === null ? null : SEALED_TEXT.exec(opened)
  return m === null || m[1] !== projectId ? null : positionOf(m[2])
}

/* Whether `a` comes before `b` in archive order. */
const before = (a: ArchivedTask, b: ArchivedTask): boolean =>
  a.archived_at !== b.archived_at
    ? a.archived_at > b.archived_at
    : a._creationTime !== b._creationTime
      ? a._creationTime > b._creationTime
      : a._id > b._id

/* The tasks of `tasks`, read in index order, whose id sorts below `id`. */
async function* idsBelow(
  tasks: AsyncIterable<Doc<'issues'>>,
  id: string,
): AsyncGenerator<Doc<'issues'>> {
  for await (const task of tasks) if (task._id < id) yield task
}

/* The archived tasks of the index ranges `ranges` opens, in turn, read
 * lazily. Each range opens only once the one before it is read to its end. */
async function* archivedIn(
  ranges: readonly (() => AsyncIterable<Doc<'issues'>>)[],
): AsyncGenerator<ArchivedTask> {
  for (const range of ranges) for await (const task of range()) if (isArchived(task)) yield task
}

/* One project's archived tasks after `after`, in archive order, from at most
 * three ranges of by_project_archived. They are the tasks that share both of
 * the cursor's times and sort below its id, the rest of the cursor's moment,
 * then everything archived earlier. */
function projectArchive(
  ctx: QueryCtx,
  projectId: string,
  after: ArchiveCursor | null,
): AsyncGenerator<ArchivedTask> {
  const issues = () => ctx.db.query('issues')
  const earlier = () =>
    issues()
      .withIndex('by_project_archived', (q) => {
        const archived = q.eq('project_id', projectId).gt('archived_at', undefined)
        return after === null ? archived : archived.lt('archived_at', after.archived_at)
      })
      .order('desc')
  if (after === null) return archivedIn([earlier])
  const sameInstant = () =>
    idsBelow(
      issues()
        .withIndex('by_project_archived', (q) =>
          q
            .eq('project_id', projectId)
            .eq('archived_at', after.archived_at)
            .eq('_creationTime', after.created),
        )
        .order('desc'),
      after.id,
    )
  const sameMoment = () =>
    issues()
      .withIndex('by_project_archived', (q) =>
        q
          .eq('project_id', projectId)
          .eq('archived_at', after.archived_at)
          .lt('_creationTime', after.created),
      )
      .order('desc')
  return archivedIn([sameInstant, sameMoment, earlier])
}

/* The whole organization's archived tasks after `after`, in archive order,
 * from by_org_archived the way projectArchive reads one project. */
function organizationArchive(
  ctx: QueryCtx,
  orgId: string,
  after: ArchiveCursor | null,
): AsyncGenerator<ArchivedTask> {
  const issues = () => ctx.db.query('issues')
  const earlier = () =>
    issues()
      .withIndex('by_org_archived', (q) => {
        const archived = q.eq('org_id', orgId).gt('archived_at', undefined)
        return after === null ? archived : archived.lt('archived_at', after.archived_at)
      })
      .order('desc')
  if (after === null) return archivedIn([earlier])
  const sameInstant = () =>
    idsBelow(
      issues()
        .withIndex('by_org_archived', (q) =>
          q
            .eq('org_id', orgId)
            .eq('archived_at', after.archived_at)
            .eq('_creationTime', after.created),
        )
        .order('desc'),
      after.id,
    )
  const sameMoment = () =>
    issues()
      .withIndex('by_org_archived', (q) =>
        q
          .eq('org_id', orgId)
          .eq('archived_at', after.archived_at)
          .lt('_creationTime', after.created),
      )
      .order('desc')
  return archivedIn([sameInstant, sameMoment, earlier])
}

/** A merged read of archived tasks in archive order. */
export type ArchivedTaskStream = {
  /** The next task, or null once every range is read to its end. */
  next(): Promise<ArchivedTask | null>
  /** Whether a task follows the one next() returned last. */
  more(): boolean
  /** Closes every open query. */
  close(): Promise<void>
}

/**
 * The archived tasks of `scope.projectIds` after `cursor`, in archive order.
 * It holds each project's next task, so it reads one task per project when
 * it opens, then one more task of a project each time it hands one out. A
 * page pays only for what it pulls, and more() needs no read. Before it opens
 * each project after the first it asks `mayOpen` whether the reads so far
 * leave room. When they do not, opening every project would read too much,
 * so it closes the ones it opened and reads the organization's archive
 * instead, one task at a time. That read hands out tasks of other projects
 * too, which the caller skips. Call close() when done, so no query stays
 * open.
 */
export async function archivedTasksAfter(
  ctx: QueryCtx,
  scope: { orgId: string; projectIds: readonly string[] },
  cursor: ArchiveCursor | null,
  mayOpen: () => Promise<boolean>,
): Promise<ArchivedTaskStream> {
  let streams: AsyncGenerator<ArchivedTask>[] = []
  const heads: (ArchivedTask | null)[] = []
  const pull = async (i: number) => {
    const step = await streams[i].next()
    heads[i] = step.done === true ? null : step.value
  }
  for (const projectId of scope.projectIds) {
    if (streams.length > 0 && !(await mayOpen())) {
      for (const stream of streams) await stream.return(undefined)
      streams = [organizationArchive(ctx, scope.orgId, cursor)]
      heads.length = 0
      await pull(0)
      break
    }
    streams.push(projectArchive(ctx, projectId, cursor))
    await pull(streams.length - 1)
  }
  return {
    async next() {
      let best = -1
      heads.forEach((head, i) => {
        if (head === null) return
        const leader = best < 0 ? null : heads[best]
        if (leader === null || before(head, leader)) best = i
      })
      if (best < 0) return null
      const task = heads[best]
      await pull(best)
      return task
    },
    more: () => heads.some((head) => head !== null),
    async close() {
      for (const stream of streams) await stream.return(undefined)
    },
  }
}

/* ------------------------------------------------------------- the budget */

/** What one page of archived tasks may read, counted from the page's start
 * with Convex's own transaction metrics, inside the limits of one
 * transaction (4,096 index ranges, 32,000 documents and 16 MiB) once the
 * caller's own reads before the page are done, and never more than the
 * request has left. A page also stops after looking at `tasks` archived
 * tasks. Opening the scope's projects side by side, a task each, may read
 * the `opening` share of the page before the page reads the organization's
 * archive instead (archivedTasksAfter). Tests lower these. */
export const ARCHIVE_PAGE = {
  tasks: 1000,
  ranges: 1500,
  documents: 16_000,
  bytes: 8 << 20,
  opening: 1 / 4,
}

/** What an archived page keeps back from the request's limits, for the
 * reads of a row after its last check and of the page's end. The first task
 * a page looks at may use the rest. A task's filters can read whether it is
 * a group and its text, two description rows at most (model/descriptions.ts
 * descriptionOf), before its row's walk checks the room, and past the walk's
 * last check a REST or MCP row reads at most four more documents
 * (lib/core.ts listArchivedIssuesCore): the subtask its walk read last, the
 * first subtask of a group too large to walk, its parent and its newest
 * comment. Its text is the one the filters read, or one more read in its
 * place. The bytes hold seven documents at Convex's size limit. Tests lower
 * these. */
export const ARCHIVE_RESERVE = { ranges: 16, documents: 64, bytes: 7 * DOCUMENT_MAX_BYTES }

/** Transaction totals (ctx.meta.getTransactionMetrics) that a read keeps
 * below, in index ranges, documents and bytes read. */
export type ReadCeiling = { ranges: number; documents: number; bytes: number }

/* A transaction's limit on one count, from what it used and has left. */
const limitOf = (m: TransactionMetric): number => m.used + m.remaining

/** The request's limits less `reserve`, as a ceiling, from its metrics. */
export const roomOf = (m: TransactionMetrics, reserve: ReadCeiling): ReadCeiling => ({
  ranges: limitOf(m.databaseQueries) - reserve.ranges,
  documents: limitOf(m.documentsRead) - reserve.documents,
  bytes: limitOf(m.bytesRead) - reserve.bytes,
})

/** Whether the request has read less than `ceiling` on every count. */
export async function readsUnder(ctx: QueryCtx, ceiling: ReadCeiling): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics()
  return (
    m.databaseQueries.used < ceiling.ranges &&
    m.documentsRead.used < ceiling.documents &&
    m.bytesRead.used < ceiling.bytes
  )
}

/** A walk's check of the request's reads against a ceiling (readsUnder)
 * that reads the metrics only when the reads since its last look could
 * have reached the ceiling. It counts each index range as one and each
 * document at Convex's size limit, so as long as the walk reads nothing
 * between its calls, no range starts once the ceiling's ranges are used
 * and the documents and bytes stay under the ceiling's. The range that uses
 * the last of the ceiling's ranges may be read to its end. */
export type CeilingGuard = {
  /** Whether the walk may start one more index range. */
  range(): Promise<boolean>
  /** Whether the walk may go on after the document it just read. */
  document(): Promise<boolean>
}

/** A CeilingGuard for `ceiling`. Each look at the metrics costs about as
 * much as an index range, which a walk of thousands of tasks felt when it
 * looked before each range and after each document. */
export function ceilingGuard(ctx: QueryCtx, ceiling: ReadCeiling): CeilingGuard {
  let ranges = 0
  let documents = 0
  const look = async (): Promise<boolean> => {
    const m = await ctx.meta.getTransactionMetrics()
    const left = {
      ranges: ceiling.ranges - m.databaseQueries.used,
      documents: ceiling.documents - m.documentsRead.used,
      bytes: ceiling.bytes - m.bytesRead.used,
    }
    if (left.ranges <= 0 || left.documents <= 0 || left.bytes <= 0) return false
    ranges = left.ranges
    documents = Math.min(left.documents - 1, Math.floor((left.bytes - 1) / DOCUMENT_MAX_BYTES))
    return true
  }
  return {
    range: async () => {
      if (ranges <= 0 && !(await look())) return false
      ranges--
      return true
    },
    document: async () => {
      if (documents <= 0) return await look()
      documents--
      return true
    },
  }
}

/** How many index ranges the request has left under `ceiling`. */
export async function rangesLeft(ctx: QueryCtx, ceiling: ReadCeiling): Promise<number> {
  return ceiling.ranges - (await ctx.meta.getTransactionMetrics()).databaseQueries.used
}

/* -------------------------------------------------------------- the facts */

/** What a page reads about one archived task besides its own row, each at
 * most once, so a search and the task's row share the reads. */
export type TaskFacts = {
  /** Whether the task has any subtask, archived or not, whoever can read it.
   * An archived task is a group while it has one. */
  isGroup(): Promise<boolean>
  /** The ids of the labels the task carries, archive marks included. */
  labelIds(): Promise<string[]>
  /** The task's text, from its description row (model/descriptions.ts
   * descriptionOf). */
  description(): Promise<string>
}

/** The facts of `task`, read on first use. */
export function taskFacts(ctx: QueryCtx, task: Doc<'issues'>): TaskFacts {
  let group: Promise<boolean> | undefined
  let labels: Promise<string[]> | undefined
  let text: Promise<string> | undefined
  return {
    description: () => (text ??= descriptionOf(ctx.db, task)),
    isGroup: () =>
      (group ??= ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
        .first()
        .then((kid) => kid !== null)),
    labelIds: () =>
      (labels ??= ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .collect()
        .then((rows) => rows.map((row) => row.label_id))),
  }
}

/* ------------------------------------------------------------- the search */

/** The organization's labels whose lowercased name contains one of the
 * search's `pieces` (lib/search.ts searchPieces), in the organization's label
 * order. No other label can change whether a task matches. */
export async function matchingLabels(
  ctx: QueryCtx,
  orgId: string,
  pieces: readonly string[],
): Promise<Doc<'labels'>[]> {
  if (pieces.length === 0) return []
  const out: Doc<'labels'>[] = []
  const labels = ctx.db.query('labels').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const label of labels) {
    const name = label.name.toLowerCase()
    if (pieces.some((piece) => name.includes(piece))) out.push(label)
  }
  return out
}

/** The organization's roster, people and agents alike, for list rows. */
export const rosterOf = (ctx: QueryCtx, orgId: string): Promise<Doc<'profiles'>[]> =>
  ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()

/** Profile uuid to name over a roster, for list rows and search. */
export const namesOf = (profiles: readonly Doc<'profiles'>[]): Map<string, string> =>
  new Map(profiles.map((p) => [p.id, p.name]))

/** Profile uuid to name over the organization's roster, for list rows and
 * search. */
export async function rosterNames(ctx: QueryCtx, orgId: string): Promise<Map<string, string>> {
  return namesOf(await rosterOf(ctx, orgId))
}

/** The search fields a task's own row holds, without its description, which
 * its description row holds, and its labels, and with its status line
 * decided by `group` (lib/search.ts taskSearchText). */
export const searchFields = (
  task: Doc<'issues'>,
  names: ReadonlyMap<string, string>,
): Omit<TaskSearchFields, 'group' | 'labelNames' | 'description'> => ({
  key: issueKey(task.num),
  title: task.title,
  status: task.status,
  priority: task.priority,
  assigneeName: task.assignee_id === undefined ? null : names.get(task.assignee_id),
})

/** A test of whether an archived task matches `search`. */
export type ArchivedTaskMatcher = (task: ArchivedTask, facts: TaskFacts) => Promise<boolean>

/**
 * The task search rule for archived tasks of the organization `orgId`, the
 * one the app's filter and REST and MCP search share (lib/search.ts
 * taskSearchText). Each fragment of `search` must occur in the task ID,
 * title, description, status name (not on a task with subtasks), priority
 * name, assignee name or label names, in any order. With `stars`, as REST
 * reads it, `*` stands for any run of text.
 *
 * More text never undoes a match, so it first tries the fields the task's
 * own row holds. Only when they fail does it read its description row, and
 * only when that fails too what else can still change the answer: the
 * roster's names (`names`, read once), whether the task is a group when
 * some fragment occurs in a status name, and the task's labels when some
 * label's name holds a fragment. Each of those costs one index range at
 * most, read through `facts` so the task's row can reuse it.
 */
export async function archivedTaskMatcher(
  ctx: QueryCtx,
  orgId: string,
  search: string,
  o: { stars: boolean; names: () => Promise<ReadonlyMap<string, string>> },
): Promise<ArchivedTaskMatcher> {
  const matches = allWordsMatcher(search, o.stars)
  const pieces = searchPieces(search, o.stars)
  const labels = await matchingLabels(ctx, orgId, pieces)
  // a status line holding none of the pieces never changes the answer
  const statusMatters = Object.values(STATUS_NAMES).some((name) => {
    const lower = name.toLowerCase()
    return pieces.some((piece) => lower.includes(piece))
  })
  let names: Promise<ReadonlyMap<string, string>> | undefined
  const nameOf = async (id: string) => {
    names ??= o.names()
    return (await names).get(id)
  }
  return async (task, facts) => {
    const own = searchFields(task, new Map())
    const cheap = { ...own, group: true, labelNames: [] }
    if (matches(taskSearchText({ ...cheap, description: '' }))) return true
    const description = await facts.description()
    if (matches(taskSearchText({ ...cheap, description }))) return true
    const assigneeName = task.assignee_id === undefined ? null : await nameOf(task.assignee_id)
    const held = labels.length > 0 ? new Set(await facts.labelIds()) : null
    return matches(
      taskSearchText({
        ...own,
        description,
        assigneeName,
        group: statusMatters ? await facts.isGroup() : true,
        labelNames: held === null ? [] : labels.filter((l) => held.has(l.id)).map((l) => l.name),
      }),
    )
  }
}

/* --------------------------------------------------------------- the page */

/** How a page of archived tasks chooses and shows its tasks. */
export type ArchivedPageRules<Row> = {
  /** Whether the page lists `task`, a task of the scope's organization and
   * projects. It may read, through `facts`. */
  keeps(task: ArchivedTask, facts: TaskFacts): Promise<boolean>
  /** The row of a kept `task`, or null when the reads it needs do not fit
   * under `ceiling`, which ends the page before `task`, so the next page
   * starts with it. The `first` task a page looks at gets all the room the
   * request has left as its ceiling, and must answer a row. */
  row(
    task: ArchivedTask,
    facts: TaskFacts,
    ceiling: ReadCeiling,
    first: boolean,
  ): Promise<Row | null>
}

/** One page of archived tasks: its rows, where the next page starts, or
 * null when no archived task of the scope follows, and how many tasks of the
 * scope it looked at. */
export type ArchivedTasksPage<Row> = {
  rows: Row[]
  next: ArchiveCursor | null
  scanned: number
}

/**
 * One page of the archived tasks of `scope.projectIds` in the organization
 * `scope.orgId` after `cursor`, in archive order. It stops at `limit` rows,
 * after looking at ARCHIVE_PAGE.tasks tasks, or once it has spent
 * ARCHIVE_PAGE's reads, so it can hold fewer rows than `limit`, even none,
 * while `next` is set. `next` is the last task the page looked at, not the
 * last row, so the next page never rereads tasks `rules.keeps` left out. A
 * task outside the scope's organization or projects is never kept, which
 * fails closed when the stream reads the organization's whole archive.
 */
export async function archivedTasksPage<Row>(
  ctx: QueryCtx,
  scope: { orgId: string; projectIds: readonly string[] },
  cursor: ArchiveCursor | null,
  limit: number,
  rules: ArchivedPageRules<Row>,
): Promise<ArchivedTasksPage<Row>> {
  // the request's room less ARCHIVE_RESERVE, the page's budget inside it
  // and the share of that budget that opening the projects may read
  const start = await ctx.meta.getTransactionMetrics()
  const used = {
    ranges: start.databaseQueries.used,
    documents: start.documentsRead.used,
    bytes: start.bytesRead.used,
  }
  const room = roomOf(start, ARCHIVE_RESERVE)
  const budget: ReadCeiling = {
    ranges: Math.min(room.ranges, used.ranges + ARCHIVE_PAGE.ranges),
    documents: Math.min(room.documents, used.documents + ARCHIVE_PAGE.documents),
    bytes: Math.min(room.bytes, used.bytes + ARCHIVE_PAGE.bytes),
  }
  const opening: ReadCeiling = {
    ranges: used.ranges + (budget.ranges - used.ranges) * ARCHIVE_PAGE.opening,
    documents: used.documents + (budget.documents - used.documents) * ARCHIVE_PAGE.opening,
    bytes: used.bytes + (budget.bytes - used.bytes) * ARCHIVE_PAGE.opening,
  }
  const projects = new Set(scope.projectIds)
  const rows: Row[] = []
  const stream = await archivedTasksAfter(ctx, scope, cursor, () => readsUnder(ctx, opening))
  let last: ArchiveCursor | null = null
  let looked = 0
  let scanned = 0
  try {
    for (let task = await stream.next(); task !== null; task = await stream.next()) {
      looked++
      // a wide scope's stream hands out other projects' tasks too
      if (task.org_id === scope.orgId && projects.has(task.project_id)) {
        scanned++
        const facts = taskFacts(ctx, task)
        if (await rules.keeps(task, facts)) {
          const first = last === null
          const row = await rules.row(task, facts, first ? room : budget, first)
          if (row === null) {
            // a first task without a row would end the list early
            if (first) throw new Error('the first task of an archived page needs a row')
            // the row does not fit this page, so the next page starts with it
            return { rows, next: last, scanned: scanned - 1 }
          }
          rows.push(row)
        }
      }
      last = cursorAfter(task)
      if (
        rows.length >= limit ||
        looked >= ARCHIVE_PAGE.tasks ||
        !(await readsUnder(ctx, budget))
      ) {
        return { rows, next: stream.more() ? last : null, scanned }
      }
    }
    return { rows, next: null, scanned }
  } finally {
    await stream.close()
  }
}

/* ------------------------------------------------------ the Archived tasks
 * page of the app (issues.archivedPage) */

/** The most rows one page of the app's Archived tasks answers, and how many
 * it answers unless asked for fewer. */
export const ARCHIVED_PAGE_ROWS = 100

/**
 * The projects whose archived tasks the app's Archived tasks page lists for
 * `project`, as `me` sees them. A sub-project is itself. A top-level project
 * adds its sub-projects that share its archived state and that `me` can see,
 * as the app's project tree shows them (src/store/viewModels.ts shapeProject
 * `children`). Its own id stays in, though tasks live only in sub-projects,
 * which costs one empty range. So an active project leaves out a sub-project
 * archived on its own, where a restored task would stay hidden everywhere.
 * REST and MCP archived lists include such sub-projects (lib/core.ts
 * taskListScope). The caller has already checked that `me` sees `project`.
 */
export async function archiveFamily(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
): Promise<string[]> {
  if (project.type !== 'meta') return [project.id]
  const out = [project.id]
  const kids = ctx.db.query('projects').withIndex('by_parent', (q) => q.eq('parent_id', project.id))
  for await (const kid of kids) {
    if ((kid.archived_at === undefined) !== (project.archived_at === undefined)) continue
    if (await canSeeProject(ctx, me, kid)) out.push(kid.id)
  }
  return out
}

/** An archived task as the Archived tasks page shows it: its stored fields
 * without the description, the parent or server-owned marks, and whether it
 * is a group. */
export type ArchivedPageRow = Omit<
  Doc<'issues'>,
  '_id' | '_creationTime' | 'description' | 'parent_id' | 'relations_marked' | 'window_key'
> & { archived_at: string; is_group: boolean }

/**
 * One page of the archived tasks of `project`'s family (archiveFamily) for
 * `me`, most recently archived first, as the app's Archived tasks page asks
 * for it. With a `search`, the rows are the tasks that match it
 * (archivedTaskMatcher), and a page may stop early under the read budget;
 * the caller passes `next` back until it is null. `scanned` counts the
 * family's archived tasks the page looked at, so the page can say how far a
 * search reached. The caller has already checked that `me` sees `project`.
 */
export async function archivedPageCore(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  project: Doc<'projects'>,
  o: { cursor: ArchiveCursor | null; search: string; limit: number },
): Promise<ArchivedTasksPage<ArchivedPageRow>> {
  const projectIds = await archiveFamily(ctx, me, project)
  const matches = o.search
    ? await archivedTaskMatcher(ctx, me.org_id, o.search, {
        stars: false,
        names: () => rosterNames(ctx, me.org_id),
      })
    : null
  return await archivedTasksPage(ctx, { orgId: me.org_id, projectIds }, o.cursor, o.limit, {
    keeps: async (task, facts) => matches === null || (await matches(task, facts)),
    row: (task, facts) => pageRow(task, facts),
  })
}

/* `task` as the Archived tasks page shows it (ArchivedPageRow). */
async function pageRow(task: ArchivedTask, facts: TaskFacts): Promise<ArchivedPageRow> {
  const {
    _id,
    _creationTime,
    description: _description,
    parent_id: _parent,
    relations_marked: _marks,
    window_key: _window,
    ...row
  } = task
  return { ...row, is_group: await facts.isGroup() }
}

/**
 * The archived task `id` as the app's Archived tasks page shows it to the
 * caller, whose active profiles are `myProfiles` keyed by organization, or
 * null when that page lists it for none of the caller's projects. It applies
 * the page's rule for a row: the task is archived, and the caller's seat in
 * the organization of the task's project sees that project (canSeeProject).
 * The page of that project lists such a task (archivedPageCore), so the
 * answer tells nothing the page does not. An active, deleted or unknown task
 * and one in a project the caller cannot see all answer null.
 */
export async function archivedTaskCore(
  ctx: QueryCtx,
  myProfiles: ReadonlyMap<string, Doc<'profiles'>>,
  id: string,
): Promise<ArchivedPageRow | null> {
  const task = await byId(ctx, 'issues', id)
  if (task === null || !isArchived(task)) return null
  const project = await byId(ctx, 'projects', task.project_id)
  // the page reads only its own organization's tasks
  if (project === null || project.org_id !== task.org_id) return null
  const me = myProfiles.get(project.org_id)
  if (me === undefined || !(await canSeeProject(ctx, me, project))) return null
  return await archivedRowOf(ctx, task)
}

/** Archived task `task` as the Archived tasks page shows it
 * (ArchivedPageRow), for a caller who has checked archivedTaskCore's rule
 * already: the caller's seat in the task's organization sees its project.
 * It reads whether the task is a group, one index range. */
export async function archivedRowOf(ctx: QueryCtx, task: ArchivedTask): Promise<ArchivedPageRow> {
  return await pageRow(task, taskFacts(ctx, task))
}
