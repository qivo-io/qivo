/* The comment writes the app, REST and MCP share. postComment inserts the
 * row and runs its fan-out (model/messages.ts notifyCommentInsert), so the
 * author follows the task, mentions are notified and followers read 'New
 * comment'. It also holds the task to LIMITS.comments and the author to
 * LIMITS.commentRate (model/commentLimits.ts), and deleteComment gives the
 * task its slot back. Every reader pages a thread, so no read loads a whole
 * one. editComment and deleteComment hold the app's rule that only a comment's
 * author or a lead of the task's project may change it. A comment writes no
 * activity row, because the comment is its own entry in the discussion.
 * Each caller resolves the task, which the caller must be able to see, and
 * refuses with its own sentences in its own order first; postComment only
 * repeats the write gate as defense in depth. */

import { getDocumentSize, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { hasProjectLevel } from '../lib/access'
import { assertNewRowId, byId, insertUnique } from '../lib/db'
import { trimmedForm } from '../lib/fieldPrints'
import { badRequest, forbidden, rule } from '../lib/functions'
import { limitedMarkdown, limitedText } from '../lib/limitRules'
import { LIMITS } from '../lib/limits'
import { tooManyMentions } from '../lib/mentions'
import { issueKey } from '../lib/taskRefs'
import { commentRoom, takeRoom, tallyComments } from './commentLimits'
import { assertExpected, DELETES, type Fields, filledText, type Next, type View } from './expected'
import { assertCanEdit } from './issues'
import { notifyCommentInsert, notifyCommentUpdate } from './messages'
import { newUuid } from './orgs'

type NewComment = {
  id?: string
  issue: Doc<'issues'>
  author: Doc<'profiles'>
  body: string
  now: string
  /** The comment is the reason for archiving `issue`, so a limit's
   * refusal says the archive did not happen (postArchiveReason). */
  archive?: boolean
}

/**
 * Posts `body` on `issue` as `author`, stamped `now`, which the comment and
 * every message its fan-out posts share. `id` is the app's client-made id;
 * machine callers omit it and get a new one. Refuses an id that is not a
 * lowercase UUID (lib/db.ts assertNewRowId), an author without Edit on the
 * task's project, a blank body, a body past LIMITS.comment or mentioning
 * more people than LIMITS.mentions allows (lib/mentions.ts), then a task
 * that holds LIMITS.comments.max comments or an author past
 * LIMITS.commentRate there (model/commentLimits.ts commentRoom, which can
 * also refuse for now while the task's comments are counted), and an id
 * already in use. It stores `body` trimmed, so the cap measures the
 * stored text. `now` is also the post's time for the rate.
 */
export async function postComment(ctx: MutationCtx, a: NewComment): Promise<Doc<'comments'>> {
  const { issue, author, now } = a
  if (a.id !== undefined) assertNewRowId(a.id)
  await assertCanEdit(ctx, author, issue.project_id)
  const body = limitedMarkdown(LIMITS.comment, a.body)
  if (body === '') throw rule('a comment cannot be empty')
  if (tooManyMentions(body)) throw rule(LIMITS.mentions.refusal)
  const nowMs = Date.parse(now)
  const room = await commentRoom(ctx, { issue, author, nowMs, archive: a.archive })
  const id = a.id ?? newUuid()
  const docId = await insertUnique(
    ctx,
    'comments',
    'by_uuid',
    { id },
    { id, issue_id: issue.id, author: author.id, body, created_at: now },
    badRequest('a comment with this id already exists'),
  )
  const comment = (await ctx.db.get(docId)) as Doc<'comments'>
  await takeRoom(ctx, room, { issue, author, nowMs })
  await notifyCommentInsert(ctx, { comment, issue, actor: author, now })
  return comment
}

type ArchiveReason = {
  issue: Doc<'issues'>
  author: Doc<'profiles'>
  reason: string | undefined
  now: string
}

/**
 * Posts the reason given for archiving `issue` as a normal comment by
 * `author`, trimmed and sharing the archive's `now`. The app's archive and
 * the machine archive call it only when their write archived the task; a
 * blank or missing reason posts nothing, and one past LIMITS.archiveReason
 * after trimming is refused. REST and MCP also check the reason with
 * limitedText while they parse a request, before any write, so a task
 * already archived, which posts no reason, refuses it too. The reason
 * takes a comment slot and a post of the author's rate like any comment,
 * and their refusals say the task was not archived: the caller archives in
 * the same transaction, so a refusal undoes the archive.
 */
export async function postArchiveReason(
  ctx: MutationCtx,
  a: ArchiveReason,
): Promise<Doc<'comments'> | null> {
  const body = limitedText(LIMITS.archiveReason, a.reason ?? '')
  if (body === '') return null
  return await postComment(ctx, {
    issue: a.issue,
    author: a.author,
    body,
    now: a.now,
    archive: true,
  })
}

/** Refuses an archive of `issue` whose reason the comment cap or the
 * author's posting rate would refuse, with postArchiveReason's sentences,
 * so the archive's callers refuse before their writes and fan-out. A blank
 * or missing reason passes, because it posts nothing. */
export async function assertArchiveReasonRoom(ctx: MutationCtx, a: ArchiveReason): Promise<void> {
  if (limitedText(LIMITS.archiveReason, a.reason ?? '') === '') return
  await commentRoom(ctx, {
    issue: a.issue,
    author: a.author,
    nowMs: Date.parse(a.now),
    archive: true,
  })
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

/** The key of a comment's `expected`. The app sends the body's print
 * (lib/fieldPrints.ts). */
export const COMMENT_FIELDS: Fields<Doc<'comments'>> = {
  // editComment's rule
  body: { sends: 'body', type: filledText(LIMITS.comment), form: trimmedForm, printed: true },
}

/** The app's `expected` for a comment edit or delete. */
export const vCommentExpected = v.object({ body: v.string() })

/* Refuses a comment edit or delete over a body someone else changed since
 * `expected` was read (model/expected.ts). The comment's edit stamps name
 * who, because editComment is the only writer of a body. */
async function assertCommentExpected(
  ctx: QueryCtx,
  a: {
    me: Doc<'profiles'>
    comment: Doc<'comments'>
    issue: Doc<'issues'>
    view: View
    expected: Readonly<Record<string, unknown>> | undefined
    next: Next
  },
): Promise<void> {
  const { comment } = a
  await assertExpected({
    read: { ctx, me: a.me, view: a.view },
    fields: COMMENT_FIELDS,
    record: 'comment',
    id: comment.id,
    label: `comment ${comment.id} on ${issueKey(a.issue.num)}`,
    row: comment,
    expected: a.expected,
    next: a.next,
    writers: async () =>
      comment.edited_by !== undefined && comment.edited_at !== undefined
        ? new Map([['body', { by: comment.edited_by, at: comment.edited_at }]])
        : new Map(),
  })
}

/**
 * Replaces the body of `comment` with `body`, trimmed, as `me`, in place and
 * without history. Refuses anyone but the author or a project lead, then a
 * blank body, one past LIMITS.comment or one mentioning more people than
 * LIMITS.mentions allows. The same text again changes nothing and stamps
 * nothing. Otherwise the comment records who edited
 * it and when, stamped `now`, and people the edit newly mentions follow the
 * task and hear about it. Returns the comment as stored and whether it
 * changed.
 */
export async function editComment(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    comment: Doc<'comments'>
    issue: Doc<'issues'>
    body: string
    now: string
    /** The body the caller read, in its view (assertCommentExpected). */
    expected?: Readonly<Record<string, unknown>>
    view?: View
  },
): Promise<{ comment: Doc<'comments'>; changed: boolean }> {
  const { me, comment, issue, now } = a
  await assertCommentEditor(ctx, { me, comment, issue, verb: 'edit' })
  await assertCommentExpected(ctx, {
    me,
    comment,
    issue,
    view: a.view ?? 'app',
    expected: a.expected,
    next: { body: a.body },
  })
  const text = limitedMarkdown(LIMITS.comment, a.body)
  if (text === '') throw rule('a comment cannot be empty')
  if (tooManyMentions(text)) throw rule(LIMITS.mentions.refusal)
  if (text === comment.body) return { comment, changed: false }
  await ctx.db.patch(comment._id, { body: text, edited_at: now, edited_by: me.id })
  const after = (await ctx.db.get(comment._id)) as Doc<'comments'>
  await notifyCommentUpdate(ctx, { before: comment, after, issue, actor: me, now })
  return { comment: after, changed: true }
}

/**
 * Deletes `comment` as `me`, its author or a project lead. The thread just
 * loses the row, and the task one comment of its count, so it has room for
 * one more under LIMITS.comments; the author's posting rate stays as it
 * was. Nothing is narrated and nobody is notified. Deleted items cannot
 * bring a comment back, so a delete may carry `expected`, the body the
 * caller read, and is refused when someone changed it since.
 */
export async function deleteComment(
  ctx: MutationCtx,
  a: {
    me: Doc<'profiles'>
    comment: Doc<'comments'>
    issue: Doc<'issues'>
    expected?: Readonly<Record<string, unknown>>
    view?: View
  },
): Promise<void> {
  await assertCommentEditor(ctx, { ...a, verb: 'delete' })
  await assertCommentExpected(ctx, {
    me: a.me,
    comment: a.comment,
    issue: a.issue,
    view: a.view ?? 'app',
    expected: a.expected,
    next: DELETES,
  })
  await ctx.db.delete(a.comment._id)
  await tallyComments(ctx, [[a.comment, -1]])
}

/* -------------------------------------------------------------- reading */

/** The most comments one page holds. The app's task window loads the
 * newest page of a thread and then earlier pages on request (threadPage),
 * and a REST or MCP read answers one unless it asks for fewer (lib/core.ts
 * listCommentsCore). */
export const COMMENT_PAGE_MAX = LIMITS.listComments.max

/** The most one page of comments reads, in bytes as Convex counts a
 * document's size. Half of Convex's 16 MiB read limit per transaction leaves
 * room for the task, the roster and the access checks. */
export const COMMENT_PAGE_BYTES = 8 * 1024 * 1024

/** Convex's limit on one document's size. A comment can come close to it, so
 * a read with a byte budget takes no more comments at a time than its unspent
 * budget could hold at this size (newestComments, teamSync.ts lastComments). */
export const DOCUMENT_MAX_BYTES = 1024 * 1024

/**
 * The newest comment on the task `issueId`, or null when it has none. One
 * index range and at most one comment. Comments are server-stamped and
 * inserted in the order they were posted (see newestComments), so the
 * by_issue index's last row is the latest. Editing a comment does not move
 * it.
 */
export async function latestComment(
  ctx: QueryCtx,
  issueId: string,
): Promise<Doc<'comments'> | null> {
  return await ctx.db
    .query('comments')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .order('desc')
    .first()
}

/**
 * The newest comments on the task `issueId`, newest first. A page holds at
 * most `limit`, and with `before`, a comment on that task, only those the
 * thread holds before it. A page stops once it has read about
 * COMMENT_PAGE_BYTES, so long comments make it shorter than `limit`. It
 * still holds at least one comment when an earlier one exists, so an empty
 * page means there are none.
 *
 * The thread's order is the by_issue index, _creationTime and then the
 * document id. Convex does not make _creationTime unique, and no index range
 * can name a document id. So each index read after the first starts at the
 * time of the last comment it passed, that time included, and skips the
 * comments at that time it already passed. The byte count includes that
 * reread, which is one comment unless comments share that time. A page so
 * reads at most COMMENT_PAGE_BYTES and one comment more.
 *
 * With `before`, the page first reads every comment that shares its time,
 * once, to find where `before` stands among them, and reads that group whole
 * on top of the bound. Convex gives each insert in a transaction a later
 * _creationTime than the one before, so only posts from separate
 * transactions that start at the same instant, or an import that sets the
 * times, make such a group. A group larger than Convex's 16 MiB read limit,
 * such as 17 comments near the 1 MiB document limit at one time, so fails
 * every page before one of its comments. The newest page still works on
 * such a thread.
 *
 * The index orders a thread by insertion, so a task's comments must be
 * inserted in the order they were posted (latestComment relies on this
 * too).
 */
export async function newestComments(
  ctx: QueryCtx,
  issueId: string,
  a: { limit: number; before?: Doc<'comments'> },
): Promise<Doc<'comments'>[]> {
  const out: Doc<'comments'>[] = []
  let bytes = 0
  // The next read resumes at `at`, the _creationTime of the last comment
  // passed. `passed` comments at that time are behind it already, and
  // `passedBytes` is their size, which that read spends again. With
  // `below`, every comment at that time is behind it, so the read starts
  // under that time and rereads none.
  let at = a.before?._creationTime
  let passed = 0
  let passedBytes = 0
  let below = false
  if (a.before !== undefined) {
    const anchor = a.before
    const tied = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) =>
        q.eq('issue_id', issueId).eq('_creationTime', anchor._creationTime),
      )
      .order('desc')
      .collect()
    for (const comment of tied) bytes += getDocumentSize(comment)
    // Newest first, so the comments after `before` are the earlier ones.
    const earlier = tied.slice(tied.findIndex((comment) => comment._id === anchor._id) + 1)
    out.push(...earlier.slice(0, a.limit))
    below = true
  }
  while (out.length < a.limit && (bytes + passedBytes < COMMENT_PAGE_BYTES || out.length === 0)) {
    const fits = Math.floor((COMMENT_PAGE_BYTES - bytes - passedBytes) / DOCUMENT_MAX_BYTES)
    const n = Math.min(a.limit - out.length, Math.max(1, fits))
    const skip = passed
    const from = at
    const under = below
    const rows = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) =>
        from === undefined
          ? q.eq('issue_id', issueId)
          : under
            ? q.eq('issue_id', issueId).lt('_creationTime', from)
            : q.eq('issue_id', issueId).lte('_creationTime', from),
      )
      .order('desc')
      .take(skip + n)
    bytes += passedBytes
    below = false
    for (const comment of rows.slice(skip)) {
      const size = getDocumentSize(comment)
      bytes += size
      if (comment._creationTime === at) {
        passed += 1
        passedBytes += size
      } else {
        at = comment._creationTime
        passed = 1
        passedBytes = size
      }
      out.push(comment)
    }
    if (rows.length < skip + n) break
  }
  return out
}

/** The refusal for a `before` that names no comment on the task read. */
export const BEFORE_NOT_A_COMMENT = 'before must be the id of a comment on this task'

/**
 * The comment `ref` names on the task `issueId`, as the `before` of a page
 * of earlier comments. Accepts the id in any case. Refuses anything else,
 * unknown ids and comments on other tasks included, so a `before` reveals
 * nothing about other threads.
 */
export async function commentAnchor(
  ctx: QueryCtx,
  issueId: string,
  ref: string,
): Promise<Doc<'comments'>> {
  const anchor = await byId(ctx, 'comments', ref.toLowerCase())
  if (anchor === null || anchor.issue_id !== issueId) throw badRequest(BEFORE_NOT_A_COMMENT)
  return anchor
}

/**
 * One page of the task `issueId`'s thread for the app's task window. It
 * holds the newest COMMENT_PAGE_MAX comments, or with `before` the newest
 * ones the thread holds before it (newestComments, so long comments make the
 * page shorter), oldest first in thread order. `earlier` says whether the
 * thread holds a comment before the page's first one. It reads one comment
 * on top of the page, the thread's first, so a long thread costs nothing
 * more to ask. An empty page has no earlier comments.
 */
export async function threadPage(
  ctx: QueryCtx,
  issueId: string,
  before?: Doc<'comments'>,
): Promise<{ comments: Doc<'comments'>[]; earlier: boolean }> {
  const page = await newestComments(ctx, issueId, { limit: COMMENT_PAGE_MAX, before })
  const oldest = page.at(-1)
  if (oldest === undefined) return { comments: [], earlier: false }
  // The by_issue index orders a thread, so its first row starts it.
  const first = await ctx.db
    .query('comments')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .order('asc')
    .first()
  return { comments: page.reverse(), earlier: first !== null && first._id !== oldest._id }
}
