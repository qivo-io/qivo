/* The delay of a task only a view's answer brings (store/viewRows.ts),
   judged from its row and its owner's load from the owner-load cache
   (store/ownerLoadCache.ts), by the rules the task index judges the
   workspace's tasks with (store/taskIndex.ts judge).

   The owner's load is the cache's spans, with the span of every task this
   person's rows hold, in the workspace or in a view, taken from those rows
   instead (convex/lib/loadRows.ts loadRowFor, as taskIndex.ts fileLoad
   files a shown task), under the owner those rows name. So a pending hours
   or owner edit moves a delay at once, the server's span of the same task
   is never counted again, before or after the server's answer, and a task
   given to another owner leaves the first owner's load. Spans without a
   task, other people's work the person is not shown, stay. */

import { delayProjector } from '../../convex/lib/delay'
import { loadRowFor } from '../../convex/lib/loadRows'
import { taskOwnerId } from '../../convex/lib/review'
import type { ViewRow } from '../../convex/lib/viewReads'
import { canonicalLoad } from '../../convex/lib/workload'
import { isoToWeek, TODAY_ISO, TODAY_WEEK, tsToWeek } from '../lib/dates'
import { DELAY_UNKNOWN, type DelayInfo, type DelayIssue, delayBeforeLoads } from '../lib/delay'
import type { LoadSpan } from '../lib/workload'
import type { OwnerLoad } from './ownerLoadCache'

/** What judging a view's task reads from the store. */
export type ViewDelayCtx = {
  /** owner `owner` of organization `org`'s load from the cache */
  load: (org: string, owner: string) => OwnerLoad
  /** whether the workspace holds task `uuid` */
  held: (uuid: string) => boolean
  /** whether a view's rows hold task `uuid` (its row on screen) */
  inView: (uuid: string) => boolean
  /** the spans of owner `owner`'s tasks the workspace holds, pending edits
      included (taskIndex.ts shownSpans) */
  heldSpans: (owner: string) => LoadSpan[]
  /** every row the views hold that the workspace does not, painted */
  viewRows: () => Iterable<ViewRow>
  /** person `id`'s plannable hours a week (lib/workload.ts plannableHoursOf) */
  capacity: (id: string) => number
  /** whether project `id` is live */
  projectLive: (id: string) => boolean
  /** the organization of person `id` */
  orgOf: (id: string) => string | undefined
  /** each owner's projection, built once while the rows hold still (one
      reshape of the views), by organization and owner; viewDelay fills it */
  memo?: Map<string, (it: DelayIssue) => DelayInfo | null>
}

/* A week index of an ISO week date, or null. */
const week = (iso: string | undefined) => (iso === undefined ? null : isoToWeek(iso))

/** Task `row` of a view's answer as the delay rules read it. A group's dates
    and Done come from its facts. */
export function delayIssueOfRow(row: ViewRow, capacity: (id: string) => number): DelayIssue {
  const group = row.has_subtasks
  const owner = taskOwnerId(row, group) ?? null
  const start = group ? week(row.span?.start_week) : week(row.start_week)
  const end = group ? week(row.span?.end_week) : week(row.end_week)
  return {
    uuid: row.id,
    status: row.status,
    isGroup: group,
    isDone: group ? !!row.group_done : row.status === 'done',
    partial: group ? !!row.span?.partial : false,
    owner,
    start,
    end: end === null ? null : Math.max(start ?? end, end),
    dueWeek: row.due_date ? isoToWeek(row.due_date) : null,
    duePast: !!row.due_date && row.due_date < TODAY_ISO,
    remaining: row.remaining_hours != null ? Number(row.remaining_hours) : undefined,
    remainingSet: row.remaining_set_at != null ? tsToWeek(row.remaining_set_at) : null,
    capacity: owner ? capacity(owner) : 0,
  }
}

/** Whether task `row`'s verdict reads its owner's load: a leaf with an
    owner, hours left and a finite capacity, with something to be judged
    against (lib/delay.ts delayBeforeLoads). */
export function needsLoad(row: ViewRow, capacity: (id: string) => number): boolean {
  const issue = delayIssueOfRow(row, capacity)
  return (
    !!issue.owner && delayBeforeLoads(issue, { datesKnown: true, loading: false }) === DELAY_UNKNOWN
  )
}

/** Owner `owner` of organization `org`'s load for a view's delays: the
    cache's spans `load` with the spans of the tasks this person's rows hold
    taken from those rows (see the header), in the server's total order. */
export function viewLoadOf(
  org: string,
  owner: string,
  load: Extract<OwnerLoad, { state: 'ok' }>,
  ctx: ViewDelayCtx,
): LoadSpan[] {
  const spans: LoadSpan[] = []
  for (const span of load.spans)
    if (!span.issueUuid || (!ctx.held(span.issueUuid) && !ctx.inView(span.issueUuid)))
      spans.push(span)
  spans.push(...ctx.heldSpans(owner))
  const seen = new Set<string>()
  for (const row of ctx.viewRows()) {
    if (row.org_id !== org || seen.has(row.id)) continue
    seen.add(row.id)
    const filed = loadRowFor(row, {
      isGroup: row.has_subtasks,
      projectLive: ctx.projectLive(row.project_id),
      ownerInOrg: (id) => ctx.orgOf(id) === org,
      visible: true,
      staff: false,
      meId: '',
    })
    if (!filed || filed.owner_id !== owner) continue
    spans.push({
      issueUuid: filed.issue_id,
      start: isoToWeek(filed.start_week),
      end: isoToWeek(filed.end_week),
      remaining: filed.remaining != null ? Number(filed.remaining) : 0,
      remainingSet: filed.remaining_set_at != null ? tsToWeek(filed.remaining_set_at) : null,
    })
  }
  return canonicalLoad(spans)
}

/** The delay of task `row`, which only a view holds: judged exactly where
    the verdict needs no one's other work, else against its owner's load.
    Null while that load's first answer is on its way, as before any
    answer nothing is known and a mark would flash on every open;
    DELAY_UNKNOWN where the load is unavailable, failed or past the cap, so
    it never reads as on track. */
export function viewDelay(
  row: ViewRow,
  ctx: ViewDelayCtx,
): DelayInfo | typeof DELAY_UNKNOWN | null {
  const issue = delayIssueOfRow(row, ctx.capacity)
  const load = issue.owner ? ctx.load(row.org_id, issue.owner) : null
  // with the owner's load the verdict is exact, the projected week too
  if (issue.owner && load?.state === 'ok') {
    const key = `${row.org_id}\u0000${issue.owner}`
    let project = ctx.memo?.get(key)
    if (!project) {
      const spans = viewLoadOf(row.org_id, issue.owner, load, ctx)
      project = delayProjector(() => spans, TODAY_WEEK)
      ctx.memo?.set(key, project)
    }
    return project(issue)
  }
  const exact = delayBeforeLoads(issue, { datesKnown: true, loading: false })
  // a passed due date is late whatever the load (convex/lib/delay.ts), with
  // no projected week to name
  if (exact === null && issue.duePast && !issue.isDone && !issue.isGroup)
    return { status: 'late', fin: null }
  if (exact !== DELAY_UNKNOWN) return exact
  if (load === null || load.state === 'waiting') return null
  return DELAY_UNKNOWN
}
