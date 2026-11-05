/* Team sync's reading floor (convex/lib/teamSync.ts readingBounds), which
   the server's agenda reads each walker's Done tasks from, against the
   reading point the page derives (syncSince) at every moment of a day, in
   zones from Pacific/Pago_Pago (UTC-11) to Pacific/Kiritimati (UTC+14),
   across daylight-saving changes, with the clock the page sends. It runs
   in the node project, where a change of process.env.TZ moves every Date;
   the convex project's edge runtime keeps the host's zone. */

import { afterAll, describe, expect, it } from 'vitest'
import {
  readingBounds,
  SYNC_SITTING_MS,
  type SyncStamp,
  syncSince,
} from '../../convex/lib/teamSync'

const zone = process.env.TZ
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Zones from UTC-11 to UTC+14, with daylight-saving changes of one hour,
 * half an hour (Lord Howe), two hours (Troll), one at midnight (Santiago)
 * and on both hemispheres. */
const ZONES = [
  'Pacific/Pago_Pago',
  'America/Los_Angeles',
  'America/New_York',
  'America/Santiago',
  'UTC',
  'Europe/Stockholm',
  'Antarctica/Troll',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
]

/** Local days the cases read, by local noon: ordinary days, a Monday and a
 * Sunday, and the days around this year's daylight-saving changes. */
const DAYS: [number, number, number][] = [
  [2026, 8, 9],
  [2026, 8, 7],
  [2026, 8, 13],
  [2026, 2, 8],
  [2026, 2, 9],
  [2026, 2, 29],
  [2026, 2, 30],
  [2026, 3, 5],
  [2026, 3, 6],
  [2026, 8, 6],
  [2026, 8, 27],
  [2026, 9, 4],
  [2026, 9, 25],
  [2026, 9, 26],
  [2026, 10, 1],
  [2026, 10, 2],
]

const pad = (n: number) => String(n).padStart(2, '0')
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The clock the page sends on local day `day`, in the current zone, on
 * weeks that begin on `weekStart`, as src/views/overview/overviewArgs.ts
 * overviewClock builds it from the store's grid: the day, its week's first
 * day, the local midnights of that week and the 52 before, and of the next
 * week's first day. */
function clockOf(day: Date, weekStart: number) {
  const back = (day.getDay() - weekStart + 7) % 7
  const first = new Date(day.getFullYear(), day.getMonth(), day.getDate() - back)
  const weekAt = (k: number) =>
    new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7 * k).getTime()
  return {
    day: isoOf(day),
    week: isoOf(first),
    week_starts: Array.from({ length: 53 }, (_, i) => weekAt(i - 52)),
    week_end: weekAt(1),
  }
}

/** Every half hour of local day `day`, and its first and last instant. */
function momentsOf(day: Date): number[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
  const out = [start, end - 1]
  for (let t = start + HOUR / 2; t < end; t += HOUR / 2) out.push(t)
  return out
}

/** The stamps a case reads on local day `day`: none, sittings that ended
 * before the day, one that runs into it, one during it and one at its
 * end, each without a `since`, with a reading day and with a previous
 * sync's instant, and stamps at local midnights, where the day of `at`
 * depends on the zone. */
function stampsOf(day: Date): (SyncStamp | null)[] {
  const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
  const ats = [
    midnight - 30 * DAY,
    midnight - DAY - 2 * HOUR,
    midnight - 8 * HOUR,
    midnight - SYNC_SITTING_MS - 1,
    midnight - 3 * HOUR,
    midnight - 1,
    midnight,
    midnight + 10 * HOUR,
    midnight + DAY - HOUR,
  ]
  const reading = isoOf(new Date(day.getFullYear(), day.getMonth(), day.getDate() - 3))
  const out: (SyncStamp | null)[] = [null]
  for (const at of ats) {
    const iso = new Date(at).toISOString()
    out.push(
      { at: iso },
      { at: iso, since: reading },
      { at: iso, since: new Date(at - 4 * DAY).toISOString() },
    )
  }
  return out
}

/** For every zone, day, week start and stamp, `check` of the bounds and the
 * reading points syncSince answers at every moment of the day. */
function sweep(
  check: (
    bounds: { floor: number; top: number },
    points: number[],
    label: string,
    edges: boolean,
  ) => void,
): number {
  let cases = 0
  for (const tz of ZONES) {
    process.env.TZ = tz
    for (const [y, m, d] of DAYS) {
      const day = new Date(y, m, d, 12)
      for (const weekStart of [1, 0]) {
        const clock = clockOf(day, weekStart)
        const moments = momentsOf(day)
        for (const stamp of stampsOf(day)) {
          const points = moments.map((now) => syncSince(stamp, now, weekStart))
          const at = stamp === null ? null : Date.parse(stamp.at)
          const end = at === null ? null : at + SYNC_SITTING_MS
          const near = (t: number) => end !== null && Math.abs(end - t) <= 3 * HOUR
          const local = at === null ? null : new Date(at)
          const midnights =
            local === null
              ? []
              : [0, 1].map((k) =>
                  new Date(local.getFullYear(), local.getMonth(), local.getDate() + k).getTime(),
                )
          check(
            readingBounds(stamp, clock, weekStart),
            points,
            `${tz} ${clock.day} week start ${weekStart} ${JSON.stringify(stamp)}`,
            near(moments[0]) ||
              near(moments[1] + 1) ||
              midnights.some((m) => at !== null && Math.abs(at - m) <= 3 * HOUR),
          )
          cases++
        }
      }
    }
  }
  return cases
}

describe('readingBounds', () => {
  it('is never after the reading point syncSince answers at any moment of the day, nor the top before it, in any zone', () => {
    const cases = sweep((bounds, points, label) => {
      expect(bounds.floor, label).toBeLessThanOrEqual(Math.min(...points))
      expect(bounds.top, label).toBeGreaterThanOrEqual(Math.max(...points))
    })
    expect(cases).toBeGreaterThan(5000)
  })

  it("is at most four hours from the day's reading points, through the client's weeks", () => {
    let loose = 0
    sweep((bounds, points, label, edges) => {
      // where a sitting ends, or a stamp was made, within a few hours of a
      // local midnight, the bounds may span more (readingBounds)
      if (edges) {
        loose++
        return
      }
      expect(bounds.floor, label).toBeGreaterThanOrEqual(Math.min(...points) - 4 * HOUR)
      expect(bounds.top, label).toBeLessThanOrEqual(Math.max(...points) + 4 * HOUR)
    })
    expect(loose).toBeGreaterThan(0)
  })

  it("keeps a sitting's reading point all day, after the sitting ends", () => {
    process.env.TZ = 'Europe/Stockholm'
    const day = new Date(2026, 8, 9, 12)
    const clock = clockOf(day, 1)
    const since = new Date(2026, 8, 2, 15).toISOString()
    const stamp = { at: new Date(2026, 8, 9, 9).toISOString(), since }
    // in the sitting and after it, the page reads from `since` and then `at`
    expect(syncSince(stamp, new Date(2026, 8, 9, 10).getTime(), 1)).toBe(Date.parse(since))
    expect(syncSince(stamp, new Date(2026, 8, 9, 18).getTime(), 1)).toBe(Date.parse(stamp.at))
    expect(readingBounds(stamp, clock, 1)).toEqual({
      floor: Date.parse(since),
      top: Date.parse(stamp.at),
    })
    // a day later the sitting is over all day
    const next = clockOf(new Date(2026, 8, 10, 12), 1)
    expect(readingBounds(stamp, next, 1)).toEqual({
      floor: Date.parse(stamp.at),
      top: Date.parse(stamp.at),
    })
  })

  it('reads Monday from Friday, and Monday from Sunday where the week starts on Sunday', () => {
    process.env.TZ = 'America/New_York'
    const monday = new Date(2026, 8, 7, 12)
    expect(readingBounds(null, clockOf(monday, 1), 1).floor).toBe(new Date(2026, 8, 4).getTime())
    expect(readingBounds(null, clockOf(monday, 0), 0).floor).toBe(new Date(2026, 8, 6).getTime())
  })

  it('must fail for a floor without the zones’ margin: the UTC midnight of the working day before', () => {
    // this must fail, as on Wednesday 9 September, without a stamp, the page
    // reads from Tuesday's local midnight, which is before Tuesday's UTC
    // midnight east of UTC, as at UTC+14
    const late: string[] = []
    sweep((_bounds, points, label) => {
      const naive = Date.parse('2026-09-08T00:00:00.000Z')
      if (label.includes(' 2026-09-09 week start 1 null') && Math.min(...points) < naive)
        late.push(label.split(' ')[0])
    })
    expect(late).toContain('Pacific/Kiritimati')
    expect(late).not.toContain('Pacific/Pago_Pago')
  })
})
