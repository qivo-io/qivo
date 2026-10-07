import { badRequest } from '../lib/functions'

type TaskDateField = 'start_week' | 'end_week' | 'due_date'

/** Null clears a date; stored values must be real ISO calendar days. */
export function cleanTaskDate(value: unknown, field: TaskDateField): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`${field} must be YYYY-MM-DD or null`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw badRequest(`${field} must be a valid calendar date or null`)
  }
  return value
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

/** At magnitudes where scaling overflows, the number already has no fraction. */
export function roundTenths(value: number): number {
  const scaled = value * 10
  return Number.isFinite(scaled) ? Math.round(scaled) / 10 : value
}

/** Estimates are finite, nonnegative hours, stored to one decimal place. */
export function cleanRemaining(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest('remaining_hours must be a non-negative number or null')
  }
  return roundTenths(value)
}
