/* My view's Your work (overview.ts work). The rows are the person's own
 * open tasks without subtasks by the Reviewer rule, read through their
 * assignee and reviewer ranges as the Board's My view reads them, with
 * the kinds of the project Overview's Needs attention list
 * (lib/overviewNeeds.ts). In Review without a reviewer stays with its
 * assignee under In progress, as Team sync's On it holds it. Each row's
 * blockers are read through the seat of its own organization. The
 * milestone lines' Late tasks are read from every task of the person's
 * that is not done for them, Backlog tasks and groups included, a group
 * whose stored status is Done too, as Needs attention reads a project's.
 * The tasks, Done ones included, their parents and blockers are read
 * whole or the answer is over_budget; the verdicts come last, and a
 * verdict that could not be read makes the delay figures unavailable, its
 * row's delay unknown, never on track, and its top-level project's Late
 * tasks unavailable where it could be Late. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ISSUE_STATUSES } from './enums'
import { badRequest } from './functions'
import {
  isDoneFor,
  isGroup,
  newGroups,
  overScope,
  readGroups,
  type ScopeRefusal,
  tracks,
} from './overview'
import { NEEDS_KINDS, type NeedsKind } from './overviewNeeds'
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
import { groupBy, ownTasks, shownParents, type ViewRow, viewRow } from './viewReads'
import type { WorkGroup } from './workGroups'

export { WORK_GROUPS, type WorkGroup } from './workGroups'

/** Tests lower these and set them back with structuredClone. `most` is
 * the Board's ceiling of matching tasks (lib/limits.ts BOARD_TASKS). */
export const WORK = { first: 10, step: 10, most: 1000 }

export type WorkRow = ViewRow & {
  needs: {
    /** the first of its kinds, which ranks it, null for none */
    kind: NeedsKind | null
    /** its other kinds, in the order of NEEDS_KINDS */
    also: NeedsKind[]
    /** how many of its blockers the reader is shown that are not done */
    blocked_by: number
    /** for Projected to miss and Behind plan, the first day of the week the
     * task is projected to finish in on the client's weeks, null where the
     * verdict has no projected week */
    finish_week?: string | null
    /** whether its sub-project tracks delay and its verdict could not be
     * read, so the page says its delay is unknown */
    delay_unknown?: true
  }
  parent_title?: string
}

export type WorkAnswer =
  | {
      state: 'ok'
      groups: Record<WorkGroup, { rows: WorkRow[]; total: number }>
      most: number
      counts: Record<'overdue' | 'blocked' | 'no_reviewer' | 'paused', number> &
        Record<'projected' | 'behind', Figure<{ count: number }>>
      /** one entry for each top-level project above a task of the
       * person's in a sub-project that tracks delay, Done tasks not yet
       * archived included, by project id: its Late tasks, the overdue ones
       * and those projected to miss among the tasks not done for them, by
       * due date ascending, which may be none, or unavailable where a task
       * of it that is due has a verdict that could not be read */
      late_due: {
        project_id: string
        late: Figure<{ days: { due: string; count: number }[] }>
      }[]
    }
  | ScopeRefusal

type Judged = {
  task: Doc<'issues'>
  group: WorkGroup
  kinds: NeedsKind[]
  weeks: number
  fin?: number | null
  unknown: boolean
  blockers: Doc<'issues'>[]
}

/* sorts after every YYYY-MM-DD day and ISO instant, so a missing date
 * goes last */
const NO_DAY = '￿'

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function plannedEnd(clock: Clock, t: Doc<'issues'>): number | null {
  if (t.end_week === undefined) return null
  const end = clock.ofDay(t.end_week)
  return t.start_week === undefined ? end : Math.max(clock.ofDay(t.start_week), end)
}

function byUrgency(a: Judged, b: Judged): number {
  const ka = a.kinds[0] === undefined ? NEEDS_KINDS.length : NEEDS_KINDS.indexOf(a.kinds[0])
  const kb = b.kinds[0] === undefined ? NEEDS_KINDS.length : NEEDS_KINDS.indexOf(b.kinds[0])
  if (ka !== kb) return ka - kb
  const due = order(a.task.due_date ?? NO_DAY, b.task.due_date ?? NO_DAY)
  const waited = order(a.task.review_at ?? NO_DAY, b.task.review_at ?? NO_DAY)
  let d = 0
  switch (a.kinds[0]) {
    case 'projected':
      d = b.weeks - a.weeks || due
      break
    case 'behind':
      d = b.weeks - a.weeks
      break
    case 'no_reviewer':
      d = waited
      break
    case undefined:
      d = a.group === 'review' ? waited : due
      break
    default:
      d = due
  }
  return d || a.task.num - b.task.num || order(a.task.id, b.task.id)
}

function byStart(a: Judged, b: Judged): number {
  return (
    order(a.task.start_week ?? NO_DAY, b.task.start_week ?? NO_DAY) ||
    order(a.task.due_date ?? NO_DAY, b.task.due_date ?? NO_DAY) ||
    a.task.num - b.task.num ||
    order(a.task.id, b.task.id)
  )
}

function groupOf(t: Doc<'issues'>, me: string): WorkGroup | null {
  if (t.status === 'progress') return 'progress'
  if (t.status === 'todo') return 'next'
  if (t.status !== 'review') return null
  return t.reviewer_id === me ? 'review' : 'progress'
}

const verdictFigure = (count: number, missing: Missing | null): Figure<{ count: number }> =>
  missing === null ? { state: 'ok', count } : { state: 'unavailable', reason: missing }

function limitArg(n: number, name: string): number {
  if (!Number.isInteger(n) || n < 1 || n > WORK.most)
    throw badRequest(`${name} must be a whole number from 1 to ${WORK.most}`)
  return n
}

/** Refuses a malformed clock and a limit outside 1 to WORK.most. */
export async function readWork(
  ctx: QueryCtx,
  profiles: ReadonlyMap<string, Doc<'profiles'>>,
  args: {
    day: string
    week: string
    week_starts: readonly number[]
    week_end: number
    progress: number
    review: number
    next: number
  },
): Promise<WorkAnswer> {
  const clock = clockOf(args)
  const limits: Record<WorkGroup, number> = {
    progress: limitArg(args.progress, 'progress'),
    review: limitArg(args.review, 'review'),
    next: limitArg(args.next, 'next'),
  }
  return await overScope(ctx, profiles, { kind: 'mine' }, async (guard, at) => {
    const g = newGroups()
    const read = new Map<string, Doc<'issues'>>()
    const mine: { task: Doc<'issues'>; group: WorkGroup }[] = []
    const subOf = new Map<string, Doc<'projects'>>()
    const tracking: Doc<'issues'>[] = []
    for (const seat of at.seats.values()) {
      const own: Doc<'issues'>[] = []
      for await (const step of ownTasks(ctx, guard, seat, ISSUE_STATUSES)) own.push(...step)
      for (const t of own) read.set(t.id, t)
      // a Done task is its assignee's, a group or not
      await readGroups(
        ctx,
        guard,
        g,
        own.filter((t) => t.status !== 'done'),
        false,
      )
      for (const t of own) {
        if (taskOwnerId(t, isGroup(g, t)) !== seat.me.id) continue
        const sub = await seat.project(t.project_id)
        if (sub === null) continue
        subOf.set(t.id, sub)
        if (tracks(sub)) tracking.push(t)
        const group = isGroup(g, t) ? null : groupOf(t, seat.me.id)
        if (group !== null) mine.push({ task: t, group })
      }
    }
    // the groups' facts, and which Done tasks a subtask made groups, where
    // a due date can make them Late: their stored status is dormant
    await readGroups(
      ctx,
      guard,
      g,
      tracking.filter((t) => isGroup(g, t) || (t.status === 'done' && t.due_date !== undefined)),
      true,
    )
    const facts = (t: Doc<'issues'>) => (isGroup(g, t) ? (g.facts.get(t.id) ?? null) : null)
    const tasks = mine.map((m) => m.task)
    const parents = await shownParents(ctx, guard, tasks, read, Number.POSITIVE_INFINITY)
    const parentOf = new Map(parents.map((p) => [p.id, p]))
    const blocked = new Map<string, Doc<'issues'>[]>()
    for (const [org, rows] of groupBy(tasks, (t) => t.org_id)) {
      const seat = at.seats.get(org)
      if (seat === undefined) continue
      const blockers = await blockersOf(ctx, guard, new Map([[org, seat]]), {
        rows,
        tasks: read,
        known: g.known,
      })
      for (const t of rows) blocked.set(t.id, blockers.open(t))
    }

    // the verdicts last: of the rows, and of the person's other tasks a
    // verdict could make Late, organizations in id order, so where a
    // stopped read ends never follows the order of the rows
    const tracked = (t: Doc<'issues'>) => tracks(subOf.get(t.id) ?? null)
    const overdue = (t: Doc<'issues'>) => t.due_date !== undefined && t.due_date < clock.day
    const open = tracking.filter((t) => !isDoneFor(g, t))
    const rowIds = new Set(tasks.map((t) => t.id))
    const judged = [
      ...tasks.filter((t) => tracked(t) && !overdue(t)),
      ...open.filter((t) => !rowIds.has(t.id) && t.due_date !== undefined && !overdue(t)),
    ]
    const verdictOf = new Map<string, { status: string; fin: number | null }>()
    const unknown = new Set<string>()
    const delays = await bounded(async (): Promise<Figure<{ missing: Missing | null }>> => {
      const v = verdicts(ctx, guard, at.seats, clock)
      const byOrg = groupBy(judged, (t) => t.org_id)
      for (const org of [...byOrg.keys()].sort()) {
        const owners: string[] = []
        for (const t of byOrg.get(org) ?? []) {
          const owner = await v.needs(t, facts(t))
          if (owner !== null) owners.push(owner)
        }
        await v.readAll(org, owners)
      }
      let missing: Missing | null = null
      for (const t of judged) {
        const verdict = await v.of(t, facts(t))
        if (verdict === UNKNOWN) {
          if (rowIds.has(t.id)) missing = 'loads'
          unknown.add(t.id)
        } else if (verdict !== null) verdictOf.set(t.id, verdict)
      }
      return { state: 'ok', missing }
    })
    const missing: Missing | null = delays.state === 'ok' ? delays.missing : delays.reason
    if (delays.state !== 'ok') for (const t of judged) unknown.add(t.id)

    // the Late tasks by due date under each top-level project, unknown for
    // a project where a task that is due could be Late by a verdict not read
    const lateDue = new Map<string, Map<string, number> | Missing>()
    for (const t of tracking) {
      const top = subOf.get(t.id)?.parent_id
      if (top === undefined) continue
      const days = lateDue.get(top) ?? new Map<string, number>()
      lateDue.set(top, days)
      if (typeof days === 'string' || t.due_date === undefined || isDoneFor(g, t)) continue
      if (unknown.has(t.id)) lateDue.set(top, delays.state === 'ok' ? 'loads' : delays.reason)
      else if (overdue(t) || verdictOf.get(t.id)?.status === 'late')
        days.set(t.due_date, (days.get(t.due_date) ?? 0) + 1)
    }

    const list: Judged[] = []
    for (const { task: t, group } of mine) {
      const kinds: NeedsKind[] = []
      let weeks = 0
      let fin: number | null | undefined
      const verdict = verdictOf.get(t.id)
      if (overdue(t)) kinds.push('overdue')
      else if (verdict?.status === 'late') {
        kinds.push('projected')
        fin = verdict.fin
        weeks =
          verdict.fin === null || t.due_date === undefined
            ? 0
            : verdict.fin - clock.ofDay(t.due_date)
      } else if (verdict?.status === 'behind') {
        kinds.push('behind')
        fin = verdict.fin
        const end = plannedEnd(clock, t)
        weeks = verdict.fin === null || end === null ? 0 : verdict.fin - end
      }
      const blockers = blocked.get(t.id) ?? []
      if (blockers.length > 0) kinds.push('blocked')
      if (t.status === 'review' && t.reviewer_id === undefined) kinds.push('no_reviewer')
      if (t.paused === true) kinds.push('paused')
      list.push({ task: t, group, kinds, weeks, fin, unknown: unknown.has(t.id), blockers })
    }

    const shown = new Map(read)
    for (const p of parents) shown.set(p.id, p)
    const rowOf = (j: Judged): WorkRow => {
      const parent = j.task.parent_id === undefined ? undefined : parentOf.get(j.task.parent_id)
      const row = viewRow(j.task, shown, null)
      return {
        ...row,
        needs: {
          kind: j.kinds[0] ?? null,
          also: j.kinds.slice(1),
          blocked_by: j.blockers.length,
          ...(j.fin === undefined
            ? {}
            : { finish_week: j.fin === null ? null : clock.firstDay(j.fin) }),
          ...(j.unknown ? { delay_unknown: true as const } : {}),
        },
        ...(parent !== undefined && row.parent_id === parent.id
          ? { parent_title: parent.title }
          : {}),
      }
    }
    const groupRows = (group: WorkGroup) => {
      const rows = list
        .filter((j) => j.group === group)
        .sort(group === 'next' ? byStart : byUrgency)
      return { rows: rows.slice(0, limits[group]).map(rowOf), total: rows.length }
    }
    const count = (kind: NeedsKind) => list.filter((j) => j.kinds.includes(kind)).length
    return {
      state: 'ok',
      groups: {
        progress: groupRows('progress'),
        review: groupRows('review'),
        next: groupRows('next'),
      },
      most: WORK.most,
      counts: {
        overdue: count('overdue'),
        blocked: count('blocked'),
        no_reviewer: count('no_reviewer'),
        paused: count('paused'),
        projected: verdictFigure(count('projected'), missing),
        behind: verdictFigure(count('behind'), missing),
      },
      late_due: [...lateDue.entries()]
        .sort(([a], [b]) => order(a, b))
        .map(([project_id, days]) => ({
          project_id,
          late:
            typeof days === 'string'
              ? { state: 'unavailable', reason: days }
              : {
                  state: 'ok',
                  days: [...days.entries()]
                    .sort(([a], [b]) => order(a, b))
                    .map(([due, n]) => ({ due, count: n })),
                },
        })),
    }
  })
}
