/* The one definition of the Reviewer rule, shared by the server (planning,
 * notifications, the review-time and hand-off stamps) and the browser (every
 * ownership surface, the optimistic stamps). A task In Review with a reviewer belongs to that reviewer; in
 * every other state it belongs to its assignee. src/ imports this module,
 * so it must stay free of server runtime: its only import is a type. */

import type { Doc } from '../_generated/dataModel'

/* Remaining time a task gets on entering Review when neither its
 * sub-project nor its project sets one. */
export const DEFAULT_REVIEW_HOURS = 2
/* The largest project review time, in hours. */
export const REVIEW_HOURS_MAX = 999

/* True while the reviewer owns the task. A group's stored status is dormant
 * (its subtasks carry the work), so a group always stays with its assignee. */
export function reviewerOwns(
  task: Pick<Doc<'issues'>, 'status' | 'reviewer_id'>,
  isGroup = false,
): boolean {
  return !isGroup && task.status === 'review' && task.reviewer_id !== undefined
}

/* The profile a task's work counts against: the reviewer while they own it,
 * else the assignee (absent when unassigned). */
export function taskOwnerId(
  task: Pick<Doc<'issues'>, 'status' | 'assignee_id' | 'reviewer_id'>,
  isGroup = false,
): string | undefined {
  return reviewerOwns(task, isGroup) ? task.reviewer_id : task.assignee_id
}

/* issues.review_at after a write (`before` null on create): the instant the
 * task was last handed to review, i.e. it entered In Review, or went to a
 * different reviewer (from none included) while it stayed there. A move
 * In Review → Done keeps it, so a Done task carries it exactly when it was
 * reviewed to Done; any other move out of In Review, and any move out of Done
 * except back into Review, clears it. Server-owned like done_at (no public
 * argument carries it): createIssueCore and updateIssueCore write it, and the
 * browser paints the same rule. A group never enters Review (its status is
 * refused), and gaining subtasks drops a leaf's (clearParentRemaining). */
export function reviewStamp(
  before: Pick<Doc<'issues'>, 'status' | 'reviewer_id' | 'review_at'> | null,
  after: Pick<Doc<'issues'>, 'status' | 'reviewer_id'>,
  now: string,
): string | undefined {
  if (after.status === 'review') {
    if (before?.status !== 'review') return now
    const handedOn = after.reviewer_id !== undefined && after.reviewer_id !== before.reviewer_id
    return handedOn ? now : before.review_at
  }
  const reviewedToDone = before?.status === 'review' || before?.status === 'done'
  return after.status === 'done' && reviewedToDone ? before.review_at : undefined
}

/* A sub-project's effective review time: its own value, else its project's,
 * else the default. `??`, never `||`: 0 is a real setting. */
export function resolveReviewHours(own: number | undefined, parent: number | undefined): number {
  return own ?? parent ?? DEFAULT_REVIEW_HOURS
}

/* Rounds to the remaining_hours grain (0.1 h). */
export function roundReviewHours(n: number): number {
  return Math.round(n * 10) / 10
}
