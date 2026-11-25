/* The Overview's Needs attention list behind overview.ts needs: for a
 * project scope, a top-level project with its visible live sub-projects or
 * one sub-project, every task that is not done for the reader and needs
 * attention, ranked by one rule, with what each kind counts, the people
 * who own the scope's open work and how many listed tasks are theirs, and
 * the Late tasks by due date for the milestones' lines. It reads through
 * the Overview's scope and figures (lib/overview.ts), the shared view
 * reader (lib/viewReads.ts), Team sync's blockers (lib/teamSyncAgenda.ts
 * blockersOf) and the shared verdicts (lib/viewLoads.ts), so each kind
 * follows the rule another page already has:
 *
 * - Overdue: due before the client's day and not done for the reader, a
 *   group by its group facts, as overview.summary's Overdue counts it.
 * - Projected to miss: due on or after the day, in a sub-project that
 *   tracks delay, whose verdict is Late, as overview.risk counts it.
 * - Behind plan: in a sub-project that tracks delay, whose verdict is
 *   Behind plan, as the health table counts it.
 * - Blocked: a To Do, In Progress or In Review task without subtasks with
 *   a blocker the reader is shown that is not done, Team sync's rule.
 * - No reviewer: an In Review task without subtasks and without a
 *   reviewer, Team sync's Needs a reviewer.
 * - Paused: a paused task without subtasks, as the Paused list holds it.
 *
 * A task with several kinds is one row under the first of them in that
 * order, and names the others. Rows are ranked by kind in that order, then
 * within a kind: Overdue earliest due date first (most days overdue),
 * Projected to miss and Behind plan most weeks past the due week or the
 * planned end first, Blocked and Paused earliest due date first with
 * undated ones last, No reviewer longest waiting first with an unknown
 * hand-off last, and then by task number.
 *
 * The read is whole or it says why not. The tasks are read first and past
 * the budget the answer is over_budget, as no kind can be listed without
 * them. The verdicts come last, through the owners' loads, and where an
 * owner's load or the budget does not hold one, Projected to miss, Behind
 * plan and the whole list's count are unavailable, with its reason, and
 * the rows of the other kinds still show, as does every row whose verdict
 * was read. The list then says it may leave tasks out. */

import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { badRequest } from './functions'
import {
  type Groups,
  isDoneFor,
  isGroup,
  newGroups,
  overScope,
  readGroups,
  type ScopeRead,
  type ScopeRefusal,
  tracks,
} from './overview'
import { taskOwnerId } from './review'
import { blockersOf } from './teamSyncAgenda'
import {
  bounded,
  type Clock,
  clockOf,
  type Figure,
  type Missing,
  UNKNOWN,
  verdicts,
} from './viewLoads'
import {
  FOCUS_STATUSES,
  type GroupFacts,
  selectionTasks,
  shownParents,
  type ViewRow,
  viewRow,
} from './viewReads'

/** The kinds of the Needs attention list, in the order a task takes the
 * first of them. */
export const NEEDS_KINDS = [
  'overdue',
  'projected',
  'behind',
  'blocked',
  'no_reviewer',
  'paused',
] as const

/** One kind of the list. */
export type NeedsKind = (typeof NEEDS_KINDS)[number]

/** The validator of the kind the page shows, every kind for `all`. */
export const vNeedsFilter = v.union(v.literal('all'), ...NEEDS_KINDS.map((kind) => v.literal(kind)))

/** What the page asks the list for. */
export type NeedsFilter = 'all' | NeedsKind

/** The list's sizes, which tests lower and set back with structuredClone:
 * `first` rows at first and `step` more on each Load more, at most `most`
 * rows one answer holds. The design size's 800 open tasks of a project
 * with its sub-projects fit `most`; past it the list says it shows the
 * first ones. */
export const NEEDS = { first: 20, step: 20, most: 1000 }

/** A row of the list: the task as a view sends it, and what it needs. */
export type NeedsRow = ViewRow & {
  needs: {
    /** the first of its kinds, which ranks it */
    kind: NeedsKind
    /** its other kinds, in the order of NEEDS_KINDS */
    also: NeedsKind[]
    /** how many of its blockers the reader is shown that are not done */
    blocked_by: number
    /** the rows of the scope it blocks: how many, and the first, by the
     * order in which the blocked rows rank */
    blocks: { count: number; first: { id: string; title: string } } | null
    /** for Projected to miss and Behind plan, the first day of the week the
     * task is projected to finish in on the client's weeks, null where the
     * verdict has no projected week */
    finish_week?: string | null
  }
}

/** Every kind's count: the stored facts' whole, the verdicts' unavailable
 * where some verdict could not be read. `all` counts each task once. */
export type NeedsCounts = Record<'overdue' | 'blocked' | 'no_reviewer' | 'paused', number> &
  Record<'projected' | 'behind' | 'all', Figure<{ count: number }>>

/** What overview.needs answers. */
export type NeedsAnswer =
  | {
      state: 'ok'
      /** the first `limit` rows of the kind asked, in the list's order */
      rows: NeedsRow[]
      /** how many rows the kind asked holds, the ones whose verdict was
       * read: with `counts` unavailable for it, there may be more */
      total: number
      /** the most rows one answer holds (NEEDS.most) */
      most: number
      counts: NeedsCounts
      /** whether a sub-project of the scope tracks delay, so the page shows
       * Projected to miss and Behind plan */
      tracks_delay: boolean
      /** the owners of the scope's open work, the To Do, In Progress and In
       * Review tasks without subtasks, and of the listed tasks, by id, with
       * how many listed tasks are theirs */
      people: { id: string; listed: number }[]
      /** the Late tasks, the overdue ones and those projected to miss, of
       * the sub-projects that track delay, by due date, ascending;
       * unavailable as Projected to miss is */
      late_due: Figure<{ days: { due: string; count: number }[] }>
    }
  | ScopeRefusal

/* A task of the list as the read judges it. */
type Judged = {
  task: Doc<'issues'>
  facts: GroupFacts | null
  kinds: NeedsKind[]
  /* how far past the due week or the planned end the projection is, in
   * weeks, for Projected to miss and Behind plan */
  weeks: number
  fin?: number | null
  blockers: Doc<'issues'>[]
}

/* The ISO day after every YYYY-MM-DD day, which sorts an undated task last. */
const NO_DAY = '￿'

/* The planned end week of `t` on the clock's weeks as the verdicts read it
 * (lib/viewLoads.ts verdicts): a group's calculated end, a task's end week,
 * never before its start; null without one. */
function plannedEnd(clock: Clock, t: Doc<'issues'>, facts: GroupFacts | null): number | null {
  if (facts !== null) return facts.span.end_week ? clock.ofDay(facts.span.end_week) : null
  if (t.end_week === undefined) return null
  const end = clock.ofDay(t.end_week)
  return t.start_week === undefined ? end : Math.max(clock.ofDay(t.start_week), end)
}

/* The list's order (the module header), as one comparison. */
function byNeed(a: Judged, b: Judged): number {
  const ka = NEEDS_KINDS.indexOf(a.kinds[0] as NeedsKind)
  const kb = NEEDS_KINDS.indexOf(b.kinds[0] as NeedsKind)
  if (ka !== kb) return ka - kb
  const dueA = a.task.due_date ?? NO_DAY
  const dueB = b.task.due_date ?? NO_DAY
  const due = dueA < dueB ? -1 : dueA > dueB ? 1 : 0
  let d = 0
  switch (a.kinds[0]) {
    case 'overdue':
    case 'blocked':
    case 'paused':
      d = due
      break
    case 'projected':
      d = b.weeks - a.weeks || due
      break
    case 'behind':
      d = b.weeks - a.weeks
      break
    case 'no_reviewer': {
      const ra = a.task.review_at ?? NO_DAY
      const rb = b.task.review_at ?? NO_DAY
      d = ra < rb ? -1 : ra > rb ? 1 : 0
      break
    }
  }
  return d || a.task.num - b.task.num || (a.task.id < b.task.id ? -1 : 1)
}

/* The scope's tasks that are not done for the reader, read whole: every
 * active task of the selected sub-projects in a status other than Done,
 * and the parents of those, by id, that a Done status kept out, as a group
 * with a subtask that is not done is not done for the reader. Which are
 * groups, and each group's facts, are read into `g`. */
async function openTasks(
  ctx: QueryCtx,
  guard: Parameters<typeof readGroups>[1],
  at: Extract<ScopeRead, { kind: 'project' }>,
  g: Groups,
): Promise<{ open: Doc<'issues'>[]; read: Map<string, Doc<'issues'>> }> {
  const read = new Map<string, Doc<'issues'>>()
  for await (const step of selectionTasks(ctx, guard, at.selection.subProjects, [
    'backlog',
    ...FOCUS_STATUSES,
  ]))
    for (const t of step) read.set(t.id, t)
  const tasks = [...read.values()]
  const parents = await shownParents(ctx, guard, tasks, read, Number.POSITIVE_INFINITY)
  for (const p of parents) if (!read.has(p.id)) read.set(p.id, p)
  const all = [...read.values()]
  await readGroups(ctx, guard, g, all, true)
  return { open: all.filter((t) => !isDoneFor(g, t)), read }
}

/* The figure of a count the verdicts decide: the count, or why it is not
 * given. */
const verdictFigure = (count: number, missing: Missing | null): Figure<{ count: number }> =>
  missing === null ? { state: 'ok', count } : { state: 'unavailable', reason: missing }

/**
 * The Needs attention list of `scope` (NeedsAnswer) on the client's day
 * and weeks (lib/viewLoads.ts clockOf), for the login whose seats are
 * `profiles`: the first `limit` rows of `kind` (every kind for `all`), as
 * the module header states. Refuses a malformed clock and a `limit` that
 * is not a whole number from 1 to NEEDS.most. A project scope only: My
 * view has no such list, and answers unavailable.
 */
export async function readNeeds(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: {
    scope: { org_id: string; project_id: string }
    day: string
    week: string
    week_starts: readonly number[]
    week_end: number
    kind: NeedsFilter
    limit: number
  },
): Promise<NeedsAnswer> {
  const clock = clockOf(args)
  const { limit } = args
  if (!Number.isInteger(limit) || limit < 1 || limit > NEEDS.most)
    throw badRequest(`limit must be a whole number from 1 to ${NEEDS.most}`)
  const scope = { kind: 'project' as const, ...args.scope }
  return await overScope(ctx, profiles, scope, async (guard, at) => {
    if (at.kind !== 'project') return { state: 'unavailable' }
    const g = newGroups()
    const { open, read } = await openTasks(ctx, guard, at, g)
    const facts = (t: Doc<'issues'>) => (isGroup(g, t) ? (g.facts.get(t.id) ?? null) : null)
    const projectOf = new Map(at.selection.subProjects.map((p) => [p.id, p]))
    const tracked = (t: Doc<'issues'>) => tracks(projectOf.get(t.project_id) ?? null)

    // Team sync's rows: the open tasks without subtasks in its three
    // statuses, whose blockers it reads
    const focus = new Set<string>(FOCUS_STATUSES)
    const rows = open.filter((t) => !isGroup(g, t) && focus.has(t.status))
    const blockers = await blockersOf(ctx, guard, at.seats, { rows, tasks: read, known: g.known })

    // the verdicts last, of the open tasks in sub-projects that track delay
    // and are not overdue, whose owners' loads are read in owner id order
    const overdue = (t: Doc<'issues'>) => t.due_date !== undefined && t.due_date < clock.day
    const judged = open.filter((t) => tracked(t) && !overdue(t))
    const verdictOf = new Map<string, { status: string; fin: number | null }>()
    const delays = await bounded(async (): Promise<Figure<{ missing: Missing | null }>> => {
      const v = verdicts(ctx, guard, at.seats, clock)
      const owners: string[] = []
      for (const t of judged) {
        const owner = await v.needs(t, facts(t))
        if (owner !== null) owners.push(owner)
      }
      await v.readAll(at.seat.me.org_id, owners)
      let missing: Missing | null = null
      for (const t of judged) {
        const verdict = await v.of(t, facts(t))
        if (verdict === UNKNOWN) missing = 'loads'
        else if (verdict !== null) verdictOf.set(t.id, verdict)
      }
      return { state: 'ok', missing }
    })
    const missing: Missing | null = delays.state === 'ok' ? delays.missing : delays.reason

    // each task's kinds, in order
    const list: Judged[] = []
    const lateDue = new Map<string, number>()
    for (const t of open) {
      const f = facts(t)
      const leaf = f === null
      const kinds: NeedsKind[] = []
      let weeks = 0
      let fin: number | null | undefined
      const verdict = verdictOf.get(t.id)
      if (overdue(t)) {
        kinds.push('overdue')
        if (tracked(t))
          lateDue.set(t.due_date as string, (lateDue.get(t.due_date as string) ?? 0) + 1)
      } else if (verdict?.status === 'late') {
        kinds.push('projected')
        fin = verdict.fin
        weeks =
          verdict.fin === null || t.due_date === undefined
            ? 0
            : verdict.fin - clock.ofDay(t.due_date)
        if (t.due_date !== undefined) lateDue.set(t.due_date, (lateDue.get(t.due_date) ?? 0) + 1)
      } else if (verdict?.status === 'behind') {
        kinds.push('behind')
        fin = verdict.fin
        const end = plannedEnd(clock, t, f)
        weeks = verdict.fin === null || end === null ? 0 : verdict.fin - end
      }
      const open_blockers = leaf && focus.has(t.status) ? blockers.open(t) : []
      if (open_blockers.length > 0) kinds.push('blocked')
      if (leaf && t.status === 'review' && t.reviewer_id === undefined) kinds.push('no_reviewer')
      if (leaf && t.paused === true) kinds.push('paused')
      if (kinds.length === 0) continue
      list.push({ task: t, facts: f, kinds, weeks, fin, blockers: open_blockers })
    }
    list.sort(byNeed)

    // the rows each task blocks, in the list's order, which holds every
    // blocked row
    const blocks = new Map<string, Doc<'issues'>[]>()
    for (const j of list)
      for (const b of j.blockers) blocks.set(b.id, [...(blocks.get(b.id) ?? []), j.task])

    // the people: the owners of the scope's open work and of the listed tasks
    const listed = new Map<string, number>()
    for (const t of rows) {
      const owner = taskOwnerId(t, false)
      if (owner !== undefined && !listed.has(owner)) listed.set(owner, 0)
    }
    for (const j of list) {
      const owner = taskOwnerId(j.task, j.facts !== null)
      if (owner !== undefined) listed.set(owner, (listed.get(owner) ?? 0) + 1)
    }

    const count = (kind: NeedsKind) => list.filter((j) => j.kinds.includes(kind)).length
    const kept =
      args.kind === 'all' ? list : list.filter((j) => j.kinds.includes(args.kind as NeedsKind))
    const shown = new Map(read)
    return {
      state: 'ok',
      rows: kept.slice(0, limit).map((j): NeedsRow => {
        const blocked = blocks.get(j.task.id) ?? []
        return {
          ...viewRow(j.task, shown, j.facts),
          needs: {
            kind: j.kinds[0] as NeedsKind,
            also: j.kinds.slice(1),
            blocked_by: j.blockers.length,
            blocks:
              blocked.length === 0
                ? null
                : { count: blocked.length, first: { id: blocked[0].id, title: blocked[0].title } },
            ...(j.fin === undefined
              ? {}
              : { finish_week: j.fin === null ? null : clock.firstDay(j.fin) }),
          },
        }
      }),
      total: kept.length,
      most: NEEDS.most,
      counts: {
        overdue: count('overdue'),
        blocked: count('blocked'),
        no_reviewer: count('no_reviewer'),
        paused: count('paused'),
        projected: verdictFigure(count('projected'), missing),
        behind: verdictFigure(count('behind'), missing),
        all: verdictFigure(list.length, missing),
      },
      tracks_delay: at.selection.subProjects.some(tracks),
      people: [...listed.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, n]) => ({ id, listed: n })),
      late_due:
        missing === null
          ? {
              state: 'ok',
              days: [...lateDue.entries()]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([due, n]) => ({ due, count: n })),
            }
          : { state: 'unavailable', reason: missing },
    }
  })
}
