import { afterEach, describe, expect, it } from 'vitest'
import { setWeekConfig, TODAY_WEEK, weekToISO } from './dates'
import { captureWeekDates, exactWeekForDate, restoreWeekDates } from './weekDrafts'

afterEach(() => setWeekConfig())

describe('week-based editing across calendar changes', () => {
  it('cancels planning back to its original dates after Sunday rolls into Monday', () => {
    setWeekConfig(1, 'first4day', new Date(2026, 9, 25, 23, 55))
    const original = captureWeekDates({ start: TODAY_WEEK, end: TODAY_WEEK + 2 })
    setWeekConfig(1, 'first4day', new Date(2026, 9, 26, 0, 5))
    const cancellation = restoreWeekDates(original)
    expect(cancellation).toEqual({ start: TODAY_WEEK - 1, end: TODAY_WEEK + 1 })
    expect(captureWeekDates(cancellation)).toEqual(original)
    expect(Object.keys(cancellation).sort()).toEqual(['end', 'start'])
  })

  it('keeps an originally unscheduled task unscheduled after a week rollover', () => {
    setWeekConfig(1, 'first4day', new Date(2026, 9, 25))
    const original = captureWeekDates({ start: null, end: null })
    setWeekConfig(1, 'first4day', new Date(2026, 9, 26))
    expect(restoreWeekDates(original)).toEqual({ start: null, end: null })
  })

  it('preserves milestone creation/edit dates when the organization changes week start', () => {
    setWeekConfig(1, 'first4day', new Date(2026, 9, 26))
    const draftDate = weekToISO(TODAY_WEEK + 2)
    setWeekConfig(0, 'first4day', new Date(2026, 9, 26))
    expect(weekToISO(exactWeekForDate(draftDate))).toBe(draftDate)
    expect(Number.isInteger(exactWeekForDate(draftDate))).toBe(false)
  })

  it('round-trips every weekday across spring and autumn DST changes', () => {
    for (const today of [new Date(2026, 2, 30), new Date(2026, 9, 26)]) {
      for (const weekStart of [0, 1, 6]) {
        setWeekConfig(weekStart, 'first4day', today)
        for (const date of ['2026-03-27', '2026-03-29', '2026-03-30', '2026-10-25', '2026-10-26'])
          expect(weekToISO(exactWeekForDate(date))).toBe(date)
      }
    }
  })
})
