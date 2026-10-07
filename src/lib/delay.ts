/* Estimate completion from the effective owner's free capacity, then compare
   it with the due date and plan. Estimates start at their measurement week,
   assuming progress since then; unfinished work cannot finish before today.
   Groups use their date envelope and descendant completion, not saved hours
   or status. The store decides whether the project displays delay. */

import { TODAY_WEEK } from './dates'
import { committedByWeek, fitEndWeek, type LoadSpan, prepareLoadProjection } from './workload'

export type DelayStatus = 'ok' | 'behind' | 'late'

export type DelayInfo = {
  status: DelayStatus
  fin: number | null // projected finish week index; null when 'late' rests on a passed due date alone
}

export type DelayIssue = {
  uuid: string
  status: string // workflow status; 'done' has no delay status
  isGroup?: boolean // active children make the saved status and own hours dormant
  isDone?: boolean // effective completion, derived from descendant leaves for groups
  owner: string | null // effective owner (IssueVM.owner): whose load and capacity it walks
  start: number | null // planned period, week indexes (end is the planned end)
  end: number | null
  dueWeek: number | null // due date floored to its week
  duePast: boolean // due date strictly before today (day precision)
  remaining?: number // hours of work left; unset gives no projection basis (0 does: it means "nothing left")
  remainingSet?: number | null // week the remaining hours were measured (remaining_set_at); today when absent
  capacity: number // the owner's own plannable hours per week (0092); Infinity for an agent (0103)
}

/** Delay status for one issue given its owner's org-wide load. */
export function delayOf(it: DelayIssue, load: LoadSpan[]): DelayInfo | null {
  return delayWithProjection(it, (from, remaining, capacity) =>
    fitEndWeek(from, remaining, capacity, committedByWeek(load, it.uuid)),
  )
}

function delayWithProjection(
  it: DelayIssue,
  project: (from: number, remaining: number, capacity: number, owner: string) => number,
): DelayInfo | null {
  if (it.isDone ?? (!it.isGroup && it.status === 'done')) return null
  let fin: number | null = null
  if (!it.isGroup && it.owner && it.remaining != null && it.capacity > 0) {
    // Start no earlier than the plan or measurement. Zero is a completed
    // estimate, while undefined falls back to the planned end below.
    const anchor = it.remainingSet != null ? it.remainingSet : TODAY_WEEK
    const from = it.start != null ? Math.max(it.start, anchor) : anchor
    fin = Math.max(TODAY_WEEK, project(from, it.remaining, it.capacity, it.owner))
  } else if (it.end != null) {
    fin = Math.max(it.end, TODAY_WEEK)
  }
  if (it.duePast || (it.dueWeek != null && fin != null && fin > it.dueWeek))
    return { status: 'late', fin }
  if (fin == null) return null
  if (it.end != null && fin > it.end) return { status: 'behind', fin }
  if (it.end != null || it.dueWeek != null) return { status: 'ok', fin }
  return null // nothing to be on track against
}

/** Task delays share each effective owner's organization-wide load index. */
export function computeDelayMap(
  issues: DelayIssue[],
  loadByOwner: Map<string, LoadSpan[]>,
): Map<string, DelayInfo> {
  const out = new Map<string, DelayInfo>()
  const projections = new Map<string, ReturnType<typeof prepareLoadProjection>>()
  for (const it of issues) {
    const info = delayWithProjection(it, (from, remaining, capacity, owner) => {
      let project = projections.get(owner)
      if (!project) {
        project = prepareLoadProjection(loadByOwner.get(owner) || [])
        projections.set(owner, project)
      }
      return project(from, remaining, capacity, it.uuid)
    })
    if (info) out.set(it.uuid, info)
  }
  return out
}

/* Presentation constants — token references, not hex: surfaces that need a
   translucent fill derive it with color-mix(), which works on a var() the way
   suffixing alpha only worked on a literal.
   `ok` is deliberately null. On track is the ordinary state, and the ordinary
   state is drawn as nothing — only pressure earns a colour. */
export const DELAY_COLORS: Record<DelayStatus, string | null> = {
  ok: null,
  behind: 'var(--pressure-warn)',
  late: 'var(--pressure-over)',
}
export const DELAY_NEUTRAL = null // done / no status, when the project tracks delay: also drawn as nothing
export const DELAY_LABELS: Record<DelayStatus, string> = {
  ok: 'On track',
  behind: 'Currently delayed',
  late: 'Delayed',
}
/* The task window's mark for the two pressure states: an `Icon` name and the
   glyph's colour (the words beside it stay plain — coloured text reads poorly
   on the dark surfaces). `ok` has no entry — on track is drawn as nothing, the
   same rule DELAY_COLORS states above. */
export const DELAY_MARK: Record<Exclude<DelayStatus, 'ok'>, { glyph: string; color: string }> = {
  behind: { glyph: 'clockFading', color: 'var(--pressure-warn)' },
  late: { glyph: 'warning', color: 'var(--pressure-over)' },
}
