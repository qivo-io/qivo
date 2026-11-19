/* The live layer of an organization's tasks, the guard on parent links,
 * and the one rule for which subtasks make a task a group.
 *
 * A subtask is always in its parent's own sub-project: every write that
 * makes a parent link enforces it (model/issues.ts sameSubProject). A task
 * is a group through the subtasks that count for it: an archived task
 * counts every subtask and an active one its active subtasks
 * (countsAsSubtask), so archiving a task never turns it into a leaf. Both
 * ends share a project, so whether that project is archived changes no
 * task's group. A task is live while it is not archived and its project
 * exists and is not archived, which is what every reader shows
 * (lib/workingSet.ts inWorkingSet), and a reader shown a task is shown its
 * sub-project, so the app, REST and MCP agree on its group state and show
 * its parent and subtasks without asking anyone's sight of them.
 *
 * No reader needs the organization's live tasks any more. Each reads one
 * owner's, one project's or one task's, and project completion reads the
 * stored counts. The tests keep the walk over all of them, and the group
 * rule over the rows it reads, as their oracle
 * (convex/tests/orgLoad.setup.ts liveTasksOf and groupTest). */

import type { Doc } from '../_generated/dataModel'

/** The fields of a parent task that liveLink compares. */
export type LinkEnd = Pick<Doc<'issues'>, 'id' | 'org_id' | 'project_id'>

/** The fields of a subtask that liveLink compares. */
export type LinkStart = Pick<Doc<'issues'>, 'parent_id' | 'org_id' | 'project_id'>

/**
 * Whether `child` names `parent` as its parent and both are tasks of one
 * organization in one sub-project, as every write keeps them. A read names
 * a parent or a subtask, and lists, counts or sums subtasks, only where
 * this holds, so no stored row could show a caller a task outside the
 * sub-project it reads.
 */
export const liveLink = (parent: LinkEnd, child: LinkStart): boolean =>
  child.parent_id === parent.id &&
  child.org_id === parent.org_id &&
  child.project_id === parent.project_id

/**
 * Whether `child` makes `parent` a group: it is `parent`'s subtask
 * (liveLink), and the parent is archived, which keeps its whole tree, or
 * the child is active. An archived child never counts for an active
 * parent.
 */
export const countsAsSubtask = (
  parent: LinkEnd & Pick<Doc<'issues'>, 'archived_at'>,
  child: LinkStart & Pick<Doc<'issues'>, 'archived_at'>,
): boolean =>
  liveLink(parent, child) && (parent.archived_at !== undefined || child.archived_at === undefined)

/** Whether the project with this id exists and is not archived. */
export type ProjectLive = (projectId: string) => boolean

/** ProjectLive over projects a caller already holds by id. A project missing
 * from `byUuid` is not live, as a project row that no longer exists is not. */
export const liveIn =
  (byUuid: ReadonlyMap<string, Pick<Doc<'projects'>, 'archived_at'>>): ProjectLive =>
  (projectId) => {
    const project = byUuid.get(projectId)
    return project !== undefined && project.archived_at === undefined
  }
