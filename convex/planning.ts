/* The plan_* load family. Two walks disclose busy TIME from projects the
 * caller cannot see, while the projection strips the identity. The fence is
 * in the filter, the anonymization in the projection — kept distinct here.
 * orgLoadRows walks an organization's live tasks, for the REST and MCP
 * lists and workload. The owner reader (lib/ownerLoads.ts) walks one
 * owner's open tasks, for assigneeLoad, ownerLoads and the single-task
 * delay, within bounds past which an owner's load is unavailable.
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
 *   as load), and the disclosure trio (0085 guests / 0102 viewers,
 *   lib/loadRows.ts loadShown):
 *   isOrgStaff(caller) OR can_see_project(issue) OR the caller owns the row.
 *   So staff get every qualifying row (invisible ones anonymized), while
 *   guests/viewers get only visible-or-own rows — other people's hidden work
 *   does not arrive at all, not even anonymously.
 *
 * org_load and ownerLoads ONLY add `remaining_hours > 0`; assigneeLoad has
 * NO remaining filter — unestimated/zero-remaining scheduled rows are
 * included. */

import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { accessOf, accessUnchecked, isOrgStaff } from './lib/access'
import { byId } from './lib/db'
import type { OrgRole, ProfileKind } from './lib/enums'
import { authedQuery, badRequest, orgQuery, type Refusal } from './lib/functions'
import { groupTest, liveIn, liveTasksOf } from './lib/liveTasks'
import { loadRowFor, type OrgLoadRow } from './lib/loadRows'
import { callRoom, loadRowsOf, OWNER_LOADS, ownerLoadReader } from './lib/ownerLoads'
import { type OrgProjectView, orgProjectView } from './lib/visibility'
import { canonicalLoad, committedByWeek, type LoadSpan, weekGrid } from './lib/workload'
import { roundTenths } from './model/taskValues'

export type { OrgLoadRow }

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

/* plan_org_load for one org, each task through the one fence
 * (lib/loadRows.ts loadRowFor). orgProfileIds = ALL profile ids of the org
 * (active + inactive + agents), the 0065 owner fence. The snapshot passes
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
  const live = liveIn(view.byUuid)
  const isGroup = groupTest(issues, live)
  const ownerInOrg = (id: string) => orgProfileIds.has(id)
  const rows: OrgLoadRow[] = []
  for (const i of issues) {
    const row = loadRowFor(i, {
      isGroup: isGroup(i),
      projectLive: live(i.project_id),
      ownerInOrg,
      visible: view.visible(i.project_id),
      staff,
      meId: me.id,
    })
    if (row !== null) rows.push(row)
  }
  return rows
}

/** The reason of the refusal of a load that does not fit the owner
 * reader's bounds (loadUnavailable). */
export const LOAD_UNAVAILABLE = 'load_unavailable'

/** The refusal of a person's load that the owner reader (lib/ownerLoads.ts)
 * could not read within its bounds, so the planning panel says the
 * workload is unavailable rather than counting the missing work as free
 * time. */
export const loadUnavailable = (): ConvexError<Refusal> =>
  new ConvexError<Refusal>({
    code: 'rule',
    reason: LOAD_UNAVAILABLE,
    message: "Qivo could not read all of this person's planned work in one request.",
  })

/* AssigneeLoadRows in one total order, so the answer never tells the
 * creation order or project of a row the caller cannot see: by weeks, the
 * measurement and the hours, an unestimated row first, then the task id, a
 * hidden row's null first (lib/ownerLoads.ts byLoadRow). */
function byAssigneeRow(a: AssigneeLoadRow, b: AssigneeLoadRow): number {
  const keys = (r: AssigneeLoadRow) => [r.start_week, r.end_week, r.remaining_set_at ?? '']
  const [x, y] = [keys(a), keys(b)]
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  if (a.remaining !== b.remaining) return (a.remaining ?? -1) - (b.remaining ?? -1)
  if (a.issue_id === b.issue_id) return 0
  if (a.issue_id === null) return -1
  if (b.issue_id === null) return 1
  return a.issue_id < b.issue_id ? -1 : 1
}

/* The person whose owned load: the assignee, or the reviewer while the task
 * is In Review (lib/review.ts). The arg keeps its `assignee_id` name. The
 * org is resolved server-side as that person's own org (the client's
 * `rows.profiles.get(uuid).org_id || HOME_ORG` fallback wart, removed).
 * Parity with the SQL fences: an unknown person, or a caller holding no
 * active seat in that person's org, yields an EMPTY ARRAY, not an error.
 *
 * The rows are the person's own open tasks, read by the owner reader
 * (lib/ownerLoads.ts) with unestimated ones kept, in one total order
 * (byAssigneeRow). Where the reader's bounds stop the read it refuses with
 * loadUnavailable, and where a bound stopped a check of the caller's access
 * with accessUnchecked, so the planning panel says the workload is
 * unavailable, never that the person is free. */
export const assigneeLoad = authedQuery({
  args: { assignee_id: v.string() },
  handler: async (ctx, { assignee_id }): Promise<AssigneeLoadRow[]> => {
    const assignee = await byId(ctx, 'profiles', assignee_id)
    if (assignee === null) return []
    const me = ctx.myProfiles.get(assignee.org_id)
    if (me === undefined) return []
    const access = accessOf(ctx, me)
    const reader = ownerLoadReader(ctx, { me, access, room: callRoom, unestimated: true })
    const load = await reader.read(assignee.id)
    if (load.state === 'unavailable' && load.why === 'access') throw accessUnchecked()
    // the first owner of a read is never not_read
    if (load.state !== 'ok') throw loadUnavailable()
    return load.tasks
      .map(
        ({ task, project, visible }): AssigneeLoadRow => ({
          issue_id: visible ? task.id : null,
          title: visible ? task.title : null,
          project_id: visible ? task.project_id : null,
          project_name: visible ? project.name : null,
          // the reader answers scheduled tasks only
          start_week: task.start_week ?? '',
          end_week: task.end_week ?? '',
          remaining: task.remaining_hours ?? null,
          remaining_set_at: task.remaining_set_at ?? null,
          visible,
        }),
      )
      .sort(byAssigneeRow)
  },
})

/** One span of an owner's load on the wire: a load row (lib/loadRows.ts
 * OrgLoadRow) without its owner. `issue_id` is the task's id when the
 * caller can see its project, else null. */
export type OwnerLoadSpan = Omit<OrgLoadRow, 'owner_id'>

/** One owner of planning.ownerLoads' answer: `ok` with every span of their
 * load, `unavailable` when it did not fit the reader's bounds or a check of
 * the caller's access stopped, `not_read` when the call had no room left
 * for it, or did not read it because the caller is a guest or Viewer and
 * it is not the first, so asking again with fewer owners reads it. */
export type OwnerLoadJson =
  | { owner_id: string; state: 'ok'; spans: OwnerLoadSpan[] }
  | { owner_id: string; state: 'unavailable' }
  | { owner_id: string; state: 'not_read' }

/** planning.ownerLoads' answer. */
export type OwnerLoadsJson = {
  /** 'counted': spans of projects the caller cannot see are in every
   * owner's load, without a task id (organization admins and users).
   * 'own_only': only in the caller's own load (guests and organization
   * Viewers), so another person's load leaves them out and is a
   * permission-limited figure. It follows the caller's role alone. */
  hidden: 'counted' | 'own_only'
  /** the owners in the order asked, each once */
  owners: OwnerLoadJson[]
}

/**
 * The load of each of `owner_ids` (at most OWNER_LOADS.owners, compared in
 * lowercase, each once, in the order given) as the caller may see it, for
 * delays and availability without the workspace's load rows. Each owner's
 * spans are their load rows (the fence above, remaining hours above zero)
 * in one total order (lib/ownerLoads.ts byLoadRow), read by the owner
 * reader within its bounds. An owner of another organization or an unknown
 * id answers `ok` with no spans. An owner whose spans would take the answer
 * past OWNER_LOADS.spans answers `not_read`, unless it is the first, and so
 * does every owner after a `not_read` one.
 *
 * A guest or organization Viewer gets one owner a call, the first, and
 * every later owner answers `not_read`. One room serves every owner of a
 * call, and the reader spends it on an owner's open tasks before it knows
 * which of them the caller can see, so where `not_read` started would
 * tell such a caller how much hidden work the owners before it hold.
 * Asking again for the `not_read` owners reads the next one. Staff keep
 * every owner the room holds: they already receive each person's hidden
 * work as busy time without a task id (lib/loadRows.ts loadShown).
 *
 * It reads each owner's profile and five open-task ranges, the project row
 * of each project their scheduled tasks name, the caller's access to the
 * live ones (their own grants, memberships and team shares among it) and a
 * subtask range for each task left. So a change to those reruns it, and no
 * other change in the organization does. Nothing in the app calls it yet:
 * the view stages and the task window read it once they stop reading the
 * workspace's load rows.
 */
export const ownerLoads = orgQuery({
  args: { owner_ids: v.array(v.string()) },
  handler: async (ctx, { owner_ids }): Promise<OwnerLoadsJson> => {
    const ids = [...new Set(owner_ids.map((id) => id.toLowerCase()))]
    if (ids.length > OWNER_LOADS.owners) {
      throw badRequest(`at most ${OWNER_LOADS.owners} people at a time`)
    }
    const staff = isOrgStaff(ctx.me)
    const access = accessOf(ctx, ctx.me)
    const reader = ownerLoadReader(ctx, { me: ctx.me, access, room: callRoom })
    const owners: OwnerLoadJson[] = []
    let spans = 0
    let ended = false
    for (const owner_id of ids) {
      // a guest's or Viewer's cut follows the order asked alone (above)
      if (!staff && owners.length > 0) ended = true
      const load = ended ? null : await reader.read(owner_id)
      if (load === null || load.state === 'not_read') {
        ended = true
        owners.push({ owner_id, state: 'not_read' })
      } else if (load.state === 'unavailable') {
        owners.push({ owner_id, state: 'unavailable' })
      } else {
        const rows = loadRowsOf(ctx.me, load.tasks).map(({ owner_id: _, ...span }) => span)
        if (owners.length > 0 && spans + rows.length > OWNER_LOADS.spans) {
          ended = true
          owners.push({ owner_id, state: 'not_read' })
        } else {
          spans += rows.length
          owners.push({ owner_id, state: 'ok', spans: rows })
        }
      }
    }
    return { hidden: staff ? 'counted' : 'own_only', owners }
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
 * tasks of the organization (lib/liveTasks.ts liveTasksOf), also with
 * `project`, because a subtask
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
  // only the asked weeks are added up, however far a plan runs, in the
  // order the app adds them (canonicalLoad)
  const asked = { from: first, to: first + o.weeks - 1 }
  const perWeek = (items: LoadSpan[]): number[] => {
    const byWeek = committedByWeek(canonicalLoad(items), null, asked)
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
