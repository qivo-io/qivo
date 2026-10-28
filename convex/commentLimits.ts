/* Background work for the comment limits (model/commentLimits.ts).
 *
 * `step` counts a task's comments in steps of its own, each scheduling the
 * next until the count is exact. A restore of a task stored before the
 * count starts one (restartCount). Convex drops what a failed step
 * scheduled, so `recover` (every 10 minutes, crons.ts) schedules a step for
 * each count still under way, which also finishes a count that
 * internal/commentCountsBackfill left. Two steps of one count run one after
 * the other, because both write its row, and each counts on from where the
 * last one stopped, so a repeated step costs reads but never counts a
 * comment twice. Until a count is exact, a post on its task counts the rest
 * itself or is refused for now.
 *
 * `sweep` (hourly) deletes the comment_rates rows whose posts all stopped
 * counting. The rate reads only the posts of the last minute, so a row the
 * sweep has not reached yet changes nothing. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { START, SWEEP_BATCH, stepCount } from './model/commentLimits'

/** The most counts under way one recovery restarts. */
export const RECOVER_BATCH = 64

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

/** Schedules a step of each count under way, at most RECOVER_BATCH of them,
 * those counted least far first. A later run takes the rest. */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const rows = await ctx.db
      .query('task_comment_counts')
      .withIndex('by_counted', (q) => q.gte('counted', START))
      .take(RECOVER_BATCH)
    for (const row of rows) await ctx.scheduler.runAfter(0, stepRef, { issue_id: row.issue_id })
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
