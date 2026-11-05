/* The clock the Overview sends (overviewArgs.ts overviewClock) as the
 * server reads it (convex/lib/viewLoads.ts clockOf): each instant falls in
 * the week the store's grid puts it in (lib/dates.ts tsToWeek), in zones
 * whose daylight-saving change skips a midnight too. It runs in the node
 * project, where a change of process.env.TZ moves every Date. */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { clockOf } from '../../../convex/lib/viewLoads'
import { setWeekConfig, TODAY_WEEK, tsToWeek, weekToDate } from '../../lib/dates'
import { overviewClock } from './overviewArgs'

// the store's grid as overviewClock reads it, from lib/dates.ts, as the
// store's rebuild copies it (store/planner.ts P)
vi.mock('../../store/planner', async () => {
  const dates = await import('../../lib/dates')
  return {
    P: {
      get TODAY_ISO() {
        return dates.TODAY_ISO
      },
      TODAY_WEEK: dates.TODAY_WEEK,
      isoFromDate: dates.isoFromDate,
      weekToDate: dates.weekToDate,
    },
  }
})

const zone = process.env.TZ
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
  setWeekConfig(null, null)
})

const MINUTE = 60_000

describe('overviewClock', () => {
  it('places every instant around a week start in the week the store puts it in, where daylight saving skips a midnight', () => {
    // Havana, Santiago and Beirut skip the midnight of a Sunday in 2026;
    // the days are that Sunday, later in its week and 11 weeks on, where
    // the grid is anchored on it, and New York for a zone without one
    const days = [
      ['America/Havana', [2026, 2, 8]],
      ['America/Santiago', [2026, 8, 6]],
      ['Asia/Beirut', [2026, 2, 29]],
      ['America/New_York', [2026, 2, 8]],
    ] as const
    let checked = 0
    for (const [tz, [y, m, d]] of days) {
      process.env.TZ = tz
      for (const start of [0, 1])
        for (const after of [0, 3, 77, 80]) {
          const now = new Date(y, m, d + after, 12)
          setWeekConfig(start, null, now)
          const clock = clockOf(overviewClock())
          for (let w = TODAY_WEEK - 52; w <= TODAY_WEEK + 1; w++)
            for (const minutes of [-1, 0, 30, 59, 61]) {
              const at = new Date(weekToDate(w).getTime() + minutes * MINUTE).toISOString()
              expect(clock.ofInstant(at), `${tz} week start ${start} ${at}`).toBe(
                tsToWeek(at) - TODAY_WEEK,
              )
              checked++
            }
        }
    }
    expect(checked).toBeGreaterThan(5000)
  })
})
