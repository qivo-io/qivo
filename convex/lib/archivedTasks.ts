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
 * Callers get the position sealed (archiveCursorText, scopeCursorText), since
 * it can be a task of a project they cannot see. The task window looks up its
 * own task in the archive by id instead (issues.archivedTask, archivedTaskCore
 * below).
 *
 * Both surfaces page through archivedTasksPage, under one read budget, over a
 * scope (ArchiveScope) that either merges a list of projects or reads the
 * organization's whole archive and keeps only the tasks the scope holds. The
 * app's page asks for some projects of one organization or for all of them
 * (ArchivedPageScope). Both search with archivedTaskMatcher, the task search
 * rule (lib/search.ts taskSearchText) that reads a task's labels, assignee
 * and subtasks only when they can change the answer, never the
 * organization's roster, and its labels only up to ARCHIVE_LABELS.scan. The
 * organization's matching labels and roster names that active task lists
 * read live here too. */

import type { TransactionMetric, TransactionMetrics } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { descriptionOf } from '../model/descriptions'
import { type Grantee, navReady } from '../model/projectNav'
import { canSeeProject, levelRank, OWN_READS, projectLevelsOf, receivesTeamAccess } from './access'
import { digestText, openCursorText, sealCursorText } from './archiveCursorSeal'
import { byId } from './db'
import { taskOwnerId } from './review'
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

/** What the app's Archived tasks page asks for (issues.archivedPage): the
 * archived tasks of some projects of one organization, a top-level project
 * standing for its family (archivedPageCore), or of every project of the
 * organization the caller sees. */
export type ArchivedPageScope =
  | { kind: 'projects'; orgId: string; projectIds: readonly string[] }
  | { kind: 'all'; orgId: string }

/* A scope as text of one length: the SHA-256 of its kind, its organization
 * and its project ids, each once and sorted, as JSON. */
const scopeKey = (scope: ArchivedPageScope): Promise<string> =>
  digestText(
    JSON.stringify(
      scope.kind === 'all'
        ? [scope.kind, scope.orgId]
        : [scope.kind, scope.orgId, [...new Set(scope.projectIds)].sort()],
    ),
  )

/* What a cursor of the app's page seals, `3:<kind>:<scope key>~<position>`.
 * The colon after the version is in no project uuid, so a `2~` cursor's
 * sealed text never opens as this one, nor this one as a `2~` cursor's. */
const SCOPE_SEALED_TEXT = /^3:(projects|all):([0-9a-f]{64})~(.+)$/s

/* The longest `3~` cursor scopeCursorText writes: `3:`, the longer kind and
 * a colon, the scope key's 64 hex characters and a `~`, a position of at most
 * 284 bytes as in SEALED_MAX, and the 16-byte tag, as hex. */
const SCOPE_SEALED_MAX = 2 + 2 * (2 + 8 + 1 + 64 + 1 + 284 + 16)

/** A cursor of the app's page as callers see it, `3~` and the position
 * sealed together with the version, the scope's kind and its key. It seals
 * the scope as asked for, not the projects it expanded to, since a family's
 * sub-projects can change between pages. */
export const scopeCursorText = async (
  c: ArchiveCursor,
  scope: ArchivedPageScope,
): Promise<string> =>
  `3~${await sealCursorText(`3:${scope.kind}:${await scopeKey(scope)}~${positionText(c)}`)}`

/** The position `text` names for `scope`, or null when it is not a cursor
 * scopeCursorText wrote for that scope. A cursor of another scope, kind or
 * organization would start this list part way, as another project's would
 * (parseArchiveCursor), and a `2~` cursor is not one of the app's scopes, so
 * all of them are refused. */
export async function parseScopeCursor(
  text: string,
  scope: ArchivedPageScope,
): Promise<ArchiveCursor | null> {
  if (!text.startsWith('3~') || text.length > SCOPE_SEALED_MAX) return null
  const opened = await openCursorText(text.slice(2))
  const m = opened === null ? null : SCOPE_SEALED_TEXT.exec(opened)
  if (m === null || m[1] !== scope.kind || m[2] !== (await scopeKey(scope))) return null
  return positionOf(m[3])
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

/** The archived tasks one page covers, in the organization `orgId`: it
 * reads those of `projectIds`, merged project by project
 * (archivedTasksAfter), or the organization's whole archive when it is null,
 * and keeps a task that read hands out only when `holds` says the task is in
 * scope. A page never keeps a task of another organization, whatever `holds`
 * answers.
 *
 * `wide` says whether the page may read the organization's whole archive:
 * only for a caller who sees every live project of it, an organization
 * admin, from whom that read hides nothing they cannot see elsewhere, such
 * as an archived project's tasks. A read of the whole archive passes tasks
 * the scope does not hold, and where a page of it ends, what more() says
 * and how far its budget goes all follow those tasks, which would tell
 * another caller about projects they cannot see. So for anyone else
 * projectIds names the projects and the page reads nothing else. */
export type ArchiveScope = {
  orgId: string
  projectIds: readonly string[] | null
  holds(task: ArchivedTask): Promise<boolean>
  wide: boolean
}

/** The scope of the archived tasks of `projectIds` in the organization
 * `orgId`, as REST and MCP archived lists and the app's page for a few
 * projects name it, `wide` only for an organization admin (ArchiveScope). */
export function projectsScope(
  orgId: string,
  projectIds: readonly string[],
  wide: boolean,
): ArchiveScope {
  const projects = new Set(projectIds)
  return { orgId, projectIds, wide, holds: async (task) => projects.has(task.project_id) }
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
 * The archived tasks of `scope.projectIds` after `cursor`, in archive order,
 * or of the organization's whole archive when the scope names no projects,
 * which only a `wide` scope may (ArchiveScope). It holds each project's next
 * task, so it reads one task per project when it opens, then one more task
 * of a project each time it hands one out. A page pays only for what it
 * pulls, and more() needs no read. Before it opens each project after the
 * first it asks `mayOpen` whether the reads so far leave room. When they do
 * not, a wide scope closes the projects it opened and reads the
 * organization's archive instead, one task at a time, which hands out tasks
 * of other projects too that the caller skips (ArchiveScope holds). Any
 * other scope answers null, as its projects are too many to open side by
 * side; what decided it is the heads of the scope's own projects alone.
 * Call close() when done, so no query stays open.
 */
export async function archivedTasksAfter(
  ctx: QueryCtx,
  scope: Pick<ArchiveScope, 'orgId' | 'projectIds' | 'wide'>,
  cursor: ArchiveCursor | null,
  mayOpen: () => Promise<boolean>,
): Promise<ArchivedTaskStream | null> {
  let streams: AsyncGenerator<ArchivedTask>[] = []
  const heads: (ArchivedTask | null)[] = []
  const pull = async (i: number) => {
    const step = await streams[i].next()
    heads[i] = step.done === true ? null : step.value
  }
  if (scope.projectIds === null) {
    if (!scope.wide) throw new Error('only a wide scope reads the organization’s archive')
    streams = [organizationArchive(ctx, scope.orgId, cursor)]
    await pull(0)
  }
  for (const projectId of scope.projectIds ?? []) {
    if (streams.length > 0 && !(await mayOpen())) {
      for (const stream of streams) await stream.return(undefined)
      if (!scope.wide) return null
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
 * tasks of its scope. Opening the scope's projects side by side, a task
 * each, may read the `opening` share of the page before a wide scope reads
 * the organization's archive instead, and the whole page for any other
 * scope, which has no other read (archivedTasksAfter). Tests lower these. */
export const ARCHIVE_PAGE = {
  tasks: 1000,
  ranges: 1500,
  documents: 16_000,
  bytes: 8 << 20,
  opening: 1 / 4,
}

/** What an archived page keeps back from the request's limits, for the
 * reads one task makes after the page's last check and the reads of the
 * page's end. The first task a page looks at may use the rest. Between two
 * checks a task can read, in index ranges and documents:
 *
 * - the scope's check of a project not asked before (ArchiveScope holds):
 *   the project and its parent (2 and 2), the caller's grant on it (1 and
 *   1), its team shares (1 range), and for each share of a team not asked
 *   before a membership and the team (2 and 2 a share);
 * - its filters and search: whether it is a group (1 and 1), its text (1
 *   and 2, model/descriptions.ts descriptionOf), its labels (1 and at most
 *   LIMITS.labels.max, 20) and, past ARCHIVE_LABELS.scan, each of those
 *   labels by id (20 and 20), and its assignee's profile (1 and 1);
 * - its row: the owner's profile (1 and 1), or past a REST or MCP row's
 *   walk at most four more documents (lib/core.ts listArchivedIssuesCore):
 *   the subtask its walk read last, the first subtask of a group too large
 *   to walk, its parent and its newest comment.
 *
 * That is 30 ranges and 51 documents with a few shares and four more for
 * each further share, so the reserve covers a project shared with about ten
 * teams. The bytes hold seven documents at Convex's size limit: two
 * description rows and four REST documents, the rest small. The app's page
 * keeps LEVEL_STEP_READS back too. Tests lower these. */
export const ARCHIVE_RESERVE = { ranges: 64, documents: 128, bytes: 7 * DOCUMENT_MAX_BYTES }

/** What the app's page keeps back beyond ARCHIVE_RESERVE: the task whose
 * scope check asks its levels instance about the 32nd, 128th or 512th
 * project reads the caller's own grants and memberships, each up to one row
 * past the step, and the shares of their teams, up to OWN_READS.rows rows
 * and one range a team, at once (lib/access.ts OWN_READS). A grant, a
 * membership and a share hold ids and a level, a few hundred bytes at
 * most. */
export const LEVEL_STEP_READS = {
  ranges: 2 + OWN_READS.teams,
  documents: 2 * (Math.max(...OWN_READS.steps) + 1) + OWN_READS.rows + 1,
  bytes: 512 << 10,
}

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

/* `read` of each key, read once and kept. */
function memoized<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const known = new Map<string, Promise<T>>()
  return (key) => {
    let value = known.get(key)
    if (value === undefined) {
      value = read(key)
      known.set(key, value)
    }
    return value
  }
}

/** The name of the profile with an id in the organization `orgId`, or
 * undefined for none there, each profile read once by id. The app's page
 * names a search's assignees and its rows' owners this way, so it reads the
 * profiles of the tasks it looks at and never the organization's roster. */
export const profileNamesIn = (
  ctx: QueryCtx,
  orgId: string,
): ((profileId: string) => Promise<string | undefined>) =>
  memoized(async (id) => {
    const profile = await byId(ctx, 'profiles', id)
    return profile !== null && profile.org_id === orgId ? profile.name : undefined
  })

/** How many of the organization's labels a search reads at once. When the
 * organization has at most `scan` labels, a search reads them all in one
 * range and reads a task's labels only when one of them holds a piece of the
 * search. Past it, items 5 and 12b of the limits plan set no cap on labels,
 * so it reads instead the labels of each task whose own fields, text and
 * assignee did not match, by id. A label stores a name of at most 40
 * characters, its lowercase copy, a color and two ids, so labels at the
 * longest names read 301 bytes each, measured, and 1,000 of them one range
 * and about 300 KB (convex/tests/archived.test.ts). The scan reads one label
 * more to tell whether that was all. Tests lower it. */
export const ARCHIVE_LABELS = { scan: 1000 }

/* The organization's labels whose lowercased name holds one of `pieces`,
 * in the organization's label order, when it has at most
 * ARCHIVE_LABELS.scan labels, else null. */
async function scannedLabels(
  ctx: QueryCtx,
  orgId: string,
  pieces: readonly string[],
  holdsPiece: (label: Doc<'labels'>) => boolean,
): Promise<Doc<'labels'>[] | null> {
  if (pieces.length === 0) return []
  const labels = await ctx.db
    .query('labels')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .take(ARCHIVE_LABELS.scan + 1)
  return labels.length > ARCHIVE_LABELS.scan ? null : labels.filter(holdsPiece)
}

/* Labels in the order of by_org: creation time, then document id. */
const labelOrder = (a: Doc<'labels'>, b: Doc<'labels'>): number =>
  a._creationTime - b._creationTime || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)

/** A test of whether an archived task matches `search`. */
export type ArchivedTaskMatcher = (task: ArchivedTask, facts: TaskFacts) => Promise<boolean>

/**
 * The task search rule for archived tasks of the organization `orgId`, the
 * one the app's filter and REST and MCP search share (lib/search.ts
 * taskSearchText). Each fragment of `search` must occur in the task ID,
 * title, description, status name (not on a task with subtasks), priority
 * name, assignee name or label names, in any order. With `stars`, as REST
 * reads it, `*` stands for any run of text, which may span fields, so the
 * label names keep the organization's label order.
 *
 * More text never undoes a match, so it first tries the fields the task's
 * own row holds. Only when they fail does it read its description row, and
 * only when that fails too what else can still change the answer: the
 * assignee's name (`nameOf`), whether the task is a group when some fragment
 * occurs in a status name, and the names of the task's labels that hold a
 * piece of the search. It reads the organization's labels once, up to
 * ARCHIVE_LABELS.scan, and then reads a task's labels only when one of those
 * holds a piece; an organization with more labels has each task's labels
 * read, and each label by id, once per matcher. Those reads go through
 * `facts` so the task's row can reuse them.
 */
export async function archivedTaskMatcher(
  ctx: QueryCtx,
  orgId: string,
  search: string,
  o: { stars: boolean; nameOf: (profileId: string) => Promise<string | undefined> },
): Promise<ArchivedTaskMatcher> {
  const matches = allWordsMatcher(search, o.stars)
  const pieces = searchPieces(search, o.stars)
  // a label whose name holds none of the pieces never changes the answer
  const holdsPiece = (label: Doc<'labels'>) => {
    const name = label.name.toLowerCase()
    return pieces.some((piece) => name.includes(piece))
  }
  const scanned = await scannedLabels(ctx, orgId, pieces, holdsPiece)
  const labelOf = memoized((id) => byId(ctx, 'labels', id))
  /* the names of the task's labels that hold a piece, in label order */
  const labelNames = async (facts: TaskFacts): Promise<string[]> => {
    if (scanned !== null) {
      if (scanned.length === 0) return []
      const held = new Set(await facts.labelIds())
      return scanned.filter((l) => held.has(l.id)).map((l) => l.name)
    }
    const labels = await Promise.all([...new Set(await facts.labelIds())].map(labelOf))
    return labels
      .filter((l): l is Doc<'labels'> => l !== null && l.org_id === orgId && holdsPiece(l))
      .sort(labelOrder)
      .map((l) => l.name)
  }
  // a status line holding none of the pieces never changes the answer
  const statusMatters = Object.values(STATUS_NAMES).some((name) => {
    const lower = name.toLowerCase()
    return pieces.some((piece) => lower.includes(piece))
  })
  return async (task, facts) => {
    const own = searchFields(task, new Map())
    const cheap = { ...own, group: true, labelNames: [] }
    if (matches(taskSearchText({ ...cheap, description: '' }))) return true
    const description = await facts.description()
    if (matches(taskSearchText({ ...cheap, description }))) return true
    const assigneeName = task.assignee_id === undefined ? null : await o.nameOf(task.assignee_id)
    return matches(
      taskSearchText({
        ...own,
        description,
        assigneeName,
        group: statusMatters ? await facts.isGroup() : true,
        labelNames: await labelNames(facts),
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
  /** What the page keeps back from the request's limits, ARCHIVE_RESERVE
   * unless given. */
  reserve?: ReadCeiling
}

/** One page of archived tasks: its rows, where the next page starts, or
 * null when no archived task of the scope follows, and how many tasks of the
 * scope it looked at. `tooWide` says a scope that may not read the
 * organization's archive has more projects than one page can open side by
 * side, so the page answers no rows (archivedTasksAfter). */
export type ArchivedTasksPage<Row> = {
  rows: Row[]
  next: ArchiveCursor | null
  scanned: number
  tooWide?: true
}

/**
 * One page of the archived tasks of `scope` after `cursor`, in archive
 * order. It stops at `limit` rows, after looking at ARCHIVE_PAGE.tasks
 * tasks of the scope, or once it has spent ARCHIVE_PAGE's reads, so it can
 * hold fewer rows than `limit`, even none, while `next` is set. `next` is the
 * last task the page looked at, not the last row, so the next page never
 * rereads tasks `rules.keeps` left out. A task outside the scope's
 * organization, or one the scope does not hold, is never kept or counted in
 * `scanned`, which fails closed when the stream reads the organization's
 * whole archive. Only a wide scope reads that (ArchiveScope), as such a read
 * passes tasks the caller would not see elsewhere: their reads spend the
 * budget, and more() looks at them. Any other scope reads only its own
 * projects, opening them side by side within the whole budget, and answers
 * `tooWide` when even that does not fit. Its budget counts from the
 * request's reads when it starts, so what the caller read before, such as
 * the scope's projects and a search's labels, leaves the page that much less
 * room under the request's limits.
 */
export async function archivedTasksPage<Row>(
  ctx: QueryCtx,
  scope: ArchiveScope,
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
  const room = roomOf(start, rules.reserve ?? ARCHIVE_RESERVE)
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
  const rows: Row[] = []
  // a scope that may not read the organization's archive has no cheaper
  // read, so its projects may open within the whole budget
  const stream = await archivedTasksAfter(ctx, scope, cursor, () =>
    readsUnder(ctx, scope.wide ? opening : budget),
  )
  if (stream === null) return { rows: [], next: null, scanned: 0, tooWide: true }
  let last: ArchiveCursor | null = null
  let scanned = 0
  try {
    for (let task = await stream.next(); task !== null; task = await stream.next()) {
      // a read of the organization's archive hands out other projects' tasks too
      if (task.org_id === scope.orgId && (await scope.holds(task))) {
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
        scanned >= ARCHIVE_PAGE.tasks ||
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

/** How many rows one page of the app's Archived tasks answers when the call
 * names no limit: the 25 a page shows (limits plan, "Archived task browsing
 * and search"). */
export const ARCHIVED_PAGE_ROWS = 25

/** The most rows one page of the app's Archived tasks answers when asked.
 * A tab loaded before pages of 25 asks for 100 and keeps working until it
 * reloads. A later release lowers it to 25. */
export const ARCHIVED_PAGE_MOST = 100

/** How far a page expands its scope before its read budget starts: at
 * most `ids` distinct project ids (issues.archivedPage refuses more), and at
 * most `subProjects` projects merged side by side, the sub-projects of named
 * top-level projects and, for All projects, the projects the caller
 * reaches, each checked for the caller once. To find them it reads the
 * project_reach rows of the caller's seat and of at most `teams` of their
 * teams, and at most `rows` such rows and sub-project rows in all, skipped
 * and repeated ones included. A family has no cap on sub-projects (limits
 * plan, item 4), so past those bounds an organization admin's page reads the
 * organization's archive instead, and anyone else's answers that the scope
 * is too wide (ArchiveScope). REST and MCP archived lists of more than
 * `subProjects` projects answer the same for anyone but an admin. At the
 * description cap in a three-byte script a task row is about 61 KB, so the
 * heads of about 130 such projects fill a page's bytes (ARCHIVE_PAGE.bytes,
 * convex/tests/archived.test.ts measures it); 200 keeps ordinary scopes
 * whole and leaves the rest to that budget. Tests lower them. */
export const ARCHIVED_SCOPE = { ids: 50, subProjects: 200, teams: 64, rows: 1000 }

/* What readScope answers for a scope it may not merge side by side and may
 * not read through the organization's archive (ArchiveScope wide). */
const TOO_WIDE = 'too wide'

/* What readScope still may read to find a scope's projects: project_reach
 * and sub-project rows, each counted as read (ARCHIVED_SCOPE.rows). */
type RowRoom = { rows: number }

/* Counts one row read against `room`, and answers whether it was within
 * it. */
const counted = (room: RowRoom): boolean => --room.rows >= 0

/**
 * The projects whose archived tasks the app's Archived tasks page lists for
 * `project`, as `me` sees them, when a tab from before scopes names one
 * project (issues.archivedPage `project_id`). It reads every sub-project
 * and checks each one by itself, so only that deprecated argument uses it;
 * scopes expand a family within ARCHIVED_SCOPE. A sub-project is itself. A
 * top-level project
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

/** An archived task as the app's Archived tasks page lists it: its row
 * (ArchivedPageRow) with where it lives, who owns it and whether the caller
 * may restore it, so the page needs none of the planner's projects, people
 * or levels. */
export type ArchivedListRow = ArchivedPageRow & {
  /** the names of the task's project and of the top-level project above
   * it, null for a project without a parent */
  place: { project_name: string; parent_name: string | null }
  /** the name of the task's owner (lib/review.ts taskOwnerId), or null when
   * it has none or the profile is gone */
  owner_name: string | null
  /** whether the caller has Edit or lead on the task's project, as
   * issues.unarchive asks (model/issues.ts assertCanEdit) */
  can_restore: boolean
}

/** What issues.archivedPage asks archivedPageCore for: a scope of the app's
 * page, or the family of one project, as a tab from before scopes asks
 * (archiveFamily). */
export type ArchivedPageRequest = ArchivedPageScope | { kind: 'family'; project: Doc<'projects'> }

/* What projectLevelsOf answers. */
type ProjectLevels = ReturnType<typeof projectLevelsOf>

/* Whether the project with an id is a live project of the organization
 * `orgId` under a live parent, or without one, that the caller of `levels`
 * sees, each project asked once. A top-level project is asked without
 * navigation, as a parent shown only to reach one of its sub-projects grants
 * nothing else, and that leaves out its sub-projects' walk. Tasks live only
 * in sub-projects (model/issues.ts), so it changes nothing a page lists. */
const shownIn = (levels: ProjectLevels, orgId: string) =>
  memoized(async (id) => {
    const project = await levels.project(id)
    if (project === null || project.org_id !== orgId || project.archived_at !== undefined)
      return false
    if (project.parent_id !== undefined) {
      const parent = await levels.project(project.parent_id)
      if (parent === null || parent.archived_at !== undefined) return false
    }
    return (await levels.level(id, false)) !== null
  })

/* The live sub-projects of top-level project `top`, each added to `found`,
 * the distinct projects a scope has found so far, or null when `found`
 * passes `most` or reading them passes `room`. One already in `found` counts
 * once, and archived ones never count. A project stored before
 * archive_state existed has none until internal/navBackfill gives it one,
 * so those are read too and kept while live; every one read counts against
 * `room`. */
async function liveSubProjects(
  ctx: QueryCtx,
  top: Pick<Doc<'projects'>, 'id' | 'org_id'>,
  found: Set<string>,
  most: number,
  room: RowRoom,
): Promise<Doc<'projects'>[] | null> {
  const out: Doc<'projects'>[] = []
  for (const state of ['live', undefined] as const) {
    const kids = ctx.db
      .query('projects')
      .withIndex('by_org_parent_state_name', (q) =>
        q.eq('org_id', top.org_id).eq('parent_id', top.id).eq('archive_state', state),
      )
    for await (const kid of kids) {
      if (!counted(room)) return null
      if (kid.archived_at !== undefined) continue
      out.push(kid)
      found.add(kid.id)
      if (found.size > most) return null
    }
  }
  return out
}

/* Whose project_reach rows tell what `me` reaches: their seat, and each of
 * their teams when their role receives team access (a guest's does not).
 * Null while the organization's rows are not complete (model/projectNav.ts
 * navReady), or when `me` is in more than ARCHIVED_SCOPE.teams teams. */
async function granteesOf(ctx: QueryCtx, me: Doc<'profiles'>): Promise<Grantee[] | null> {
  if (!(await navReady(ctx, me.org_id))) return null
  const seat: Grantee = { grantee_kind: 'profile', grantee_id: me.id }
  if (!receivesTeamAccess(me)) return [seat]
  const memberships = await ctx.db
    .query('team_members')
    .withIndex('by_profile', (q) => q.eq('profile_id', me.id))
    .take(ARCHIVED_SCOPE.teams + 1)
  if (memberships.length > ARCHIVED_SCOPE.teams) return null
  return [
    seat,
    ...memberships.map((m): Grantee => ({ grantee_kind: 'team', grantee_id: m.team_id })),
  ]
}

/* The live projects of the caller's organization that `grantees` reach
 * (granteesOf), for All projects: each top-level project on which one holds
 * a source of its own, with all its live sub-projects, which that source
 * reaches, and each live sub-project on which one holds one. Null when they
 * are more than `most`, or when the rows it reads, root rows for navigation
 * only, repeats and the sub-project rows included, pass `room`. A row finds
 * a candidate and grants nothing: the caller checks each (shownIn), and a
 * role that turns no source into access, such as a viewer's lead, drops out
 * there. A project several rows find, such as a sub-project of the caller's
 * own beside its parent's team share, counts once toward `most`. `read`
 * holds the projects read on the way. */
async function reachedProjects(
  ctx: QueryCtx,
  orgId: string,
  grantees: readonly Grantee[],
  most: number,
  room: RowRoom,
): Promise<{ ids: string[]; read: Doc<'projects'>[] } | null> {
  const ids = new Set<string>()
  const read: Doc<'projects'>[] = []
  const reach = (g: Grantee, kind: 'root' | 'child') =>
    ctx.db
      .query('project_reach')
      .withIndex('by_grantee_list', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('kind', kind)
          .eq('live', true),
      )
  for (const g of grantees) {
    for await (const row of reach(g, 'root')) {
      if (!counted(room)) return null
      // a root row for navigation only reaches the sub-projects of its child rows
      if (!row.on_root || row.org_id !== orgId || ids.has(row.project_id)) continue
      ids.add(row.project_id)
      if (ids.size > most) return null
      const kids = await liveSubProjects(
        ctx,
        { id: row.project_id, org_id: orgId },
        ids,
        most,
        room,
      )
      if (kids === null) return null
      read.push(...kids)
    }
    for await (const row of reach(g, 'child')) {
      if (!counted(room)) return null
      if (row.org_id !== orgId) continue
      ids.add(row.project_id)
      if (ids.size > most) return null
    }
  }
  return { ids: [...ids], read }
}

/* Adds to `found`, the distinct projects a scope has found so far, the live
 * sub-projects under top-level project `rootId` on which one of `grantees`
 * holds a source of its own (project_reach child rows), which a caller who
 * sees `rootId` only to reach them may see. Answers whether it found any,
 * or null when `found` passes `most` or the rows read, repeats included,
 * pass `room`. The caller checks each (shownIn). */
async function reachedUnder(
  ctx: QueryCtx,
  grantees: readonly Grantee[],
  rootId: string,
  found: Set<string>,
  most: number,
  room: RowRoom,
): Promise<boolean | null> {
  let any = false
  for (const g of grantees) {
    const rows = ctx.db
      .query('project_reach')
      .withIndex('by_grantee_root', (q) =>
        q
          .eq('grantee_kind', g.grantee_kind)
          .eq('grantee_id', g.grantee_id)
          .eq('root_id', rootId)
          .eq('kind', 'child')
          .eq('live', true),
      )
    for await (const row of rows) {
      if (!counted(room)) return null
      any = true
      found.add(row.project_id)
      if (found.size > most) return null
    }
  }
  return any
}

/* The scope that merges `candidates`, the ones of them `shown` keeps, or
 * null when it keeps none, `wide` as ArchiveScope says. */
async function mergedScope(
  orgId: string,
  candidates: readonly string[],
  shown: (id: string) => Promise<boolean>,
  wide: boolean,
): Promise<ArchiveScope | null> {
  const ids = [...new Set(candidates)]
  const seen = await Promise.all(ids.map(shown))
  const projectIds = ids.filter((_, i) => seen[i])
  return projectIds.length === 0 ? null : projectsScope(orgId, projectIds, wide)
}

/* The archived tasks `asked` covers for `me`, with the levels instance that
 * answered for its projects: a scope, null when it covers no project, which
 * answers the same empty last page as an empty archive, or TOO_WIDE when
 * `me` is no organization admin and its projects cannot be found or merged
 * side by side within ARCHIVED_SCOPE. Only an admin's scope reads the
 * organization's archive (ArchiveScope wide).
 *
 * - `all` merges the live projects `me` sees side by side, found through
 *   the project_reach rows of their seat and teams (reachedProjects) and
 *   each checked (shownIn), so one who sees none reads nothing. It is too
 *   wide when they reach more than ARCHIVED_SCOPE.subProjects projects, are
 *   in more than ARCHIVED_SCOPE.teams teams, need more than
 *   ARCHIVED_SCOPE.rows rows to find their projects, or their organization's
 *   reach rows are not complete. An admin, who sees every live project,
 *   reads the organization's archive, which holds a task whose project is
 *   live and under a live parent. So a sub-project archived on its own under
 *   an active parent stays out, as do archived projects, until they are
 *   restored.
 * - `projects` keeps the named live projects of the organization. A named
 *   top-level project stands for its live sub-projects that `me` sees: all
 *   of them when `me` holds access on the top-level project itself, else
 *   those on which they hold a source of their own (reachedUnder). One `me`
 *   sees neither way drops out before any of its sub-projects is read, as
 *   does an archived, unknown or foreign id, so no answer tells them apart.
 *   A family `me` sees only to reach some of its sub-projects drops out
 *   too while the organization's reach rows cannot be read, which fails
 *   closed. Past the bounds it is too wide, and an admin's page reads the
 *   organization's archive and holds a task of a named project or of a
 *   sub-project of a family kept.
 * - `family` is archiveFamily's list, for the deprecated one-project
 *   argument, too wide past ARCHIVED_SCOPE.subProjects projects for anyone
 *   but an admin. */
async function readScope(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  asked: ArchivedPageRequest,
): Promise<{ scope: ArchiveScope | null | typeof TOO_WIDE; levels: ProjectLevels }> {
  const orgId = me.org_id
  const admin = me.org_role === 'admin'
  const room: RowRoom = { rows: ARCHIVED_SCOPE.rows }
  if (asked.kind === 'family') {
    const projectIds = await archiveFamily(ctx, me, asked.project)
    const levels = projectLevelsOf(ctx, me, [asked.project])
    if (!admin && projectIds.length > ARCHIVED_SCOPE.subProjects) return { scope: TOO_WIDE, levels }
    return { scope: projectsScope(orgId, projectIds, admin), levels }
  }
  if (asked.kind === 'all') {
    if (admin) {
      const levels = projectLevelsOf(ctx, me)
      const shown = shownIn(levels, orgId)
      return {
        scope: { orgId, projectIds: null, wide: true, holds: (task) => shown(task.project_id) },
        levels,
      }
    }
    const grantees = await granteesOf(ctx, me)
    const reached =
      grantees === null
        ? null
        : await reachedProjects(ctx, orgId, grantees, ARCHIVED_SCOPE.subProjects, room)
    const levels = projectLevelsOf(ctx, me, reached?.read ?? [])
    if (reached === null) return { scope: TOO_WIDE, levels }
    return { scope: await mergedScope(orgId, reached.ids, shownIn(levels, orgId), false), levels }
  }
  const named: Doc<'projects'>[] = []
  for (const id of new Set(asked.projectIds)) {
    const project = await byId(ctx, 'projects', id)
    if (project !== null && project.org_id === orgId && project.archived_at === undefined)
      named.push(project)
  }
  const isTop = (p: Doc<'projects'>) => p.type === 'meta' && p.parent_id === undefined
  // whether `me` holds access on a named top-level project itself, which
  // reaches all its sub-projects
  const topLevels = projectLevelsOf(ctx, me, named)
  const families = new Set<string>()
  const kids: Doc<'projects'>[] = []
  // the distinct sub-projects the families kept stand for
  const found = new Set<string>()
  let grantees: Grantee[] | null | undefined
  let wide = false
  for (const top of named.filter(isTop)) {
    // past the bounds only an admin's page goes on, through the organization's archive
    if (wide && !admin) break
    if ((await topLevels.level(top.id, false)) !== null) {
      families.add(top.id)
      if (wide) continue
      const subs = await liveSubProjects(ctx, top, found, ARCHIVED_SCOPE.subProjects, room)
      if (subs === null) wide = true
      else kids.push(...subs)
      continue
    }
    grantees ??= await granteesOf(ctx, me)
    if (grantees === null) continue
    // once wide, `found` or `room` is past its bound, so this stops at its
    // first row and tells only whether `me` reaches any of the family
    const any = await reachedUnder(ctx, grantees, top.id, found, ARCHIVED_SCOPE.subProjects, room)
    if (any === false) continue
    families.add(top.id)
    if (any === null) wide = true
  }
  const levels = projectLevelsOf(ctx, me, [...named, ...kids])
  if (wide && !admin) return { scope: TOO_WIDE, levels }
  const shown = shownIn(levels, orgId)
  // the named projects that stand for themselves, and the families kept
  const own = named.filter((p) => !isTop(p) || families.has(p.id)).map((p) => p.id)
  if (wide) {
    const ownIds = new Set(own)
    const holds = memoized(async (id) => {
      const project = await levels.project(id)
      if (project === null) return false
      const inFamily = project.parent_id !== undefined && families.has(project.parent_id)
      return (ownIds.has(project.id) || inFamily) && (await shown(project.id))
    })
    return {
      scope: { orgId, projectIds: null, wide: true, holds: (task) => holds(task.project_id) },
      levels,
    }
  }
  const candidates = [...own, ...found]
  return { scope: await mergedScope(orgId, candidates, shown, admin), levels }
}

/**
 * One page of the archived tasks `asked` covers for `me`, most recently
 * archived first, as the app's Archived tasks page asks for it (readScope).
 * With a `search`, the rows are the tasks that match it
 * (archivedTaskMatcher), and a page may stop early under the read budget;
 * the caller passes `next` back until it is null. `scanned` counts the
 * scope's archived tasks the page looked at, so the page can say how far a
 * search reached. A scope that covers no project answers an empty last page,
 * the same as an empty archive.
 *
 * For anyone but an organization admin a page reads only the projects of its
 * scope, merged side by side, so no task of a project they cannot see
 * spends its budget or decides where it ends, and it answers `tooWide`, with
 * no rows, when the scope has more projects than ARCHIVED_SCOPE allows or
 * than one page can open (archivedTasksPage). What decides that is the
 * caller's own projects and their newest archived tasks. An admin's page
 * may read the organization's archive, which hides nothing from them. For
 * the deprecated `family` request the caller has already checked that `me`
 * sees the project.
 */
export async function archivedPageCore(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  asked: ArchivedPageRequest,
  o: { cursor: ArchiveCursor | null; search: string; limit: number },
): Promise<ArchivedTasksPage<ArchivedListRow>> {
  const { scope, levels } = await readScope(ctx, me, asked)
  if (scope === null) return { rows: [], next: null, scanned: 0 }
  if (scope === TOO_WIDE) return { rows: [], next: null, scanned: 0, tooWide: true }
  const nameOf = profileNamesIn(ctx, me.org_id)
  const matches = o.search
    ? await archivedTaskMatcher(ctx, me.org_id, o.search, { stars: false, nameOf })
    : null
  return await archivedTasksPage(ctx, scope, o.cursor, o.limit, {
    keeps: async (task, facts) => matches === null || (await matches(task, facts)),
    row: (task, facts) => listRow(task, facts, levels, nameOf),
    reserve: {
      ranges: ARCHIVE_RESERVE.ranges + LEVEL_STEP_READS.ranges,
      documents: ARCHIVE_RESERVE.documents + LEVEL_STEP_READS.documents,
      bytes: ARCHIVE_RESERVE.bytes + LEVEL_STEP_READS.bytes,
    },
  })
}

/* `task` as the app's Archived tasks page lists it (ArchivedListRow). Its
 * project and parent are read once each through `levels`, and so is the
 * caller's level, which the scope's check asked already. */
async function listRow(
  task: ArchivedTask,
  facts: TaskFacts,
  levels: ProjectLevels,
  nameOf: (profileId: string) => Promise<string | undefined>,
): Promise<ArchivedListRow> {
  const row = await pageRow(task, facts)
  const project = await levels.project(task.project_id)
  const parent = project?.parent_id === undefined ? null : await levels.project(project.parent_id)
  const owner = taskOwnerId(task, row.is_group)
  return {
    ...row,
    place: { project_name: project?.name ?? '', parent_name: parent?.name ?? null },
    owner_name: owner === undefined ? null : ((await nameOf(owner)) ?? null),
    can_restore: levelRank(await levels.level(task.project_id, false)) >= levelRank('user'),
  }
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
