/* The milestones the store's milestone reads hold (store/planner.ts
   P.watchMilestones: convex/milestones.ts get, section and between), and
   the paints of a person's milestone writes over them.

   - Each read keeps its last answer, by slot, as its anchor: the ask it
     answers, its rows in the server's order, and the answer's `next`,
     `stopped` and `past`, with the organization a `get` answer names.
   - Each repaint copies the anchors once and runs the live layers'
     `milestones` paints over the copies (store/layers.ts), as the store
     paints the workspace's rows. A paint changes every copy of a
     milestone in every read, a live read's first, and keeps each read's
     rows as the server would answer them: an edit takes a row out of a
     read it no longer belongs to, moves it to its place in the server's
     order, and adds it to a read it now belongs to (covers), as a create
     does. A `get` read takes no row it did not hold.
   - A read stopped with its rows kept, as a hidden page's, never stands in
     for a live read's: row() and orgOf() look in live reads first.
   - Rows are never changed in place: a paint replaces a row and its read's
     list, so an anchor stays as the server sent it and a list on screen
     keeps its object while no paint changed it.

   The module imports nothing from the store, so it is tested on its own
   (store/milestoneRows.test.ts). */

import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Row } from './rows'

/** A milestone as the reads answer it, as the projects part sends it. */
export type MilestoneRow = Row<'milestones'>

/** A place in the reads' order, just after the milestone with this stored
    day (`week`), name key (convex/lib/nameKey.ts) and id
    (convex/model/milestones.ts MilestonePosition). */
export type MilestonePosition = { week: string; key: string; id: string }

/** One milestone read, as its query's arguments: one milestone by id, a
    batch of a section of the milestones of `projects` from `from` on
    ('upcoming') or before it ('past'), or the milestones of `projects` on a
    day in [from, to) (convex/milestones.ts). */
export type MilestoneAsk =
  | { kind: 'get'; id: string }
  | {
      kind: 'section'
      projects: readonly string[]
      from: string
      side: 'upcoming' | 'past'
      search?: string
      after?: MilestonePosition
      limit: number
    }
  | {
      kind: 'between'
      projects: readonly string[]
      from: string
      to: string
      after?: MilestonePosition
    }

/** The top-level project a `get` answer names for its milestone. */
export type MilestoneProject = { id: string; name: string; key: string; org_id: string }

/** What one answer brings: its rows in the server's order, the position a
    following batch starts after (null when none follows), the stored day a
    read reached when its budget ran out first (else null), whether one of
    the projects holds a past milestone (a first upcoming batch only), and
    for a `get` answer the project that stores its milestone and whether the
    person may change it, or a null project for an answer of null, which
    brings no rows. */
export type MilestoneTake = {
  rows: readonly MilestoneRow[]
  next: MilestonePosition | null
  stopped: string | null
  past?: boolean
  project?: MilestoneProject | null
  canWrite?: boolean
}

/** One read's rows on screen: its anchor's with the paints over them. */
export type MilestonesShown = { rows: readonly MilestoneRow[]; past?: boolean }

type Anchor = { key: string; ask: MilestoneAsk; take: MilestoneTake }

/* Text before the first day a stored date can name, and after the last. */
const pad = (n: number, width: number) => String(n).padStart(width, '0')

/** The YYYY-MM-DD day the app shows stored day `day` on: the day itself, or
    for a day that does not exist the day it overflows to (2026-02-31 is 3
    March), cut to 0000-01-01 and 9999-12-31, null for text that names no
    day, as the server places it (convex/model/orgs.ts shownDay). */
export function shownDay(day: string): string | null {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(y, (m ?? 1) - 1, d ?? 1)
  if (!Number.isFinite(date.getTime())) return null
  const year = date.getUTCFullYear()
  if (year < 0) return '0000-01-01'
  if (year > 9999) return '9999-12-31'
  return `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
}

/** The position of `row` in the reads' order. */
export const positionOf = (row: Pick<MilestoneRow, 'week' | 'name' | 'id'>): MilestonePosition => ({
  week: row.week,
  key: nameKey(row.name),
  id: row.id,
})

/** Negative when `a` comes before `b` in the reads' ascending order,
    positive after: stored day, name key, id, each compared by UTF-16 code
    units, never by localeCompare (convex/model/milestones.ts compared). */
export function comparePositions(a: MilestonePosition, b: MilestonePosition): number {
  for (const field of ['week', 'key', 'id'] as const)
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  return 0
}

/** Whether `ask` reads its rows newest first. */
const descending = (ask: MilestoneAsk) => ask.kind === 'section' && ask.side === 'past'

/** Creates an empty registry. `topOf` names the top-level project a project
    stands for in a read (a sub-project its parent), as the server folds the
    projects a read names; `live` says whether a slot's read is subscribed. */
export function createMilestoneRows(o: {
  topOf: (projectId: string) => string
  live: (slot: string) => boolean
}) {
  const anchors = new Map<string, Anchor>()
  // the rows on screen, live reads first
  let painted = new Map<string, MilestonesShown>()

  /** Whether `pos` comes before `other` in `ask`'s order. */
  const before = (ask: MilestoneAsk, pos: MilestonePosition, other: MilestonePosition) =>
    descending(ask) ? comparePositions(pos, other) > 0 : comparePositions(pos, other) < 0

  /** Whether the read of `anchor` would answer `row`, by the server's rules
      (convex/model/milestones.ts readMilestones): one of the projects it
      names, folded to their top-level projects, a day it lists (shownDay),
      its search, after its `after` and up to its answer's `next`. A `get`
      read covers its own milestone only. */
  function coversRow(anchor: Anchor, row: MilestoneRow): boolean {
    const { ask, take } = anchor
    if (ask.kind === 'get') return row.id === ask.id
    if (!ask.projects.some((id) => o.topOf(id) === o.topOf(row.project_id))) return false
    const shown = shownDay(row.week)
    if (shown === null) return false
    if (ask.kind === 'between' && (shown < ask.from || shown >= ask.to)) return false
    if (ask.kind === 'section') {
      if (ask.side === 'upcoming' ? shown < ask.from : shown >= ask.from) return false
      const search = (ask.search ?? '').trim()
      if (search !== '' && !allWordsMatcher(nameKey(search))(nameKey(row.name))) return false
    }
    const pos = positionOf(row)
    if (ask.after !== undefined && !before(ask, ask.after, pos)) return false
    return take.next === null || !before(ask, take.next, pos)
  }

  /** `rows` with `row` in its place in `ask`'s order. */
  function placed(ask: MilestoneAsk, rows: readonly MilestoneRow[], row: MilestoneRow) {
    const pos = positionOf(row)
    const at = rows.findIndex((other) => before(ask, pos, positionOf(other)))
    return at < 0 ? [...rows, row] : [...rows.slice(0, at), row, ...rows.slice(at)]
  }

  /** Marks a first upcoming batch that names `row`'s project as one whose
      projects hold a past milestone when `row` is shown before its first
      day, as the server's `past` would say (layers.ts rule 6). */
  function markPast(anchor: Anchor, shown: MilestonesShown, row: MilestoneRow): MilestonesShown {
    const { ask } = anchor
    if (ask.kind !== 'section' || ask.side !== 'upcoming' || ask.after !== undefined) return shown
    if (shown.past !== false) return shown
    if (!ask.projects.some((id) => o.topOf(id) === o.topOf(row.project_id))) return shown
    const day = shownDay(row.week)
    return day !== null && day < ask.from ? { ...shown, past: true } : shown
  }

  /** The first copy of milestone `id` on screen, a live read's first. */
  function peek(id: string): MilestoneRow | undefined {
    for (const shown of painted.values()) {
      const row = shown.rows.find((r) => r.id === id)
      if (row) return row
    }
    return undefined
  }

  return {
    /** Takes slot `slot`'s answer `take` to `ask`, whose arguments' key is
        `key`, as its new anchor. The caller repaints. */
    take(slot: string, key: string, ask: MilestoneAsk, take: MilestoneTake) {
      anchors.set(slot, { key, ask, take })
    },
    /** Forgets slot `slot`'s rows. The caller repaints. */
    release(slot: string) {
      anchors.delete(slot)
      painted.delete(slot)
    },
    /** Whether slot `slot` holds an answer. */
    holds: (slot: string) => anchors.has(slot),
    /** The arguments' key slot `slot`'s answer is for, or null. */
    keyOf: (slot: string): string | null => anchors.get(slot)?.key ?? null,
    /** Whether slot `slot`'s answer, as the server sent it, holds
        milestone `id`. */
    anchorHas: (slot: string, id: string) =>
      anchors.get(slot)?.take.rows.some((row) => row.id === id) ?? false,
    /** Whether slot `slot`'s answer holds a milestone of one of the
        top-level projects `projects`. */
    anchorHasProject(slot: string, projects: ReadonlySet<string>): boolean {
      return anchors.get(slot)?.take.rows.some((row) => projects.has(row.project_id)) ?? false
    },
    /** Whether slot `slot`'s read would answer `row` (coversRow). */
    covers(slot: string, row: MilestoneRow): boolean {
      const anchor = anchors.get(slot)
      return anchor !== undefined && coversRow(anchor, row)
    },
    /** Starts a repaint: every read's rows as its anchor holds them, the
        live reads first. */
    beginPaint() {
      const ranked = [...anchors].sort(([a], [b]) => Number(o.live(b)) - Number(o.live(a)))
      painted = new Map(
        ranked.map(([slot, { take }]) => [
          slot,
          take.past === undefined ? { rows: take.rows } : { rows: take.rows, past: take.past },
        ]),
      )
    },
    /** Paints `fields` over every copy of milestone `id`, and keeps each
        read's rows as the server would answer them: a read the changed row
        no longer belongs to drops it, one it still belongs to moves it to
        its place, and one it now belongs to takes it, from a copy on
        screen, else `fallback` (the workspace's row). Skips when no copy is
        left (layers.ts rule 5). */
    update(id: string, fields: { name?: string; week?: string }, fallback?: MilestoneRow) {
      const base = peek(id) ?? fallback
      if (!base) return
      for (const [slot, shown] of painted) {
        const anchor = anchors.get(slot)
        if (!anchor) continue
        const at = shown.rows.findIndex((row) => row.id === id)
        const row = { ...(at < 0 ? base : shown.rows[at]), ...fields }
        if (anchor.ask.kind === 'get') {
          if (at >= 0)
            painted.set(slot, { ...shown, rows: shown.rows.map((r, i) => (i === at ? row : r)) })
          continue
        }
        const rest = at < 0 ? shown.rows : shown.rows.filter((r) => r.id !== id)
        const rows = coversRow(anchor, row) ? placed(anchor.ask, rest, row) : rest
        const next = markPast(anchor, rows === shown.rows ? shown : { ...shown, rows }, row)
        if (next !== shown) painted.set(slot, next)
      }
    },
    /** Takes milestone `id` out of every read. */
    hide(id: string) {
      for (const [slot, shown] of painted)
        if (shown.rows.some((row) => row.id === id))
          painted.set(slot, { ...shown, rows: shown.rows.filter((row) => row.id !== id) })
    },
    /** Takes every milestone of the top-level projects `projects` out of
        every read, as an archive or delete of the projects does. */
    hideProjects(projects: ReadonlySet<string>) {
      for (const [slot, shown] of painted)
        if (shown.rows.some((row) => projects.has(row.project_id)))
          painted.set(slot, {
            ...shown,
            rows: shown.rows.filter((row) => !projects.has(row.project_id)),
          })
    },
    /** Adds new milestone `row` to every read that would answer it and
        does not hold it (layers.ts rule 4), in its place; never to a `get`
        read. */
    insert(row: MilestoneRow) {
      for (const [slot, shown] of painted) {
        const anchor = anchors.get(slot)
        if (!anchor || anchor.ask.kind === 'get' || shown.rows.some((r) => r.id === row.id))
          continue
        const rows = coversRow(anchor, row) ? placed(anchor.ask, shown.rows, row) : shown.rows
        const next = markPast(anchor, rows === shown.rows ? shown : { ...shown, rows }, row)
        if (next !== shown) painted.set(slot, next)
      }
    },
    /** Milestone `id` as a read shows it, a live read's first, or
        undefined. */
    row: peek,
    /** The organization a `get` answer named for milestone `id`, or
        undefined. */
    orgOf(id: string): string | undefined {
      const ranked = [...anchors].sort(([a], [b]) => Number(o.live(b)) - Number(o.live(a)))
      for (const [, { ask, take }] of ranked)
        if (ask.kind === 'get' && ask.id === id && take.project) return take.project.org_id
      return undefined
    },
    /** Slot `slot`'s rows on screen, or null when it holds no answer. */
    shownOf: (slot: string): MilestonesShown | null => painted.get(slot) ?? null,
    /** Slot `slot`'s answer as the server sent it, or null. */
    anchorOf: (slot: string): MilestoneTake | null => anchors.get(slot)?.take ?? null,
    /** Every read's rows on screen, by slot, for the store's strict layer
        check. */
    views: (): ReadonlyMap<string, MilestonesShown> => painted,
    /** What a strict check repaints from: the rows on screen, to put back. */
    save: () => painted,
    restore(saved: Map<string, MilestonesShown>) {
      painted = saved
    },
    /** Forgets everything (a disposed demo, a store reset). */
    clear() {
      anchors.clear()
      painted = new Map()
    },
  }
}

export type MilestoneRows = ReturnType<typeof createMilestoneRows>
