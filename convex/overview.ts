/* The Overview's live queries, which answer one scope's summary, its
 * projected delays and its two task lists on the server. The app's Overview
 * page reads them through the store (src/store/overviewLists.ts), its lists
 * a batch at a time with fixed ends. Readers and budgets are in
 * lib/overview.ts, on the shared view reader lib/viewReads.ts and the
 * counts every task writer keeps (model/overviewCounts.ts). A scope is a
 * top-level project with its visible live sub-projects, one sub-project,
 * or My view across every seat of the login.
 *
 * - summary: the leaves by status and the paused leaves, from the counts,
 *   whether the scope holds a task, and Overdue, the tasks not done for the
 *   reader and due before the client's day. It reads the caller's seats,
 *   for a project the project by id, its sub-projects (projects by_parent)
 *   and the caller's access to each, the family's readiness (org_ready,
 *   overview_count_runs, overview_regroups) and each sub-project's count
 *   rows (overview_counts by_project_owner_shard); for My view each
 *   person's count rows (by_owner_project) and their projects. Overdue reads
 *   the tasks due before the day (issues by_project_archived_paused_due, or
 *   by_assignee_archived_paused_due and by_reviewer_archived_status), Done
 *   ones that wait for the nightly archive included, each one's first
 *   subtask and a group's subtasks.
 * - risk: the tasks due on or after the day, in projects that track delay,
 *   projected late, reading those tasks the same way and their owners' open
 *   tasks (lib/ownerLoads.ts), at most one owner's for a guest or an
 *   organization Viewer.
 * - attention and paused: one batch of the Overdue & at risk list and of the
 *   Paused list, at most lib/overview.ts OVERVIEW.batch rows, in due-date
 *   order, through the same indexes, and the parents of the rows by id.
 *
 * Each answers `unavailable` for a scope the caller does not hold, alike
 * for every reason, or with `reason: 'access_unchecked'` and its sentence
 * where a bound of the caller's own access reads stopped a check
 * (lib/access.ts accessUnchecked), and `over_budget` where the scope's own
 * selection, or a list batch's reads before it judged one candidate, did
 * not fit. Then each figure is a figure or unavailable on its
 * own (`counting`, `budget` or `loads`), never a smaller number, and a list
 * batch says whether it is complete. The day and the weeks are the
 * client's (lib/overview.ts clockOf), passed as arguments, because a query
 * that read the time could answer from Convex's cache on a later day and
 * has no time zones. Live queries: a change to a document one of those reads
 * returned or would now return reruns them, such as a count row, a task due
 * in the range, a subtask or parent they read, a project or access row they
 * asked about, and for risk an owner's open task elsewhere, their profile's
 * plannable hours or a project's delay tracking; the summary's counts rerun
 * only when a count row of the scope moves. authedQuery, not orgQuery, as My
 * view spans seats and a project scope whose seat goes away answers
 * `unavailable` instead of throwing in a subscription; list positions are
 * bound to the login, so no seat change refuses them. */

import { v } from 'convex/values'
import { authedQuery } from './lib/functions'
import { readAttention, readPaused, readRisk, readSummary } from './lib/overview'

const vScope = v.union(
  v.object({ kind: v.literal('project'), org_id: v.string(), project_id: v.string() }),
  v.object({ kind: v.literal('mine') }),
)

/* The client's day and weeks (lib/overview.ts clockOf). */
const vWeeks = {
  day: v.string(),
  week: v.string(),
  week_starts: v.array(v.number()),
  week_end: v.number(),
}

export const summary = authedQuery({
  args: { scope: vScope, day: v.string() },
  handler: (ctx, args) => readSummary(ctx, ctx.myProfiles, args),
})

export const risk = authedQuery({
  args: { scope: vScope, ...vWeeks },
  handler: (ctx, args) => readRisk(ctx, ctx.myProfiles, args),
})

export const attention = authedQuery({
  args: { scope: vScope, ...vWeeks, cursor: v.optional(v.string()), end: v.optional(v.string()) },
  handler: (ctx, args) => readAttention(ctx, ctx.myProfiles, ctx.authUserId, args),
})

export const paused = authedQuery({
  args: { scope: vScope, cursor: v.optional(v.string()), end: v.optional(v.string()) },
  handler: (ctx, args) => readPaused(ctx, ctx.myProfiles, ctx.authUserId, args),
})
