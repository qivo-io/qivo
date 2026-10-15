/* The comment writes the app, REST and MCP share. postComment inserts the
 * row and runs its fan-out (model/messages.ts notifyCommentInsert), so the
 * author follows the task, mentions are notified and followers read 'New
 * comment'. editComment and deleteComment hold the app's rule that only a
 * comment's author or a lead of the task's project may change it. A comment
 * writes no activity row, because the comment is its own entry in the
 * discussion.
 * Each caller resolves the task, which the caller must be able to see, and
 * refuses with its own sentences in its own order first; postComment only
 * repeats the write gate as defense in depth. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { hasProjectLevel } from '../lib/access'
import { insertUnique } from '../lib/db'
import { badRequest, forbidden } from '../lib/functions'
import { assertCanEdit } from './issues'
import { notifyCommentInsert, notifyCommentUpdate } from './messages'
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

/**
 * Posts the reason given for archiving `issue` as a normal comment by
 * `author`, trimmed and sharing the archive's `now`. The app's archive and
 * the machine archive call it only when their write archived the task; a
 * blank or missing reason posts nothing.
 */
export async function postArchiveReason(
  ctx: MutationCtx,
  a: { issue: Doc<'issues'>; author: Doc<'profiles'>; reason: string | undefined; now: string },
): Promise<Doc<'comments'> | null> {
  const body = (a.reason ?? '').trim()
  if (body === '') return null
  return await postComment(ctx, { issue: a.issue, author: a.author, body, now: a.now })
}

/**
 * Refuses `me` unless it wrote `comment` or leads the project of `issue`,
 * the task the comment is on. A lead's standing comes from hasProjectLevel,
 * so an organization admin passes too.
 */
export async function assertCommentEditor(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    comment: Doc<'comments'>
    issue: Doc<'issues'>
    verb: 'edit' | 'delete'
  },
): Promise<void> {
  if (a.comment.author === a.me.id) return
  if (await hasProjectLevel(ctx, a.me, a.issue.project_id, 'lead')) return
  throw forbidden(`only the author or a project lead can ${a.verb} this comment`)
}

/**
 * Replaces the body of `comment` with `body`, trimmed, as `me`, in place and
 * without history. Refuses anyone but the author or a project lead, then a
 * blank body. The same text again changes nothing and stamps nothing.
 * Otherwise the comment records who edited it and when, stamped `now`, and
 * people the edit newly mentions follow the task and hear about it. Returns
 * the comment as stored and whether it changed.
 */
export async function editComment(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    comment: Doc<'comments'>
    issue: Doc<'issues'>
    body: string
    now: string
  },
): Promise<{ comment: Doc<'comments'>; changed: boolean }> {
  const { me, comment, issue, now } = a
  await assertCommentEditor(ctx, { me, comment, issue, verb: 'edit' })
  const text = a.body.trim()
  if (text === '') throw badRequest('a comment cannot be empty')
  if (text === comment.body) return { comment, changed: false }
  await ctx.db.patch(comment._id, { body: text, edited_at: now, edited_by: me.id })
  const after = (await ctx.db.get(comment._id)) as Doc<'comments'>
  await notifyCommentUpdate(ctx, { before: comment, after, issue, actor: me, now })
  return { comment: after, changed: true }
}

/**
 * Deletes `comment` as `me`, its author or a project lead. The thread just
 * loses the row. Nothing is narrated and nobody is notified.
 */
export async function deleteComment(
  ctx: MutationCtx,
  a: { me: Doc<'profiles'>; comment: Doc<'comments'>; issue: Doc<'issues'> },
): Promise<void> {
  await assertCommentEditor(ctx, { ...a, verb: 'delete' })
  await ctx.db.delete(a.comment._id)
}
