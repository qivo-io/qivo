/* The task window's own queries. The first three are live, and each reads
 * one opened task and its own relations, under ordinary access, so a task
 * opens without the workspace's task windows, in a project of any size,
 * from a direct link and in a fresh app session. Readers and budgets are in
 * lib/taskWindow.ts, and the relation pickers' in lib/relationPicker.ts.
 *
 * - task: the task a uuid or number names in the organization, its labels,
 *   the caller's follow, its parent and its subtasks as short rows. It reads
 *   the task by_uuid or by_org_num, the caller's levels on the projects of
 *   the tasks it sends, its label and follow rows, its parent by id, its
 *   description row, and its active subtasks in one by_parent_archived
 *   range with one more range each for whether that subtask is a group. Of
 *   an archived task it reads the row, whether it is a group, its
 *   description row, its label rows and the caller's level on its project.
 * - links: the task's links whose other end the caller is shown, and those
 *   ends as short rows. Its two link ranges, each other end by id, and one
 *   range each for whether that end is a group.
 * - attachments: the task's attachment rows, as metadata. One by_issue
 *   range.
 * - relationCandidates: the tasks the window's Parent, Subtasks and Linked
 *   tasks pickers offer, a batch of 25 at a time (lib/relationPicker.ts).
 *   Unlike the three above, the app reads it once for each rested search
 *   and each Load more and never subscribes to it, because a batch reads
 *   the active tasks of the task's family, and after Search all your
 *   projects of the organization's other projects, up to its own budget.
 *
 * None of the first three reads the tasks of a project or of the
 * organization, and none reads the links, subtasks or files of the tasks
 * it names. Beside the caller's own grants, memberships and team shares,
 * the access reads take the projects asked about with their grants and
 * shares, and where a top-level project shows the caller only for
 * navigation, the caller's reach rows under it and the sub-projects they
 * name, once the organization's are complete, or else that project's
 * sub-projects and, for a caller in many teams, the organization's teams
 * (lib/access.ts projectLevelsOf). An edit of those reruns a query, as it
 * reruns the workspace parts, and no other edit elsewhere in the
 * organization does.
 *
 * A task outside the caller's working set answers `{state: 'unavailable'}`,
 * the same for every reason, a check of its access or its parent's that a
 * bound of the caller's own reads stopped included (lib/access.ts
 * accessUnchecked), and `task` answers `{state: 'archived'}` for an
 * archived task whose project the caller sees, also in an archived project,
 * with its row, its text, its labels and the caller's level, which the
 * window shows read-only. relationCandidates answers the same
 * `unavailable` for such a task. The app subscribes `task` while a window
 * shows the task's details, while a window shows a task the workspace does
 * not hold, and to read a task a window opens by its address, by its number
 * in the organization the address names, or by its uuid, first in that
 * organization and then in the caller's other organizations, one read at a
 * time, until one finds it (src/lib/taskReference.ts,
 * src/store/planner.ts refSeats).
 * A list a budget stops answers `complete: false`, and a picker batch a
 * budget stops answers `stopped: true` with a cursor, never an error.
 * orgQuery still refuses a caller without a seat in the organization, or
 * one whose organization is being deleted, before the handler runs. The
 * app reads `task`'s refusal with exactly those two texts as unavailable,
 * as a task it cannot open, and every other error as a failure. */

import { v } from 'convex/values'
import { orgQuery } from './lib/functions'
import { readRelationCandidates } from './lib/relationPicker'
import { readWindowAttachments, readWindowLinks, readWindowTask } from './lib/taskWindow'

/* The opened task, by `ref`: its uuid in any case, its number, or QN-12
 * (lib/taskWindow.ts readWindowTask). */
export const task = orgQuery({
  args: { ref: v.string() },
  handler: async (ctx, { ref }) => await readWindowTask(ctx, ctx.me, ref),
})

/* The opened task's links (lib/taskWindow.ts readWindowLinks). */
export const links = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => await readWindowLinks(ctx, ctx.me, issue_id),
})

/* The opened task's attachment list (lib/taskWindow.ts
 * readWindowAttachments). */
export const attachments = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => await readWindowAttachments(ctx, ctx.me, issue_id),
})

/* The tasks a relation picker of the opened task offers, one batch from
 * `cursor` on, matching `search` (lib/relationPicker.ts
 * readRelationCandidates). The app reads it once a batch, never as a
 * subscription. */
export const relationCandidates = orgQuery({
  args: {
    issue_id: v.string(),
    kind: v.union(v.literal('parent'), v.literal('subtask'), v.literal('link')),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => await readRelationCandidates(ctx, ctx.me, args),
})
