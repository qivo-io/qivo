/* Deletes platform_audit_log rows once they are AUDIT_RETENTION_DAYS old,
 * the period Qivo's privacy notice gives for records of administrative and
 * security actions. It covers every row: operator actions, the app's
 * invitation emails, billing changes and the nightly jobs' own rows.
 *
 * The nightly cron (crons.ts) starts a run with empty arguments, which fixes
 * the run's cutoff. Each step deletes the oldest rows from before the cutoff,
 * at most AUDIT_EXPIRY.page of them, and schedules the next step while a full
 * page came back. The last step writes the run's one expire_audit_log row
 * with the number of rows deleted, as each nightly job writes one row
 * (jobs.ts). That row expires like the others. Convex drops the calls a
 * failed step scheduled, so a failure ends the run without its row, and the
 * next night's run deletes what is left.
 *
 * Once a row is gone, Qivo Admin's Audit page no longer lists it, and a
 * pending seat invited before then shows only "Invited", without when the
 * email went out or the link to copy when it was not sent (admin.ts
 * latestInvite, adminPeople.ts inviteIn). A pending seat reactivated after
 * that is emailed again, because no delivered invitation remains on record
 * (invites.ts unless_sent). The invitation email caps read only the last
 * hour (invites.ts recentSends). */

import { makeFunctionReference } from 'convex/server'
import { type ObjectType, v } from 'convex/values'
import { internalMutation } from './_generated/server'

/** Days an audit row is kept. Change the privacy notice with it. */
export const AUDIT_RETENTION_DAYS = 90

/** Size of one expiry step. Audit rows hold a few small fields, so a page
 * stays far below Convex's per-transaction read and write limits. Tests lower
 * it. */
export const AUDIT_EXPIRY = {
  /** Rows one step deletes at most. */
  page: 200,
}

const DAY_MS = 86_400_000

const expireArgs = {
  // rows with an earlier ts are deleted, an ISO timestamp fixed by the run's first step
  cutoff: v.optional(v.string()),
  // rows the run's earlier steps deleted
  deleted: v.optional(v.number()),
}
const expireRef = makeFunctionReference<'mutation', ObjectType<typeof expireArgs>, null>(
  'auditRetention:expire',
)

/** One step of the nightly audit log expiry. Empty arguments start a run.
 * Safe to run twice or beside another run, since a step only deletes rows
 * it read in the same transaction. */
export const expire = internalMutation({
  args: expireArgs,
  handler: async (ctx, a): Promise<null> => {
    const cutoff = a.cutoff ?? new Date(Date.now() - AUDIT_RETENTION_DAYS * DAY_MS).toISOString()
    const rows = await ctx.db
      .query('platform_audit_log')
      .withIndex('by_ts', (q) => q.lt('ts', cutoff))
      .take(AUDIT_EXPIRY.page)
    for (const row of rows) await ctx.db.delete(row._id)
    const deleted = (a.deleted ?? 0) + rows.length
    if (rows.length === AUDIT_EXPIRY.page) {
      await ctx.scheduler.runAfter(0, expireRef, { cutoff, deleted })
      return null
    }
    await ctx.db.insert('platform_audit_log', {
      ts: new Date().toISOString(),
      actor_email: 'system',
      action: 'expire_audit_log',
      detail: { deleted, before: cutoff },
    })
    return null
  },
})
