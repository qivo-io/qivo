/* Personal token expiry as the token settings choose and show it. A person
   picks the last day the token works. Qivo stores the instant that day ends,
   the start of the next day in their time zone, as a UTC ISO 8601 string
   (convex/lib/access.ts cleanTokenExpiry accepts that form). The list shows
   the chosen day again by reading the date just before that instant. The
   client clock only decides what the page shows; the server decides whether
   a token still works. */
import { fmtDateYear, isoFromDate } from './dates'

/** The longest countdown the list shows ("In 7 days") before it names the date. */
export const EXPIRY_SOON_DAYS = 7

const DAY_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** A native date input's value, such as "2027-01-12", as that local date at
    midnight. Null for anything but a real calendar date. */
export function parseDayInput(value: string): Date | null {
  const match = DAY_INPUT.exec(value)
  if (!match) return null
  const [y, m, d] = match.slice(1).map(Number)
  const day = new Date(y, m - 1, d)
  // Refuses rolled-over days (2027-02-30) and the years 0-99 that Date maps
  // into the 1900s.
  return day.getFullYear() === y && day.getMonth() === m - 1 && day.getDate() === d ? day : null
}

/** The expires_at to store when the date input's `value` is the token's last
    day, or null when that is not a date from today (local time) on. */
export function expiryFromDay(value: string, now: Date): string | null {
  const day = parseDayInput(value)
  if (!day || value < isoFromDate(now)) return null
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  // toISOString writes a year past 9999 with a sign the server refuses
  return end.getFullYear() > 9999 ? null : end.toISOString()
}

/** The last day a token works, the local date just before `expiresAt`, or
    null when the value cannot be read. */
export function lastDay(expiresAt: string): Date | null {
  const at = Date.parse(expiresAt)
  return Number.isNaN(at) ? null : new Date(at - 1)
}

/** Whether a token has stopped working at `now`, by the server's rule
    (convex/lib/access.ts tokenExpired): one without an expiry never expires
    and an unreadable one counts as expired. */
export function isExpired(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return false
  return !(Date.parse(expiresAt) > now.getTime())
}

/* Whole local calendar days from `from` to `to`; rounding absorbs the 23 and
   25 hour days of a daylight saving change. */
function daysBetween(from: Date, to: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((start(to) - start(from)) / DAY_MS)
}

/** The token list's Expires cell. "Never", the last day in the org's date
    format, or within EXPIRY_SOON_DAYS "Today", "Tomorrow" or "In N days",
    which `soon` marks for the warning color. An expired token shows its last
    day and an unreadable expiry shows nothing. */
export function expiryLabel(expiresAt: string | null, now: Date): { text: string; soon: boolean } {
  if (expiresAt === null) return { text: 'Never', soon: false }
  const day = lastDay(expiresAt)
  if (!day) return { text: '', soon: false }
  if (!isExpired(expiresAt, now)) {
    const days = daysBetween(now, day)
    if (days === 0) return { text: 'Today', soon: true }
    if (days === 1) return { text: 'Tomorrow', soon: true }
    if (days <= EXPIRY_SOON_DAYS) return { text: `In ${days} days`, soon: true }
  }
  return { text: fmtDateYear(day, now), soon: false }
}

/** The same expiry inside a sentence: "never expires", "expires today",
    "expires in 6 days", "expires 12 Jan 2027" or "expired 30 Sep". */
export function expiryPhrase(expiresAt: string | null, now: Date): string {
  if (expiresAt === null) return 'never expires'
  const { text, soon } = expiryLabel(expiresAt, now)
  if (isExpired(expiresAt, now)) return text ? `expired ${text}` : 'expired'
  return `expires ${soon ? text.toLowerCase() : text}`
}
