/* Timeline mapping — ports the prototype's week-indexed grid (data.js) onto
   real dates. The DB stores absolute week-start dates (ISO date strings —
   Mondays under the default settings); the client anchors the grid where the
   prototype did: week 0 starts 11 weeks before this week's first day, so
   "today" is mid-program. That anchor is an ORIGIN, not a viewport — indexes
   run negative and past 28, and each view clips to its own window instead.
   All math is done on local-midnight
   dates; ISO strings are built manually (never via toISOString) to avoid
   timezone drift on date-only values. */

export const WEEKS = 28 // the prototype grid's nominal span; nothing bounds a week by it
export const TODAY_WEEK = 11
const DAY = 86400000

/* --- organization week settings --------------------------------------------
   Which weekday each week begins on (the org's first workday) and which week
   is week 1 of the year — the parameterization Outlook and ICU/CLDR share:
   week 1 is the first week with at least `minDays` days in the new year,
   i.e. the week containing Jan (minDays).
     'jan1'      minDays 1 — week containing Jan 1 (North American calendars)
     'first4day' minDays 4 — first 4-day week (ISO 8601; week of Jan 4)
     'firstfull' minDays 7 — first full week (the week of Jan 7)
   Defaults are ISO 8601: Monday + first4day. */

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]
export const WEEK_ONE_RULES = ['jan1', 'first4day', 'firstfull'] as const
export type WeekOneRule = (typeof WEEK_ONE_RULES)[number]
export const DEFAULT_WEEK_START = 1 // JS Date#getDay numbering: Monday
export const DEFAULT_WEEK_ONE_RULE: WeekOneRule = 'first4day'
const WEEK_ONE_MIN_DAYS: Record<WeekOneRule, number> = { jan1: 1, first4day: 4, firstfull: 7 }

let weekStart: number = DEFAULT_WEEK_START
let weekOneRule: WeekOneRule = DEFAULT_WEEK_ONE_RULE

/** First day of d's week — the org's week-start day at local midnight. */
export function weekStartOf(d: Date): Date {
  const m = new Date(d)
  m.setHours(0, 0, 0, 0)
  const dow = (m.getDay() - weekStart + 7) % 7 // days since the week started
  m.setDate(m.getDate() - dow)
  return m
}

function computeTimelineStart(now: Date): Date {
  const d = weekStartOf(now)
  d.setDate(d.getDate() - TODAY_WEEK * 7)
  return d
}
const initialToday = new Date()
export let TIMELINE_START: Date = computeTimelineStart(initialToday)
export let TODAY_ISO = isoFromDate(initialToday)

/* Today at DAY precision — a FRACTIONAL index on the same week grid: the
   whole part is TODAY_WEEK, the fraction is how far into the week today
   falls (0 on the week's first workday, 6/7 on its last day). Scheduling
   math stays week-granular on TODAY_WEEK; the timeline's "today" marker uses
   this so the line sits on today's date instead of jumping back to the
   week's first day. Depends on the week start, so setWeekConfig re-derives
   it with TIMELINE_START. */
function computeTodayPos(now: Date): number {
  const t = new Date(now)
  t.setHours(0, 0, 0, 0)
  return Math.round((t.getTime() - TIMELINE_START.getTime()) / DAY) / 7
}
export let TODAY_POS: number = computeTodayPos(initialToday)

/** Apply the organization's week settings. Re-anchors the whole grid, so all
    stored week indexes must be re-derived afterwards — the store calls this
    at the top of rebuild(), before any isoToWeek conversion. */
export function setWeekConfig(start?: number | null, rule?: string | null, now = new Date()): void {
  weekStart =
    typeof start === 'number' && start >= 0 && start <= 6 ? Math.round(start) : DEFAULT_WEEK_START
  weekOneRule = (WEEK_ONE_RULES as readonly string[]).includes(rule as string)
    ? (rule as WeekOneRule)
    : DEFAULT_WEEK_ONE_RULE
  TIMELINE_START = computeTimelineStart(now)
  TODAY_POS = computeTodayPos(now)
  TODAY_ISO = isoFromDate(now)
}

export function weekToDate(w: number): Date {
  const d = new Date(TIMELINE_START)
  d.setDate(d.getDate() + Math.round(w * 7))
  return d
}

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/* --- organization date-format setting ----------------------------------- */
/* Full dates (due dates etc.) render in the organization's format; compact
   week labels only follow its day/month order. The date controls draw their
   own face AND calendar popup (components/index.tsx CalendarPop) — a native
   date input would follow the browser locale instead of the org settings. */

export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD'
export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD.MM.YYYY',
  'D MMM YYYY',
  'MMM D, YYYY',
]
let dateFormat = DEFAULT_DATE_FORMAT

export function setDateFormat(f?: string | null): void {
  dateFormat = f && DATE_FORMATS.includes(f) ? f : DEFAULT_DATE_FORMAT
}
export function fmtFullWith(f: string, d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0')
  const y = d.getFullYear(),
    mm = p2(d.getMonth() + 1),
    dd = p2(d.getDate())
  switch (f) {
    case 'DD/MM/YYYY':
      return `${dd}/${mm}/${y}`
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${y}`
    case 'DD.MM.YYYY':
      return `${dd}.${mm}.${y}`
    case 'D MMM YYYY':
      return `${d.getDate()} ${MONTHS[d.getMonth()]} ${y}`
    case 'MMM D, YYYY':
      return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${y}`
    default:
      return `${y}-${mm}-${dd}`
  }
}
export function fmtFull(d: Date): string {
  return fmtFullWith(dateFormat, d)
}
/** 24-hour wall-clock time, "09:05" — the app never shows AM/PM. */
export function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** An exact moment for hover help: the org's date format, then the time. */
export function fmtDateTime(d: Date): string {
  return `${fmtFull(d)} ${fmtTime(d)}`
}

export function fmtDate(d: Date): string {
  const monthFirst = dateFormat === 'MM/DD/YYYY' || dateFormat === 'MMM D, YYYY'
  return monthFirst
    ? `${MONTHS[d.getMonth()]} ${d.getDate()}`
    : `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
/* --- calendar week numbers ------------------------------------------------ */

function week1Start(year: number): Date {
  return weekStartOf(new Date(year, 0, WEEK_ONE_MIN_DAYS[weekOneRule]))
}

/** Calendar week number of week index w under the org's rule. The week-year
    can differ from the start date's year around New Year (ISO semantics). */
export function weekNumberOf(w: number): { year: number; num: number } {
  const s = weekToDate(w)
  const e = new Date(s)
  e.setDate(e.getDate() + 6)
  let year = e.getFullYear() // a Dec–Jan straddler may already be week 1 of the new year
  if (s.getTime() < week1Start(year).getTime()) year = s.getFullYear()
  return { year, num: Math.round((s.getTime() - week1Start(year).getTime()) / (7 * DAY)) + 1 }
}

export function weekNumLabel(w: number): string {
  return `W${weekNumberOf(w).num}`
}

export function weekLabel(w: number): string {
  return `${weekNumLabel(w)}, ${fmtDate(weekToDate(w))}`
}
/** A week in words relative to this one — "this week", "next week",
    "in 3 weeks", "last week", "2 weeks ago" — as the Overview's milestone
    rows and the Milestones window say it. */
export function relativeWeek(w: number): string {
  const d = w - TODAY_WEEK
  if (d === 0) return 'this week'
  if (d === 1) return 'next week'
  if (d === -1) return 'last week'
  return d > 0 ? `in ${d} weeks` : `${-d} weeks ago`
}
export function fmtRange(a: number, b: number): string {
  return `${fmtDate(weekToDate(a))} → ${fmtDate(weekToDate(b))}`
}

export function isoFromDate(d: Date): string {
  return (
    String(d.getFullYear()).padStart(4, '0') +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}
export function isoToDate(s: string): Date {
  const p = s.split('-').map(Number)
  const date = new Date(0)
  date.setHours(0, 0, 0, 0)
  date.setFullYear(p[0], p[1] - 1, p[2]) // Date's constructor maps years 0–99 into 1900–1999.
  return date
}
export function fmtISO(s: string): string {
  return fmtFull(isoToDate(s))
}

/* --- DB (ISO week-start date) ↔ week index ------------------------------- */

/** ISO date of week w's first day — what the DB stores for week-granular fields. */
export function weekToISO(w: number): string {
  return isoFromDate(weekToDate(w))
}

/** Week index of an ISO date that is (or should be treated as) a week start.
    Uses floor: any day within a week belongs to that week. */
export function isoToWeek(s: string): number {
  const d = weekStartOf(isoToDate(s))
  return Math.round((d.getTime() - TIMELINE_START.getTime()) / (7 * DAY))
}

/** Week index of a full timestamp (issues.remaining_set_at etc.) — the local
    week the moment falls in. Math.round absorbs the DST hour like isoToWeek. */
export function tsToWeek(ts: string): number {
  const d = weekStartOf(new Date(ts))
  return Math.round((d.getTime() - TIMELINE_START.getTime()) / (7 * DAY))
}

/** Picker rounding — the prototype's DateSelect rounds the picked day to the
    NEAREST week-grid start (late-week picks land on the following week).
    Unclamped, and there is no clamped twin: a `snapToWeek` used to pin the
    answer inside the prototype's 28-week viewport, which was right while that
    viewport was the whole roadmap and wrong the moment the visible range
    became a window you choose — it would drag a date a few months out back
    onto the edge of the grid. Week indexes are unbounded so a date outside
    the window survives the round trip. */
export function nearestWeek(s: string): number {
  const d = isoToDate(s)
  return Math.round((d.getTime() - TIMELINE_START.getTime()) / (7 * DAY))
}

/* --- sub-issue date envelope -----------------------------------------------
   Rule: an issue never starts after its earliest scheduled sub-issue, and
   never ends before its latest one. `env` is that envelope — the span
   [min earliest child start, max latest child end] over the DIRECT children
   that have dates; null when no scheduled children exist. */

export type DateEnvelope = { min: number; max: number }

/** Widen (never shrink) an issue's dates so they span its envelope. */
export function coverEnvelope(
  start: number,
  end: number,
  env: DateEnvelope | null,
): { start: number; end: number } {
  if (!env) return { start, end }
  return { start: Math.min(start, env.min), end: Math.max(end, env.max) }
}

/** Roadmap bar drag: window clamp plus the envelope pin.
    · d is the dragged distance in whole weeks; os/oe the committed span.
    · The window clamp keeps the bar intersecting [w0, w1] (a bar that leaves
      the window would unmount mid-drag and lose the release commit).
    · The envelope pin stops a parent bar from shrinking inside its
      sub-issues. Its bounds are relaxed to admit the bar's own committed
      position, so a bar that ALREADY violates the rule (legacy data) never
      teleports — it can be dragged toward compliance but not further out.
    · The pin is applied after the window clamp: when the two disagree the
      envelope wins (the rule is an invariant, the window only a viewport). */
export function clampBarDrag(
  mode: 'move' | 'start' | 'end',
  os: number,
  oe: number,
  d: number,
  w0: number,
  w1: number,
  env: DateEnvelope | null,
): { start: number; end: number } {
  const len = oe - os
  let s = os
  let en = oe
  if (mode === 'move') {
    // keep the bar inside the window; when it's LONGER than the window,
    // the same clamp (bounds swap) keeps it covering the window instead
    const sMin = Math.min(w0, w1 - len)
    const sMax = Math.max(w0, w1 - len)
    s = Math.max(sMin, Math.min(sMax, os + d))
    if (env) {
      const lo = Math.min(env.max - len, os)
      const hi = Math.max(env.min, os)
      s = Math.max(lo, Math.min(hi, s))
    }
    en = s + len
  } else if (mode === 'start') {
    s = Math.max(w0, Math.min(Math.min(oe, w1), os + d))
    if (env) s = Math.min(s, Math.max(env.min, os))
  } else {
    en = Math.min(w1, Math.max(Math.max(os, w0), oe + d))
    if (env) en = Math.max(en, Math.min(env.max, oe))
  }
  return { start: s, end: en }
}

/* --- roadmap view window --------------------------------------------------
   The roadmap shows a user-chosen span of weeks. Each endpoint is either
   relative — "N weeks from today's week", so the window follows the
   calendar — or an exact date, pinned. Defaults: −2w … +6w around today.
   Resolved week indexes count from TIMELINE_START and are UNBOUNDED:
   negative and ≥ WEEKS are fine; views clip to their window. */

export type WinEndpoint = { mode: 'weeks'; value: number } | { mode: 'date'; value: string }
export type RoadmapWin = { start: WinEndpoint; end: WinEndpoint }

export const DEFAULT_WIN: RoadmapWin = {
  start: { mode: 'weeks', value: -2 },
  end: { mode: 'weeks', value: 6 },
}

/** Coerce anything (saved prefs, old formats, garbage) into a valid window. */
export function sanitizeWin(win: unknown): RoadmapWin {
  const ep = (e: unknown, dflt: WinEndpoint): WinEndpoint => {
    const cand = (e ?? {}) as { mode?: unknown; value?: unknown }
    if (
      cand.mode === 'date' &&
      typeof cand.value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(cand.value)
    ) {
      return { mode: 'date', value: cand.value }
    }
    if (cand.mode === 'weeks' && Number.isFinite(Number(cand.value))) {
      return { mode: 'weeks', value: Math.round(Number(cand.value)) }
    }
    return dflt
  }
  const w = (win ?? {}) as { start?: unknown; end?: unknown }
  return {
    start: ep(w.start, DEFAULT_WIN.start),
    end: ep(w.end, DEFAULT_WIN.end),
  }
}

export function endpointWeek(e: WinEndpoint): number {
  return e.mode === 'date' ? isoToWeek(e.value) : TODAY_WEEK + e.value
}

/** A window as a short phrase, for a control that has to SAY which range it
    would restore or store. A relative endpoint writes the offset alone
    (`−2w`, `+6w`, `today`) exactly as the old chips did: that end follows the
    calendar, so printing a date there would be a promise it is not making. A
    pinned endpoint writes its date, because there the date IS the value. */
export function winLabel(win: RoadmapWin): string {
  const one = (e: WinEndpoint) =>
    e.mode === 'date'
      ? fmtDate(isoToDate(e.value))
      : e.value === 0
        ? 'today'
        : `${(e.value > 0 ? '+' : '−') + Math.abs(e.value)}w`
  return `${one(win.start)} … ${one(win.end)}`
}

/** Same window? Compared field by field rather than by JSON.stringify, which
    answers on KEY ORDER — `{start,end}` and `{end,start}` are one window, and
    a saved blob that has been through a round trip need not keep the order it
    was written in. */
export function sameWin(a: RoadmapWin, b: RoadmapWin): boolean {
  const eq = (x: WinEndpoint, y: WinEndpoint) => x.mode === y.mode && x.value === y.value
  return eq(a.start, b.start) && eq(a.end, b.end)
}

/** Resolve to inclusive week indexes [w0, w1]. Swaps a backwards pair and
    caps the span at 5 years so the grid stays renderable. */
export function resolveWin(win: RoadmapWin): { w0: number; w1: number } {
  let w0 = endpointWeek(win.start)
  let w1 = endpointWeek(win.end)
  if (w1 < w0) {
    const t = w0
    w0 = w1
    w1 = t
  }
  if (w1 - w0 > 259) w1 = w0 + 259
  return { w0, w1 }
}

/** Pan by whole weeks: relative endpoints shift their offset, exact dates
    move by 7·n days (calendar-safe across DST). */
export function shiftWin(win: RoadmapWin, dw: number): RoadmapWin {
  const mv = (e: WinEndpoint): WinEndpoint => {
    if (e.mode === 'date') {
      const d = isoToDate(e.value)
      d.setDate(d.getDate() + dw * 7)
      return { mode: 'date', value: isoFromDate(d) }
    }
    return { mode: 'weeks', value: e.value + dw }
  }
  return { start: mv(win.start), end: mv(win.end) }
}
