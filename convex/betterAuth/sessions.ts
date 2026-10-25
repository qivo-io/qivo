/* Session lookups for app functions that must not load Better Auth. A
 * nested call loads the imports of its module again, and adapter.ts loads
 * all of Better Auth through auth.ts's options, so this module imports
 * neither (see ../authTriggers.ts and ../lib/authUser.ts). */

import { v } from 'convex/values'
import { query } from './_generated/server'

/** The login of session `sessionId`, or null unless that session exists,
 * has not expired and belongs to `userId`, and that login exists. One call
 * proves what the adapter client's safeGetAuthUser proves with two
 * adapter.findOne calls, and also that the session is the login's. */
export const liveSessionUser = query({
  args: { sessionId: v.string(), userId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.string(),
      email: v.string(),
      isAnonymous: v.union(v.boolean(), v.null()),
    }),
  ),
  handler: async (ctx, { sessionId, userId }) => {
    const sessionKey = ctx.db.normalizeId('session', sessionId)
    const session = sessionKey ? await ctx.db.get(sessionKey) : null
    if (!session || session.expiresAt <= Date.now() || session.userId !== userId) return null
    const userKey = ctx.db.normalizeId('user', userId)
    const user = userKey ? await ctx.db.get(userKey) : null
    if (!user) return null
    return { _id: user._id, email: user.email, isAnonymous: user.isAnonymous ?? null }
  },
})
