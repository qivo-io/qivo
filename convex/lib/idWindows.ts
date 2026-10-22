/* Windows of row ids for the workspace parts (workspace.ts). A window
 * [from, to) holds the rows whose `id` sorts from `from` (inclusive) to
 * `to` (exclusive, null for no end). Ids are random UUIDs, so windows cut at
 * fixed hex points hold about as many rows each, and cutting one in two
 * needs no row: its halves meet at the middle point of its bounds. So no
 * window bound tells anything about the rows, and the app chooses its
 * windows without asking the server. Bounds are 8 hex digits, compared as
 * strings with the ids, so the windows of a kind cover every id once.
 *
 * src/ and scripts/ import this module, so it imports nothing. */

/** A window of ids: from `from`, '' for the first, to `to`, null for the
 * last. */
export type IdWindow = { from: string; to: string | null }

/* The size of the point space: 8 hex digits. */
const SPACE = 2 ** 32
const point = (n: number) => (n === 0 ? '' : n.toString(16).padStart(8, '0'))
const pointOf = (bound: string | null) =>
  bound === null ? SPACE : bound === '' ? 0 : Number.parseInt(bound, 16)

/** The most windows of one kind the app starts with. */
export const MOST_WINDOWS = 1024

/** `n` windows that cover every id, for n a power of two up to
 * MOST_WINDOWS. */
export function idWindows(n: number): IdWindow[] {
  const count = Math.max(1, Math.min(MOST_WINDOWS, n))
  return Array.from({ length: count }, (_, i) => ({
    from: point((SPACE / count) * i),
    to: i === count - 1 ? null : point((SPACE / count) * (i + 1)),
  }))
}

/** How many windows to start with for about `rows` rows, `each` a window:
 * a power of two. */
export function windowCount(rows: number, each: number): number {
  let n = 1
  while (n < MOST_WINDOWS && n * each < rows) n *= 2
  return n
}

/** How many times a window of the whole space may be cut in two. A part
 * accepts only windows of this grid (isIdWindow), so a caller cannot narrow
 * a window around one row: the rows a part holds back, such as a hidden
 * task, tell at most which of 4,096 slices their id falls in, the first
 * three hex digits, and never the id. 4,096 windows of 300 tasks each hold
 * 1.2 million tasks. */
export const MAX_DEPTH = 12

/* The width of the narrowest window. */
const NARROWEST = SPACE / 2 ** MAX_DEPTH

/** The two halves of `w`, or null when it cannot be cut further. */
export function halve(w: IdWindow): [IdWindow, IdWindow] | null {
  const a = pointOf(w.from)
  const b = pointOf(w.to)
  if (b - a <= NARROWEST) return null
  const at = point((a + b) / 2)
  return [
    { from: w.from, to: at },
    { from: at, to: w.to },
  ]
}

/** Whether `w` is a window of the grid that idWindows and halve make: its
 * width is the whole space halved at most MAX_DEPTH times, it starts at a
 * multiple of its width, and its bounds are written as they write them. */
export function isIdWindow(w: IdWindow): boolean {
  const a = pointOf(w.from)
  const b = pointOf(w.to)
  if (point(a) !== w.from || (w.to !== null && (b >= SPACE || point(b) !== w.to))) return false
  const width = b - a
  return width >= NARROWEST && Number.isInteger(Math.log2(width)) && a % width === 0
}

/** Whether id `id` falls in window `w`. */
export const inIdWindow = (id: string, w: IdWindow) => id >= w.from && (w.to === null || id < w.to)

/** About how many rows the app's first windows of each kind hold, from the
 * organization's counters (lib/workspaceParts.ts PAGE has the split
 * points). The people of an organization have no counter, so they start in
 * one window, which cuts itself as it fills. */
export const WINDOW_ROWS = { tasks: 200, projects: 250 }
