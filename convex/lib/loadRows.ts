/* The fence of the organization-wide load (planning.ts orgLoadRows) for one
 * task. The server applies it to an organization's live tasks
 * (orgLoadRows) and to one owner's open tasks (lib/ownerLoads.ts), and the
 * app applies it to the tasks it shows (src/store/taskIndex.ts), so a
 * pending edit moves its owner's load and delays at once and the server
 * sends only the rows of tasks the reader is not shown. src/ imports this
 * module, so it must stay free of server runtime: beside a type it imports
 * only lib/review.ts, which holds none. */

import type { Doc } from '../_generated/dataModel'
import { taskOwnerId } from './review'

/* rows.orgLoad element, field names verbatim: `remaining`, NOT
 * remaining_hours. */
export type OrgLoadRow = {
  issue_id: string | null
  // the effective owner: the reviewer while In Review with one set, else the assignee (#314)
  owner_id: string
  start_week: string
  end_week: string
  remaining: number
  remaining_set_at: string | null
}

/** The task fields the fence reads. */
export type LoadTask = Pick<
  Doc<'issues'>,
  | 'id'
  | 'status'
  | 'assignee_id'
  | 'reviewer_id'
  | 'start_week'
  | 'end_week'
  | 'paused'
  | 'remaining_hours'
  | 'remaining_set_at'
  | 'archived_at'
>

/** What the fence needs to know beside the task's own fields. */
export type LoadFacts = {
  /** whether a subtask makes the task a group (lib/liveTasks.ts countsAsSubtask) */
  isGroup: boolean
  /** whether the task's project exists and is not archived */
  projectLive: boolean
  /** whether the profile with this id belongs to the task's organization */
  ownerInOrg: (profileId: string) => boolean
  /** whether the reader can see the task's project */
  visible: boolean
  /** whether the reader is staff (lib/access.ts isOrgStaff) */
  staff: boolean
  /** the reader's profile id in the task's organization */
  meId: string
}

/**
 * Whether a reader receives the load row of a task `owner` owns, which the
 * fence has kept otherwise. Staff (lib/access.ts isOrgStaff) receive every
 * row, those of projects they cannot see without the task's id or project.
 * Guests and organization Viewers receive the rows of projects they can
 * see, anyone's, and their own, so another person's hidden work does not
 * arrive at all.
 *
 * The owner chose this rule for guests and Viewers on 31 October 2026,
 * option A of three (qivo-internal docs/limits-plan.md, "Workload and
 * scheduling loading"). The bounded owner reader (lib/ownerLoads.ts) reads
 * a person's open tasks before it knows which of them the reader can see,
 * so past its budgets a guest's or Viewer's answer about another person can
 * be unavailable because of that person's tasks in projects the reader
 * cannot see. That one fact is all the answer tells of them: never their
 * ids, projects, titles, creation order or count. planning.ownerLoads
 * reads one owner a call for them, so where its `not_read` starts follows
 * the order they asked in alone, not another person's hidden reads. Every
 * hidden row that does go out goes in one total order with the others.
 * The options not taken were two more task indexes read per visible
 * project, and only the reader's own load for guests and Viewers.
 */
export function loadShown(f: {
  staff: boolean
  visible: boolean
  owner: string
  meId: string
}): boolean {
  return f.staff || f.visible || f.owner === f.meId
}

/**
 * The load row task `task` adds for a reader, or null. A row is an ordinary
 * task (not a group), owned (lib/review.ts taskOwnerId) by a profile of the
 * task's organization, scheduled, neither Done nor paused, with remaining
 * hours above zero, not archived and in a live project. A reader who is not
 * staff gets a row of a project they cannot see only when they own it. A
 * row of a project the reader cannot see carries no task id.
 */
export function loadRowFor(task: LoadTask, facts: LoadFacts): OrgLoadRow | null {
  if (facts.isGroup) return null
  // groups are left out above, so the rule's isGroup default holds
  const owner = taskOwnerId(task)
  if (owner === undefined) return null
  if (task.start_week === undefined || task.end_week === undefined) return null
  if (task.status === 'done' || task.paused) return null
  const remaining = task.remaining_hours ?? 0
  if (!(remaining > 0)) return null
  if (task.archived_at !== undefined || !facts.projectLive) return null
  if (!facts.ownerInOrg(owner)) return null
  if (!loadShown({ staff: facts.staff, visible: facts.visible, owner, meId: facts.meId }))
    return null
  return {
    issue_id: facts.visible ? task.id : null,
    owner_id: owner,
    start_week: task.start_week,
    end_week: task.end_week,
    remaining,
    remaining_set_at: task.remaining_set_at ?? null,
  }
}
