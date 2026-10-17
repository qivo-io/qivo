/* The background trim that holds each organization's stored activity near
 * its newest ACTIVITY_CAP rows (model/activity.ts). An activity write
 * schedules it through requestActivityTrim when none is pending, so writers
 * in one organization do not conflict over deleting the oldest row. Readers
 * take the newest ACTIVITY_CAP rows themselves, so the extra rows a pending
 * trim leaves are never shown. */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import {
  ACTIVITY_TRIM_DELAY_MS,
  activityTrimRef,
  retentionRow,
  trimActivity,
} from './model/activity'

/** One trim step for an organization. A backlog larger than one step
 * schedules the next step at once. Rows too new to trim that still hold the
 * organization past the cap schedule another trim after
 * ACTIVITY_TRIM_DELAY_MS, so the excess goes even if no write follows. The
 * last step clears trim_due_at, so the next activity write schedules a trim
 * again. A trim that runs while another is due later, because an operator
 * ran it or a writer took it for lost, leaves both to that one, so one
 * chain of trims remains. */
export const trim = internalMutation({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<null> => {
    const state = await retentionRow(ctx, org_id)
    if (state === null) return null // the organization is gone
    const owner = state.trim_due_at === undefined || state.trim_due_at <= Date.now()
    const result = await trimActivity(ctx, org_id)
    if (result === 'more') {
      // trim_due_at stays set, so writers keep only reading the state row
      await ctx.scheduler.runAfter(0, activityTrimRef, { org_id })
      return null
    }
    if (!owner) return null
    if (result === 'later') {
      // the new due time keeps writers from taking this trim for a lost one
      const due = Date.now() + ACTIVITY_TRIM_DELAY_MS
      await ctx.scheduler.runAt(due, activityTrimRef, { org_id })
      await ctx.db.patch(state._id, { trim_due_at: due })
      return null
    }
    if (state.trim_due_at !== undefined) await ctx.db.patch(state._id, { trim_due_at: undefined })
    return null
  },
})
