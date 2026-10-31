/* The app's projected delay (lib/delay.ts) on REST and MCP task rows. Each
 * verdict's inputs come from stored rows the way the app's store builds them
 * from its snapshot (src/store/planner.ts rebuild). They are the task's plan,
 * due date and remaining hours, its owner's plannable hours, and its owner's
 * other scheduled work as the reader may see it, the load rows of the
 * snapshot's own rule (lib/loadRows.ts loadRowFor). A list row takes them
 * from the organization's active tasks the list read (planning.ts
 * orgLoadRows), and a single-task read from the owner's own open tasks
 * (lib/ownerLoads.ts), which answers `unavailable` where that work does not
 * fit the reader's bounds. A group's plan weeks and completion are its group
 * facts (lib/core.ts groupFacts), the app's groupSpan and isIssueDone.
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
import { orgLoadRows } from '../planning'
import { type Access, accessOf, OWN_READS } from './access'
import { LEVEL_STEP_READS, type ReadCeiling, roomOf } from './archivedTasks'
import type { Caller, GroupFacts } from './core'
import { byId } from './db'
import { type DelayInfo, type DelayIssue, type DelayStatus, delayOf, delayProjector } from './delay'
import { TEAM_ROW_MAX_BYTES } from './limits'
import type { OrgLoadRow } from './loadRows'
import { loadRowsOf, OWNER_LOADS, ownerLoadReader, type ReadRoom } from './ownerLoads'
import { taskOwnerId } from './review'
import type { OrgProjectView } from './visibility'
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
 * rests on a passed due date alone. A single-task read's status is
 * `unavailable`, with no week, where the owner's other work did not fit the
 * owner reader's bounds (UNAVAILABLE_DELAY); a list row's never is. */
export type DelayJson = { status: DelayStatus | 'unavailable'; projected_end_week: string | null }

/** The verdict of a single-task read whose owner's other scheduled work
 * Qivo could not read within its bounds, or whose check of the caller's
 * access a bound stopped (lib/ownerLoads.ts). It is never a verdict that
 * counts missing work as free time. */
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

/** The projects a reader's load rows are judged by, which are every project
 * of the organization by id and whether the reader can read each one. */
export type LoadView = Pick<OrgProjectView, 'byUuid' | 'visible'>

/**
 * Verdicts for the rows of an active task list, for `me`. The list already
 * read the organization's `active` tasks, its roster (`profiles`) and its
 * projects, which hold every input, so a verdict reads nothing more. The
 * owners' load rows are built once, on the first verdict that projects.
 */
export function listForecaster(o: {
  clock: DelayClock
  me: Caller
  active: readonly Doc<'issues'>[]
  view: LoadView
  profiles: readonly Doc<'profiles'>[]
}): Forecaster {
  const profiles = new Map(o.profiles.map((p) => [p.id, p]))
  let load: Map<string, LoadSpan[]> | undefined
  const verdict = delayProjector((owner) => {
    load ??= spansByOwner(
      orgLoadRows(o.me, o.view, new Set(profiles.keys()), o.active),
      o.clock.grid,
    )
    return load.get(owner) ?? []
  }, o.clock.todayWeek)
  return async (issue, project, facts) => {
    if (!tracked(issue, project)) return null
    const owner = taskOwnerId(issue, facts !== null)
    const capacity = capacityOf(owner === undefined ? null : profiles.get(owner), issue.org_id)
    return delayJson(verdict(delayIssue(issue, facts, o.clock, capacity)), o.clock.grid)
  }
}

/** What a single-task read keeps back from the request's limits while its
 * owner's load is read (taskForecaster). lib/core.ts taskOut reads the
 * verdict after everything else, so nothing is read after it, and this
 * holds what the owner reader (lib/ownerLoads.ts) may read past its last
 * look at the metrics while it asks about one sub-project and its top-level
 * project (past those it holds STEP_READS too): the row it read last, up to
 * Convex's document size limit, and the single-row reads of the caller's
 * access that no price counts, within the testing envelope the caller's
 * membership in each team that shares the two projects (at most 50, 25 a
 * project) and the rows of the caller's teams among them (at most 25), each
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
 * `start`: OWNER_LOADS.call from there, past the access instance's shared
 * reads, and within the request's limits less DELAY_READ_RESERVE, and less
 * STEP_READS where a round may read the caller's own rows at once, as those
 * reads count against the request's limits like any other. */
const delayRoom =
  (start: TransactionMetrics): ReadRoom =>
  (m, shared, wide) => {
    const room = roomOf(m, DELAY_READ_RESERVE)
    const hold = wide ? STEP_READS : { ranges: 0, documents: 0, bytes: 0 }
    const since = (now: number, then: number, own: number) => now - then - own
    return {
      ranges: Math.min(
        OWNER_LOADS.call.ranges -
          since(m.databaseQueries.used, start.databaseQueries.used, shared.ranges),
        room.ranges - hold.ranges - m.databaseQueries.used,
      ),
      documents: Math.min(
        OWNER_LOADS.call.documents -
          since(m.documentsRead.used, start.documentsRead.used, shared.documents),
        room.documents - hold.documents - m.documentsRead.used,
      ),
      bytes: Math.min(
        OWNER_LOADS.call.bytes - since(m.bytesRead.used, start.bytesRead.used, shared.bytes),
        room.bytes - hold.bytes - m.bytesRead.used,
      ),
    }
  }

/**
 * Verdicts for single-task reads, for `me`. A verdict reads the owner's
 * profile. It reads the owner's load only when that load can change the
 * verdict, that is, for a task without subtasks that is not Done, has a
 * planned end or a due date to be judged against, has remaining hours above
 * zero and an owner with a finite plannable week. The load is the owner's
 * own open tasks as `me` may see them (lib/ownerLoads.ts ownerLoadReader,
 * through one accessOf instance made on first need), within the reader's
 * bounds and the room the request has left (delayRoom). Where it does not
 * fit, or a check of `me`'s access a bound stopped, the verdict is
 * UNAVAILABLE_DELAY, also when the due date has passed, because the
 * projected finish rests on the load.
 */
export function taskForecaster(ctx: QueryCtx, me: Caller, clock: DelayClock): Forecaster {
  let access: Access | undefined
  return async (issue, project, facts) => {
    if (!tracked(issue, project)) return null
    const owner = taskOwnerId(issue, facts !== null)
    const profile = owner === undefined ? null : await byId(ctx, 'profiles', owner)
    const capacity = capacityOf(profile, issue.org_id)
    const it = delayIssue(issue, facts, clock, capacity)
    // a group, a Done task, an agent and zero hours never fit hours against
    // the owner's other work (lib/delay.ts, fitEndWeek), and a projected
    // finish with neither a planned end nor a due date has nothing to be
    // judged against, so its verdict is null whatever the load
    const needsLoad =
      facts === null &&
      issue.status !== 'done' &&
      (it.end !== null || it.dueWeek !== null) &&
      (issue.remaining_hours ?? 0) > 0 &&
      Number.isFinite(capacity) &&
      capacity > 0
    if (profile === null || !needsLoad) {
      return delayJson(delayOf(it, [], clock.todayWeek), clock.grid)
    }
    access ??= accessOf(ctx, me)
    const room = delayRoom(await ctx.meta.getTransactionMetrics())
    const load = await ownerLoadReader(ctx, { me, access, room }).read(profile.id)
    if (load.state !== 'ok') return UNAVAILABLE_DELAY
    // spansByOwner puts the rows in the order the list's load and the
    // app's take (canonicalLoad), so each week's hours add up in the same
    // order and round the same way
    const spans = spansByOwner(loadRowsOf(me, load.tasks), clock.grid).get(profile.id) ?? []
    return delayJson(delayOf(it, spans, clock.todayWeek), clock.grid)
  }
}
