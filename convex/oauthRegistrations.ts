/* OAuth client registration limits and cleanup. lib/oauthRegistration.ts
 * holds the limits and explains them. The Better Auth hook in
 * lib/oauthProvider.ts calls admit before the provider stores a client; the
 * crons run the two sweeps. */

import { v } from 'convex/values'
import { components, internal } from './_generated/api'
import { internalMutation, type QueryCtx } from './_generated/server'
import {
  OAUTH_REGISTRATION_SOURCE_PREFIX,
  OAUTH_REGISTRATION_TOTAL_KEY,
  OAUTH_REGISTRATION_WINDOW_MS,
  OAUTH_REGISTRATIONS_TOTAL,
  OAUTH_UNUSED_CLIENT_TTL_MS,
  registrationSourceCounters,
} from './lib/oauthRegistration'

/** Counts one client registration from `address` (null when the backend did
 * not report it) against its source counters and the deployment's counter,
 * each with an hourly limit. When any limit is full it writes nothing and
 * returns the seconds until the window ends. All counters move together, so
 * a refused registration uses no capacity and leaves no counter row behind.
 * It logs once when a counter reaches its limit, without the address, so an
 * operator sees that registrations are being refused. Throws when the
 * counters cannot be read; the caller then refuses the registration. */
export const admit = internalMutation({
  args: { address: v.union(v.string(), v.null()) },
  handler: async (ctx, { address }): Promise<{ admitted: boolean; retryAfter: number }> => {
    const secret = process.env.BETTER_AUTH_SECRET
    if (!secret) throw new Error('BETTER_AUTH_SECRET is not set')
    const now = Date.now()
    const windowStart =
      Math.floor(now / OAUTH_REGISTRATION_WINDOW_MS) * OAUTH_REGISTRATION_WINDOW_MS
    const counters = [
      ...(await registrationSourceCounters(address, secret)),
      { key: OAUTH_REGISTRATION_TOTAL_KEY, limit: OAUTH_REGISTRATIONS_TOTAL },
    ]
    const rows = await Promise.all(
      counters.map(({ key }) =>
        ctx.db
          .query('machine_rate_limits')
          .withIndex('by_key', (q) => q.eq('key', key))
          .unique(),
      ),
    )
    const counts = rows.map((row) => (row?.window_start === windowStart ? row.count : 0))
    if (counters.some(({ limit }, i) => counts[i] >= limit))
      return {
        admitted: false,
        retryAfter: Math.ceil((windowStart + OAUTH_REGISTRATION_WINDOW_MS - now) / 1000),
      }
    for (const [i, { key, limit }] of counters.entries()) {
      const row = rows[i]
      if (row) await ctx.db.patch(row._id, { window_start: windowStart, count: counts[i] + 1 })
      else await ctx.db.insert('machine_rate_limits', { key, window_start: windowStart, count: 1 })
      if (counts[i] + 1 === limit)
        console.warn(
          key === OAUTH_REGISTRATION_TOTAL_KEY
            ? `OAuth client registrations reached the deployment limit of ${limit} for this hour. New registrations are refused until the hour ends.`
            : `One source reached its OAuth client registration limit of ${limit} for this hour.`,
        )
    }
    return { admitted: true, retryAfter: 0 }
  },
})

const CLIENTS_PER_LEG = 100
// Client rows read per leg, in bytes. The leg reads each client again before
// it deletes it, so even with rows near the 1 MiB document limit it stays well
// below Convex's 16 MiB read limit.
const CLIENT_BYTES_PER_LEG = 2 * 1024 * 1024
const COUNTERS_PER_LEG = 500

/** Whether a Qivo connection keeps the client. A connection someone approved
 * keeps it, even after it was revoked, and so does an authorization that is
 * still pending. A pending authorization that expired does not, so opening
 * the consent page without approving keeps no client. */
async function clientConnected(ctx: QueryCtx, clientId: string): Promise<boolean> {
  const approved = await ctx.db
    .query('oauth_connections')
    .withIndex('by_client', (q) => q.eq('client_id', clientId).gt('approved_at', ''))
    .first()
  if (approved) return true
  const pending = await ctx.db
    .query('oauth_connections')
    .withIndex('by_client', (q) =>
      q
        .eq('client_id', clientId)
        .eq('approved_at', undefined)
        .gt('authorization_expires_at', new Date().toISOString()),
    )
    .first()
  return pending !== null
}

/** Deletes OAuth clients older than OAUTH_UNUSED_CLIENT_TTL_MS that no
 * consent, token, approved connection or pending authorization refers to, a
 * page per leg, oldest first. The daily cron starts it with no arguments;
 * each leg schedules the next. The component query, this check and the
 * delete run in one transaction. */
export const sweepClients = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<null> => {
    const before = Date.now() - OAUTH_UNUSED_CLIENT_TTL_MS
    const page: { clientIds: string[]; cursor: string | null } = await ctx.runQuery(
      components.betterAuth.oauth.unusedClients,
      {
        cursor: args.cursor ?? null,
        before,
        numItems: CLIENTS_PER_LEG,
        maximumBytesRead: CLIENT_BYTES_PER_LEG,
      },
    )
    const unused: string[] = []
    for (const clientId of page.clientIds)
      if (!(await clientConnected(ctx, clientId))) unused.push(clientId)
    if (unused.length > 0)
      await ctx.runMutation(components.betterAuth.oauth.deleteUnusedClients, {
        clientIds: unused,
        before,
      })
    if (page.cursor !== null)
      await ctx.scheduler.runAfter(0, internal.oauthRegistrations.sweepClients, {
        cursor: page.cursor,
      })
    return null
  },
})

/** Deletes per-source registration counters from earlier windows, which
 * admit no longer reads. The hourly cron starts it with no arguments; a leg
 * that read a full batch schedules the next after its last key. */
export const sweepCounters = internalMutation({
  args: { after: v.optional(v.string()) },
  handler: async (ctx, args): Promise<null> => {
    const windowStart =
      Math.floor(Date.now() / OAUTH_REGISTRATION_WINDOW_MS) * OAUTH_REGISTRATION_WINDOW_MS
    const rows = await ctx.db
      .query('machine_rate_limits')
      .withIndex('by_key', (q) =>
        q
          .gt('key', args.after ?? OAUTH_REGISTRATION_SOURCE_PREFIX)
          .lt('key', `${OAUTH_REGISTRATION_SOURCE_PREFIX}~`),
      )
      .take(COUNTERS_PER_LEG)
    for (const row of rows) if (row.window_start < windowStart) await ctx.db.delete(row._id)
    if (rows.length === COUNTERS_PER_LEG)
      await ctx.scheduler.runAfter(0, internal.oauthRegistrations.sweepCounters, {
        after: rows[rows.length - 1].key,
      })
    return null
  },
})
