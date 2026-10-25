/* The months a login was signed in, kept as usage_sign_ins rows as Better
 * Auth deletes its sessions, so the monthly usage figures and Qivo Admin's
 * last sign-in still count a session that ended (model/usage.ts keptSignIn
 * and keptSignInAt). The session delete triggers load this module, so it
 * imports nothing heavy (authTriggers.ts). */

import type { MutationCtx } from '../_generated/server'
import { isDemoDeployment } from './demo'
import { monthRange, monthsBetween, previousMonth, retentionCutoff } from './usage'

/** Keeps the months a sign-in session of login `authUserId` was used in,
 * from its creation to its last refresh, as Better Auth deletes it, and
 * when it signed in on the row of that month (model/usage.ts keptSignInAt).
 * Months older than retention keeps are left out, so a session holds at
 * most about 27, and with `recent` all but the current month and the one
 * before (keepRecentSignIns). Nothing is kept on the demo deployment. */
export async function keepSignIns(
  ctx: MutationCtx,
  authUserId: string,
  session: { createdAt: number; updatedAt: number },
  now: number,
  recent = false,
): Promise<void> {
  if (isDemoDeployment()) return
  const kept = monthRange(retentionCutoff(now))?.start ?? now
  const oldest = recent ? Math.max(kept, monthRange(previousMonth(now))?.start ?? now) : kept
  const months = monthsBetween(
    Math.max(session.createdAt, oldest),
    Math.min(session.updatedAt, now),
  )
  // the first month is the sign-in's own unless the bound cut it off
  const signedIn = session.createdAt >= oldest ? months[0] : undefined
  for (const month of months) {
    const row = await ctx.db
      .query('usage_sign_ins')
      .withIndex('by_user_month', (q) => q.eq('auth_user_id', authUserId).eq('month', month))
      .first()
    const at = month === signedIn ? session.createdAt : undefined
    if (row === null)
      await ctx.db.insert('usage_sign_ins', {
        auth_user_id: authUserId,
        month,
        ...(at === undefined ? {} : { signed_in_at: at }),
      })
    else if (at !== undefined && !((row.signed_in_at ?? 0) >= at))
      await ctx.db.patch(row._id, { signed_in_at: at })
  }
}

/** Keeps a deleted session's months that a usage run may be reading as it
 * goes, the current month and the one before, at most two reads and two
 * writes, in the transaction that deletes the session (lib/sessionEnd.ts).
 * The monthly run closes the month before, and Qivo Admin computes the
 * current one, so neither finds the session gone and its months not yet
 * kept. The rest wait for usage.ts keepSignIn. A session whose times are
 * not times keeps nothing here, so its end does not fail on them. */
export async function keepRecentSignIns(
  ctx: MutationCtx,
  authUserId: string,
  session: { createdAt: number; updatedAt: number },
  now: number,
): Promise<void> {
  if (!Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt)) return
  await keepSignIns(ctx, authUserId, session, now, true)
}
