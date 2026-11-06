/* The delay of a task the workspace cannot judge, a task only a view's
   answer brings (store/viewRows.ts), which before an ask for every task is
   every task a view shows, and a task the task window shows from its own
   read or holds before every task is held (store/planner.ts P.windowDelay),
   judged from the task and its owner's load from the owner-load cache
   (store/ownerLoadCache.ts), by the rules the task index judges the
   workspace's tasks with (store/taskIndex.ts judge). Both go through one
   judge (judgeDelay), so a window over a Board card shows the card's
   verdict. An organization Viewer's Team sync judges the rows its agenda
   left unknown with it too (store/planner.ts P.syncViewerVerdicts).

   The owner's load is the cache's spans, with the span of every task this
   person's rows hold, in the workspace or in a view, taken from those rows
   instead (convex/lib/loadRows.ts loadRowFor, as taskIndex.ts fileLoad
   files a shown task), under the owner those rows name. So a pending hours
   or owner edit moves a delay at once, the server's span of the same task
   is never counted again, before or after the server's answer, and a task
   given to another owner leaves the first owner's load. Spans without a
   task, other people's work the person is not shown, stay. The judged
   task's own spans never count, whichever list holds them, since the
   projection leaves them out by uuid (convex/lib/workload.ts), so a task
   the window shows from its answer, painted with the person's pending
   edits (store/taskDetail.ts), needs no span of its own here. */

import { delayProjector } from '../../convex/lib/delay'
import { loadRowFor } from '../../convex/lib/loadRows'
import { taskOwnerId } from '../../convex/lib/review'
import type { ViewRow } from '../../convex/lib/viewReads'
import { canonicalLoad } from '../../convex/lib/workload'
import { isoToWeek, TODAY_ISO, TODAY_WEEK, tsToWeek } from '../lib/dates'
import { DELAY_UNKNOWN, type DelayInfo, type DelayIssue, delayBeforeLoads } from '../lib/delay'
import type { LoadSpan } from '../lib/workload'
import type { OwnerLoad } from './ownerLoadCache'
import type { IssueVM } from './viewModels'

/** What judging a view's task reads from the store. */
export type ViewDelayCtx = {
  /** owner `owner` of organization `org`'s load from the cache */
  load: (org: string, owner: string) => OwnerLoad
  /** whether the workspace holds task `uuid` */
  held: (uuid: string) => boolean
  /** whether a view's rows hold task `uuid` (its row on screen), among the
      views whose rows still hear every change, so none whose read stopped
      or kept its rows past a refusal or a failure (store/planner.ts
      viewDelayCtx) */
  inView: (uuid: string) => boolean
  /** the spans of owner `owner`'s tasks the workspace holds, pending edits
      included (taskIndex.ts shownSpans) */
  heldSpans: (owner: string) => LoadSpan[]
  /** every row those views hold that the workspace does not, painted */
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
  /** while `memo` is set, the spans the views' rows file under each owner,
      by organization and owner, built in one pass over the rows */
  filed?: Map<string, LoadSpan[]>
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

/** Task view model `it` as the delay rules read it, the task window's
    task (store/planner.ts P.windowDelay), with a group's Done and whether
    its span leaves out subtasks from `group`, and its owner's plannable
    hours from `capacity`. */
export function delayIssueOfTask(
  it: IssueVM,
  group: { isGroup: boolean; isDone: boolean; partial: boolean },
  capacity: (id: string) => number,
): DelayIssue {
  return {
    uuid: it.uuid,
    status: it.status,
    isGroup: group.isGroup,
    isDone: group.isDone,
    partial: group.partial,
    owner: it.owner ?? null,
    start: it.start,
    end: it.end,
    dueWeek: it.due ? isoToWeek(it.due) : null,
    duePast: !!it.due && it.due < TODAY_ISO,
    remaining: it.remaining,
    remainingSet: it.remainingSet,
    capacity: it.owner ? capacity(it.owner) : 0,
  }
}

/** Whether task `row`'s verdict reads its owner's load: a leaf with an
    owner, hours left and a finite capacity, with something to be judged
    against (lib/delay.ts delayBeforeLoads). */
export function needsLoad(row: ViewRow, capacity: (id: string) => number): boolean {
  return issueNeedsLoad(delayIssueOfRow(row, capacity))
}

/** The spans the views' rows file (convex/lib/loadRows.ts loadRowFor), by
    organization and owner, in one pass over the rows. */
function filedSpans(ctx: ViewDelayCtx): Map<string, LoadSpan[]> {
  const out = new Map<string, LoadSpan[]>()
  const seen = new Set<string>()
  for (const row of ctx.viewRows()) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const filed = loadRowFor(row, {
      isGroup: row.has_subtasks,
      projectLive: ctx.projectLive(row.project_id),
      ownerInOrg: (id) => ctx.orgOf(id) === row.org_id,
      visible: true,
      staff: false,
      meId: '',
    })
    if (!filed) continue
    const key = `${row.org_id}\u0000${filed.owner_id}`
    const list = out.get(key) ?? []
    list.push({
      issueUuid: filed.issue_id,
      start: isoToWeek(filed.start_week),
      end: isoToWeek(filed.end_week),
      remaining: filed.remaining != null ? Number(filed.remaining) : 0,
      remainingSet: filed.remaining_set_at != null ? tsToWeek(filed.remaining_set_at) : null,
    })
    out.set(key, list)
  }
  return out
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
  let filed = ctx.filed
  if (!filed) {
    filed = filedSpans(ctx)
    // kept while the rows hold still (one reshape, `memo`)
    if (ctx.memo) ctx.filed = filed
  }
  spans.push(...(filed.get(`${org}\u0000${owner}`) ?? []))
  return canonicalLoad(spans)
}

/** What a group's verdict knows besides the task: whether its dates are
    known, and whether subtasks may still arrive (lib/delay.ts
    delayBeforeLoads). A view's row knows both. */
export type DelayFacts = { datesKnown: boolean; loading: boolean }
const ROW_FACTS: DelayFacts = { datesKnown: true, loading: false }

/** The delay of task `issue` of organization `org`, which the workspace
    cannot judge: exact where the verdict needs no one's other work, as for
    a group, whose dates decide it (`facts`), else against its owner's load.
    Late for a passed due date. Null while that load's first answer is on
    its way, as before any answer nothing is known and a mark would flash
    on every open; DELAY_UNKNOWN where the load is unavailable, failed or
    past the cap, so it never reads as on track. */
export function judgeDelay(
  issue: DelayIssue,
  org: string,
  ctx: ViewDelayCtx,
  facts: DelayFacts = ROW_FACTS,
): DelayInfo | typeof DELAY_UNKNOWN | null {
  // a group's projection reads no one's load, only its subtasks' dates
  if (issue.isGroup) return delayBeforeLoads(issue, facts)
  const load = issue.owner ? ctx.load(org, issue.owner) : null
  // with the owner's load the verdict is exact, the projected week too
  if (issue.owner && load?.state === 'ok') {
    const key = `${org}\u0000${issue.owner}`
    let project = ctx.memo?.get(key)
    if (!project) {
      const spans = viewLoadOf(org, issue.owner, load, ctx)
      project = delayProjector(() => spans, TODAY_WEEK)
      ctx.memo?.set(key, project)
    }
    return project(issue)
  }
  const exact = delayBeforeLoads(issue, facts)
  // a passed due date is late whatever the load (convex/lib/delay.ts), with
  // no projected week to name
  if (exact === null && issue.duePast && !issue.isDone) return { status: 'late', fin: null }
  if (exact !== DELAY_UNKNOWN) return exact
  if (load === null || load.state === 'waiting') return null
  return DELAY_UNKNOWN
}

/** The delay of task `row`, which only a view holds (judgeDelay). */
export const viewDelay = (
  row: ViewRow,
  ctx: ViewDelayCtx,
): DelayInfo | typeof DELAY_UNKNOWN | null =>
  judgeDelay(delayIssueOfRow(row, ctx.capacity), row.org_id, ctx)

/** Whether task `issue`'s verdict reads its owner's load (judgeDelay): a
    leaf with an owner, hours left and a finite capacity, with something to
    be judged against. */
export const issueNeedsLoad = (issue: DelayIssue): boolean =>
  !issue.isGroup && !!issue.owner && delayBeforeLoads(issue, ROW_FACTS) === DELAY_UNKNOWN
