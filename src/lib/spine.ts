/* Inbox and task conversations share oldest-first ordering and unread marks.
   Keep them consistent while both surfaces share the same comment cache. */

import type { ActivityVM, CommentVM } from '../store/planner'

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

/* Comments and activity events interleaved, oldest first. The tie-break on id
   is the same one planner.ts applies when it builds P.comments: two rows that
   share an insert timestamp must land in a stable order, or an optimistic row
   and its refetched self can swap places under the reader. */
export function mergeSpine<
  C extends { ts: number; id: string },
  E extends { ts: number; id: string },
>(comments: readonly C[], events: readonly E[]): SpineItem<C, E>[] {
  return [
    ...comments.map((c) => ({ kind: 'c' as const, ts: c.ts, id: c.id, c })),
    ...events.map((e) => ({ kind: 'e' as const, ts: e.ts, id: e.id, e })),
  ].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
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

type UnreadSource = { issueUuid: string; ts: number; read: boolean }

/* Oldest unread message for this task, regardless of input order.
   The server scopes messages to the viewer; task uuids are globally unique. */
export function firstUnreadTs(
  messages: readonly UnreadSource[],
  issueUuid: string | null,
): number | null {
  if (!issueUuid) return null
  let oldest: number | null = null
  for (const m of messages) {
    if (m.read || m.issueUuid !== issueUuid) continue
    if (oldest === null || m.ts < oldest) oldest = m.ts
  }
  return oldest
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
