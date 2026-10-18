/* When something went to Deleted items, as the page says it: "Today 14:09",
   "Yesterday 16:40" or "14 Oct 10:22" in the viewer's local time, the full
   date and time for the hover, and the short day and time phrases the page's
   sentences use ("today", "on 12 Oct", "14:02 to 14:09"). Pure, so the page
   and its tests share one reading of "today". */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const pad = (n: number) => String(n).padStart(2, '0')

/** The 24-hour local time of `at`, such as "14:09". */
export function clockTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/* Whole local calendar days from `at` to `now`: 0 on the same day, 1 the day
   before. Counted on calendar dates, so a daylight saving change in between
   never makes yesterday read as today. */
function daysBefore(at: Date, now: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((day(now) - day(at)) / 86_400_000)
}

/** Whether `a` and `b` fall on the same local day. */
export function sameDay(a: Date, b: Date): boolean {
  return daysBefore(a, b) === 0
}

/** "Today", "Yesterday" or "14 Oct", with the year when it is not this
    year's ("20 Dec 2025"). A time a little ahead of `now` (another clock)
    still reads as today. */
export function dayLabel(at: Date, now: Date): string {
  const days = daysBefore(at, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]}`
  return at.getFullYear() === now.getFullYear() ? date : `${date} ${at.getFullYear()}`
}

/** A row's time: "Today 14:09", "Yesterday 16:40" or "14 Oct 10:22". */
export function deletedAtLabel(at: Date, now: Date): string {
  return `${dayLabel(at, now)} ${clockTime(at)}`
}

/** The hover over a row's time: "14 October 2026, 10:22". */
export function deletedAtFull(at: Date): string {
  return `${at.getDate()} ${MONTHS_LONG[at.getMonth()]} ${at.getFullYear()}, ${clockTime(at)}`
}

/** The day as a word inside a sentence: "today", "yesterday" or "14 Oct". */
export function dayWord(at: Date, now: Date): string {
  const label = dayLabel(at, now)
  return label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : label
}

/** The day after a verb: "today", "yesterday" or "on 14 Oct". */
export function dayInSentence(at: Date, now: Date): string {
  const word = dayWord(at, now)
  return word === 'today' || word === 'yesterday' ? word : `on ${word}`
}

const ordered = (a: Date, b: Date): [Date, Date] => (a.getTime() <= b.getTime() ? [a, b] : [b, a])

/** The clock times from the earlier of `a` and `b` to the later: "14:02 to
    14:09", or "14:09" when both read the same minute. */
export function timeSpan(a: Date, b: Date): string {
  const [first, last] = ordered(a, b)
  const start = clockTime(first)
  const end = clockTime(last)
  return start === end ? start : `${start} to ${end}`
}

/** A stretch of time with its day: "today 14:02 to 14:08", or with both days
    when it runs over midnight: "yesterday 23:58 to today 00:03". */
export function stretch(a: Date, b: Date, now: Date): string {
  const [first, last] = ordered(a, b)
  if (sameDay(first, last)) return `${dayWord(first, now)} ${timeSpan(first, last)}`
  return `${dayWord(first, now)} ${clockTime(first)} to ${dayWord(last, now)} ${clockTime(last)}`
}
