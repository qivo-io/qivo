/* The Team sync reading rule, shared by the server (the stamp mutation in
 * teamSync.ts) and the browser (the sync page). A person's stamp is the latest
 * change made on them through the sync page; "Done since", "untouched" and
 * "changed" read from the instant syncSince derives from it. src/ imports this
 * module, so it must stay free of server runtime: it imports nothing. */

/* A sync is one sitting: changes made on a person within this window of the
 * previous one belong to the same sync, so "since" stays put while the
 * meeting runs on every screen. */
export const SYNC_SITTING_MS = 6 * 60 * 60 * 1000

/* How far back a first sitting's reading day may lie (firstSittingSince). */
const FIRST_SINCE_MAX_MS = 14 * 24 * 60 * 60 * 1000

/* A person's stored stamp: profiles.sync_at and profiles.sync_since. `since`
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
