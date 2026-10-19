/* The live layer of an organization's tasks, and the one rule for which
 * subtasks make a task a group.
 *
 * A task is live while it is not archived and its project exists and is not
 * archived. That is what every reader already shows (lib/workingSet.ts
 * inWorkingSet), so a task in an active project is a group only through
 * live subtasks (countsAsSubtask). Its group state therefore depends only
 * on tasks every reader reads, and the app, REST and MCP agree on it.
 *
 * A task in an archived project counts every active subtask, and an
 * archived task every subtask, so archiving a project or a task never turns
 * a group in it into a leaf. Archiving a project can turn a task in it into
 * a group, through active subtasks in a project archived before it. A
 * restore can then leave that task a group with the own hours it took as a
 * leaf, which the restore's steps clear (regroup.ts).
 *
 * The readers that need the organization's live tasks read them per active
 * project (liveTasksOf), so tasks in archived projects are never read, until
 * an organization has more active projects than one read can take ranges
 * for. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from './db'
import { ISSUE_STATUSES } from './enums'
import { taskOwnerId } from './review'

/** Whether the project with this id exists and is not archived. */
export type ProjectLive = (projectId: string) => boolean

/** ProjectLive that may read the project first. */
export type Liveness = (projectId: string) => boolean | Promise<boolean>

/** A task as the group rule sees it, which is whether it is archived and
 * whether its project exists and is not archived. */
export type TaskLayer = { archived: boolean; projectLive: boolean }

/**
 * Whether `child` makes `parent` a group. An archived parent keeps its whole
 * tree, an archived child never counts for an active parent, and a parent in
 * an active project counts only children in active projects. A parent in an
 * archived or missing project counts every active child.
 */
export function countsAsSubtask(parent: TaskLayer, child: TaskLayer): boolean {
  if (parent.archived) return true
  if (child.archived) return false
  return !parent.projectLive || child.projectLive
}

/** The TaskLayer of a task row, with its project's state from `live`. */
export const layerOf = (
  task: Pick<Doc<'issues'>, 'archived_at' | 'project_id'>,
  live: ProjectLive,
): TaskLayer => ({ archived: task.archived_at !== undefined, projectLive: live(task.project_id) })

/** ProjectLive over projects a caller already holds by id. A project missing
 * from `byUuid` is not live, as a project row that no longer exists is not. */
export const liveIn =
  (byUuid: ReadonlyMap<string, Pick<Doc<'projects'>, 'archived_at'>>): ProjectLive =>
  (projectId) => {
    const project = byUuid.get(projectId)
    return project !== undefined && project.archived_at === undefined
  }

/** Liveness read from the database, each project once per call. */
export function projectLiveness(ctx: QueryCtx): (projectId: string) => Promise<boolean> {
  const known = new Map<string, Promise<boolean>>()
  return (projectId) => {
    let live = known.get(projectId)
    if (live === undefined) {
      live = byId(ctx, 'projects', projectId).then((p) => p !== null && p.archived_at === undefined)
      known.set(projectId, live)
    }
    return live
  }
}

/**
 * Which tasks are groups by the subtasks among `rows` (countsAsSubtask). An
 * active task needs its active subtasks in `rows` and an archived one all of
 * them, so a caller passing the organization's active tasks may ask only
 * about active tasks.
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

/** How many active projects liveTasksOf reads one index range each before
 * it reads the organization's active tasks in one range instead, so an
 * organization with thousands of projects stays far below Convex's 4,096
 * ranges. Tests lower `reads`. */
export const LIVE_PROJECT_READS = { reads: 1000 }

/**
 * The active tasks of the active projects among `projects`, which belong to
 * one organization, oldest first by creation, the order the organization's
 * by_org_archived range gives. One by_project_archived range per project
 * read, or past LIVE_PROJECT_READS such projects one by_org_archived range,
 * which also holds the active tasks of archived projects, left out here.
 * Tasks live in sub-projects, and top-level projects are read too, so a row
 * older code stored under one is not lost. A project missing from
 * `projects` is never read, so tasks whose project no longer exists drop
 * out.
 */
export async function liveTasksOf(
  ctx: QueryCtx,
  projects: readonly Doc<'projects'>[],
): Promise<Doc<'issues'>[]> {
  const live = projects.filter((p) => p.archived_at === undefined)
  const first = live[0]
  if (first === undefined) return []
  if (live.length > LIVE_PROJECT_READS.reads) {
    const ids = new Set(live.map((p) => p.id))
    const active = await ctx.db
      .query('issues')
      .withIndex('by_org_archived', (q) =>
        q.eq('org_id', first.org_id).eq('archived_at', undefined),
      )
      .collect()
    return active.filter((task) => ids.has(task.project_id))
  }
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

/* The statuses of tasks that can carry load, every one but Done, as
 * planning.ts orgLoadRows skips Done tasks. */
const OPEN_STATUSES = ISSUE_STATUSES.filter((status) => status !== 'done')

/**
 * The live tasks `ownerId` owns by the Reviewer rule (lib/review.ts
 * taskOwnerId) that are not Done, oldest first by creation. One index range
 * per open status of the tasks the person is assigned, and one of the In
 * Review tasks they review, so Done tasks, which stay active until the
 * nightly archive and forever in an archived project, are never read. The
 * rule is read as for a task without subtasks, which is right for callers
 * that leave groups out.
 */
export async function ownedOpenTasks(
  ctx: QueryCtx,
  ownerId: string,
  live: ProjectLive,
): Promise<Doc<'issues'>[]> {
  const ranges = await Promise.all([
    ...OPEN_STATUSES.map((status) =>
      ctx.db
        .query('issues')
        .withIndex('by_assignee_archived_status', (q) =>
          q.eq('assignee_id', ownerId).eq('archived_at', undefined).eq('status', status),
        )
        .collect(),
    ),
    // a reviewer owns a task only while it is in review (lib/review.ts)
    ctx.db
      .query('issues')
      .withIndex('by_reviewer_archived_status', (q) =>
        q.eq('reviewer_id', ownerId).eq('archived_at', undefined).eq('status', 'review'),
      )
      .collect(),
  ])
  const owned = new Map<string, Doc<'issues'>>()
  for (const task of ranges.flat()) {
    if (taskOwnerId(task) === ownerId && live(task.project_id)) owned.set(task.id, task)
  }
  return [...owned.values()].sort((a, b) => a._creationTime - b._creationTime)
}
