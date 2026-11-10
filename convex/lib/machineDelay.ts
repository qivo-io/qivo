/* The app's projected delay (lib/delay.ts) on REST and MCP task rows. Each
 * verdict's inputs come from stored rows the way the app's store builds them
 * from its snapshot (src/store/planner.ts rebuild). They are the task's plan,
 * due date and remaining hours, its owner's plannable hours, and its owner's
 * other scheduled work as the reader may see it, the load rows of the
 * snapshot's own rule (lib/loadRows.ts loadRowFor). Both a single-task read
 * and a list row take that work from the owner's own open tasks
 * (lib/ownerLoads.ts), which answers `unavailable` where that work does not
 * fit the reader's bounds. A list reads its owners once its rows are fixed,
 * within a share of its page's budget, one owner a page for a guest or an
 * organization Viewer (pageForecaster). A group's plan weeks and completion
 * are its group facts (lib/core.ts groupFacts), the app's groupSpan and
 * isIssueDone.
 *
 * Today is the request's UTC day, which the HTTP action passes as `today`
 * (utcToday), because a query that read the time itself could answer from
 * Convex's cache on a later day. Passing the day rather than the moment
 * lets Convex answer repeated reads within a day from that cache, with the
 * same answer. The server judges it, and remaining_set_at, by UTC day on
 * the organization's week grid (lib/workload.ts weekGrid). The app judges
 * both in the browser's time zone, so near midnight or a week boundary the
 * two can differ. Week indexes on the two grids differ by a constant, which
 * every comparison and projection cancels. */

import type { TransactionMetrics } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { type Access, isOrgStaff, OWN_READS } from './access'
import { LEVEL_STEP_READS, type ReadCeiling, roomOf } from './archivedTasks'
import type { Caller, GroupFacts } from './core'
import { byId } from './db'
import { type DelayInfo, type DelayIssue, type DelayStatus, delayOf } from './delay'
import { TEAM_ROW_MAX_BYTES } from './limits'
import type { OrgLoadRow } from './loadRows'
import {
  loadRowsOf,
  OWNER_LOADS,
  type OwnedLoad,
  ownerLoadReader,
  type ReadRoom,
} from './ownerLoads'
import { taskOwnerId } from './review'
import {
  canonicalLoad,
  DEFAULT_PLANNABLE_HOURS,
  type LoadSpan,
  plannableHoursOf,
  type WeekGrid,
  weekGrid,
} from './workload'

/** A delay verdict as REST and MCP send it, with the app's status and the
 * first day of the week the work is projected to finish, null when `late`
 * rests on a passed due date alone. The status is `unavailable`, with no
 * week, where the owner's other work did not fit the owner reader's bounds
 * (UNAVAILABLE_DELAY), and on a list row also where its page read no load
 * of that owner (pageForecaster). */
export type DelayJson = { status: DelayStatus | 'unavailable'; projected_end_week: string | null }

/** The verdict of a task whose owner's other scheduled work Qivo could not
 * read within its bounds, or whose check of the caller's access a bound
 * stopped (lib/ownerLoads.ts), or, on a list row, whose owner its page did
 * not read (pageForecaster). It is never a verdict that counts missing work
 * as free time. */
export const UNAVAILABLE_DELAY: DelayJson = { status: 'unavailable', projected_end_week: null }

/** The day every verdict of one read is judged on, and the organization's
 * week grid. */
export type DelayClock = { grid: WeekGrid; today: string; todayWeek: number }

/** Today's UTC day, YYYY-MM-DD, as an HTTP action passes it to a read. */
export const utcToday = (): string => new Date().toISOString().slice(0, 10)

/** The clock of a read made on `today`, a UTC day (YYYY-MM-DD), in an
 * organization. */
export function delayClock(
  org: Pick<Doc<'organizations'>, 'week_start'> | null,
  today: string,
): DelayClock {
  const grid = weekGrid(org?.week_start ?? 1)
  return { grid, today, todayWeek: grid.ofDay(today) }
}

/** A task's verdict for one reader, or null. `facts` are its group facts,
 * null for a task without subtasks. */
export type Forecaster = (
  issue: Doc<'issues'>,
  project: Doc<'projects'>,
  facts: GroupFacts | null,
) => Promise<DelayJson | null>

/** The forecaster of rows that never carry a verdict, such as archived ones. */
export const noForecast: Forecaster = async () => null

/* Whether the app paints the task's delay, which it does for an active task
 * in an active project whose Delay tracking is on (src/store/planner.ts
 * tracksDelay over the working set). */
const tracked = (issue: Doc<'issues'>, project: Doc<'projects'>): boolean =>
  issue.archived_at === undefined && project.archived_at === undefined && project.track_delay

/* The owner's plannable hours, as the app reads them from its roster. That
 * is the organization's profile, or the default for one it does not hold. */
const capacityOf = (profile: Doc<'profiles'> | null | undefined, orgId: string): number =>
  profile?.org_id === orgId
    ? plannableHoursOf({ plannableHours: profile.plannable_hours, kind: profile.kind })
    : DEFAULT_PLANNABLE_HOURS

/* The task as lib/delay.ts reads it, as the app's store builds it from the
 * task's view model (src/store/viewModels.ts shapeIssue) and group span. */
function delayIssue(
  issue: Doc<'issues'>,
  facts: GroupFacts | null,
  clock: DelayClock,
  capacity: number,
): DelayIssue {
  const { grid } = clock
  const week = (day: string | null | undefined) => (day ? grid.ofDay(day) : null)
  const isGroup = facts !== null
  let start: number | null
  let end: number | null
  if (facts !== null) {
    start = week(facts.start_week)
    end = week(facts.end_week)
  } else {
    start = week(issue.start_week)
    const planned = week(issue.end_week)
    end = planned === null ? null : Math.max(start ?? planned, planned)
  }
  return {
    uuid: issue.id,
    status: issue.status,
    isGroup,
    isDone:
      facts === null
        ? issue.status === 'done'
        : !facts.partial && facts.total > 0 && facts.done === facts.total,
    partial: facts?.partial ?? false,
    owner: taskOwnerId(issue, isGroup) ?? null,
    start,
    end,
    dueWeek: week(issue.due_date),
    duePast: !!issue.due_date && issue.due_date < clock.today,
    remaining: issue.remaining_hours,
    remainingSet: issue.remaining_set_at ? grid.ofInstant(issue.remaining_set_at) : null,
    capacity,
  }
}

/* A verdict on the wire. A week whose first day falls after the year 9999
 * has no YYYY-MM-DD form, so its finish is sent as unknown. */
function delayJson(info: DelayInfo | null, grid: WeekGrid): DelayJson | null {
  if (info === null) return null
  const day = info.fin === null ? null : grid.firstDay(info.fin)
  return {
    status: info.status,
    projected_end_week: day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
  }
}

/* Load rows as the delay projection walks them, by owner, each owner's in
 * the app's order (canonicalLoad). */
function spansByOwner(rows: readonly OrgLoadRow[], grid: WeekGrid) {
  const out = new Map<string, LoadSpan[]>()
  for (const row of rows) {
    const span: LoadSpan = {
      issueUuid: row.issue_id,
      start: grid.ofDay(row.start_week),
      end: grid.ofDay(row.end_week),
      remaining: row.remaining,
      remainingSet: row.remaining_set_at === null ? null : grid.ofInstant(row.remaining_set_at),
    }
    const own = out.get(row.owner_id)
    if (own === undefined) out.set(row.owner_id, [span])
    else own.push(span)
  }
  for (const spans of out.values()) canonicalLoad(spans)
  return out
}

/** What a single-task read keeps back from the request's limits while its
 * owner's load is read (taskForecaster). lib/core.ts taskOut reads the
 * verdict after everything else, so nothing is read after it, and this
 * holds what the owner reader (lib/ownerLoads.ts) may read past its last
 * look at the metrics while it asks about one sub-project and its top-level
 * project (past those it holds STEP_READS too): the row it read last, up to
 * Convex's document size limit, and the single-row reads of the caller's
 * access that no price counts, within the design size the caller's
 * membership in each team that shares the two projects (at most 10, 5 a
 * project) and the rows of the caller's teams among them (at most 5), each
 * a range and a document. A small single read takes 29 ranges and 16
 * documents in all (convex/tests/taskDelay.test.ts reads the owner's
 * Done-free load under a limit of 250 documents). Tests lower these. */
export const DELAY_READ_RESERVE: ReadCeiling = {
  ranges: 96,
  documents: 96,
  bytes: DOCUMENT_MAX_BYTES + 96 * TEAM_ROW_MAX_BYTES,
}

/* What the caller's access may read of the caller's own rows at once in
 * one round of questions (lib/ownerLoads.ts ReadRoom `wide`): the largest
 * step of their grants, memberships and teams' shares
 * (lib/archivedTasks.ts LEVEL_STEP_READS) and the organization's teams,
 * which a question reads once the caller's teams are known (lib/access.ts
 * OWN_READS orgTeamsMost and bytes, which counts JSON, of which Convex
 * counts up to about 2.3 times). */
const STEP_READS: ReadCeiling = {
  ranges: LEVEL_STEP_READS.ranges + 1,
  documents: LEVEL_STEP_READS.documents + OWN_READS.orgTeamsMost + 1,
  bytes: LEVEL_STEP_READS.bytes + 3 * OWN_READS.bytes,
}

/* The room of the owner reader of a single-task read that starts at
 * `start`, when the access instance had counted `from` as shared:
 * OWNER_LOADS.call from there, past the shared reads the instance makes
 * from then on, as lib/core.ts relatedRoom leaves them out, and within the
 * request's limits less DELAY_READ_RESERVE, and less STEP_READS where a
 * round may read the caller's own rows at once, as those reads count
 * against the request's limits like any other. The shared reads made
 * before `start` were read by the rest of the task's read, so they give
 * the owner reader no room. */
const delayRoom =
  (start: TransactionMetrics, from: ReadCeiling): ReadRoom =>
  (m, shared, wide) => {
    const room = roomOf(m, DELAY_READ_RESERVE)
    const hold = wide ? STEP_READS : { ranges: 0, documents: 0, bytes: 0 }
    // what the reader read since `start`, less the shared reads since then
    const since = (now: number, then: number, own: number, ownThen: number) =>
      now - then - (own - ownThen)
    return {
      ranges: Math.min(
        OWNER_LOADS.call.ranges -
          since(m.databaseQueries.used, start.databaseQueries.used, shared.ranges, from.ranges),
        room.ranges - hold.ranges - m.databaseQueries.used,
      ),
      documents: Math.min(
        OWNER_LOADS.call.documents -
          since(m.documentsRead.used, start.documentsRead.used, shared.documents, from.documents),
        room.documents - hold.documents - m.documentsRead.used,
      ),
      bytes: Math.min(
        OWNER_LOADS.call.bytes -
          since(m.bytesRead.used, start.bytesRead.used, shared.bytes, from.bytes),
        room.bytes - hold.bytes - m.bytesRead.used,
      ),
    }
  }

/* Whether the owner's other work can change `issue`'s verdict `it`. A
 * group, a Done task, an agent and zero hours never fit hours against the
 * owner's other work (lib/delay.ts, fitEndWeek), and a projected finish
 * with neither a planned end nor a due date has nothing to be judged
 * against, so its verdict is null whatever the load. */
const needsLoad = (
  issue: Doc<'issues'>,
  facts: GroupFacts | null,
  it: DelayIssue,
  capacity: number,
): boolean =>
  facts === null &&
  issue.status !== 'done' &&
  (it.end !== null || it.dueWeek !== null) &&
  (issue.remaining_hours ?? 0) > 0 &&
  Number.isFinite(capacity) &&
  capacity > 0

/* The verdict of `it` against the load `load` read for its owner `ownerId`,
 * as `me` may see it. spansByOwner puts the rows in the order the app's load
 * takes (canonicalLoad), so each week's hours add up in the same order and
 * round the same way. */
function loadVerdict(
  me: Caller,
  it: DelayIssue,
  ownerId: string,
  load: OwnedLoad | undefined,
  clock: DelayClock,
): DelayJson | null {
  if (load === undefined || load.state !== 'ok') return UNAVAILABLE_DELAY
  const spans = spansByOwner(loadRowsOf(me, load.tasks), clock.grid).get(ownerId) ?? []
  return delayJson(delayOf(it, spans, clock.todayWeek), clock.grid)
}

/**
 * Verdicts for single-task reads, for `me`. A verdict reads the owner's
 * profile. It reads the owner's load only when that load can change the
 * verdict, that is, for a task without subtasks that is not Done, has a
 * planned end or a due date to be judged against, has remaining hours above
 * zero and an owner with a finite plannable week. The load is the owner's
 * own open tasks as `me` may see them (lib/ownerLoads.ts ownerLoadReader,
 * through `access`, the single-task read's own accessOf instance, so the
 * caller's own grants, memberships and team shares are read once a read),
 * within the reader's bounds and the room the request has left (delayRoom),
 * OWNER_LOADS.call counted from the verdict's start, so the caller's own
 * rows the rest of the read counted as shared give it no more room.
 * Where it does not fit, or a check of `me`'s access a bound stopped, the
 * verdict is UNAVAILABLE_DELAY, also when the due date has passed, because
 * the projected finish rests on the load.
 */
export function taskForecaster(
  ctx: QueryCtx,
  me: Caller,
  clock: DelayClock,
  access: Access,
): Forecaster {
  return async (issue, project, facts) => {
    if (!tracked(issue, project)) return null
    const owner = taskOwnerId(issue, facts !== null)
    const profile = owner === undefined ? null : await byId(ctx, 'profiles', owner)
    const capacity = capacityOf(profile, issue.org_id)
    const it = delayIssue(issue, facts, clock, capacity)
    if (profile === null || !needsLoad(issue, facts, it, capacity)) {
      return delayJson(delayOf(it, [], clock.todayWeek), clock.grid)
    }
    const room = delayRoom(await ctx.meta.getTransactionMetrics(), { ...access.shared })
    const load = await ownerLoadReader(ctx, { me, access, room }).read(profile.id)
    return loadVerdict(me, it, profile.id, load, clock)
  }
}

/* The room of the owner reader of a list page whose delays start at
 * `start`: the page's `share` from there, every read of the owners counted,
 * the caller's own rows the access reads again included, and within the
 * request's limits less DELAY_READ_RESERVE, and less STEP_READS where a
 * round may read the caller's own rows at once. */
const shareRoom =
  (start: TransactionMetrics, share: ReadCeiling): ReadRoom =>
  (m, _shared, wide) => {
    const room = roomOf(m, DELAY_READ_RESERVE)
    const hold = wide ? STEP_READS : { ranges: 0, documents: 0, bytes: 0 }
    return {
      ranges: Math.min(
        share.ranges - (m.databaseQueries.used - start.databaseQueries.used),
        room.ranges - hold.ranges - m.databaseQueries.used,
      ),
      documents: Math.min(
        share.documents - (m.documentsRead.used - start.documentsRead.used),
        room.documents - hold.documents - m.documentsRead.used,
      ),
      bytes: Math.min(
        share.bytes - (m.bytesRead.used - start.bytesRead.used),
        room.bytes - hold.bytes - m.bytesRead.used,
      ),
    }
  }

/** A row of a list page, as its delay is judged: the task, its project and
 * whether it is a group. */
export type PageDelayRow = { issue: Doc<'issues'>; project: Doc<'projects'>; group: boolean }

/**
 * Verdicts for the rows of one page of an active task list
 * (lib/activeTaskPage.ts), for `me`, judged as taskForecaster judges a single
 * read, from the same owner reader (lib/ownerLoads.ts ownerLoadReader). It
 * reads the owners' loads before the rows are built, once the page's rows are
 * fixed, so the loads never move where a page stops. Of `rows`, in page order,
 * only those whose owner's load can change the verdict need one, and the rows
 * of one owner share one read. The owners are read one after another within
 * `share` (shareRoom), which counts every read the owner reader makes,
 * `access`'s own reads of the caller's grants, memberships and team shares
 * included. Staff get every owner the share holds, as planning.ownerLoads gives
 * them. A guest or an organization Viewer gets one owner a page, the first that
 * needs a load, because the share is spent on an owner's open tasks before the
 * reader knows which of them the caller can see, so where the next owner
 * stopped fitting would tell how much hidden work the first holds (planning.ts
 * ownerLoads). `profiles` is the organization's roster by id. A row whose owner
 * was not read, whose load was unavailable, or whose access check a bound
 * stopped is UNAVAILABLE_DELAY, also on a passed due date, as a single read is.
 * So the rows of a person with very much open work can say unavailable on every
 * page while the single read judges them, which is the agreed rule for figures
 * that depend on people's workloads (the owner's choice of 1 November 2026,
 * design-spec §9.1).
 */
export async function pageForecaster(
  ctx: QueryCtx,
  o: {
    me: Caller
    clock: DelayClock
    profiles: ReadonlyMap<string, Doc<'profiles'>>
    rows: readonly PageDelayRow[]
    access: Access
    share: ReadCeiling
  },
): Promise<Forecaster> {
  const { me, clock, profiles } = o
  // the profile of the owner of `issue`, when the organization holds it
  const ownerOf = (issue: Doc<'issues'>, group: boolean) => {
    const owner = taskOwnerId(issue, group)
    return owner === undefined ? undefined : profiles.get(owner)
  }
  const owners: string[] = []
  for (const { issue, project, group } of o.rows) {
    if (group || !tracked(issue, project)) continue
    const profile = ownerOf(issue, false)
    if (profile === undefined || owners.includes(profile.id)) continue
    const capacity = capacityOf(profile, issue.org_id)
    if (needsLoad(issue, null, delayIssue(issue, null, clock, capacity), capacity))
      owners.push(profile.id)
  }
  const loads = new Map<string, OwnedLoad>()
  if (owners.length > 0) {
    const room = shareRoom(await ctx.meta.getTransactionMetrics(), o.share)
    const reader = ownerLoadReader(ctx, { me, access: o.access, room })
    // a guest's or Viewer's one owner a page (above)
    for (const owner of isOrgStaff(me) ? owners : owners.slice(0, 1)) {
      const load = await reader.read(owner)
      if (load.state === 'not_read') break
      loads.set(owner, load)
    }
  }
  return async (issue, project, facts) => {
    if (!tracked(issue, project)) return null
    const profile = ownerOf(issue, facts !== null)
    const capacity = capacityOf(profile, issue.org_id)
    const it = delayIssue(issue, facts, clock, capacity)
    if (profile === undefined || !needsLoad(issue, facts, it, capacity)) {
      return delayJson(delayOf(it, [], clock.todayWeek), clock.grid)
    }
    return loadVerdict(me, it, profile.id, loads.get(profile.id), clock)
  }
}
