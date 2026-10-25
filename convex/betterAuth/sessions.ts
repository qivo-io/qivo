/* Session lookups for app functions that must not load Better Auth. A
 * nested call loads the imports of its module again, and adapter.ts loads
 * all of Better Auth through auth.ts's options, so this module imports
 * neither (see ../authTriggers.ts and ../lib/authUser.ts). Better Auth
 * upgrades re-check it against the release's session rules
 * (docs/better-auth-upgrade.md). */

import { v } from 'convex/values'
import { query } from './_generated/server'

/** The login of session `sessionId`, or null unless that session exists,
 * has not expired and belongs to `userId`, and that login exists. One call
 * proves what the adapter client's safeGetAuthUser proves with two
 * adapter.findOne calls, and also that the session is the login's. An
 * expiry that is not a number refuses, as the adapter's `gt` filter does. */
export const liveSessionUser = query({
  args: { sessionId: v.string(), userId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.string(),
      name: v.string(),
      email: v.string(),
      emailVerified: v.boolean(),
      isAnonymous: v.union(v.boolean(), v.null()),
    }),
  ),
  handler: async (ctx, { sessionId, userId }) => {
    const sessionKey = ctx.db.normalizeId('session', sessionId)
    const session = sessionKey ? await ctx.db.get(sessionKey) : null
    if (!session || !(session.expiresAt > Date.now()) || session.userId !== userId) return null
    const userKey = ctx.db.normalizeId('user', userId)
    const user = userKey ? await ctx.db.get(userKey) : null
    if (!user) return null
    return {
      _id: user._id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      isAnonymous: user.isAnonymous ?? null,
    }
  },
})
