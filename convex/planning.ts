/* The plan_* load family. Both walks disclose busy TIME from projects the
 * caller cannot see, while the projection strips the identity. The fence is
 * in the filter, the anonymization in the projection — kept distinct here.
 *
 * Shared fence (both walks):
 *   scheduled (start_week set — the 0037 envelope CHECK means end_week too),
 *   ordinary task (no subtask that makes it a group, lib/liveTasks.ts
 *   countsAsSubtask), status <> done (0073), not paused
 *   (#310: its owner is free for other work; a paused Review task drops out
 *   too), issue not archived (0070), project not archived (0106), owner
 *   (lib/review.ts: the reviewer while In Review with one set, else the
 *   assignee) is a profile of THIS org (0065 — deliberately NO active and NO
 *   kind test: an inactive person's or an agent's scheduled work still counts
 *   as load), and the disclosure trio (0085 guests / 0102 viewers):
 *   isOrgStaff(caller) OR can_see_project(issue) OR the caller owns the row.
 *   So staff get every qualifying row (invisible ones anonymized), while
 *   guests/viewers get only visible-or-own rows — other people's hidden work
 *   does not arrive at all, not even anonymously.
 *
 * org_load ONLY adds `remaining_hours > 0`; assigneeLoad has NO remaining
 * filter — unestimated/zero-remaining scheduled rows are included. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { isOrgStaff } from './lib/access'
import { byId } from './lib/db'
import type { OrgRole, ProfileKind } from './lib/enums'
import { authedQuery, badRequest } from './lib/functions'
import { groupTest, liveIn, liveTasksOf, ownedOpenTasks } from './lib/liveTasks'
import { taskOwnerId } from './lib/review'
import { type OrgProjectView, orgProjectView } from './lib/visibility'
import { committedByWeek, type LoadSpan, weekGrid } from './lib/workload'
import { hasSubtasks } from './model/issues'
import { roundTenths } from './model/taskValues'

/* rows.orgLoad element, field names verbatim (planner.ts:90): `remaining`,
 * NOT remaining_hours. */
export type OrgLoadRow = {
  issue_id: string | null
  // the effective owner: the reviewer while In Review with one set, else the assignee (#314)
  owner_id: string
  start_week: string
  end_week: string
  remaining: number
  remaining_set_at: string | null
}

/* plan_assignee_load's wire shape — the SQL column names exactly. The client
 * never reads `title` today, but it is in the SQL contract; kept. */
export type AssigneeLoadRow = {
  issue_id: string | null
  title: string | null
  project_id: string | null
  project_name: string | null
  start_week: string
  end_week: string
  remaining: number | null
  remaining_set_at: string | null
  visible: boolean
}

/* plan_org_load for one org. orgProfileIds = ALL profile ids of the org
 * (active + inactive + agents) — the 0065 owner fence. The snapshot passes
 * its live task read (lib/liveTasks.ts liveTasksOf) so planning and grouping
 * do not scan it again. A task's group state comes from those rows, which
 * hold every subtask that makes a task in an active project a group. The
 * REST and MCP delay verdicts (lib/machineDelay.ts) pass the machine
 * catalogue and access flags as `view`, the same projects and rule. */
export function orgLoadRows(
  me: Doc<'profiles'>,
  view: Pick<OrgProjectView, 'byUuid' | 'visible'>,
  orgProfileIds: Set<string>,
  issues: readonly Doc<'issues'>[],
): OrgLoadRow[] {
  const staff = isOrgStaff(me)
  const rows: OrgLoadRow[] = []
  const isGroup = groupTest(issues, liveIn(view.byUuid))
  for (const i of issues) {
    if (isGroup(i)) continue
    // groups are skipped above, so the rule's isGroup default holds
    const owner = taskOwnerId(i)
    if (owner === undefined) continue
    if (i.start_week === undefined || i.end_week === undefined) continue
    if (i.status === 'done' || i.paused) continue
    const remaining = i.remaining_hours ?? 0
    if (!(remaining > 0)) continue
    if (i.archived_at !== undefined) continue
    const project = view.byUuid.get(i.project_id)
    if (project === undefined || project.archived_at !== undefined) continue
    if (!orgProfileIds.has(owner)) continue
    const vis = view.visible(i.project_id)
    if (!(staff || vis || owner === me.id)) continue
    rows.push({
      issue_id: vis ? i.id : null,
      owner_id: owner,
      start_week: i.start_week,
      end_week: i.end_week,
      remaining,
      remaining_set_at: i.remaining_set_at ?? null,
    })
  }
  return rows
}

/** How many of a person's tasks their load checks for subtasks, one
 * by_parent_archived range each, before it reads the organization's live
 * tasks once instead (lib/machineDelay.ts OWNER_LOAD_CHECKS does the same
 * for a delay verdict). Tests lower `reads`. */
export const ASSIGNEE_LOAD_CHECKS = { reads: 500 }

/* plan_assignee_load: the person's own live tasks that are not Done
 * (lib/liveTasks.ts ownedOpenTasks), never the organization's. A task that
 * passes every other test is checked for subtasks on its own (hasSubtasks),
 * or, past ASSIGNEE_LOAD_CHECKS such tasks, against the organization's live
 * tasks (lib/liveTasks.ts groupTest), so a group is left out as in
 * orgLoadRows. */
async function assigneeLoadRows(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  view: OrgProjectView,
  assigneeId: string,
): Promise<AssigneeLoadRow[]> {
  const staff = isOrgStaff(me)
  const live = liveIn(view.byUuid)
  // each task that passes every test but the group one, with its row
  const candidates: { task: Doc<'issues'>; row: AssigneeLoadRow }[] = []
  // ownedOpenTasks leaves out Done tasks and tasks outside active projects
  for (const i of await ownedOpenTasks(ctx, assigneeId, live)) {
    if (i.start_week === undefined || i.end_week === undefined) continue
    if (i.paused) continue
    const project = view.byUuid.get(i.project_id)
    if (project === undefined) continue
    const vis = view.visible(i.project_id)
    if (!(staff || vis || assigneeId === me.id)) continue
    candidates.push({
      task: i,
      row: {
        issue_id: vis ? i.id : null,
        title: vis ? i.title : null,
        project_id: vis ? i.project_id : null,
        project_name: vis ? project.name : null,
        start_week: i.start_week,
        end_week: i.end_week,
        remaining: i.remaining_hours ?? null,
        remaining_set_at: i.remaining_set_at ?? null,
        visible: vis,
      },
    })
  }
  const isGroup =
    candidates.length > ASSIGNEE_LOAD_CHECKS.reads
      ? groupTest(await liveTasksOf(ctx, view.projects), live)
      : null
  const rows: AssigneeLoadRow[] = []
  for (const { task, row } of candidates) {
    if (!(isGroup === null ? await hasSubtasks(ctx, task, live) : isGroup(task))) rows.push(row)
  }
  return rows
}

/* The person whose owned load: the assignee, or the reviewer while the task
 * is In Review (lib/review.ts). The arg keeps its `assignee_id` name. The
 * org is resolved server-side as that person's own org (the client's
 * `rows.profiles.get(uuid).org_id || HOME_ORG` fallback wart, removed).
 * Parity with the SQL fences: an unknown person, or a caller holding no
 * active seat in that person's org, yields an EMPTY ARRAY, not an error. */
export const assigneeLoad = authedQuery({
  args: { assignee_id: v.string() },
  handler: async (ctx, { assignee_id }): Promise<AssigneeLoadRow[]> => {
    const assignee = await byId(ctx, 'profiles', assignee_id)
    if (assignee === null) return []
    const me = ctx.myProfiles.get(assignee.org_id)
    if (me === undefined) return []
    const view = await orgProjectView(ctx, me)
    return await assigneeLoadRows(ctx, me, view, assignee.id)
  },
})

/** One person's planned hours per week, as REST and MCP read them. */
export type PersonWorkloadJson = {
  id: string
  name: string
  org_role: OrgRole
  kind: ProfileKind
  active: boolean
  /** null for an agent, whose capacity is unbounded */
  plannable_hours: number | null
  /** planned hours in each week of week_starts, tasks the caller cannot see included */
  hours: number[]
  /** the part of hours from tasks the caller cannot see, which stay unnamed */
  hidden_hours: number[]
}

/** The REST and MCP workload read. */
export type WorkloadJson = {
  /** the first day of each week, in order */
  week_starts: string[]
  /** the project the hours are limited to, or null for all of them */
  project: { id: string; key: string; name: string } | null
  people: PersonWorkloadJson[]
}

/** The refusal of a workload window with a week outside the years 0000 to
 * 9999. */
export const WORKLOAD_YEARS = 'the workload window must fall within the years 0000 to 9999'

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Each person's planned hours for `weeks` weeks from the week holding
 * `fromDay` (YYYY-MM-DD), as `me` may see them. The rows are orgLoadRows for
 * `me`, which hold work owned by the reviewer while In Review, else the
 * assignee, scheduled, not done, not paused, with remaining hours, outside
 * archived tasks and projects. Staff also receive the rows of projects they
 * cannot see, counted in hours and again, unnamed, in hidden_hours, the part
 * of hours they cannot see; viewers and guests receive only rows they can
 * see or own. Each row's remaining hours spread
 * over its weeks by the app's rule, and only the requested weeks are added
 * up, so the work follows the window. `project`, a project `me` can see,
 * limits the hours to it and its visible sub-projects, which leaves no
 * hidden hours. Lists every active member of the organization and every
 * inactive one with hours in the window, ordered by name. It reads the live
 * tasks of the organization, one index range per active project
 * (lib/liveTasks.ts liveTasksOf), also with `project`, because a subtask
 * stored before subtasks had to stay in their parent's top-level project
 * can make a task there a group.
 */
export async function workloadCore(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  o: { fromDay: string; weeks: number; project: Doc<'projects'> | null },
): Promise<WorkloadJson> {
  const org = await byId(ctx, 'organizations', me.org_id)
  const grid = weekGrid(org?.week_start ?? 1)
  const first = grid.ofDay(o.fromDay)
  // the week holding 0000-01-01 can start in year -1, and a late 9999
  // window can run past year 9999, where week_starts would not be YYYY-MM-DD
  if (
    !DAY_SHAPE.test(grid.firstDay(first)) ||
    !DAY_SHAPE.test(grid.firstDay(first + o.weeks - 1))
  ) {
    throw badRequest(WORKLOAD_YEARS)
  }
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', me.org_id))
    .collect()
  const view = await orgProjectView(ctx, me)
  const issues = await liveTasksOf(ctx, view.projects)
  const scope =
    o.project === null
      ? null
      : new Set([
          o.project.id,
          ...view.projects
            .filter((p) => p.parent_id === o.project?.id && view.visible(p.id))
            .map((p) => p.id),
        ])
  const projectOf = new Map(issues.map((i) => [i.id, i.project_id]))
  const rows = orgLoadRows(me, view, new Set(profiles.map((p) => p.id)), issues).filter(
    (row) =>
      scope === null || (row.issue_id !== null && scope.has(projectOf.get(row.issue_id) ?? '')),
  )
  const spans = new Map<string, { all: LoadSpan[]; hidden: LoadSpan[] }>()
  for (const row of rows) {
    const span: LoadSpan = {
      issueUuid: row.issue_id,
      start: grid.ofDay(row.start_week),
      end: grid.ofDay(row.end_week),
      remaining: row.remaining,
      remainingSet: row.remaining_set_at === null ? null : grid.ofInstant(row.remaining_set_at),
    }
    const own = spans.get(row.owner_id) ?? { all: [], hidden: [] }
    own.all.push(span)
    if (row.issue_id === null) own.hidden.push(span)
    spans.set(row.owner_id, own)
  }
  const window = Array.from({ length: o.weeks }, (_, i) => first + i)
  // only the asked weeks are added up, however far a plan runs
  const asked = { from: first, to: first + o.weeks - 1 }
  const perWeek = (items: LoadSpan[]): number[] => {
    const byWeek = committedByWeek(items, null, asked)
    return window.map((week) => roundTenths(byWeek.get(week) ?? 0))
  }
  const people: PersonWorkloadJson[] = []
  const roster = [...profiles].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  )
  for (const p of roster) {
    const own = spans.get(p.id)
    const hours = perWeek(own?.all ?? [])
    if (!p.active && hours.every((h) => h === 0)) continue
    people.push({
      id: p.id,
      name: p.name,
      org_role: p.org_role,
      kind: p.kind,
      active: p.active,
      plannable_hours: p.plannable_hours ?? null,
      hours,
      hidden_hours: perWeek(own?.hidden ?? []),
    })
  }
  return {
    week_starts: window.map(grid.firstDay),
    project:
      o.project === null ? null : { id: o.project.id, key: o.project.key, name: o.project.name },
    people,
  }
}
