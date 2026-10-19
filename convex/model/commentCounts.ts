/* The comment count of each task, which holds a task to COMMENT_MAX
 * comments (comment_counts in schema.ts). postComment refuses a new comment
 * on a task that has that many (assertRoomForComment). A task that had more
 * before the cap keeps them. An archive reason is posted past the cap too,
 * so archiving never fails on it, and each archive with a reason can add one
 * comment past COMMENT_MAX.
 *
 * The count lives in its own table. The app snapshot reads every active
 * task, so a field on the task would rerun every member's snapshot on each
 * comment, and posting a comment writes no task row otherwise. Counting the
 * thread at each post would fail too, because 400 comments at TEXT_MAX can
 * pass Convex's 16 MiB read limit, and comments saved before that cap can be
 * near the 1 MiB document limit.
 *
 * A task without a row is not counted yet, which is every task older than
 * the count and each new one until its first post. The first post counts
 * the thread within COUNT_BUDGET.post. A thread too long for that is stored
 * with `cursor`, the index position the count reached, and background steps
 * (convex/commentCounts.ts step) count the rest, as does each later post.
 * Until then `count` is a lower bound, and a post is refused only when that
 * bound reaches the cap.
 *
 * A refused post writes nothing, the count included. So a task that held
 * COMMENT_MAX comments before the count existed, with all of them inside
 * COUNT_BUDGET.post, is counted again at each refused post. Each of those
 * reads stops after COMMENT_MAX comments or COUNT_BUDGET.post bytes and one
 * comment, a quarter of what one page of comments may read
 * (model/comments.ts COMMENT_PAGE_BYTES).
 *
 * Every write that inserts or deletes comment rows keeps the count.
 * - postComment (model/comments.ts), the one insert for the app, REST, MCP
 *   and archive reasons, calls noteCommentAdded.
 * - deleteComment (model/comments.ts), for the app, REST and MCP, calls
 *   noteCommentRemoved.
 * - Deleted items (model/deletedItems.ts), where the app's, REST's and
 *   MCP's task and project deletes move tasks with their comments, delete
 *   the row when the task row leaves the live tables (dropCommentCount). A
 *   restore writes the comments back and leaves the task not counted yet.
 * - deleteOrgDeep (model/cascade.ts), which tests and the guest
 *   organization reset run, deletes each task's row with its comments
 *   (dropCommentCount).
 * - The stepped organization deletion (model/orgDeletion.ts), whose phases
 *   the Northstar wipe also runs, and the public demo purge
 *   (internal/demoCleanup.ts) delete the row before the comments.
 * - The Northstar seed (model/demoSeed.ts) inserts every comment of tasks it
 *   creates and stores their counts (storeCommentCount).
 * Deleting a task's row is always safe, because its next post counts again.
 *
 * Counting pages through the by_issue index oldest first, and `cursor` is
 * Convex's pagination cursor, an exact index position. So comments that
 * share a _creationTime are counted once, and a count stops after at most
 * one comment past its byte budget. A comment inserted later sorts after the
 * cursor, because Convex stamps it in the inserting transaction and
 * noteCommentAdded reads the row. An insert that overlaps a count moving the
 * cursor conflicts with it and runs again after it. */

import { makeFunctionReference } from 'convex/server'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { rule } from '../lib/functions'

/** The most comments a task can hold. */
export const COMMENT_MAX = 400

/** The refusal for a comment on a task that holds COMMENT_MAX. A `rule`
 * refusal, so the app shows the sentence, as it does the text caps'. */
export const TOO_MANY_COMMENTS = `this task has ${COMMENT_MAX} comments, the most a task can have; start a new task to continue`

/** How much one count reads, in bytes as Convex counts a document's size.
 * A count stops once it has read `post` bytes (a post counting its task's
 * thread) or `step` bytes (a background step), and so reads at most one
 * comment past that, under Convex's 1 MiB document limit. A post so leaves
 * most of the 16 MiB read limit for its own reads, such as the roster, the
 * follows and each follower's inbox item, and stays quick. A step also stops
 * after `stepRows` comments. Tests lower them. */
export const COUNT_BUDGET = {
  post: 2 * 1024 * 1024,
  step: 4 * 1024 * 1024,
  stepRows: 2_000,
}

/* convex/commentCounts.ts step, referenced by name as model/archiveMarks.ts
 * references its steps. */
const stepRef = makeFunctionReference<'mutation', { issue_id: string }, null>('commentCounts:step')

/* The count row of a task, or null when it is not counted yet. */
const countRow = (ctx: QueryCtx, issueId: string): Promise<Doc<'comment_counts'> | null> =>
  ctx.db
    .query('comment_counts')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .first()

/**
 * Counts the comments of `issueId` from `cursor`, the position an earlier
 * count reached (null for the start), oldest first. It stops at the end of
 * the thread, or once it has counted `rows` or read `bytes`. `cursor` in the
 * answer is where it stopped, and absent when it reached the end. This is a
 * paginated query, and a Convex transaction may run only one.
 */
export async function countThread(
  ctx: QueryCtx,
  issueId: string,
  a: { cursor: string | null; rows: number; bytes: number },
): Promise<{ counted: number; cursor: string | undefined }> {
  const page = await ctx.db
    .query('comments')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .paginate({ cursor: a.cursor, numItems: a.rows, maximumBytesRead: a.bytes })
  return { counted: page.page.length, cursor: page.isDone ? undefined : page.continueCursor }
}

/**
 * Refuses a new comment on `issueId` when the task holds COMMENT_MAX
 * comments. A task not counted yet, or still being counted, is counted
 * here first within COUNT_BUDGET.post, and the count is stored unless the
 * post is refused. A thread longer than that budget is stored as counted so
 * far, background steps count on, and the post is refused only once the
 * comments counted reach the cap. postComment calls this before its insert
 * and noteCommentAdded after it.
 */
export async function assertRoomForComment(ctx: MutationCtx, issueId: string): Promise<void> {
  const row = await countRow(ctx, issueId)
  let count = row?.count ?? 0
  if ((row === null || row.cursor !== undefined) && count < COMMENT_MAX) {
    const more = await countThread(ctx, issueId, {
      cursor: row?.cursor ?? null,
      rows: COMMENT_MAX - count,
      bytes: COUNT_BUDGET.post,
    })
    count += more.counted
    if (count < COMMENT_MAX) {
      if (row === null) {
        await ctx.db.insert('comment_counts', {
          issue_id: issueId,
          count,
          ...(more.cursor === undefined ? {} : { cursor: more.cursor }),
        })
        // This post started the count, so it starts the background steps.
        // A later post that counts on leaves them to the steps already
        // scheduled.
        if (more.cursor !== undefined)
          await ctx.scheduler.runAfter(0, stepRef, { issue_id: issueId })
      } else {
        await ctx.db.patch(row._id, { count, cursor: more.cursor })
      }
    }
  }
  if (count >= COMMENT_MAX) throw rule(TOO_MANY_COMMENTS)
}

/**
 * Counts a comment just inserted on `issueId`. A task not counted yet stays
 * uncounted, and a task still being counted has its steps count the
 * comment, so only a whole count changes.
 */
export async function noteCommentAdded(ctx: MutationCtx, issueId: string): Promise<void> {
  const row = await countRow(ctx, issueId)
  if (row !== null && row.cursor === undefined) {
    await ctx.db.patch(row._id, { count: row.count + 1 })
  }
}

/**
 * Uncounts `comment`, deleted in this transaction. A task still being
 * counted loses its count instead, because its cursor cannot tell whether
 * the count has passed the comment, and its next post counts it again.
 */
export async function noteCommentRemoved(
  ctx: MutationCtx,
  comment: Doc<'comments'>,
): Promise<void> {
  const row = await countRow(ctx, comment.issue_id)
  if (row === null) return
  if (row.cursor !== undefined) await ctx.db.delete(row._id)
  else await ctx.db.patch(row._id, { count: Math.max(0, row.count - 1) })
}

/** Deletes the count of `issueId`, for a write that deletes the task or all
 * of its comments. */
export async function dropCommentCount(ctx: MutationCtx, issueId: string): Promise<void> {
  for (const row of await ctx.db
    .query('comment_counts')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .collect())
    await ctx.db.delete(row._id)
}

/** Stores `count` as the comment count of `issueId`, a task the caller
 * created in this transaction with every comment it holds, such as the
 * Northstar seed's tasks. */
export async function storeCommentCount(
  ctx: MutationCtx,
  issueId: string,
  count: number,
): Promise<void> {
  await dropCommentCount(ctx, issueId)
  await ctx.db.insert('comment_counts', { issue_id: issueId, count })
}

/**
 * One background step of a count that a post started. It counts on from
 * `cursor` within COUNT_BUDGET and schedules the next step until the count
 * reaches the end of the thread. A task deleted, or counted to the end by a
 * post meanwhile, ends the steps.
 */
export async function stepCommentCount(ctx: MutationCtx, issueId: string): Promise<void> {
  const row = await countRow(ctx, issueId)
  if (row === null || row.cursor === undefined) return
  const more = await countThread(ctx, issueId, {
    cursor: row.cursor,
    rows: COUNT_BUDGET.stepRows,
    bytes: COUNT_BUDGET.step,
  })
  await ctx.db.patch(row._id, { count: row.count + more.counted, cursor: more.cursor })
  if (more.cursor !== undefined) await ctx.scheduler.runAfter(0, stepRef, { issue_id: issueId })
}
