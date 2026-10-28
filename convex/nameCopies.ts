/* Background steps that bring a renamed profile's or team's name key copies
 * in line (schema.ts name_copies, model/nameKeys.ts). A rename brings up to
 * NAME_COPIES.inline of them in line in its own transaction. A source with
 * more gets a name_copies row and a scheduled `step`. Each step reads the
 * source's current name, gives up to NAME_COPIES.step more copies its key
 * and schedules the next until none differs. Then it deletes the row. A
 * step finds the copies through an index range by source and key, so no
 * cursor is kept and a repeated step cannot skip one.
 *
 * Convex drops the calls a failed mutation scheduled, so a step that fails
 * leaves the row in place. `recover` runs every ten minutes (crons.ts) and
 * restarts a row whose last step committed more than STALLED_MS ago and
 * that has no step waiting or running. The job is keyed by its source, not
 * by organization, so it also ends after the organization is deleted. A
 * step that finds the source gone deletes the row, as the copies go with
 * their profile or team. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { byId } from './lib/db'
import { type NameSource, vNameSource } from './lib/enums'
import { bringInLine, NAME_COPIES, pendingNameCopies } from './model/nameKeys'

/** A row whose last step committed longer ago than this is restarted. */
export const STALLED_MS = 5 * 60_000

const RECOVER_BATCH = 32
/* The most stalled rows one recovery looks at, oldest progress first. Rows
 * whose step still waits are skipped without counting toward RECOVER_BATCH,
 * as in labelRemovals.ts. */
const RECOVER_SCAN = 512

const stepRef = makeFunctionReference<'mutation', { source: NameSource; source_id: string }, null>(
  'nameCopies:step',
)

/** One bounded step. Safe to run twice or after the row is gone. */
export const step = internalMutation({
  args: { source: vNameSource, source_id: v.string() },
  handler: async (ctx, { source, source_id }): Promise<null> => {
    const job = await pendingNameCopies(ctx, source, source_id)
    if (job === null) return null
    const row = await byId(ctx, source, source_id)
    if (row !== null && (await bringInLine(ctx, source, row, { left: NAME_COPIES.step }))) {
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { source, source_id })
      await ctx.db.patch(job._id, { progress_at: new Date().toISOString(), scheduled_id })
      return null
    }
    await ctx.db.delete(job._id)
    return null
  },
})

/** Restarts jobs whose last step committed more than STALLED_MS ago, for
 * example after a step failed. A row whose next step still waits or runs is
 * left alone, because a second chain would only repeat its work. */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const stalled = await ctx.db
      .query('name_copies')
      .withIndex('by_progress', (q) =>
        q.lt('progress_at', new Date(now - STALLED_MS).toISOString()),
      )
      .take(RECOVER_SCAN)
    let restarted = 0
    for (const job of stalled) {
      if (restarted === RECOVER_BATCH) break
      const next = job.scheduled_id === undefined ? null : await ctx.db.system.get(job.scheduled_id)
      if (next?.state.kind === 'pending' || next?.state.kind === 'inProgress') continue
      restarted += 1
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, {
        source: job.source,
        source_id: job.source_id,
      })
      await ctx.db.patch(job._id, { progress_at: new Date(now).toISOString(), scheduled_id })
      console.warn('Name key copies resumed', {
        source: job.source,
        source_id: job.source_id,
        stalled_ms: now - Date.parse(job.progress_at),
      })
    }
    return null
  },
})
