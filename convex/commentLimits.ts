/* Background work for the comment limits (model/commentLimits.ts).
 *
 * `step` counts a task's comments in steps of its own, each scheduling the
 * next until the count is exact. `begin` starts a count: REST and MCP call
 * it after a post refused while its task's comments are counted
 * (machine/registry.ts runEntry), because the refusal undoes what it wrote,
 * and the app calls comments.countThread, which does the same behind the
 * app's checks. A restore of a task stored before counts starts one too.
 *
 * Every step that commits stamps the count's `progress_at`. Convex drops
 * what a failed step scheduled, so `recover` (every 10 minutes, crons.ts)
 * restarts each count under way that has not moved for STALLED_MS, least
 * recently moved first, and counts the attempt: each halves the next
 * step's budget, and a count that keeps failing at the smallest one is
 * marked stuck and left for the backfill (internal/commentCountsBackfill),
 * which lists it. Its task's posts stay refused for now, as the cap needs.
 * `begin` restarts a stalled count the same way (model/commentLimits.ts
 * restartStalled), so a caller that retries on every refusal brings a
 * failing count down to the smallest budget too.
 * Two steps of one count run one after the other, because both write its
 * row, and each counts on from where the last one stopped, so a repeated
 * step costs reads but never counts a comment twice.
 *
 * `sweep` (hourly) deletes the comment_rates rows whose posts all stopped
 * counting. The rate reads only the posts of the last minute, so a row the
 * sweep has not reached yet changes nothing. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { byId } from './lib/db'
import {
  beginCount,
  restartStalled,
  STALLED_MS,
  SWEEP_BATCH,
  stepCount,
} from './model/commentLimits'

/** The most stalled counts one recovery restarts. Tests lower it. */
export const RECOVER = { batch: 64 }

const stepRef = makeFunctionReference<'mutation', { issue_id: string }, null>('commentLimits:step')
const sweepRef = makeFunctionReference<'mutation', Record<string, never>, null>(
  'commentLimits:sweep',
)

/** One step of the count of task `issue_id`, scheduling the next until the
 * count is exact. Does nothing for a task with no row or an exact count. */
export const step = internalMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }): Promise<null> => {
    if ((await stepCount(ctx, issue_id)) === null)
      await ctx.scheduler.runAfter(0, stepRef, { issue_id })
    return null
  },
})

/** Starts counting live task `issue_id`'s comments
 * (model/commentLimits.ts beginCount), after a post on it was refused while
 * they are counted. Safe to call again; does nothing for a task that is
 * gone. */
export const begin = internalMutation({
  args: { issue_id: v.string() },
  handler: async (ctx, { issue_id }): Promise<null> => {
    const issue = await byId(ctx, 'issues', issue_id)
    if (issue !== null) await beginCount(ctx, issue)
    return null
  },
})

/** Restarts the counts under way that have not moved for STALLED_MS, at
 * most RECOVER.batch of them, least recently moved first, and stamps each,
 * so a later run takes the others first (model/commentLimits.ts
 * restartStalled: one attempt more, half the budget, stuck at the end). */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const rows = await ctx.db
      .query('task_comment_counts')
      .withIndex('by_progress', (q) => q.gte('progress_at', 0).lt('progress_at', now - STALLED_MS))
      .take(RECOVER.batch)
    for (const row of rows) await restartStalled(ctx, row, now)
    return null
  },
})

/** Deletes up to SWEEP_BATCH comment_rates rows whose newest post stopped
 * counting, and schedules the next leg after a full one. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const rows = await ctx.db
      .query('comment_rates')
      .withIndex('by_until', (q) => q.lte('until', now))
      .take(SWEEP_BATCH)
    for (const row of rows) await ctx.db.delete(row._id)
    if (rows.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, sweepRef, {})
    return null
  },
})
