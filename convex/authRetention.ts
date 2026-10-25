/* Deletes the sign-in rows Better Auth never deletes on its own: sessions
 * that have expired, OAuth access and refresh tokens that protect nothing
 * any more, and the hashes Qivo keeps of used refresh tokens once those
 * tokens could no longer be accepted. Without this a login keeps every
 * session it ever let expire, since Better Auth deletes one only when its
 * cookie is presented again, and every MCP token refresh adds an access
 * token, a refresh token and a hash for good.
 *
 * Each nightly cron (crons.ts) starts a run with empty arguments, which
 * fixes the run's cutoff. A step that deleted a full page schedules the
 * next. When the run deleted any, its last step writes one audit row with
 * the count, as the nightly jobs do (jobs.ts). Convex drops the calls a
 * failed step scheduled, so a failure ends the run, and the next night's
 * run deletes what is left.
 *
 * Sessions go through the Better Auth component's delete with the cleanup's
 * session delete trigger (authTriggers.ts onExpiredDelete), which runs in
 * the step's transaction for each session: it ends the OAuth access tokens
 * issued in the session before it expired and keeps the months the session
 * was used in (lib/sessionEnd.ts). Tokens go without a trigger, since
 * nothing else depends on them (betterAuth/oauth.ts deleteSpentTokens), and
 * so do the hashes (REPLAY_HASH_KEEP_MS).
 *
 * Cost, measured on a local backend: a step of 100 expired sessions took
 * about 0.9 seconds, and each deleted session schedules one call that keeps
 * its older months (usage.ts keepSignIn). A step of 1,000 token rows or
 * hashes reads and deletes only those rows. A night with nothing to delete
 * is one call for each job, reading one index entry for sessions and two
 * for tokens and hashes. At 10,000 organizations of about ten people,
 * assuming each person leaves about one session a week to expire and one in
 * five refreshes an MCP connection about ten times a day, a night deletes
 * about 14,000 sessions in 140 steps with 14,000 month calls, and about
 * 400,000 token rows and 200,000 hashes in 600 steps: about 15,000 function
 * calls a night, or 450,000 a month. The hashes then hold about 31 days of
 * refreshes, about 6 million rows, where they grew without end before. */

import { createFunctionHandle, makeFunctionReference } from 'convex/server'
import { type ObjectType, v } from 'convex/values'
import { components, internal } from './_generated/api'
import { internalMutation, type MutationCtx } from './_generated/server'
import { OAUTH_ACCESS_TOKEN_TTL_SECONDS, OAUTH_REFRESH_TOKEN_TTL_SECONDS } from './lib/oauth'

/** Step sizes. Tests lower them. */
export const AUTH_EXPIRY = {
  /** Sessions one step deletes at most. Each runs its delete trigger in the
   * step's transaction, about 7 ms on a local backend, so a step stays well
   * inside Convex's time limit for one transaction; a step that failed on
   * time would fail every night. */
  sessions: 100,
  /** OAuth token rows and refresh token hashes one step deletes at most,
   * far below Convex's read and write limits for one transaction. */
  tokens: 1000,
}

/** How long the hash of a used refresh token (oauth_credential_uses) is
 * kept after its use: as long as the token could still be accepted,
 * OAUTH_REFRESH_TOKEN_TTL_SECONDS from its issue, which came before its use,
 * plus a day. While it is kept, a replay of the token ends the whole grant
 * (oauthConnections.ts revokeReplay). Better Auth refuses a refresh token
 * that expired, and Qivo's adapter hides a used one (lib/oauthAdapter.ts),
 * so a replay after the nightly job deleted the hash is refused all the
 * same, but it no longer ends the grant. The job runs once a day, so a hash
 * lasts up to a day past this, and a client that refreshes at most once an
 * hour, as its access token runs out, keeps at most 32 × 24 = 768 hashes a
 * connection. A code's hash is kept for the connection's life, one an
 * authorization. */
export const REPLAY_HASH_KEEP_MS = (OAUTH_REFRESH_TOKEN_TTL_SECONDS + 86_400) * 1_000

const runArgs = {
  // rows that ran out before this time, in ms, are deleted, a time fixed by
  // the run's first step. A later value is ignored, so no call deletes a row
  // that has not run out.
  cutoff: v.optional(v.number()),
  // rows the run's earlier steps deleted
  deleted: v.optional(v.number()),
}
type RunArgs = ObjectType<typeof runArgs>
const expireSessionsRef = makeFunctionReference<'mutation', RunArgs, null>(
  'authRetention:expireSessions',
)
const expireTokensRef = makeFunctionReference<'mutation', RunArgs, null>(
  'authRetention:expireTokens',
)

/** The run's cutoff: the first step's time, never later than now. */
const cutoffOf = (a: RunArgs, now: number) =>
  a.cutoff !== undefined && a.cutoff < now ? a.cutoff : now

/** One step of the nightly expired-session cleanup. Empty arguments start a
 * run. Each step deletes up to AUTH_EXPIRY.sessions of the sessions that
 * expired before the cutoff, the earliest expiry first. Safe to run twice or
 * beside another run, since a step deletes only sessions it reads in the
 * same transaction. */
export const expireSessions = internalMutation({
  args: runArgs,
  handler: async (ctx, a): Promise<null> => {
    const cutoff = cutoffOf(a, Date.now())
    const result = (await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: {
        model: 'session',
        where: [{ field: 'expiresAt', operator: 'lt', value: cutoff }],
      },
      paginationOpts: { numItems: AUTH_EXPIRY.sessions, cursor: null },
      onDeleteHandle: await createFunctionHandle(internal.authTriggers.onExpiredDelete),
    })) as { count: number }
    const deleted = (a.deleted ?? 0) + result.count
    if (result.count === AUTH_EXPIRY.sessions) {
      await ctx.scheduler.runAfter(0, expireSessionsRef, { cutoff, deleted })
      return null
    }
    if (deleted > 0) await auditRun(ctx, 'expire_sessions', deleted, cutoff)
    return null
  },
})

/** One step of the nightly OAuth token cleanup. Empty arguments start a run.
 * Each step deletes up to AUTH_EXPIRY.tokens rows that protect nothing any
 * more: first access tokens and refresh tokens that expired before the
 * cutoff, and refresh tokens revoked an access token's lifetime before it
 * (betterAuth/oauth.ts deleteSpentTokens), then the hashes of refresh tokens
 * used REPLAY_HASH_KEEP_MS before it. The audit row counts both. Safe to run
 * twice or beside another run. */
export const expireTokens = internalMutation({
  args: runArgs,
  handler: async (ctx, a): Promise<null> => {
    const cutoff = cutoffOf(a, Date.now())
    let count: number = await ctx.runMutation(components.betterAuth.oauth.deleteSpentTokens, {
      expiredBefore: cutoff,
      revokedBefore: cutoff - OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1_000,
      numItems: AUTH_EXPIRY.tokens,
    })
    if (count < AUTH_EXPIRY.tokens) {
      const hashes = await ctx.db
        .query('oauth_credential_uses')
        .withIndex('by_used', (q) =>
          q
            .eq('kind', 'refresh_token')
            .lt('used_at', new Date(cutoff - REPLAY_HASH_KEEP_MS).toISOString()),
        )
        .take(AUTH_EXPIRY.tokens - count)
      for (const row of hashes) await ctx.db.delete(row._id)
      count += hashes.length
    }
    const deleted = (a.deleted ?? 0) + count
    if (count === AUTH_EXPIRY.tokens) {
      await ctx.scheduler.runAfter(0, expireTokensRef, { cutoff, deleted })
      return null
    }
    if (deleted > 0) await auditRun(ctx, 'expire_oauth_tokens', deleted, cutoff)
    return null
  },
})

/** The one audit row of a run that deleted rows. */
const auditRun = (
  ctx: MutationCtx,
  action: 'expire_sessions' | 'expire_oauth_tokens',
  deleted: number,
  cutoff: number,
) =>
  ctx.db.insert('platform_audit_log', {
    ts: new Date().toISOString(),
    actor_email: 'system',
    action,
    detail: { deleted, before: new Date(cutoff).toISOString() },
  })
