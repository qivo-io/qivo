import { describe, expect, it } from 'vitest'
import {
  dayInSentence,
  dayLabel,
  deletedAtFull,
  deletedAtLabel,
  sameDay,
  stretch,
  timeSpan,
} from './deletedTime'

/* Local times throughout, so every case reads the same in any time zone. */
const NOW = new Date(2026, 9, 16, 15, 0)
const at = (month: number, day: number, h: number, m: number, year = 2026) =>
  new Date(year, month - 1, day, h, m)

describe('the time of a deleted item', () => {
  it('says today, yesterday or the date, with the year only for another year', () => {
    expect(deletedAtLabel(at(10, 16, 14, 9), NOW)).toBe('Today 14:09')
    expect(deletedAtLabel(at(10, 16, 0, 0), NOW)).toBe('Today 00:00')
    expect(deletedAtLabel(at(10, 15, 16, 40), NOW)).toBe('Yesterday 16:40')
    expect(deletedAtLabel(at(10, 14, 10, 22), NOW)).toBe('14 Oct 10:22')
    expect(deletedAtLabel(at(12, 20, 9, 5, 2025), NOW)).toBe('20 Dec 2025 09:05')
    // late last night is yesterday, not today, however few hours ago
    expect(dayLabel(at(10, 15, 23, 59), at(10, 16, 0, 1))).toBe('Yesterday')
    expect(dayLabel(at(10, 15, 23, 59), at(10, 16, 0, 1))).not.toBe('Today')
  })

  it('reads a time a little ahead of this clock as today', () => {
    expect(dayLabel(at(10, 16, 15, 2), NOW)).toBe('Today')
    expect(dayLabel(at(10, 17, 0, 5), at(10, 16, 23, 58))).toBe('Today')
  })

  it('counts days on the calendar across a daylight saving change', () => {
    // 25 Oct 2026 is 23 or 25 hours long in many zones
    const morning = at(10, 26, 0, 30)
    expect(dayLabel(at(10, 25, 0, 30), morning)).toBe('Yesterday')
    expect(dayLabel(at(10, 24, 23, 30), morning)).toBe('24 Oct')
    expect(sameDay(at(10, 25, 23, 59), morning)).toBe(false)
  })

  it('gives the full date and time for the hover', () => {
    expect(deletedAtFull(at(10, 14, 10, 22))).toBe('14 October 2026, 10:22')
    expect(deletedAtFull(at(1, 2, 7, 3))).toBe('2 January 2026, 07:03')
  })

  it('names the day inside a sentence', () => {
    expect(dayInSentence(at(10, 16, 9, 0), NOW)).toBe('today')
    expect(dayInSentence(at(10, 15, 9, 0), NOW)).toBe('yesterday')
    expect(dayInSentence(at(10, 12, 9, 0), NOW)).toBe('on 12 Oct')
  })

  it('spans times earliest first, and says one time once', () => {
    expect(timeSpan(at(10, 16, 14, 9), at(10, 16, 14, 2))).toBe('14:02 to 14:09')
    expect(timeSpan(at(10, 16, 14, 9), at(10, 16, 14, 9))).toBe('14:09')
    expect(stretch(at(10, 16, 14, 2), at(10, 16, 14, 8), NOW)).toBe('today 14:02 to 14:08')
    expect(stretch(at(10, 14, 10, 0), at(10, 14, 10, 22), NOW)).toBe('14 Oct 10:00 to 10:22')
    // over midnight both days are named
    expect(stretch(at(10, 16, 0, 3), at(10, 15, 23, 58), NOW)).toBe(
      'yesterday 23:58 to today 00:03',
    )
  })
})
