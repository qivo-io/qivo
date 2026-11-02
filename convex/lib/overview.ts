/* The Overview's reads behind overview.ts: the summary of a scope, its
 * projected delays, and its two task lists, through the shared view reader
 * (lib/viewReads.ts) and the counts every task writer keeps
 * (model/overviewCounts.ts). It holds the Overview's own rules: what each
 * figure counts, as src/views/overviewFigures.ts derives it in the app, the
 * lists' order, batches and positions, and the states.
 *
 * A scope is a top-level project with its visible live sub-projects, one
 * sub-project, or My view, the person's own tasks by the Reviewer rule
 * (lib/review.ts taskOwnerId) across every seat of the login, read through
 * their own ranges and never by reading projects. There is no all-projects
 * scope. A scope holds only tasks of the reader's working set
 * (lib/workingSet.ts), and a task a legacy writer stored on a top-level
 * project is in none.
 *
 * Every figure the counts hold is whole at any size inside the design
 * size: leaves by status (Completion, In progress, In review, the
 * status distribution), paused leaves and Left. Figures that follow the day
 * or the reader are read from the tasks within OVERVIEW.reads, and a figure
 * whose reads do not fit answers `unavailable`, never a smaller number. So
 * do the counts while they are not whole (`counting`). That is the owner's
 * rule of 1 November 2026, which holds for every view like this one: a view
 * shows a figure it cannot read whole within one request as unavailable,
 * never as a partial total.
 *
 * - Overdue counts the scope's tasks, groups included, that are not done for
 *   the reader and are due before the reader's day: a leaf by its stored
 *   status, a group by its group facts (lib/viewReads.ts groupFacts), which a
 *   subtask the reader cannot see keeps not done. It reads every task due
 *   before the day, so Done tasks the nightly archive has not taken yet (30
 *   days after done_at by default, longer for a parent that waits for its
 *   subtasks) count toward its reads, and a scope with thousands of them
 *   answers unavailable sooner.
 * - Projected counts the tasks due on or after the day, in projects that
 *   track delay, whose verdict is late (lib/delay.ts): a group by its
 *   calculated span, a task without subtasks against its owner's whole load
 *   (lib/ownerLoads.ts ownerLoadReader) where that load can move it. Owners
 *   are read in owner id order within the room the query has left, and a
 *   guest or an organization Viewer gets at most one owner's load, as
 *   planning.ownerLoads reads one owner a call for them, so where their
 *   reads stop never spans two owners. Missing work is never spare
 *   capacity: an owner that does not fit makes the figure unavailable.
 *
 * The client passes its day (`day`, YYYY-MM-DD), the first day of its
 * current week (`week`), the instants its last 53 local weeks began at
 * (`week_starts`) and the instant its next week begins at (`week_end`),
 * because the app judges dates in the browser's time zone and a query has
 * no zone data (the Convex runtime has no Intl). Days fall in weeks by day
 * arithmetic from `week`, and an instant (remaining_set_at) by those
 * instants, so every verdict matches the app's local weeks, the current
 * one included when a daylight-saving change makes it 167 or 169 hours.
 *
 * The lists are read in one total order of positions, earliest due date
 * first, undated last, then creation time and document id, merged across
 * their ranges, so batches never depend on which range a row came from. A
 * batch answers at most OVERVIEW.batch rows, `complete` false where its
 * reads stopped before the batch or the list ended, a sealed `next` that is
 * null only at the list's true end, and a sealed `end`, its last position.
 * An At-risk candidate whose owner's load no batch can read is a row whose
 * risk is `unknown`, so the list goes on past it.
 * A batch asked again with its `end` holds exactly the rows between its
 * start and that end, so rows that change due date, pause or verdict move
 * between batches and none is duplicated or skipped; one that grows past
 * OVERVIEW.split rows answers `split` with a middle position. Positions are
 * sealed (lib/archiveCursorSeal.ts) and bound to their list, the login,
 * the scope and the days (listKey), because in My view one can fall on the
 * person's own task in a project they cannot see. */

import type { TransactionMetrics } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  addCounts,
  countsOfRows,
  familyCounts,
  type LeafCounts,
  noCounts,
  orgCountState,
  overviewRegroupOf,
  ownerRows,
} from '../model/overviewCounts'
import {
  ACCESS_UNCHECKED,
  type Access,
  accessOf,
  isAccessUnchecked,
  isOrgStaff,
  OWN_READS,
} from './access'
import { digestText, openCursorText, sealCursorText } from './archiveCursorSeal'
import { LEVEL_STEP_READS, type ReadCeiling } from './archivedTasks'
import type { BoardScope } from './board'
import { byId } from './db'
import { type DelayInfo, type DelayIssue, delayOf } from './delay'
import { ISSUE_STATUSES, type IssueStatus } from './enums'
import { badRequest } from './functions'
import { MIB, TASK_ROW_MAX_BYTES } from './limits'
import { loadRowsOf, OWNER_LOADS, ownerLoadReader, type ReadRoom } from './ownerLoads'
import { taskOwnerId } from './review'
import {
  BY_ID,
  firstSubtaskCheck,
  type GroupFacts,
  groupBy,
  groupFacts,
  inSteps,
  isGroupKnown,
  isOverBudget,
  noSubtasks,
  ownerSettled,
  ownHeldTasks,
  PROJECT_ASK,
  PROJECT_READ,
  projectSelection,
  RANGE,
  type Reads,
  ROW,
  type Selection,
  type StepRange,
  type Subtasks,
  selectionTasks,
  settled,
  type ViewAccess,
  type ViewBudget,
  type ViewRow,
  type ViewSeats,
  viewAccess,
  viewBudget,
  viewRow,
} from './viewReads'
import { canonicalLoad, DEFAULT_PLANNABLE_HOURS, type LoadSpan, plannableHoursOf } from './workload'

// --- budgets and shapes -------------------------------------------------------------

/** The Overview's budgets, which tests lower and set back with
 * structuredClone.
 *
 * `reads` caps each query's reads as Convex counts them, the reader's own
 * access rows included (lib/viewReads.ts viewBudget), the same as the
 * Board's (lib/board.ts BOARD.reads), keeping 4 MiB, 8,000 documents and 496
 * index ranges under Convex's limits for what one step reads past the
 * guard's last look. Measured on 2 November 2026 under convex-test's
 * transaction limits with rows as the app writes them, ordinary titles and
 * names, data from before the rule of one level (tests/overview.test.ts,
 * real limits), in ranges, documents and MiB:
 *
 * - One sub-project of 300 tasks, every dated one due before the day,
 *   Done ones and groups included: the summary 316, 371 and 0.25, whole.
 *   With `reads.ranges` lowered to 200 its Overdue stops there and answers
 *   unavailable, while its counts stay whole; Overdue costs about one
 *   range for each task due before the day. A first At-risk batch reads
 *   41, 49 and 0.03 there, a first Paused batch 27, 30 and 0.02. On 1
 *   November 2026, at the text caps, 4,000 such tasks stopped Overdue at
 *   the 3,600 ranges and 2,000 answered whole, past the design size.
 * - 600 tasks over a project of 30 sub-projects that a team of the reader
 *   shares: the summary 549, 605 and 0.36, the projection 217, 125 and
 *   0.08, a first At-risk batch 166, 352 and 0.23, a first Paused batch
 *   158, 140 and 0.08.
 * - My view of 400 of the reader's own tasks over the 200 sub-projects
 *   their three teams share: the summary 529, 967 and 0.37, the projection
 *   581, 625 and 0.26, a first At-risk batch 113 ranges and a first Paused
 *   batch 126.
 *
 * `batch` is how many rows a list batch holds, the page's Load more step,
 * and `split` how many a batch with a fixed end may hold before it answers
 * a middle position to split at. */
export const OVERVIEW = {
  reads: { bytes: 12 * MIB, documents: 24_000, ranges: 3_600 },
  batch: 10,
  split: 20,
}

/** An Overview scope, as the Board names one (lib/board.ts BoardScope). */
export type OverviewScope = BoardScope

/** Why a figure is not given: the counts are not whole yet (`counting`),
 * its reads did not fit OVERVIEW.reads (`budget`), or an owner's load it
 * needs did not fit the owner reader's bounds or the one-owner rule of a
 * guest or Viewer (`loads`). */
export type Missing = 'counting' | 'budget' | 'loads'

/** A figure, or why it is not given. Never a partial value. */
export type Figure<T extends object> =
  | ({ state: 'ok' } & T)
  | { state: 'unavailable'; reason: Missing }

/** What every query answers for a scope it does not answer: `unavailable`
 * alike for every reason the scope is not the caller's (no seat, no such
 * project, another organization's, archived, hidden, a top-level project
 * that is not a meta), with `reason` and its sentence where a bound of the
 * caller's own access reads stopped a check (lib/access.ts
 * accessUnchecked), which is never answered as no access or a smaller
 * figure; `over_budget` where the scope's own selection did not fit, or a
 * list batch's reads before it judged one candidate, such as My view's
 * reviewer range. */
export type ScopeRefusal =
  | { state: 'unavailable'; reason?: typeof ACCESS_UNCHECKED; message?: string }
  | { state: 'over_budget' }

/** What overview.summary answers. */
export type SummaryAnswer =
  | {
      state: 'ok'
      /** whether the scope holds an active task, a group included, for the
       * page's empty notes */
      any_task: Figure<{ value: boolean }>
      /** the leaves by stored status, for Completion (done over all), In
       * progress, In review and the status distribution, and the paused
       * leaves */
      counts: Figure<{ leaves: Record<IssueStatus, number>; paused: number }>
      /** the tasks, groups included, not done for the reader and due
       * before `day` */
      overdue: Figure<{ count: number }>
      /** a project scope's sub-projects, in creation order */
      sub_projects?: string[]
    }
  | ScopeRefusal

/** What overview.risk answers. */
export type RiskAnswer =
  | {
      state: 'ok'
      /** the tasks due on or after `day`, in projects that track delay,
       * projected to finish after their due week; with the summary's
       * overdue they make the At-risk count */
      projected: Figure<{ count: number }>
    }
  | ScopeRefusal

/** A list row: the task as the Board sends it (lib/viewReads.ts viewRow),
 * and on an At-risk row whether it is overdue, by its due date; projected
 * late, with the first day of the week it is projected to finish in on the
 * client's weeks (null where that is not known); or `unknown`, a candidate
 * whose projection needs an owner's load no batch can read (the owner
 * reader's bounds, or a guest's one-owner rule), which the list keeps so
 * it can go on past it and may not be late. A list holding one is not
 * whole. */
export type OverviewRow = ViewRow & {
  at_risk?:
    | { kind: 'overdue' }
    | { kind: 'projected'; finish_week: string | null }
    | { kind: 'unknown' }
}

/** What overview.attention and overview.paused answer. */
export type ListAnswer =
  | {
      state: 'ok'
      rows: OverviewRow[]
      /** false where the reads stopped before the batch or the list ended */
      complete: boolean
      /** where the next batch starts, null only at the list's true end */
      next: string | null
      /** the batch's last position, to ask it again with as its fixed end */
      end: string | null
      /** a fixed batch past OVERVIEW.split rows: where to split it, rows
       * holding the batch up to there */
      split?: string
    }
  | ScopeRefusal

// --- days and weeks -------------------------------------------------------------------

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/* The days since 1970-01-01 of YYYY-MM-DD `iso`, or NaN. */
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS

/** The day number of `value`, a real YYYY-MM-DD day, or a badRequest naming
 * argument `name`. */
function dayArg(value: string, name: string): number {
  const n = dayNumber(value)
  if (
    !ISO_DAY.test(value) ||
    !Number.isInteger(n) ||
    new Date(n * DAY_MS).toISOString().slice(0, 10) !== value
  )
    throw badRequest(`${name} must be a day, YYYY-MM-DD`)
  return n
}

/** How many local weeks `week_starts` holds: this one and the 52 before. */
export const WEEK_STARTS = 53

/* How far a local week may be from 7 days long: a daylight-saving change
 * moves a week's start by an hour in most zones and by two in a few, such
 * as Antarctica/Troll's. */
const WEEK_SLACK_MS = 3 * 3_600_000

/** The day and the weeks a verdict is judged by, on the client's grid:
 * week 0 is the client's current week. */
export type Clock = {
  /** the client's day, YYYY-MM-DD */
  day: string
  /** the week holding YYYY-MM-DD `iso` */
  ofDay(iso: string): number
  /** the week holding ISO instant `instant` on the client's local weeks */
  ofInstant(instant: string): number
  /** the first day of `week`, YYYY-MM-DD */
  firstDay(week: number): string
}

/**
 * The clock of `day`, `week`, `week_starts` and `week_end`, or a badRequest
 * where one is malformed: `day` and `week` not real days, `week` not the
 * first day of a week holding `day`, `week_starts` not exactly WEEK_STARTS
 * instants in milliseconds, ascending, each within three hours of 7 days
 * after the one before (a daylight-saving change), or `week_end`, the
 * instant the next local week begins at, not as far after the last of them.
 * An instant falls in the local week whose start it is at or after and
 * whose end it is before, so a week a daylight-saving change makes 167 or
 * 169 hours long ends where the client's does. One before the first start
 * falls in whole weeks of 7 days before it, and one after `week_end` in
 * whole weeks after it, exact unless a daylight-saving change lies past
 * the window, and then only within an hour of a week's start.
 */
export function clockOf(a: {
  day: string
  week: string
  week_starts: readonly number[]
  week_end: number
}): Clock {
  const today = dayArg(a.day, 'day')
  const first = dayArg(a.week, 'week')
  if (today - first < 0 || today - first > 6)
    throw badRequest('week must be the first day of the week that holds day')
  const starts = a.week_starts
  if (starts.length !== WEEK_STARTS || !starts.every((s) => Number.isSafeInteger(s)))
    throw badRequest(
      `week_starts must hold the ${WEEK_STARTS} instants the last weeks began at, in milliseconds`,
    )
  for (let i = 1; i < starts.length; i++)
    if (Math.abs(starts[i] - starts[i - 1] - WEEK_MS) > WEEK_SLACK_MS)
      throw badRequest('week_starts must be ascending, a week apart')
  const last = starts.length - 1
  const end = a.week_end
  if (!Number.isSafeInteger(end) || Math.abs(end - starts[last] - WEEK_MS) > WEEK_SLACK_MS)
    throw badRequest('week_end must be the instant the week after the last of week_starts began at')
  return {
    day: a.day,
    ofDay: (iso) => Math.floor((dayNumber(iso) - first) / 7),
    ofInstant: (instant) => {
      const ms = Date.parse(instant)
      if (ms >= end) return 1 + Math.floor((ms - end) / WEEK_MS)
      if (ms >= starts[last]) return 0
      if (ms < starts[0]) return -last - Math.ceil((starts[0] - ms) / WEEK_MS)
      let lo = 0
      let hi = last
      // the last start at or before `ms`
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (starts[mid] <= ms) lo = mid
        else hi = mid
      }
      return lo - last
    },
    firstDay: (week) => new Date((first + 7 * week) * DAY_MS).toISOString().slice(0, 10),
  }
}

// --- the scope -------------------------------------------------------------------------

/** A scope as one query reads it: its seats, by organization, and for a
 * project scope its selection. */
type ScopeRead =
  | { kind: 'project'; seat: ViewAccess; seats: ViewSeats; selection: Selection }
  | { kind: 'mine'; seats: ViewSeats }

/* What a scope the caller does not hold answers. */
const UNAVAILABLE = { state: 'unavailable' as const }

/* The scope `scope` names for the login whose seats are `profiles`, or null
 * when it names none, alike for every reason. */
async function scopeOf(
  ctx: QueryCtx,
  guard: ViewBudget,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  scope: OverviewScope,
): Promise<ScopeRead | null> {
  if (scope.kind === 'project') {
    const me = profiles.get(scope.org_id)
    if (me === undefined) return null
    const seat = viewAccess(ctx, guard, me)
    const selection = await projectSelection(ctx, guard, seat, scope.project_id)
    if (selection === null) return null
    return { kind: 'project', seat, seats: new Map([[me.org_id, seat]]), selection }
  }
  return {
    kind: 'mine',
    seats: new Map(
      [...profiles.values()].map((me): [string, ViewAccess] => [
        me.org_id,
        viewAccess(ctx, guard, me),
      ]),
    ),
  }
}

/* `read`'s answer over the scope, or the scope's refusal: unavailable for a
 * scope the caller does not hold or where a bound of the caller's own
 * access reads stopped a check, over_budget where the scope itself, or a
 * read no figure or batch answers for itself, did not fit. */
async function overScope<A>(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  scope: OverviewScope,
  read: (guard: ViewBudget, at: ScopeRead) => Promise<A>,
): Promise<A | ScopeRefusal> {
  const guard = viewBudget(ctx, OVERVIEW.reads)
  try {
    const at = await scopeOf(ctx, guard, profiles, scope)
    if (at === null) return UNAVAILABLE
    return await read(guard, at)
  } catch (e) {
    // a read the figures do not catch themselves, such as the scope's
    // selection or a list's own reads, which answers no part of a list
    if (isOverBudget(e)) return { state: 'over_budget' }
    if (isAccessUnchecked(e))
      return { state: 'unavailable', reason: ACCESS_UNCHECKED, message: e.data.message }
    throw e
  }
}

/* `figure`'s value, or unavailable for `budget` where its reads did not fit
 * the guard. A figure read after it then finds the guard spent too. */
async function bounded<T extends object>(figure: () => Promise<Figure<T>>): Promise<Figure<T>> {
  try {
    return await figure()
  } catch (e) {
    if (isOverBudget(e)) return { state: 'unavailable', reason: 'budget' }
    throw e
  }
}

// --- the counts ------------------------------------------------------------------------

/** One count row as a read keeps room for it: a few hundred bytes, the
 * same for every row, as its fields are ids and numbers. */
const COUNT_ROW: Reads = { bytes: 1024, documents: 1, ranges: 0 }

/* What familyCounts reads for one sub-project: its range and its rows. */
const SUB_COUNTS: Reads = { bytes: 4 * COUNT_ROW.bytes, documents: 4, ranges: 1 }

/* The summed counts of `parts`. */
const sumCounts = (parts: Iterable<LeafCounts>): LeafCounts => {
  let sum = noCounts()
  for (const c of parts) sum = addCounts(sum, c)
  return sum
}

/* A project scope's counts: its family's readiness once, then each
 * selected sub-project's rows (model/overviewCounts.ts familyCounts). */
async function projectCounts(
  ctx: QueryCtx,
  guard: ViewBudget,
  selection: Selection,
): Promise<Map<string, LeafCounts> | null> {
  const family = selection.project.parent_id ?? selection.project.id
  await guard.take(RANGE, 3)
  await guard.take(SUB_COUNTS, selection.subProjects.length)
  return await familyCounts(ctx.db, selection.project.org_id, family, selection.subProjects)
}

/* The counts of each seat's person in the live sub-projects they can see,
 * by sub-project id, or null while any seat's organization is not counted,
 * a backfill counts it or a regroup runs in it: for each seat the
 * organization's readiness and its first regroup row (three ranges), every
 * count row of the person (model/overviewCounts.ts ownerRows, one range),
 * then whether each row's project is live, a sub-project and one they see.
 * The rows of projects they cannot see are read too; they are alike in
 * size, so only how many there are can move an answer, at the budget's
 * margin. */
async function mineCounts(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
): Promise<Map<string, LeafCounts> | null> {
  const out = new Map<string, LeafCounts>()
  for (const seat of seats.values()) {
    // every seat's organization counted, with no count or regroup under way
    // in it, before its rows say anything: a person may hold no row yet in
    // an organization still counting, or in a family a regroup is reading
    await guard.take(RANGE, 3)
    const state = await orgCountState(ctx.db, seat.me.org_id)
    if (!state.stamped || state.run !== null) return null
    const regroup = await ctx.db
      .query('overview_regroups')
      .withIndex('by_org', (q) => q.eq('org_id', seat.me.org_id))
      .first()
    if (regroup !== null) return null
    const rows: Doc<'overview_counts'>[] = []
    for await (const step of inSteps(guard, [ownerRange(ctx, seat.me.id)], COUNT_ROW))
      rows.push(...step)
    const byProject = groupBy(rows, (r) => r.project_id)
    const ids = [...byProject.keys()]
    const live = await seat.live(ids)
    const liveIds = ids.filter((_, i) => live[i])
    const shown = await seat.visible(liveIds)
    const subs: Doc<'projects'>[] = []
    for (const [i, id] of liveIds.entries()) {
      const p = await seat.project(id)
      if (shown[i] && p !== null && p.parent_id !== undefined) subs.push(p)
    }
    for (const p of subs) {
      const counts = countsOfRows(byProject.get(p.id) ?? [], p)
      if (counts === null) return null
      out.set(p.id, counts)
    }
  }
  return out
}

/* The count rows of person `ownerId` (counts by_owner_project), ordered by
 * project, read in steps: a step that ends on a row goes on with the rest
 * of that row's project from its creation time, then the later projects. */
function ownerRange(
  ctx: QueryCtx,
  ownerId: string,
  from?: { project: string; part: 'same' | 'later' },
): StepRange<Doc<'overview_counts'>> {
  const index = (at?: number) =>
    from === undefined
      ? ownerRows(ctx.db, ownerId)
      : ctx.db.query('overview_counts').withIndex('by_owner_project', (q) => {
          const own = q.eq('owner_id', ownerId)
          if (from.part === 'later') return own.gt('project_id', from.project)
          const same = own.eq('project_id', from.project)
          return at === undefined ? same : same.gte('_creationTime', at)
        })
  return {
    open: (at) => index(at),
    after: (last, rows) => [
      {
        ...ownerRange(ctx, ownerId, { project: last.project_id, part: 'same' }),
        after: undefined,
        start: {
          from: last._creationTime,
          seen: rows.filter(
            (r) => r.project_id === last.project_id && r._creationTime === last._creationTime,
          ),
        },
      },
      ownerRange(ctx, ownerId, { project: last.project_id, part: 'later' }),
    ],
  }
}

// --- candidate ranges ----------------------------------------------------------------

/* The bound above every YYYY-MM-DD day, for a span of every dated task. */
const ANY_DAY = '\uffff'

/** A span of due dates: from `from` (with `after`, after it) to before
 * `below`. */
type DueSpan = { from: string; after?: boolean; below: string }

/* Which index a range of candidates reads and the key before its due date:
 * a sub-project's tasks (issues by_project_archived_paused_due) or the tasks
 * assigned to a person (by_assignee_archived_paused_due), paused or not. */
type DueKey = { project: string } | { assignee: string }

/* A part of one range of the due-date indexes: one due date from a
 * creation time on (`same`), the due dates after one (`later`), or those
 * from one (`from`), each to before `below`. */
type DuePart =
  | { kind: 'same'; due: string; from: number }
  | { kind: 'later'; after: string; below: string }
  | { kind: 'from'; from: string; below: string }

/* The active tasks of `key`, paused as `paused` says, in `part`, in order of
 * due date then creation time. */
function dueQuery(ctx: QueryCtx, key: DueKey, paused: boolean, part: DuePart) {
  if ('project' in key)
    return ctx.db.query('issues').withIndex('by_project_archived_paused_due', (q) => {
      const b = q.eq('project_id', key.project).eq('archived_at', undefined).eq('paused', paused)
      return part.kind === 'same'
        ? b.eq('due_date', part.due).gte('_creationTime', part.from)
        : part.kind === 'later'
          ? b.gt('due_date', part.after).lt('due_date', part.below)
          : b.gte('due_date', part.from).lt('due_date', part.below)
    })
  return ctx.db.query('issues').withIndex('by_assignee_archived_paused_due', (q) => {
    const b = q.eq('assignee_id', key.assignee).eq('archived_at', undefined).eq('paused', paused)
    return part.kind === 'same'
      ? b.eq('due_date', part.due).gte('_creationTime', part.from)
      : part.kind === 'later'
        ? b.gt('due_date', part.after).lt('due_date', part.below)
        : b.gte('due_date', part.from).lt('due_date', part.below)
  })
}

/* The active tasks of `key`, paused as `paused` says, due in `span`, in
 * order of due date then creation time. A step that ends on a row goes on
 * with that row's due date from its creation time, then the later due
 * dates. */
function dueRange(
  ctx: QueryCtx,
  key: DueKey,
  paused: boolean,
  span: DueSpan,
  at?: { due: string; seen: readonly Doc<'issues'>[]; from: number },
): StepRange<Doc<'issues'>> {
  if (at !== undefined)
    return {
      open: (from) =>
        dueQuery(ctx, key, paused, { kind: 'same', due: at.due, from: from ?? at.from }),
      start: { from: at.from, seen: at.seen },
    }
  return {
    open: () =>
      dueQuery(
        ctx,
        key,
        paused,
        span.after
          ? { kind: 'later', after: span.from, below: span.below }
          : { kind: 'from', from: span.from, below: span.below },
      ),
    after: (last, rows) => {
      const due = last.due_date ?? ''
      return [
        dueRange(ctx, key, paused, span, {
          due,
          from: last._creationTime,
          seen: rows.filter((r) => r.due_date === due && r._creationTime === last._creationTime),
        }),
        dueRange(ctx, key, paused, { from: due, after: true, below: span.below }),
      ]
    },
  }
}

/* The undated active tasks of `key`, paused as `paused` says, by creation
 * time. */
function undatedRange(ctx: QueryCtx, key: DueKey, paused: boolean): StepRange<Doc<'issues'>> {
  return {
    open: (from) =>
      'project' in key
        ? ctx.db.query('issues').withIndex('by_project_archived_paused_due', (q) => {
            const base = q
              .eq('project_id', key.project)
              .eq('archived_at', undefined)
              .eq('paused', paused)
              .eq('due_date', undefined)
            return from === undefined ? base : base.gte('_creationTime', from)
          })
        : ctx.db.query('issues').withIndex('by_assignee_archived_paused_due', (q) => {
            const base = q
              .eq('assignee_id', key.assignee)
              .eq('archived_at', undefined)
              .eq('paused', paused)
              .eq('due_date', undefined)
            return from === undefined ? base : base.gte('_creationTime', from)
          }),
  }
}

/* The In Review tasks person `reviewer` reviews (by_reviewer_archived_status),
 * which a reviewer owns while they wait In Review as tasks without
 * subtasks; that range is not ordered by due date, so a list reads it
 * whole. */
const reviewedRange = (ctx: QueryCtx, reviewer: string): StepRange<Doc<'issues'>> => ({
  open: (from) =>
    ctx.db.query('issues').withIndex('by_reviewer_archived_status', (q) => {
      const own = q.eq('reviewer_id', reviewer).eq('archived_at', undefined).eq('status', 'review')
      return from === undefined ? own : own.gte('_creationTime', from)
    }),
})

/* Whether `t` is due in `span`. */
const dueIn = (t: Doc<'issues'>, span: DueSpan): boolean =>
  t.due_date !== undefined &&
  (span.after ? t.due_date > span.from : t.due_date >= span.from) &&
  t.due_date < span.below

/** The tasks of a scope a figure reads, a step at a time: for a project
 * scope those of its selected sub-projects `projects` keeps, due in `span`,
 * paused or not, all in the reader's working set; for My view each seat's
 * person's own tasks due in `span` (assigned, and In Review ones they
 * review), in their working set and a sub-project (lib/viewReads.ts
 * ownHeldTasks), whoever owns them by the Reviewer rule. */
async function* dueTasks(
  ctx: QueryCtx,
  guard: ViewBudget,
  at: ScopeRead,
  span: DueSpan,
  projects: (p: Doc<'projects'>) => boolean = () => true,
): AsyncGenerator<Doc<'issues'>[]> {
  if (at.kind === 'project') {
    const ranges = at.selection.subProjects
      .filter(projects)
      .flatMap((p) => [false, true].map((paused) => dueRange(ctx, { project: p.id }, paused, span)))
    yield* inSteps(guard, ranges)
    return
  }
  for (const seat of at.seats.values()) {
    const me = seat.me.id
    const ranges = [
      ...[false, true].map((paused) => dueRange(ctx, { assignee: me }, paused, span)),
      reviewedRange(ctx, me),
    ]
    for await (const step of ownHeldTasks(guard, seat, ranges)) {
      const kept: Doc<'issues'>[] = []
      for (const t of step) {
        const p = await seat.project(t.project_id)
        if (dueIn(t, span) && p !== null && projects(p)) kept.push(t)
      }
      yield kept
    }
  }
}

// --- groups and owners --------------------------------------------------------------

/** What one query knows of its tasks' subtasks (lib/viewReads.ts Subtasks)
 * and the group facts it read. */
type Groups = { known: Subtasks; facts: Map<string, GroupFacts> }

const newGroups = (): Groups => ({ known: noSubtasks(), facts: new Map() })

/* Reads which of `tasks`, tasks of the reader's working set, are groups
 * (firstSubtaskCheck), and with `facts` the group facts of the groups among
 * them. Each task is one the reader is shown, and the parent of one is a
 * group. */
async function readGroups(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  g: Groups,
  tasks: readonly Doc<'issues'>[],
  facts: boolean,
): Promise<void> {
  for (const t of tasks) {
    g.known.shown.set(t.id, true)
    if (t.parent_id !== undefined) g.known.parents.add(t.parent_id)
  }
  await firstSubtaskCheck(ctx, guard, seats, tasks, g.known)
  if (!facts) return
  const fresh = tasks.filter((t) => isGroupKnown(g.known, t.id) === true && !g.facts.has(t.id))
  if (fresh.length === 0) return
  for (const [id, f] of await groupFacts(ctx, guard, seats, fresh, g.known)) g.facts.set(id, f)
}

/* Whether `t` is a group, once readGroups read it. */
const isGroup = (g: Groups, t: Doc<'issues'>): boolean => isGroupKnown(g.known, t.id) === true

/* Whether `t` belongs to the scope `at`: in a project scope every task of
 * the selection does; in My view one its seat's person owns by the Reviewer
 * rule, once readGroups read it. */
const inScope = (at: ScopeRead, g: Groups, t: Doc<'issues'>): boolean =>
  at.kind === 'project' || taskOwnerId(t, isGroup(g, t)) === at.seats.get(t.org_id)?.me.id

/* Whether `t` is done for the reader: a leaf by its stored status, a group
 * by its group facts, which readGroups read. */
const isDoneFor = (g: Groups, t: Doc<'issues'>): boolean =>
  isGroup(g, t) ? g.facts.get(t.id)?.done === true : t.status === 'done'

// --- any task and overdue ----------------------------------------------------------------

/* Whether a project scope's selected sub-projects hold an active task: the
 * first of each, a round at a time, until one holds one. */
async function projectHasTask(
  ctx: QueryCtx,
  guard: ViewBudget,
  selection: Selection,
): Promise<boolean> {
  const subs = selection.subProjects
  for (let at = 0; at < subs.length; ) {
    const step = subs.slice(at, at + (await guard.upTo(BY_ID, Math.min(64, subs.length - at))))
    at += step.length
    const firsts = await settled(
      step.map((p) =>
        ctx.db
          .query('issues')
          .withIndex('by_project_archived', (q) =>
            q.eq('project_id', p.id).eq('archived_at', undefined),
          )
          .first(),
      ),
    )
    if (firsts.some((t) => t !== null)) return true
  }
  return false
}

/* Whether My view holds a task: a task of a seat's person they own by the
 * Reviewer rule, a group included, in a sub-project they can see. */
async function mineHasTask(ctx: QueryCtx, guard: ViewBudget, seats: ViewSeats): Promise<boolean> {
  const g = newGroups()
  for (const seat of seats.values()) {
    const me = seat.me.id
    const ranges: StepRange<Doc<'issues'>>[] = [
      ...ISSUE_STATUSES.map(
        (status): StepRange<Doc<'issues'>> => ({
          open: (from) =>
            ctx.db.query('issues').withIndex('by_assignee_archived_status', (q) => {
              const own = q.eq('assignee_id', me).eq('archived_at', undefined).eq('status', status)
              return from === undefined ? own : own.gte('_creationTime', from)
            }),
        }),
      ),
      reviewedRange(ctx, me),
    ]
    for await (const step of ownHeldTasks(guard, seat, ranges)) {
      if (step.some((t) => ownerSettled(t) && t.assignee_id === me)) return true
      await readGroups(
        ctx,
        guard,
        seats,
        g,
        step.filter((t) => !ownerSettled(t)),
        false,
      )
      if (step.some((t) => taskOwnerId(t, isGroup(g, t)) === me)) return true
    }
  }
  return false
}

/* The scope's tasks not done for the reader and due before the day. */
async function overdueCount(
  ctx: QueryCtx,
  guard: ViewBudget,
  at: ScopeRead,
  day: string,
): Promise<number> {
  const candidates: Doc<'issues'>[] = []
  for await (const step of dueTasks(ctx, guard, at, { from: '', below: day }))
    candidates.push(...step)
  const g = newGroups()
  await readGroups(ctx, guard, at.seats, g, candidates, true)
  return candidates.filter((t) => inScope(at, g, t) && !isDoneFor(g, t)).length
}

// --- verdicts --------------------------------------------------------------------------

/* What the caller's access may read of the caller's own rows at once in one
 * round of questions (lib/machineDelay.ts STEP_READS). */
const STEP_HOLD: ReadCeiling = {
  ranges: LEVEL_STEP_READS.ranges + 1,
  documents: LEVEL_STEP_READS.documents + OWN_READS.orgTeamsMost + 1,
  bytes: LEVEL_STEP_READS.bytes + 3 * OWN_READS.bytes,
}

/** The room of the owner reader of an Overview query whose owner reads
 * start at `start`: lib/ownerLoads.ts OWNER_LOADS.call from there past the
 * access instance's shared reads, and within the query's `guard` (its
 * ceiling, without the room it holds) less STEP_HOLD where a round may read
 * the caller's own rows at once, as lib/machineDelay.ts delayRoom builds
 * it, so the loads share the query's own budget and never pass Convex's
 * limits. */
const loadRoom =
  (start: TransactionMetrics, guard: ViewBudget): ReadRoom =>
  (m, shared, wide) => {
    const budget = guard.ceiling
    const hold = wide ? STEP_HOLD : { ranges: 0, documents: 0, bytes: 0 }
    const since = (now: number, then: number, own: number) => now - then - own
    return {
      ranges: Math.min(
        OWNER_LOADS.call.ranges -
          since(m.databaseQueries.used, start.databaseQueries.used, shared.ranges),
        budget.ranges - hold.ranges - m.databaseQueries.used,
      ),
      documents: Math.min(
        OWNER_LOADS.call.documents -
          since(m.documentsRead.used, start.documentsRead.used, shared.documents),
        budget.documents - hold.documents - m.documentsRead.used,
      ),
      bytes: Math.min(
        OWNER_LOADS.call.bytes - since(m.bytesRead.used, start.bytesRead.used, shared.bytes),
        budget.bytes - hold.bytes - m.bytesRead.used,
      ),
    }
  }

/* The verdict of a task that needs an owner's load nobody could read. */
const UNKNOWN = 'unknown' as const

/* One owner's load as the projection walks it, or unknown where it could
 * not be read. */
type Load = LoadSpan[] | typeof UNKNOWN

/** What verdicts answers: one query's verdicts, each owner's load read once. */
export type Verdicts = ReturnType<typeof verdicts>

/**
 * The verdicts of one query, on `clock`: each task's as lib/delay.ts gives
 * it, with the owner's load read once (lib/ownerLoads.ts ownerLoadReader)
 * where it can move the verdict (needsLoad), through one access instance a
 * seat, in a room built from the query's own budget (loadRoom). A guest or
 * an organization Viewer gets at most one owner's load a query; a verdict
 * that needs another is unknown, and so is one whose owner did not fit.
 */
export function verdicts(ctx: QueryCtx, guard: ViewBudget, seats: ViewSeats, clock: Clock) {
  const profiles = new Map<string, Promise<Doc<'profiles'> | null>>()
  const loads = new Map<string, Load>()
  const readers = new Map<string, ReturnType<typeof ownerLoadReader>>()
  // the owners a guest's or Viewer's seat read, by organization
  const read = new Map<string, number>()

  const profileOf = async (id: string): Promise<Doc<'profiles'> | null> => {
    let p = profiles.get(id)
    if (p === undefined) {
      await guard.take(BY_ID)
      p = byId(ctx, 'profiles', id)
      profiles.set(id, p)
    }
    return await p
  }

  /* The owner's capacity as the app reads it from its roster. */
  const capacityOf = (owner: Doc<'profiles'> | null, orgId: string) =>
    owner !== null && owner.org_id === orgId
      ? plannableHoursOf({ plannableHours: owner.plannable_hours, kind: owner.kind })
      : DEFAULT_PLANNABLE_HOURS

  /* `task` as lib/delay.ts reads it, as the app's store builds it. */
  const delayIssue = (
    task: Doc<'issues'>,
    facts: GroupFacts | null,
    capacity: number,
  ): DelayIssue => {
    const week = (day: string | undefined) => (day ? clock.ofDay(day) : null)
    let start: number | null
    let end: number | null
    if (facts !== null) {
      start = week(facts.span.start_week)
      end = week(facts.span.end_week)
    } else {
      start = week(task.start_week)
      const planned = week(task.end_week)
      end = planned === null ? null : Math.max(start ?? planned, planned)
    }
    return {
      uuid: task.id,
      status: task.status,
      isGroup: facts !== null,
      isDone: facts === null ? task.status === 'done' : facts.done,
      partial: facts?.span.partial ?? false,
      owner: taskOwnerId(task, facts !== null) ?? null,
      start,
      end,
      dueWeek: week(task.due_date),
      duePast: task.due_date !== undefined && task.due_date < clock.day,
      remaining: task.remaining_hours,
      remainingSet: task.remaining_set_at ? clock.ofInstant(task.remaining_set_at) : null,
      capacity,
    }
  }

  /* The load of `owner`, an owner of a seat of organization `orgId`. */
  const loadOf = async (orgId: string, owner: string): Promise<Load> => {
    const known = loads.get(owner)
    if (known !== undefined) return known
    const seat = seats.get(orgId)
    if (seat === undefined) return UNKNOWN
    if (!isOrgStaff(seat.me)) {
      // a guest or Viewer reads one owner's load a query
      if ((read.get(orgId) ?? 0) >= 1) return UNKNOWN
      read.set(orgId, 1)
    }
    let reader = readers.get(orgId)
    if (reader === undefined) {
      const access: Access = accessOf(ctx, seat.me)
      reader = ownerLoadReader(ctx, {
        me: seat.me,
        access,
        room: loadRoom(await ctx.meta.getTransactionMetrics(), guard),
      })
      readers.set(orgId, reader)
    }
    const got = await reader.read(owner)
    // the guard looks at the request's reads again before its next read
    guard.forget()
    const load: Load =
      got.state !== 'ok'
        ? UNKNOWN
        : canonicalLoad(
            loadRowsOf(seat.me, got.tasks).map((row) => ({
              issueUuid: row.issue_id,
              start: clock.ofDay(row.start_week),
              end: clock.ofDay(row.end_week),
              remaining: row.remaining,
              remainingSet:
                row.remaining_set_at === null ? null : clock.ofInstant(row.remaining_set_at),
            })),
          )
    loads.set(owner, load)
    return load
  }

  return {
    /** The owner whose load `task`'s verdict needs, with its capacity, or
     * null where the load cannot move it: a group, a Done task, one with
     * neither a planned end nor a due date, no remaining hours, an owner
     * without a finite week (an agent) or no owner. */
    async needs(task: Doc<'issues'>, facts: GroupFacts | null) {
      if (facts !== null || task.status === 'done') return null
      if (task.end_week === undefined && task.due_date === undefined) return null
      if (!((task.remaining_hours ?? 0) > 0)) return null
      const id = taskOwnerId(task, false)
      if (id === undefined) return null
      const owner = await profileOf(id)
      const capacity = capacityOf(owner, task.org_id)
      if (owner === null || !Number.isFinite(capacity) || capacity <= 0) return null
      return id
    },
    /** `task`'s verdict, with `facts` for a group, or UNKNOWN where the load
     * it needs could not be read. */
    async of(
      task: Doc<'issues'>,
      facts: GroupFacts | null,
    ): Promise<DelayInfo | null | typeof UNKNOWN> {
      const ownerId = taskOwnerId(task, facts !== null)
      const owner = ownerId === undefined ? null : await profileOf(ownerId)
      const it = delayIssue(task, facts, capacityOf(owner, task.org_id))
      const needed = await this.needs(task, facts)
      if (needed === null) return delayOf(it, [], 0)
      const load = await loadOf(task.org_id, needed)
      if (load === UNKNOWN) return UNKNOWN
      return delayOf(it, load, 0)
    },
    /** Reads the loads of `owners`, owner ids of organization `orgId`, in
     * owner id order, and answers whether every one was read. */
    async readAll(orgId: string, owners: readonly string[]): Promise<boolean> {
      for (const owner of [...new Set(owners)].sort())
        if ((await loadOf(orgId, owner)) === UNKNOWN) return false
      return true
    },
  }
}

/* Whether project `p` tracks delay, as the app paints a verdict only there. */
const tracks = (p: Doc<'projects'> | null): boolean => p?.track_delay === true

/* The scope's tasks due on or after the day, in projects that track delay,
 * projected late; null where an owner's load could not be read. The loads
 * are read for the owners in owner id order (verdicts readAll). */
async function projectedCount(
  ctx: QueryCtx,
  guard: ViewBudget,
  at: ScopeRead,
  clock: Clock,
): Promise<number | null> {
  const candidates: Doc<'issues'>[] = []
  for await (const step of dueTasks(ctx, guard, at, { from: clock.day, below: ANY_DAY }, tracks))
    candidates.push(...step)
  const g = newGroups()
  await readGroups(ctx, guard, at.seats, g, candidates, false)
  const kept = candidates.filter((t) => inScope(at, g, t))
  const groups = kept.filter((t) => isGroup(g, t))
  if (groups.length > 0) await readGroups(ctx, guard, at.seats, g, groups, true)
  const v = verdicts(ctx, guard, at.seats, clock)
  const open = kept.filter((t) => !isDoneFor(g, t))
  // the owners each organization's verdicts need, read in owner id order
  for (const [org, tasks] of groupBy(open, (t) => t.org_id)) {
    const owners: string[] = []
    for (const t of tasks) {
      const owner = await v.needs(t, isGroup(g, t) ? (g.facts.get(t.id) ?? null) : null)
      if (owner !== null) owners.push(owner)
    }
    if (!(await v.readAll(org, owners))) return null
  }
  let late = 0
  for (const t of open) {
    const verdict = await v.of(t, isGroup(g, t) ? (g.facts.get(t.id) ?? null) : null)
    if (verdict === UNKNOWN) return null
    if (verdict?.status === 'late') late++
  }
  return late
}

// --- list positions ---------------------------------------------------------------------

/** Where a row sorts in a list: dated before undated, then by due date,
 * creation time and document id. */
type Pos = { undated: boolean; due: string; at: number; doc: string }

const posOf = (t: Doc<'issues'>): Pos => ({
  undated: t.due_date === undefined,
  due: t.due_date ?? '',
  at: t._creationTime,
  doc: t._id,
})

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The order of list positions. */
const comparePos = (a: Pos, b: Pos): number =>
  Number(a.undated) - Number(b.undated) || order(a.due, b.due) || a.at - b.at || order(a.doc, b.doc)

/** The Overview's two lists. */
export type ListKind = 'attention' | 'paused'

/* The version each list's sealed positions carry outside and inside their
 * text: every sealed cursor shares one key (lib/archiveCursorSeal.ts), so
 * the version inside keeps one list's position from opening as another's,
 * or as another reader's cursor. */
const LIST_PREFIX: Record<ListKind, string> = { attention: 'oa1~', paused: 'op1~' }
const LIST_VERSION: Record<ListKind, string> = {
  attention: 'overview-attention-1',
  paused: 'overview-paused-1',
}

/* The longest position text that may open: far above what a position
 * seals to, so only junk is refused unopened. */
const POSITION_MAX = 4096

/** The key a list's positions are bound to: the list, the login (its
 * auth user id), the scope and the days and weeks its rows follow, of one
 * length whatever seats the login holds, so a seat gained or lost keeps the
 * login's positions, and a scope whose seat is gone answers unavailable. A
 * position from another key is refused. */
async function listKey(
  kind: ListKind,
  login: string,
  scope: OverviewScope,
  day: string,
  weeks?: { week: string; week_starts: readonly number[]; week_end: number },
): Promise<string> {
  const where = scope.kind === 'project' ? [scope.org_id, scope.project_id] : 'mine'
  const days =
    weeks === undefined
      ? [day]
      : [day, weeks.week, await digestText(JSON.stringify([weeks.week_starts, weeks.week_end]))]
  return JSON.stringify([kind, login, where, days])
}

/** `pos` sealed for list `kind` and `key`; a null position is the list's
 * start. */
async function sealPos(kind: ListKind, key: string, pos: Pos | null): Promise<string> {
  const at = pos === null ? null : [pos.undated ? 1 : 0, pos.due, pos.at, pos.doc]
  return `${LIST_PREFIX[kind]}${await sealCursorText(JSON.stringify([LIST_VERSION[kind], key, at]))}`
}

/** The position `text` names for list `kind` and `key`, null for its start,
 * or a badRequest naming argument `name` when it is not one this list
 * answered for that key. */
async function openPos(
  kind: ListKind,
  key: string,
  text: string,
  name: string,
): Promise<Pos | null> {
  const refused = () =>
    badRequest(`${name} must be a position an earlier batch of this list answered`)
  if (!text.startsWith(LIST_PREFIX[kind]) || text.length > POSITION_MAX) throw refused()
  const opened = await openCursorText(text.slice(LIST_PREFIX[kind].length))
  if (opened === null) throw refused()
  let body: unknown
  try {
    body = JSON.parse(opened)
  } catch {
    throw refused()
  }
  if (
    !Array.isArray(body) ||
    body.length !== 3 ||
    body[0] !== LIST_VERSION[kind] ||
    body[1] !== key
  )
    throw refused()
  const at = body[2]
  if (at === null) return null
  if (
    !Array.isArray(at) ||
    at.length !== 4 ||
    (at[0] !== 0 && at[0] !== 1) ||
    typeof at[1] !== 'string' ||
    typeof at[2] !== 'number' ||
    typeof at[3] !== 'string'
  )
    throw refused()
  return { undated: at[0] === 1, due: at[1], at: at[2], doc: at[3] }
}

// --- list candidates in order --------------------------------------------------------------

/* Rows a read takes beyond those it asks for, for the rows at the position
 * it goes on from, which it reads again and leaves out. */
const TIES = 4

/** One ordered range of candidates (a source): the least position its rows
 * can hold, and a read of up to `n` rows after `after` (from its start when
 * null) in position order, answering them, every row its reads returned,
 * the ones at `after` it left out and those past `n` included, and whether
 * the source has no more. */
type Source = {
  floor: Pos
  read(
    after: Pos | null,
    n: number,
  ): Promise<{ rows: Doc<'issues'>[]; returned: Doc<'issues'>[]; done: boolean }>
}

const LOWEST = (undated: boolean, due: string): Pos => ({
  undated,
  due,
  at: Number.NEGATIVE_INFINITY,
  doc: '',
})

/* Whether `t` sorts after `after`, or there is no `after`. */
const pastPos = (t: Doc<'issues'>, after: Pos | null) =>
  after === null || comparePos(posOf(t), after) > 0

/* The dated active tasks of `key`, paused as `paused` says, due from `from`
 * to before `below`, in position order. */
function datedSource(
  ctx: QueryCtx,
  key: DueKey,
  paused: boolean,
  from: string,
  below: string,
): Source {
  return {
    floor: LOWEST(false, from),
    read: async (after, n) => {
      const rows: Doc<'issues'>[] = []
      const returned: Doc<'issues'>[] = []
      let part: DuePart = { kind: 'from', from, below }
      if (after?.undated) return { rows, returned, done: true }
      if (after !== null && after.due >= from) {
        if (after.due >= below) return { rows, returned, done: true }
        // the rest of `after`'s due date, then the later due dates; a take
        // that only found rows at `after` reads further
        for (let take = n + TIES; ; take *= 2) {
          const same = await dueQuery(ctx, key, paused, {
            kind: 'same',
            due: after.due,
            from: after.at,
          }).take(take)
          returned.push(...same)
          const past = same.filter((t) => pastPos(t, after))
          if (same.length === take && past.length === 0) continue
          rows.push(...past)
          if (same.length === take) return { rows: rows.slice(0, n), returned, done: false }
          break
        }
        part = { kind: 'later', after: after.due, below }
      }
      const need = n - rows.length
      if (need <= 0) return { rows: rows.slice(0, n), returned, done: false }
      const later = await dueQuery(ctx, key, paused, part).take(need)
      returned.push(...later)
      rows.push(...later)
      return { rows, returned, done: later.length < need }
    },
  }
}

/* The undated active tasks of `key`, paused as `paused` says, in position
 * order. */
function undatedSource(ctx: QueryCtx, key: DueKey, paused: boolean): Source {
  const range = undatedRange(ctx, key, paused)
  return {
    floor: LOWEST(true, ''),
    read: async (after, n) => {
      const from = after?.undated ? after.at : undefined
      const returned: Doc<'issues'>[] = []
      // a take that only found rows at or before `after`'s creation time
      // and id reads further, each take's rows counted
      for (let take = n + (from === undefined ? 0 : TIES); ; take *= 2) {
        const got = await range.open(from).take(take)
        returned.push(...got)
        const past = got.filter((t) => pastPos(t, after))
        if (got.length === take && past.length === 0) continue
        return {
          rows: past.slice(0, n),
          returned,
          done: got.length < take && past.length <= n,
        }
      }
    },
  }
}

/* The rows `rows`, read and charged before, as a source, in position
 * order, which returns no row from the database again. */
function heldSource(rows: readonly Doc<'issues'>[]): Source {
  const sorted = [...rows].sort((a, b) => comparePos(posOf(a), posOf(b)))
  return {
    floor: sorted.length === 0 ? LOWEST(true, ANY_DAY) : posOf(sorted[0]),
    read: async (after, n) => {
      const past = sorted.filter((t) => pastPos(t, after))
      return { rows: past.slice(0, n), returned: [], done: past.length <= n }
    },
  }
}

/**
 * The candidates of `sources` in one total order of positions, after
 * `after`, merged: a source is read only once the least position it can
 * hold could come before every row read so far, a few rows at a time, the
 * sources a round needs read together within the guard. `read` hears every
 * row a read returned, for a caller that charges them.
 */
async function* inOrder(
  guard: ViewBudget,
  sources: readonly Source[],
  after: Pos | null,
  read: (t: Doc<'issues'>) => void = () => {},
): AsyncGenerator<Doc<'issues'>> {
  type State = { src: Source; buf: Doc<'issues'>[]; last: Pos | null; done: boolean }
  const states: State[] = sources.map((src) => ({ src, buf: [], last: after, done: false }))
  const floorOf = (s: State) =>
    s.last === null || comparePos(s.last, s.src.floor) < 0 ? s.src.floor : s.last
  for (;;) {
    let best: State | undefined
    for (const s of states)
      if (
        s.buf.length > 0 &&
        (best === undefined || comparePos(posOf(s.buf[0]), posOf(best.buf[0])) < 0)
      )
        best = s
    const head = best === undefined ? undefined : posOf(best.buf[0])
    const wanting = states.filter(
      (s) =>
        !s.done && s.buf.length === 0 && (head === undefined || comparePos(floorOf(s), head) < 0),
    )
    if (wanting.length > 0) {
      await fill(guard, wanting, read)
      continue
    }
    if (best === undefined) return
    const next = best.buf.shift() as Doc<'issues'>
    yield next
  }
}

/* How many rows a source read asks for at once. */
const CHUNK = OVERVIEW.batch + 1

/* Reads the next rows of `wanting`, up to 16 sources a round, each round
 * taking room for two ranges a source and the rows it may read. */
async function fill(
  guard: ViewBudget,
  wanting: readonly { src: Source; buf: Doc<'issues'>[]; last: Pos | null; done: boolean }[],
  read: (t: Doc<'issues'>) => void,
): Promise<void> {
  for (let at = 0; at < wanting.length; ) {
    const ranges = Math.min(16, wanting.length - at)
    const n = await guard.upTo(ROW, ranges * (CHUNK + TIES), ranges * (1 + TIES), {
      bytes: 0,
      documents: 0,
      ranges: 2 * ranges,
    })
    const each = Math.max(1, Math.floor(n / ranges) - TIES)
    const step = wanting.slice(at, at + ranges)
    at += ranges
    const got = await settled(step.map((s) => s.src.read(s.last, each)))
    guard.giveBack(ROW, n - got.reduce((total, g) => total + g.returned.length, 0))
    for (const [i, g] of got.entries()) {
      const s = step[i]
      // every row a read returned counts once, those it left out included
      for (const t of g.returned) read(t)
      s.buf.push(...g.rows)
      const last = g.rows.at(-1)
      if (last !== undefined) s.last = posOf(last)
      if (g.done) s.done = true
    }
  }
}

// --- list batches -------------------------------------------------------------------------

/* How many candidates one round of a batch judges together. */
const JUDGE = 16

/** What a list makes of a candidate it judged: a row, with what an At-risk
 * row says; no row; or `stop`, naming the owner whose load its verdict
 * needs and could not be read, so the batch ends before it. */
type Judged = { row: OverviewRow['at_risk'] | true } | { drop: true } | { stop: string }

/** One list over a scope: its sources and how it judges a round of
 * candidates, in order, with what the batch read of them. */
type ListSpec = {
  sources: Source[]
  judge(round: readonly Doc<'issues'>[], g: Groups): Promise<Judged[]>
}

/** What a batch read: the rows it keeps with their extras, in order; the
 * last candidate it judged; whether its reads stopped short; and the
 * parents of its rows it holds room back for (shownIds). */
type BatchRead = {
  rows: { task: Doc<'issues'>; at_risk?: OverviewRow['at_risk'] }[]
  last: Pos | null
  stopped: boolean
  parents: Set<string>
}

/* What reading one row's parent may take (shownIds): the parent by id, and
 * whether the reader is shown it, its project's row and the access question
 * about that project, held as the batch keeps the row (ViewBudget hold), so
 * a batch its budget stopped still answers the rows it kept. */
const PARENT_READ: Reads = {
  ranges: BY_ID.ranges + PROJECT_READ.ranges + PROJECT_ASK.ranges,
  documents: BY_ID.documents + PROJECT_READ.documents + PROJECT_ASK.documents,
  bytes: BY_ID.bytes + PROJECT_READ.bytes + PROJECT_ASK.bytes,
}

/* The candidates of `spec` after `from`, up to `end` when given, judged in
 * order until `want` rows are kept, the candidates end, or the reads stop
 * (a budget, or a verdict without its owner's load). A candidate that stops
 * the batch before it judged any other can never be judged by a later one,
 * as a later batch starts at it with the same reads, so it is kept as a row
 * whose risk is unknown and the batch goes on past it, as it does past the
 * later candidates of that owner. */
async function readBatch(
  guard: ViewBudget,
  spec: ListSpec,
  g: Groups,
  from: Pos | null,
  end: Pos | null,
  want: number,
  charge: (t: Doc<'issues'>) => void,
): Promise<BatchRead> {
  const out: BatchRead = { rows: [], last: from, stopped: false, parents: new Set() }
  const candidates = inOrder(guard, spec.sources, from, charge)
  // the owners whose loads no batch can read
  const unread = new Set<string>()
  /* keeps `t` as a row, with room for reading its parent */
  const keep = async (t: Doc<'issues'>, at_risk?: OverviewRow['at_risk']) => {
    if (t.parent_id !== undefined && !out.parents.has(t.parent_id)) {
      await guard.hold(PARENT_READ)
      out.parents.add(t.parent_id)
    }
    out.last = posOf(t)
    out.rows.push(at_risk === undefined ? { task: t } : { task: t, at_risk })
  }
  try {
    for (let ended = false; !ended && out.rows.length < want; ) {
      let round: Doc<'issues'>[] = []
      while (round.length < JUDGE) {
        const next = await candidates.next()
        if (next.done === true || (end !== null && comparePos(posOf(next.value), end) > 0)) {
          ended = true
          break
        }
        round.push(next.value)
      }
      while (round.length > 0) {
        const judged = await spec.judge(round, g)
        let rest: Doc<'issues'>[] = []
        for (const [i, t] of round.entries()) {
          const j = judged[i]
          if ('stop' in j) {
            if (out.last !== from && !unread.has(j.stop)) {
              out.stopped = true
              return out
            }
            // nothing judged before it, or an owner it could not read then:
            // unknown, and on past it
            unread.add(j.stop)
            await keep(t, { kind: 'unknown' })
            if (out.rows.length >= want) return out
            rest = round.slice(i + 1)
            break
          }
          if ('row' in j) await keep(t, j.row === true ? undefined : j.row)
          else out.last = posOf(t)
          if (out.rows.length >= want) return out
        }
        round = rest
      }
    }
  } catch (e) {
    if (!isOverBudget(e)) throw e
    out.stopped = true
  } finally {
    await candidates.return(undefined)
  }
  return out
}

/* The tasks among `rows`' parents the reader is shown, beside the rows
 * themselves: each parent read by id, charged at lib/limits.ts
 * TASK_ROW_MAX_BYTES, and shown when it is in the reader's working set. */
async function shownIds(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  rows: readonly Doc<'issues'>[],
): Promise<Set<string>> {
  const shown = new Set(rows.map((t) => t.id))
  const wanted = [
    ...new Set(
      rows.flatMap((t) =>
        t.parent_id === undefined || shown.has(t.parent_id) ? [] : [t.parent_id],
      ),
    ),
  ]
  if (wanted.length === 0) return shown
  await guard.take(BY_ID, wanted.length)
  const parents = (await settled(wanted.map((id) => byId(ctx, 'issues', id)))).filter(
    (p): p is Doc<'issues'> => p !== null,
  )
  for (const p of parents) guard.charge(p, TASK_ROW_MAX_BYTES)
  for (const [org, theirs] of groupBy(parents, (p) => p.org_id)) {
    const seat = seats.get(org)
    if (seat === undefined) continue
    const held = await seat.holds(theirs)
    for (const [i, p] of theirs.entries()) if (held[i]) shown.add(p.id)
  }
  return shown
}

/** The candidates a My view list read in projects the reader may not
 * see, each counted at lib/limits.ts TASK_ROW_MAX_BYTES each time a read
 * returned it, until it turns out to be a row of the batch, shown to the
 * reader, which counts at its real size. A project scope's candidates are
 * all shown. */
function charges(guard: ViewBudget, at: ScopeRead) {
  const times = new Map<string, number>()
  return {
    /** Counts `t`, which a read returned, at its fixed size. */
    charge: (t: Doc<'issues'>): void => {
      if (at.kind === 'project') return
      guard.charge(t, TASK_ROW_MAX_BYTES)
      times.set(t._id, (times.get(t._id) ?? 0) + 1)
    },
    /** Counts `t`, a row of the batch, at its real size. */
    shown: (t: Doc<'issues'>): void => {
      for (let n = times.get(t._id) ?? 0; n > 0; n--) guard.refund(t, TASK_ROW_MAX_BYTES)
      times.delete(t._id)
    },
  }
}

/** What charges answers. */
type Charges = ReturnType<typeof charges>

/**
 * One batch of list `kind` over the scope `at`, after `from` (its start when
 * null), up to `end` when the client asks the batch again with its fixed
 * end, as ListAnswer states it, or `over_budget` where its budget stopped it
 * before it judged a candidate.
 */
async function listBatch(
  ctx: QueryCtx,
  guard: ViewBudget,
  at: ScopeRead,
  kind: ListKind,
  key: string,
  spec: ListSpec,
  from: Pos | null,
  end: Pos | null,
  c: Charges,
): Promise<ListAnswer> {
  const g = newGroups()
  const want = end === null ? OVERVIEW.batch + 1 : OVERVIEW.split + 1
  const got = await readBatch(guard, spec, g, from, end, want, c.charge)
  // a batch that could not judge one candidate would answer its own start
  if (got.stopped && got.rows.length === 0 && got.last === from) return { state: 'over_budget' }
  const seal = (pos: Pos | null) => sealPos(kind, key, pos)
  let kept = got.rows
  let split: string | undefined
  let complete = !got.stopped
  let next: string | null
  let last: string | null
  if (end === null) {
    // a batch is whole once it holds OVERVIEW.batch rows, whatever stopped
    // the look past them
    if (got.rows.length > OVERVIEW.batch || (got.stopped && got.rows.length === OVERVIEW.batch)) {
      kept = got.rows.slice(0, OVERVIEW.batch)
      last = await seal(posOf(kept[kept.length - 1].task))
      next = last
      complete = true
    } else if (!got.stopped) {
      last = kept.length === 0 ? null : await seal(posOf(kept[kept.length - 1].task))
      next = null
    } else {
      // where the reads stopped: the next batch goes on after the last
      // candidate this one judged
      last = got.last === null ? null : await seal(got.last)
      next = await seal(got.last)
    }
  } else if (got.rows.length > OVERVIEW.split) {
    kept = got.rows.slice(0, OVERVIEW.batch)
    split = await seal(posOf(kept[kept.length - 1].task))
    complete = true
    last = await seal(end)
    next = last
  } else {
    last = await seal(end)
    next = got.stopped ? await seal(got.last) : last
  }
  // the rows are shown, so they count at their real size
  for (const { task } of kept) c.shown(task)
  const tasks = kept.map((r) => r.task)
  guard.release(PARENT_READ, got.parents.size)
  const shown = await shownIds(ctx, guard, at.seats, tasks)
  const rows = kept.map(({ task, at_risk }) => {
    const row = viewRow(
      task,
      (id) => shown.has(id),
      isGroup(g, task) ? (g.facts.get(task.id) ?? null) : null,
    )
    return at_risk === undefined ? row : { ...row, at_risk }
  })
  return { state: 'ok', rows, complete, next, end: last, ...(split === undefined ? {} : { split }) }
}

// --- the two lists ---------------------------------------------------------------------------

const DROP: Judged = { drop: true }

/* The sources of list `kind` over the scope `at`: for a project scope each
 * selected sub-project's ranges of the due-date index; for My view each
 * seat's person's assigned tasks there, and the In Review tasks they review,
 * which their range does not order by due date, read whole first (each read
 * counts through `charge`). The At-risk list's projected part reads only the
 * sub-projects that track delay. */
async function listSources(
  ctx: QueryCtx,
  guard: ViewBudget,
  at: ScopeRead,
  kind: ListKind,
  day: string,
  charge: (t: Doc<'issues'>) => void,
): Promise<Source[]> {
  const ranges = (key: DueKey, below: string): Source[] =>
    kind === 'paused'
      ? [datedSource(ctx, key, true, '', ANY_DAY), undatedSource(ctx, key, true)]
      : [false, true].map((paused) => datedSource(ctx, key, paused, '', below))
  if (at.kind === 'project')
    return at.selection.subProjects.flatMap((p) =>
      ranges({ project: p.id }, tracks(p) ? ANY_DAY : day),
    )
  const out: Source[] = []
  for (const seat of at.seats.values()) {
    const me = seat.me.id
    out.push(...ranges({ assignee: me }, ANY_DAY))
    const reviewed: Doc<'issues'>[] = []
    for await (const step of inSteps(guard, [reviewedRange(ctx, me)], ROW, charge))
      reviewed.push(...step)
    out.push(
      heldSource(
        reviewed.filter(
          (t) => t.assignee_id !== me && (kind === 'paused' ? t.paused : t.due_date !== undefined),
        ),
      ),
    )
  }
  return out
}

/* Whether each of `round` is in the scope's working set and a sub-project:
 * every candidate of a project scope is; in My view, those the seat's
 * access holds (lib/viewReads.ts ViewAccess holds). */
async function heldIn(at: ScopeRead, round: readonly Doc<'issues'>[]): Promise<boolean[]> {
  if (at.kind === 'project') return round.map(() => true)
  const out = round.map(() => false)
  for (const [org, theirs] of groupBy([...round.entries()], ([, t]) => t.org_id)) {
    const seat = at.seats.get(org)
    if (seat === undefined) continue
    const held = await seat.holds(theirs.map(([, t]) => t))
    for (const [k, [i, t]] of theirs.entries())
      out[i] = held[k] && (await seat.project(t.project_id))?.parent_id !== undefined
  }
  return out
}

/* The project of `t`, a candidate of the scope `at`. */
const projectOf = async (at: ScopeRead, t: Doc<'issues'>): Promise<Doc<'projects'> | null> =>
  at.kind === 'project'
    ? (at.selection.subProjects.find((p) => p.id === t.project_id) ?? null)
    : ((await at.seats.get(t.org_id)?.project(t.project_id)) ?? null)

/* The Overdue & at risk list: a task due before the day that is not done
 * for the reader, or one due on or after it, in a project that tracks
 * delay, projected late (verdicts). */
function attentionSpec(
  ctx: QueryCtx,
  guard: ViewBudget,
  at: ScopeRead,
  clock: Clock,
  sources: Source[],
): ListSpec {
  const v = verdicts(ctx, guard, at.seats, clock)
  return {
    sources,
    judge: async (round, g) => {
      const held = await heldIn(at, round)
      await readGroups(
        ctx,
        guard,
        at.seats,
        g,
        round.filter((_, i) => held[i]),
        true,
      )
      const out: Judged[] = []
      for (const [i, t] of round.entries()) {
        if (!held[i] || !inScope(at, g, t) || isDoneFor(g, t)) {
          out.push(DROP)
          continue
        }
        if ((t.due_date as string) < clock.day) {
          out.push({ row: { kind: 'overdue' } })
          continue
        }
        if (!tracks(await projectOf(at, t))) {
          out.push(DROP)
          continue
        }
        const facts = isGroup(g, t) ? (g.facts.get(t.id) ?? null) : null
        const verdict = await v.of(t, facts)
        if (verdict === UNKNOWN) {
          out.push({ stop: taskOwnerId(t, facts !== null) ?? '' })
          return out
        }
        out.push(
          verdict?.status === 'late'
            ? {
                row: {
                  kind: 'projected',
                  finish_week: verdict.fin === null ? null : clock.firstDay(verdict.fin),
                },
              }
            : DROP,
        )
      }
      return out
    },
  }
}

/* The Paused list: paused tasks without subtasks, a group's own pause
 * being dormant (src/store/planner.ts isPaused). */
function pausedSpec(ctx: QueryCtx, guard: ViewBudget, at: ScopeRead, sources: Source[]): ListSpec {
  return {
    sources,
    judge: async (round, g) => {
      const held = await heldIn(at, round)
      await readGroups(
        ctx,
        guard,
        at.seats,
        g,
        round.filter((_, i) => held[i]),
        false,
      )
      return round.map((t, i) =>
        held[i] && !isGroup(g, t) && inScope(at, g, t) ? { row: true } : DROP,
      )
    },
  }
}

// --- the answers ---------------------------------------------------------------------------

/* The sum of the leaves by status. */
const leafTotal = (c: LeafCounts) => ISSUE_STATUSES.reduce((n, s) => n + c.leaves[s], 0)

/**
 * The summary of `scope` on the client's day `day` (YYYY-MM-DD), for the
 * login whose seats are `profiles` (SummaryAnswer): the counts, whether the
 * scope holds a task, and Overdue, each a figure of its own, read in that
 * order within OVERVIEW.reads, so a figure whose reads do not fit answers
 * unavailable and the ones before it stay. Refuses a malformed day.
 */
export async function readSummary(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: { scope: OverviewScope; day: string },
): Promise<SummaryAnswer> {
  dayArg(args.day, 'day')
  return await overScope(ctx, profiles, args.scope, async (guard, at) => {
    const counts = await bounded(async (): Promise<SummaryAnswerCounts> => {
      const read =
        at.kind === 'project'
          ? await projectCounts(ctx, guard, at.selection)
          : await mineCounts(ctx, guard, at.seats)
      if (read === null) return { state: 'unavailable', reason: 'counting' }
      const sum = sumCounts(read.values())
      return { state: 'ok', leaves: sum.leaves, paused: sum.paused }
    })
    const any_task = await bounded(async () => {
      if (counts.state === 'ok' && leafTotal({ ...counts, left_tenths: 0 }) > 0)
        return { state: 'ok' as const, value: true }
      return {
        state: 'ok' as const,
        value:
          at.kind === 'project'
            ? await projectHasTask(ctx, guard, at.selection)
            : await mineHasTask(ctx, guard, at.seats),
      }
    })
    const overdue = await bounded(async () => ({
      state: 'ok' as const,
      count: await overdueCount(ctx, guard, at, args.day),
    }))
    return {
      state: 'ok',
      any_task,
      counts,
      overdue,
      ...(at.kind === 'project' ? { sub_projects: at.selection.subProjects.map((p) => p.id) } : {}),
    }
  })
}

/* SummaryAnswer's counts figure. */
type SummaryAnswerCounts = Figure<{ leaves: Record<IssueStatus, number>; paused: number }>

/**
 * The projected delays of `scope` (RiskAnswer) on the client's day and
 * weeks (clockOf), for the login whose seats are `profiles`: the tasks due
 * on or after the day in projects that track delay, projected late. Refuses
 * a malformed day, week, week_starts or week_end.
 */
export async function readRisk(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: {
    scope: OverviewScope
    day: string
    week: string
    week_starts: readonly number[]
    week_end: number
  },
): Promise<RiskAnswer> {
  const clock = clockOf(args)
  return await overScope(ctx, profiles, args.scope, async (guard, at) => {
    const projected = await bounded(async (): Promise<Figure<{ count: number }>> => {
      const count = await projectedCount(ctx, guard, at, clock)
      return count === null ? { state: 'unavailable', reason: 'loads' } : { state: 'ok', count }
    })
    return { state: 'ok', projected }
  })
}

/**
 * One batch of the Overdue & at risk list of `scope` (ListAnswer), on the
 * client's day and weeks (clockOf), after `cursor` (from its start
 * without), up to `end` when given, for the login whose seats are
 * `profiles` and whose auth user id is `login`. Overdue rows come first, as
 * their due dates are before the day, then projected ones, each by due
 * date; a row whose verdict could never be read is kept as `unknown`.
 * Refuses a malformed day, week, week_starts or week_end, and a cursor or
 * end this list did not answer for the same key (listKey).
 */
export async function readAttention(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  login: string,
  args: {
    scope: OverviewScope
    day: string
    week: string
    week_starts: readonly number[]
    week_end: number
    cursor?: string
    end?: string
  },
): Promise<ListAnswer> {
  const clock = clockOf(args)
  const key = await listKey('attention', login, args.scope, args.day, args)
  const from =
    args.cursor === undefined ? null : await openPos('attention', key, args.cursor, 'cursor')
  const end = args.end === undefined ? null : await openPos('attention', key, args.end, 'end')
  return await overScope(ctx, profiles, args.scope, async (guard, at) => {
    const c = charges(guard, at)
    const sources = await listSources(ctx, guard, at, 'attention', clock.day, c.charge)
    const spec = attentionSpec(ctx, guard, at, clock, sources)
    return await listBatch(ctx, guard, at, 'attention', key, spec, from, end, c)
  })
}

/**
 * One batch of the Paused list of `scope` (ListAnswer): paused tasks
 * without subtasks, earliest due date first, undated last, after `cursor`
 * (from its start without), up to `end` when given. No figure of it
 * follows the day. Refuses a cursor or end this list did not answer for
 * the same key (listKey), with `login` the caller's auth user id.
 */
export async function readPaused(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  login: string,
  args: { scope: OverviewScope; cursor?: string; end?: string },
): Promise<ListAnswer> {
  const key = await listKey('paused', login, args.scope, '')
  const from =
    args.cursor === undefined ? null : await openPos('paused', key, args.cursor, 'cursor')
  const end = args.end === undefined ? null : await openPos('paused', key, args.end, 'end')
  return await overScope(ctx, profiles, args.scope, async (guard, at) => {
    const c = charges(guard, at)
    const sources = await listSources(ctx, guard, at, 'paused', '', c.charge)
    const spec = pausedSpec(ctx, guard, at, sources)
    return await listBatch(ctx, guard, at, 'paused', key, spec, from, end, c)
  })
}

// --- one sub-project's health ---------------------------------------------------------------

/** One health row piece: a sub-project's figures, or one person's in it. */
export type HealthPiece = {
  /** the leaves by status, the paused leaves and the remaining hours of the
   * leaves not Done in whole tenths, unrounded: a row over several pieces
   * adds them up and rounds once, as src/store/planner.ts remainingByGroups
   * does */
  counts: Figure<LeafCounts>
  /** the tasks, groups included, whose verdict is late (Delayed) or behind
   * (Slipping), in a project that tracks delay; zero in one that does not */
  delays: Figure<{ late: number; behind: number }>
}

/**
 * The health figures of live sub-project `project`, or with `owner` of the
 * tasks that seat's person owns there by the Reviewer rule, for a health
 * row (src/views/Overview.tsx, the health table), within `guard`:
 *
 * - its counts: the family's readiness and the sub-project's rows, or the
 *   person's rows there (model/overviewCounts.ts), a few ranges whatever
 *   its tasks;
 * - its delays: every active task of the sub-project read (lib/viewReads.ts
 *   selectionTasks), which are groups and their group facts, and the
 *   verdicts `v` gives, whose owners' loads it reads in owner id order.
 *
 * A figure whose reads do not fit `guard` answers unavailable for `budget`,
 * one whose owner's load could not be read for `loads`. Pass one `v` for
 * all the rows of one query, so each owner's load is read once. A row of a
 * project scope is one piece; a top-level project's row in My view adds up
 * the person's pieces of its sub-projects. It is also the reader REST's and
 * MCP's project completion can switch to for one sub-project
 * (model/overviewCounts.ts familyCounts for a family).
 */
export async function subProjectHealth(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  project: Doc<'projects'>,
  v: Verdicts,
  owner?: Doc<'profiles'>,
): Promise<HealthPiece> {
  const family = project.parent_id
  const counts = await bounded(async (): Promise<Figure<LeafCounts>> => {
    if (family === undefined || project.archived_at !== undefined)
      return { state: 'unavailable', reason: 'counting' }
    if (owner === undefined) {
      await guard.take(RANGE, 3)
      await guard.take(SUB_COUNTS)
      const got = (await familyCounts(ctx.db, project.org_id, family, [project]))?.get(project.id)
      return got === undefined
        ? { state: 'unavailable', reason: 'counting' }
        : { state: 'ok', ...got }
    }
    await guard.take(RANGE, 3)
    await guard.take(SUB_COUNTS)
    const state = await orgCountState(ctx.db, project.org_id)
    if (!state.stamped || state.run !== null || (await overviewRegroupOf(ctx.db, family)) !== null)
      return { state: 'unavailable', reason: 'counting' }
    const rows = await ctx.db
      .query('overview_counts')
      .withIndex('by_owner_project', (q) => q.eq('owner_id', owner.id).eq('project_id', project.id))
      .collect()
    const got = countsOfRows(rows, project)
    return got === null ? { state: 'unavailable', reason: 'counting' } : { state: 'ok', ...got }
  })
  const delays = await bounded(async (): Promise<Figure<{ late: number; behind: number }>> => {
    if (!tracks(project)) return { state: 'ok', late: 0, behind: 0 }
    const tasks: Doc<'issues'>[] = []
    for await (const step of selectionTasks(ctx, guard, [project])) tasks.push(...step)
    const g = newGroups()
    await readGroups(ctx, guard, seats, g, tasks, true)
    const mine = tasks.filter(
      (t) => owner === undefined || taskOwnerId(t, isGroup(g, t)) === owner.id,
    )
    const facts = (t: Doc<'issues'>) => (isGroup(g, t) ? (g.facts.get(t.id) ?? null) : null)
    const owners: string[] = []
    for (const t of mine) {
      const needed = await v.needs(t, facts(t))
      if (needed !== null) owners.push(needed)
    }
    if (!(await v.readAll(project.org_id, owners))) return { state: 'unavailable', reason: 'loads' }
    let late = 0
    let behind = 0
    for (const t of mine) {
      const verdict = await v.of(t, facts(t))
      if (verdict === UNKNOWN) return { state: 'unavailable', reason: 'loads' }
      if (verdict?.status === 'late') late++
      if (verdict?.status === 'behind') behind++
    }
    return { state: 'ok', late, behind }
  })
  return { counts, delays }
}
