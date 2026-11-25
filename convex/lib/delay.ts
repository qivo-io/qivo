/* Project when unfinished work finishes, then compare that week with the
   due date and plan. An owner's tasks share the owner's weekly hours in one
   walk (lib/workload.ts shareOwnerWeeks), and each task's projection is its
   finish in that walk. Hours left count from the week they were measured,
   assuming progress since then; unfinished work cannot finish before
   today. Groups use their calculated dates and descendant completion, not
   saved hours, dates or status. When Qivo could not read all of a group's
   subtasks, the span it read can still prove the group late, but cannot
   prove it on track or behind. Whether a project displays delay is its
   caller's decision.

   The app (src/lib/delay.ts, on its grid where today is TODAY_WEEK) and the
   REST and MCP task reads (lib/machineDelay.ts, on the server's weekGrid)
   share these rules. Only differences between week indexes matter, so each
   passes the index of the current week on its own grid as `todayWeek`. */

import {
  type LoadSpan,
  type OwnerWeeks,
  type SharedSpan,
  sharedSpanOf,
  shareOwnerWeeks,
} from './workload'

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
  partial?: boolean // a group Qivo could not read whole, which can only be shown as late
  paused?: boolean // takes no hours of its own, only those its owner's other work leaves free
  owner: string | null // effective owner (IssueVM.owner): whose load and capacity it walks
  start: number | null // planned period, week indexes (end is the planned end)
  end: number | null
  dueWeek: number | null // due date floored to its week
  duePast: boolean // due date strictly before today (day precision)
  remaining?: number // hours of work left; unset gives no projection basis (0 does: it means "nothing left")
  remainingSet?: number | null // week the remaining hours were measured (remaining_set_at); today when absent
  capacity: number // the owner's own plannable hours per week (0092); Infinity for an agent (0103)
}

/* Task `it`'s own place in its owner's walk from week `from`, or null for
   a task without a plan or a paused one, which asks for no hours and gets
   those the walk leaves free. */
function ownSpan(it: DelayIssue, from: number, remaining: number): SharedSpan | null {
  if (it.paused || it.start == null || it.end == null) return null
  return { issueUuid: it.uuid, from, end: Math.max(it.end, from), remaining }
}

const sameSpan = (a: SharedSpan, b: SharedSpan) =>
  a.from === b.from && a.end === b.end && a.remaining === b.remaining

/** The week task `it` finishes from week `from` where its owner's other
 * work cannot move it, else null. No hours left finish at once. An agent's
 * unlimited hours meet every ask, so its task finishes at its planned end,
 * or at once without a plan or while paused. */
export function finishWithoutLoad(it: DelayIssue, from: number): number | null {
  const remaining = it.remaining ?? 0
  if (!(remaining > 0)) return from
  if (it.capacity === Infinity) return ownSpan(it, from, remaining)?.end ?? from
  return null
}

/** The projection of the tasks of an owner whose load is `load`, judged in
 * the week `todayWeek`: the week a task finishes from week `from`. The
 * owner's walk is built once for each capacity, on the first task that
 * needs it, and shared by the rest. A task whose own span in the load
 * differs from the task, as with a pending edit, or that the load lacks or
 * holds twice, gets a walk of the load with the task's own span in its
 * place. */
export function ownerProjection(
  load: readonly LoadSpan[],
  todayWeek: number,
): (it: DelayIssue, from: number) => number {
  const spans = load.map((s) => sharedSpanOf(s, todayWeek))
  const byTask = new Map<string, number[]>()
  spans.forEach((s, i) => {
    if (s.issueUuid === null) return
    const listed = byTask.get(s.issueUuid)
    if (listed) listed.push(i)
    else byTask.set(s.issueUuid, [i])
  })
  const walks = new Map<number, OwnerWeeks>()
  return (it, from) => {
    const known = finishWithoutLoad(it, from)
    if (known !== null) return known
    const remaining = it.remaining ?? 0
    const own = ownSpan(it, from, remaining)
    const listed = byTask.get(it.uuid) ?? []
    if (
      own === null ? listed.length === 0 : listed.length === 1 && sameSpan(spans[listed[0]], own)
    ) {
      let walk = walks.get(it.capacity)
      if (walk === undefined) {
        walk = shareOwnerWeeks(spans, it.capacity)
        walks.set(it.capacity, walk)
      }
      return own === null ? walk.fitFree(from, remaining) : walk.finishes[listed[0]]
    }
    const others = spans.filter((s) => s.issueUuid !== it.uuid)
    if (own === null) return shareOwnerWeeks(others, it.capacity).fitFree(from, remaining)
    return shareOwnerWeeks([...others, own], it.capacity).finishes[others.length]
  }
}

/** Delay status for one issue given its owner's org-wide load, judged in
 * the week `todayWeek`. */
export function delayOf(it: DelayIssue, load: LoadSpan[], todayWeek: number): DelayInfo | null {
  const project = ownerProjection(load, todayWeek)
  return delayWithProjection(it, todayWeek, (from) => project(it, from))
}

/** Delay status for one issue, with `project` answering the week its owner
 * finishes it from the week `from`. */
export function delayWithProjection(
  it: DelayIssue,
  todayWeek: number,
  project: (from: number, owner: string) => number,
): DelayInfo | null {
  if (it.isDone ?? (!it.isGroup && it.status === 'done')) return null
  let fin: number | null = null
  if (!it.isGroup && it.owner && it.remaining != null && it.capacity > 0) {
    // Start no earlier than the plan or measurement. Zero is a completed
    // estimate, while undefined falls back to the planned end below.
    const anchor = it.remainingSet != null ? it.remainingSet : todayWeek
    const from = it.start != null ? Math.max(it.start, anchor) : anchor
    fin = Math.max(todayWeek, project(from, it.owner))
  } else if (it.end != null) {
    fin = Math.max(it.end, todayWeek)
  }
  if (it.duePast || (it.dueWeek != null && fin != null && fin > it.dueWeek))
    return { status: 'late', fin }
  // subtasks Qivo could not read may end later than those it read, so the
  // span it read proves neither "on track" nor "behind"
  if (it.isGroup && it.partial) return null
  if (fin == null) return null
  if (it.end != null && fin > it.end) return { status: 'behind', fin }
  if (it.end != null || it.dueWeek != null) return { status: 'ok', fin }
  return null // nothing to be on track against
}

/** Delay statuses one issue at a time, each walked against its effective
 * owner's organization-wide load (`loadOf`), judged in the week `todayWeek`.
 * Each owner's walk is built once, on the first issue that needs it
 * (ownerProjection), and shared by the rest. */
export function delayProjector(
  loadOf: (owner: string) => LoadSpan[],
  todayWeek: number,
): (it: DelayIssue) => DelayInfo | null {
  const projections = new Map<string, ReturnType<typeof ownerProjection>>()
  return (it) =>
    delayWithProjection(it, todayWeek, (from, owner) => {
      let project = projections.get(owner)
      if (!project) {
        project = ownerProjection(loadOf(owner), todayWeek)
        projections.set(owner, project)
      }
      return project(it, from)
    })
}

/** Task delays share each effective owner's organization-wide load. */
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
