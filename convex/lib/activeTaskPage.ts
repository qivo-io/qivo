/* One page of the active tasks REST GET /v1/tasks and MCP list_tasks list,
 * read from a cursor within a budget (listActiveIssuesCore). The archived
 * lists page with lib/archivedTasks.ts instead.
 *
 * A list covers the projects the caller can read: those a named project
 * covers (lib/core.ts taskListScope), else every readable project that is
 * not archived, top-level projects included, since a task older code stored
 * on one stays listed. Every caller's page, an organization admin's
 * included, reads only those projects, each one's active tasks in the
 * documented order (issues by_project_archived_created, created_at and then
 * number), merged side by side. So where a page stops and whether more
 * follows never depend on a task of a project the caller cannot read. Until
 * the admin access split lands an admin reads every project; after it the
 * same merge follows the split's rule through `readable`.
 *
 * The reads that follow hidden data are those lib/machineSubtree.ts names:
 * how many active subtasks a row has in projects the caller cannot read,
 * each counted at a fixed size, and the real bytes of hidden documents past
 * the caps at the real-bytes stop. Before the page the list reads the
 * organization's projects and the caller's access to them (lib/core.ts
 * loadCatalogue and accessFlags), its roster, and for a search up to
 * ARCHIVE_LABELS.scan of its labels, which hidden projects' rows fill too,
 * but the page's budget counts from its own start, and a request without
 * room for the whole budget is refused (TASK_LIST_UNREADABLE) rather than
 * answered with a shorter page. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { latestComment } from '../model/comments'
import { descriptionAndRows } from '../model/descriptions'
import { accessOf } from './access'
import {
  labelOrder,
  namesOf,
  type ReadCeiling,
  roomOf,
  rosterOf,
  scannedLabels,
  searchFields,
} from './archivedTasks'
import {
  type ActiveListOpts,
  type Caller,
  issueOut,
  type ListView,
  type McpIssueOut,
  type RestIssueJson,
} from './core'
import { byId } from './db'
import { badRequest } from './functions'
import { limitedText } from './limitRules'
import { LIMITS, MIB } from './limits'
import { CURSOR_REFUSAL, filtersKey, listCursorText, openListCursor } from './listCursor'
import { liveIn } from './liveTasks'
import { delayClock, pageForecaster } from './machineDelay'
import { type ReadTally, readTally, subtreeReads, totalsOf } from './machineSubtree'
import { taskOwnerId } from './review'
import { allWordsMatcher, searchPieces, taskSearchText } from './search'
import { STATUS_NAMES } from './taskRefs'
import { ownerSettled, ROW_BYTES } from './viewReads'

/** What one page of an active task list may read, counted from the page's
 * start with Convex's own transaction metrics, and within the request's
 * limits less ACTIVE_RESERVE. The rows may read all of it but `delays`,
 * the share their delays read once the rows are fixed
 * (lib/machineDelay.ts pageForecaster). A page also stops after looking at
 * `tasks` tasks, and opens at most `opening` projects' ranges at once. A
 * call whose request has no room for the whole budget, past the testing
 * envelope only, is refused with TASK_LIST_UNREADABLE. Tests lower these
 * and set them back with structuredClone.
 *
 * Measured in convex/tests/activeTaskPagesScale.test.ts, an organization of
 * 2,000 projects, 1,000 people and 50,000 active tasks with real titles and
 * texts, read under Convex's limits. Before the page, a member in 25 teams
 * that share every sub-project reads 55 ranges, 7,051 documents and
 * 1.77 MiB at ordinary name lengths. Their page of 200 rows across 2,000
 * projects reads 2,659 ranges, 11,458 documents and 4.34 MiB in all, an
 * organization admin's 2,615 ranges, 6,410 documents and 3.43 MiB, and a
 * page of a 199-project family 863 ranges. A search that matches some
 * tasks ends early, at 84 rows (2,964 ranges, 4.95 MiB), and one that
 * matches none answers no rows with a cursor (2,958 ranges, 4.46 MiB). The
 * delays' share holds the loads of about eight owners of 100 open tasks in
 * four sub-projects each, so a staff page whose 200 rows have 200 owners
 * judges eight of them and answers the rest unavailable (3,311 ranges); an
 * owner past the owner reader's bounds answers unavailable at once. That a
 * row of a person with very much open work says unavailable on every page,
 * while the task's own read judges it, is the agreed rule for figures that
 * depend on people's workloads (limits plan, "Testing and review
 * envelope", owner, 2026-11-01). */
export const ACTIVE_PAGE = {
  ranges: 3800,
  documents: 20_000,
  bytes: 5 * MIB,
  delays: { ranges: 900, documents: 6000, bytes: 1.5 * MIB } satisfies ReadCeiling,
  tasks: 5000,
  opening: 64,
}

/** What a page keeps back from the request's limits, for the reads one task
 * makes past the page's last check: its row read again where a page goes
 * on, its subtasks, at most LIMITS.subtasks.max, each counted as read, its
 * parent, its text (two description rows at most) and its newest comment,
 * each up to the size a rollback's copy of a text gives a row
 * (lib/viewReads.ts ROW_BYTES), and the reads issueOut makes for a parent
 * that is gone. Tests lower these. */
export const ACTIVE_RESERVE: ReadCeiling = { ranges: 64, documents: 128, bytes: MIB }

/** The refusal of a list whose request cannot hold a page's whole budget
 * beside what the list read before it (the caller's projects and access),
 * or whose scope has more projects than one page can open side by side.
 * Only a list past the testing envelope meets it. */
export const TASK_LIST_UNREADABLE =
  "the task list could not be read within the request's limits; pass project to list one project's tasks"

/** One page of an active task list: its rows, and the cursor of the next
 * page, null once every project of the list is read to its end. */
export type ActivePage<Row> = { rows: Row[]; next: string | null }

/* A position in the order of an active list, just after the task with this
 * created_at and number. */
type Position = { created_at: string; num: number }

/* Whether `a` comes before `b` in an active list's order. */
const before = (a: Position, b: Position): boolean =>
  a.created_at < b.created_at || (a.created_at === b.created_at && a.num < b.num)

/* The next task of each open project range, the earliest on top. */
type Head = { task: Doc<'issues'>; rest: AsyncGenerator<Doc<'issues'>> }

/* A binary heap of heads in list order, so taking the next task costs
 * comparisons in the logarithm of the projects open, not one for each. */
function headHeap() {
  const heap: Head[] = []
  const less = (i: number, j: number) => before(heap[i].task, heap[j].task)
  const swap = (i: number, j: number) => {
    const t = heap[i]
    heap[i] = heap[j]
    heap[j] = t
  }
  return {
    size: () => heap.length,
    peek: (): Head | undefined => heap[0],
    push: (head: Head) => {
      heap.push(head)
      for (let i = heap.length - 1; i > 0; ) {
        const up = (i - 1) >> 1
        if (!less(i, up)) break
        swap(i, up)
        i = up
      }
    },
    pop: (): Head | undefined => {
      const top = heap[0]
      const end = heap.pop()
      if (heap.length > 0 && end !== undefined) {
        heap[0] = end
        for (let i = 0; ; ) {
          const l = 2 * i + 1
          const r = l + 1
          let least = i
          if (l < heap.length && less(l, least)) least = l
          if (r < heap.length && less(r, least)) least = r
          if (least === i) break
          swap(i, least)
          i = least
        }
      }
      return top
    },
  }
}

/* The list name a cursor seals, one for each surface, as REST lets `*`
 * widen a search and MCP does not. */
const listName = (surface: 'rest' | 'mcp') => `tasks.active.${surface}`

/* The position a cursor names, or a refusal when its tie is not a task
 * number. */
async function cursorPosition(
  text: string,
  surface: 'rest' | 'mcp',
  scope: readonly string[],
): Promise<Position> {
  const at = await openListCursor(text, listName(surface), scope, 1)
  const [num] = at.tie
  // a cursor this list wrote always holds a task number
  if (typeof num !== 'number' || !Number.isSafeInteger(num)) throw badRequest(CURSOR_REFUSAL)
  return { created_at: at.key, num }
}

/**
 * One page of the active tasks a list asks for, as list rows, oldest first
 * by creation with ties by number, after `o.cursor`.
 *
 * It merges the list's projects side by side (above), opening their
 * ranges `opening` at a time and checking the page's budget before each
 * batch, so it refuses with TASK_LIST_UNREADABLE when they cannot all open
 * rather than place a task without every head. Then it takes the tasks in
 * order, and each one the filters keep becomes a row. A page stops at
 * `o.limit` rows, after looking at ACTIVE_PAGE.tasks tasks, or once its
 * rows have spent the budget less the delays' share, so it can hold fewer
 * rows than `o.limit`, even none, while `next` is set. `next` is the last
 * task the page looked at whose answer is final, so the next page never
 * reads again what the filters left out; it is null only once every range
 * is read to its end. A cursor is sealed with the list's surface, the
 * organization, the caller, the project the call names and a digest of the
 * filters and search (lib/listCursor.ts), so a cursor of another list,
 * caller or filter is refused. Pages are not a snapshot: a task created
 * while a caller pages lands at the end, and one that keeps an older
 * created_at, restored from Deleted items or the archive, or in a project
 * the caller can read from now on, appears only to a list started again.
 *
 * A status filter leaves groups out, so it reads whether each task whose
 * status matches is a group; the owner filter reads it only for a task In
 * Review with a reviewer (lib/viewReads.ts ownerSettled). A search matches
 * as lib/search.ts taskSearchText reads the app's task filter, REST's `*`
 * widening on REST only, and settles the tasks in list order: their own
 * fields first, whether they are groups only when a fragment occurs in a
 * status name, their label names only when the organization's first
 * ARCHIVE_LABELS.scan labels hold a matching one or it has more, and their
 * text last. A search past LIMITS.search, once trimmed, is refused first.
 *
 * A row reads whether it is a group and, for a group, the subtree its
 * facts walk, its parent outside the page, its text unless the search read
 * it and its newest comment, all counted by the page (lib/machineSubtree.ts).
 * A row whose reads do not fit ends the page before its task, so the next
 * page starts with it. The first task a page looks at may use the rest of
 * the rows' budget and always answers, as a group whose subtree does not
 * fit even that with the facts of a subtree too large to read. The delays
 * of the rows are read last, within ACTIVE_PAGE.delays.
 */
export async function listActiveIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ActiveListOpts,
  view: ListView & { surface: 'rest' },
): Promise<ActivePage<RestIssueJson>>
export async function listActiveIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ActiveListOpts,
  view: ListView & { surface: 'mcp' },
): Promise<ActivePage<McpIssueOut>>
export async function listActiveIssuesCore(
  ctx: QueryCtx,
  me: Caller,
  o: ActiveListOpts,
  view: ListView,
): Promise<ActivePage<RestIssueJson | McpIssueOut>> {
  if (o.search !== undefined) limitedText(LIMITS.search, o.search)
  const { cat, readable } = view
  const statuses = o.statuses !== undefined && o.statuses.length > 0 ? o.statuses : null
  const search = o.search ? o.search : null
  const scope = [
    me.org_id,
    me.id,
    o.project ?? 'all',
    await filtersKey([
      statuses === null ? null : [...new Set(statuses)].sort(),
      o.priority ?? null,
      o.assignee ?? null,
      o.owner ?? null,
      search,
    ]),
  ]
  const after = o.cursor === null ? null : await cursorPosition(o.cursor, view.surface, scope)
  const projectOf = (id: string) => cat.byUuid.get(id)
  const live = liveIn(cat.byUuid)
  // the list's projects, each read once
  const ids = [
    ...new Set(
      o.scope ??
        cat.projects.filter((p) => p.archived_at === undefined && readable(p.id)).map((p) => p.id),
    ),
  ].filter(readable)
  // what the list reads before its page: the roster, the organization and
  // a search's labels
  const profiles = await rosterOf(ctx, me.org_id)
  const names = namesOf(profiles)
  const org = await byId(ctx, 'organizations', me.org_id)
  const pieces = search === null ? [] : searchPieces(search, o.stars)
  const holdsPiece = (label: Doc<'labels'>) => {
    const name = label.name.toLowerCase()
    return pieces.some((piece) => name.includes(piece))
  }
  const scanned = search === null ? [] : await scannedLabels(ctx, me.org_id, pieces, holdsPiece)

  // the room check, then the page's budget from its start
  const metrics = await ctx.meta.getTransactionMetrics()
  const start = totalsOf(metrics)
  const hard = roomOf(metrics, ACTIVE_RESERVE)
  if (
    hard.ranges - start.ranges < ACTIVE_PAGE.ranges ||
    hard.documents - start.documents < ACTIVE_PAGE.documents ||
    hard.bytes - start.bytes < ACTIVE_PAGE.bytes
  ) {
    throw badRequest(TASK_LIST_UNREADABLE)
  }
  const rowsCeiling: ReadCeiling = {
    ranges: start.ranges + ACTIVE_PAGE.ranges - ACTIVE_PAGE.delays.ranges,
    documents: start.documents + ACTIVE_PAGE.documents - ACTIVE_PAGE.delays.documents,
    bytes: start.bytes + ACTIVE_PAGE.bytes - ACTIVE_PAGE.delays.bytes,
  }
  const tally = await readTally(ctx, hard)
  const reads = subtreeReads(ctx, { me, readable, projectOf, live }, tally)
  // a group check a task's filters or search need reads past the rows'
  // budget, up to the request's room, which LIMITS.subtasks.max holds
  const groupOf = async (task: Doc<'issues'>): Promise<boolean> => {
    const group = await reads.group(task, hard)
    if (group === null) throw badRequest(TASK_LIST_UNREADABLE)
    return group
  }
  const texts = new Map<string, string>()
  const textOf = async (task: Doc<'issues'>): Promise<string> => {
    const known = texts.get(task.id)
    if (known !== undefined) return known
    tally.range()
    const { text, rows } = await descriptionAndRows(ctx.db, task)
    for (const row of rows) tally.doc(row)
    texts.set(task.id, text)
    return text
  }
  const matches = search === null ? null : searchRule(ctx, search, o.stars, names, scanned, tally)

  /* Whether the filters and search keep `task`, reading only what they
   * still need. */
  const keeps = async (task: Doc<'issues'>): Promise<boolean> => {
    // the RLS's successor, always, and an archived project only when named
    if (task.org_id !== me.org_id || !readable(task.project_id)) return false
    if (o.scope === null && projectOf(task.project_id)?.archived_at !== undefined) return false
    if (o.priority && task.priority !== o.priority) return false
    if (o.assignee && task.assignee_id !== o.assignee) return false
    if (statuses !== null && (!statuses.includes(task.status) || (await groupOf(task))))
      return false
    // a group stays with its assignee, as in the app
    if (o.owner) {
      const group = ownerSettled(task) ? false : await groupOf(task)
      if (taskOwnerId(task, group) !== o.owner) return false
    }
    if (matches === null) return true
    return await matches(task, textOf, groupOf)
  }

  const streams: AsyncGenerator<Doc<'issues'>>[] = []
  try {
    const heap = await openHeads(ctx, ids, after, tally, rowsCeiling, streams)
    const kept: { task: Doc<'issues'>; partial: boolean }[] = []
    const lastComments = new Map<string, string | null>()
    /* Reads what the row of `task` needs besides what its filters read:
     * whether it is a group and its subtree, its parent, its text and its
     * newest comment. Null when they do not fit the rows' budget, which the
     * first task a page looks at never answers: its subtree takes the rest
     * of that budget, and one that does not fit gives the facts of a
     * subtree too large to read ('partial'). */
    const rowReads = async (
      task: Doc<'issues'>,
      first: boolean,
    ): Promise<'row' | 'partial' | null> => {
      if (!first && !(await tally.under(rowsCeiling))) return null
      const group = reads.known(task)
        ? reads.isGroup(task)
        : await reads.group(task, first ? hard : rowsCeiling)
      if (group === null) {
        if (!first) return null
        throw badRequest(TASK_LIST_UNREADABLE)
      }
      let whole = true
      if (group) {
        whole = await reads.walk(task, rowsCeiling)
        if (!whole && !first) return null
      }
      await reads.parent(task)
      await textOf(task)
      tally.range()
      const comment = await latestComment(ctx, task.id)
      if (comment !== null) tally.doc(comment)
      lastComments.set(task.id, comment?.created_at ?? null)
      return whole ? 'row' : 'partial'
    }

    let last: Doc<'issues'> | null = null
    let looked = 0
    let stopped = false
    for (let head = heap.peek(); head !== undefined; head = heap.peek()) {
      if (
        last !== null &&
        (kept.length >= o.limit || looked >= ACTIVE_PAGE.tasks || !(await tally.under(rowsCeiling)))
      ) {
        stopped = true
        break
      }
      heap.pop()
      const next = await head.rest.next()
      if (next.done !== true) heap.push({ task: next.value, rest: head.rest })
      const task = head.task
      reads.tasks.set(task.id, task)
      const first = last === null
      if (await keeps(task)) {
        const row = await rowReads(task, first)
        if (row === null) {
          // the row does not fit this page, so the next page starts with it
          stopped = true
          break
        }
        kept.push({ task, partial: row === 'partial' })
      }
      last = task
      looked++
    }

    const more = stopped || heap.size() > 0
    const nextCursor =
      more && last !== null
        ? await listCursorText(listName(view.surface), scope, {
            key: last.created_at,
            tie: [last.num],
          })
        : null
    // the delays, once the rows are fixed
    const forecast = await pageForecaster(ctx, {
      me,
      clock: delayClock(org, o.today),
      profiles: new Map(profiles.map((p) => [p.id, p])),
      rows: kept.map(({ task }) => ({
        issue: task,
        // the list's projects are in the catalogue
        project: projectOf(task.project_id) as Doc<'projects'>,
        group: reads.isGroup(task),
      })),
      access: accessOf(ctx, me, cat.projects),
      share: ACTIVE_PAGE.delays,
    })
    const rows = await Promise.all(
      kept.map(({ task, partial }) => {
        const shared = {
          me,
          readable,
          project: projectOf(task.project_id),
          projectOf,
          names,
          orgSlug: org?.slug,
          tasks: reads.tasks,
          lastComments,
          texts,
          children: reads.kids,
          live,
          partial,
          forecast,
        }
        return view.surface === 'rest'
          ? issueOut(ctx, task, { ...shared, surface: 'rest' })
          : issueOut(ctx, task, { ...shared, surface: 'mcp' })
      }),
    )
    return { rows, next: nextCursor }
  } finally {
    for (const stream of streams) await stream.return(undefined)
  }
}

/* How many tasks created at a cursor's instant, at or before its number,
 * one project's range reads again and skips before it reads that project
 * in two ranges instead (projectTasks). */
const TIE_SKIPS = 64

/* The active tasks of project `projectId` in list order, after `after`,
 * each counted by `tally`. A range starts at the cursor's created_at, that
 * instant included, and skips the tasks there at or before the cursor's
 * number, which one range cannot leave out, so a resumed page takes one
 * range a project. Past TIE_SKIPS of those, as when an import gave many
 * tasks one instant, it reads the project in two ranges that skip nothing,
 * the rest of the cursor's instant and everything created after it, so no
 * page reads more than that again before it passes its cursor. */
async function* projectTasks(
  ctx: QueryCtx,
  projectId: string,
  after: Position | null,
  tally: ReadTally,
): AsyncGenerator<Doc<'issues'>> {
  const active = () =>
    ctx.db.query('issues').withIndex('by_project_archived_created', (q) => {
      const project = q.eq('project_id', projectId).eq('archived_at', undefined)
      return after === null ? project : project.gte('created_at', after.created_at)
    })
  tally.range()
  let skipped = 0
  for await (const task of active()) {
    tally.doc(task)
    if (after === null || task.created_at !== after.created_at || task.num > after.num) {
      yield task
      continue
    }
    if (++skipped > TIE_SKIPS) break
  }
  if (after === null || skipped <= TIE_SKIPS) return
  const rest = [
    () =>
      ctx.db
        .query('issues')
        .withIndex('by_project_archived_created', (q) =>
          q
            .eq('project_id', projectId)
            .eq('archived_at', undefined)
            .eq('created_at', after.created_at)
            .gt('num', after.num),
        ),
    () =>
      ctx.db
        .query('issues')
        .withIndex('by_project_archived_created', (q) =>
          q
            .eq('project_id', projectId)
            .eq('archived_at', undefined)
            .gt('created_at', after.created_at),
        ),
  ]
  for (const range of rest) {
    tally.range()
    for await (const task of range()) {
      tally.doc(task)
      yield task
    }
  }
}

/* Opens the ranges of `ids` after `after` and answers their heads in a
 * heap, a batch of at most ACTIVE_PAGE.opening at a time, and fewer when
 * the room left under `ceiling` holds fewer rows at lib/viewReads.ts
 * ROW_BYTES, since a row a rollback wrote can carry a copy of its text.
 * Each stream goes into `streams`, which the caller closes. Refused with
 * TASK_LIST_UNREADABLE when the heads do not all fit under `ceiling`. */
async function openHeads(
  ctx: QueryCtx,
  ids: readonly string[],
  after: Position | null,
  tally: ReadTally,
  ceiling: ReadCeiling,
  streams: AsyncGenerator<Doc<'issues'>>[],
) {
  const heap = headHeap()
  for (let at = 0; at < ids.length; ) {
    if (!(await tally.under(ceiling))) throw badRequest(TASK_LIST_UNREADABLE)
    const left = tally.left(ceiling)
    const n = Math.max(
      1,
      Math.min(
        ACTIVE_PAGE.opening,
        left.ranges,
        left.documents,
        Math.floor(left.bytes / ROW_BYTES),
      ),
    )
    const batch = ids.slice(at, at + n).map((id) => projectTasks(ctx, id, after, tally))
    streams.push(...batch)
    const firsts = await Promise.all(batch.map((rest) => rest.next()))
    for (const [i, first] of firsts.entries()) {
      if (first.done !== true) heap.push({ task: first.value, rest: batch[i] })
    }
    at += batch.length
  }
  return heap
}

/* The search rule of an active list for `search`: whether a task matches,
 * reading what it needs in the order listActiveIssuesCore documents. A
 * task's label names come through its own assignments (by_issue), never a
 * label's assignments across the organization, whose count would follow
 * tasks of projects the caller cannot read. */
function searchRule(
  ctx: QueryCtx,
  search: string,
  stars: boolean,
  names: ReadonlyMap<string, string>,
  scanned: readonly Doc<'labels'>[] | null,
  tally: ReadTally,
): (
  task: Doc<'issues'>,
  textOf: (task: Doc<'issues'>) => Promise<string>,
  groupOf: (task: Doc<'issues'>) => Promise<boolean>,
) => Promise<boolean> {
  const matches = allWordsMatcher(search, stars)
  const pieces = searchPieces(search, stars)
  const holdsPiece = (label: Doc<'labels'>) => {
    const name = label.name.toLowerCase()
    return pieces.some((piece) => name.includes(piece))
  }
  // a status line holding none of the pieces never changes the answer
  const statusMatters = Object.values(STATUS_NAMES).some((name) => {
    const lower = name.toLowerCase()
    return pieces.some((piece) => lower.includes(piece))
  })
  const labels = new Map<string, Promise<Doc<'labels'> | null>>()
  const labelOf = (id: string) => {
    let label = labels.get(id)
    if (label === undefined) {
      tally.range()
      label = byId(ctx, 'labels', id).then((row) => {
        if (row !== null) tally.doc(row)
        return row
      })
      labels.set(id, label)
    }
    return label
  }
  /* the names of the task's labels that hold a piece, in label order,
   * from its own assignments, archive marks included */
  const labelNames = async (task: Doc<'issues'>): Promise<string[]> => {
    if (scanned !== null && scanned.length === 0) return []
    tally.range()
    const rows = await ctx.db
      .query('issue_labels')
      .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
      .collect()
    for (const row of rows) tally.doc(row)
    const held = new Set(rows.map((row) => row.label_id))
    if (scanned !== null) return scanned.filter((l) => held.has(l.id)).map((l) => l.name)
    const found = await Promise.all([...held].map(labelOf))
    return found
      .filter((l): l is Doc<'labels'> => l !== null && l.org_id === task.org_id && holdsPiece(l))
      .sort(labelOrder)
      .map((l) => l.name)
  }
  return async (task, textOf, groupOf) => {
    const own = searchFields(task, names)
    const hay = (group: boolean, names: readonly string[], description: string) =>
      matches(taskSearchText({ ...own, group, labelNames: names, description }))
    if (hay(true, [], '')) return true
    const group = statusMatters ? await groupOf(task) : true
    if (!group && hay(false, [], '')) return true
    const held = await labelNames(task)
    if (held.length > 0 && hay(group, held, '')) return true
    return hay(group, held, await textOf(task))
  }
}
