/* What a read may say about the tasks around the ones it returns. In the
 * app, a reader is shown its working set (the active tasks of the projects
 * it can see that are not archived). Over REST and MCP, it is shown the
 * tasks whose project it can read, except in the inbox, which shows the
 * working set on every surface. A parent, a link, an inbox row or a group
 * total that a read sends goes through these rules, so no read names or
 * counts a task its reader is not shown. It may only say that such a task
 * exists (has_hidden_parent, has_hidden_subtasks). The app's workspace
 * parts (lib/workspaceParts.ts) apply them, and machine outputs reuse them. */

import type { Doc } from '../_generated/dataModel'
import { countsAsSubtask, layerOf, liveIn, type ProjectLive } from './liveTasks'

/** Whether the reader is shown the task with this id. */
export type Shown = (taskId: string) => boolean

/** The tasks one member of one organization works with in the app. */
export type WorkingSet = {
  /** the active tasks of visible, active projects, in the order given */
  tasks: Doc<'issues'>[]
  shown: Shown
  /** whether the task has a subtask that makes it a group (an active
   * subtask in an active project, lib/liveTasks.ts countsAsSubtask) that the
   * member is not shown */
  hasHiddenSubtasks: (taskId: string) => boolean
}

/**
 * Whether a task belongs to a member's working set: the task and its own
 * project are not archived, and the member can see the project (`visible`).
 * The app's snapshot applies it through workingSetOf, and the machine inbox
 * applies it to the tasks its messages name.
 */
export function inWorkingSet(
  task: Pick<Doc<'issues'>, 'archived_at'>,
  project: Pick<Doc<'projects'>, 'archived_at'> | undefined,
  visible: boolean,
): boolean {
  return (
    visible &&
    project !== undefined &&
    task.archived_at === undefined &&
    project.archived_at === undefined
  )
}

/**
 * The working set within an organization's active tasks, which holds those
 * in a project the member can see that is not archived. `projects` is the
 * member's view of the organization's projects (lib/visibility.ts). Every
 * task of the working set is in an active project, so its subtasks that make
 * it a group are the active tasks in active projects (lib/liveTasks.ts
 * countsAsSubtask), which is what `activeTasks` must hold for
 * hasHiddenSubtasks to be right. Tasks in archived projects among them
 * change nothing.
 */
export function workingSetOf(
  activeTasks: readonly Doc<'issues'>[],
  projects: {
    byUuid: ReadonlyMap<string, Doc<'projects'>>
    visible: (projectId: string) => boolean
  },
): WorkingSet {
  const tasks = activeTasks.filter((task) =>
    inWorkingSet(task, projects.byUuid.get(task.project_id), projects.visible(task.project_id)),
  )
  const ids = new Set(tasks.map((task) => task.id))
  const shown: Shown = (taskId) => ids.has(taskId)
  const live = liveIn(projects.byUuid)
  // the parents asked about are in the working set, so active in an active project
  const parent = { archived: false, projectLive: true }
  const hiddenSubtaskParents = new Set<string>()
  for (const task of activeTasks) {
    if (task.parent_id === undefined || shown(task.id)) continue
    if (countsAsSubtask(parent, layerOf(task, live))) hiddenSubtaskParents.add(task.parent_id)
  }
  return { tasks, shown, hasHiddenSubtasks: (taskId) => hiddenSubtaskParents.has(taskId) }
}

/**
 * A task's parent as a read may state it. The parent's id goes out only when
 * the reader is shown the parent, else only the fact that a parent exists.
 */
export function parentLink(
  task: Pick<Doc<'issues'>, 'parent_id'>,
  shown: Shown,
): { parent_id?: string; has_hidden_parent: boolean } {
  if (task.parent_id === undefined) return { has_hidden_parent: false }
  return shown(task.parent_id)
    ? { parent_id: task.parent_id, has_hidden_parent: false }
    : { has_hidden_parent: true }
}

/** Whether a read may send a link, which needs the reader shown both ends. */
export function linkShown(
  link: Pick<Doc<'issue_links'>, 'source_id' | 'target_id'>,
  shown: Shown,
): boolean {
  return shown(link.source_id) && shown(link.target_id)
}

/**
 * The rows about single tasks (inbox messages, own follows) that a read may
 * send, which are those about a task the reader is shown. The others stay
 * stored and come back if the reader is shown that task again.
 */
export function aboutShownTasks<Row extends { issue_id: string }>(
  rows: readonly Row[],
  shown: Shown,
): Row[] {
  return rows.filter((row) => shown(row.issue_id))
}

/**
 * A group's remaining hours as the app shows them (src/store/planner.ts
 * remainingOf). It is the sum over the unfinished leaves of its subtree that
 * the reader is shown, to one decimal, or null when none has hours. A nested
 * group counts only through its subtasks. The walk enters only the subtasks
 * that make the task above them a group (lib/liveTasks.ts countsAsSubtask,
 * with `live` telling which projects are active), and never one the reader
 * is not shown, so nothing under it counts either.
 */
export function groupRemainingHours(
  group: Pick<Doc<'issues'>, 'id' | 'archived_at' | 'project_id'>,
  childrenOf: (taskId: string) => readonly Doc<'issues'>[],
  shown: Shown,
  live: ProjectLive,
): number | null {
  let sum = 0
  let counted = false
  const seen = new Set<string>([group.id])
  // the subtasks of `task` that make it a group
  const counting = (task: Pick<Doc<'issues'>, 'id' | 'archived_at' | 'project_id'>) => {
    const above = layerOf(task, live)
    return childrenOf(task.id).filter((kid) => countsAsSubtask(above, layerOf(kid, live)))
  }
  const stack = counting(group)
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    if (seen.has(task.id) || !shown(task.id)) continue
    seen.add(task.id)
    const kids = counting(task)
    if (kids.length > 0) {
      stack.push(...kids)
      continue
    }
    if (task.status === 'done' || task.remaining_hours === undefined) continue
    sum += task.remaining_hours
    counted = true
  }
  return counted ? Math.round(sum * 10) / 10 : null
}
