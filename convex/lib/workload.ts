/* How a task's remaining hours spread over the weeks, how an owner's tasks
 * share their weekly hours when a week is overbooked, and the end Auto-fit
 * gives a task. The app's capacity views read the spread (src/lib/workload.ts
 * re-exports these), as do the REST and MCP workload pages
 * (lib/ownerLoads.ts weeklyHours). Delay verdicts (lib/delay.ts,
 * lib/machineDelay.ts) and Auto-fit read the shared walk (shareOwnerWeeks,
 * autoFitEndWeek). Weeks are integer indexes on one grid; weekGrid maps a
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

/** How many overbooked weeks the shared walk (shareOwnerWeeks) follows,
    how many weeks a free-hours fit looks at from its first week, and how
    many end weeks Auto-fit (autoFitEndWeek) tries. */
export const PROJECTION_WEEKS = 520

/* Hours left at or below this count as none in a free-hours fit. */
const DONE = 1e-9

/* Asks over the weekly hours by no more than this still fit them, as
   asks that fill a week exactly can add up a little over it. */
const FITS = 1e-9

/* How many asks the walks of one Auto-fit (autoFitEndWeek) may add up,
   past the walk of the owner's other tasks, before it stops trying ends. */
const FIT_ASKS = 1_000_000

let walkSteps = 0

/** How many steps the shared walk has taken so far, in this module
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

/* A task in a walk, with its hours left, its ask this week and the week it
   finished, Infinity until it does. */
type Task = SharedSpan & { left: number; ask: number; fin: number }

const taskOf = (span: SharedSpan): Task => ({
  ...span,
  left: span.remaining,
  ask: 0,
  fin: Infinity,
})

/* A walk so far: the week it is at, its tasks with hours in walk order, how
   many of them have started, the started ones it has not finished, how
   many overbooked weeks it has taken, the hours it gave in each run of
   weeks in week order, the week it stopped at its bound, and how many asks
   it has added up. */
type Walk = {
  week: number
  tasks: Task[]
  next: number
  active: Task[]
  overbooked: number
  used: { from: number; to: number; hours: number }[]
  stopped: number | null
  asks: number
}

const walkOf = (tasks: Task[]): Walk => ({
  week: -Infinity,
  tasks: tasks.filter((t) => t.remaining > 0).sort(byShared),
  next: 0,
  active: [],
  overbooked: 0,
  used: [],
  stopped: null,
  asks: 0,
})

/* Walk `w` on, sharing `cap` hours a week, through the weeks before week
   `stop`, or to its end. */
function advance(w: Walk, cap: number, stop: number): void {
  while (w.week < stop && (w.active.length > 0 || w.next < w.tasks.length)) {
    if (w.active.length === 0) {
      const first = w.tasks[w.next].from
      if (first >= stop) {
        w.week = stop
        return
      }
      w.week = Math.max(w.week, first)
    }
    while (w.next < w.tasks.length && w.tasks[w.next].from <= w.week)
      w.active.push(w.tasks[w.next++])
    let total = 0
    for (const t of w.active) {
      t.ask = w.week < t.end ? t.left / (t.end - w.week + 1) : t.left
      total += t.ask
    }
    w.asks += w.active.length
    const fits = total <= cap + FITS
    if (!fits && w.overbooked === PROJECTION_WEEKS) {
      for (const t of [...w.active, ...w.tasks.slice(w.next)]) t.fin = Math.max(t.end, w.week)
      w.used.push({ from: w.week, to: Infinity, hours: cap })
      w.stopped = w.week
      w.active = []
      w.next = w.tasks.length
      return
    }
    walkSteps += 1
    if (!fits) {
      // The week gives out all the capacity, so the hours left of the
      // started tasks fall by the capacity, and their asks fit once those
      // hours are no more than it.
      w.overbooked += 1
      const share = cap / total
      w.used.push({ from: w.week, to: w.week, hours: cap })
      // an endless ask makes the share 0, and Infinity * 0 is NaN
      if (share > 0) for (const t of w.active) t.left -= t.ask * share
      w.week += 1
      continue
    }
    // Every ask fits until the next task starts, and an ask met in full
    // asks the same the week after, so each task runs its plan out.
    const until = Math.min(stop - 1, w.next < w.tasks.length ? w.tasks[w.next].from - 1 : Infinity)
    const week = w.week
    const ending = w.active
      .filter((t) => t.end <= until)
      .sort((a, b) => Math.max(week, a.end) - Math.max(week, b.end))
    let from = week
    let hours = total
    for (const t of ending) {
      t.fin = Math.max(week, t.end)
      if (t.fin >= from) w.used.push({ from, to: t.fin, hours })
      from = t.fin + 1
      hours -= t.ask
    }
    w.active = w.active.filter((t) => t.end > until)
    for (const t of w.active) t.left -= t.ask * (until - week + 1)
    if (w.active.length > 0 && from <= until) w.used.push({ from, to: until, hours })
    w.week = until + 1
  }
}

/* Walk `w` as it stands, to go on from with other tasks. */
function copyOf(w: Walk): Walk {
  const started = new Set(w.active)
  const tasks = w.tasks.map((t) => ({ ...t }))
  const active = tasks.filter((_, i) => i < w.next && started.has(w.tasks[i]))
  return { ...w, tasks, active, used: [], asks: 0 }
}

/* The week the hours a walk leaves free, `cap` a week less those it gave
   in the runs `used`, cover `remaining` hours from week `from`, within
   PROJECTION_WEEKS weeks of `from`, else the last of them. */
function fitFreeIn(used: Walk['used'], cap: number, from: number, remaining: number): number {
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
}

/** What one owner's shared walk answers. */
export type OwnerWeeks = {
  /** the week each of `spans` finishes, in the order given, its first week
      for one without hours left */
  finishes: number[]
  /** the week the hours the walk leaves free cover `remaining` hours from
      week `from`, within PROJECTION_WEEKS weeks of `from`, else the last of
      them; a walk stopped at its bound leaves no hours free from the week it
      stopped at */
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
 * is later, and the walk leaves no hours free from that week on.
 */
export function shareOwnerWeeks(spans: readonly SharedSpan[], capacity: number): OwnerWeeks {
  const cap = Math.max(0, capacity)
  const all = spans.map(taskOf)
  const walk = walkOf(all)
  advance(walk, cap, Infinity)
  return {
    finishes: all.map((t) => (t.remaining > 0 ? t.fin : t.from)),
    fitFree: (from, remaining) => fitFreeIn(walk.used, cap, from, remaining),
  }
}

/** A task as Auto-fit places it: its id, the week it starts, its hours
    left, the week they were measured, and whether it is paused. */
export type FitTask = {
  issueUuid: string
  start: number
  remaining: number
  remainingSet?: number | null
  paused?: boolean
}

/**
 * The end week Auto-fit gives `task` among its owner's load `load`, the
 * owner having `capacity` hours a week, judged in week `todayWeek`: the
 * earliest end at which the owner's shared walk (shareOwnerWeeks), with the
 * task planned to end then, finishes the task by that end, so that its
 * delay verdict (lib/delay.ts) is not Behind plan. The task's own spans in
 * the load are left out. The task takes part from the week its hours were
 * measured, or `todayWeek` without a measurement, or its start when that
 * is later, and its end is no earlier than that week or `todayWeek`. A
 * paused task asks for no hours, so it ends when the hours the walk leaves
 * free cover it.
 *
 * The search tries PROJECTION_WEEKS ends. It skips an end in whose week the
 * other tasks leave fewer free hours than the task's even share, which no
 * walk with the task can fit, and stops trying once its walks have added up
 * FIT_ASKS asks. Without an end that works it gives the last end it could
 * try, as a free-hours fit does for an owner without free hours. An agent's
 * unlimited hours fit every ask, so its task ends in that first week.
 */
export function autoFitEndWeek(
  load: readonly LoadSpan[],
  task: FitTask,
  capacity: number,
  todayWeek: number,
): number {
  const from = Math.max(task.start, task.remainingSet ?? todayWeek)
  const first = Math.max(from, todayWeek)
  const last = first + PROJECTION_WEEKS - 1
  if (!(task.remaining > 0) || capacity === Infinity) return first
  const cap = Math.max(0, capacity)
  const others = load
    .filter((span) => span.issueUuid !== task.issueUuid)
    .map((span) => taskOf(sharedSpanOf(span, todayWeek)))
  const rest = walkOf(others)
  advance(rest, cap, from)
  const before = copyOf(rest)
  advance(rest, cap, Infinity)
  if (task.paused) return Math.max(first, fitFreeIn(rest.used, cap, from, task.remaining))
  let asks = 0
  let run = 0
  for (let end = first; end <= last && asks <= FIT_ASKS; end++) {
    while (run < rest.used.length && rest.used[run].to < end) run++
    const at = rest.used[run]
    const given = at !== undefined && at.from <= end ? at.hours : 0
    // the task asks in its last week at least its hours spread evenly
    if (given + task.remaining / (end - from + 1) > cap + 2 * FITS) continue
    const walk = copyOf(before)
    const own = taskOf({ issueUuid: task.issueUuid, from, end, remaining: task.remaining })
    let place = walk.next
    while (place < walk.tasks.length && byShared(walk.tasks[place], own) <= 0) place++
    walk.tasks.splice(place, 0, own)
    advance(walk, cap, end + 1)
    if (walk.stopped === null && own.fin === end) return end
    asks += walk.asks
  }
  return last
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
