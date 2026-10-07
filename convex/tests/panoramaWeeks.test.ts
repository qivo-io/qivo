import { describe, expect, it } from 'vitest'
import { calendarWeekDates, calendarWeekForKey, isoWeekForDate } from '../lib/panoramaWeeks'

describe('operator weekly calendar dates', () => {
  it('shows complete Monday–Sunday ranges at month and year boundaries', () => {
    expect(calendarWeekDates(2026, 'W01')).toEqual({ start: '2025-12-29', end: '2026-01-04' })
    expect(calendarWeekDates(2026, 'W53')).toEqual({ start: '2026-12-28', end: '2027-01-03' })
    expect(calendarWeekDates(2028, 'W09')).toEqual({ start: '2028-02-28', end: '2028-03-05' })
    expect(calendarWeekDates(2027, 'W53')).toBeNull()
    expect(isoWeekForDate('2027-01-01')).toEqual({ year: 2026, week: 'W53' })
  })

  it('maps historical dates deterministically while retaining explicit week keys', () => {
    expect(calendarWeekForKey('12-25')).toBe('W52')
    expect(calendarWeekForKey('09-07')).toBe('W37')
    expect(calendarWeekForKey('W53')).toBe('W53')
  })
})
