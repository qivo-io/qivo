/* The fence of the organization-wide load (planning.ts orgLoadRows) for one
 * task. The server applies it to an organization's live tasks, and the app
 * applies it to the tasks it shows (src/store/taskIndex.ts), so a pending
 * edit moves its owner's load and delays at once and the server sends only
 * the rows of tasks the reader is not shown. src/ imports this module, so
 * it must stay free of server runtime: its only import is a type. */

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
  if (!(facts.staff || facts.visible || owner === facts.meId)) return null
  return {
    issue_id: facts.visible ? task.id : null,
    owner_id: owner,
    start_week: task.start_week,
    end_week: task.end_week,
    remaining,
    remaining_set_at: task.remaining_set_at ?? null,
  }
}
