/* The Board's read behind tasks.ts board: one Board selection with the app's
 * filter row applied on the server, within the Board's budgets (BOARD) and
 * its ceiling of BOARD.ceiling matching tasks, lib/limits.ts BOARD_TASKS. It
 * reads through the shared view reader (lib/viewReads.ts) and the filter
 * row's read the Board shares with the Roadmap (lib/viewFilters.ts
 * filterRead, the filters as the app's passesFilters applies them in
 * src/store/planner.ts, and the order its search reads in), and holds the
 * Board's own rules, which passing tasks are rows under Stale and Focus,
 * the ceiling, the lanes that stay without cards, and its states.
 *
 * A selection is a top-level project with its visible live sub-projects, one
 * sub-project, or My view, the person's own tasks across every seat of the
 * login, read through their assignee and reviewer ranges and never by
 * reading projects. There is no all-projects selection. The Board holds
 * only tasks of the reader's working set (lib/workingSet.ts). Admin status
 * adds nothing beyond what lib/access.ts accessOf answers.
 *
 * Under Focus a group whose stored status is Backlog or Done is no row,
 * though the app's passesFilters keeps every group: no surface shows one
 * then, as the phone list places each task in the section of its stored
 * status and hides Backlog and Done (src/components/MobileWorkspace.tsx
 * MobileTaskList), and the desktop shows a group only as the heading of its
 * cards, which `parents` holds whatever its status. So Focus reads only the
 * To do, In progress and In review tasks.
 *
 * The ceiling counts matching tasks without subtasks, each subtask
 * included, across the whole selection: the desktop Board shows them as
 * cards, and a parent heading repeats in each cell as context without
 * adding to the counts (design specification section 4). A matching group,
 * which the phone list shows as a row, and each shown parent count toward
 * BOARD.reads and BOARD.context instead. More than BOARD.ceiling is claimed
 * only once the reads found BOARD.ceiling + 1 of them; a budget reached
 * first answers over_budget, and no answer holds part of a Board. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ACCESS_UNCHECKED, isAccessUnchecked } from './access'
import { ISSUE_STATUSES, type IssuePriority, type IssueStatus } from './enums'
import { BOARD_TASKS, MIB } from './limits'
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
  FOCUS_STATUSES,
  isOverBudget,
  OverBudget,
  ownTasks,
  projectSelection,
  type Selection,
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

/** The Board's search reads a label assignment at this fixed size
 * (lib/viewFilters.ts), re-exported where tests/rowBounds.test.ts checks
 * it. */
export { LABEL_ASSIGNMENT_BYTES } from './viewFilters'

/** The Board's budgets, which tests lower and set back with
 * structuredClone.
 *
 * `reads` caps the request's reads as Convex counts them, the reader's own
 * access rows included (lib/viewReads.ts viewBudget), and keeps 4 MiB,
 * 8,000 documents and 496 index ranges under Convex's 16 MiB, 32,000 and
 * 4,096 for what one step reads past the guard's last look.
 * tests/board.test.ts ("real limits") logs what each case reads under
 * convex-test's transaction limits, with rows as the app writes them, each
 * task with its creator, reporter and status stamp and each team share and
 * membership with its copy of a name key, in ordinary text. Its cases are a
 * project at its design size, under Focus too, My view over two seats, the
 * largest My view the ceiling allows and a search over a project's 800 open
 * tasks, and each reads inside these budgets. On 31 October 2026 a real
 * backend, with rows the app's own writers made, read the bytes the tests
 * of that day measured, at ordinary text and at the text caps.
 *
 * An organization admin's Board read costs the same as a standard user's
 * with the same rows.
 *
 * Each task the filters keep costs about one range, its group check, and a
 * group one more for its subtasks. The subtasks of a shown group that the
 * filters drop cost nothing more where the group or the subtask was created
 * under the rule of one level (lib/viewReads.ts ONE_LEVEL_SINCE); data
 * stored before it gets a check of each such subtask, which a legacy nested
 * group may be, a range each, and the largest My view, whose fixture data
 * predates the rule, comes closest to `reads.ranges`, and at its ranges a
 * card the ceiling stops such a Board before its ranges run out.
 *
 * Bytes stop a selection whose tasks a filter must read whole: the search,
 * the people filter, Priority and Stale read every task of the selection's
 * ranges before they drop any (`take`), where My tasks and Focus read only
 * their own ranges. At the design size each fits with room to spare, the
 * search over a project's 800 open tasks above included. Past it, a
 * selection of thousands of tasks or candidates with long texts reaches the
 * budget, and a filter that keeps subtasks under many parents sooner, as it
 * reads each such parent's subtasks again. Each answers over_budget, and
 * the owner chose on 31 October 2026 that the Board then asks the person to
 * narrow. The tests reach those answers by lowering `reads`.
 *
 * `context` caps the groups among the rows and the shown parents together,
 * the rows a Board holds beside its BOARD.ceiling cards. They count in
 * `reads` already, so this bounds what the browser keeps: 2,000 rows at up
 * to about 1.6 KB of JSON, about 3.2 MB, so 1,000 cards under 1,000 parents
 * still fit. `owners` caps the ids the people filter may name, the design
 * size's 1,000 people. `labelTasks` is how many candidates of one
 * organization a search reads labels for through their own rows, a range
 * each, before it tries each label that can finish their matches by its
 * assignments, many to a range, and `labelScan` how many assignments a
 * candidate that try reads before it goes back to the own rows, as a label
 * may be on thousands of other tasks (lib/viewFilters.ts filterSearch).
 * `ceiling` is the most matching tasks without subtasks a Board answers,
 * lib/limits.ts BOARD_TASKS, which the app reads too; tests lower it here
 * alone. */
export const BOARD = {
  reads: { bytes: 12 * MIB, documents: 24_000, ranges: 3_600 },
  context: 2000,
  owners: 1000,
  labelTasks: 64,
  labelScan: 4,
  ceiling: BOARD_TASKS,
}

/** A Board selection: a project of one organization, a top-level project
 * or a sub-project, or My view. */
export type BoardScope = { kind: 'project'; org_id: string; project_id: string } | { kind: 'mine' }

/** The app's filter row (src/store/planner.ts IssueFilters), as the Board
 * sends it. */
export type BoardFilters = {
  /** the My tasks toggle; in My view the person is the selection, so it
   * adds nothing */
  mine: boolean
  /** the people filter, matched against each task's owner by the Reviewer
   * rule (lib/review.ts taskOwnerId), at most BOARD.owners ids */
  owners: string[]
  priority: IssuePriority | null
  /** an ISO instant; a task not Done whose newest activity is before it is
   * stale, null when the Stale filter is off */
  stale_before: string | null
  focus: boolean
  /** at most LIMITS.search characters, trimmed here, so whitespace alone is
   * no filter, also not for the lanes a filter Clear clears drops
   * (heldLanes). The app trims it before that test and before sending
   * (src/views/board/boardArgs.ts). */
  search: string
}

/** What tasks.ts board answers. */
export type BoardAnswer =
  | {
      state: 'ok'
      /** every matching task, groups included, by number, then
       * organization and id; under Focus not a group whose stored status
       * is Backlog or Done (see the header). The answer holds no list of
       * owners: each row carries its organization, assignee, reviewer,
       * status and has_subtasks, from which lib/review.ts taskOwnerId gives
       * its owner for planning.ownerLoads, an organization at a time. */
      rows: ViewRow[]
      /** the shown ancestors of rows that are not rows themselves, in that
       * order */
      parents: ViewRow[]
      /** the projects whose lanes stay on the Board without cards (heldLanes) */
      held_projects: string[]
      /** a project selection's sub-projects, to narrow to */
      projects?: string[]
    }
  | { state: 'over_ceiling'; ceiling: number; projects?: string[] }
  | { state: 'over_budget'; projects?: string[] }
  | { state: 'unavailable'; reason?: typeof ACCESS_UNCHECKED; message?: string }

/** What the Board answers for a selection it does not hold, alike for every
 * reason. */
const UNAVAILABLE = { state: 'unavailable' as const }

/**
 * The Board of `scope` with `filters` for the login whose seats are
 * `profiles`, by organization:
 *
 * - `ok` with every matching task (`rows`), the shown parents above them
 *   (`parents`), the lanes that stay without cards (`held_projects`) and,
 *   for a project selection, its sub-projects (`projects`);
 * - `over_ceiling` once BOARD.ceiling + 1 matching tasks without subtasks
 *   were found, whatever the budget says after;
 * - `over_budget` when the reads reach BOARD.reads before the count is
 *   known, or the groups and parents pass BOARD.context;
 * - `unavailable`, alike for every reason, for a project selection the
 *   login holds no seat in, or that names no selection
 *   (lib/viewReads.ts projectSelection); and with `reason` and its sentence,
 *   which names nothing about the project, where a bound of the reader's
 *   own access reads stopped a check (lib/access.ts accessUnchecked,
 *   roomSpent alike, as a Board cannot ask about fewer projects). That is
 *   never answered as no access, and never as a smaller Board.
 *
 * Refuses more than BOARD.owners owners, a search past LIMITS.search and a
 * stale_before that is not an instant (lib/viewFilters.ts filtersOf).
 */
export async function readBoard(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: { scope: BoardScope; filters: BoardFilters },
): Promise<BoardAnswer> {
  const f = filtersOf(args.filters, BOARD.owners)
  // a project selection's sub-projects, once known
  const known: { projects?: string[] } = {}
  try {
    return await boardOf(ctx, profiles, args.scope, f, known)
  } catch (e) {
    const projects = known.projects === undefined ? {} : { projects: known.projects }
    if (e instanceof OverCeiling)
      return { state: 'over_ceiling', ceiling: BOARD.ceiling, ...projects }
    if (isOverBudget(e)) return { state: 'over_budget', ...projects }
    if (isAccessUnchecked(e))
      return { state: 'unavailable', reason: ACCESS_UNCHECKED, message: e.data.message }
    throw e
  }
}

/**
 * The Board's rule over the tasks that pass the filter row
 * (lib/viewFilters.ts filterRead). Under Stale, a task without subtasks is
 * a row when it is not Done, and a group when it is not done by its group
 * facts and its newest activity, its own and its shown descendants', is
 * before the cutoff, as the app's isStale and isDone combine; every other
 * passing task is a row. The ceiling counts the rows without subtasks.
 */
const boardRule = (f: Filters): RowRule => ({
  facts: f.staleBefore !== null,
  row: (t, group, facts) => {
    if (f.staleBefore === null) return true
    return group
      ? facts !== undefined && !facts.done && facts.newest < f.staleBefore
      : t.status !== 'done'
  },
  counts: (_t, group) => !group,
  ceiling: BOARD.ceiling,
})

/* readBoard's answer while it is ok, its selection named in `known`. */
async function boardOf(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  scope: BoardScope,
  f: Filters,
  known: { projects?: string[] },
): Promise<BoardAnswer> {
  const guard = viewBudget(ctx, BOARD.reads)
  const statuses = f.focus ? FOCUS_STATUSES : undefined
  const rule = boardRule(f)
  if (scope.kind === 'project') {
    const me = profiles.get(scope.org_id)
    if (me === undefined) return UNAVAILABLE
    const seat = viewAccess(ctx, guard, me)
    const selection = await projectSelection(ctx, guard, seat, scope.project_id)
    if (selection === null) return UNAVAILABLE
    known.projects = selection.subProjects.map((p) => p.id)
    const ids = new Set(known.projects)
    const seats = new Map([[me.org_id, seat]])
    // My tasks reads the person's own ranges and keeps those of the
    // selection; every other filter reads the selection's ranges whole
    const board = filterRead(ctx, guard, seats, f, {
      mine: f.mine,
      whole: !f.mine && !f.focus,
      rule,
      limits: BOARD,
    })
    await board.take(
      f.mine
        ? ownTasks(ctx, guard, seat, statuses ?? ISSUE_STATUSES)
        : selectionTasks(ctx, guard, selection.subProjects, statuses),
      (t) => ids.has(t.project_id),
    )
    return await boardAnswer(ctx, guard, seats, f, await board.finish(), { selection })
  }
  const seats = new Map(
    [...profiles.values()].map((me): [string, ViewAccess] => [
      me.org_id,
      viewAccess(ctx, guard, me),
    ]),
  )
  const board = filterRead(ctx, guard, seats, f, { mine: true, whole: false, rule, limits: BOARD })
  for (const seat of seats.values())
    await board.take(ownTasks(ctx, guard, seat, statuses ?? ISSUE_STATUSES))
  return await boardAnswer(ctx, guard, seats, f, await board.finish(), { seats })
}

/* The ok answer of the Board read `got`, with the parents, the group facts
 * and the lanes. `selection` for a project selection, `seats` for My view. */
async function boardAnswer(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  f: Filters,
  got: FilterResult,
  at: { selection: Selection } | { seats: ViewSeats },
): Promise<BoardAnswer> {
  const { rows: list, isGroup } = got
  const groups = list.filter((t) => isGroup(t))
  if (groups.length > BOARD.context) throw new OverBudget()
  const parents = await shownParents(
    ctx,
    guard,
    seats,
    list,
    got.read,
    BOARD.context - groups.length,
  )
  await got.factsOf([...groups, ...parents])
  const held = await heldLanes(ctx, guard, f, list, isGroup, at)
  const shownIds = new Set([...list.map((t) => t.id), ...parents.map((p) => p.id)])
  const shown = (id: string) => shownIds.has(id)
  const out = (t: Doc<'issues'>) =>
    viewRow(t, shown, isGroup(t) === true ? (got.facts.get(t.id) ?? null) : null)
  return {
    state: 'ok',
    rows: list.sort(byNumber).map(out),
    parents: parents.sort(byNumber).map(out),
    held_projects: held,
    ...('selection' in at ? { projects: at.selection.subProjects.map((p) => p.id) } : {}),
  }
}

/**
 * The projects whose lanes the Board keeps without a card, as the app kept a
 * lane, a side-board or in My view a top-level project for a group whose
 * scope holds a task when it showed its own result before the answer
 * (src/views/board/useBoardView.ts takes them from here alone), unless a filter the
 * Clear button clears is on (clearable: My tasks outside My view, people,
 * priority, Stale or a search) and drops a lane without cards. With such a
 * filter they are the projects of the cards; without one, every scoped task
 * is a row, so they are the projects of the rows, and Focus alone, which
 * hides Backlog and Done, adds the selection's sub-projects that hold any
 * active task (one by_project_archived range and one document each), or in
 * My view the top-level projects of the person's Backlog and Done tasks
 * (their assignee ranges, where the assignee is the owner). A project
 * selection answers its sub-projects in its order, My view its top-level
 * projects by id. Owner lanes come from the rows (the coordinator's answer
 * of 2026-10-31), so a person whose only scoped tasks Focus hides gets no
 * lane.
 */
async function heldLanes(
  ctx: QueryCtx,
  guard: ViewBudget,
  f: Filters,
  rows: readonly Doc<'issues'>[],
  isGroup: (t: Doc<'issues'>) => boolean | undefined,
  at: { selection: Selection } | { seats: ViewSeats },
): Promise<string[]> {
  const clearable =
    ('selection' in at && f.mine) ||
    f.owners.size > 0 ||
    f.priority !== null ||
    f.staleBefore !== null ||
    f.search !== ''
  const counted = rows.filter((t) => !clearable || isGroup(t) !== true)
  if ('selection' in at) {
    const held = new Set(counted.map((t) => t.project_id))
    if (!clearable && f.focus) {
      const empty = at.selection.subProjects.filter((p) => !held.has(p.id))
      for (let i = 0; i < empty.length; ) {
        const step = empty.slice(i, i + (await guard.upTo(BY_ID, Math.min(STEP, empty.length - i))))
        i += step.length
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
        for (const [j, first] of firsts.entries()) if (first !== null) held.add(step[j].id)
      }
    }
    return at.selection.subProjects.map((p) => p.id).filter((id) => held.has(id))
  }
  const held = new Set<string>()
  /* adds the top-level project of each of `tasks`, tasks of sub-projects */
  const hold = async (tasks: readonly Doc<'issues'>[]) => {
    for (const t of tasks) {
      const parent = (await at.seats.get(t.org_id)?.project(t.project_id))?.parent_id
      if (parent !== undefined) held.add(parent)
    }
  }
  await hold(counted)
  if (!clearable && f.focus) {
    const hidden: IssueStatus[] = ['backlog', 'done']
    for (const seat of at.seats.values())
      for await (const step of ownTasks(ctx, guard, seat, hidden, false)) await hold(step)
  }
  return [...held].sort(order)
}
