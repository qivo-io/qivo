/* What a read may say about the tasks around the ones it returns. In the
 * app, a reader is shown its working set (the active tasks of the projects
 * it can see that are not archived). Over REST and MCP, it is shown the
 * tasks whose project it can read, except in the inbox, which shows the
 * working set on every surface. A parent, a link, an inbox row or a group
 * total that a read sends goes through these rules, so no read names or
 * counts a task its reader is not shown. A parent and its subtasks share a
 * sub-project, and a read names one from the other only where they do
 * (lib/liveTasks.ts liveLink), so a reader shown either end is shown the
 * other, and no read says that a task it does not show exists. The app's
 * workspace parts (lib/workspaceParts.ts), its task window
 * (lib/taskWindow.ts), its Board (lib/board.ts) and its Overview
 * (lib/overview.ts), both through lib/viewReads.ts, apply them, and machine
 * outputs reuse them. */

import type { Doc } from '../_generated/dataModel'
import { countsAsSubtask, type LinkEnd, liveLink } from './liveTasks'

/** Whether the reader is shown the task with this id. */
export type Shown = (taskId: string) => boolean

/** The tasks one member of one organization works with in the app. */
export type WorkingSet = {
  /** the active tasks of visible, active projects, in the order given */
  tasks: Doc<'issues'>[]
  shown: Shown
}

/**
 * Whether a task belongs to a member's working set: the task and its own
 * project are not archived, and the member can see the project (`visible`).
 * The app's snapshot applies it through workingSetOf. The machine Inbox
 * applies the same rule through the Inbox's walk (model/inboxReads.ts
 * inboxScope).
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
 * member's view of the organization's projects by id, with whether they can
 * see each, such as the access suites' (tests/orgProjectView.setup.ts).
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
  return { tasks, shown: (taskId) => ids.has(taskId) }
}

/**
 * A task's parent as a read states it. `parent` is the task the read shows
 * as the parent, or none. Its id goes out only inside the task's own
 * sub-project (lib/liveTasks.ts liveLink).
 */
export function parentLink(
  task: Pick<Doc<'issues'>, 'parent_id' | 'org_id' | 'project_id'>,
  parent: LinkEnd | null | undefined,
): { parent_id?: string } {
  return parent != null && liveLink(parent, task) ? { parent_id: parent.id } : {}
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
 * that make the task above them a group (lib/liveTasks.ts countsAsSubtask),
 * and never one the reader is not shown, so nothing under it counts either.
 */
export function groupRemainingHours(
  group: Pick<Doc<'issues'>, 'id' | 'org_id' | 'archived_at' | 'project_id'>,
  childrenOf: (taskId: string) => readonly Doc<'issues'>[],
  shown: Shown,
): number | null {
  let sum = 0
  let counted = false
  const seen = new Set<string>([group.id])
  // the subtasks of `task` that make it a group
  const counting = (task: Pick<Doc<'issues'>, 'id' | 'org_id' | 'archived_at' | 'project_id'>) =>
    childrenOf(task.id).filter((kid) => countsAsSubtask(task, kid))
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
