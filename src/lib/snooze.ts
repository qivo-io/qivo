/* Inbox snooze, the pure part: the stepper units and the return-time form
 * the row shows while an item sleeps. The state itself is the server's
 * (messages.snoozed_until, cleared by the scheduled messages.wake); nothing
 * here compares a stamp to the clock to decide whether an item is hidden. */

import { fmtTime } from './dates'

export const SNOOZE_UNIT_MS = { hours: 3_600_000, days: 86_400_000 } as const
export type SnoozeUnit = keyof typeof SNOOZE_UNIT_MS
export const SNOOZE_STEP_MAX = 99

/* When a snoozed item returns, for the age slot and the Unsnooze row: the
   time alone today, "Tomorrow" + time, the weekday within a week, else day
   and month. 24-hour clock, so the slot never needs an AM/PM suffix. The
   boundary is the calendar day, not 24 hours. */
export function fmtSnoozeUntil(until: number, now = Date.now()): string {
  const d = new Date(until)
  const time = fmtTime(d)
  const dayStart = (t: number) => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.round((dayStart(until) - dayStart(now)) / 86_400_000)
  if (days <= 0) return time
  if (days === 1) return `Tomorrow ${time}`
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.getDate()} ${d.toLocaleDateString(undefined, { month: 'short' })} ${time}`
}
