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

/** The most pieces one cut makes of a window (cutPieces). */
export const MOST_PIECES = 64

/** `w` cut into `n` equal windows of the grid, n a power of two, or into
 * windows of the grid's narrowest width when `n` would make them narrower.
 * Null when `w` cannot be cut. */
export function cut(w: IdWindow, n: number): IdWindow[] | null {
  if (halve(w) === null) return null
  const a = pointOf(w.from)
  const width = Math.max(NARROWEST, (pointOf(w.to) - a) / Math.max(2, n))
  const count = (pointOf(w.to) - a) / width
  return Array.from({ length: count }, (_, i) => ({
    from: i === 0 ? w.from : point(a + width * i),
    to: i === count - 1 ? w.to : point(a + width * (i + 1)),
  }))
}

/** How many pieces to cut window `w` into when the rows a read took from
 * its start, in order, end at a row whose key or id starts with `last`: so
 * many that each holds about half of what the read took, as keys and ids
 * spread evenly, from 2 to MOST_PIECES. A window that cannot hold all its
 * rows in one read then reaches its size in one round, not in one round per
 * halving. 2 when `last` is no hex point. */
export function cutPieces(w: IdWindow, last: string | undefined): number {
  const a = pointOf(w.from)
  const at = last === undefined ? Number.NaN : Number.parseInt(last.slice(0, 8), 16)
  if (!/^[0-9a-f]{8}/.test(last ?? '') || !(at >= a)) return 2
  const covered = (at - a + 1) / (pointOf(w.to) - a)
  let n = 2
  while (n < MOST_PIECES && n * covered < 2) n *= 2
  return n
}

/** The windows that take over from window `w` after its part answered
 * `answer`: its halves after `split`, the pieces it names after `overflow`
 * (any count but a power of two from 2 to MOST_PIECES halves), or null when
 * the answer asks for no cut or `w` cannot be cut. */
export function piecesAfter(
  w: IdWindow,
  answer: { state: string; split?: boolean; pieces?: number },
): IdWindow[] | null {
  if (answer.state === 'ok' && answer.split === true) return halve(w)
  if (answer.state !== 'overflow') return null
  const n = answer.pieces ?? 2
  return cut(w, Number.isInteger(Math.log2(n)) && n >= 2 && n <= MOST_PIECES ? n : 2)
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

/** The share of every id that window `w` covers, from 0 to 1. */
export const idShare = (w: IdWindow) => (pointOf(w.to) - pointOf(w.from)) / SPACE

/** Whether id `id` falls in window `w`. */
export const inIdWindow = (id: string, w: IdWindow) => id >= w.from && (w.to === null || id < w.to)

/** About how many rows the app's first windows of each kind hold, from the
 * organization's counts (startWindows; lib/workspaceParts.ts PAGE has the
 * split points). The people of an organization have no count, so they
 * start in one window, which a large organization overflows at once, and
 * its answer says how many pieces to cut it into (cutPieces). */
export const WINDOW_ROWS = { tasks: 200, projects: 250 }

/** An organization as the root part sends it (lib/workspaceParts.ts
 * readRoot): its numbers, and the rows its windows read once the server
 * counts them (schema.ts org_counters). */
export type WindowCounts = {
  next_issue_num: number
  next_project_num: number
  active_tasks?: number
  live_projects?: number
}

/** About how many tasks the task windows of organization `org` read. Until
 * the server has counted its active tasks, the task numbers it handed out
 * stand in, which count every task ever created. */
export const tasksIn = (org: WindowCounts): number => org.active_tasks ?? org.next_issue_num

/** How many task and project windows the app starts organization `org`
 * with, sized by the rows its windows read (tasksIn, and its projects,
 * archived ones included), or by the numbers it handed out until the
 * server has counted them. */
export const startWindows = (org: WindowCounts) => ({
  tasks: windowCount(tasksIn(org), WINDOW_ROWS.tasks),
  projects: windowCount(org.live_projects ?? org.next_project_num, WINDOW_ROWS.projects),
})
