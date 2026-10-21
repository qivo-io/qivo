/* How a task's remaining hours spread over the weeks and when an owner's
 * free capacity finishes them, the rules the app's capacity views and delay
 * projection (src/lib/workload.ts re-exports these) share with the REST and
 * MCP workload read (convex/planning.ts workloadCore) and delay verdicts
 * (lib/delay.ts, lib/machineDelay.ts). Weeks are integer indexes on one grid;
 * weekGrid maps a deployment's dates onto it. */

/** The slice of a load item the capacity math reads, which is also the
 * shape of a plan_org_load row once its dates are week indexes. */
export type LoadSpan = {
  issueUuid: string | null
  start: number
  end: number
  remaining: number
  remainingSet?: number | null
}

/* -1, 0 or 1 as `a` sorts before, with or after `b`, a null first. */
const order = <T extends number | string>(a: T | null | undefined, b: T | null | undefined) =>
  a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0

/** `spans` in one total order: by start, end, remaining hours, measurement
    week and task id, a missing one first. Weekly sums add floating point
    hours in list order, so the app and the REST and MCP reads sort an
    owner's load this way and add it up the same however its rows arrive.
    Sorts in place and answers `spans`. */
export function canonicalLoad<S extends LoadSpan>(spans: S[]): S[] {
  return spans.sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      a.remaining - b.remaining ||
      order(a.remainingSet, b.remainingSet) ||
      order(a.issueUuid, b.issueUuid),
  )
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

let weeksSpread = 0

/** How many week entries committedByWeek has added hours to so far, in this
    module instance. A test reads it before and after a call to measure the
    call's work without a clock. */
export function weeksSpreadSoFar(): number {
  return weeksSpread
}

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
    if (last >= first) weeksSpread += last - first + 1
    for (let w = first; w <= last; w++) m.set(w, (m.get(w) || 0) + per)
  }
  return m
}

/** Capacity when the person is missing; must match the organization default. */
export const DEFAULT_PLANNABLE_HOURS = 32

/** Agents have unlimited capacity; missing or legacy person values use the default. */
export function plannableHoursOf(
  user?: { plannableHours?: number | null; kind?: string | null; isAgent?: boolean } | null,
): number {
  if (user && (user.isAgent || user.kind === 'agent')) return Infinity
  const h = user?.plannableHours
  return h && h > 0 ? Number(h) : DEFAULT_PLANNABLE_HOURS
}

/** The week by which the owner's free capacity covers `remaining` hours,
    starting at `start`. Free capacity in week w = max(0, capacity - committed[w]);
    fully-booked weeks add nothing and push the end further out. Returns `start`
    when there's no remaining time, and is bounded so a fully-saturated owner
    (or zero capacity) can't loop forever. */
export function fitEndWeek(
  start: number,
  remaining: number,
  capacity: number,
  committed: Pick<ReadonlyMap<number, number>, 'get'>,
  maxWeeks = 520,
): number {
  if (!(remaining > 0)) return start
  const cap = Math.max(0, capacity)
  let left = remaining
  for (let w = start; w < start + maxWeeks; w++) {
    const free = Math.max(0, cap - (committed.get(w) || 0))
    left -= free
    if (left <= 1e-9) return w
  }
  return start + maxWeeks - 1
}

/** fitEndWeek against an owner's load. Only the weeks the fit can read,
    `maxWeeks` of them from `start`, are added up, so a plan that runs to the
    year 9999 costs no more than they do. */
export function fitEndWeekAgainst(
  load: LoadSpan[],
  excludeUuid: string | null | undefined,
  start: number,
  remaining: number,
  capacity: number,
  maxWeeks = 520,
): number {
  const committed = committedByWeek(load, excludeUuid, { from: start, to: start + maxWeeks - 1 })
  return fitEndWeek(start, remaining, capacity, committed, maxWeeks)
}

/** How many weeks of an owner's totals prepareLoadProjection adds up at once. */
const TOTALS_BLOCK = 64

/** Reuse one owner's weekly totals across projections. Each total is added
 * up on first use, TOTALS_BLOCK weeks at a time, so a plan that runs to the
 * year 9999 costs only the weeks the projections read. Near a completion
 * boundary, repeat the original ordered sum: subtracting self from a total
 * can lose small commitments to rounding and change the finish week. */
export function prepareLoadProjection(items: LoadSpan[]) {
  const blocks = new Map<number, Map<number, number>>()
  const totals = {
    get(week: number): number {
      const block = Math.floor(week / TOTALS_BLOCK)
      let byWeek = blocks.get(block)
      if (!byWeek) {
        const from = block * TOTALS_BLOCK
        byWeek = committedByWeek(items, null, { from, to: from + TOTALS_BLOCK - 1 })
        blocks.set(block, byWeek)
      }
      return byWeek.get(week) || 0
    },
  }
  const own = new Map<string, { start: number; end: number; per: number }[]>()
  // each week's total adds some of these hours in the same order, so no
  // total can exceed their sum, and all are finite when it is
  let sum = 0
  for (const it of items) {
    const win = spreadWindow(it.start, it.end, it.remainingSet)
    const span = win.end - win.start + 1
    const per = (it.remaining || 0) / span
    if (span <= 0 || per <= 0) continue
    sum += per
    if (!it.issueUuid) continue
    const spans = own.get(it.issueUuid) || []
    spans.push({ ...win, per })
    own.set(it.issueUuid, spans)
  }
  const finite = Number.isFinite(sum)
  return (
    start: number,
    remaining: number,
    capacity: number,
    excludeUuid?: string | null,
    maxWeeks = 520,
  ): number => {
    const exact = () => fitEndWeekAgainst(items, excludeUuid, start, remaining, capacity, maxWeeks)
    if (!(remaining > 0)) return start
    if (!finite || !Number.isFinite(remaining) || !Number.isFinite(capacity)) return exact()
    const self = excludeUuid ? own.get(excludeUuid) : undefined
    if (!self) return fitEndWeek(start, remaining, capacity, totals, maxWeeks)
    const cap = Math.max(0, capacity)
    let left = remaining
    let uncertainty = 0
    for (let w = start; w < start + maxWeeks; w++) {
      const total = totals.get(w)
      let excluded = 0
      for (const span of self) if (w >= span.start && w <= span.end) excluded += span.per
      const committed = Math.max(0, total - excluded)
      // Positive sums bound error by their total and addition count. Include
      // both summation orders, self subtraction, and accumulated solver error.
      uncertainty =
        (uncertainty +
          Number.EPSILON * 4 * (total * (items.length + 2) + Math.abs(left) + cap + committed) +
          Number.MIN_VALUE * items.length) *
        (1 + Number.EPSILON)
      left -= Math.max(0, cap - committed)
      if (Math.abs(left - 1e-9) <= uncertainty) return exact()
      if (left <= 1e-9) return w
    }
    return start + maxWeeks - 1
  }
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
