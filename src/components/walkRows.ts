/* The state and row helpers both person-by-person walks share (see walk.tsx
   for the pieces they render). */
import { useState } from 'react'
import { type IssueVM, P } from '@/store/planner'

/** Which walk a piece sits in: its data hooks read `data-<hook>-…`. */
export type WalkHook = 'ue' | 'sync'

/** Review ticks: session-local, keyed by task uuid, stored nowhere. An edit
    ticks a row, the tick button toggles it. `count` intersects the caller's
    LIVE rows, so the total adjusts when a task leaves the walk. */
export function useReviewed() {
  const [set, setSet] = useState(() => new Set<string>())
  return {
    has: (uuid: string) => set.has(uuid),
    mark: (uuid: string) => setSet((s) => (s.has(uuid) ? s : new Set(s).add(uuid))),
    toggle: (uuid: string) =>
      setSet((s) => {
        const n = new Set(s)
        if (n.has(uuid)) n.delete(uuid)
        else n.add(uuid)
        return n
      }),
    count: (rows: readonly { uuid: string }[]) => rows.filter((it) => set.has(it.uuid)).length,
  }
}
export type Reviewed = ReturnType<typeof useReviewed>

/** Scheduled first by planned start week, then unscheduled by due date
    (undated last): the same per-track ordering the roadmap uses, so the
    list reads in "this week first" order. */
export function rowOrder(a: IssueVM, b: IssueVM) {
  if (a.start != null && b.start != null) return a.start - b.start
  if (a.start != null) return -1
  if (b.start != null) return 1
  return a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0
}

/** The plan in a row's meta line: `W40` or `W40–W41`, else `due 23 Sep`. */
export function planHint(it: IssueVM) {
  if (it.start != null) {
    const a = P.weekNumLabel(it.start),
      b = P.weekNumLabel(it.end)
    return a === b ? a : `${a}–${b}`
  }
  if (it.due) return `due ${P.fmtDate(P.isoToDate(it.due))}`
  return null
}

/** Blur a focused Remaining box of this walk so it commits: closing or
    stepping away unmounts the box, and React fires no blur on unmount, so a
    typed-but-uncommitted number would vanish. */
export function flushWalkInput(walk: WalkHook) {
  const el = document.activeElement
  if (el instanceof HTMLElement && el.hasAttribute(`data-${walk}-input`)) el.blur()
}
