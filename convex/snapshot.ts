/* The task window's comment thread and the history beside it: the live
 * comment page the app subscribes to while a task is open (threadComments),
 * the live history page it subscribes to only while the window shows All
 * (threadHistory), and the earlier pages of each it reads once on demand.
 * The rest of the workspace comes in live parts (workspace.ts). Rows omit
 * Convex system fields. */
import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { canSeeProject } from './lib/access'
import { historyAnchor, taskHistoryPage, WINDOW_HISTORY_PAGE } from './lib/activityVisibility'
import { byId } from './lib/db'
import { notFound, orgQuery } from './lib/functions'
import { inWorkingSet } from './lib/workingSet'
import { rowOf } from './lib/workspaceParts'
import { commentAnchor, threadPage } from './model/comments'

/* The task `issueId` when the caller can see it. Unknown, foreign and
 * invisible task IDs all refuse with the same not-found sentence. Comments
 * remain available on visible archived tasks. */
async function threadTask(
  ctx: QueryCtx & { me: Doc<'profiles'> },
  issueId: string,
): Promise<{ issue: Doc<'issues'>; project: Doc<'projects'> }> {
  const issue = await byId(ctx, 'issues', issueId)
  if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound('task not found')
  const project = await byId(ctx, 'projects', issue.project_id)
  if (project === null || !(await canSeeProject(ctx, ctx.me, project))) {
    throw notFound('task not found')
  }
  return { issue, project }
}

/* A page of history rows as the thread sends them. Field prints only let a
 * refused edit name who wrote a value (model/expected.ts), so the thread
 * leaves them out. */
const historyOut = (rows: Doc<'activity_events'>[]) =>
  rows.map(({ field_prints: _prints, ...event }) => rowOf(event))

/* The task window's live comment page. It holds the thread's newest
 * COMMENT_PAGE_MAX comments, and fewer when they are long, oldest first in
 * thread order, and says whether the thread holds earlier ones
 * (model/comments.ts threadPage). The window reads further back with
 * commentsBefore, and reads no history here: under All it subscribes to
 * threadHistory besides. */
export const threadComments = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const { issue } = await threadTask(ctx, issue_id)
    const page = await threadPage(ctx, issue.id)
    return { comments: page.comments.map(rowOf), earlier: page.earlier }
  },
})

/* The task window's live history page, which it subscribes to only while
 * it shows All. It holds the newest WINDOW_HISTORY_PAGE rows of the task's
 * history the caller receives (lib/activityVisibility.ts taskHistoryPage),
 * oldest first, whether the history holds rows before them, and `next`, the
 * row the window reads those before with historyBefore. It can hold no row
 * while `earlier` is set. The page is empty for an archived task or a task
 * in an archived project, which the app does not show. */
export const threadHistory = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const { issue, project } = await threadTask(ctx, issue_id)
    // the app shows history only for a task in the working set (lib/workingSet.ts);
    // threadTask already refused a project the caller cannot see
    if (!inWorkingSet(issue, project, true)) return { events: [], earlier: false, next: null }
    const history = await taskHistoryPage(ctx, ctx.me, issue, undefined, WINDOW_HISTORY_PAGE)
    return {
      events: historyOut(history.rows),
      earlier: history.earlier,
      next: history.next?.id ?? null,
    }
  },
})

/* Deprecated: the task window subscribes to threadComments, and to
 * threadHistory under All. Kept for one release, with the same answer, for
 * browser tabs and desktop clients from before the split; remove it with
 * its manifest line once no served build calls it. It answers the comment
 * page of threadComments and, in `events`, `events_earlier` and
 * `events_next`, the newest HISTORY_PAGE_MAX rows of the task's history the
 * caller receives, read in every run whether the window shows them or not.
 * The history is empty for an archived task or a task in an archived
 * project. */
export const commentThread = orgQuery({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }) => {
    const { issue, project } = await threadTask(ctx, issue_id)
    // comments first: the page counts only its own bytes (model/comments.ts
    // newestComments), so the history page's room checks must see what it spent
    const page = await threadPage(ctx, issue.id)
    // the app shows history only for a task in the working set (lib/workingSet.ts);
    // threadTask already refused a project the caller cannot see
    const history = inWorkingSet(issue, project, true)
      ? await taskHistoryPage(ctx, ctx.me, issue)
      : { rows: [], earlier: false, next: undefined }
    return {
      comments: page.comments.map(rowOf),
      earlier: page.earlier,
      events: historyOut(history.rows),
      events_earlier: history.earlier,
      events_next: history.next?.id ?? null,
    }
  },
})

/* The page of history "Show earlier activity" loads beside the comments. It
 * holds the newest WINDOW_HISTORY_PAGE rows the caller receives before the
 * row `before` (lib/activityVisibility.ts taskHistoryPage), oldest first,
 * whether the history holds rows before them, and `next`, the row to read
 * those before, in threadHistory's shape. It can hold no row while
 * `earlier` is set. The app reads it once rather than subscribing. A
 * `before` that is not a row of this task's history refuses with
 * BEFORE_NOT_A_CHANGE as a bad_request, and a task the window shows no
 * history for answers an empty page. */
export const historyBefore = orgQuery({
  args: { issue_id: v.string(), before: v.string() },
  handler: async (ctx, { issue_id, before }) => {
    const { issue, project } = await threadTask(ctx, issue_id)
    const anchor = await historyAnchor(ctx, issue, before)
    if (!inWorkingSet(issue, project, true)) return { events: [], earlier: false, next: null }
    const history = await taskHistoryPage(ctx, ctx.me, issue, anchor, WINDOW_HISTORY_PAGE)
    return {
      events: historyOut(history.rows),
      earlier: history.earlier,
      next: history.next?.id ?? null,
    }
  },
})

/* The page "Show earlier comments" loads. It holds the newest
 * COMMENT_PAGE_MAX comments the thread holds before the comment `before`, in
 * threadComments' shape. The app reads it once rather than subscribing. A
 * `before` that is not a comment on this task, deleted ones included,
 * refuses with BEFORE_NOT_A_COMMENT as a bad_request. */
export const commentsBefore = orgQuery({
  args: { issue_id: v.string(), before: v.string() },
  handler: async (ctx, { issue_id, before }) => {
    const { issue } = await threadTask(ctx, issue_id)
    const anchor = await commentAnchor(ctx, issue.id, before)
    const page = await threadPage(ctx, issue.id, anchor)
    return { comments: page.comments.map(rowOf), earlier: page.earlier }
  },
})
