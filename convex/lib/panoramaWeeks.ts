/* Recurring ISO weeks run Monday–Sunday. The fixed legacy reference year keeps
 * old MM-DD inputs deterministic while new assignments use explicit W01–W53. */
export const LEGACY_CALENDAR_YEAR = 2026

function parseDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('use a date in YYYY-MM-DD format')
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new Error('invalid calendar date')
  return parsed
}

export function isoWeekForDate(date: string): { year: number; week: string } {
  const thursday = parseDate(date)
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7))
  const year = thursday.getUTCFullYear()
  const first = new Date(thursday)
  first.setUTCMonth(0, 1)
  const number = Math.ceil(((thursday.getTime() - first.getTime()) / 86400000 + 1) / 7)
  return { year, week: `W${String(number).padStart(2, '0')}` }
}

export function calendarWeeks(): string[] {
  return Array.from({ length: 53 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`)
}

export function calendarWeekForKey(key: string): string {
  if (/^W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(key)) return key
  if (/^\d{2}-\d{2}$/.test(key) && key !== '02-29') {
    try {
      return isoWeekForDate(`${LEGACY_CALENDAR_YEAR}-${key}`).week
    } catch {
      // Expose one input hint for invalid weekly keys and legacy dates.
    }
  }
  throw new Error(
    'choose a week from W01 to W53, or a valid month and day; February 29 is not a recurring key',
  )
}

export function calendarWeekDates(
  year: number,
  week: string,
): { start: string; end: string } | null {
  if (!/^W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(week) || !Number.isInteger(year)) return null
  const start = new Date(`${String(year).padStart(4, '0')}-01-04T00:00:00.000Z`)
  if (!Number.isFinite(start.getTime())) return null
  start.setUTCDate(
    start.getUTCDate() - ((start.getUTCDay() + 6) % 7) + (Number(week.slice(1)) - 1) * 7,
  )
  const isoStart = start.toISOString().slice(0, 10)
  if (isoWeekForDate(isoStart).year !== year) return null
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  return { start: isoStart, end: end.toISOString().slice(0, 10) }
}
