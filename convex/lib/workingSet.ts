/* What a read may say about the tasks around the ones it returns. In the
 * app, a reader is shown its working set (the active tasks of the projects
 * it can see that are not archived). Over REST and MCP, it is shown the
 * tasks whose project it can read. A parent, a link, an inbox row or a group
 * total that a read sends goes through these rules, so no read names or
 * counts a task its reader is not shown. It may only say that such a task
 * exists (has_hidden_parent, has_hidden_subtasks). The app's snapshot
 * (convex/snapshot.ts) applies them, and machine outputs reuse them. */

import type { Doc } from '../_generated/dataModel'

/** Whether the reader is shown the task with this id. */
export type Shown = (taskId: string) => boolean

/** The tasks one member of one organization works with in the app. */
export type WorkingSet = {
  /** the active tasks of visible, active projects, in the order given */
  tasks: Doc<'issues'>[]
  shown: Shown
  /** whether the task has an active subtask the member is not shown */
  hasHiddenSubtasks: (taskId: string) => boolean
}

/**
 * The working set within an organization's active tasks, which holds those
 * in a project the member can see that is not archived. `projects` is the
 * member's view of the organization's projects (lib/visibility.ts).
 */
export function workingSetOf(
  activeTasks: readonly Doc<'issues'>[],
  projects: {
    byUuid: ReadonlyMap<string, Doc<'projects'>>
    visible: (projectId: string) => boolean
  },
): WorkingSet {
  const tasks = activeTasks.filter(
    (task) =>
      projects.visible(task.project_id) &&
      projects.byUuid.get(task.project_id)?.archived_at === undefined,
  )
  const ids = new Set(tasks.map((task) => task.id))
  const shown: Shown = (taskId) => ids.has(taskId)
  const hiddenSubtaskParents = new Set<string>()
  for (const task of activeTasks) {
    if (task.parent_id !== undefined && !shown(task.id)) hiddenSubtaskParents.add(task.parent_id)
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
 * group counts only through its subtasks. The walk never enters a subtask
 * the reader is not shown, so nothing under it counts either. Like
 * hasSubtasks, an active task is a group while it has an active subtask, and
 * an archived one while it has any.
 */
export function groupRemainingHours(
  group: Pick<Doc<'issues'>, 'id'>,
  childrenOf: (taskId: string) => readonly Doc<'issues'>[],
  shown: Shown,
): number | null {
  let sum = 0
  let counted = false
  const seen = new Set<string>([group.id])
  const stack = [...childrenOf(group.id)]
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    if (seen.has(task.id) || !shown(task.id)) continue
    seen.add(task.id)
    const kids = childrenOf(task.id)
    const archived = task.archived_at !== undefined
    if (kids.some((kid) => archived || kid.archived_at === undefined)) {
      stack.push(...kids)
      continue
    }
    if (task.status === 'done' || task.remaining_hours === undefined) continue
    sum += task.remaining_hours
    counted = true
  }
  return counted ? Math.round(sum * 10) / 10 : null
}
