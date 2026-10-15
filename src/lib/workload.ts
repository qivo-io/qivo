/* Planning uses the effective owner's capacity: the reviewer during review,
   otherwise the assignee. Hidden projects still contribute organization-wide
   load; presentation folds them into an anonymous "Other projects" bucket.
   The spread rule lives in convex/lib/workload.ts, which the REST and MCP
   workload read shares. */

import {
  committedByWeek,
  type LoadSpan,
  spreadWindow,
  type WeekRange,
} from '../../convex/lib/workload'

export { committedByWeek, type LoadSpan, spreadWindow, type WeekRange }

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

/** Is this a capacity that can be divided by and written down? Everything that
    prints an hours figure or a load percentage has to ask, because an agent's
    is neither: `0 / Infinity * 100` is 0, but `0 * Infinity` is NaN. */
export function hasPlannableWeek(cap: number): boolean {
  return Number.isFinite(cap)
}

/** Hours as the load surfaces print them: at most one decimal, no trailing zero. */
export function fmtHours(value: number): string {
  const scaled = value * 10
  return String(Number.isFinite(scaled) ? Math.round(scaled) / 10 : value)
}

export type LoadTone = 'over' | 'near' | 'normal'

/** The Team strip's colour rule for one person-week, judged on the ROUNDED
    percentage: over above 100%, near from 90%. The Team sync's load figures
    share it, so the two surfaces can never disagree about a week. */
export function loadTone(pct: number): LoadTone {
  return pct > 100 ? 'over' : pct >= 90 ? 'near' : 'normal'
}

export type LoadItem = {
  issueUuid: string | null // null when the caller can't see the project
  projectId: string | null
  projectName: string | null
  start: number // week index (inclusive)
  end: number // week index (inclusive)
  remaining: number // hours; 0 when unset
  remainingSet?: number | null // week the remaining hours were measured (remaining_set_at)
  visible: boolean
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

/* Resource views group the same spread by project. Paused tasks consume no
   capacity; their planned weeks are marked separately. */

export type PersonWeekLoad = Map<number, Map<string, number>> // week → (projectId → hours)

export type LoadIssue = {
  owner: string | null // the effective owner (IssueVM.owner)
  project: string
  start: number | null
  end: number | null
  remaining?: number
  remainingSet?: number | null
  paused?: boolean
}

/** person id → (week → (project id → committed hours)) over their owned
    issues. `inScope`, when given, keeps only issues whose project passes it
    (the "this project only" view). Paused issues add nothing;
    `pausedWeeksByPerson` marks where they sit. `range` limits the answer to
    the weeks a view shows, as committedByWeek's does. */
export function issueLoadByPerson(
  issues: LoadIssue[],
  inScope?: (projectId: string) => boolean,
  range?: WeekRange,
): Map<string, PersonWeekLoad> {
  const out = new Map<string, PersonWeekLoad>()
  for (const it of issues) {
    if (it.paused || !it.owner || it.start == null || it.end == null) continue
    if (inScope && !inScope(it.project)) continue
    const win = spreadWindow(it.start, it.end, it.remainingSet)
    const span = win.end - win.start + 1
    if (span <= 0) continue
    const per = (it.remaining || 0) / span
    if (per <= 0) continue
    const first = range === undefined ? win.start : Math.max(win.start, range.from)
    const last = range === undefined ? win.end : Math.min(win.end, range.to)
    if (first > last) continue
    let wl = out.get(it.owner)
    if (!wl) {
      wl = new Map()
      out.set(it.owner, wl)
    }
    for (let w = first; w <= last; w++) {
      let pm = wl.get(w)
      if (!pm) {
        pm = new Map()
        wl.set(w, pm)
      }
      pm.set(it.project, (pm.get(it.project) || 0) + per)
    }
  }
  return out
}

/** person id → the weeks their owned paused issues are planned in, over the
    whole planned period whatever the remaining hours (a pause is a fact about
    the week, not an amount). Same scope rule and `range` as
    `issueLoadByPerson`. */
export function pausedWeeksByPerson(
  issues: LoadIssue[],
  inScope?: (projectId: string) => boolean,
  range?: WeekRange,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const it of issues) {
    if (!it.paused || !it.owner || it.start == null || it.end == null) continue
    if (inScope && !inScope(it.project)) continue
    let weeks = out.get(it.owner)
    if (!weeks) {
      weeks = new Set()
      out.set(it.owner, weeks)
    }
    const first = range === undefined ? it.start : Math.max(it.start, range.from)
    const last = range === undefined ? it.end : Math.min(it.end, range.to)
    for (let w = first; w <= last; w++) weeks.add(w)
  }
  return out
}

export type LoadBucket = { projectId: string | null; name: string; hours: number; other: boolean }

/** The owner's committed hours over [wStart,wEnd] grouped by project, with
    every not-visible item folded into one "Other projects" bucket. Sorted
    biggest-first; the Other bucket always sorts last. */
export function loadByProject(
  items: LoadItem[],
  wStart: number,
  wEnd: number,
  excludeUuid?: string | null,
): LoadBucket[] {
  const named = new Map<string, LoadBucket>()
  let other: LoadBucket | null = null
  for (const it of items) {
    if (excludeUuid && it.issueUuid === excludeUuid) continue
    const win = spreadWindow(it.start, it.end, it.remainingSet)
    const span = win.end - win.start + 1
    if (span <= 0) continue
    const per = (it.remaining || 0) / span
    if (per <= 0) continue
    const overlap = Math.min(wEnd, win.end) - Math.max(wStart, win.start) + 1
    if (overlap <= 0) continue
    const hours = per * overlap
    if (it.visible && it.projectId) {
      const b = named.get(it.projectId) || {
        projectId: it.projectId,
        name: it.projectName || 'Project',
        hours: 0,
        other: false,
      }
      b.hours += hours
      named.set(it.projectId, b)
    } else {
      other = other || { projectId: null, name: 'Other projects', hours: 0, other: true }
      other.hours += hours
    }
  }
  const out = [...named.values()].sort((a, b) => b.hours - a.hours)
  if (other) out.push(other)
  return out
}
