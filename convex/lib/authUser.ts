/* The caller's login, read without loading Better Auth. authComponent's
 * safeGetAuthUser (auth.ts) needs that module and its whole Better Auth
 * closure, and two nested calls into the component's adapter, which loads
 * it again in the component. A function that runs many times, such as each
 * call of a demo start (demo.ts ensureMine), reads the login here instead.
 * This module imports none of auth.ts, Better Auth or the adapter's client
 * (tests/authTriggers.test.ts holds it to that). */

import { components } from '../_generated/api'
import type { QueryCtx } from '../_generated/server'

/** The caller's login while the session in its token is live: the session
 * exists, has not expired and belongs to the token's subject, and that
 * login exists. Null otherwise, also for a caller without a sign-in. The
 * same check as safeGetAuthUser, in one nested call (betterAuth/sessions.ts
 * liveSessionUser). MutationCtx satisfies this too. */
export async function liveAuthUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity || typeof identity.sessionId !== 'string') return null
  return ctx.runQuery(components.betterAuth.sessions.liveSessionUser, {
    sessionId: identity.sessionId,
    userId: identity.subject,
  })
}
