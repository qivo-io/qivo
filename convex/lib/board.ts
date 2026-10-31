/* The Board's read behind tasks.ts board: one Board selection with the app's
 * filter row applied on the server, within the Board's budgets (BOARD) and
 * its ceiling of lib/limits.ts BOARD_TASKS matching tasks. It reads through
 * the shared view reader (lib/viewReads.ts) and holds the Board's own
 * rules: the filters as the app's passesFilters applies them
 * (src/store/planner.ts), the order its search reads in, the ceiling, the
 * lanes that stay without cards, and its states.
 *
 * A selection is a top-level project with its visible live sub-projects, one
 * sub-project, or My view, the person's own tasks across every seat of the
 * login, read through their assignee and reviewer ranges and never by
 * reading projects. There is no all-projects selection. The Board holds
 * only tasks of the reader's working set (lib/workingSet.ts). Admin status
 * adds nothing beyond what lib/access.ts accessOf answers.
 *
 * The ceiling counts matching tasks without subtasks, each subtask
 * included, across the whole selection: the desktop Board shows them as
 * cards, and a parent heading repeats in each cell as context without
 * adding to the counts (design specification section 4). A matching group,
 * which the phone list shows as a row, and each shown parent count toward
 * BOARD.reads and BOARD.context instead. More than BOARD_TASKS is claimed
 * only once the reads found BOARD_TASKS + 1 of them; a budget reached first
 * answers over_budget, and no answer holds part of a Board. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { descriptionsOf, projectTextReader, type RangeStep } from '../model/descriptions'
import { ACCESS_UNCHECKED, isAccessUnchecked } from './access'
import { labelNamesOf, markedLabelNamesOf, TEXT_TASK_READS } from './core'
import { byId } from './db'
import { ISSUE_STATUSES, type IssuePriority, type IssueStatus } from './enums'
import { badRequest } from './functions'
import { limitedText } from './limitRules'
import { BOARD_TASKS, LIMITS, MIB, TEAM_ROW_MAX_BYTES } from './limits'
import { taskOwnerId } from './review'
import { allWordsMatcher, searchPieces, taskSearchText } from './search'
import { issueKey, STATUS_NAMES } from './taskRefs'
import {
  BY_ID,
  FOCUS_STATUSES,
  type GroupFacts,
  groupBy,
  groupCheck,
  groupFacts,
  inSteps,
  isGroupIn,
  isOverBudget,
  noSubtasks,
  OverBudget,
  ownerSettled,
  ownTasks,
  projectSelection,
  type Reads,
  type Selection,
  type StepRange,
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

/** The Board's budgets, which tests lower and set back with
 * structuredClone.
 *
 * `reads` caps the request's reads as Convex counts them, the reader's own
 * access rows included (lib/viewReads.ts viewBudget), and keeps 4 MiB,
 * 8,000 documents and 496 index ranges under Convex's 16 MiB, 32,000 and
 * 4,096 for what one step reads past the guard's last look. Measured under
 * convex-test's transaction limits with titles at the cap in a three-byte
 * script and description rows at the cap (tests/board.test.ts, real
 * limits), in ranges, documents and MiB:
 *
 * - 1,000 tasks of one sub-project: 1,020, 1,018 and 1.08; 1,001 stop at
 *   the ceiling after about as much.
 * - 1,000 tasks over 200 sub-projects of one project: 1,239, 1,208 and
 *   1.14, under Focus 1,241.
 * - 1,000 tasks under 50 groups: 1,071, 2,069 and 2.29.
 * - My view of 600 and 400 tasks in two seats: 1,035, 1,021 and 1.13.
 * - The envelope's largest Board, 1,000 subtasks under 1,000 parents over
 *   200 sub-projects, each shared with each of the person's 25 teams: 2,476,
 *   9,289 and 4.35, with or without Focus, the 5,000 shares about 6,300 of
 *   those documents.
 * - A search over 5,000 tasks of 390-character texts, the measured
 *   average: 213, 10,159 and 4.69.
 *
 * Each task the filters keep costs about one range, its group check, and a
 * group one more for its subtasks, so ranges run out first, at about 1,500
 * cards under as many parents; the ceiling comes well before. A search
 * whose candidates hold texts near the cap does not fit and answers
 * over_budget, as does the people filter over a selection of about 11,000
 * tasks at the title cap, whose rows the filter must read.
 *
 * `context` caps the groups among the rows and the shown parents together,
 * the rows a Board holds beside its BOARD_TASKS cards. They count in
 * `reads` already, so this bounds what the browser keeps: 2,000 rows at up
 * to about 1.6 KB of JSON, about 3.2 MB, so 1,000 cards under 1,000 parents
 * still fit. `owners` caps the ids the people filter may name, the
 * envelope's 1,000 people. `labelTasks` is how many candidates of one
 * organization a search reads labels for through their own rows, a range
 * each, before it reads each label that can finish their matches by its
 * assignments instead, many to a range (boardSearch). */
export const BOARD = {
  reads: { bytes: 12 * MIB, documents: 24_000, ranges: 3_600 },
  context: 2000,
  owners: 1000,
  labelTasks: 500,
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
  /** at most LIMITS.search characters */
  search: string
}

/** What tasks.ts board answers. */
export type BoardAnswer =
  | {
      state: 'ok'
      /** every matching task, groups included, by number, then
       * organization and id. The answer holds no list of owners: each row
       * carries its organization, assignee, reviewer, status and
       * has_subtasks, from which lib/review.ts taskOwnerId gives its owner
       * for planning.ownerLoads, an organization at a time. */
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

/** The filters as the read applies them. */
type Filters = {
  mine: boolean
  owners: ReadonlySet<string>
  priority: IssuePriority | null
  /** stale_before in ms */
  staleBefore: number | null
  focus: boolean
  /** trimmed, '' for none */
  search: string
}

/** The filters of `f`, refused past BOARD.owners ids, past LIMITS.search
 * characters (code `rule`) or with a stale_before Date.parse cannot read. */
function filtersOf(f: BoardFilters): Filters {
  if (f.owners.length > BOARD.owners)
    throw badRequest(`the people filter names at most ${BOARD.owners} people; choose fewer`)
  let staleBefore: number | null = null
  if (f.stale_before !== null) {
    staleBefore = Date.parse(f.stale_before)
    if (Number.isNaN(staleBefore)) throw badRequest('stale_before must be an ISO date and time')
  }
  return {
    mine: f.mine,
    owners: new Set(f.owners),
    priority: f.priority,
    staleBefore,
    focus: f.focus,
    search: limitedText(LIMITS.search, f.search),
  }
}

/** What the read throws once it found BOARD_TASKS + 1 matching tasks. */
class OverCeiling extends Error {}

/**
 * The Board of `scope` with `filters` for the login whose seats are
 * `profiles`, by organization:
 *
 * - `ok` with every matching task (`rows`), the shown parents above them
 *   (`parents`), the lanes that stay without cards (`held_projects`) and,
 *   for a project selection, its sub-projects (`projects`);
 * - `over_ceiling` once BOARD_TASKS + 1 matching tasks without subtasks
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
 * stale_before that is not an instant (filtersOf).
 */
export async function readBoard(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: { scope: BoardScope; filters: BoardFilters },
): Promise<BoardAnswer> {
  const f = filtersOf(args.filters)
  // a project selection's sub-projects, once known
  const known: { projects?: string[] } = {}
  try {
    return await boardOf(ctx, profiles, args.scope, f, known)
  } catch (e) {
    const projects = known.projects === undefined ? {} : { projects: known.projects }
    if (e instanceof OverCeiling)
      return { state: 'over_ceiling', ceiling: BOARD_TASKS, ...projects }
    if (isOverBudget(e)) return { state: 'over_budget', ...projects }
    if (isAccessUnchecked(e))
      return { state: 'unavailable', reason: ACCESS_UNCHECKED, message: e.data.message }
    throw e
  }
}

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
  if (scope.kind === 'project') {
    const me = profiles.get(scope.org_id)
    if (me === undefined) return UNAVAILABLE
    const seat = viewAccess(ctx, guard, me)
    const selection = await projectSelection(ctx, guard, seat, scope.project_id)
    if (selection === null) return UNAVAILABLE
    known.projects = selection.subProjects.map((p) => p.id)
    const ids = new Set(known.projects)
    // My tasks reads the person's own ranges and keeps those of the
    // selection; every other filter reads the selection's ranges whole
    const board = boardRead(ctx, guard, new Map([[me.org_id, seat]]), f, {
      mine: f.mine,
      whole: !f.mine && !f.focus,
    })
    await board.take(
      f.mine
        ? ownTasks(ctx, guard, seat, statuses ?? ISSUE_STATUSES)
        : selectionTasks(ctx, guard, selection.subProjects, statuses),
      (t) => ids.has(t.project_id),
    )
    return await board.answer({ selection })
  }
  const seats = new Map(
    [...profiles.values()].map((me): [string, ViewAccess] => [
      me.org_id,
      viewAccess(ctx, guard, me),
    ]),
  )
  const board = boardRead(ctx, guard, seats, f, { mine: true, whole: false })
  for (const seat of seats.values())
    await board.take(ownTasks(ctx, guard, seat, statuses ?? ISSUE_STATUSES))
  return await board.answer({ seats })
}

/** How many tasks one step of the filters, a group check or a search read
 * settles at once, so the count is known after each step. */
const STEP = 64

/** A label row or a label assignment, as a read keeps room for it: smaller
 * than a team row (lib/limits.ts TEAM_ROW_MAX_BYTES), as a label holds a
 * name of at most 40 characters and an assignment three ids and a window
 * key. */
const LABEL_ROW: Reads = { bytes: TEAM_ROW_MAX_BYTES, documents: 1, ranges: 0 }

/** What one task's label read takes at most: one range and LIMITS.labels.max
 * assignments (lib/core.ts markedLabelNamesOf), or one (labelNamesOf). */
const LABEL_TASK: Reads = {
  bytes: LIMITS.labels.max * LABEL_ROW.bytes,
  documents: LIMITS.labels.max,
  ranges: 1,
}

/** The most a label assignment row takes, as Convex counts a document: an
 * organization, a task and a label id, the task's window key and the
 * archive mark, 236 bytes measured (tests/rowBounds.test.ts). A search that reads a label's
 * assignments, those of tasks the reader cannot see among them, counts each
 * at this size, so their contents move no answer. */
export const LABEL_ASSIGNMENT_BYTES = 512

/** One label assignment read in a label's range. */
const ASSIGNMENT: Reads = { bytes: LABEL_ASSIGNMENT_BYTES, documents: 1, ranges: 0 }

/** How many assignments one step of a label's range asks for. */
const ASSIGNMENTS_PER_STEP = 256

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/* Tasks by number, then organization and id, as src/store/taskIndex.ts
 * orders the store's tasks. */
const byNumber = (a: Doc<'issues'>, b: Doc<'issues'>) =>
  a.num - b.num || order(a.org_id, b.org_id) || order(a.id, b.id)

/** A search candidate and what the search has read about it: the
 * assignee's name (null for none), the text and the names of the labels
 * that hold a piece of the search. */
type Candidate = {
  task: Doc<'issues'>
  name?: string | null
  text?: string
  labels?: readonly string[]
}

/** What a candidate's search needs read next. */
type Need = 'group' | 'name' | 'text' | 'labels'

/**
 * One Board read over `seats`: it takes the selection's tasks in steps
 * (take), applies the filters to each as it comes and counts the matches,
 * and then reads what the rows show (answer).
 *
 * The filters run in the app's order of cost. Priority and Stale's recent
 * activity need nothing more than the row. The owner of a task needs its
 * group fact only In Review with a reviewer other than its assignee
 * (lib/viewReads.ts ownerSettled), and the Stale filter of a task whose own
 * row is old needs it too, and for a group its subtree (GroupFacts). Every
 * task that passes them gets its group check, which tells a task without
 * subtasks, the one the ceiling counts.
 *
 * With a search, each task that passes the other filters settles in this
 * order, tested again after each step (lib/search.ts taskSearchText, as the
 * app's matchesSearch builds it): its own fields, with the status name only
 * where its group fact is known or no piece of the search occurs in a status
 * name, as lib/archivedTasks.ts archivedTaskMatcher decides; its group check
 * where a status name would decide it; its assignee's name, each profile
 * read once; its text; and the names of its labels that hold a piece of the
 * search. Only the tasks that match get their group check, so a search over
 * thousands of tasks does not read a range each for them. Texts come before
 * labels, the reverse of lib/core.ts searchedTexts, because a Board reads a
 * task's labels through its own rows, a range a task, where many texts come
 * many to a range; lib/archivedTasks.ts archivedTaskMatcher reads them in
 * the same order.
 */
function boardRead(
  ctx: QueryCtx,
  guard: ViewBudget,
  seats: ViewSeats,
  f: Filters,
  o: {
    /** whether a task must belong to the seat's person (My tasks, My view) */
    mine: boolean
    /** whether the read takes its projects' active tasks whole, so it knows
     * how many each holds */
    whole: boolean
  },
) {
  const subtasks = noSubtasks()
  // the tasks the read took, all in the reader's working set
  const read = new Map<string, Doc<'issues'>>()
  // how many active tasks each project holds, when the read takes them whole
  const sizes = new Map<string, number>()
  const rows = new Map<string, Doc<'issues'>>()
  const facts = new Map<string, GroupFacts>()
  let cards = 0
  const isGroup = (t: Doc<'issues'>) => isGroupIn(subtasks, t.id)
  const seatOf = (t: Doc<'issues'>): ViewAccess => {
    const seat = seats.get(t.org_id)
    if (seat === undefined) throw new Error('a Board read a task without its seat')
    return seat
  }

  /* whether `t`'s owner passes My tasks, My view and the people filter */
  const ownerPasses = (t: Doc<'issues'>, group: boolean) => {
    const owner = taskOwnerId(t, group)
    if (o.mine && owner !== seatOf(t).me.id) return false
    return f.owners.size === 0 || (owner !== undefined && f.owners.has(owner))
  }
  /* whether `t` may pass the filters, as far as its row tells: Priority,
   * Stale's recent activity, which a group's newest descendant never makes
   * older, and an owner the group fact does not change */
  const cheap = (t: Doc<'issues'>) =>
    (f.priority === null || t.priority === f.priority) &&
    (f.staleBefore === null || Date.parse(t.updated_at) < f.staleBefore) &&
    (!ownerSettled(t) || ownerPasses(t, false))

  /* the group facts of `groups`, each read once */
  const factsOf = async (groups: readonly Doc<'issues'>[]) => {
    const fresh = groups.filter((g) => !facts.has(g.id))
    if (fresh.length === 0) return
    for (const [id, got] of await groupFacts(ctx, guard, seats, fresh, subtasks)) facts.set(id, got)
  }

  /* keeps the tasks of `tasks`, which passed `cheap` (and match the search),
   * that pass every filter once their group facts are read, and counts the
   * cards among them, a step at a time */
  const decide = async (tasks: readonly Doc<'issues'>[]) => {
    for (let at = 0; at < tasks.length; at += STEP) {
      const step = tasks.slice(at, at + STEP).filter((t) => !rows.has(t.id))
      await groupCheck(ctx, guard, seats, step, subtasks)
      const pass = step.filter((t) => ownerPasses(t, isGroup(t) === true))
      // Stale on a group reads its subtree, as isStale and isDone combine
      if (f.staleBefore !== null) await factsOf(pass.filter((t) => isGroup(t)))
      for (const t of pass) {
        const group = isGroup(t) === true
        if (f.staleBefore !== null) {
          const g = facts.get(t.id)
          const stale = group
            ? g !== undefined && !g.done && g.newest < f.staleBefore
            : t.status !== 'done'
          if (!stale) continue
        }
        rows.set(t.id, t)
        if (!group && ++cards > BOARD_TASKS) throw new OverCeiling()
      }
    }
  }

  const search = f.search === '' ? null : boardSearch(ctx, guard, f.search, subtasks, sizes, seats)
  // the tasks taken that wait for their group checks
  const pending: Doc<'issues'>[] = []

  return {
    /** Takes the tasks `batches` yields, each in the reader's working set,
     * and applies the filters to those `keep` holds: those their rows tell
     * as they come, and the rest, which need group checks, once more than
     * BOARD_TASKS wait, so the read can stop at the ceiling. */
    async take(
      batches: AsyncIterable<Doc<'issues'>[]>,
      keep: (t: Doc<'issues'>) => boolean = () => true,
    ): Promise<void> {
      for await (const batch of batches) {
        for (const t of batch) {
          read.set(t.id, t)
          if (o.whole) sizes.set(t.project_id, (sizes.get(t.project_id) ?? 0) + 1)
          // an active task in a live project makes its parent a group, and
          // the reader is shown it
          if (t.parent_id !== undefined) subtasks.parents.add(t.parent_id)
          subtasks.shown.set(t.id, true)
        }
        const passing = batch.filter((t) => keep(t) && cheap(t))
        pending.push(...(search === null ? passing : search.add(passing)))
        // the group checks wait until a ceiling's worth of tasks does, so a
        // parent whose subtasks the selection holds is known as one first
        if (pending.length > BOARD_TASKS) await decide(pending.splice(0))
      }
    },

    /** The ok answer, once every task was taken: the rest of the search,
     * then the parents, the group facts and the lanes. `selection` for a
     * project selection, `seats` for My view. */
    async answer(at: { selection: Selection } | { seats: ViewSeats }): Promise<BoardAnswer> {
      await decide(pending.splice(0))
      if (search !== null) await search.finish(decide)
      const list = [...rows.values()]
      const groups = list.filter((t) => isGroup(t))
      if (groups.length > BOARD.context) throw new OverBudget()
      const parents = await shownParents(
        ctx,
        guard,
        seats,
        list,
        read,
        BOARD.context - groups.length,
      )
      await factsOf([...groups, ...parents])
      const held = await heldLanes(ctx, guard, f, list, isGroup, at)
      const shownIds = new Set([...rows.keys(), ...parents.map((p) => p.id)])
      const shown = (id: string) => shownIds.has(id)
      const out = (t: Doc<'issues'>) =>
        viewRow(t, shown, isGroup(t) === true ? (facts.get(t.id) ?? null) : null)
      return {
        state: 'ok',
        rows: list.sort(byNumber).map(out),
        parents: parents.sort(byNumber).map(out),
        held_projects: held,
        ...('selection' in at ? { projects: at.selection.subProjects.map((p) => p.id) } : {}),
      }
    },
  }
}

/**
 * The Board's search over the candidates `add` takes, which passed every
 * other filter as far as their rows tell (boardRead). `add` answers those
 * whose own fields match at once; `finish` reads what the others need, a
 * step at a time in the order boardRead states, and hands each step's new
 * matches to `decide`, which counts them, so the read stops once the ceiling
 * is passed. A step whose room runs out throws OverBudget, never a Board of
 * the matches so far.
 *
 * Texts are read one task at a time (model/descriptions.ts descriptionsOf)
 * for at most lib/core.ts TEXT_TASK_READS tasks, and by chunks of a
 * project's active description rows (projectTextReader) for a project
 * whose candidates are more than half of its active tasks, where the read
 * took them whole (`sizes`), and for every task past TEXT_TASK_READS. So a
 * few candidates of a large project, under the people filter or in My view,
 * never read that project's other texts, and a search over a whole
 * selection reads its texts many to a range. Both take the guard's ceiling,
 * with its fixed charges folded in.
 *
 * The organization's labels are read once, in steps, and only those whose
 * name holds a piece of the search matter, as lib/archivedTasks.ts
 * matchingLabels finds them. A candidate's labels are read only where they
 * can finish its match: every piece its own fields, assignee name and text
 * leave must be in such a label's name, so "login bug" reads no label for
 * a task without "login". They are read through the candidate's own rows,
 * one by_issue_label range for one useful label (lib/core.ts
 * labelNamesOf), else the task's by_issue range (markedLabelNamesOf). Past
 * BOARD.labelTasks candidates of one organization, each useful label's
 * active assignments are read instead (issue_labels by_label), many to a
 * range. Those follow the organization rather than the selection, and hold
 * tasks the reader cannot see: each counts at LABEL_ASSIGNMENT_BYTES, so
 * their contents move no answer, but how many there are can move it at the
 * budget's margin, as lib/viewReads.ts lists for its other reads.
 */
function boardSearch(
  ctx: QueryCtx,
  guard: ViewBudget,
  text: string,
  subtasks: ReturnType<typeof noSubtasks>,
  sizes: ReadonlyMap<string, number>,
  seats: ViewSeats,
) {
  const matches = allWordsMatcher(text)
  const pieces = searchPieces(text)
  const holdsPiece = (name: string) => {
    const lower = name.toLowerCase()
    return pieces.some((piece) => lower.includes(piece))
  }
  // a status line holding none of the pieces never changes the answer
  const statusMatters = (Object.values(STATUS_NAMES) as string[]).some(holdsPiece)
  const queues: Record<Need, Candidate[]> = { group: [], name: [], text: [], labels: [] }
  let matched: Candidate[] = []
  // the assignees read, by profile id, null for none
  const people = new Map<string, Doc<'profiles'> | null>()
  // each organization's labels that hold a piece, once read
  const labelsOf = new Map<string, Doc<'labels'>[]>()
  // the tasks whose texts were read one at a time
  let oneByOne = 0

  /* whether `c` matches, or what it needs read before that is known */
  const answer = (c: Candidate): boolean | Need => {
    const t = c.task
    const group = isGroupIn(subtasks, t.id)
    const fields = {
      key: issueKey(t.num),
      title: t.title,
      status: t.status,
      priority: t.priority,
      description: c.text ?? '',
      assigneeName: c.name ?? null,
      labelNames: c.labels ?? [],
    }
    if (matches(taskSearchText({ ...fields, group: group ?? true }))) return true
    if (
      group === undefined &&
      statusMatters &&
      matches(taskSearchText({ ...fields, group: false }))
    )
      return 'group'
    if (c.name === undefined) return 'name'
    if (c.text === undefined) return 'text'
    if (c.labels === undefined) return 'labels'
    return false
  }
  const route = (c: Candidate) => {
    const next = answer(c)
    if (next === true) matched.push(c)
    else if (next !== false) queues[next].push(c)
  }
  const takeMatched = () => {
    const out = matched.map((c) => c.task)
    matched = []
    return out
  }
  /* the pieces of the search that `c`'s own fields, assignee name and text
   * do not hold, the status line counted unless `c` is a group */
  const missing = (c: Candidate): string[] => {
    const t = c.task
    const hay = taskSearchText({
      key: issueKey(t.num),
      title: t.title,
      status: t.status,
      priority: t.priority,
      description: c.text ?? '',
      assigneeName: c.name ?? null,
      labelNames: [],
      group: isGroupIn(subtasks, t.id) === true,
    }).toLowerCase()
    return pieces.filter((piece) => !hay.includes(piece))
  }
  /* the organization's labels that can finish `c`'s match: those holding a
   * piece its other fields do not, or none when some such piece is in no
   * label, so its labels cannot make it match */
  const usefulLabels = (c: Candidate): Doc<'labels'>[] => {
    const left = missing(c)
    const labels = (labelsOf.get(c.task.org_id) ?? []).filter((label) => {
      const name = label.name.toLowerCase()
      return left.some((piece) => name.includes(piece))
    })
    const named = (piece: string) => labels.some((l) => l.name.toLowerCase().includes(piece))
    return left.length > 0 && left.every(named) ? labels : []
  }

  /* the organization's labels whose name holds a piece of the search */
  const piecedLabels = async (orgId: string): Promise<Doc<'labels'>[]> => {
    const range: StepRange<Doc<'labels'>> = {
      open: (from) =>
        ctx.db
          .query('labels')
          .withIndex('by_org', (q) =>
            from === undefined
              ? q.eq('org_id', orgId)
              : q.eq('org_id', orgId).gte('_creationTime', from),
          ),
    }
    const out: Doc<'labels'>[] = []
    for await (const step of inSteps(guard, [range], LABEL_ROW))
      out.push(...step.filter((label) => holdsPiece(label.name)))
    return out
  }

  /* the assignees' names of `step`, each profile read once by id; an
   * assignee of no profile, or of another organization, has none */
  const readNames = async (step: readonly Candidate[]) => {
    const wanted = [
      ...new Set(
        step.flatMap((c) => (c.task.assignee_id === undefined ? [] : [c.task.assignee_id])),
      ),
    ].filter((id) => !people.has(id))
    // those the room holds; a candidate whose assignee waits goes back
    const ids = wanted.slice(0, await guard.upTo(BY_ID, wanted.length, wanted.length === 0 ? 0 : 1))
    const found = await settled(ids.map((id) => byId(ctx, 'profiles', id)))
    for (const [i, id] of ids.entries()) people.set(id, found[i])
    for (const c of step) {
      const id = c.task.assignee_id
      if (id !== undefined && !people.has(id)) continue
      const person = id === undefined ? null : (people.get(id) ?? null)
      c.name = person !== null && person.org_id === c.task.org_id ? person.name : null
    }
  }

  /* the label names of `step`, the candidates waiting for them: none for a
   * candidate whose other fields leave a piece no label of its organization
   * holds, so no label can make it match; else those of the labels that can
   * finish its match, through its own rows (lib/core.ts labelNamesOf for one
   * such label, markedLabelNamesOf for more), a range each, or past
   * BOARD.labelTasks candidates of one organization through each such
   * label's active assignments (issue_labels by_label), many to a range.
   * Those include assignments of tasks the reader cannot see, each counted
   * at LABEL_ASSIGNMENT_BYTES, and a task restored so recently that its
   * assignments are still marked reads its own rows. A candidate the room
   * does not hold goes back. */
  const readLabels = async (step: readonly Candidate[]) => {
    for (const org of new Set(step.map((c) => c.task.org_id)))
      if (!labelsOf.has(org)) labelsOf.set(org, await piecedLabels(org))
    const useful = new Map(step.map((c) => [c, usefulLabels(c)]))
    for (const c of step) if ((useful.get(c) ?? []).length === 0) c.labels = []
    for (const [, theirs] of groupBy(
      step.filter((c) => c.labels === undefined),
      (c) => c.task.org_id,
    )) {
      const byLabel = theirs.length > BOARD.labelTasks
      const own = byLabel ? theirs.filter((c) => c.task.relations_marked === true) : theirs
      if (byLabel)
        await readAssignments(
          theirs.filter((c) => !own.includes(c)),
          useful,
        )
      // those the room holds, a range and the rows each may read
      const reading = own.slice(
        0,
        await guard.upTo(LABEL_TASK, own.length, own.length === 0 ? 0 : 1),
      )
      const got = await settled(
        reading.map((c) => {
          const labels = useful.get(c) ?? []
          return labels.length === 1
            ? labelNamesOf(ctx, c.task.id, labels)
            : markedLabelNamesOf(ctx, c.task.id, labels)
        }),
      )
      for (const [i, c] of reading.entries()) c.labels = got[i]
    }
  }

  /* the label names of `cands`, candidates of one organization, through
   * the active assignments of each label that can finish one's match */
  const readAssignments = async (
    cands: readonly Candidate[],
    useful: ReadonlyMap<Candidate, readonly Doc<'labels'>[]>,
  ) => {
    const labels = [
      ...new Map(cands.flatMap((c) => useful.get(c) ?? []).map((l) => [l.id, l])).values(),
    ]
    const wanted = new Set(cands.map((c) => c.task.id))
    const carried = new Map<string, Set<string>>()
    const ranges = labels.map(
      (label): StepRange<Doc<'issue_labels'>> => ({
        open: (from) =>
          ctx.db.query('issue_labels').withIndex('by_label', (q) => {
            const active = q.eq('label_id', label.id).eq('task_archived', undefined)
            return from === undefined ? active : active.gte('_creationTime', from)
          }),
      }),
    )
    const charge = (row: Doc<'issue_labels'>) => guard.charge(row, LABEL_ASSIGNMENT_BYTES)
    for await (const rows of inSteps(guard, ranges, ASSIGNMENT, charge, ASSIGNMENTS_PER_STEP))
      for (const row of rows)
        if (wanted.has(row.issue_id))
          carried.set(row.issue_id, (carried.get(row.issue_id) ?? new Set()).add(row.label_id))
    for (const c of cands) {
      const held = carried.get(c.task.id) ?? new Set()
      c.labels = (useful.get(c) ?? []).filter((l) => held.has(l.id)).map((l) => l.name)
    }
  }

  // the texts in flight: those read one at a time, and those read by
  // project chunks with their reader
  let texts: {
    single: Candidate[]
    chunked: Candidate[]
    reader: ReturnType<typeof projectTextReader> | null
    got: Map<string, string>
  } | null = null

  /* reads one step of texts, of the candidates in flight or, with none, of
   * every candidate that waits for its text */
  const readTexts = async () => {
    if (texts === null) {
      const waiting = queues.text.splice(0)
      const wanted = new Map<string, number>()
      for (const c of waiting)
        wanted.set(c.task.project_id, (wanted.get(c.task.project_id) ?? 0) + 1)
      const single: Candidate[] = []
      const chunked: Candidate[] = []
      for (const c of waiting) {
        const size = sizes.get(c.task.project_id)
        const most = size !== undefined && 2 * (wanted.get(c.task.project_id) ?? 0) > size
        if (!most && oneByOne < TEXT_TASK_READS.reads) {
          single.push(c)
          oneByOne++
        } else chunked.push(c)
      }
      const got = new Map<string, string>()
      const reader =
        chunked.length === 0
          ? null
          : projectTextReader(
              ctx,
              chunked.map((c) => c.task),
              guard.ceiling,
              got,
            )
      texts = { single, chunked, reader, got }
    }
    const pass = texts
    if (pass.single.length > 0) {
      const step = pass.single.splice(0, STEP)
      const read = await descriptionsOf(
        ctx,
        step.map((c) => c.task),
        guard.ceiling,
      )
      if (read === null) throw new OverBudget()
      for (const c of step) {
        c.text = read.get(c.task.id) ?? ''
        route(c)
      }
      return
    }
    if (pass.reader !== null && pass.chunked.length > 0) {
      const step: RangeStep = await pass.reader.step(() => false)
      if (step === 'full') throw new OverBudget()
      if (step === 'missing') {
        // no range holds a row for the next task, read it on its own
        const next = pass.chunked.find((c) => !pass.got.has(c.task.id))
        if (next !== undefined) {
          const read = await descriptionsOf(ctx, [next.task], guard.ceiling)
          if (read === null) throw new OverBudget()
          pass.got.set(next.task.id, read.get(next.task.id) ?? '')
        }
      }
      const left: Candidate[] = []
      for (const c of pass.chunked) {
        const got = pass.got.get(c.task.id)
        if (got === undefined) {
          left.push(c)
          continue
        }
        c.text = got
        route(c)
      }
      pass.chunked = left
      return
    }
    texts = null
  }

  return {
    /** Takes `tasks` as candidates and answers those whose own fields
     * match. */
    add(tasks: readonly Doc<'issues'>[]): Doc<'issues'>[] {
      for (const task of tasks)
        route({ task, name: task.assignee_id === undefined ? null : undefined })
      return takeMatched()
    },
    /** Reads what the candidates still need, a step at a time, and hands
     * each step's matches to `decide`. */
    async finish(decide: (tasks: readonly Doc<'issues'>[]) => Promise<void>): Promise<void> {
      for (;;) {
        await decide(takeMatched())
        if (queues.group.length > 0) {
          const step = queues.group.splice(0, STEP)
          await groupCheck(
            ctx,
            guard,
            seats,
            step.map((c) => c.task),
            subtasks,
          )
          for (const c of step) route(c)
          continue
        }
        if (queues.name.length > 0) {
          const step = queues.name.splice(0, STEP)
          await readNames(step)
          for (const c of step) route(c)
          continue
        }
        if (texts !== null || queues.text.length > 0) {
          await readTexts()
          // the description readers step by the request's totals
          guard.forget()
          continue
        }
        if (queues.labels.length > 0) {
          // the whole queue, so one organization's many candidates read by label
          const step = queues.labels.splice(0)
          await readLabels(step)
          for (const c of step) route(c)
          continue
        }
        return
      }
    },
  }
}

/**
 * The projects whose lanes the Board keeps without a card, as src/views/
 * Kanban.tsx keeps a lane, a side-board or in My view a top-level project
 * for a group whose scope holds a task (holdsScoped), unless a filter the
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
