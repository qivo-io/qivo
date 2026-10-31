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
 *   Focus by_project_archived_status_done by status); for My view and My
 *   tasks the person's own tasks instead (by_assignee_archived_status,
 *   by_reviewer_archived_status). Then each matching task's active
 *   subtasks (by_parent_archived), the parents it shows by id, and for a
 *   search the assignees by id, the texts (issue_descriptions by_issue or
 *   by_project_archived) and the label rows of tasks still unmatched
 *   (issue_labels by_issue_label or by_issue). It never reads the
 *   organization's tasks, so its reads follow the selection, not the
 *   organization.
 *
 * It answers `ok`, `over_ceiling` once more than lib/limits.ts BOARD_TASKS
 * matching tasks were found, `over_budget` when its reads reach
 * lib/board.ts BOARD before that is known, and `unavailable` for a
 * selection the caller does not hold, alike for every reason, or with
 * `reason: 'access_unchecked'` where a bound of the caller's own access
 * reads stopped a check (lib/access.ts accessUnchecked). A live query: a
 * change to any task, project or access row it read reruns it, so a change
 * to a task of the selection, or to the subtasks and parents it shows, does,
 * and edits elsewhere in the organization do not. authedQuery, not
 * orgQuery, as My view spans seats and a project selection whose seat goes
 * away answers `unavailable` instead of throwing in a subscription. */

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
