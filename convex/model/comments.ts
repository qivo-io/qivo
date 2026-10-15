/* The comment write the app, REST and MCP share, which inserts the row and
 * runs its fan-out (model/messages.ts notifyCommentInsert). The author
 * follows the task, mentions are notified and followers read 'New comment'.
 * A comment writes no activity row, because the comment is its own entry in
 * the discussion.
 * Each caller resolves the task, refuses with its own sentences in its own
 * order and trims the body first; this function only repeats the write gate
 * as defense in depth. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { insertUnique } from '../lib/db'
import { badRequest } from '../lib/functions'
import { assertCanEdit } from './issues'
import { notifyCommentInsert } from './messages'
import { newUuid } from './orgs'

/**
 * Posts `body` on `issue` as `author`, stamped `now`, which the comment and
 * every message its fan-out posts share. `id` is the app's client-made id;
 * machine callers omit it and get a new one. Refuses an author without Edit
 * on the task's project, a blank body and an id already in use.
 */
export async function postComment(
  ctx: MutationCtx,
  a: { id?: string; issue: Doc<'issues'>; author: Doc<'profiles'>; body: string; now: string },
): Promise<Doc<'comments'>> {
  const { issue, author, now } = a
  await assertCanEdit(ctx, author, issue.project_id)
  if (a.body.trim() === '') throw badRequest('a comment cannot be empty')
  const id = a.id ?? newUuid()
  const docId = await insertUnique(
    ctx,
    'comments',
    'by_uuid',
    { id },
    { id, issue_id: issue.id, author: author.id, body: a.body, created_at: now },
    badRequest('a comment with this id already exists'),
  )
  const comment = (await ctx.db.get(docId)) as Doc<'comments'>
  await notifyCommentInsert(ctx, { comment, issue, actor: author, now })
  return comment
}
