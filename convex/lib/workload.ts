/* How a task's remaining hours spread over the weeks, when an owner's free
 * capacity finishes them, and how an owner's tasks share their weekly hours
 * when a week is overbooked. The app's capacity views and Auto-fit read the
 * spread and the fit (src/lib/workload.ts re-exports these), as do the REST
 * and MCP workload pages (lib/ownerLoads.ts weeklyHours). Delay verdicts
 * (lib/delay.ts, lib/machineDelay.ts) read the shared walk
 * (shareOwnerWeeks). Weeks are integer indexes on one grid; weekGrid maps a
 * deployment's dates onto it. */

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

/** How many overbooked weeks the shared walk (shareOwnerWeeks) follows,
    and how many weeks a free-hours fit looks at from its first week. */
export const PROJECTION_WEEKS = 520

/* Hours left at or below this count as none, as in fitEndWeek. */
const DONE = 1e-9

/* Asks over the weekly hours by no more than this still fit them, as
   asks that fill a week exactly can add up a little over it. */
const FITS = 1e-9

let walkSteps = 0

/** How many steps shareOwnerWeeks has taken so far, in this module
    instance, a run of weeks or one overbooked week each. A test reads it
    before and after a call to measure the call's work without a clock. */
export function walkStepsSoFar(): number {
  return walkSteps
}

/** One task in its owner's shared walk: it asks for hours from week
    `from`, with `remaining` hours left then, and its plan ends in week
    `end`, never before `from`. */
export type SharedSpan = { issueUuid: string | null; from: number; end: number; remaining: number }

/** Load span `span` in the shared walk, judged in week `todayWeek`. It takes
    part from the week its hours were measured, or `todayWeek` without a
    measurement, or its planned start when that is later, which also covers
    a future start. Its plan ends at its planned end, or in that first week
    when the plan ended before it, as spreadWindow piles such hours. */
export function sharedSpanOf(span: LoadSpan, todayWeek: number): SharedSpan {
  const from = Math.max(span.start, span.remainingSet ?? todayWeek)
  return {
    issueUuid: span.issueUuid,
    from,
    end: Math.max(span.end, from),
    remaining: span.remaining,
  }
}

/* The walk's one order of its tasks: by first week, plan end, hours and
   task id, a hidden row's null first. Each week's asks add up in it, so the
   answer is the same however the rows arrive. */
const byShared = (a: SharedSpan, b: SharedSpan) =>
  a.from - b.from || a.end - b.end || a.remaining - b.remaining || order(a.issueUuid, b.issueUuid)

/** What one owner's shared walk answers. */
export type OwnerWeeks = {
  /** the week each of `spans` finishes, in the order given, its first week
      for one without hours left */
  finishes: number[]
  /** the week the hours the walk leaves free cover `remaining` hours from
      week `from`, as fitEndWeek fits against committed hours, within
      PROJECTION_WEEKS weeks of `from` */
  fitFree(from: number, remaining: number): number
}

/**
 * One owner's tasks `spans` sharing `capacity` hours a week, walked week by
 * week from the earliest task's first week. In each week every task that
 * has started and has hours left asks for its hours left divided by the
 * weeks left in its plan, this week included, or for all its hours left
 * once its plan has ended. When the asks fit in the capacity, or exceed it
 * by no more than rounding, every task gets its ask; when they do not, the
 * week is overbooked, every task gets the same share of its ask and keeps
 * the rest for the next week. A task finishes in the first week in which it
 * gets all its hours left, so in a week whose asks fit and in which it asks
 * for all it has left. An overbooked week finishes no task, and a task that
 * gets its ask every week finishes in its plan's last week.
 *
 * A stretch of weeks in which the asks fit and no task starts takes one
 * step, so a plan that runs to the year 9999 costs no more than its start
 * and end. Overbooked weeks take one step each, and the walk stops at the
 * overbooked week after PROJECTION_WEEKS of them. A task it has not
 * finished by then finishes in that week or at its planned end, whichever
 * is later.
 */
export function shareOwnerWeeks(spans: readonly SharedSpan[], capacity: number): OwnerWeeks {
  const cap = Math.max(0, capacity)
  let overbooked = 0
  type Task = SharedSpan & { left: number; ask: number; fin: number }
  const finishes = spans.map((s) => s.from)
  const all = spans.map((s): Task => ({ ...s, left: s.remaining, ask: 0, fin: s.end }))
  const tasks = all.filter((t) => t.remaining > 0).sort(byShared)
  // the hours the walk gives in each run of weeks, in week order
  const used: { from: number; to: number; hours: number }[] = []
  let next = 0
  let active: Task[] = []
  let week = tasks.length > 0 ? tasks[0].from : 0
  while (active.length > 0 || next < tasks.length) {
    if (active.length === 0) week = Math.max(week, tasks[next].from)
    while (next < tasks.length && tasks[next].from <= week) active.push(tasks[next++])
    let total = 0
    for (const t of active) {
      t.ask = week < t.end ? t.left / (t.end - week + 1) : t.left
      total += t.ask
    }
    const fits = total <= cap + FITS
    if (!fits && overbooked === PROJECTION_WEEKS) {
      for (const t of [...active, ...tasks.slice(next)]) t.fin = Math.max(t.end, week)
      break
    }
    walkSteps += 1
    if (!fits) {
      // The week gives out all the capacity, so the hours left of the
      // started tasks fall by the capacity, and their asks fit once those
      // hours are no more than it.
      overbooked += 1
      const share = cap / total
      used.push({ from: week, to: week, hours: cap })
      // an endless ask makes the share 0, and Infinity * 0 is NaN
      if (share > 0) for (const t of active) t.left -= t.ask * share
      week += 1
      continue
    }
    // Every ask fits until the next task starts, and an ask met in full
    // asks the same the week after, so each task runs its plan out.
    const until = next < tasks.length ? tasks[next].from - 1 : Infinity
    const ending = active
      .filter((t) => t.end <= until)
      .sort((a, b) => Math.max(week, a.end) - Math.max(week, b.end))
    let from = week
    let hours = total
    for (const t of ending) {
      t.fin = Math.max(week, t.end)
      if (t.fin >= from) used.push({ from, to: t.fin, hours })
      from = t.fin + 1
      hours -= t.ask
    }
    active = active.filter((t) => t.end > until)
    for (const t of active) t.left -= t.ask * (until - week + 1)
    if (active.length > 0 && from <= until) used.push({ from, to: until, hours })
    week = until + 1
  }
  all.forEach((t, i) => {
    if (t.remaining > 0) finishes[i] = t.fin
  })
  return {
    finishes,
    fitFree(from, remaining) {
      if (!(remaining > 0) || remaining <= DONE) return from
      const end = from + PROJECTION_WEEKS - 1
      let left = remaining
      let i = 0
      while (i < used.length && used[i].to < from) i++
      for (let w = from; w <= end; ) {
        const run = used[i]
        const busy = run !== undefined && run.from <= w
        const to = Math.min(end, busy ? run.to : run === undefined ? end : run.from - 1)
        const free = cap - (busy ? run.hours : 0)
        if (busy) i++
        if (free > 0) {
          const weeks = Math.max(1, Math.ceil((left - DONE) / free))
          if (weeks <= to - w + 1) return w + weeks - 1
          left -= free * (to - w + 1)
        }
        w = to + 1
      }
      return end
    },
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
