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
 * seed (model/demoSeed.ts). Every task insert starts its count at 0
 * (startCount): createIssueCore, the Northstar seed and the
 * guest-organization fixture.
 *
 * A task's id can come back once the task is deleted for good, in its
 * organization or another, so the rows keyed by it go in the transaction
 * that deletes the task (deleteCommentRows): Deleted items' purges and
 * drops, and each teardown's step that deletes the task row. A row that
 * names another organization than the task's counts for nothing: a post
 * counts the thread again (commentRoom), and a new task or a new count
 * replaces the row (startCount, beginCount).
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
 * first the post is refused for now (countingRefusal), so no post passes
 * the cap on a partial count. The refusal undoes its own writes, so its
 * caller then starts the count in a transaction of its own (beginCount):
 * REST and MCP at once (machine/registry.ts runEntry), the app through
 * comments.countThread. Background steps (commentLimits.ts step) count on,
 * and a cron restarts a count that stopped moving at half the budget, until
 * one that keeps failing is marked stuck (commentLimits.ts recover).
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
import { COMMENT_RATE, COMMENTS_COUNTING, LIMITS, MIB, tooManyComments } from '../lib/limits'
import { DOCUMENT_MAX_BYTES } from './comments'

/** Where a count starts, below every _creationTime. */
export const START = Number.MIN_SAFE_INTEGER

/** How long a post counts against the author's rate on its task. */
export const RATE_WINDOW_MS = 60_000

/** The seconds a COMMENTS_COUNTING refusal asks a caller to wait. */
export const COUNTING_RETRY_AFTER = 60

/** What one count reads, in bytes as Convex counts every document a read
 * returns, a document read twice included: a post counting its task
 * (`post`), which shares its transaction with the post's own reads, and a
 * background or backfill step (`step`). A count reads in parts, each of
 * fewer comments than what `part` has left could hold at Convex's document
 * size limit, so even a thread of comments near that limit reads little
 * more than `part`. It stops once it has read `bytes` or counted `rows`,
 * with every comment that shares the last one's _creationTime. Each part
 * reads one comment past its end, which the next part reads again, so a
 * post's count of short comments stops after about 1.5 MiB of them. A post
 * counts no more than the cap needs. Tests lower them. */
export const COUNT_BUDGET = {
  post: { bytes: 2 * MIB, part: 6 * MIB },
  step: { bytes: 4 * MIB, part: 8 * MIB, rows: 2_000 },
}

/** Adaptive retries of a count's steps (commentLimits.ts recover): each
 * recovery halves a step's COUNT_BUDGET.step down to `floor`, and a count
 * whose step failed `atFloor` more times there is marked stuck. */
export const RETRY = { floor: 1 / 16, atFloor: 5 }

/** A count under way that has not moved for this long is restarted. */
export const STALLED_MS = 60_000

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
 * first, within `budget`. Each part reads one comment more than it counts,
 * to tell whether it ends inside a group of comments that share a
 * _creationTime, and only then reads that group whole. So a page that stops
 * at a time has counted every comment at it, and the next starts after it.
 * Only an import that set the times could make such a group too large to
 * read (model/comments.ts newestComments).
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
    // the part and the comment past it fit what `part` has left
    const fits = Math.floor((budget.part - bytes) / DOCUMENT_MAX_BYTES)
    const want = Math.max(1, Math.min(budget.rows - rows, fits - 1))
    const from = through
    const read = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', issueId).gt('_creationTime', from))
      .take(want + 1)
    for (const comment of read) bytes += getDocumentSize(comment)
    if (read.length <= want) {
      rows += read.length
      return { rows, through: read.at(-1)?._creationTime ?? through, done: true }
    }
    const last = read[want - 1]._creationTime
    let counted = want
    if (read[want]._creationTime === last) {
      // the part ends inside a group that shares its last time
      const group = await ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', issueId).eq('_creationTime', last))
        .collect()
      for (const comment of group) bytes += getDocumentSize(comment)
      counted = read.slice(0, want).filter((c) => c._creationTime < last).length + group.length
    }
    rows += counted
    through = last
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
  more: Pick<Refusal, 'reason' | 'retry_after' | 'task_id'> = {},
): ConvexError<Refusal> {
  const message = archive
    ? `${what}, so the archive reason cannot be posted and the task was not archived. ${next}`
    : `${what}. ${next}`
  return new ConvexError<Refusal>({ code: 'rule', message, ...more })
}

/** The cap's refusal (LIMITS.comments). Only a comment's author or a
 * project lead can delete it, so an archive's sentence also names the way
 * every member has: an archive without a reason. */
export const capRefusal = (archive: boolean): ConvexError<Refusal> =>
  archive
    ? refusal(
        true,
        'this task has reached 1,000 comments, the most a task can have',
        'Archive it without a reason, which the app allows once its work is Done, or ask a project lead to delete comments until it has fewer than 1,000.',
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

/** The refusal of a post on task `issueId` while its comments are still
 * being counted. */
export const countingRefusal = (archive: boolean, issueId: string): ConvexError<Refusal> =>
  refusal(
    archive,
    "Qivo is still counting this task's comments",
    `Try again in ${COUNTING_RETRY_AFTER} seconds.`,
    { reason: COMMENTS_COUNTING, retry_after: COUNTING_RETRY_AFTER, task_id: issueId },
  )

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
 * A task not counted yet, still being counted, or whose row names another
 * organization, is counted to the end here within COUNT_BUDGET.post and the
 * count stored; when the budget runs out first, the comment is refused for
 * now (countingRefusal). Every refusal, with `archive`, refuses the archive
 * whose reason the comment is. Answers what postComment records once it has
 * inserted the comment.
 */
export async function commentRoom(
  ctx: MutationCtx,
  a: { issue: Doc<'issues'>; author: Doc<'profiles'>; nowMs: number; archive?: boolean },
): Promise<Room> {
  const { issue, author, nowMs } = a
  const archive = a.archive === true
  const max = LIMITS.comments.max
  const found = await countRow(ctx, issue.id)
  // a row another task with this id left counts for nothing
  const own = found?.org_id === issue.org_id ? found : null
  let counter: Doc<'task_comment_counts'>
  if (own !== null && own.counted === undefined) counter = own
  else {
    // what the row has counted is a lower bound, enough to refuse on
    const held = own?.count ?? 0
    if (held >= max) throw capRefusal(archive)
    const page = await countPage(ctx, issue.id, own?.counted ?? START, {
      ...COUNT_BUDGET.post,
      rows: max - held,
    })
    const count = held + page.rows
    if (count >= max) throw capRefusal(archive)
    if (!page.done) {
      console.warn("A comment waited for its task's comments to be counted", {
        issue_id: issue.id,
      })
      throw countingRefusal(archive, issue.id)
    }
    const exact = {
      org_id: issue.org_id,
      issue_id: issue.id,
      count,
      revision: (found?.revision ?? -1) + 1,
    }
    if (found === null) {
      const id = await uncountedWriter(ctx.db).insert('task_comment_counts', exact)
      counter = (await ctx.db.get(id)) as Doc<'task_comment_counts'>
    } else {
      await ctx.db.replace(found._id, exact)
      counter = { _id: found._id, _creationTime: found._creationTime, ...exact }
    }
  }
  if (counter.count >= max) throw capRefusal(archive)
  const rate = await ctx.db
    .query('comment_rates')
    .withIndex('by_author_issue', (q) => q.eq('author', author.id).eq('issue_id', issue.id))
    .unique()
  // posts another task with this id left count for nothing
  const recent = (rate?.org_id === issue.org_id ? rate.posts : [])
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
  const { counter } = room
  await ctx.db.patch(counter._id, { count: counter.count + 1, revision: counter.revision + 1 })
  const posts = [...room.recent, a.nowMs].sort((x, y) => x - y).slice(-LIMITS.commentRate.max)
  const until = a.nowMs + RATE_WINDOW_MS
  if (room.rate !== null)
    await ctx.db.patch(room.rate._id, { org_id: a.issue.org_id, posts, until })
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
 * deleted outside postComment, and their revisions. Reads each task's row
 * once. A task without a row stays not counted, and a comment created after
 * a count's `counted` is left to that count.
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
    await ctx.db.patch(row._id, { count: row.count + by, revision: row.revision + 1 })
  }
}

/** Starts the comment count of `issue`, a task the caller inserted in this
 * transaction with no comments, at 0. A row left under its id, which no
 * comment of the new task can be in, is replaced. */
export async function startCount(
  ctx: MutationCtx,
  issue: Pick<Doc<'issues'>, 'id' | 'org_id'>,
): Promise<void> {
  const row = await countRow(ctx, issue.id)
  const fresh = { org_id: issue.org_id, issue_id: issue.id, count: 0 }
  if (row !== null) await ctx.db.replace(row._id, { ...fresh, revision: row.revision + 1 })
  else await uncountedWriter(ctx.db).insert('task_comment_counts', { ...fresh, revision: 0 })
}

/**
 * Starts counting the comments of `issue` in background steps, from the
 * start of its thread when it has no row or one that names another
 * organization, and restarts a count under way that has not moved for
 * STALLED_MS. An exact count, a moving count and a stuck one are left as
 * they are, so it is safe to call again. For a post refused while its
 * task's comments are counted, in a transaction of its own because the
 * refusal undoes its own writes, and for a task Deleted items writes back
 * that was stored before counts, whose steps also count the comments the
 * restore wrote back.
 */
export async function beginCount(
  ctx: MutationCtx,
  issue: Pick<Doc<'issues'>, 'id' | 'org_id'>,
): Promise<void> {
  const row = await countRow(ctx, issue.id)
  const now = Date.now()
  if (row === null || row.org_id !== issue.org_id) {
    const fresh = {
      org_id: issue.org_id,
      issue_id: issue.id,
      count: 0,
      counted: START,
      progress_at: now,
    }
    if (row !== null) await ctx.db.replace(row._id, { ...fresh, revision: row.revision + 1 })
    else await uncountedWriter(ctx.db).insert('task_comment_counts', { ...fresh, revision: 0 })
  } else if (
    row.counted === undefined ||
    row.stuck === true ||
    (row.progress_at ?? 0) > now - STALLED_MS
  )
    return
  else await ctx.db.patch(row._id, { progress_at: now })
  await ctx.scheduler.runAfter(0, stepRef, { issue_id: issue.id })
}

/** Deletes the comment count and the post logs of task `issueId`, in the
 * transaction that deletes the task for good, so a task that takes its id
 * later starts from nothing. Answers the rows deleted, for a caller that
 * charges them to a budget. */
export async function deleteCommentRows(
  ctx: MutationCtx,
  issueId: string,
): Promise<(Doc<'task_comment_counts'> | Doc<'comment_rates'>)[]> {
  const counts = await ctx.db
    .query('task_comment_counts')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .collect()
  const rates = await ctx.db
    .query('comment_rates')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .collect()
  for (const row of [...counts, ...rates]) await ctx.db.delete(row._id)
  return [...counts, ...rates]
}

/** The share of COUNT_BUDGET.step a count's step spends after `attempts`
 * recoveries: half for each, down to RETRY.floor. */
const stepScale = (attempts: number | undefined): number =>
  Math.max(RETRY.floor, 2 ** -(attempts ?? 0))

/** The recoveries after which a count is at RETRY.floor. */
const FLOOR_AFTER = Math.ceil(Math.log2(1 / RETRY.floor))

/** Whether a count recovered `attempts` times has failed RETRY.atFloor
 * times at the smallest budget, so recovery marks it stuck. */
export const keepsFailing = (attempts: number): boolean => attempts > FLOOR_AFTER + RETRY.atFloor

/**
 * One step of the count of task `issueId`: counts the comments created
 * after its row's `counted` within COUNT_BUDGET.step, scaled down after
 * failed steps (stepScale), and ends the count at the end of the thread. A
 * step that commits resets the budget. Answers the count once it is exact,
 * null while it counts, and 'skipped' when the task has no row. An exact
 * count is left as it is.
 */
export async function stepCount(
  ctx: MutationCtx,
  issueId: string,
): Promise<number | 'skipped' | null> {
  const row = await countRow(ctx, issueId)
  if (row === null) return 'skipped'
  if (row.counted === undefined) return row.count
  const scale = stepScale(row.attempts)
  const { bytes, part, rows } = COUNT_BUDGET.step
  const page = await countPage(ctx, issueId, row.counted, {
    bytes: bytes * scale,
    part: Math.max(2 * DOCUMENT_MAX_BYTES, part * scale),
    rows: Math.max(1, Math.floor(rows * scale)),
  })
  const count = row.count + page.rows
  await ctx.db.patch(row._id, {
    count,
    revision: row.revision + 1,
    counted: page.done ? undefined : page.through,
    progress_at: page.done ? undefined : Date.now(),
    attempts: undefined,
    stuck: undefined,
  })
  return page.done ? count : null
}
