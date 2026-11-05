/* The filter row's read that the app's task views share, the Board's
 * (lib/board.ts) and the Roadmap's (lib/roadmap.ts). Each takes a
 * selection's tasks with the app's filter row applied on the server as the
 * app's passesFilters applies it (src/store/planner.ts), My tasks and the
 * people filter by the Reviewer rule (lib/review.ts taskOwnerId), Priority,
 * Stale's recent activity, and the text filter, in the order its search
 * reads in. It holds no rule of one view. A view hands it its own rule
 * (RowRule), which of the tasks that pass the filters are rows, with or
 * without their group facts, and which of them count toward its ceiling,
 * and its own search limits (SearchLimits), which its tests lower.
 *
 * It reads through the shared view reader (lib/viewReads.ts) and follows
 * its working-set rules, so every task it takes is in the reader's working
 * set. A view answers OverCeiling and the guard's OverBudget with states of
 * its own, never with the rows read so far. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { descriptionsOf, projectTextReader, type RangeStep } from '../model/descriptions'
import { labelNamesOf, markedLabelNamesOf, TEXT_TASK_READS } from './core'
import { byId } from './db'
import type { IssuePriority } from './enums'
import { badRequest } from './functions'
import { limitedText } from './limitRules'
import { LIMITS, TEAM_ROW_MAX_BYTES } from './limits'
import { taskOwnerId } from './review'
import { allWordsMatcher, searchPieces, taskSearchText } from './search'
import { issueKey, STATUS_NAMES } from './taskRefs'
import {
  BY_ID,
  type GroupFacts,
  groupBy,
  groupCheck,
  groupFacts,
  inSteps,
  isGroupIn,
  noSubtasks,
  OverBudget,
  ownerSettled,
  type Reads,
  type StepRange,
  type Subtasks,
  settled,
  type ViewAccess,
  type ViewBudget,
  type ViewSeats,
} from './viewReads'

/** The filter row as a view sends it (src/store/planner.ts IssueFilters):
 * lib/board.ts BoardFilters, and the Roadmap's, which has no Stale and no
 * Focus. */
export type FilterArgs = {
  /** the My tasks toggle */
  mine: boolean
  /** the people filter, matched against each task's owner by the Reviewer
   * rule (lib/review.ts taskOwnerId) */
  owners: string[]
  priority: IssuePriority | null
  /** an ISO instant; a task not Done whose newest activity is before it is
   * stale, null or absent when the Stale filter is off */
  stale_before?: string | null
  focus?: boolean
  /** at most LIMITS.search characters, trimmed here, so whitespace alone is
   * no filter */
  search: string
}

/** The filters as the read applies them. */
export type Filters = {
  mine: boolean
  owners: ReadonlySet<string>
  priority: IssuePriority | null
  /** stale_before in ms */
  staleBefore: number | null
  focus: boolean
  /** trimmed, '' for none */
  search: string
}

/** The filters of `f`, refused past `owners` ids (a view's own cap, such as
 * lib/board.ts BOARD.owners), past LIMITS.search characters (code `rule`)
 * or with a stale_before Date.parse cannot read. */
export function filtersOf(f: FilterArgs, owners: number): Filters {
  if (f.owners.length > owners)
    throw badRequest(`the people filter names at most ${owners} people; choose fewer`)
  let staleBefore: number | null = null
  if (f.stale_before !== undefined && f.stale_before !== null) {
    staleBefore = Date.parse(f.stale_before)
    if (Number.isNaN(staleBefore)) throw badRequest('stale_before must be an ISO date and time')
  }
  return {
    mine: f.mine,
    owners: new Set(f.owners),
    priority: f.priority,
    staleBefore,
    focus: f.focus ?? false,
    search: limitedText(LIMITS.search, f.search),
  }
}

/** What the read throws once more rows than its rule's ceiling count. */
export class OverCeiling extends Error {}

/** A view's own rule over the tasks that pass the filter row (filterRead):
 * which of them are rows, and which rows count toward its ceiling. */
export type RowRule = {
  /** whether `row` needs the group facts of each passing group, which the
   * read then takes before it decides (lib/viewReads.ts groupFacts) */
  facts: boolean
  /** whether passing task `t` is a row; `group` tells a group, and `facts`
   * holds its facts where `facts` asks for them */
  row: (t: Doc<'issues'>, group: boolean, facts: GroupFacts | undefined) => boolean
  /** whether row `t` counts toward `ceiling` */
  counts: (t: Doc<'issues'>, group: boolean) => boolean
  /** the most rows that count; the read throws OverCeiling at the next */
  ceiling: number
}

/** A view's limits of the search's label reads (filterSearch), which its
 * tests lower. `labelTasks` is how many candidates of one organization a
 * search reads labels for through their own rows before it tries each
 * label's assignments, and `labelScan` how many assignments a candidate
 * that try reads. */
export type SearchLimits = { readonly labelTasks: number; readonly labelScan: number }

/** What a filter read holds once every task was taken (filterRead finish). */
export type FilterResult = {
  /** every row, in the order the read found them */
  rows: Doc<'issues'>[]
  /** the tasks the read took, all in the reader's working set */
  read: ReadonlyMap<string, Doc<'issues'>>
  /** what the read knows of its tasks' subtasks */
  subtasks: Subtasks
  /** whether a task the read checked is a group */
  isGroup: (t: Doc<'issues'>) => boolean | undefined
  /** the group facts read so far, by task id */
  facts: ReadonlyMap<string, GroupFacts>
  /** reads the facts of `groups` it does not hold yet, each once */
  factsOf: (groups: readonly Doc<'issues'>[]) => Promise<void>
}

/** How many tasks one step of the filters, a group check or a search read
 * settles at once, so the count is known after each step. */
export const STEP = 64

/** A label row, as a read keeps room for it: smaller than a team row
 * (lib/limits.ts TEAM_ROW_MAX_BYTES), as a label holds a name of at most 40
 * characters. */
const LABEL_ROW: Reads = { bytes: TEAM_ROW_MAX_BYTES, documents: 1, ranges: 0 }

/** The most a label assignment row takes, as Convex counts a document: an
 * organization, a task and a label id, the task's window key and the
 * archive mark, 236 bytes measured (tests/rowBounds.test.ts). A search that
 * reads a label's assignments, those of tasks the reader cannot see among
 * them, counts each at this size, so their contents move no answer. */
export const LABEL_ASSIGNMENT_BYTES = 512

/** One label assignment read in a label's range. */
const ASSIGNMENT: Reads = { bytes: LABEL_ASSIGNMENT_BYTES, documents: 1, ranges: 0 }

/** What one task's label read takes at most through its own rows: for one
 * label, one range and its assignment (lib/core.ts labelNamesOf), for more,
 * one range and up to LIMITS.labels.max assignments (markedLabelNamesOf). */
const LABEL_ONE: Reads = { bytes: LABEL_ASSIGNMENT_BYTES, documents: 1, ranges: 1 }
const LABEL_TASK: Reads = {
  bytes: LIMITS.labels.max * LABEL_ASSIGNMENT_BYTES,
  documents: LIMITS.labels.max,
  ranges: 1,
}

/** No reads. */
const NO_READS: Reads = { bytes: 0, documents: 0, ranges: 0 }

/* `a` and `b` together. */
const plus = (a: Reads, b: Reads): Reads => ({
  bytes: a.bytes + b.bytes,
  documents: a.documents + b.documents,
  ranges: a.ranges + b.ranges,
})

/** How many assignments one step of a label's range asks for. */
const ASSIGNMENTS_PER_STEP = 256

/** -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
export const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Tasks by number, then organization and id, as src/store/taskIndex.ts
 * orders the store's tasks. */
export const byNumber = (a: Doc<'issues'>, b: Doc<'issues'>) =>
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
 * One filter read over `seats`: it takes the selection's tasks in steps
 * (take), applies the filters to each as it comes, decides by the view's
 * rule which are rows and counts those its rule counts, and answers what it
 * read (finish).
 *
 * The filters run in the app's order of cost. Priority and Stale's recent
 * activity need nothing more than the row. The owner of a task needs its
 * group fact only In Review with a reviewer other than its assignee
 * (lib/viewReads.ts ownerSettled). Every task that passes them gets its
 * group check, and where the view's rule asks, a group its facts (the
 * Board's Stale filter reads a group's subtree, and the Roadmap shows a
 * group by its effective completion and span).
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
 * labels, the reverse of the REST and MCP active lists' search
 * (lib/activeTaskPage.ts searchRule), because a view reads a task's labels
 * through its own rows, a range a task, where many texts come many to a
 * range; lib/archivedTasks.ts archivedTaskMatcher reads them in the same
 * order.
 */
export function filterRead(
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
    /** the view's rule */
    rule: RowRule
    /** the view's search limits */
    limits: SearchLimits
  },
) {
  const subtasks = noSubtasks()
  // the tasks the read took, all in the reader's working set
  const read = new Map<string, Doc<'issues'>>()
  // how many active tasks each project holds, when the read takes them whole
  const sizes = new Map<string, number>()
  const rows = new Map<string, Doc<'issues'>>()
  const facts = new Map<string, GroupFacts>()
  let counted = 0
  const isGroup = (t: Doc<'issues'>) => isGroupIn(subtasks, t.id)
  const seatOf = (t: Doc<'issues'>): ViewAccess => {
    const seat = seats.get(t.org_id)
    if (seat === undefined) throw new Error('a view read a task without its seat')
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
   * that pass every filter once their group checks are read and that the
   * view's rule takes as rows, and counts those its rule counts, a step at
   * a time */
  const decide = async (tasks: readonly Doc<'issues'>[]) => {
    for (let at = 0; at < tasks.length; at += STEP) {
      const step = tasks.slice(at, at + STEP).filter((t) => !rows.has(t.id))
      await groupCheck(ctx, guard, seats, step, subtasks)
      const pass = step.filter((t) => ownerPasses(t, isGroup(t) === true))
      if (o.rule.facts) await factsOf(pass.filter((t) => isGroup(t)))
      for (const t of pass) {
        const group = isGroup(t) === true
        if (!o.rule.row(t, group, facts.get(t.id))) continue
        rows.set(t.id, t)
        if (o.rule.counts(t, group) && ++counted > o.rule.ceiling) throw new OverCeiling()
      }
    }
  }

  const search =
    f.search === '' ? null : filterSearch(ctx, guard, f.search, subtasks, sizes, seats, o.limits)
  // the tasks taken that wait for their group checks
  const pending: Doc<'issues'>[] = []

  return {
    /** Takes the tasks `batches` yields, each in the reader's working set,
     * and applies the filters to those `keep` holds: those their rows tell
     * as they come, and the rest, which need group checks, once more than
     * the rule's ceiling wait, so the read can stop at the ceiling. */
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
        if (pending.length > o.rule.ceiling) await decide(pending.splice(0))
      }
    },

    /** What the read holds once every task was taken, after the rest of
     * the search read. */
    async finish(): Promise<FilterResult> {
      await decide(pending.splice(0))
      if (search !== null) await search.finish(decide)
      return { rows: [...rows.values()], read, subtasks, isGroup, facts, factsOf }
    },
  }
}

/**
 * The filter row's search over the candidates `add` takes, which passed every
 * other filter as far as their rows tell (filterRead). `add` answers those
 * whose own fields match at once; `finish` reads what the others need, a
 * step at a time in the order filterRead states, and hands each step's new
 * matches to `decide`, which counts them, so the read stops once the ceiling
 * is passed. A step whose room runs out throws OverBudget, never a view of
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
 * the view's labelTasks (SearchLimits) candidates of one organization, each
 * useful label's active assignments are read (issue_labels by_label), many
 * to a range, as long as that is the cheaper read: within its labelScan
 * assignments a candidate while the room holds the own-row reads too, else
 * only where it does not hold those (readLabels). The assignments follow the
 * organization rather than the selection, and hold tasks the reader cannot
 * see: each counts at LABEL_ASSIGNMENT_BYTES, so their contents move no
 * answer, but how many there are can move it at the budget's margin, as
 * lib/viewReads.ts lists for its other reads.
 *
 * Whether a candidate's status line counts decides which pieces its labels
 * must hold, so a candidate whose status line holds a piece its other
 * fields do not gets its group check before its labels: a group's stored
 * status is dormant and not searched.
 */
function filterSearch(
  ctx: QueryCtx,
  guard: ViewBudget,
  text: string,
  subtasks: ReturnType<typeof noSubtasks>,
  sizes: ReadonlyMap<string, number>,
  seats: ViewSeats,
  limits: SearchLimits,
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
    if (c.labels === undefined)
      // which labels can finish its match turns on whether its status line
      // counts, which only its group check tells
      return group === undefined && statusDecides(c) ? 'group' : 'labels'
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
   * do not hold, its status line counted unless it is a group (`asGroup`) */
  const missing = (c: Candidate, asGroup: boolean): string[] => {
    const t = c.task
    const hay = taskSearchText({
      key: issueKey(t.num),
      title: t.title,
      status: t.status,
      priority: t.priority,
      description: c.text ?? '',
      assigneeName: c.name ?? null,
      labelNames: [],
      group: asGroup,
    }).toLowerCase()
    return pieces.filter((piece) => !hay.includes(piece))
  }
  /* whether `c`'s status line holds a piece its other fields do not, so
   * the pieces its labels must hold depend on whether it is a group, whose
   * stored status is dormant and not searched */
  const statusDecides = (c: Candidate): boolean =>
    missing(c, true).length !== missing(c, false).length
  /* the organization's labels that can finish `c`'s match: those holding a
   * piece its other fields do not, or none when some such piece is in no
   * label, so its labels cannot make it match. `c`'s group fact is known
   * wherever its status line decides those pieces (answer). */
  const usefulLabels = (c: Candidate): Doc<'labels'>[] => {
    const left = missing(c, isGroupIn(subtasks, c.task.id) === true)
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
   * finish its match. Up to limits.labelTasks candidates of one organization
   * read them through their own rows (readOwn), a range each. Past it the
   * search reads each such label's active assignments instead (issue_labels
   * by_label), many to a range, but a label may be on thousands of other
   * tasks of the organization, so it does so only as far as it pays: while
   * the room also holds the own-row reads, it reads at most limits.labelScan
   * assignments a candidate and reads the own rows once it passes that;
   * where the room holds only the own-row reads, it reads those; and where
   * it holds neither it reads the assignments, the one read that may still
   * fit. The assignments include those of tasks the reader cannot see, each
   * counted at LABEL_ASSIGNMENT_BYTES, and a task restored so recently that
   * its assignments are still marked reads its own rows. */
  const readLabels = async (step: readonly Candidate[]) => {
    for (const org of new Set(step.map((c) => c.task.org_id)))
      if (!labelsOf.has(org)) labelsOf.set(org, await piecedLabels(org))
    const useful = new Map(step.map((c) => [c, usefulLabels(c)]))
    for (const c of step) if ((useful.get(c) ?? []).length === 0) c.labels = []
    for (const [, theirs] of groupBy(
      step.filter((c) => c.labels === undefined),
      (c) => c.task.org_id,
    )) {
      const marked = theirs.filter((c) => c.task.relations_marked === true)
      const rest = theirs.filter((c) => c.task.relations_marked !== true)
      let own = theirs
      if (rest.length > limits.labelTasks) {
        const labels = new Set(rest.flatMap((c) => (useful.get(c) ?? []).map((l) => l.id)))
        const cap = limits.labelScan * rest.length
        // a scan of `cap` assignments, with the step past it and a range a label
        const rows = cap + labels.size * ASSIGNMENTS_PER_STEP
        const scan: Reads = {
          bytes: rows * LABEL_ASSIGNMENT_BYTES,
          documents: rows,
          ranges: labels.size + Math.ceil(rows / ASSIGNMENTS_PER_STEP),
        }
        const perTask = rest.reduce((total, c) => plus(total, ownCost(c, useful)), NO_READS)
        const holds = async (cost: Reads) => (await guard.count(cost, 1)) >= 1
        if (await holds(plus(perTask, scan))) {
          if (await readAssignments(rest, useful, cap)) own = marked
        } else if (!(await holds(perTask))) {
          await readAssignments(rest, useful)
          own = marked
        }
      }
      await readOwn(own, useful)
    }
  }

  /* what reading `c`'s labels through its own rows takes at most */
  const ownCost = (c: Candidate, useful: ReadonlyMap<Candidate, readonly Doc<'labels'>[]>) =>
    (useful.get(c) ?? []).length === 1 ? LABEL_ONE : LABEL_TASK

  /* the label names of `cands` through their own rows, one by_issue_label
   * range for one useful label (lib/core.ts labelNamesOf), else the task's
   * by_issue range (markedLabelNamesOf); a candidate the room does not hold
   * goes back */
  const readOwn = async (
    cands: readonly Candidate[],
    useful: ReadonlyMap<Candidate, readonly Doc<'labels'>[]>,
  ) => {
    for (const cost of [LABEL_ONE, LABEL_TASK]) {
      const these = cands.filter((c) => ownCost(c, useful) === cost)
      const reading = these.slice(
        0,
        await guard.upTo(cost, these.length, these.length === 0 ? 0 : 1),
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
   * the active assignments of each label that can finish one's match, or
   * false, with none set, once they pass `cap` assignments */
  const readAssignments = async (
    cands: readonly Candidate[],
    useful: ReadonlyMap<Candidate, readonly Doc<'labels'>[]>,
    cap = Number.POSITIVE_INFINITY,
  ): Promise<boolean> => {
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
    let read = 0
    for await (const rows of inSteps(guard, ranges, ASSIGNMENT, charge, ASSIGNMENTS_PER_STEP)) {
      read += rows.length
      if (read > cap) return false
      for (const row of rows)
        if (wanted.has(row.issue_id))
          carried.set(row.issue_id, (carried.get(row.issue_id) ?? new Set()).add(row.label_id))
    }
    for (const c of cands) {
      const held = carried.get(c.task.id) ?? new Set()
      c.labels = (useful.get(c) ?? []).filter((l) => held.has(l.id)).map((l) => l.name)
    }
    return true
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
