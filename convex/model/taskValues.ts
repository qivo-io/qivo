import { badRequest } from '../lib/functions'
import { roundTenths } from '../lib/numbers'

type TaskDateField = 'start_week' | 'end_week' | 'due_date'

/** The shape of a date, YYYY-MM-DD, as a JSON Schema pattern. */
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'

/* Whether `value` is written YYYY-MM-DD. */
const dateShaped = (value: unknown): value is string =>
  typeof value === 'string' && new RegExp(DATE_PATTERN).test(value)

/* Whether YYYY-MM-DD text `value` names a day that exists. */
const dayExists = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Whether `value` is one real calendar day written YYYY-MM-DD (calendarDay). */
export const isCalendarDay = (value: unknown): value is string =>
  dateShaped(value) && dayExists(value)

/** Returns `value` when it is one real calendar day written YYYY-MM-DD, the
 * rule for task dates and milestone weeks (model/milestones.ts). Refuses
 * other text with `refusals.shape` and a day that does not exist, such as
 * 2026-02-31, with `refusals.date`. */
export function calendarDay(value: unknown, refusals: { shape: string; date: string }): string {
  if (!dateShaped(value)) throw badRequest(refusals.shape)
  if (!dayExists(value)) throw badRequest(refusals.date)
  return value
}

/** Null clears a date; stored values must be real ISO calendar days. */
export function cleanTaskDate(value: unknown, field: TaskDateField): string | undefined {
  if (value == null) return undefined
  return calendarDay(value, {
    shape: `${field} must be YYYY-MM-DD or null`,
    date: `${field} must be a valid calendar date or null`,
  })
}

/** Validate the resulting plan, including an unchanged endpoint on updates. */
export function assertWeekPair(start: string | undefined, end: string | undefined): void {
  if ((start === undefined) !== (end === undefined)) {
    throw badRequest('start_week and end_week must be set (or cleared) together')
  }
  cleanTaskDate(start, 'start_week')
  cleanTaskDate(end, 'end_week')
  if (start !== undefined && end !== undefined && start > end) {
    throw badRequest('start_week must not be after end_week')
  }
}

export { roundTenths } from '../lib/numbers'

/** Estimates are finite, nonnegative hours, stored to one decimal place. */
export function cleanRemaining(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest('remaining_hours must be a non-negative number or null')
  }
  return roundTenths(value)
}
