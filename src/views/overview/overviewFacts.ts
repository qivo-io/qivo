/* The words and rules both Overview pages share (overviewRows.tsx holds
   their shared components): a kind's name, a task's fact on a day, its
   other reasons, the line under a milestone, My view's milestone notes,
   and the focus rules of a list whose rows can leave. */

import { type FocusEvent, useRef, useState } from 'react'
import { firstDayOfWeek, fmtDate, isoToDate, isoToWeek, WEEKDAYS, weekNumLabel } from '@/lib/dates'
import { DELAY_LABELS } from '@/lib/delay'
import { focusAround, useFocusWhenGone } from '@/lib/focusWhenGone'
import { headingTarget } from '@/lib/taskFocus'
import { grouped, LIMITS } from '../../../convex/lib/limits'
import type { NeedsKind } from '../../../convex/lib/overviewNeeds'
import type { ViewRow } from '../../../convex/lib/viewReads'
import type { MilestoneVM } from '../../store/planner'

export const KIND_LABEL: Record<NeedsKind, string> = {
  overdue: 'Overdue',
  projected: 'Projected to miss',
  behind: DELAY_LABELS.behind,
  blocked: 'Blocked',
  no_reviewer: 'No reviewer',
  paused: 'Paused',
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function daysSince(at: number, now: number): number {
  const a = new Date(at)
  const b = new Date(now)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

export const dayOf = (iso: string) => {
  const d = isoToDate(iso)
  return `${WEEKDAYS[d.getDay()]?.slice(0, 3)} ${fmtDate(d)}`
}

export const weekOf = (iso: string) => weekNumLabel(isoToWeek(iso))

/** A task with what it needs, as a Needs attention row or a Your work
    row with a kind carries it. */
export type FactRow = ViewRow & {
  needs: { kind: NeedsKind; blocked_by: number; finish_week?: string | null }
}

const plannedEnd = (row: ViewRow): string | undefined =>
  row.has_subtasks ? row.span?.end_week : (row.end_week ?? undefined)

/** What a row says of its kind on day `day`: the fact, such as "4d
    overdue" or "finishes W50", and the date it is measured against. */
export function factOf(row: FactRow, day: string): { fact: string; date: string | null } {
  const due = row.due_date ?? null
  const end = plannedEnd(row)
  const fin = row.needs.finish_week
  switch (row.needs.kind) {
    case 'overdue': {
      const days = Math.max(
        1,
        Math.round((isoToDate(day).getTime() - isoToDate(due ?? day).getTime()) / 86_400_000),
      )
      return { fact: `${days}d overdue`, date: due ? `due ${dayOf(due)}` : null }
    }
    case 'projected':
      return {
        fact: fin ? `finishes ${weekOf(fin)}` : 'projected to miss',
        date: due ? `due ${weekOf(due)}, ${dayOf(due)}` : null,
      }
    case 'behind':
      return {
        fact: fin ? `finishes ${weekOf(fin)}` : DELAY_LABELS.behind.toLowerCase(),
        date: end ? `planned ${weekOf(end)}` : null,
      }
    case 'no_reviewer': {
      const at = row.review_at ? Date.parse(row.review_at) : null
      return {
        fact: 'no reviewer',
        date:
          at === null ? null : `waiting ${plural(Math.max(0, daysSince(at, Date.now())), 'day')}`,
      }
    }
    default:
      return {
        fact:
          row.needs.kind === 'blocked'
            ? `blocked by ${plural(row.needs.blocked_by, 'task')}`
            : 'paused',
        date: due ? `due ${dayOf(due)}` : end ? `planned ${weekOf(end)}` : null,
      }
  }
}

/** What a row says of its other kinds, after its place: the task it
    blocks, its blockers, how long it waits for a reviewer, its pause. */
export function reasonsOf(
  row: ViewRow & {
    needs: {
      also: readonly NeedsKind[]
      blocked_by: number
      blocks?: { count: number; first: { title: string } } | null
    }
  },
): string[] {
  const out: string[] = []
  const { needs } = row
  const kinds = needs.also
  if (needs.blocks)
    out.push(
      `blocks ${needs.blocks.first.title}${needs.blocks.count > 1 ? ` and ${plural(needs.blocks.count - 1, 'more')}` : ''}`,
    )
  if (kinds.includes('blocked')) out.push(`blocked by ${plural(needs.blocked_by, 'task')}`)
  if (kinds.includes('no_reviewer')) {
    const days = row.review_at ? daysSince(Date.parse(row.review_at), Date.now()) : null
    out.push(
      days === null
        ? 'no reviewer'
        : days <= 0
          ? 'no reviewer since today'
          : `no reviewer for ${plural(days, 'day')}`,
    )
  }
  if (kinds.includes('paused')) out.push('paused')
  return out
}

/** Focus props for a control that a change can take away, and `held()`,
    whether focus was on it when it went, which answers once. */
export function useHeldFocus() {
  // React hears no blur from an element it removes while it has focus, so
  // the flag stays set through the removal
  const on = useRef(false)
  return {
    props: {
      onFocus: () => {
        on.current = true
      },
      // a window that loses focus blurs the control and keeps it focused
      onBlur: (e: FocusEvent) => {
        if (document.activeElement !== e.target) on.current = false
      },
    },
    held: () => {
      const was = on.current
      on.current = false
      return was
    },
  }
}

/**
 * Where focus goes once a change takes the row it is in out of a list: the
 * same row where it shows elsewhere on the page, else the next row, else
 * the one before, else the list's heading. Each row carries `data-<mark>`
 * (its handle) and `data-<mark>-id` (its task's uuid) and calls `focusIn`
 * as focus enters it, with the `data-focus-key` of the element focused, and
 * `focusOut` as focus leaves an element of it; `shows` says whether the
 * list still shows a uuid. Focus goes to the element of the same key in
 * the row it lands on, else to its `row` one.
 */
export function useRowFocus(
  mark: string,
  shows: (uuid: string) => boolean,
  heading: () => HTMLElement | null | undefined,
) {
  const attr = `data-${mark}`
  const idKey = `${mark}Id`
  const focused = useRef<{ uuid: string; target: () => HTMLElement | null } | null>(null)
  const focusIn = (handle: string, uuid: string, key?: string) => {
    focused.current = {
      uuid,
      target: focusAround(
        attr,
        handle,
        (row) =>
          (key && key !== 'row'
            ? row.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)
            : null) ?? row.querySelector<HTMLElement>('[data-focus-key="row"]'),
        () => headingTarget(heading()) ?? null,
      ),
    }
  }
  // a window that loses focus blurs the row and keeps it focused
  const focusOut = (e: FocusEvent) => {
    if (document.activeElement !== e.target) focused.current = null
  }
  const was = focused.current
  const [, marked] = useState(0)
  useFocusWhenGone(was === null || shows(was.uuid), () => {
    const to = focused.current ? focused.current.target() : null
    // a window in the background sends no focus event for the row focus
    // moves to, so the mark follows it here, and a render lets the hook see
    // that row on the page before it can leave too
    const row = to?.closest<HTMLElement>(`[${attr}]`)
    const handle = row?.getAttribute(attr)
    const uuid = row?.dataset[idKey]
    if (handle && uuid) {
      focusIn(handle, uuid, to?.dataset.focusKey)
      marked((n) => n + 1)
    }
    return to
  })
  return { focusIn, focusOut }
}

/** The Late tasks by due date a milestone line counts. */
export type LateDays = readonly { due: string; count: number }[]

/** The line under an upcoming milestone: how many Late tasks are due on or
    before the first day of its week, in the calendar of its organization,
    whose weeks start on `weekStart`, so every reader cuts at the same day;
    those due by the cut-off day of `before`, the milestone shown above it,
    left out. Which milestone is shown above it follows the reader's own
    weeks. */
export function lateLine(
  days: LateDays,
  m: MilestoneVM,
  before: MilestoneVM | null,
  weekStart: number,
): string {
  const upTo = (row: MilestoneVM) => {
    const day = firstDayOfWeek(row.day, weekStart)
    return days.reduce((n, d) => (d.due <= day ? n + d.count : n), 0)
  }
  const n = upTo(m) - (before ? upTo(before) : 0)
  const late = DELAY_LABELS.late.toLowerCase()
  if (before === null)
    return n === 0
      ? `No ${late} task is due before it`
      : `${plural(n, `${late} task`)} ${n === 1 ? 'is' : 'are'} due before it`
  return n === 0
    ? `No other ${late} task is due before it`
    : `${n} more ${late} ${n === 1 ? 'task is' : 'tasks are'} due before it`
}

/** The line a milestone shows where its Late tasks could not be counted. */
export const LATE_UNKNOWN = `Qivo could not count the ${DELAY_LABELS.late.toLowerCase()} tasks due before it`

/** What My view's notes add where a read needs more reads than one
    request allows, as My view cannot choose fewer projects. */
export const MINE_MILESTONES_HINT = 'Open a project to see its milestones.'

/** My view's note where the person's own work lies in more top-level
    projects than one read names (LIMITS.milestoneProjects), in place of
    the limit's sentence, which asks to choose fewer projects, something My
    view cannot do. */
export const MINE_TOO_MANY = `Your work spans more than ${grouped(LIMITS.milestoneProjects.max)} projects, so their milestones are not listed here. ${MINE_MILESTONES_HINT}`
