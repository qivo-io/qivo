/* Comments (phase 5): the discussion thread's write surface. Ported from
 * 0054's table + comments_guard and 0081's final policies (291-305):
 * insert = author-is-self + has_project_level(project, 'member'→'user');
 * update/delete = the author or lead level on the issue's project.
 *
 * The guard's structural rules need no runtime checks here: author is
 * pinned to ctx.me at insert, created_at/edited_* are server-stamped, and
 * issue_id/author/created_at simply have no update slot (T16). Comments
 * write NO activity rows — edit attribution is the edited_at/edited_by pair
 * the client renders, nothing else. The comment row and every message its
 * fan-out posts share ONE `now` (0111; spine.ts's `>=` depends on it).
 *
 * No archived guard on purpose: the archive reason-comment posts onto a
 * just-archived issue, so comments stay writable there (issues.ts does). */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { canSeeProject } from './lib/access'
import { byId } from './lib/db'
import { badRequest, notFound, orgMutation } from './lib/functions'
import { deleteComment, editComment, postComment, vCommentExpected } from './model/comments'
import { assertCanEdit } from './model/issues'

type MeCtx = MutationCtx & { me: Doc<'profiles'> }

/* Unknown, foreign-org and invisible all read the same fence — the SELECT
 * policy was visibility, so an invisible thread does not exist for the
 * caller (0056's no-existence-oracle discipline). */
async function visibleIssue(ctx: MeCtx, issueId: string, sentence: string): Promise<Doc<'issues'>> {
  const issue = await byId(ctx, 'issues', issueId)
  if (issue === null || issue.org_id !== ctx.me.org_id) throw notFound(sentence)
  const project = await byId(ctx, 'projects', issue.project_id)
  if (project === null || !(await canSeeProject(ctx, ctx.me, project))) throw notFound(sentence)
  return issue
}

async function myComment(
  ctx: MeCtx,
  id: string,
): Promise<{ comment: Doc<'comments'>; issue: Doc<'issues'> }> {
  const comment = await byId(ctx, 'comments', id)
  if (comment === null) throw notFound('comment not found')
  const issue = await visibleIssue(ctx, comment.issue_id, 'comment not found')
  return { comment, issue }
}

const trimmedBody = (body: string): string => {
  const text = body.trim()
  if (text === '') throw badRequest('a comment cannot be empty')
  return text
}

/* ----------------------------------------------------------------- create
 * P.addComment. Author is structurally ctx.me ('comments can only be
 * created as yourself' becomes shape); created_at is server-stamped — a
 * client cannot backdate. Returns nothing: the client pre-generated the id
 * and the thread arrives via the commentThread subscription. The write
 * itself is model/comments.ts postComment, shared with REST and MCP. */
export const create = orgMutation({
  args: { id: v.string(), issue_id: v.string(), body: v.string() },
  handler: async (ctx, { id, issue_id, body }) => {
    const now = new Date().toISOString()
    const issue = await visibleIssue(ctx, issue_id, 'task not found')
    await assertCanEdit(ctx, ctx.me, issue.project_id)
    const text = trimmedBody(body)
    await postComment(ctx, { id, issue, author: ctx.me, body: text, now })
    return null
  },
})

/* ----------------------------------------------------------------- update
 * P.updateComment — in-place, no history. A same-body write is a silent
 * no-op WITHOUT stamps (comments_guard only stamped when the body actually
 * changed). Mention fan-out covers only mentions ADDED by the edit. The
 * rule and the write are model/comments.ts editComment, shared with REST
 * and MCP. */
export const update = orgMutation({
  args: { id: v.string(), body: v.string(), expected: v.optional(vCommentExpected) },
  handler: async (ctx, { id, body, expected }) => {
    const now = new Date().toISOString()
    const { comment, issue } = await myComment(ctx, id)
    await editComment(ctx, { me: ctx.me, comment, issue, body, now, expected })
    return null
  },
})

/* ----------------------------------------------------------------- remove
 * P.deleteComment. It notifies and narrates nothing; the thread just loses
 * the row (model/comments.ts deleteComment, shared with REST and MCP). */
export const remove = orgMutation({
  args: { id: v.string(), expected: v.optional(vCommentExpected) },
  handler: async (ctx, { id, expected }) => {
    const { comment, issue } = await myComment(ctx, id)
    await deleteComment(ctx, { me: ctx.me, comment, issue, expected })
    return null
  },
})
