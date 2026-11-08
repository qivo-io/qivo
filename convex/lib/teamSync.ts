/* The Team sync rules the server and the browser share: the reading rule
 * (the stamp mutation in teamSync.ts and the sync page), the reading floor
 * (readingBounds, teamSync.ts agenda), and which tasks "Needs an owner" and
 * "Done since" list (needsAnOwner and doneSinceKind, which
 * src/lib/teamSync.ts and lib/teamSyncAgenda.ts call). A person's stamp is
 * the latest change made on them through the sync page; "Done since",
 * "untouched" and "changed" read from the instant syncSince derives from
 * it. src/ imports this module, so it must stay free of server runtime: it
 * imports nothing. */

/** The most people one latest-comment read takes (teamSync.ts
 * lastComments). The page asks only for the people whose cards it shows and
 * its neighbouring steps, so it stays far below this. */
export const SYNC_OWNERS_MAX = 50

/* A sync is one sitting: changes made on a person within this window of the
 * previous one belong to the same sync, so "since" stays put while the
 * meeting runs on every screen. */
export const SYNC_SITTING_MS = 6 * 60 * 60 * 1000

/* How far back a first sitting's reading day may lie (firstSittingSince). */
const FIRST_SINCE_MAX_MS = 14 * 24 * 60 * 60 * 1000

/* A person's stored stamp: their sync_stamps row (model/syncStamps.ts), which
 * teamSync.agenda answers on each walker (lib/teamSyncAgenda.ts). `since`
 * is either an instant, the last change of the previous sitting (a real
 * sync), or, during a person's first sitting, the calendar day (YYYY-MM-DD)
 * the page was reading from when it began (isReadingDay). */
export type SyncStamp = { at: string; since?: string }

const READING_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/* True when a stamp's `since` is a first sitting's reading day rather than a
 * previous sync. A day, not an instant, so every viewer reads it from their
 * own local midnight, exactly as they read a person with no stamp. */
export function isReadingDay(since: string): boolean {
  return READING_DAY.test(since)
}

/* The instant (ms) a stamp's `since` reads from. */
function sinceMs(since: string): number {
  const m = READING_DAY.exec(since)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(since)
}

/* The reading day a first stamp carries (`first_since` on the wire), or
 * undefined when it is not one: a real calendar day whose UTC start is not
 * after `now` (ISO) and at most 14 days before it. The page sends the day it
 * reads a person with no stamp from (firstSittingDay). */
export function firstSittingSince(first: string | undefined, now: string): string | undefined {
  const m = first === undefined ? null : READING_DAY.exec(first)
  if (!m) return undefined
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (new Date(start).toISOString().slice(0, 10) !== first) return undefined // e.g. 31 Feb
  const t = Date.parse(now)
  return start <= t && t - start <= FIRST_SINCE_MAX_MS ? first : undefined
}

/* The stamp after a change at `now` (ISO). Inside a sitting `since` stays as
 * it was (absent included); a new sitting moves the previous `at` into it. A
 * person's first stamp keeps `firstSince`, the day the page was reading from,
 * when it is a valid one (firstSittingSince), so a first sitting that runs
 * past midnight keeps its reading point. */
export function nextSyncStamp(prev: SyncStamp | null, now: string, firstSince?: string): SyncStamp {
  if (prev === null) {
    const since = firstSittingSince(firstSince, now)
    return since === undefined ? { at: now } : { at: now, since }
  }
  if (Date.parse(now) - Date.parse(prev.at) <= SYNC_SITTING_MS) {
    return prev.since === undefined ? { at: now } : { at: now, since: prev.since }
  }
  return { at: now, since: prev.at }
}

/* The five days starting at the organization's week start (JS getDay
 * numbering) are its working days. */
function isWorkingDay(day: number, weekStart: number): boolean {
  return (((day - weekStart) % 7) + 7) % 7 < 5
}

/* Local midnight (ms) of the latest working day before the day of `t`. With
 * a Monday week start: Monday and the weekend read from Friday, Tuesday from
 * Monday. */
export function previousWorkingDayStart(t: number, weekStart = 1): number {
  const day = new Date(t)
  day.setHours(0, 0, 0, 0)
  do {
    day.setDate(day.getDate() - 1)
  } while (!isWorkingDay(day.getDay(), weekStart))
  return day.getTime()
}

/* The reading day a person with no stamp is read from at `now` (ms), as the
 * local YYYY-MM-DD the page sends with their first stamp. */
export function firstSittingDay(now: number, weekStart = 1): string {
  const d = new Date(previousWorkingDayStart(now, weekStart))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/* The instant (ms) a person's "Done since", "untouched" and "changed" read
 * from, at `now` (ms):
 * - no stamp: the start of the previous working day before `now`;
 * - a sitting is on (`at` within SYNC_SITTING_MS of `now`): `since` (a
 *   reading day from its local midnight), else the start of the previous
 *   working day before `at`, so the sitting's own changes never move the
 *   reading point;
 * - otherwise: `at`, the person's last sync. */
export function syncSince(stamp: SyncStamp | null, now: number, weekStart = 1): number {
  if (stamp === null) return previousWorkingDayStart(now, weekStart)
  const at = Date.parse(stamp.at)
  if (now - at > SYNC_SITTING_MS) return at
  return stamp.since === undefined ? previousWorkingDayStart(at, weekStart) : sinceMs(stamp.since)
}

/* ---- the reading floor ----------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** The client's day and local weeks as a query takes them
 * (lib/viewLoads.ts vClock and clockOf, which checks them): its day and the
 * first day of its week, YYYY-MM-DD, the instants (ms) its last local weeks
 * began at, oldest first, the last the local midnight of `week`, and the
 * instant its next week begins at. */
export type ReadingClock = {
  day: string
  week: string
  week_starts: readonly number[]
  week_end: number
}

/* The days since 1970-01-01 of YYYY-MM-DD `iso`. */
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`) / DAY_MS

/* The weekday of day number `n`, 0 for Sunday: 1970-01-01 was a Thursday. */
const weekdayOf = (n: number): number => (((n + 4) % 7) + 7) % 7

/* The day number of the latest working day before day number `n`, as
 * previousWorkingDayStart walks local days. */
function workingDayBefore(n: number, weekStart: number): number {
  let d = n - 1
  while (!isWorkingDay(weekdayOf(d), weekStart)) d--
  return d
}

/* The earliest and latest instant (ms) the local midnight of day number
 * `n` can be at in the client's zone. In a week of the client's grid it is
 * the week's start plus whole days, moved by the week's daylight-saving
 * change once that is past (the difference between the week's length and 7
 * days), so exact in a week without one; in the week after the grid, its
 * start plus whole days within three hours. Outside them the zone is
 * unknown, and UTC offsets run from minus 12 to plus 14 hours, so it is
 * the day's UTC midnight less 14 hours to the same plus 12. */
function midnightOf(n: number, clock: ReadingClock): [number, number] {
  const { start, k, shift } = weekOf(n, clock)
  if (start === null) return [n * DAY_MS - 14 * HOUR_MS, n * DAY_MS + 12 * HOUR_MS]
  if (k === 0) return [start, start]
  const at = start + k * DAY_MS
  if (shift === null) return [at - 3 * HOUR_MS, at + 3 * HOUR_MS]
  return [at + Math.min(0, shift), at + Math.max(0, shift)]
}

/* Day number `n`'s week on the client's grid: its start (ms), null outside
 * the grid and the week after it; the day's place in it; and its
 * daylight-saving change, the difference between its length and 7 days,
 * null where the week's end is not known. */
function weekOf(
  n: number,
  clock: ReadingClock,
): { start: number | null; k: number; shift: number | null } {
  const starts = clock.week_starts
  const last = starts.length - 1
  const fromWeek = n - dayNumber(clock.week)
  const weeks = Math.floor(fromWeek / 7)
  const week = last + weeks
  const k = fromWeek - 7 * weeks
  if (week < 0 || week > last + 1) return { start: null, k, shift: null }
  if (week > last) return { start: clock.week_end, k, shift: null }
  const next = week < last ? starts[week + 1] : clock.week_end
  return { start: starts[week], k, shift: next - starts[week] - 7 * DAY_MS }
}

/* How much later than a local midnight previousWorkingDayStart can answer
 * when it walks back from day number `to` to the day after `from`. Where a
 * daylight-saving change skips one of those days' midnight, the walk lands
 * on the hour after the gap and keeps that wall time back to the working
 * day. At most the largest change of those days' weeks, or three hours
 * where a week's change is not known. */
function walkDrift(from: number, to: number, clock: ReadingClock): number {
  let most = 0
  for (let n = from + 1; n <= to; n++) {
    const shift = weekOf(n, clock).shift
    most = Math.max(most, shift === null ? 3 * HOUR_MS : Math.abs(shift))
  }
  return most
}

/* The earliest and latest instant previousWorkingDayStart(at) can answer
 * in the client's zone, the midnight of the working day before each local
 * day `at` can fall on. */
function workingDayBeforeInstant(
  at: number,
  clock: ReadingClock,
  weekStart: number,
): [number, number] {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  const utc = Math.floor(at / DAY_MS)
  for (let n = utc - 1; n <= utc + 1; n++) {
    if (midnightOf(n, clock)[0] > at || midnightOf(n + 1, clock)[1] <= at) continue
    const before = workingDayBefore(n, weekStart)
    const [from, to] = midnightOf(before, clock)
    lo = Math.min(lo, from)
    hi = Math.max(hi, to + walkDrift(before, n, clock))
  }
  return [lo, hi]
}

/**
 * The earliest (`floor`) and the latest (`top`) instant, in ms, that
 * syncSince can answer for a person with `stamp` at any moment of the
 * client's day `clock.day`, with the organization's `weekStart`, in the
 * client's time zone, which a query does not know. The client's local weeks
 * (ReadingClock) place each local midnight inside them exactly, or within
 * the week's daylight-saving change, at most three hours; a midnight outside
 * them is placed for any zone, from 14 hours before its UTC midnight to 12
 * after. The top also covers previousWorkingDayStart's walk through a
 * midnight a daylight-saving change skips (walkDrift). teamSync.ts agenda
 * reads each walker's Done tasks from `floor`, and counts one toward Team
 * sync's ceiling as certain only from `top`. Outside a week with a
 * daylight-saving change they are what syncSince can answer that day; in
 * one, within twice its change, at most four hours. They are looser where
 * the change leaves unclear whether the sitting covers the day's first or
 * last moments, or which local day the stamp's `at` fell on, that is where
 * either lies within a few hours of a midnight. They then span the
 * sitting's reading point, or the working days before both days, up to
 * three days more.
 *
 * - No stamp: the midnight of the working day before the day.
 * - A sitting over before the day begins anywhere: its `at`.
 * - Otherwise a running sitting's reading point, its `since` (a reading day
 *   from its midnight) or the midnight of the working day before the day
 *   of `at`, and, where the sitting can end during the day, `at` too.
 *
 * So on the day of a person's sitting the floor stays at the sitting's
 * reading point after it ends.
 */
export function readingBounds(
  stamp: SyncStamp | null,
  clock: ReadingClock,
  weekStart = 1,
): { floor: number; top: number } {
  const today = dayNumber(clock.day)
  if (stamp === null) {
    const before = workingDayBefore(today, weekStart)
    const [floor, top] = midnightOf(before, clock)
    return { floor, top: top + walkDrift(before, today, clock) }
  }
  const at = Date.parse(stamp.at)
  const end = at + SYNC_SITTING_MS
  // whether some moment of the day can be inside the sitting, and some past it
  const on = end >= midnightOf(today, clock)[0]
  const over = end < midnightOf(today + 1, clock)[1]
  let floor = over ? at : Number.POSITIVE_INFINITY
  let top = over ? at : Number.NEGATIVE_INFINITY
  if (on) {
    const since = stamp.since
    const [from, to] =
      since === undefined
        ? workingDayBeforeInstant(at, clock, weekStart)
        : isReadingDay(since)
          ? midnightOf(dayNumber(since), clock)
          : [Date.parse(since), Date.parse(since)]
    floor = Math.min(floor, from)
    top = Math.max(top, to)
  }
  return { floor, top }
}

/* ---- the needs-owner and done-since rules ---------------------------------- */

/** How many days past the reader's day "Needs an owner" lists an
 * unassigned task by its due date. */
export const ASK_DAYS = 14

/* The statuses of a Team sync row. */
const OPEN = new Set(['todo', 'progress', 'review'])

/** The last day, YYYY-MM-DD, by which an unassigned task due then needs an
 * owner on the reader's day `today`: ASK_DAYS later. */
export const askHorizon = (today: string): string =>
  new Date((dayNumber(today) + ASK_DAYS) * DAY_MS).toISOString().slice(0, 10)

/** A task as "Needs an owner" reads it. The page fills it from a task's
 * view model (src/lib/teamSync.ts needsOwner) and the server from its row
 * (lib/teamSyncAgenda.ts). */
export type AskFacts = {
  status: string
  /** Urgent or High */
  pressing: boolean
  assigned: boolean
  /** it has subtasks (src/lib/issueGroups.ts isIssueGroup) */
  group: boolean
  /** planned to start this week or earlier on the reader's week grid */
  startsByThisWeek: boolean
  /** its due day, YYYY-MM-DD, or null */
  due: string | null
}

/** Whether "Needs an owner" lists task `t`, with `horizon` the reader's
 * askHorizon: unassigned and without subtasks, and open and Urgent or High,
 * open and planned to start this week or earlier, or due by the horizon
 * (overdue included) in any status but Done, Backlog included. */
export function needsAnOwner(t: AskFacts, horizon: string): boolean {
  if (t.assigned || t.group) return false
  const open = OPEN.has(t.status)
  if (open && (t.pressing || t.startsByThisWeek)) return true
  return t.status !== 'done' && t.due !== null && t.due <= horizon
}

/** A task as "Done since" reads it, filled as AskFacts is. */
export type DoneFacts = {
  status: string
  /** it has subtasks */
  group: boolean
  /** when it reached Done, or moved to another sub-project while Done (ms),
   * or null */
  doneAt: number | null
  assignee: string | null
  reviewer: string | null
  /** whether it carries a review hand-off (review_at), which the move from
   * In Review into Done keeps and any other way into Done clears */
  handedOff: boolean
}

/** How `person`'s "Done since" from `since` (ms) shows task `t`: `done` when
 * they were its assignee, `reviewed` when they reviewed someone else's task
 * to Done, or null when it does not show there. Only a task without
 * subtasks that reached Done at or after `since` shows. */
export function doneSinceKind(
  t: DoneFacts,
  person: string,
  since: number,
): 'done' | 'reviewed' | null {
  if (t.status !== 'done' || t.group || t.doneAt === null || t.doneAt < since) return null
  if (t.assignee === person) return 'done'
  return t.reviewer === person && t.handedOff ? 'reviewed' : null
}
