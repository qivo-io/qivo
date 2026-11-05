/* The Roadmap's reads behind tasks.ts roadmap and roadmapDependencies. They
 * answer one Roadmap selection with the Roadmap's filter row and its
 * displayed window applied on the server, and the dependency inputs its
 * arrows and Auto-move need, within the Roadmap's budgets (ROADMAP, DEPENDENCIES) and its
 * ceiling of ROADMAP.ceiling tasks, lib/limits.ts ROADMAP_TASKS. It reads
 * through the shared view reader (lib/viewReads.ts) and the filter row's
 * read the Roadmap shares with the Board (lib/viewFilters.ts filterRead),
 * and holds the Roadmap's own rules, which tasks are rows
 * (lib/roadmapVisibility.ts isRoadmapTaskVisible, the app's rule), the
 * ceiling with groups counted, the counts bound, the headings' Remaining,
 * the sub-projects My view holds, a group row's subtasks, the parts of the
 * dependency graph Auto-move works on, and the states. The app imports this
 * module's types only.
 *
 * A selection is a top-level project with its visible live sub-projects, one
 * sub-project, or My view, the person's own tasks by the Reviewer rule
 * (lib/review.ts taskOwnerId) across every seat of the login, read through
 * their assignee and reviewer ranges and never by reading projects. There
 * is no all-projects selection. Both reads hold only tasks of the reader's
 * working set (lib/workingSet.ts). Admin status adds nothing beyond what
 * lib/access.ts accessOf answers.
 *
 * The window. The app floors a stored day into the reader's week grid, and
 * the server has no grid of its own, so the client sends `from` and `to`,
 * the first days of the displayed window's first and last weeks on its
 * grid. A stored day's week is the whole number of weeks from `from`,
 * floored, so the window is weeks 0 to (to - from) / 7, both counted.
 *
 * Beside lib/viewReads.ts's list, these still follow hidden data at a
 * budget's margin. How many subtasks a shown group has, hidden ones
 * included; how many of a person's own tasks and count rows are in projects
 * they cannot see, and where those projects' ids sort among the others
 * (lib/viewReads.ts mineCounts); the hidden sub-projects of a navigated
 * top-level project; and for the dependency read, how many links a task of
 * a part has to tasks the reader is not shown, archived tasks included,
 * each read by id and dropped. Each such task or link counts at a fixed
 * size, so its contents move no answer. A `counting` Remaining also
 * follows a regroup anywhere in the organization (model/overviewCounts.ts
 * countsReady), so a reader learns for a while that some project, one they cannot see
 * included, was archived, restored or moved to Deleted items, as the
 * Overview's figures do (lib/overview.ts). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { LeafCounts } from '../model/overviewCounts'
import { ACCESS_UNCHECKED, isAccessUnchecked } from './access'
import type { BoardScope } from './board'
import { byId } from './db'
import { ISSUE_STATUSES, type IssuePriority } from './enums'
import { badRequest } from './functions'
import { LIMITS, MIB, ROADMAP_TASKS, TASK_ROW_MAX_BYTES } from './limits'
import { dayArg, dayNumber, type Figure } from './overview'
import { isRoadmapTaskVisible } from './roadmapVisibility'
import {
  byNumber,
  type FilterResult,
  type Filters,
  filterRead,
  filtersOf,
  OverCeiling,
  order,
  type RowRule,
  STEP,
} from './viewFilters'
import {
  BY_ID,
  type GroupFacts,
  groupBy,
  groupCheck,
  groupFacts,
  inSteps,
  isGroupIn,
  isOverBudget,
  mineCounts,
  noSubtasks,
  OverBudget,
  ownedBy,
  ownerSettled,
  ownTasks,
  projectCounts,
  projectSelection,
  type Reads,
  type Selection,
  type StepRange,
  type Subtasks,
  selectionTasks,
  settled,
  shownParents,
  type ViewAccess,
  type ViewBudget,
  type ViewRow,
  type ViewSeats,
  viewAccess,
  viewBudget,
  viewRow,
} from './viewReads'

// --- budgets and shapes -----------------------------------------------------------

/** The Roadmap's budgets, which tests lower and set back with
 * structuredClone.
 *
 * `reads` caps the request's reads as Convex counts them, the reader's own
 * access rows included (lib/viewReads.ts viewBudget), the same as the
 * Board's (lib/board.ts BOARD.reads), keeping room under Convex's limits for
 * what one step reads past the guard's last look. Measured under
 * convex-test's transaction limits with rows as the app writes them, in
 * ordinary text, data from before the rule of one level
 * (tests/roadmapRead.test.ts, real limits), in ranges, documents and MiB, on
 * 5 November 2026, each case one figure at its design size:
 *
 * - A project of 3 sub-projects with 800 open tasks, one in ten of them a
 *   group and two in ten subtasks, three in five dated, the default window:
 *   827, 992 and 0.58, 731 rows. A search of it that 7 rows match: 53,
 *   1,644 and 0.96.
 * - A project of 30 sub-projects with 20 open tasks each: 696, 873 and
 *   0.48, 570 rows.
 * - A sub-project of 300 open tasks beside two of 30: 313, 372 and 0.22
 *   for the sub-project, 379, 454 and 0.27 for its project.
 * - 200 Done tasks not yet archived beside 90 open ones over 3
 *   sub-projects: 308, 329 and 0.20 in a window that holds them all (284
 *   rows) and in one that holds none (84 rows).
 * - My view of 400 of the reader's own tasks over the 200 sub-projects
 *   their three teams share: 803, 1,239 and 0.55. A person in 5 teams, each
 *   sharing 20 sub-projects with one task of theirs: 298, 334 and 0.15.
 * - The largest My view the ceiling allows, 1,000 of the person's subtasks
 *   under 1,000 parents of others over 21 sub-projects of 3 projects, each
 *   shared with each of the person's 3 teams: 3,106, 3,195 and 1.87. One
 *   more answers over_ceiling from the counts in 84 ranges.
 *
 * Each task the filters keep costs about one range, its group check, and a
 * group one more for its subtasks, as on the Board, and a group's facts
 * read nothing more. A search reads as the Board's does. The counts add 3
 * ranges and one a sub-project, or in My view the person's count rows.
 *
 * `context` caps the shown parents and the subtasks of group rows that are
 * not rows themselves, together, the rows a Roadmap holds beside its
 * ROADMAP.ceiling rows, 2,000 view rows of up to about 1.6 KB of JSON,
 * about 3.2 MB. `owners` caps the ids the people filter may name, the
 * design size's 1,000 people. `labelTasks` and `labelScan` are the search's
 * label reads (lib/viewFilters.ts SearchLimits), the Board's values.
 * `ceiling` is the most rows a Roadmap answers, groups counted,
 * lib/limits.ts ROADMAP_TASKS; tests lower it here alone. */
export const ROADMAP = {
  reads: { bytes: 12 * MIB, documents: 24_000, ranges: 3_600 },
  context: 2000,
  owners: 1000,
  labelTasks: 64,
  labelScan: 4,
  ceiling: ROADMAP_TASKS,
}

/** The dependency read's budgets (readDependencies), which tests lower and
 * set back with structuredClone.
 *
 * `reads` is the Roadmap's. `tasks` caps the tasks of the parts the read
 * grows, the selected tasks with a span among them; past it Auto-move's
 * inputs answer over_budget, and the arrows between the selection's own
 * tasks stay. Measured as ROADMAP's are (tests/dependencies.test.ts, real
 * limits), at the everyday link share, 5 percent of tasks with a blocks
 * link, half of those to tasks of everyday projects elsewhere in the
 * organization, as the perf seed links its tasks (scripts/perf/server.mjs
 * `links`):
 *
 * - A project of 800 open tasks over 3 sub-projects, 40 of them linked, 20
 *   to each other and 20 to tasks of 2 everyday projects of 90 tasks
 *   elsewhere, which hold their own share: 1,960, 1,094 and 0.62, parts of
 *   95 tasks. The selection's group checks and the two link ranges of each
 *   of its tasks with a span take most of the ranges.
 * - My view of 400 of the reader's own tasks over 200 sub-projects, 20 of
 *   them linked, half to other people's tasks: 1,306, 871 and 0.41.
 * - Each task of a part outside the selection costs about 4.2 ranges, 3.3
 *   documents and 0.0015 MiB, for its read by id, its group check, its two
 *   link ranges and its project's access, measured over chains through 60
 *   and 120 tasks of everyday projects (470 and 721 ranges).
 *
 * So beside a project at its design size the parts may hold about 380
 * tasks outside the selection. A chain of 350 tasks through 6 everyday
 * projects, which brings 386 such tasks with their families, reads 3,442
 * ranges, 2,277 documents and 1.16 MiB whole. That is the measured size;
 * past it the ranges run out and Auto-move's inputs answer over_budget.
 * `tasks` comes after it inside the design size and bounds the bytes sent.
 *
 * The owner chose on 1 November 2026 that a figure that depends on the day
 * or on workloads may answer unavailable past a measured size inside the
 * design size. Auto-move is a scheduling calculation over other tasks'
 * dates, and the limits plan asks to make such a calculation explicitly
 * unavailable rather than derive it from incomplete inputs (Roadmap
 * loading, Workload and scheduling loading), so its inputs answer
 * over_budget past the size above, an agent decision of 5 November 2026
 * that borrows choice 1's measured and documented size. The design size has
 * no link figure, so the measured size uses the perf seed's share. */
export const DEPENDENCIES = {
  reads: { bytes: 12 * MIB, documents: 24_000, ranges: 3_600 },
  tasks: 2000,
}

/** The most a link row takes, as Convex counts a document. It holds an
 * organization, a link, a source and a target id, the type, the pair key,
 * the creation time, the archive mark and the source's window key, 414
 * bytes measured (tests/rowBounds.test.ts). The dependency read counts
 * each link row it reads at this size, so a link to a task the reader is
 * not shown moves no answer by its contents. */
export const LINK_ROW_BYTES = 512

/** One link row read in a task's range. */
const LINK_ROW: Reads = { bytes: LINK_ROW_BYTES, documents: 1, ranges: 0 }

/** A Roadmap selection, as the Board names one (lib/board.ts BoardScope). */
export type RoadmapScope = BoardScope

/** The Roadmap's filter row, as the app hands the Roadmap the effective
 * filters (src/App.tsx roadmapFilters), with My tasks, the people filter,
 * Priority and the text filter. The Roadmap applies neither Stale nor
 * Focus. */
export type RoadmapFilters = {
  /** the My tasks toggle; in My view the person is the selection, so it
   * adds nothing */
  mine: boolean
  /** the people filter, matched against each task's owner by the Reviewer
   * rule (lib/review.ts taskOwnerId), at most ROADMAP.owners ids */
  owners: string[]
  priority: IssuePriority | null
  /** at most LIMITS.search characters, trimmed here */
  search: string
}

/** The displayed window, the first days, YYYY-MM-DD, of its first and last
 * weeks on the reader's week grid, at most LIMITS.roadmapWeeks.max weeks
 * counted inclusively (src/lib/dates.ts resolveWin). */
export type RoadmapWindow = { from: string; to: string }

/** What tasks.ts roadmap answers. */
export type RoadmapAnswer =
  | {
      state: 'ok'
      /** every task the Roadmap shows, groups included, by number, then
       * organization and id, the selection's tasks that pass the filter row
       * and isRoadmapTaskVisible in the window */
      rows: ViewRow[]
      /** the shown ancestors of rows that are not rows themselves, as the
       * Board's parents */
      parents: ViewRow[]
      /** every shown descendant of a group row, at any depth, that is
       * neither a row nor a parent, such as Backlog subtasks, Done ones outside
       * the window, filtered-out ones and those in another sub-project. With
       * the rows and parents they hold every shown descendant of a group
       * row, so a group's bar during a drag (src/lib/issueGroups.ts
       * groupSpan) and its stale fade (the newest activity of its shown
       * descendants) need nothing else; a view row carries no `newest`. */
      subtasks: ViewRow[]
      /** In My view only, the sub-projects, by id, that hold an active task
       * the person owns by the Reviewer rule, whatever its status, its
       * dates or the filters, as the app's Roadmap keeps a track or band
       * (src/views/Roadmap.tsx held). Sub-project ids, where the Board's
       * held_projects holds lanes. */
      held_sub_projects?: string[]
      /** a project selection's sub-projects, to narrow to */
      projects?: string[]
      /** each sub-project's unfinished leaves' Remaining in whole tenths of
       * an hour, Backlog included, before the filter row, from the counts
       * (model/overviewCounts.ts left_tenths). In a project selection every
       * selected sub-project has a key. In My view they are the person's own
       * leaves, and a sub-project without a key holds none of them, 0
       * tenths. Sum in tenths and divide by 10 once. `counting` while the counts are
       * not whole, `budget` where their reads did not fit. */
      remaining: Figure<{ tenths: Record<string, number> }>
    }
  | { state: 'over_ceiling'; ceiling: number; projects?: string[] }
  | { state: 'over_budget'; projects?: string[] }
  | { state: 'unavailable'; reason?: typeof ACCESS_UNCHECKED; message?: string }

/** One blocks link as Auto-move and the arrows read it, its blocker, the
 * link's source, and the task it blocks, its target. */
export type DependencyPair = { blocker: string; blocked: string }

/** A task as the dependency read sends it, with what Auto-move
 * (src/lib/schedule.ts autoMoves) reads of it and the stored dates a move
 * sends as expected values (roadmap.ts change). `parent_id` only for a parent in the same
 * answer; `span` on groups only. */
export type DependencyRow = Pick<
  ViewRow,
  | 'id'
  | 'org_id'
  | 'project_id'
  | 'num'
  | 'status'
  | 'start_week'
  | 'end_week'
  | 'parent_id'
  | 'has_subtasks'
  | 'span'
>

/** Auto-move's inputs, the parts of the dependency graph that hold a
 * selected task and a blocks link, whole. */
export type AutoMoveInputs = {
  state: 'ok'
  /** every task of the parts, by number, then organization and id */
  tasks: DependencyRow[]
  /** every blocks link between two of `tasks`, by the link's creation
   * time, then its id, the order in which the app lists a task's links
   * (src/lib/taskSections.ts linkViews). Build each task's links from them
   * in this order, so autoMoves takes its pairs in the app's order */
  pairs: DependencyPair[]
  /** the projects of `tasks` the reader may edit (Edit, lead or user
   * level), for autoMoves's canWrite */
  editable_projects: string[]
}

/** What tasks.ts roadmapDependencies answers. */
export type DependencyAnswer =
  | {
      state: 'ok'
      /** the arrows' inputs, every blocks link between two selected tasks
       * with a span, in `auto_move.pairs`'s order; whole whenever the
       * answer is ok */
      pairs: DependencyPair[]
      /** Auto-move's inputs, or over_budget past their measured size
       * (DEPENDENCIES), never part of them */
      auto_move: AutoMoveInputs | { state: 'over_budget' }
    }
  | { state: 'over_budget' }
  | { state: 'unavailable'; reason?: typeof ACCESS_UNCHECKED; message?: string }

/** What both reads answer for a selection they do not hold, alike for every
 * reason. */
const UNAVAILABLE = { state: 'unavailable' as const }

// --- the window ---------------------------------------------------------------------

/** A window as the read applies it, its first week's first day as a day
 * number and its last week, weeks counted from 0. */
type Window = { from: number; last: number }

/** The window of `w`, refused where a day is not a real YYYY-MM-DD day, `to`
 * is before `from`, they are not a whole number of weeks apart, or the
 * window spans more than LIMITS.roadmapWeeks.max weeks counted inclusively. */
function windowOf(w: RoadmapWindow): Window {
  const from = dayArg(w.from, 'window.from')
  const to = dayArg(w.to, 'window.to')
  if (to < from) throw badRequest('window.to must not be before window.from')
  if ((to - from) % 7 !== 0)
    throw badRequest('window.from and window.to must be the first days of two weeks')
  const last = (to - from) / 7
  if (last + 1 > LIMITS.roadmapWeeks.max)
    throw badRequest(`the window spans at most ${LIMITS.roadmapWeeks.max} weeks`)
  return { from, last }
}

/** The week of stored day `iso` in `win`, weeks counted from its first. */
const weekIn = (win: Window, iso: string): number => Math.floor((dayNumber(iso) - win.from) / 7)

/**
 * `t` as isRoadmapTaskVisible reads it, with weeks counted from `win`'s
 * first. A task without subtasks goes by its stored dates, as the app shapes
 * them (src/store/viewModels.ts), an end only with an end week, never
 * before the start; a group by its calculated span (GroupFacts span).
 */
function visibleIn(
  win: Window,
  t: Doc<'issues'>,
  group: boolean,
  facts: GroupFacts | undefined,
): boolean {
  if (group) {
    const span = facts?.span
    const start = span?.start_week === undefined ? null : weekIn(win, span.start_week)
    const end = span?.end_week === undefined ? null : weekIn(win, span.end_week)
    return isRoadmapTaskVisible(
      { status: t.status, isGroup: true, start, end },
      facts?.done ?? false,
      0,
      win.last,
    )
  }
  const start = t.start_week === undefined ? null : weekIn(win, t.start_week)
  const end =
    t.end_week === undefined
      ? null
      : Math.max(start ?? weekIn(win, t.end_week), weekIn(win, t.end_week))
  return isRoadmapTaskVisible(
    { status: t.status, isGroup: false, start, end },
    t.status === 'done',
    0,
    win.last,
  )
}

// --- the scope ----------------------------------------------------------------------

/** What a scope names, its seats and, for a project selection, the
 * selection. */
type Scoped = { seats: ViewSeats; selection: Selection | null }

/* The seats and selection `scope` names for the login whose seats are
 * `profiles`, or null where it names none, alike for every reason, as
 * lib/board.ts reads a Board's, a project selection with the login's seat
 * in its organization (lib/viewReads.ts projectSelection), named in `known`
 * once known, or My view's seats. */
async function scoped(
  ctx: QueryCtx,
  guard: ViewBudget,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  scope: RoadmapScope,
  known: { projects?: string[] },
): Promise<Scoped | null> {
  if (scope.kind === 'project') {
    const me = profiles.get(scope.org_id)
    if (me === undefined) return null
    const seat = viewAccess(ctx, guard, me)
    const selection = await projectSelection(ctx, guard, seat, scope.project_id)
    if (selection === null) return null
    known.projects = selection.subProjects.map((p) => p.id)
    return { seats: new Map([[me.org_id, seat]]), selection }
  }
  const seats = new Map(
    [...profiles.values()].map((me): [string, ViewAccess] => [
      me.org_id,
      viewAccess(ctx, guard, me),
    ]),
  )
  return { seats, selection: null }
}

/* The seat of `at`'s project selection. */
const selectionSeat = (at: Scoped): ViewAccess => {
  const seat = [...at.seats.values()][0]
  if (seat === undefined) throw new Error('a project selection without its seat')
  return seat
}

// --- the rows -----------------------------------------------------------------------

/**
 * The Roadmap of `scope` with `filters` in `window` for the login whose
 * seats are `profiles`, by organization:
 *
 * - `ok` with every task the Roadmap shows (`rows`), the shown parents above
 *   them (`parents`), the shown subtasks of group rows that are not rows
 *   (`subtasks`), My view's sub-projects (`held_sub_projects`), a project
 *   selection's sub-projects (`projects`) and the headings' Remaining;
 * - `over_ceiling` once more than ROADMAP.ceiling rows, groups counted,
 *   were established, by the counts bound (roadmapOf) or the
 *   ROADMAP.ceiling + 1th row the read found, whatever the budget says
 *   after;
 * - `over_budget` when the reads reach ROADMAP.reads before the count is
 *   known, or the parents and subtasks pass ROADMAP.context;
 * - `unavailable`, alike for every reason, for a project selection the
 *   login holds no seat in or that names no selection, and with `reason`
 *   and its sentence where a bound of the reader's own access reads stopped
 *   a check (lib/access.ts accessUnchecked). Never a smaller Roadmap.
 *
 * Refuses more than ROADMAP.owners owners, a search past LIMITS.search
 * (lib/viewFilters.ts filtersOf) and a window windowOf refuses.
 */
export async function readRoadmap(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: { scope: RoadmapScope; filters: RoadmapFilters; window: RoadmapWindow },
): Promise<RoadmapAnswer> {
  const f = filtersOf(args.filters, ROADMAP.owners)
  const win = windowOf(args.window)
  // a project selection's sub-projects, once known
  const known: { projects?: string[] } = {}
  try {
    return await roadmapOf(ctx, profiles, args.scope, f, win, known)
  } catch (e) {
    const projects = known.projects === undefined ? {} : { projects: known.projects }
    if (e instanceof OverCeiling)
      return { state: 'over_ceiling', ceiling: ROADMAP.ceiling, ...projects }
    if (isOverBudget(e)) return { state: 'over_budget', ...projects }
    if (isAccessUnchecked(e))
      return { state: 'unavailable', reason: ACCESS_UNCHECKED, message: e.data.message }
    throw e
  }
}

/**
 * The Roadmap's rule over the tasks that pass the filter row
 * (lib/viewFilters.ts filterRead). A task is a row where
 * isRoadmapTaskVisible keeps it in `win`, a group by its facts, its
 * effective completion and calculated span, and every row counts toward
 * ROADMAP.ceiling, groups included (the coordinator's decision of 31
 * October 2026).
 */
const roadmapRule = (win: Window): RowRule => ({
  facts: true,
  row: (t, group, facts) => visibleIn(win, t, group, facts),
  counts: () => true,
  ceiling: ROADMAP.ceiling,
})

/* A count read's answer, or why it gives none, not whole yet (`counting`)
 * or its reads did not fit (`budget`). */
async function countsRead(
  read: () => Promise<Map<string, LeafCounts> | null>,
): Promise<Map<string, LeafCounts> | 'counting' | 'budget'> {
  try {
    return (await read()) ?? 'counting'
  } catch (e) {
    if (isOverBudget(e)) return 'budget'
    throw e
  }
}

/* readRoadmap's answer while it is ok, its selection named in `known`. */
async function roadmapOf(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  scope: RoadmapScope,
  f: Filters,
  win: Window,
  known: { projects?: string[] },
): Promise<RoadmapAnswer> {
  const guard = viewBudget(ctx, ROADMAP.reads)
  const at = await scoped(ctx, guard, profiles, scope, known)
  if (at === null) return UNAVAILABLE
  const { seats, selection } = at
  // the headings' counts, which the bound reuses
  const counts = await countsRead(() =>
    selection === null ? mineCounts(ctx, guard, seats) : projectCounts(ctx, guard, selection),
  )
  // The counts bound, where it costs no read. Every counted To do, In
  // progress and In review leaf is a row whatever its dates, in a project
  // selection without a filter, and in My view without the people filter,
  // Priority or a search, so a sum past the ceiling establishes it
  const unfiltered = f.owners.size === 0 && f.priority === null && f.search === ''
  if (counts instanceof Map && unfiltered && (selection === null || !f.mine)) {
    let open = 0
    for (const c of counts.values()) open += c.leaves.todo + c.leaves.progress + c.leaves.review
    if (open > ROADMAP.ceiling) throw new OverCeiling()
  }
  const rule = roadmapRule(win)
  const read = filterRead(ctx, guard, seats, f, {
    mine: selection === null || f.mine,
    whole: selection !== null && !f.mine,
    rule,
    limits: ROADMAP,
  })
  // My view's tasks as the read takes them, for the sub-projects it holds
  const taken: Doc<'issues'>[] = []
  if (selection !== null) {
    const ids = new Set(selection.subProjects.map((p) => p.id))
    // My tasks reads the person's own ranges and keeps those of the
    // selection; every other filter reads the selection's ranges whole
    await read.take(
      f.mine
        ? ownTasks(ctx, guard, selectionSeat(at), ISSUE_STATUSES)
        : selectionTasks(ctx, guard, selection.subProjects),
      (t) => ids.has(t.project_id),
    )
  } else
    for (const seat of seats.values())
      await read.take(noting(ownTasks(ctx, guard, seat, ISSUE_STATUSES), taken))
  const got = await read.finish()
  const held =
    selection === null ? await heldSubProjects(ctx, guard, seats, taken, got.subtasks) : null
  const remaining: Figure<{ tenths: Record<string, number> }> =
    counts instanceof Map
      ? {
          state: 'ok',
          tenths: Object.fromEntries([...counts].map(([id, c]) => [id, c.left_tenths])),
        }
      : { state: 'unavailable', reason: counts }
  return await roadmapAnswer(ctx, guard, seats, got, {
    remaining,
    ...(held === null ? {} : { held_sub_projects: held }),
    ...(selection === null ? {} : { projects: selection.subProjects.map((p) => p.id) }),
  })
}

/* Yields `batches`, each batch's tasks noted in `into` first. */
async function* noting(
  batches: AsyncIterable<Doc<'issues'>[]>,
  into: Doc<'issues'>[],
): AsyncGenerator<Doc<'issues'>[]> {
  for await (const batch of batches) {
    into.push(...batch)
    yield batch
  }
}

/**
 * The sub-projects of the tasks of `taken`, My view's own ranges, that the
 * person of their seat owns by the Reviewer rule (lib/viewReads.ts
 * ownedBy), before the filter row and the window, as the app's Roadmap
 * keeps a track or band (src/views/Roadmap.tsx held), in id order. A task
 * whose owner is settled needs no group check; one In Review with another
 * reviewer gets one, which the filters may have skipped, unless its
 * sub-project is held already.
 */
async function heldSubProjects(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  taken: readonly Doc<'issues'>[],
  known: Subtasks,
): Promise<string[]> {
  const held = new Set<string>()
  const meOf = (t: Doc<'issues'>) => seats.get(t.org_id)?.me.id ?? ''
  const open: Doc<'issues'>[] = []
  for (const t of taken) {
    if (!ownerSettled(t)) open.push(t)
    else if (ownedBy(t, false, meOf(t))) held.add(t.project_id)
  }
  const checking = open.filter((t) => !held.has(t.project_id))
  await groupCheck(ctx, guard, seats, checking, known)
  for (const t of checking)
    if (ownedBy(t, isGroupIn(known, t.id) === true, meOf(t))) held.add(t.project_id)
  return [...held].sort(order)
}

/* The ok answer of the Roadmap read `got`, with the parents, the subtasks
 * of group rows, the group facts and the rows out, and `rest`. */
async function roadmapAnswer(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  got: FilterResult,
  rest: Pick<
    Extract<RoadmapAnswer, { state: 'ok' }>,
    'remaining' | 'held_sub_projects' | 'projects'
  >,
): Promise<RoadmapAnswer> {
  const { rows, isGroup, subtasks: known } = got
  const parents = await shownParents(ctx, guard, seats, rows, got.read, ROADMAP.context)
  const rowIds = new Set(rows.map((t) => t.id))
  const parentIds = new Set(parents.map((t) => t.id))
  // every shown descendant of a group row, through nested groups stored
  // before the rule of one level, cycle-safe, that is neither a row nor a
  // parent; groupFacts read each group row's subtree already
  const shownKids = (id: string) =>
    (known.kids.get(id) ?? []).filter((kid) => known.shown.get(kid.id) === true)
  const groupRows = rows.filter((t) => isGroup(t) === true)
  const visited = new Set<string>()
  const stack = groupRows.flatMap((g) => shownKids(g.id))
  const subtasks: Doc<'issues'>[] = []
  for (let kid = stack.pop(); kid !== undefined; kid = stack.pop()) {
    if (visited.has(kid.id)) continue
    visited.add(kid.id)
    if (!rowIds.has(kid.id) && !parentIds.has(kid.id)) subtasks.push(kid)
    if (isGroupIn(known, kid.id) === true) stack.push(...shownKids(kid.id))
  }
  if (parents.length + subtasks.length > ROADMAP.context) throw new OverBudget()
  const nested = subtasks.filter((t) => isGroupIn(known, t.id) === true)
  await got.factsOf([...groupRows, ...parents, ...nested])
  const shownIds = new Set([...rowIds, ...parentIds, ...subtasks.map((t) => t.id)])
  const shown = (id: string) => shownIds.has(id)
  const out = (t: Doc<'issues'>) =>
    viewRow(t, shown, isGroupIn(known, t.id) === true ? (got.facts.get(t.id) ?? null) : null)
  return {
    state: 'ok',
    rows: rows.sort(byNumber).map(out),
    parents: parents.sort(byNumber).map(out),
    subtasks: subtasks.sort(byNumber).map(out),
    ...rest,
  }
}

// --- the dependency inputs ------------------------------------------------------------

/**
 * The dependency inputs of `scope` for the login whose seats are `profiles`:
 * the arrows' pairs between the selection's own tasks, and Auto-move's
 * inputs, the parts of the dependency graph that hold a selected task and a
 * link, whole, inside the selection and outside it.
 *
 * The graph's nodes are the tasks of the reader's working set that have a
 * span, as src/lib/schedule.ts autoMoves takes them, a task without
 * subtasks with a start week or a group with a scheduled shown leaf (its
 * GroupFacts span). Its edges are the blocks links between two nodes, and
 * each group's link to its shown subtasks that are nodes. A part is a
 * connected set of nodes. autoMoves over a part's tasks gives exactly the
 * moves it gives over every task the workspace holds within that part, as
 * parts share no task and the solver's pushes follow only edges. Parts with
 * no selected task are left out, so Auto-move no longer moves tasks with no
 * tie to the selection, an agent decision of 5 November 2026. No guide says
 * so yet, as the app's Auto-move still runs over every task the workspace
 * holds. The Roadmap view stage, whose brief carries it, states it in the
 * Roadmap guide when the view switches to this read.
 *
 * The selected tasks are a project selection's active tasks, every status,
 * or in My view those the person owns by the Reviewer rule, never the
 * filters or the window. The read takes them, their group checks and a
 * group's facts, and each one with a span's links (issue_links by_source
 * and by_target, two ranges, relates links dropped). Where that does not
 * fit DEPENDENCIES.reads it answers over_budget whole. Then the parts grow
 * outward through links, parents and subtasks. A task a link or a parent
 * names is read by id, counted at lib/limits.ts TASK_ROW_MAX_BYTES, and
 * kept only where the reader's working set holds it (lib/viewReads.ts
 * viewAccess holds), of the same organization; a kept task's group check,
 * facts and links follow. Past DEPENDENCIES.tasks tasks, or where the reads
 * stop, `auto_move` answers over_budget, never part of a part, and the
 * arrows' pairs stay. A link whose other end the reader is not shown adds
 * no pair and its end's id never leaves the server. Links join tasks of one
 * organization (model/links.ts), so a part never crosses seats.
 *
 * `unavailable` as readRoadmap answers it.
 */
export async function readDependencies(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: { scope: RoadmapScope },
): Promise<DependencyAnswer> {
  try {
    return await dependenciesOf(ctx, profiles, args.scope)
  } catch (e) {
    if (isOverBudget(e)) return { state: 'over_budget' }
    if (isAccessUnchecked(e))
      return { state: 'unavailable', reason: ACCESS_UNCHECKED, message: e.data.message }
    throw e
  }
}

/* The link rows of the tasks with ids `ids`, as source and as target, in
 * steps through the guard, each row counted at LINK_ROW_BYTES. */
function linkRanges(ctx: QueryCtx, ids: readonly string[]): StepRange<Doc<'issue_links'>>[] {
  return ids.flatMap((id): StepRange<Doc<'issue_links'>>[] => [
    {
      open: (from) =>
        ctx.db
          .query('issue_links')
          .withIndex('by_source', (q) =>
            from === undefined
              ? q.eq('source_id', id)
              : q.eq('source_id', id).gte('_creationTime', from),
          ),
    },
    {
      open: (from) =>
        ctx.db
          .query('issue_links')
          .withIndex('by_target', (q) =>
            from === undefined
              ? q.eq('target_id', id)
              : q.eq('target_id', id).gte('_creationTime', from),
          ),
    },
  ])
}

/* Links by creation time, then id, as src/lib/taskSections.ts linkViews
 * orders a task's links. */
const byCreation = (a: Doc<'issue_links'>, b: Doc<'issue_links'>) =>
  order(a.created_at, b.created_at) || order(a.id, b.id)

/* `link` as a pair, as a blocks link's source blocks its target. */
const pairOf = (link: Doc<'issue_links'>): DependencyPair => ({
  blocker: link.source_id,
  blocked: link.target_id,
})

/**
 * The dependency graph over `seats` as a read learns it, the tasks of the
 * reader's working set it read (`read`), which of them are groups and what
 * they show (`known`, `facts`), which are nodes, and the blocks links of
 * the nodes whose links it read.
 */
function dependencyGraph(ctx: QueryCtx, guard: ViewBudget, seats: ViewSeats) {
  const known = noSubtasks()
  const read = new Map<string, Doc<'issues'>>()
  const facts = new Map<string, GroupFacts>()
  // whether each task decided is a node
  const node = new Map<string, boolean>()
  // the ids read by id that are not in the working set
  const hidden = new Set<string>()
  // the blocks links read, and each task's links by id
  const links = new Map<string, Doc<'issue_links'>>()
  const linksOf = new Map<string, Set<string>>()
  const linked = new Set<string>()

  /* notes `tasks`, in the reader's working set */
  const take = (tasks: readonly Doc<'issues'>[]) => {
    for (const t of tasks) {
      read.set(t.id, t)
      known.shown.set(t.id, true)
      // an active task in a live project makes its parent a group
      if (t.parent_id !== undefined) known.parents.add(t.parent_id)
    }
  }

  /* reads each of `tasks`' group check, and a group's facts, and decides
   * which are nodes */
  const decide = async (tasks: readonly Doc<'issues'>[]) => {
    const fresh = [...new Map(tasks.filter((t) => !node.has(t.id)).map((t) => [t.id, t])).values()]
    for (let at = 0; at < fresh.length; at += STEP) {
      const step = fresh.slice(at, at + STEP)
      await groupCheck(ctx, guard, seats, step, known)
      const groups = step.filter((t) => isGroupIn(known, t.id) === true && !facts.has(t.id))
      if (groups.length > 0)
        for (const [id, got] of await groupFacts(ctx, guard, seats, groups, known))
          facts.set(id, got)
      for (const t of step)
        node.set(
          t.id,
          isGroupIn(known, t.id) === true
            ? facts.get(t.id)?.span.start_week !== undefined
            : t.start_week !== undefined,
        )
    }
  }

  /* reads the blocks links of `tasks`, nodes whose links are not read yet */
  const readLinks = async (tasks: readonly Doc<'issues'>[]) => {
    const ids = tasks.map((t) => t.id).filter((id) => !linked.has(id))
    for (const id of ids) linked.add(id)
    const charge = (row: Doc<'issue_links'>) => guard.charge(row, LINK_ROW_BYTES)
    for await (const step of inSteps(guard, linkRanges(ctx, ids), LINK_ROW, charge))
      for (const link of step) {
        if (link.type !== 'blocks') continue
        links.set(link.id, link)
        for (const end of [link.source_id, link.target_id])
          linksOf.set(end, (linksOf.get(end) ?? new Set()).add(link.id))
      }
  }

  /* the tasks with ids `ids` of organization `org`, read by id where the
   * read holds none, each counted at TASK_ROW_MAX_BYTES, those of the
   * reader's working set */
  const resolve = async (wanted: ReadonlyMap<string, string>): Promise<Doc<'issues'>[]> => {
    const out: Doc<'issues'>[] = []
    const ids: string[] = []
    for (const [id, org] of wanted) {
      const t = read.get(id)
      if (t !== undefined) {
        if (t.org_id === org) out.push(t)
      } else if (!hidden.has(id)) ids.push(id)
    }
    for (let at = 0; at < ids.length; ) {
      const step = ids.slice(at, at + (await guard.upTo(BY_ID, Math.min(STEP, ids.length - at))))
      at += step.length
      const found = await settled(step.map((id) => byId(ctx, 'issues', id)))
      const ours: Doc<'issues'>[] = []
      for (const [i, t] of found.entries()) {
        hidden.add(step[i])
        if (t === null) continue
        guard.charge(t, TASK_ROW_MAX_BYTES)
        if (t.org_id === wanted.get(step[i])) ours.push(t)
      }
      for (const [org, theirs] of groupBy(ours, (t) => t.org_id)) {
        const seat = seats.get(org)
        if (seat === undefined) continue
        const held = await seat.holds(theirs)
        const kept = theirs.filter((_, i) => held[i])
        for (const t of kept) hidden.delete(t.id)
        take(kept)
        out.push(...kept)
      }
    }
    return out
  }

  /* the shown subtasks of task `id`, once its group check is read */
  const shownKids = (id: string) =>
    (known.kids.get(id) ?? []).filter((kid) => known.shown.get(kid.id) === true)

  return {
    known,
    read,
    facts,
    links,
    take,
    decide,
    readLinks,
    resolve,
    /** Whether task `t` is a node, once decided. */
    isNode: (t: Doc<'issues'>) => node.get(t.id) === true,
    /** The tasks next to node `t`, the other ends of its links, its parent,
     * by id with their organization, and its shown subtasks. */
    near(t: Doc<'issues'>, ids: Map<string, string>, docs: Doc<'issues'>[]) {
      for (const linkId of linksOf.get(t.id) ?? []) {
        const link = links.get(linkId)
        if (link === undefined) continue
        ids.set(link.source_id === t.id ? link.target_id : link.source_id, t.org_id)
      }
      if (t.parent_id !== undefined) ids.set(t.parent_id, t.org_id)
      if (isGroupIn(known, t.id) === true) {
        const kids = shownKids(t.id)
        take(kids)
        docs.push(...kids)
      }
    },
  }
}

/* readDependencies' answer while it is ok. */
async function dependenciesOf(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  scope: RoadmapScope,
): Promise<DependencyAnswer> {
  const guard = viewBudget(ctx, DEPENDENCIES.reads)
  const at = await scoped(ctx, guard, profiles, scope, {})
  if (at === null) return UNAVAILABLE
  const { seats, selection } = at
  const graph = dependencyGraph(ctx, guard, seats)
  // the selected tasks, their group checks and facts, and the links of
  // those with a span
  const taken: Doc<'issues'>[] = []
  if (selection !== null)
    for await (const step of selectionTasks(ctx, guard, selection.subProjects)) {
      graph.take(step)
      taken.push(...step)
    }
  else
    for (const seat of seats.values())
      for await (const step of ownTasks(ctx, guard, seat, ISSUE_STATUSES)) {
        graph.take(step)
        taken.push(...step)
      }
  await graph.decide(taken)
  const selected =
    selection !== null
      ? taken
      : taken.filter((t) =>
          ownedBy(t, isGroupIn(graph.known, t.id) === true, seats.get(t.org_id)?.me.id ?? ''),
        )
  const roots = selected.filter((t) => graph.isNode(t))
  await graph.readLinks(roots)
  const rootIds = new Set(roots.map((t) => t.id))
  const pairs = [...graph.links.values()]
    .filter((link) => rootIds.has(link.source_id) && rootIds.has(link.target_id))
    .sort(byCreation)
    .map(pairOf)
  let auto_move: AutoMoveInputs | { state: 'over_budget' }
  try {
    auto_move = await partsOf(graph, seats, roots)
  } catch (e) {
    if (!isOverBudget(e)) throw e
    auto_move = { state: 'over_budget' }
  }
  return { state: 'ok', pairs, auto_move }
}

/* Auto-move's inputs, the parts of `graph` grown from `roots`, the selected
 * nodes, through links, parents and subtasks, those holding a link, past
 * DEPENDENCIES.tasks tasks OverBudget. */
async function partsOf(
  graph: ReturnType<typeof dependencyGraph>,
  seats: ViewSeats,
  roots: readonly Doc<'issues'>[],
): Promise<AutoMoveInputs> {
  const nodes = new Map(roots.map((t) => [t.id, t]))
  if (nodes.size > DEPENDENCIES.tasks) throw new OverBudget()
  let frontier: readonly Doc<'issues'>[] = roots
  while (frontier.length > 0) {
    const ids = new Map<string, string>()
    const docs: Doc<'issues'>[] = []
    for (const t of frontier) graph.near(t, ids, docs)
    for (const id of nodes.keys()) ids.delete(id)
    const candidates = [
      ...new Map(
        [...docs, ...(await graph.resolve(ids))]
          .filter((t) => !nodes.has(t.id))
          .map((t) => [t.id, t]),
      ).values(),
    ]
    await graph.decide(candidates)
    const next = candidates.filter((t) => graph.isNode(t))
    for (const t of next) nodes.set(t.id, t)
    if (nodes.size > DEPENDENCIES.tasks) throw new OverBudget()
    await graph.readLinks(next)
    frontier = next
  }
  // the parts, by union of each node with its parent and the ends of its
  // links, and those that hold a link
  const root = new Map<string, string>()
  const find = (id: string): string => {
    let at = id
    for (let up = root.get(at); up !== undefined && up !== at; up = root.get(at)) at = up
    root.set(id, at)
    return at
  }
  const join = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) root.set(ra, rb)
  }
  for (const id of nodes.keys()) root.set(id, id)
  for (const t of nodes.values())
    if (t.parent_id !== undefined && nodes.has(t.parent_id)) join(t.id, t.parent_id)
  const partLinks = [...graph.links.values()].filter(
    (link) => nodes.has(link.source_id) && nodes.has(link.target_id),
  )
  for (const link of partLinks) join(link.source_id, link.target_id)
  // every part holds a selected task, as the parts grew from them
  const withLink = new Set(partLinks.map((link) => find(link.source_id)))
  const kept = [...nodes.values()].filter((t) => withLink.has(find(t.id)))
  const keptIds = new Set(kept.map((t) => t.id))
  const shown = (id: string) => keptIds.has(id)
  // the projects of the kept tasks the reader may edit
  const editable: string[] = []
  for (const [org, theirs] of groupBy(kept, (t) => t.org_id)) {
    const seat = seats.get(org)
    if (seat === undefined) continue
    const projects = [...new Set(theirs.map((t) => t.project_id))]
    const levels = await seat.levels(projects)
    for (const [i, id] of projects.entries())
      if (levels[i] === 'lead' || levels[i] === 'user') editable.push(id)
  }
  return {
    state: 'ok',
    tasks: kept.sort(byNumber).map((t) => {
      const row = viewRow(
        t,
        shown,
        isGroupIn(graph.known, t.id) === true ? (graph.facts.get(t.id) ?? null) : null,
      )
      return {
        id: row.id,
        org_id: row.org_id,
        project_id: row.project_id,
        num: row.num,
        status: row.status,
        ...(row.start_week === undefined ? {} : { start_week: row.start_week }),
        ...(row.end_week === undefined ? {} : { end_week: row.end_week }),
        ...(row.parent_id === undefined ? {} : { parent_id: row.parent_id }),
        has_subtasks: row.has_subtasks,
        ...(row.span === undefined ? {} : { span: row.span }),
      }
    }),
    pairs: partLinks
      .filter((link) => keptIds.has(link.source_id))
      .sort(byCreation)
      .map(pairOf),
    editable_projects: editable.sort(order),
  }
}
