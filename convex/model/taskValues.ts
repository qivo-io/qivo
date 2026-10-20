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

/** The most remaining hours a task takes, the range of the numeric(6,1)
 * column the hours came from. The app, REST and MCP refuse more with
 * REMAINING_HOURS_RULE (cleanRemaining), and MCP's task schemas publish it as
 * `maximum`. */
export const REMAINING_HOURS_MAX = 99_999.9

/** The refusal of remaining hours outside 0..REMAINING_HOURS_MAX. */
export const REMAINING_HOURS_RULE = `remaining_hours must be a number of hours from 0 to ${REMAINING_HOURS_MAX}, or null`

/** Estimates are finite hours from 0, stored to one decimal place, that
 * round to at most REMAINING_HOURS_MAX; null clears them. The cap applies to
 * the rounded hours, because the app rounds what a person types before it
 * sends it. More than the cap passes when it rounds to `current`, the task's
 * stored hours, so a task given more before the cap keeps them through
 * writes that send them back unchanged. */
export function cleanRemaining(value: unknown, current?: number): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest(REMAINING_HOURS_RULE)
  }
  const hours = roundTenths(value)
  if (hours > REMAINING_HOURS_MAX && hours !== current) throw badRequest(REMAINING_HOURS_RULE)
  return hours
}
