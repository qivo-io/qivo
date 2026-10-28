/* The two limits on comments: a task holds at most LIMITS.comments.max of
 * them, and one author posts at most LIMITS.commentRate.max on one task in
 * any 60 seconds of server time. Both hold for every author and every way a
 * comment is made, the app's composer and Team sync notes, REST, MCP and
 * archive reasons, because each posts through model/comments.ts
 * postComment, which checks both (commentRoom) and records the post
 * (takeRoom) in the transaction that inserts the comment.
 *
 * The cap reads a count, not the thread: a thousand comments at TEXT_MAX
 * are about 57 MiB, past Convex's 16 MiB read limit, and comments stored
 * before that cap can come close to the 1 MiB document limit. Each task has
 * one task_comment_counts row (schema.ts), and every other write that
 * inserts or deletes a comment row moves it in its transaction
 * (tallyComments): deleteComment, for the app, REST and MCP; Deleted items
 * (model/deletedItems.ts), whose moves take a task's comments out and whose
 * restores write them back, so a count survives the trip; and the Northstar
 * seed (model/demoSeed.ts). A task deleted for good loses its row with it
 * (deleteCount), and the teardowns that delete an organization's work
 * outright delete its rows by organization. Every task insert starts its
 * count at 0 (startCount): createIssueCore, the Northstar seed and the
 * guest-organization fixture.
 *
 * Tasks stored before the count have no row until
 * internal/commentCountsBackfill counts them. A count reads in pages, in
 * _creationTime order (countPage), and keeps the time it has counted
 * through in `counted`. A write moves `count` only for a comment created
 * at or before that time, as model/orgs.ts tallyRows does by task number,
 * so a count is exact however the thread changes while it runs. The posting
 * check fails closed. A task without a row, or whose count is under way, is
 * counted to the end in the post's own transaction, within
 * COUNT_BUDGET.post, and the count is stored. When that budget runs out
 * first the post is refused for now (COMMENTS_COUNTING), so no post passes
 * the cap on a partial count. A restore of a task stored before the count
 * starts its count in background steps (restartCount), and a cron restarts
 * every count left under way (commentLimits.ts recover).
 *
 * The rate keeps its own post log, comment_rates, because a deleted comment
 * must not give its post back. A refused post throws and so writes neither
 * row, and postComment's id check refuses a retry of a post that committed,
 * so no post counts twice. Every post and delete on a task writes its count
 * row, so Convex runs them one after another, and so it does one author's
 * posts there, which also write one rate row. */

import { makeFunctionReference } from 'convex/server'
import { ConvexError, getDocumentSize } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { uncountedWriter } from '../lib/demo'
import type { Refusal } from '../lib/functions'
import { LIMITS, MIB, tooManyComments } from '../lib/limits'
import { DOCUMENT_MAX_BYTES } from './comments'

/** Where a count starts, below every _creationTime. */
export const START = Number.MIN_SAFE_INTEGER

/** How long a post counts against the author's rate on its task. */
export const RATE_WINDOW_MS = 60_000

/** The refusal reason of a comment past LIMITS.commentRate. Its
 * `retry_after` is the wait in seconds; REST answers it 429 with
 * Retry-After. */
export const COMMENT_RATE = 'comment_rate'

/** The refusal reason of a comment on a task whose comments could not be
 * counted to the end within COUNT_BUDGET.post. REST answers it 503 with
 * Retry-After. */
export const COMMENTS_COUNTING = 'comments_counting'

/** The seconds a COMMENTS_COUNTING refusal asks a caller to wait. */
export const COUNTING_RETRY_AFTER = 60

/** What one count reads, in bytes as Convex counts a document's size: a
 * post counting its task (`post`), which shares its transaction with the
 * post's own reads, and a background or backfill step (`step`). A count
 * reads in parts of no more comments than `part`, less what it has read,
 * could hold at Convex's document size limit, so even a thread of
 * comments near that limit reads little more than `part`. It stops once it
 * has read `bytes` or counted `rows`, with every comment that shares the
 * last one's _creationTime. A post counts no more than the cap needs.
 * Tests lower them. */
export const COUNT_BUDGET = {
  post: { bytes: 2 * MIB, part: 4 * MIB },
  step: { bytes: 4 * MIB, part: 8 * MIB, rows: 2_000 },
}

/** The most rows one leg of the rate sweep deletes. */
export const SWEEP_BATCH = 500

type Budget = { bytes: number; part: number; rows: number }

/** One page of a count: the comments it counted, the _creationTime it
 * counted through, and whether the thread ends there. */
export type CountPage = { rows: number; through: number; done: boolean }

/* commentLimits.ts step, by name, as model/deletedItems.ts names its own. */
const stepRef = makeFunctionReference<'mutation', { issue_id: string }, null>('commentLimits:step')

/** The comment count row of task `issueId`, or null when it is not counted
 * yet. */
export const countRow = (
  ctx: QueryCtx,
  issueId: string,
): Promise<Doc<'task_comment_counts'> | null> =>
  ctx.db
    .query('task_comment_counts')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .unique()

/**
 * Counts the comments on task `issueId` created after `after`, oldest
 * first, within `budget`. Comments that share a _creationTime are counted
 * together, so a page that stops at a time has counted every comment at
 * it, and the next starts after it. Only an import that set the times
 * could make such a group too large to read (model/comments.ts
 * newestComments).
 */
export async function countPage(
  ctx: QueryCtx,
  issueId: string,
  after: number,
  budget: Budget,
): Promise<CountPage> {
  let through = after
  let rows = 0
  let bytes = 0
  for (;;) {
    const fits = Math.max(1, Math.floor((budget.part - bytes) / DOCUMENT_MAX_BYTES))
    const want = Math.max(1, Math.min(budget.rows - rows, fits))
    const from = through
    const part = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', issueId).gt('_creationTime', from))
      .take(want)
    const last = part.at(-1)?._creationTime
    if (last === undefined) return { rows, through, done: true }
    // a full part can end inside a group of comments that share its last time
    const tail =
      part.length < want
        ? []
        : await ctx.db
            .query('comments')
            .withIndex('by_issue', (q) => q.eq('issue_id', issueId).eq('_creationTime', last))
            .collect()
    for (const comment of [...part, ...tail]) bytes += getDocumentSize(comment)
    rows +=
      tail.length === 0
        ? part.length
        : part.filter((comment) => comment._creationTime < last).length + tail.length
    through = last
    if (part.length < want) return { rows, through, done: true }
    if (rows >= budget.rows || bytes >= budget.bytes) return { rows, through, done: false }
  }
}

/** The refusal of a comment, `what` and then `next`, the step past it, or
 * with `archive` of the archive whose reason the comment is, which says
 * that nothing was archived. */
function refusal(
  archive: boolean,
  what: string,
  next: string,
  more: Pick<Refusal, 'reason' | 'retry_after'> = {},
): ConvexError<Refusal> {
  const message = archive
    ? `${what}, so the archive reason cannot be posted and the task was not archived. ${next}`
    : `${what}. ${next}`
  return new ConvexError<Refusal>({ code: 'rule', message, ...more })
}

/** The cap's refusal (LIMITS.comments). */
export const capRefusal = (archive: boolean): ConvexError<Refusal> =>
  archive
    ? refusal(
        true,
        'this task has reached 1,000 comments, the most a task can have',
        'Delete comments until it has fewer than 1,000, then archive it again.',
      )
    : new ConvexError<Refusal>({ code: 'rule', message: LIMITS.comments.refusal })

/** The rate's refusal (LIMITS.commentRate), `seconds` before the author
 * can post on the task again. */
export function rateRefusal(archive: boolean, seconds: number): ConvexError<Refusal> {
  const more = { reason: COMMENT_RATE, retry_after: seconds }
  if (!archive)
    return new ConvexError<Refusal>({ code: 'rule', message: tooManyComments(seconds), ...more })
  const wait = seconds === 1 ? '1 second' : `${seconds} seconds`
  return refusal(
    true,
    'too many comments on this task, at most 10 in any 60 seconds from one person or agent',
    `Try again in ${wait}.`,
    more,
  )
}

/** The refusal of a post on a task whose comments are still being
 * counted. */
export const countingRefusal = (archive: boolean): ConvexError<Refusal> =>
  refusal(archive, "Qivo is still counting this task's comments", 'Try again shortly.', {
    reason: COMMENTS_COUNTING,
    retry_after: COUNTING_RETRY_AFTER,
  })

/** What a post found, which takeRoom records: the task's count row,
 * counted to the end, and the author's posts there that still count, oldest
 * first, with the row that holds them. */
export type Room = {
  counter: Doc<'task_comment_counts'>
  rate: Doc<'comment_rates'> | null
  recent: number[]
}

/**
 * Refuses a comment by `author` on `issue` at `nowMs`, server time in
 * milliseconds, once the task has LIMITS.comments.max comments or more, or
 * the author has posted LIMITS.commentRate.max there in the last
 * RATE_WINDOW_MS, with the seconds until one of those posts stops counting.
 * A task not counted yet, or still being counted, is counted to the end
 * here within COUNT_BUDGET.post and the count stored; when the budget runs
 * out first, the comment is refused for now (countingRefusal). Every
 * refusal, with `archive`, refuses the archive whose reason the comment is.
 * Answers what postComment records once it has inserted the comment.
 */
export async function commentRoom(
  ctx: MutationCtx,
  a: { issue: Doc<'issues'>; author: Doc<'profiles'>; nowMs: number; archive?: boolean },
): Promise<Room> {
  const { issue, author, nowMs } = a
  const archive = a.archive === true
  const max = LIMITS.comments.max
  let counter = await countRow(ctx, issue.id)
  if (counter === null || counter.counted !== undefined) {
    // what the row has counted is a lower bound, enough to refuse on
    const held = counter?.count ?? 0
    if (held >= max) throw capRefusal(archive)
    const page = await countPage(ctx, issue.id, counter?.counted ?? START, {
      ...COUNT_BUDGET.post,
      rows: max - held,
    })
    const count = held + page.rows
    if (count >= max) throw capRefusal(archive)
    if (!page.done) {
      console.warn("A comment waited for its task's comments to be counted", {
        issue_id: issue.id,
      })
      throw countingRefusal(archive)
    }
    if (counter === null) {
      const id = await uncountedWriter(ctx.db).insert('task_comment_counts', {
        org_id: issue.org_id,
        issue_id: issue.id,
        count,
      })
      counter = (await ctx.db.get(id)) as Doc<'task_comment_counts'>
    } else {
      await ctx.db.patch(counter._id, { count, counted: undefined })
      counter = { ...counter, count, counted: undefined }
    }
  }
  if (counter.count >= max) throw capRefusal(archive)
  const rate = await ctx.db
    .query('comment_rates')
    .withIndex('by_author_issue', (q) => q.eq('author', author.id).eq('issue_id', issue.id))
    .unique()
  const recent = (rate?.posts ?? [])
    .filter((at) => at > nowMs - RATE_WINDOW_MS)
    .sort((x, y) => x - y)
  const allowed = LIMITS.commentRate.max
  if (recent.length >= allowed) {
    const wait = recent[recent.length - allowed] + RATE_WINDOW_MS - nowMs
    throw rateRefusal(archive, Math.max(1, Math.ceil(wait / 1000)))
  }
  return { counter, rate, recent }
}

/** Records a comment by `author` on `issue`, just inserted at `nowMs`, in
 * `room`, which commentRoom answered in this transaction: one comment more
 * on the task, and one post more by the author there. */
export async function takeRoom(
  ctx: MutationCtx,
  room: Room,
  a: { issue: Doc<'issues'>; author: Doc<'profiles'>; nowMs: number },
): Promise<void> {
  await ctx.db.patch(room.counter._id, { count: room.counter.count + 1 })
  const posts = [...room.recent, a.nowMs].sort((x, y) => x - y).slice(-LIMITS.commentRate.max)
  const until = a.nowMs + RATE_WINDOW_MS
  if (room.rate !== null) await ctx.db.patch(room.rate._id, { posts, until })
  else
    await uncountedWriter(ctx.db).insert('comment_rates', {
      org_id: a.issue.org_id,
      issue_id: a.issue.id,
      author: a.author.id,
      posts,
      until,
    })
}

/** A comment as tallyComments reads it. A comment this transaction
 * inserted may leave out its _creationTime, which is then read only when a
 * count of its task is under way. */
export type Tallied = Pick<Doc<'comments'>, '_id' | 'issue_id'> &
  Partial<Pick<Doc<'comments'>, '_creationTime'>>

/** A comment this transaction inserted (+1) or deleted (-1). */
export type CommentWrite = readonly [comment: Tallied, by: 1 | -1]

/**
 * Moves the comment counts for comments this transaction inserted or
 * deleted outside postComment. Reads each task's row once. A task without
 * a row stays not counted, and a comment created after a count's `counted`
 * is left to that count.
 */
export async function tallyComments(
  ctx: MutationCtx,
  writes: readonly CommentWrite[],
): Promise<void> {
  const moves = new Map<string, CommentWrite[]>()
  for (const write of writes)
    moves.set(write[0].issue_id, [...(moves.get(write[0].issue_id) ?? []), write])
  for (const [issueId, list] of moves) {
    const row = await countRow(ctx, issueId)
    if (row === null) continue
    let by = 0
    for (const [comment, move] of list) {
      if (row.counted !== undefined) {
        // every comment was created after START, so a count that has not
        // passed it needs no time read
        const at =
          comment._creationTime ??
          (row.counted === START ? undefined : (await ctx.db.get(comment._id))?._creationTime)
        if (at === undefined || at > row.counted) continue
      }
      by += move
    }
    if (by !== 0) await ctx.db.patch(row._id, { count: row.count + by })
  }
}

/** Starts the comment count of `issue`, a task the caller inserted in this
 * transaction with no comments, at 0. A row a purge left under its id, which
 * no comment of the new task can be in, is replaced. */
export async function startCount(
  ctx: MutationCtx,
  issue: Pick<Doc<'issues'>, 'id' | 'org_id'>,
): Promise<void> {
  const row = await countRow(ctx, issue.id)
  if (row !== null)
    await ctx.db.replace(row._id, { org_id: issue.org_id, issue_id: issue.id, count: 0 })
  else
    await uncountedWriter(ctx.db).insert('task_comment_counts', {
      org_id: issue.org_id,
      issue_id: issue.id,
      count: 0,
    })
}

/** Starts counting `issue` from the start of its thread in background
 * steps unless it has a row, for a task Deleted items writes back that was
 * stored before the count. The steps also count the comments the restore
 * wrote back. */
export async function restartCount(
  ctx: MutationCtx,
  issue: Pick<Doc<'issues'>, 'id' | 'org_id'>,
): Promise<void> {
  if ((await countRow(ctx, issue.id)) !== null) return
  await uncountedWriter(ctx.db).insert('task_comment_counts', {
    org_id: issue.org_id,
    issue_id: issue.id,
    count: 0,
    counted: START,
  })
  await ctx.scheduler.runAfter(0, stepRef, { issue_id: issue.id })
}

/** Deletes the comment count of task `issueId`, deleted for good. */
export async function deleteCount(ctx: MutationCtx, issueId: string): Promise<void> {
  const row = await countRow(ctx, issueId)
  if (row !== null) await ctx.db.delete(row._id)
}

/**
 * One step of the count of task `issueId`: counts the comments created
 * after its row's `counted` within COUNT_BUDGET.step and ends the count at
 * the end of the thread. Answers the count once it is exact, null while it
 * counts, and 'skipped' when the task has no row. An exact count is left
 * as it is.
 */
export async function stepCount(
  ctx: MutationCtx,
  issueId: string,
): Promise<number | 'skipped' | null> {
  const row = await countRow(ctx, issueId)
  if (row === null) return 'skipped'
  if (row.counted === undefined) return row.count
  const page = await countPage(ctx, issueId, row.counted, COUNT_BUDGET.step)
  const count = row.count + page.rows
  await ctx.db.patch(row._id, { count, counted: page.done ? undefined : page.through })
  return page.done ? count : null
}
