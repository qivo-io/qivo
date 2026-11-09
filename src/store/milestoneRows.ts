/* The milestones the store's milestone reads hold (store/planner.ts
   P.watchMilestones: convex/milestones.ts get, section and between), and
   the paints of a person's milestone writes over them. They are the only
   milestones the store keeps, as no workspace part sends one.

   - Each read keeps its last answer, by slot, as its anchor: the ask it
     answers, its rows in the server's order, and the answer's `next`,
     `stopped` and `past`, with the organization a `get` answer names.
   - Each repaint copies the anchors once and runs the live layers'
     `milestones` paints over the copies (store/layers.ts), as the store
     paints the workspace's rows. A paint changes every copy of a
     milestone in every read, a live read's first, and keeps each read's
     rows as the server would answer them: an edit takes a row out of a
     read it no longer belongs to, moves it to its place in the server's
     order, and adds it to a read it now belongs to (covers) from a copy
     another read shows, as a create does. A `get` read takes no row it did
     not hold, and an edit of a milestone no read shows paints nothing.
   - A read stopped with its rows kept, as a hidden page's, never stands in
     for a live read's: row() and orgOf() look in live reads first. Its
     copies of the milestones a live read's answer brings follow that
     answer (take), as store/viewRows.ts keeps a stopped view's tasks.
   - A paint the server accepted runs only on the reads that have not
     delivered its write yet (within), so a read that holds the write shows
     its own answers, a later change by someone else among them, while a
     stopped read keeps the paint until it reads again.
   - Rows are never changed in place: a paint replaces a row and its read's
     list, so an anchor stays as the server sent it and a list on screen
     keeps its object while no paint changed it.

   The module imports nothing from the store, so it is tested on its own
   (store/milestoneRows.test.ts). */

import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { Row } from './rows'

/** A milestone as the reads answer it (convex/milestones.ts MilestoneRow). */
export type MilestoneRow = Row<'milestones'>

/** A place in the reads' order, just after the milestone with this stored
    day (`week`), name key (convex/lib/nameKey.ts) and id
    (convex/model/milestones.ts MilestonePosition). */
export type MilestonePosition = { week: string; key: string; id: string }

/** One milestone read, as its query's arguments: one milestone by id, a
    batch of a section of the milestones of `projects` from `from` on
    ('upcoming') or before it ('past'), or with `mine` and no projects of
    My view's, which the server finds, or the milestones of `projects` on a
    day in [from, to) (convex/milestones.ts). */
export type MilestoneAsk =
  | { kind: 'get'; id: string }
  | {
      kind: 'section'
      projects: readonly string[]
      mine?: true
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
    the projects holds a past milestone (a first upcoming batch only), for a
    section read with `mine` the top-level projects the server listed, and
    for a `get` answer the project that stores its milestone and whether the
    person may change it, or a null project for an answer of null, which
    brings no rows. */
export type MilestoneTake = {
  rows: readonly MilestoneRow[]
  next: MilestonePosition | null
  stopped: string | null
  past?: boolean
  projects?: readonly string[]
  project?: MilestoneProject | null
  canWrite?: boolean
}

/** One read's rows on screen: its anchor's with the paints over them, with
    the rest of the answer they were painted from (`take`), so a view never
    pairs the rows of one answer with the `next`, `stopped` or project of a
    newer one that a repaint has not painted yet. */
export type MilestonesShown = {
  rows: readonly MilestoneRow[]
  past?: boolean
  take: MilestoneTake
}

type Anchor = { key: string; ask: MilestoneAsk; take: MilestoneTake }

/** The projects a section or range read lists: those its ask names, or for
    a section read with `mine` those its answer names, so a person's write
    on a project of My view paints into My view's reads and one on any
    other project does not. A `mine` read lists none before it answered. */
const listedOf = (ask: Exclude<MilestoneAsk, { kind: 'get' }>, take: MilestoneTake) =>
  ask.kind === 'section' && ask.mine ? (take.projects ?? []) : ask.projects

/* `n` as decimal text, zero-padded to `width` digits. */
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

/** Whether two answers' rows of one milestone hold the same values. */
const sameRow = (a: MilestoneRow, b: MilestoneRow) =>
  a === b ||
  (a.name === b.name &&
    a.week === b.week &&
    a.project_id === b.project_id &&
    a.created_at === b.created_at)

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
  // the reads the paint that runs now may change, every read while null
  let only: ReadonlySet<string> | null = null
  const paints = (slot: string) => only === null || only.has(slot)

  /** Whether `pos` comes before `other` in `ask`'s order. */
  const before = (ask: MilestoneAsk, pos: MilestonePosition, other: MilestonePosition) =>
    descending(ask) ? comparePositions(pos, other) > 0 : comparePositions(pos, other) < 0

  /** Whether a section or range ask would list `row` with no end, by the
      server's rules (convex/model/milestones.ts readMilestones): one of
      the projects it lists (listedOf, from its answer `take`), folded to
      their top-level projects, a day it lists (shownDay), its search and
      after its `after`. */
  function reaches(
    ask: Exclude<MilestoneAsk, { kind: 'get' }>,
    take: MilestoneTake,
    row: MilestoneRow,
  ): boolean {
    const projects = listedOf(ask, take)
    if (!projects.some((id) => o.topOf(id) === o.topOf(row.project_id))) return false
    const shown = shownDay(row.week)
    if (shown === null) return false
    if (ask.kind === 'between' && (shown < ask.from || shown >= ask.to)) return false
    if (ask.kind === 'section') {
      if (ask.side === 'upcoming' ? shown < ask.from : shown >= ask.from) return false
      const search = (ask.search ?? '').trim()
      if (search !== '' && !allWordsMatcher(nameKey(search))(nameKey(row.name))) return false
    }
    return ask.after === undefined || before(ask, ask.after, positionOf(row))
  }

  /** Whether `anchor`'s read is known to lack a milestone other than `id`
      that it would list (reaches) before position `pos`, meaning one that
      another read's answer holds and this answer does not. Only the reads'
      answers tell, as the store keeps no milestone outside them. */
  function lacksBefore(anchor: Anchor, id: string, pos: MilestonePosition): boolean {
    const { ask, take } = anchor
    if (ask.kind === 'get') return false
    const held = new Set(take.rows.map((row) => row.id))
    const lacked = (row: MilestoneRow) =>
      row.id !== id &&
      !held.has(row.id) &&
      reaches(ask, take, row) &&
      before(ask, positionOf(row), pos)
    for (const other of anchors.values()) if (other.take.rows.some(lacked)) return true
    return false
  }

  /** Whether the read of `anchor` would answer `row`: a section or a range
      lists it (reaches) up to its answer's `next`. The batch's own last
      row, whose position `next` is, stays when a write moves it later,
      while it still comes before every milestone the read is known to lack
      (lacksBefore), since the following batch starts after it. Only the
      other reads' answers tell what it lacks, so a move past a milestone no
      read holds keeps the row until the read's next delivery, which a live
      read sends before the write resolves; the row then shows a little
      longer and never a wrong value. A `get` read covers its own milestone
      only. */
  function coversRow(anchor: Anchor, row: MilestoneRow): boolean {
    const { ask, take } = anchor
    if (ask.kind === 'get') return row.id === ask.id
    if (!reaches(ask, take, row)) return false
    const pos = positionOf(row)
    if (take.next === null || !before(ask, take.next, pos)) return true
    return take.next.id === row.id && !lacksBefore(anchor, row.id, pos)
  }

  /** `rows` with `row` in its place in `ask`'s order. */
  function placed(ask: MilestoneAsk, rows: readonly MilestoneRow[], row: MilestoneRow) {
    const pos = positionOf(row)
    const at = rows.findIndex((other) => before(ask, pos, positionOf(other)))
    return at < 0 ? [...rows, row] : [...rows.slice(0, at), row, ...rows.slice(at)]
  }

  /** Marks a first upcoming batch that lists `row`'s project (listedOf) as
      one whose projects hold a past milestone when `row` is shown before
      its first day, as the server's `past` would say (layers.ts rule 6). */
  function markPast(anchor: Anchor, shown: MilestonesShown, row: MilestoneRow): MilestonesShown {
    const { ask } = anchor
    if (ask.kind !== 'section' || ask.side !== 'upcoming' || ask.after !== undefined) return shown
    if (shown.past !== false) return shown
    const projects = listedOf(ask, anchor.take)
    if (!projects.some((id) => o.topOf(id) === o.topOf(row.project_id))) return shown
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
        `key`, as its new anchor, and as the anchor copy of each of these
        milestones that a stopped read holds: the copy takes the new row
        and, in a section or a range, its place there, or leaves the read
        when the read no longer covers it. Anchors are replaced, never
        changed in place. The caller repaints. */
    take(slot: string, key: string, ask: MilestoneAsk, take: MilestoneTake) {
      anchors.set(slot, { key, ask, take })
      const fresh = new Map(take.rows.map((row) => [row.id, row]))
      for (const [other, anchor] of anchors) {
        if (other === slot || o.live(other)) continue
        let rows: readonly MilestoneRow[] | null = null
        for (const held of anchor.take.rows) {
          const row = fresh.get(held.id)
          if (!row || sameRow(row, held)) continue
          const rest: readonly MilestoneRow[] = (rows ?? anchor.take.rows).filter(
            (r) => r.id !== row.id,
          )
          rows = coversRow(anchor, row) ? placed(anchor.ask, rest, row) : rest
        }
        if (rows) anchors.set(other, { ...anchor, take: { ...anchor.take, rows } })
      }
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
    /** Whether a live read's answer holds milestone `id`. */
    liveHolds(id: string): boolean {
      for (const [slot, { take }] of anchors)
        if (o.live(slot) && take.rows.some((row) => row.id === id)) return true
      return false
    },
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
          take.past === undefined
            ? { rows: take.rows, take }
            : { rows: take.rows, past: take.past, take },
        ]),
      )
    },
    /** Paints `fields` over every copy of milestone `id`, and keeps each
        read's rows as the server would answer them: a read the changed row
        no longer belongs to drops it, one it still belongs to moves it to
        its place, and one it now belongs to takes it, from a copy on
        screen. Skips when no read on screen holds a copy (layers.ts rules 1
        and 5), so it never puts back a milestone every read has dropped. */
    update(id: string, fields: { name?: string; week?: string }) {
      const base = peek(id)
      if (!base) return
      for (const [slot, shown] of painted) {
        const anchor = anchors.get(slot)
        if (!anchor || !paints(slot)) continue
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
        if (paints(slot) && shown.rows.some((row) => row.id === id))
          painted.set(slot, { ...shown, rows: shown.rows.filter((row) => row.id !== id) })
    },
    /** Takes every milestone of the top-level projects `projects` out of
        every read, as an archive or delete of the projects does. */
    hideProjects(projects: ReadonlySet<string>) {
      for (const [slot, shown] of painted)
        if (paints(slot) && shown.rows.some((row) => projects.has(row.project_id)))
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
        if (
          !anchor ||
          !paints(slot) ||
          anchor.ask.kind === 'get' ||
          shown.rows.some((r) => r.id === row.id)
        )
          continue
        const rows = coversRow(anchor, row) ? placed(anchor.ask, shown.rows, row) : shown.rows
        const next = markPast(anchor, rows === shown.rows ? shown : { ...shown, rows }, row)
        if (next !== shown) painted.set(slot, next)
      }
    },
    /** Runs `paint` on the reads `slots` names alone: update, hide,
        hideProjects and insert leave every other read as it is, as a
        write the server accepted paints only the reads that have not
        delivered it (store/planner.ts milestoneNeeds). A copy on screen
        in any read still gives an edit its row. */
    within(slots: ReadonlySet<string>, paint: () => void) {
      const was = only
      only = slots
      try {
        paint()
      } finally {
        only = was
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
    /** Slot `slot`'s rows on screen, with the answer they were painted
        from, or null when the screen shows no answer of it yet. */
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
