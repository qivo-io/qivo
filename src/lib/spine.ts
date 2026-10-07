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
