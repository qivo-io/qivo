/* How tasks are named to people, with the task ID prefix and the status and
 * priority display names. src/ imports this module through lib/search.ts, so
 * it must stay free of server runtime. Its only other import is a type. */

import type { IssuePriority, IssueStatus } from './enums'

/** The task display prefix is fixed across organizations. */
export const ISSUE_PREFIX = 'QN'

export const issueKey = (num: number): string => `${ISSUE_PREFIX}-${num}`

/** Status display names, shared by activity, inbox narration and search. */
export const STATUS_NAMES: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  progress: 'In Progress',
  review: 'In Review',
  done: 'Done',
}

/** Priority display names, shared by activity, inbox narration and search. */
export const PRIORITY_NAMES: Record<IssuePriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}
