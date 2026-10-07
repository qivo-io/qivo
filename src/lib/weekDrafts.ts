import { isoToDate, TIMELINE_START, weekToISO } from './dates'

type WeekSpan = { start: number | null; end: number | null }
type DateSpan = { start: string | null; end: string | null }

/** Drafts keep absolute dates while the live week grid moves. Fractional
 * indexes preserve the weekday after an organization changes its week start. */
export function exactWeekForDate(date: string): number {
  const days = Math.round((isoToDate(date).getTime() - TIMELINE_START.getTime()) / 86400000)
  return days / 7
}

export function captureWeekDates(span: WeekSpan): DateSpan {
  return {
    start: span.start === null ? null : weekToISO(span.start),
    end: span.end === null ? null : weekToISO(span.end),
  }
}

/** Restores dates only; changing the grid must never restamp remaining hours. */
export function restoreWeekDates(span: DateSpan): WeekSpan {
  return {
    start: span.start === null ? null : exactWeekForDate(span.start),
    end: span.end === null ? null : exactWeekForDate(span.end),
  }
}
