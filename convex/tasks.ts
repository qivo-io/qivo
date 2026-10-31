/* The Board's live query, which answers one Board selection with its
 * filters applied on the server. Nothing in the app calls it yet:
 * t3/limits-board-view switches the desktop Board, the phone list and My
 * view's Board to it. Readers and budgets are in lib/board.ts, on the shared
 * view reader lib/viewReads.ts.
 *
 * - board: the matching tasks of a selection, a top-level project with its
 *   visible live sub-projects, one sub-project, or My view across every
 *   seat of the login, with the shown parents above them, the lanes that
 *   stay without cards and the selection's sub-projects. A row is the task
 *   as the tasks part sends it without its text and relation rows, with
 *   its group facts. It reads the caller's seats, for a project the project
 *   by id, its sub-projects (projects by_parent) and the caller's access to
 *   each, and their active tasks (issues by_project_archived, or under
 *   Focus one by_project_archived_status_done span of its statuses); for My
 *   view and My tasks the person's own tasks instead
 *   (by_assignee_archived_status, by_reviewer_archived_status). Then the
 *   active subtasks (by_parent_archived) of each task it checks for being a
 *   group: each task the other filters keep, matched or not, each one a
 *   search reads a status name for, and each shown subtask of a group it
 *   shows, created before the rule of one level (lib/viewReads.ts
 *   ONE_LEVEL_SINCE); the parents it shows by id and their projects; and for
 *   a search the assignees by id, the texts (issue_descriptions by_issue or
 *   by_project_archived), the organization's labels (labels by_org), and
 *   the label rows of tasks a label could still make match (issue_labels
 *   by_issue_label or by_issue, or past lib/board.ts BOARD.labelTasks such
 *   tasks, where it is the cheaper read, each such label's active
 *   assignments, by_label). Only that last read takes rows of tasks outside
 *   the selection; no read takes the organization's tasks.
 *
 * It answers `ok`, `over_ceiling` once more than lib/limits.ts BOARD_TASKS
 * matching tasks were found, `over_budget` when its reads reach
 * lib/board.ts BOARD before that is known, and `unavailable` for a
 * selection the caller does not hold, alike for every reason, or with
 * `reason: 'access_unchecked'` where a bound of the caller's own access
 * reads stopped a check (lib/access.ts accessUnchecked). A live query: a
 * change to a document one of those reads returned or would now return
 * reruns it, such as a task of a selected sub-project or of the person, a
 * subtask or parent it read, a project or access row it asked about, and
 * for a search a profile, text, label or label row it read; edits to other
 * projects' tasks do not. authedQuery, not orgQuery, as My view spans seats
 * and a project selection whose seat goes away answers `unavailable`
 * instead of throwing in a subscription. */

import { v } from 'convex/values'
import { readBoard } from './lib/board'
import { vIssuePriority } from './lib/enums'
import { authedQuery } from './lib/functions'

export const board = authedQuery({
  args: {
    scope: v.union(
      v.object({ kind: v.literal('project'), org_id: v.string(), project_id: v.string() }),
      v.object({ kind: v.literal('mine') }),
    ),
    filters: v.object({
      mine: v.boolean(),
      owners: v.array(v.string()),
      priority: v.union(vIssuePriority, v.null()),
      stale_before: v.union(v.string(), v.null()),
      focus: v.boolean(),
      search: v.string(),
    }),
  },
  handler: (ctx, args) => readBoard(ctx, ctx.myProfiles, args),
})
