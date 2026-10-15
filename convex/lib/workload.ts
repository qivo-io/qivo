/* How a task's remaining hours spread over the weeks, the one rule the app's
 * capacity views (src/lib/workload.ts re-exports these) and the REST and MCP
 * workload read (convex/planning.ts workloadCore) share. Weeks are integer
 * indexes on one grid; weekGrid maps a deployment's dates onto it. */

/** The slice of a load item the capacity math reads, which is also the
 * shape of a plan_org_load row once its dates are week indexes. */
export type LoadSpan = {
  issueUuid: string | null
  start: number
  end: number
  remaining: number
  remainingSet?: number | null
}

/** The weeks an issue's remaining hours actually spread over. `remaining` is a
    measurement taken in `remainingSet`: work before that moment is already excluded
    from it, so the spread runs from there, never before the planned start
    (nothing happens before the issue begins, which also covers a future start:
    the hours then spread over the whole planned interval), and never empty (an
    estimate saved after the planned end piles into its own week instead of
    vanishing). No `remainingSet` means no measurement moment, so the plain span. */
export function spreadWindow(
  start: number,
  end: number,
  remainingSet?: number | null,
): { start: number; end: number } {
  if (remainingSet == null) return { start, end } // raw span, inverted ones stay dropped by the callers
  const s = Math.max(start, remainingSet)
  return { start: s, end: Math.max(end, s) }
}

/** Week indexes `from` to `to`, both included. */
export type WeekRange = { from: number; to: number }

/** Hours the owner is committed to per week, spreading each issue's
    remaining hours evenly across its spread window. `excludeUuid` drops the
    issue being planned so it doesn't compete with itself. `range` limits the
    answer to the weeks a caller reads. Each issue still divides its hours by
    its whole spread window, but only the weeks in the range are added up, so
    a plan that runs to the year 9999 costs no more than the range. A week in
    the range holds exactly what the answer without a range holds. */
export function committedByWeek(
  items: LoadSpan[],
  excludeUuid?: string | null,
  range?: WeekRange,
): Map<number, number> {
  const m = new Map<number, number>()
  for (const it of items) {
    if (excludeUuid && it.issueUuid === excludeUuid) continue
    const win = spreadWindow(it.start, it.end, it.remainingSet)
    const span = win.end - win.start + 1
    if (span <= 0) continue
    const per = (it.remaining || 0) / span
    if (per <= 0) continue
    const first = range === undefined ? win.start : Math.max(win.start, range.from)
    const last = range === undefined ? win.end : Math.min(win.end, range.to)
    for (let w = first; w <= last; w++) m.set(w, (m.get(w) || 0) + per)
  }
  return m
}

const DAY = 86_400_000
const WEEK = 7 * DAY

/** The week grid of an organization whose weeks begin on `weekStart`. */
export type WeekGrid = {
  /** the week holding a YYYY-MM-DD day */
  ofDay: (day: string) => number
  /** the week holding an ISO timestamp, by its UTC day */
  ofInstant: (instant: string) => number
  /** the YYYY-MM-DD first day of a week */
  firstDay: (week: number) => string
}

/**
 * The week grid for weeks that begin on `weekStart` (0 Sunday to 6
 * Saturday; anything else means Monday, as the app's setWeekConfig does).
 * The server reads days in UTC; the app reads a timestamp in the browser's
 * time zone, which can put a measurement made near midnight in the next or
 * previous week.
 */
export function weekGrid(weekStart: number): WeekGrid {
  const startDay = Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6 ? weekStart : 1
  // the first day of the week holding 1970-01-01, index 0
  const origin = -((new Date(0).getUTCDay() - startDay + 7) % 7) * DAY
  const weekOf = (ms: number): number => {
    const midnight = Math.floor(ms / DAY) * DAY
    const first = midnight - ((new Date(midnight).getUTCDay() - startDay + 7) % 7) * DAY
    return Math.round((first - origin) / WEEK)
  }
  return {
    ofDay: (day) => weekOf(Date.parse(`${day}T00:00:00.000Z`)),
    ofInstant: (instant) => weekOf(Date.parse(instant)),
    firstDay: (week) => new Date(origin + week * WEEK).toISOString().slice(0, 10),
  }
}
