/* The app's projected delay (lib/delay.ts) on REST and MCP task rows. Each
 * verdict's inputs come from stored rows the way the app's store builds them
 * from its snapshot (src/store/planner.ts rebuild). They are the task's plan,
 * due date and remaining hours, its owner's plannable hours, and its owner's
 * other scheduled work as the reader may see it (planning.ts orgLoadRows, the
 * snapshot's own rule). A group's plan weeks and completion are its group
 * facts (lib/core.ts groupFacts), the app's groupSpan and isIssueDone.
 *
 * Today is the request's clock, which the HTTP action passes as `now`,
 * because a query that read the time itself could answer from Convex's cache
 * on a later day. The server judges it, and remaining_set_at, by UTC day on
 * the organization's week grid (lib/workload.ts weekGrid). The app judges
 * both in the browser's time zone, so near midnight or a week boundary the
 * two can differ. Week indexes on the two grids differ by a constant, which
 * every comparison and projection cancels. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { orgLoadRows } from '../planning'
import type { Caller, GroupFacts } from './core'
import { byId } from './db'
import { type DelayInfo, type DelayIssue, type DelayStatus, delayOf, delayProjector } from './delay'
import { ISSUE_STATUSES } from './enums'
import { taskOwnerId } from './review'
import { type OrgProjectView, orgProjectView } from './visibility'
import {
  DEFAULT_PLANNABLE_HOURS,
  type LoadSpan,
  plannableHoursOf,
  type WeekGrid,
  weekGrid,
} from './workload'

/** A delay verdict as REST and MCP send it, with the app's status and the
 * first day of the week the work is projected to finish, null when `late`
 * rests on a passed due date alone. */
export type DelayJson = { status: DelayStatus; projected_end_week: string | null }

/** The day every verdict of one read is judged on, and the organization's
 * week grid. */
export type DelayClock = { grid: WeekGrid; today: string; todayWeek: number }

/** The clock of a read made at `now`, an ISO timestamp, in an organization. */
export function delayClock(
  org: Pick<Doc<'organizations'>, 'week_start'> | null,
  now: string,
): DelayClock {
  const grid = weekGrid(org?.week_start ?? 1)
  const today = new Date(now).toISOString().slice(0, 10)
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

/* Load rows as the delay projection walks them, by owner. */
function spansByOwner(rows: ReturnType<typeof orgLoadRows>, grid: WeekGrid) {
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

/**
 * Verdicts for single-task reads, for `me`. A verdict reads the owner's
 * profile. It reads the owner's load (ownerLoadSpans) over the
 * organization's projects as `me` sees them only when that load can change
 * the verdict, that is, for a task without subtasks that is not Done, has a
 * planned end or a due date to be judged against, has remaining hours above
 * zero and an owner with a finite plannable week.
 */
export function taskForecaster(ctx: QueryCtx, me: Caller, clock: DelayClock): Forecaster {
  let view: Promise<LoadView> | undefined
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
      profile !== null &&
      facts === null &&
      issue.status !== 'done' &&
      (it.end !== null || it.dueWeek !== null) &&
      (issue.remaining_hours ?? 0) > 0 &&
      Number.isFinite(capacity) &&
      capacity > 0
    let load: LoadSpan[] = []
    if (needsLoad) {
      view ??= orgProjectView(ctx, me)
      load = await ownerLoadSpans(ctx, me, profile, clock.grid, await view)
    }
    return delayJson(delayOf(it, load, clock.todayWeek), clock.grid)
  }
}

/* The statuses of tasks that can carry load, as orgLoadRows skips Done ones. */
const LOAD_STATUSES = ISSUE_STATUSES.filter((status) => status !== 'done')

/* How many of an owner's tasks a delay verdict checks for an active
 * subtask, one by_parent_archived read each, before it reads the
 * organization's active tasks once instead, the read an active list makes
 * anyway. With the single read's subtree walk (lib/core.ts SUBTREE_WALK)
 * that keeps the read's index ranges far below Convex's 4,096. Tests lower
 * `reads`. */
export const OWNER_LOAD_CHECKS = { reads: 500 }

/**
 * The load rows of `owner`'s work as `me` may see them, as delay walks
 * them. These are orgLoadRows' rows owned by `owner`, read through the
 * owner's own open tasks (those assigned to them that are not Done, and
 * those In Review that they review) rather than the organization's active
 * ones. A task with an active subtask is a group, which carries no load, so
 * each candidate that orgLoadRows would keep is checked for one. Past
 * OWNER_LOAD_CHECKS candidates it reads the organization's active tasks
 * instead, where orgLoadRows finds the groups itself. Empty for an owner
 * outside `me`'s organization, as orgLoadRows gives such an owner no rows.
 */
export async function ownerLoadSpans(
  ctx: QueryCtx,
  me: Caller,
  owner: Doc<'profiles'>,
  grid: WeekGrid,
  view: LoadView,
): Promise<LoadSpan[]> {
  if (owner.org_id !== me.org_id) return []
  const held = [
    ...LOAD_STATUSES.map((status) =>
      ctx.db
        .query('issues')
        .withIndex('by_assignee_archived_status', (q) =>
          q.eq('assignee_id', owner.id).eq('archived_at', undefined).eq('status', status),
        ),
    ),
    // a reviewer owns a task only while it is in review (lib/review.ts)
    ctx.db
      .query('issues')
      .withIndex('by_reviewer_archived_status', (q) =>
        q.eq('reviewer_id', owner.id).eq('archived_at', undefined).eq('status', 'review'),
      ),
  ]
  const tasks = new Map<string, Doc<'issues'>>()
  for (const range of held) for await (const task of range) tasks.set(task.id, task)
  // what orgLoadRows drops anyway needs no subtask read
  const candidates = [...tasks.values()].filter(
    (task) =>
      task.org_id === me.org_id &&
      taskOwnerId(task) === owner.id &&
      task.start_week !== undefined &&
      task.status !== 'done' &&
      !task.paused &&
      (task.remaining_hours ?? 0) > 0,
  )
  let rows: Doc<'issues'>[] = []
  if (candidates.length > OWNER_LOAD_CHECKS.reads) {
    rows = await ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) => q.eq('org_id', me.org_id).eq('archived_at', undefined))
      .collect()
  } else {
    for (const task of candidates) {
      const kid = await ctx.db
        .query('issues')
        .withIndex('by_parent_archived', (q) =>
          q.eq('parent_id', task.id).eq('archived_at', undefined),
        )
        .first()
      if (kid === null) rows.push(task)
    }
    // in the organization's active order (by_org_archived), which the
    // list's load and the app's follow, so each week's hours add up in the
    // same order and round the same way
    rows.sort((a, b) => a._creationTime - b._creationTime)
  }
  return spansByOwner(orgLoadRows(me, view, new Set([owner.id]), rows), grid).get(owner.id) ?? []
}
