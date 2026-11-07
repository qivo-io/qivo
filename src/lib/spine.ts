/* Inbox and task conversations share oldest-first ordering and unread marks.
   Keep them consistent while both surfaces share the same comment cache. */

import type { ActivityVM, CommentsEarlier, CommentVM } from '../store/planner'

/* Generic over the row shapes (defaulting to the store's view models) so the
   ordering rules stay testable with minimal fixtures — the merge itself only
   ever reads `ts` and `id`. */
export type SpineItem<C = CommentVM, E = ActivityVM> = {
  kind: 'c' | 'e'
  ts: number
  id: string
  c?: C
  e?: E
}

/* Comments and activity events interleaved, oldest first. At one instant the
   changes come before the comments, as an archive's own row comes before the
   reason it posts with the same time, and keep the order they are given in,
   the store's insertion order (planner.ts rebuildComments sorts them by time
   with a stable sort), so the changes of one write show in the order it
   wrote them. Comments that share an instant keep the tie-break on id that
   planner.ts applies when it builds P.comments: two rows that share an
   insert timestamp must land in a stable order, or an optimistic row and its
   refetched self can swap places under the reader. */
export function mergeSpine<
  C extends { ts: number; id: string },
  E extends { ts: number; id: string },
>(comments: readonly C[], events: readonly E[]): SpineItem<C, E>[] {
  const c = comments
    .map((row) => ({ kind: 'c' as const, ts: row.ts, id: row.id, c: row }))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const e = events
    .map((row) => ({ kind: 'e' as const, ts: row.ts, id: row.id, e: row }))
    .sort((a, b) => a.ts - b.ts)
  const out: SpineItem<C, E>[] = []
  let i = 0
  let j = 0
  while (i < c.length || j < e.length) {
    if (j < e.length && (i >= c.length || e[j].ts <= c[i].ts)) out.push(e[j++])
    else out.push(c[i++])
  }
  return out
}

/* Where the All filter's spine starts while the thread's first comment or
   the task's first change is not loaded (`whole` false). It shows rows from
   `start` on: the later of the oldest loaded comment and the oldest loaded
   change, each counted only while its own start is not loaded, so the spine
   never shows comments next to a gap in the history or changes next to a gap
   in the comments. Rows at that instant stay. A side whose start is not
   loaded and that has nothing loaded yet hides everything, since there is
   nothing to place the other beside. `load` names the sides whose earlier
   page moves `start` back, the ones whose oldest loaded row is at it. With
   both whole, `start` is -Infinity and nothing is left to load. */
export function spineWindow(
  comments: { rows: readonly { ts: number }[]; whole: boolean },
  events: { rows: readonly { ts: number }[]; whole: boolean },
): { start: number; load: { comments: boolean; events: boolean } } {
  const oldest = (side: { rows: readonly { ts: number }[]; whole: boolean }) =>
    side.whole
      ? Number.NEGATIVE_INFINITY
      : side.rows.reduce((min, row) => Math.min(min, row.ts), Number.POSITIVE_INFINITY)
  const c = oldest(comments)
  const e = oldest(events)
  const start = Math.max(c, e)
  return {
    start,
    load: { comments: !comments.whole && c === start, events: !events.whole && e === start },
  }
}

/** One kind's gap as the store holds it (store/planner.ts ThreadGapSide):
    the latest time of a row kept above it, the earliest of a row kept below
    it, and the ids kept above it. */
export type GapSide = { end: number; below: number; above: ReadonlySet<string> }

/** Where the spine's newer row stands, the mirror of spineWindow for the
    rows the store let go between its two runs (P.threadGap): `end`, the
    earliest of the shown kinds' latest times kept above a gap, `below`,
    the latest of their earliest times kept below one, and `load`, the
    kinds whose latest time kept above is `end`, whose newer page moves the
    gap's start on. Rows strictly between `end` and `below` are held but
    hidden, since they sit beside a gap in the other kind; rows at `end` and
    at `below` stay (splitSpine). Null with no gap shown. */
export function spineGap(
  comments: GapSide | null,
  events: GapSide | null,
): { end: number; below: number; load: { comments: boolean; events: boolean } } | null {
  const sides = [comments, events].filter((side): side is GapSide => side !== null)
  if (sides.length === 0) return null
  const end = Math.min(...sides.map((side) => side.end))
  const below = Math.max(...sides.map((side) => side.below))
  return { end, below, load: { comments: comments?.end === end, events: events?.end === end } }
}

/** What the spine's newer row says (store/planner.ts CommentsEarlier), from
    the gap spineGap places and `newer`, the shown kinds' P.commentsNewer
    and P.historyNewer: 'loading' while one of their newer pages loads,
    'failed' after one failed, 'more' while one has released rows, else
    'none'. A gap wholly above `start`, where the spine starts (spineWindow
    under All, -Infinity under Comments), shows no row, since nothing above
    it shows. */
export function newerRow(
  gap: { below: number } | null,
  start: number,
  newer: readonly CommentsEarlier[],
): CommentsEarlier {
  if (gap === null || gap.below <= start) return 'none'
  for (const state of ['loading', 'failed', 'more'] as const)
    if (newer.includes(state)) return state
  return 'none'
}

/** The spine's items, oldest first, in the part above the newer row and the
    part below it. A kind with a gap splits by its runs, so a seeded
    thread's rows whose times run past the rows below stay above, each part
    in time order; its rows above the gap later than `end`, and below it
    earlier than `below`, sit beside the other kind's gap and are hidden. A
    kind without a gap splits by time, its rows strictly between `end` and
    `below` hidden. `keep`, the comment in this window's editor, shows in
    the part above whatever the gap hides. */
export function splitSpine<T extends { kind: 'c' | 'e'; ts: number; id: string }>(
  items: readonly T[],
  gap: { end: number; below: number } | null,
  sides: { comments: GapSide | null; events: GapSide | null },
  keep: string | null = null,
): { above: T[]; below: T[] } {
  if (gap === null) return { above: [...items], below: [] }
  const above: T[] = []
  const below: T[] = []
  for (const item of items) {
    const side = item.kind === 'c' ? sides.comments : sides.events
    const up = side === null ? true : side.above.has(item.id)
    if (up && item.ts <= gap.end) above.push(item)
    else if ((side === null || !up) && item.ts >= gap.below) below.push(item)
    else if (item.id === keep) above.push(item)
  }
  return { above, below }
}

/** Where a visit's unread part of a task starts, in ms, null with nothing
    unread, and whether its unread messages tell of a change, which only
    the All filter lists: a change message, or a mention in the
    description, which came with an edit of it. Whether the person may see
    that change's row is the server's to say, so this cannot promise All
    shows it. The task window freezes both when the task opens, before the
    visit marks the task read, from the task's inbox item
    (itemUnreadStart), also when an Inbox row opened it. Only the Inbox's
    pop-out passes its own, a start of nothing (IssueDetail `unread`). */
export type UnreadStart = { ts: number | null; change: boolean }

/** The unread start of an inbox item as convex/inbox.ts item answers it
    (UnreadStart): its oldest unread message's created_at, which the
    divider compares with the rows' times using `>=`, as a comment and its
    notification share one created_at, and whether an unread message tells
    of a change, a change or a mention in the description, as the server
    judges it (`unread_change`). No item, or one with nothing unread, starts
    nowhere. */
export function itemUnreadStart(
  item: { first_unread_at: string | null; unread_change: boolean } | null,
): UnreadStart {
  if (!item || item.first_unread_at === null) return { ts: null, change: false }
  const ts = Date.parse(item.first_unread_at)
  if (!Number.isFinite(ts)) return { ts: null, change: false }
  return { ts, change: item.unread_change }
}

export type UnreadMark = {
  place: 'none' | 'mark' | 'tail'
  index: number
}

/* Locate the unread marker in the caller's ascending display order.
   Include equal timestamps: an event and its notification can share one.
   `tail` means the unread event is hidden or deleted, so the caller describes
   it instead of drawing a divider with no unread content beneath it. */
export function unreadMark(items: readonly { ts: number }[], ts: number | null): UnreadMark {
  if (ts === null) return { place: 'none', index: -1 }
  const index = items.findIndex((i) => i.ts >= ts)
  return index === -1 ? { place: 'tail', index: -1 } : { place: 'mark', index }
}
