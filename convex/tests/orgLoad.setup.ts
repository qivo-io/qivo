/* The organization-wide load fence, kept as the oracle that the owner
 * reader (lib/ownerLoads.ts), the REST and MCP workload pages
 * (planning.ts workloadPage) and the app's load rows are pinned against:
 * every live task of the organization (liveTasksOf), which of them are
 * groups by the subtasks among them (groupTest), the load rows of them all
 * through the one fence (orgLoadRows over lib/loadRows.ts loadRowFor), and
 * each person's weekly hours from those rows (fenceWorkload). REST and MCP
 * workload read the organization this way until t3/limits-workload-pages,
 * which reads each person's own open tasks instead, so no production code
 * reads all of an organization's live tasks any more and this copy stays
 * here, unbounded, for the tests alone.
 *
 * Named *.setup.ts: two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { isOrgStaff } from '../lib/access'
import { byId } from '../lib/db'
import { layerOf, liveIn, type ProjectLive } from '../lib/liveTasks'
import { loadRowFor, type OrgLoadRow } from '../lib/loadRows'
import { roundTenths } from '../lib/numbers'
import { type OrgProjectView, orgProjectView } from '../lib/visibility'
import { canonicalLoad, committedByWeek, type LoadSpan, weekGrid } from '../lib/workload'

/**
 * Which tasks are groups by the subtasks among `rows` (lib/liveTasks.ts
 * countsAsSubtask). An active task needs its active subtasks in `rows` and
 * an archived one all of them, so a caller passing the organization's
 * active tasks may ask only about active tasks.
 */
export function groupTest(
  rows: Iterable<Pick<Doc<'issues'>, 'parent_id' | 'archived_at' | 'project_id'>>,
  live: ProjectLive,
): (task: Pick<Doc<'issues'>, 'id' | 'archived_at' | 'project_id'>) => boolean {
  // parents with any child, with an active child, and with a live child
  const any = new Set<string>()
  const active = new Set<string>()
  const liveKid = new Set<string>()
  for (const row of rows) {
    if (row.parent_id === undefined) continue
    any.add(row.parent_id)
    if (row.archived_at !== undefined) continue
    active.add(row.parent_id)
    if (live(row.project_id)) liveKid.add(row.parent_id)
  }
  return (task) => {
    const parent = layerOf(task, live)
    if (parent.archived) return any.has(task.id)
    return parent.projectLive ? liveKid.has(task.id) : active.has(task.id)
  }
}

/**
 * The active tasks of the active projects among `projects`, which belong to
 * one organization, oldest first by creation, one by_project_archived range
 * per project. Top-level projects are read too, so a row older code stored
 * under one is not lost. A project missing from `projects` is never read,
 * so tasks whose project no longer exists drop out.
 */
export async function liveTasksOf(
  ctx: QueryCtx,
  projects: readonly Doc<'projects'>[],
): Promise<Doc<'issues'>[]> {
  const live = projects.filter((p) => p.archived_at === undefined)
  const reads = await Promise.all(
    live.map((p) =>
      ctx.db
        .query('issues')
        .withIndex('by_project_archived', (q) =>
          q.eq('project_id', p.id).eq('archived_at', undefined),
        )
        .collect(),
    ),
  )
  return reads.flat().sort((a, b) => a._creationTime - b._creationTime)
}

/* plan_org_load for one org, each task through the one fence
 * (lib/loadRows.ts loadRowFor). orgProfileIds = ALL profile ids of the org
 * (active + inactive + agents), the 0065 owner fence. A task's group state
 * comes from `issues`, which must hold every subtask that makes a task in
 * an active project a group, as liveTasksOf's answer does. */
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

/** One person's weekly hours as the fence gives them. */
export type FenceHours = { hours: number[]; hidden_hours: number[] }

/**
 * Each person's planned hours for `weeks` weeks from the week holding
 * `fromDay`, as `me` may see them, by person id, as REST and MCP workload
 * answered them before they paged (workloadCore at ef92c289): the rows are
 * orgLoadRows over the organization's live tasks, `project`, a project `me`
 * can see, keeps the rows of it and its visible sub-projects, and each row
 * spreads over its weeks by the app's rule, only the asked weeks added up,
 * rounded to tenths. `listed` holds the people that answer listed: every
 * active one and every inactive one with hours in the window.
 */
export async function fenceWorkload(
  ctx: QueryCtx,
  me: Doc<'profiles'>,
  o: { fromDay: string; weeks: number; project: Doc<'projects'> | null },
): Promise<{ people: Map<string, FenceHours>; listed: Set<string> }> {
  const org = await byId(ctx, 'organizations', me.org_id)
  const grid = weekGrid(org?.week_start ?? 1)
  const first = grid.ofDay(o.fromDay)
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
  const asked = { from: first, to: first + o.weeks - 1 }
  const perWeek = (items: LoadSpan[]): number[] => {
    const byWeek = committedByWeek(canonicalLoad(items), null, asked)
    return window.map((week) => roundTenths(byWeek.get(week) ?? 0))
  }
  const people = new Map<string, FenceHours>()
  const listed = new Set<string>()
  for (const p of profiles) {
    const own = spans.get(p.id)
    const hours = perWeek(own?.all ?? [])
    people.set(p.id, { hours, hidden_hours: perWeek(own?.hidden ?? []) })
    if (p.active || hours.some((h) => h !== 0)) listed.add(p.id)
  }
  return { people, listed }
}
