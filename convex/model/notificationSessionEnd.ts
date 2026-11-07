/* The notification row of a Better Auth session that is being deleted
 * (schema.ts notification_sessions). The session delete trigger calls it
 * (lib/sessionEnd.ts endSession) once for each session, up to 200 in one
 * transaction for a ban, and a nested call loads its module's imports
 * again (authTriggers.ts), so this module imports nothing at run time
 * (tests/authTriggers.test.ts holds lib/sessionEnd.ts's closure to that). */

import type { MutationCtx } from '../_generated/server'

/** Deletes the notification row of Better Auth session `sessionId`, if it
 * has one, with one index read and at most one delete. notifications.ts beat
 * keeps at most one row a session. The session's delivery records are left
 * to expire (notifications.ts expire), so a ban costs one small delete a
 * session, whatever it claimed. */
export async function forgetSession(ctx: MutationCtx, sessionId: string): Promise<void> {
  const row = await ctx.db
    .query('notification_sessions')
    .withIndex('by_session', (q) => q.eq('session_id', sessionId))
    .first()
  if (row !== null) await ctx.db.delete(row._id)
}
