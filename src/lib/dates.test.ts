import { afterEach, describe, expect, it } from 'vitest'
import {
  clampBarDrag,
  coverEnvelope,
  DEFAULT_WIN,
  endpointWeek,
  fmtDateTime,
  isoFromDate,
  isoToDate,
  isoToWeek,
  nearestWeek,
  relativeWeek,
  resolveWin,
  sameWin,
  sanitizeWin,
  setDateFormat,
  setWeekConfig,
  shiftWin,
  TIMELINE_START,
  TODAY_POS,
  TODAY_WEEK,
  WEEKS,
  weekNumberOf,
  weekStartOf,
  weekToDate,
  weekToISO,
  winLabel,
} from './dates'

describe('week grid', () => {
  it.each(['0000-02-29', '0099-01-01', '2026-10-01', '9999-12-31'])(
    'round-trips a valid ISO calendar date without changing its year: %s',
    (date) => expect(isoFromDate(isoToDate(date))).toBe(date),
  )

  it('anchors week 0 to the Monday 11 weeks before this week', () => {
    const thisMonday = weekStartOf(new Date())
    // both are local midnights 77 calendar days apart — the raw epoch gap is
    // ±1 h when the span crosses a DST transition, so round like dates.ts does
    const diffDays = (thisMonday.getTime() - TIMELINE_START.getTime()) / 86400000
    expect(Math.round(diffDays)).toBe(TODAY_WEEK * 7)
    expect(TIMELINE_START.getDay()).toBe(1) // Monday under the default settings
  })

  it('TODAY_POS places today on its actual day inside TODAY_WEEK', () => {
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    const daysIn = Math.round((t.getTime() - weekStartOf(t).getTime()) / 86400000)
    expect(daysIn).toBeGreaterThanOrEqual(0)
    expect(daysIn).toBeLessThanOrEqual(6)
    expect(TODAY_POS).toBeCloseTo(TODAY_WEEK + daysIn / 7, 10)
    expect(Math.floor(TODAY_POS)).toBe(TODAY_WEEK) // never leaves its own week
  })

  it('round-trips week index ↔ ISO Monday', () => {
    for (const w of [0, 1, TODAY_WEEK, WEEKS - 1]) {
      expect(isoToWeek(weekToISO(w))).toBe(w)
      expect(weekToDate(w).getDay()).toBe(1)
    }
  })

  it('isoToWeek floors any weekday into its own week', () => {
    const wed = new Date(weekToDate(5))
    wed.setDate(wed.getDate() + 2)
    const sun = new Date(weekToDate(5))
    sun.setDate(sun.getDate() + 6)
    expect(isoToWeek(isoFromDate(wed))).toBe(5)
    expect(isoToWeek(isoFromDate(sun))).toBe(5)
  })

  it('nearestWeek rounds to the NEAREST Monday — Friday lands on the following week', () => {
    const mon = new Date(weekToDate(5))
    const thu = new Date(mon)
    thu.setDate(thu.getDate() + 3)
    const fri = new Date(mon)
    fri.setDate(fri.getDate() + 4)
    const sun = new Date(mon)
    sun.setDate(sun.getDate() + 6)
    expect(nearestWeek(isoFromDate(mon))).toBe(5)
    expect(nearestWeek(isoFromDate(thu))).toBe(5)
    expect(nearestWeek(isoFromDate(fri))).toBe(6) // prototype DateSelect: Math.round
    expect(nearestWeek(isoFromDate(sun))).toBe(6)
  })

  // A picked date is never pulled back onto the prototype's 28-week grid: the
  // clamped `snapToWeek` is gone, and a plan a year out has to survive the
  // round trip through the picker intact.
  it('nearestWeek is unbounded on both sides of the prototype grid', () => {
    const before = new Date(TIMELINE_START)
    before.setDate(before.getDate() - 30)
    const after = new Date(weekToDate(WEEKS - 1))
    after.setDate(after.getDate() + 60)
    expect(nearestWeek(isoFromDate(before))).toBeLessThan(0)
    expect(nearestWeek(isoFromDate(after))).toBeGreaterThan(WEEKS - 1)
  })

  it('handles year boundaries (fixed known Mondays)', () => {
    // 2025-12-29 is a Monday; 2026-01-05 is the next Monday.
    const a = weekStartOf(new Date(2025, 11, 31)) // Wed 31 Dec 2025
    expect(isoFromDate(a)).toBe('2025-12-29')
    const b = weekStartOf(new Date(2026, 0, 5))
    expect(isoFromDate(b)).toBe('2026-01-05')
  })
})

describe('org week settings', () => {
  afterEach(() => setWeekConfig(null, null))

  it('re-anchors the whole grid to the configured week start', () => {
    setWeekConfig(0, 'jan1') // Sunday (US convention)
    expect(weekToDate(TODAY_WEEK).getDay()).toBe(0)
    for (const w of [0, TODAY_WEEK, WEEKS - 1]) expect(isoToWeek(weekToISO(w))).toBe(w)
    setWeekConfig(6, 'first4day') // Saturday
    expect(weekToDate(TODAY_WEEK).getDay()).toBe(6)
  })

  it('re-derives TODAY_POS from the new week start', () => {
    setWeekConfig(0, 'jan1') // Sunday start: the offset is simply the weekday
    expect(TODAY_POS).toBeCloseTo(TODAY_WEEK + new Date().getDay() / 7, 10)
    setWeekConfig(null, null) // Monday start
    expect(TODAY_POS).toBeCloseTo(TODAY_WEEK + ((new Date().getDay() + 6) % 7) / 7, 10)
  })

  it('floors weekdays into Sunday-start weeks under a Sunday grid', () => {
    setWeekConfig(0, 'jan1')
    // 2026-01-01 is a Thursday; its Sunday-start week begins 2025-12-28
    expect(isoFromDate(weekStartOf(new Date(2026, 0, 1)))).toBe('2025-12-28')
  })

  it('rejects garbage and falls back to ISO defaults', () => {
    setWeekConfig(99, 'nonsense')
    expect(weekToDate(0).getDay()).toBe(1)
    setWeekConfig(null, null)
    expect(weekToDate(0).getDay()).toBe(1)
  })
})

describe('calendar week numbers', () => {
  afterEach(() => setWeekConfig(null, null))
  const wkOf = (iso: string) => weekNumberOf(isoToWeek(iso))

  it('ISO 8601 (Monday + first 4-day week): week 1 contains Jan 4', () => {
    // Jan 1 2026 is a Thursday → W1 2026 starts Mon 2025-12-29
    expect(wkOf('2025-12-29')).toEqual({ year: 2026, num: 1 })
    expect(wkOf('2026-01-01')).toEqual({ year: 2026, num: 1 }) // floors into the same week
    expect(wkOf('2025-12-22')).toEqual({ year: 2025, num: 52 })
    expect(wkOf('2026-01-08')).toEqual({ year: 2026, num: 2 })
    // 2026 starts on a Thursday → a 53-week ISO year
    expect(wkOf('2026-12-28')).toEqual({ year: 2026, num: 53 })
    expect(wkOf('2027-01-04')).toEqual({ year: 2027, num: 1 })
  })

  it('US convention (Sunday + week containing Jan 1)', () => {
    setWeekConfig(0, 'jan1')
    expect(wkOf('2025-12-28')).toEqual({ year: 2026, num: 1 }) // Sun 28 Dec–Sat 3 Jan holds Jan 1
    expect(wkOf('2025-12-21')).toEqual({ year: 2025, num: 52 })
    expect(wkOf('2026-01-04')).toEqual({ year: 2026, num: 2 })
  })

  it('first full week: Jan 1–4 2026 still belong to 2025', () => {
    setWeekConfig(1, 'firstfull')
    expect(wkOf('2026-01-05')).toEqual({ year: 2026, num: 1 }) // first whole Mon–Sun week
    expect(wkOf('2025-12-29')).toEqual({ year: 2025, num: 52 })
  })
})

describe('roadmap view window', () => {
  it('defaults to −2w … +6w around today', () => {
    const { w0, w1 } = resolveWin(DEFAULT_WIN)
    expect(w0).toBe(TODAY_WEEK - 2)
    expect(w1).toBe(TODAY_WEEK + 6)
  })

  it('sanitizeWin falls back per endpoint and preserves valid ones', () => {
    expect(sanitizeWin(null)).toEqual(DEFAULT_WIN)
    expect(
      sanitizeWin({
        start: { mode: 'weeks', value: '3.7' },
        end: { mode: 'date', value: 'garbage' },
      }),
    ).toEqual({ start: { mode: 'weeks', value: 4 }, end: DEFAULT_WIN.end })
    const kept = { start: { mode: 'date', value: '2026-06-01' }, end: { mode: 'weeks', value: 10 } }
    expect(sanitizeWin(kept)).toEqual(kept)
  })

  it('endpointWeek: relative follows today, dates pin to their week', () => {
    expect(endpointWeek({ mode: 'weeks', value: -2 })).toBe(TODAY_WEEK - 2)
    expect(endpointWeek({ mode: 'date', value: weekToISO(20) })).toBe(20)
  })

  it('resolveWin swaps a backwards pair and caps the span at 5 years', () => {
    const back = resolveWin({
      start: { mode: 'weeks', value: 6 },
      end: { mode: 'weeks', value: -2 },
    })
    expect(back).toEqual({ w0: TODAY_WEEK - 2, w1: TODAY_WEEK + 6 })
    const huge = resolveWin({
      start: { mode: 'weeks', value: 0 },
      end: { mode: 'weeks', value: 9999 },
    })
    expect(huge.w1 - huge.w0).toBe(259)
  })

  it('shiftWin pans both endpoint kinds by whole weeks', () => {
    const win = {
      start: { mode: 'weeks', value: -2 } as const,
      end: { mode: 'date', value: weekToISO(17) } as const,
    }
    const moved = shiftWin(win, 3)
    expect(moved.start).toEqual({ mode: 'weeks', value: 1 })
    expect(moved.end).toEqual({ mode: 'date', value: weekToISO(20) })
    const back = shiftWin(moved, -3)
    expect(back).toEqual(win)
  })

  it('winLabel writes an offset for a relative end and a date for a pinned one', () => {
    expect(winLabel(DEFAULT_WIN)).toBe('−2w … +6w')
    expect(
      winLabel({ start: { mode: 'weeks', value: 0 }, end: { mode: 'weeks', value: 13 } }),
    ).toBe('today … +13w')
    // a pinned end is the one place a DATE is the honest answer
    expect(
      winLabel({ start: { mode: 'weeks', value: -4 }, end: { mode: 'date', value: '2026-06-01' } }),
    ).toBe('−4w … 1 Jun')
  })

  it('sameWin compares fields, not key order', () => {
    expect(sameWin(DEFAULT_WIN, sanitizeWin(null))).toBe(true)
    // the same window written the other way round — a saved blob need not
    // keep the key order it was stored in, which is why this is not stringify
    expect(sameWin(DEFAULT_WIN, { end: DEFAULT_WIN.end, start: DEFAULT_WIN.start })).toBe(true)
    expect(sameWin(DEFAULT_WIN, { ...DEFAULT_WIN, end: { mode: 'weeks', value: 13 } })).toBe(false)
    // same resolved weeks, different KIND: one follows today, one does not
    expect(
      sameWin(
        { start: { mode: 'weeks', value: 0 }, end: { mode: 'weeks', value: 6 } },
        { start: { mode: 'date', value: weekToISO(TODAY_WEEK) }, end: { mode: 'weeks', value: 6 } },
      ),
    ).toBe(false)
  })
})

describe('sub-issue date envelope', () => {
  it('coverEnvelope widens but never shrinks', () => {
    expect(coverEnvelope(5, 8, null)).toEqual({ start: 5, end: 8 })
    expect(coverEnvelope(5, 8, { min: 3, max: 10 })).toEqual({ start: 3, end: 10 })
    expect(coverEnvelope(5, 8, { min: 6, max: 7 })).toEqual({ start: 5, end: 8 }) // already covering
    expect(coverEnvelope(5, 8, { min: 2, max: 6 })).toEqual({ start: 2, end: 8 }) // start side only
    expect(coverEnvelope(5, 8, { min: 6, max: 12 })).toEqual({ start: 5, end: 12 }) // end side only
  })

  describe('clampBarDrag', () => {
    const w0 = 0,
      w1 = 20

    it('without an envelope keeps the plain window clamp', () => {
      expect(clampBarDrag('move', 4, 7, 3, w0, w1, null)).toEqual({ start: 7, end: 10 })
      expect(clampBarDrag('move', 4, 7, 99, w0, w1, null)).toEqual({ start: 17, end: 20 })
      expect(clampBarDrag('start', 4, 7, -99, w0, w1, null)).toEqual({ start: 0, end: 7 })
      expect(clampBarDrag('end', 4, 7, 99, w0, w1, null)).toEqual({ start: 4, end: 20 })
      // start edge can't cross the end
      expect(clampBarDrag('start', 4, 7, 99, w0, w1, null)).toEqual({ start: 7, end: 7 })
    })

    it('pins a parent so it cannot shrink inside its sub-issues', () => {
      const env = { min: 6, max: 9 } // children span weeks 6..9; parent 4..11 covers them
      expect(clampBarDrag('move', 4, 11, 3, w0, w1, env)).toEqual({ start: 6, end: 13 }) // start stops at 6
      expect(clampBarDrag('move', 4, 11, -3, w0, w1, env)).toEqual({ start: 2, end: 9 }) // end stops at 9
      expect(clampBarDrag('start', 4, 11, 5, w0, w1, env)).toEqual({ start: 6, end: 11 })
      expect(clampBarDrag('end', 4, 11, -5, w0, w1, env)).toEqual({ start: 4, end: 9 })
      // widening is always allowed
      expect(clampBarDrag('start', 4, 11, -2, w0, w1, env)).toEqual({ start: 2, end: 11 })
      expect(clampBarDrag('end', 4, 11, 4, w0, w1, env)).toEqual({ start: 4, end: 15 })
    })

    it('never teleports a bar that already violates the rule', () => {
      // parent 10..12 sits entirely AFTER its children's span 2..5 (legacy data)
      const env = { min: 2, max: 5 }
      // no drag / tiny drags keep it exactly where it is (bounds admit the bar)
      expect(clampBarDrag('move', 10, 12, 0, w0, w1, env)).toEqual({ start: 10, end: 12 })
      // dragging toward compliance works…
      expect(clampBarDrag('move', 10, 12, -6, w0, w1, env)).toEqual({ start: 4, end: 6 })
      // …dragging further away does nothing
      expect(clampBarDrag('move', 10, 12, 6, w0, w1, env)).toEqual({ start: 10, end: 12 })
      expect(clampBarDrag('start', 10, 12, 2, w0, w1, env)).toEqual({ start: 10, end: 12 })
      // a violating end edge may still grow (the compliant direction) — by
      // the dragged amount, not by teleporting to the envelope — but not shrink
      expect(clampBarDrag('end', 1, 3, 1, w0, w1, { min: 2, max: 8 })).toEqual({ start: 1, end: 4 })
      expect(clampBarDrag('end', 1, 3, -1, w0, w1, { min: 2, max: 8 })).toEqual({
        start: 1,
        end: 3,
      })
    })

    it('lets the envelope beat the window clamp', () => {
      // children start before the window: the start edge may not be dragged
      // to w0 — it stays at the envelope even though that is off-window
      expect(clampBarDrag('start', -5, 8, 4, 0, 20, { min: -3, max: 6 })).toEqual({
        start: -3,
        end: 8,
      })
      // children end after the window: the end edge can't come back inside
      expect(clampBarDrag('end', 4, 25, -10, 0, 20, { min: 6, max: 24 })).toEqual({
        start: 4,
        end: 24,
      })
    })

    it('keeps a dragged bar intersecting the window', () => {
      // bar half out the right side, envelope pinned far right of it (violating):
      // move must stay put, not chase the envelope out of the window
      const r = clampBarDrag('move', 19, 22, 30, 0, 20, { min: 30, max: 32 })
      expect(r.start).toBeLessThanOrEqual(20)
      expect(r.end).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('relativeWeek', () => {
  it('names this week and its neighbours in words', () => {
    expect(relativeWeek(TODAY_WEEK)).toBe('this week')
    expect(relativeWeek(TODAY_WEEK + 1)).toBe('next week')
    expect(relativeWeek(TODAY_WEEK - 1)).toBe('last week')
  })

  it('counts further weeks in either direction', () => {
    expect(relativeWeek(TODAY_WEEK + 3)).toBe('in 3 weeks')
    expect(relativeWeek(TODAY_WEEK - 2)).toBe('2 weeks ago')
    expect(relativeWeek(TODAY_WEEK + 2)).not.toBe('in 2 week')
    expect(relativeWeek(TODAY_WEEK - 6)).not.toBe('in -6 weeks')
  })
})

describe('fmtDateTime', () => {
  afterEach(() => setDateFormat(null))

  it('renders the org date format, then the time', () => {
    const d = new Date(2026, 8, 17, 9, 5)
    expect(fmtDateTime(d)).toBe('2026-09-17 09:05')
    setDateFormat('DD/MM/YYYY')
    expect(fmtDateTime(d)).toBe('17/09/2026 09:05')
    setDateFormat('MMM D, YYYY')
    expect(fmtDateTime(d)).toBe('Sep 17, 2026 09:05')
  })

  it('keeps a zero-padded 24-hour clock, never the browser locale', () => {
    const d = new Date(2026, 8, 17, 14, 20)
    expect(fmtDateTime(d)).toBe('2026-09-17 14:20')
    expect(fmtDateTime(d)).not.toMatch(/AM|PM|,/)
    expect(fmtDateTime(d)).not.toBe(d.toLocaleString())
  })
})
