/* Background removal of a deleted label's task assignments.
 * model/labels.ts deleteLabelCore deletes the label and up to
 * LABEL_REMOVAL.inline assignments and writes its 'deleted label' activity
 * row in the admin's transaction. A label on more tasks also gets a
 * label_removals row and a scheduled `step`. Each step deletes up to
 * LABEL_REMOVAL.step more and schedules the next until none is left. Then it
 * deletes the row, which frees the id for labels.create.
 *
 * The app's snapshot join and task window, the machine task read, label
 * search and the export all skip an assignment whose label is gone, so the
 * rows left meanwhile are invisible. A step reads the same index prefix
 * again with take(n), so no cursor is kept and a repeated step cannot skip
 * a row.
 *
 * Convex drops the calls a failed mutation scheduled, so a step that fails
 * leaves the row in place. `recover` runs every ten minutes (crons.ts) and
 * restarts a row whose last step committed more than STALLED_MS ago and
 * that has no step waiting or running. The job is keyed by label id, not
 * organization, so it also finishes after the organization is deleted. */

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { byId } from './lib/db'
import { deleteLabelAssignments, LABEL_REMOVAL, pendingLabelRemoval } from './model/labels'

/** A row whose last step committed longer ago than this is restarted. */
export const STALLED_MS = 5 * 60_000

const RECOVER_BATCH = 32
/* The most stalled rows one recovery looks at, oldest progress first. Rows
 * whose step still waits are skipped without counting toward RECOVER_BATCH,
 * as in profileRemovals.ts. */
const RECOVER_SCAN = 512

const stepRef = makeFunctionReference<'mutation', { label_id: string }, null>('labelRemovals:step')

/** One bounded step of a removal. Safe to run twice or after the row is
 * gone. A live label with the id ends the job with an error log. Only a
 * fixture creates one (labels.create refuses a reserved id), and the rows
 * left can no longer be told apart from the new label's. */
export const step = internalMutation({
  args: { label_id: v.string() },
  handler: async (ctx, { label_id }): Promise<null> => {
    const job = await pendingLabelRemoval(ctx, label_id)
    if (job === null) return null
    if ((await byId(ctx, 'labels', label_id)) !== null) {
      console.error('Label removal stopped because a live label has its id', { label_id })
      await ctx.db.delete(job._id)
      return null
    }
    if (await deleteLabelAssignments(ctx, label_id, LABEL_REMOVAL.step)) {
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { label_id })
      await ctx.db.patch(job._id, { progress_at: new Date().toISOString(), scheduled_id })
      return null
    }
    await ctx.db.delete(job._id)
    console.info('Label removal completed', {
      label_id,
      lag_ms: Math.max(0, Date.now() - Date.parse(job.removed_at)),
    })
    return null
  },
})

/** Restarts removals whose last step committed more than STALLED_MS ago,
 * for example after a step failed. A row whose next step still waits or
 * runs is left alone, because a second chain would only repeat its work. */
export const recover = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const now = Date.now()
    const stalled = await ctx.db
      .query('label_removals')
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
      const scheduled_id = await ctx.scheduler.runAfter(0, stepRef, { label_id: job.label_id })
      await ctx.db.patch(job._id, { progress_at: new Date(now).toISOString(), scheduled_id })
      console.warn('Label removal resumed', {
        label_id: job.label_id,
        stalled_ms: now - Date.parse(job.progress_at),
      })
    }
    return null
  },
})
