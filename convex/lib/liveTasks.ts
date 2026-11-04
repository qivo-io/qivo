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
 * No reader needs the organization's live tasks any more: each reads one
 * owner's, one project's or one task's. The tests keep the walk over all
 * of them as their oracle (convex/tests/orgLoad.setup.ts liveTasksOf). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId } from './db'

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
