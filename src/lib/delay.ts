/* The app's delay verdicts, on its week grid where the current week is
   TODAY_WEEK. The rules live in convex/lib/delay.ts, which the REST and MCP
   task reads share. The store decides whether the project displays delay. */

import {
  type DelayInfo,
  type DelayIssue,
  type DelayStatus,
  computeDelayMap as delayMapOn,
  delayOf as delayOn,
  delayWithProjection,
} from '../../convex/lib/delay'
import { fitEndWeekAgainst } from '../../convex/lib/workload'
import { TODAY_WEEK } from './dates'
import type { LoadSpan } from './workload'

export type { DelayInfo, DelayIssue, DelayStatus }

/** Delay status for one issue given its owner's org-wide load. */
export const delayOf = (it: DelayIssue, load: LoadSpan[]): DelayInfo | null =>
  delayOn(it, load, TODAY_WEEK)

/** Task delays share each effective owner's organization-wide load index. */
export const computeDelayMap = (
  issues: DelayIssue[],
  loadByOwner: Map<string, LoadSpan[]>,
): Map<string, DelayInfo> => delayMapOn(issues, loadByOwner, TODAY_WEEK)

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

/** What the task window says of a delay it cannot judge from the owners'
    loads, while tasks still load or for a task it shows from its own read
    (delayBeforeLoads): the delay is not known. */
export const DELAY_UNKNOWN = 'unknown'

/** The task window's delay verdict for task `it` where the owners' loads
    are not there to judge it: while tasks still load, or for a task the
    window shows from its own read. A verdict that needs no owner's other
    work, as for a task without an owner, hours or capacity, one with no
    hours left, one an agent owns, or a group, is judged exactly
    (convex/lib/delay.ts delayWithProjection), so it is the verdict of
    every load. One that needs it is DELAY_UNKNOWN, unless it has nothing to be judged against,
    or its due date has passed, which needs no projection and draws as
    overdue: both answer null, which draws what the window draws without a
    verdict. A group whose dates are not known (`datesKnown` false), or
    that is partial while tasks still load (`loading`), whose subtasks
    still to come can move its end, is DELAY_UNKNOWN in the same way,
    unless the visible span already proves it late. */
export function delayBeforeLoads(
  it: DelayIssue,
  { datesKnown, loading }: { datesKnown: boolean; loading: boolean },
): DelayInfo | typeof DELAY_UNKNOWN | null {
  if (it.isDone ?? (!it.isGroup && it.status === 'done')) return null
  // a passed due date, or nothing to be on time for, needs no projection
  const unknown = it.duePast || (it.dueWeek === null && it.end === null) ? null : DELAY_UNKNOWN
  if (it.isGroup && !datesKnown) return it.duePast ? null : DELAY_UNKNOWN
  let asked = false
  const verdict = delayWithProjection(it, TODAY_WEEK, (from, remaining, capacity) => {
    // the fit reads the owner's other work only for hours left against a
    // finite capacity: none left, or an agent's unlimited time, finishes
    // at `from` whatever the load (convex/lib/workload.ts fitEndWeek)
    if (remaining > 0 && capacity < Infinity) asked = true
    return fitEndWeekAgainst([], it.uuid, from, remaining, capacity)
  })
  if (asked) return unknown
  if (it.isGroup && loading && it.partial) return verdict?.status === 'late' ? verdict : unknown
  return verdict
}
