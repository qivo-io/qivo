/* The task views' live queries, which answer one Board or Roadmap selection
 * with its filters applied on the server. The desktop Board, the phone list
 * and My view's Board read board (src/views/board/useBoardView.ts); no app
 * reader calls roadmap or roadmapDependencies yet, which the Roadmap view
 * stage switches to. Readers and budgets are in lib/board.ts and
 * lib/roadmap.ts, on the shared view reader lib/viewReads.ts and the filter
 * row's read lib/viewFilters.ts.
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
 * - roadmap: the tasks one Roadmap selection shows, the same selections,
 *   with the Roadmap's filter row (My tasks, people, Priority, the text
 *   filter) and its displayed window applied by the Roadmap's visibility
 *   rule (lib/roadmapVisibility.ts), groups included and counted toward
 *   its ceiling, with the shown parents, the shown subtasks of its groups
 *   that are not rows, My view's sub-projects and the headings' Remaining.
 *   It reads what board reads with every status, each passing group's
 *   subtree for its facts, and the counts (overview_counts
 *   by_project_owner_shard of each selected sub-project, or in My view the
 *   person's rows, by_owner_project, with the organization's readiness and
 *   regroups).
 * - roadmapDependencies: a selection's dependency inputs, the blocks links
 *   between its own tasks for the arrows and the parts of the dependency
 *   graph Auto-move works on, inside the selection and outside it. It reads
 *   the selection's active tasks, or My view's own, their group checks and
 *   facts, the links of each task with a span (issue_links by_source and
 *   by_target), and the tasks a link, a parent or a subtask leads to, by id,
 *   with theirs in turn, and the caller's level on their projects. It does
 *   not take the filters or the window.
 *
 * board answers `ok`, `over_ceiling` once more than lib/board.ts
 * BOARD.ceiling (lib/limits.ts BOARD_TASKS) matching tasks were found,
 * `over_budget` when its reads reach lib/board.ts BOARD before that is
 * known, and `unavailable` for a selection the caller does not hold, alike
 * for every reason, or with `reason: 'access_unchecked'` where a bound of
 * the caller's own access reads stopped a check (lib/access.ts
 * accessUnchecked). roadmap answers the same states by lib/roadmap.ts
 * ROADMAP and ROADMAP_TASKS, roadmapDependencies `ok` with Auto-move's
 * inputs or their own over_budget, `over_budget` and `unavailable`. Live
 * queries: a change to a document one of those reads returned or would now
 * return reruns them, such as a task of a selected sub-project or of the
 * person, a subtask or parent they read, a project or access row they asked
 * about, for a search a profile, text, label or label row, for roadmap a
 * count row of its sub-projects (any leaf write there), and for
 * roadmapDependencies a link row or a task of its parts; edits to other
 * projects' tasks do not. A new filter, window or scope is a new
 * subscription; roadmapDependencies takes neither filters nor window, so
 * panning and typing never rerun it. authedQuery, not orgQuery, as My view
 * spans seats and a project selection whose seat goes away answers
 * `unavailable` instead of throwing in a subscription. */

import { v } from 'convex/values'
import { readBoard } from './lib/board'
import { vIssuePriority } from './lib/enums'
import { authedQuery } from './lib/functions'
import { readDependencies, readRoadmap } from './lib/roadmap'

/** A task view's selection, a project of one organization, a top-level
 * project or a sub-project, or My view. */
const vViewScope = v.union(
  v.object({ kind: v.literal('project'), org_id: v.string(), project_id: v.string() }),
  v.object({ kind: v.literal('mine') }),
)

export const board = authedQuery({
  args: {
    scope: vViewScope,
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

export const roadmap = authedQuery({
  args: {
    scope: vViewScope,
    filters: v.object({
      mine: v.boolean(),
      owners: v.array(v.string()),
      priority: v.union(vIssuePriority, v.null()),
      search: v.string(),
    }),
    window: v.object({ from: v.string(), to: v.string() }),
  },
  handler: (ctx, args) => readRoadmap(ctx, ctx.myProfiles, args),
})

export const roadmapDependencies = authedQuery({
  args: { scope: vViewScope },
  handler: (ctx, args) => readDependencies(ctx, ctx.myProfiles, args),
})
