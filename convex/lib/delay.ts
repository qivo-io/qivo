/* Estimate completion from the effective owner's free capacity, then compare
   it with the due date and plan. Estimates start at their measurement week,
   assuming progress since then; unfinished work cannot finish before today.
   Groups use their calculated dates and descendant completion, not saved
   hours, dates or status. When some of a group's subtasks are outside the
   view, its visible span can still prove it late, but cannot prove it on
   track or behind. Whether a project displays delay is its caller's
   decision.

   The app (src/lib/delay.ts, on its grid where today is TODAY_WEEK) and the
   REST and MCP task reads (lib/machineDelay.ts, on the server's weekGrid)
   share these rules. Only differences between week indexes matter, so each
   passes the index of the current week on its own grid as `todayWeek`. */

import { fitEndWeekAgainst, type LoadSpan, prepareLoadProjection } from './workload'

export type DelayStatus = 'ok' | 'behind' | 'late'

export type DelayInfo = {
  status: DelayStatus
  fin: number | null // projected finish week index; null when 'late' rests on a passed due date alone
}

export type DelayIssue = {
  uuid: string
  status: string // workflow status; 'done' has no delay status
  isGroup?: boolean // active children make the saved status and own hours dormant
  isDone?: boolean // effective completion, derived from descendant leaves for groups
  partial?: boolean // a group with subtasks outside the view, which can only be shown as late
  owner: string | null // effective owner (IssueVM.owner): whose load and capacity it walks
  start: number | null // planned period, week indexes (end is the planned end)
  end: number | null
  dueWeek: number | null // due date floored to its week
  duePast: boolean // due date strictly before today (day precision)
  remaining?: number // hours of work left; unset gives no projection basis (0 does: it means "nothing left")
  remainingSet?: number | null // week the remaining hours were measured (remaining_set_at); today when absent
  capacity: number // the owner's own plannable hours per week (0092); Infinity for an agent (0103)
}

/** Delay status for one issue given its owner's org-wide load, judged in
 * the week `todayWeek`. */
export function delayOf(it: DelayIssue, load: LoadSpan[], todayWeek: number): DelayInfo | null {
  return delayWithProjection(it, todayWeek, (from, remaining, capacity) =>
    fitEndWeekAgainst(load, it.uuid, from, remaining, capacity),
  )
}

/** Delay status for one issue, with `project` answering the week its owner's
 * free capacity finishes `remaining` hours from the week `from`. */
export function delayWithProjection(
  it: DelayIssue,
  todayWeek: number,
  project: (from: number, remaining: number, capacity: number, owner: string) => number,
): DelayInfo | null {
  if (it.isDone ?? (!it.isGroup && it.status === 'done')) return null
  let fin: number | null = null
  if (!it.isGroup && it.owner && it.remaining != null && it.capacity > 0) {
    // Start no earlier than the plan or measurement. Zero is a completed
    // estimate, while undefined falls back to the planned end below.
    const anchor = it.remainingSet != null ? it.remainingSet : todayWeek
    const from = it.start != null ? Math.max(it.start, anchor) : anchor
    fin = Math.max(todayWeek, project(from, it.remaining, it.capacity, it.owner))
  } else if (it.end != null) {
    fin = Math.max(it.end, todayWeek)
  }
  if (it.duePast || (it.dueWeek != null && fin != null && fin > it.dueWeek))
    return { status: 'late', fin }
  // hidden subtasks may end later than the visible ones, so the visible span
  // proves neither "on track" nor "behind"
  if (it.isGroup && it.partial) return null
  if (fin == null) return null
  if (it.end != null && fin > it.end) return { status: 'behind', fin }
  if (it.end != null || it.dueWeek != null) return { status: 'ok', fin }
  return null // nothing to be on track against
}

/** Delay statuses one issue at a time, each walked against its effective
 * owner's organization-wide load (`loadOf`), judged in the week `todayWeek`.
 * Each owner's weekly totals are added up once, on the first issue that
 * needs them (prepareLoadProjection), and shared by the rest. */
export function delayProjector(
  loadOf: (owner: string) => LoadSpan[],
  todayWeek: number,
): (it: DelayIssue) => DelayInfo | null {
  const projections = new Map<string, ReturnType<typeof prepareLoadProjection>>()
  return (it) =>
    delayWithProjection(it, todayWeek, (from, remaining, capacity, owner) => {
      let project = projections.get(owner)
      if (!project) {
        project = prepareLoadProjection(loadOf(owner))
        projections.set(owner, project)
      }
      return project(from, remaining, capacity, it.uuid)
    })
}

/** Task delays share each effective owner's organization-wide load index. */
export function computeDelayMap(
  issues: DelayIssue[],
  loadByOwner: Map<string, LoadSpan[]>,
  todayWeek: number,
): Map<string, DelayInfo> {
  const out = new Map<string, DelayInfo>()
  const delay = delayProjector((owner) => loadByOwner.get(owner) || [], todayWeek)
  for (const it of issues) {
    const info = delay(it)
    if (info) out.set(it.uuid, info)
  }
  return out
}
