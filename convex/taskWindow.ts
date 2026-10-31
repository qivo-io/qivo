/* The task window's own live queries. Each reads one opened task and its
 * own relations, under ordinary access, so a task opens without the
 * workspace's task windows: in a project of any size, from a direct link
 * and in a fresh app session. Readers and budgets are in lib/taskWindow.ts.
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
 *
 * None reads the tasks of a project or of the organization, and none reads
 * the links, subtasks or files of the tasks it names. Beside the caller's
 * own grants, memberships and team shares, the access reads take the
 * projects asked about with their grants and shares, and where a top-level
 * project shows the caller only for navigation, the caller's reach rows
 * under it and the sub-projects they name, once the organization's are
 * complete, or else that project's sub-projects and, for a caller in many
 * teams, the organization's teams (lib/access.ts projectLevelsOf). An edit
 * of those reruns a query, as it reruns the workspace parts, and no other
 * edit elsewhere in the organization does.
 *
 * A task outside the caller's working set answers `{state: 'unavailable'}`,
 * the same for every reason, a check of its access or its parent's that a
 * bound of the caller's own reads stopped included (lib/access.ts
 * accessUnchecked), and `task` answers `{state: 'archived'}` for an
 * archived task the Archived tasks page lists for the caller, with its row,
 * its text, its labels and the caller's level, which the window shows
 * read-only. The app subscribes `task` while a window shows the task's
 * details, and while a window shows a task the workspace does not hold. A
 * list a
 * budget stops answers `complete: false`, never an error. orgQuery still
 * refuses a caller without a seat in the organization, or one whose
 * organization is being deleted, before the handler runs, so the app must
 * treat that refusal as it treats one of snapshot.threadComments. */

import { v } from 'convex/values'
import { orgQuery } from './lib/functions'
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
