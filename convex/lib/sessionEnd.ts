/* What Qivo does as Better Auth deletes a sign-in session, for the session
 * delete triggers (authTriggers.ts). They run once for each session, in the
 * transaction that deletes it, so this module imports none of Better Auth
 * (see authTriggers.ts). */

import { makeFunctionReference } from 'convex/server'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { isDemoDeployment } from './demo'
import { OAUTH_ACCESS_TOKEN_TTL_SECONDS } from './oauth'
import { keepRecentSignIns } from './signIns'

const forgetEndedSessionRef = makeFunctionReference<
  'mutation',
  { id: Id<'oauth_ended_sessions'> },
  null
>('oauthConnections:forgetEndedSession')
const keepSignInRef = makeFunctionReference<
  'mutation',
  { auth_user_id: string; created_at: number; updated_at: number },
  null
>('usage:keepSignIn')

/** The fields of a stored session the triggers read. */
export type EndedSession = {
  _id: string
  userId: string
  createdAt: number
  updatedAt: number
  expiresAt: number
}

/** Ends a session that Better Auth deletes, as of `endedAt`: it ends the
 * OAuth access tokens issued in the session before then (endSessionAccess)
 * and keeps the months the session was used in and when it signed in, for
 * the usage figures and Qivo Admin. Ending the tokens must hold as the
 * session goes, so it runs in the deleting transaction, and so does keeping
 * the two months a usage run may be reading meanwhile (keepRecentSignIns).
 * Older months can wait, so they are kept in a call of their own (usage.ts
 * keepSignIn), which also reads the login and forgets the months of one
 * already deleted. The demo has neither. */
export async function endSession(ctx: MutationCtx, session: EndedSession, endedAt: number) {
  if (isDemoDeployment()) return
  await endSessionAccess(ctx, session._id, endedAt)
  await keepRecentSignIns(ctx, session.userId, session, Date.now())
  await ctx.scheduler.runAfter(0, keepSignInRef, {
    auth_user_id: session.userId,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  })
}

/** Ends the access tokens issued in browser session `sessionId` before
 * `endedAt`, such as at sign-out, a ban or the nightly cleanup of expired
 * sessions. It writes one record for the session, however many tokens the
 * session holds, and /mcp refuses every token issued before it
 * (oauthAccess.ts lookupAccess). The record goes once those tokens have
 * expired, so an end longer ago than an access token lasts writes nothing.
 * The session's refresh tokens, which `offline_access` keeps, stay, and an
 * access token they issue later works. */
async function endSessionAccess(ctx: MutationCtx, sessionId: string, endedAt: number) {
  if (endedAt + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1_000 <= Date.now()) return
  const id = await ctx.db.insert('oauth_ended_sessions', {
    session_id: sessionId,
    ended_at: endedAt,
  })
  await ctx.scheduler.runAt(
    endedAt + (OAUTH_ACCESS_TOKEN_TTL_SECONDS + 60) * 1_000,
    forgetEndedSessionRef,
    { id },
  )
}
