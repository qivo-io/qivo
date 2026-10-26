/* The caller's login, read without loading Better Auth. The adapter's own
 * safeGetAuthUser and getAuthUser, which Qivo's copy of it
 * (vendor/convex-better-auth) leaves out, ran through auth.ts's
 * authComponent, with its whole Better Auth closure and two nested calls
 * into the component's adapter, which loads it again in the component.
 * Functions that run often, such as
 * each call of a demo start (demo.ts ensureMine) and every app boot
 * (identity.ts claimMySeats), read the login here instead. This module
 * imports none of auth.ts, Better Auth or the adapter's client
 * (tests/authTriggers.test.ts holds it to that). */

import { ConvexError } from 'convex/values'
import { components } from '../_generated/api'
import type { QueryCtx } from '../_generated/server'

/** The caller's login while the session in its token is live: the session
 * exists, has not expired and belongs to the token's subject, and that
 * login exists. Null otherwise, also for a caller without a sign-in or a
 * session in its token. The adapter's safeGetAuthUser check, plus that the
 * session is the subject's, in one nested call (betterAuth/sessions.ts
 * liveSessionUser). Answers only the login's id, name, email and whether
 * it is verified and anonymous. MutationCtx satisfies this too. */
export async function liveAuthUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity || typeof identity.sessionId !== 'string') return null
  return ctx.runQuery(components.betterAuth.sessions.liveSessionUser, {
    sessionId: identity.sessionId,
    userId: identity.subject,
  })
}

/** liveAuthUser, or the adapter's getAuthUser error, 'Unauthenticated',
 * when the caller holds no live login. */
export async function requireLiveAuthUser(ctx: QueryCtx) {
  const user = await liveAuthUser(ctx)
  if (user === null) throw new ConvexError('Unauthenticated')
  return user
}
