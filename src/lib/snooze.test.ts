/* fmtSnoozeUntil — the return-time form in a snoozed row's age slot. The
 * cases pin the day boundaries (today / tomorrow / this week / later), the
 * 24-hour clock, and that the boundary is the calendar day, not 24 hours. */
import { describe, expect, it } from 'vitest'
import { fmtSnoozeUntil } from './snooze'

const at = (iso: string) => new Date(iso).getTime()
// a Thursday, mid-afternoon, in local time
const NOW = at('2026-09-17T14:20:00')

describe('fmtSnoozeUntil', () => {
  it('today is the time alone, even 9 hours out', () => {
    expect(fmtSnoozeUntil(at('2026-09-17T23:20:00'), NOW)).toBe('23:20')
    expect(fmtSnoozeUntil(at('2026-09-17T15:05:00'), NOW)).toBe('15:05')
  })
  it('the calendar day, not 24 hours, decides Tomorrow', () => {
    expect(fmtSnoozeUntil(at('2026-09-18T00:20:00'), NOW)).toBe('Tomorrow 00:20')
    expect(fmtSnoozeUntil(at('2026-09-18T14:20:00'), NOW)).toBe('Tomorrow 14:20')
  })
  it('within the week is the weekday', () => {
    const day = new Date('2026-09-20T09:00:00').toLocaleDateString(undefined, { weekday: 'short' })
    expect(fmtSnoozeUntil(at('2026-09-20T09:00:00'), NOW)).toBe(`${day} 09:00`)
  })
  it('a week or more out is day and month', () => {
    const month = new Date('2026-09-24T09:00:00').toLocaleDateString(undefined, { month: 'short' })
    expect(fmtSnoozeUntil(at('2026-09-24T09:00:00'), NOW)).toBe(`24 ${month} 09:00`)
  })
  it('an overdue stamp (wake pending) still reads as a time, never a negative day', () => {
    expect(fmtSnoozeUntil(at('2026-09-17T10:00:00'), NOW)).toBe('10:00')
  })
})
