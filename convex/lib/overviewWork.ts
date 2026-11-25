/* My view's Your work (overview.ts work). The rows are the person's own
 * open tasks without subtasks by the Reviewer rule, read through their
 * assignee and reviewer ranges as the Board's My view reads them, with
 * the kinds of the project Overview's Needs attention list
 * (lib/overviewNeeds.ts). In Review without a reviewer stays with its
 * assignee under In progress, as Team sync's On it holds it. The tasks,
 * their parents and blockers are read whole or the answer is over_budget;
 * the verdicts come last, and a verdict that could not be read makes the
 * delay figures unavailable and its row's delay unknown, never on track. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { badRequest } from './functions'
import { isGroup, newGroups, overScope, readGroups, type ScopeRefusal, tracks } from './overview'
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
import { FOCUS_STATUSES, groupBy, ownTasks, shownParents, type ViewRow, viewRow } from './viewReads'

export const WORK_GROUPS = ['progress', 'review', 'next'] as const

export type WorkGroup = (typeof WORK_GROUPS)[number]

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
      /** the Late rows, the overdue ones and those projected to miss, of
       * sub-projects that track delay, by due date ascending, under the
       * top-level project of their sub-project: one entry for each
       * top-level project above a row in a sub-project that tracks delay,
       * whose days may be empty; unavailable as Projected to miss is */
      late_due: Figure<{
        projects: { project_id: string; days: { due: string; count: number }[] }[]
      }>
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
    for (const seat of at.seats.values()) {
      const own: Doc<'issues'>[] = []
      for await (const step of ownTasks(ctx, guard, seat, FOCUS_STATUSES)) own.push(...step)
      for (const t of own) read.set(t.id, t)
      await readGroups(ctx, guard, g, own, false)
      for (const t of own) {
        if (isGroup(g, t) || taskOwnerId(t, false) !== seat.me.id) continue
        const group = groupOf(t, seat.me.id)
        if (group === null) continue
        const sub = await seat.project(t.project_id)
        if (sub === null) continue
        subOf.set(t.id, sub)
        mine.push({ task: t, group })
      }
    }
    const tasks = mine.map((m) => m.task)
    const parents = await shownParents(ctx, guard, tasks, read, Number.POSITIVE_INFINITY)
    const parentOf = new Map(parents.map((p) => [p.id, p]))
    const blockers = await blockersOf(ctx, guard, at.seats, {
      rows: tasks,
      tasks: read,
      known: g.known,
    })

    // organizations in id order, so where a stopped read ends never
    // follows the order of the rows
    const tracked = (t: Doc<'issues'>) => tracks(subOf.get(t.id) ?? null)
    const overdue = (t: Doc<'issues'>) => t.due_date !== undefined && t.due_date < clock.day
    const judged = tasks.filter((t) => tracked(t) && !overdue(t))
    const verdictOf = new Map<string, { status: string; fin: number | null }>()
    const unknown = new Set<string>()
    const delays = await bounded(async (): Promise<Figure<{ missing: Missing | null }>> => {
      const v = verdicts(ctx, guard, at.seats, clock)
      const byOrg = groupBy(judged, (t) => t.org_id)
      for (const org of [...byOrg.keys()].sort()) {
        const owners: string[] = []
        for (const t of byOrg.get(org) ?? []) {
          const owner = await v.needs(t, null)
          if (owner !== null) owners.push(owner)
        }
        await v.readAll(org, owners)
      }
      let missing: Missing | null = null
      for (const t of judged) {
        const verdict = await v.of(t, null)
        if (verdict === UNKNOWN) {
          missing = 'loads'
          unknown.add(t.id)
        } else if (verdict !== null) verdictOf.set(t.id, verdict)
      }
      return { state: 'ok', missing }
    })
    const missing: Missing | null = delays.state === 'ok' ? delays.missing : delays.reason
    if (delays.state !== 'ok') for (const t of judged) unknown.add(t.id)

    const list: Judged[] = []
    const lateDue = new Map<string, Map<string, number>>()
    for (const { task: t, group } of mine) {
      const kinds: NeedsKind[] = []
      let weeks = 0
      let fin: number | null | undefined
      const verdict = verdictOf.get(t.id)
      const top = subOf.get(t.id)?.parent_id
      const late = top !== undefined && tracked(t) ? (lateDue.get(top) ?? new Map()) : null
      if (late !== null && top !== undefined) lateDue.set(top, late)
      if (overdue(t)) {
        kinds.push('overdue')
        if (late !== null) late.set(t.due_date as string, (late.get(t.due_date as string) ?? 0) + 1)
      } else if (verdict?.status === 'late') {
        kinds.push('projected')
        fin = verdict.fin
        weeks =
          verdict.fin === null || t.due_date === undefined
            ? 0
            : verdict.fin - clock.ofDay(t.due_date)
        if (late !== null && t.due_date !== undefined)
          late.set(t.due_date, (late.get(t.due_date) ?? 0) + 1)
      } else if (verdict?.status === 'behind') {
        kinds.push('behind')
        fin = verdict.fin
        const end = plannedEnd(clock, t)
        weeks = verdict.fin === null || end === null ? 0 : verdict.fin - end
      }
      const open = blockers.open(t)
      if (open.length > 0) kinds.push('blocked')
      if (t.status === 'review' && t.reviewer_id === undefined) kinds.push('no_reviewer')
      if (t.paused === true) kinds.push('paused')
      list.push({ task: t, group, kinds, weeks, fin, unknown: unknown.has(t.id), blockers: open })
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
      late_due:
        missing === null
          ? {
              state: 'ok',
              projects: [...lateDue.entries()]
                .sort(([a], [b]) => order(a, b))
                .map(([project_id, days]) => ({
                  project_id,
                  days: [...days.entries()]
                    .sort(([a], [b]) => order(a, b))
                    .map(([due, n]) => ({ due, count: n })),
                })),
            }
          : { state: 'unavailable', reason: missing },
    }
  })
}
