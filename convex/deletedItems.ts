/* The background work of Deleted items. model/deletedItems.ts holds the
 * rules: how deleting moves a task or a project into the trash, the step
 * machine and purging.
 *
 * step runs one bounded step of an item's job, whatever its phase, and
 * schedules the next. recover (every minute, crons.ts) restarts a job whose
 * step stopped, at half the budget each time, and makes an item stuck after
 * its last retry. expire (daily at 03:45 UTC) starts purging the ready items
 * whose 30 days are over, one bounded batch per run, and schedules the next
 * run while more are due. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { expireItems, recoverJobs, runStep } from './model/deletedItems'

const expireRef = makeFunctionReference<'mutation', Record<string, never>, null>(
  'deletedItems:expire',
)

/** One step of a deleted item's job. Safe to run twice or after the item is gone. */
export const step = internalMutation({
  args: { item_id: v.string() },
  handler: async (ctx, { item_id }): Promise<null> => {
    await runStep(ctx, item_id)
    return null
  },
})

/** Restarts stalled jobs (model/deletedItems.ts recoverJobs). */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    await recoverJobs(ctx)
    return null
  },
})

/** Starts purging one batch of expired items and chains the next. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    if (await expireItems(ctx)) await ctx.scheduler.runAfter(0, expireRef, {})
    return null
  },
})
