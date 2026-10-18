/* OAuth client registration limits and cleanup. lib/oauthRegistration.ts
 * holds the limits and explains them. The Better Auth hook in
 * lib/oauthProvider.ts calls admit before the provider stores a client; the
 * crons run the two sweeps. */

import { v } from 'convex/values'
import { components, internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import {
  OAUTH_REGISTRATION_SOURCE_PREFIX,
  OAUTH_REGISTRATION_TOTAL_KEY,
  OAUTH_REGISTRATION_WINDOW_MS,
  OAUTH_REGISTRATIONS_PER_SOURCE,
  OAUTH_REGISTRATIONS_TOTAL,
  OAUTH_UNUSED_CLIENT_TTL_MS,
  registrationSourceKey,
} from './lib/oauthRegistration'

/** Counts one client registration from `address` (null when the backend did
 * not report it) against the source's and the deployment's hourly limits.
 * When either limit is full it writes nothing and returns the seconds until
 * the window ends. Both counters move together, so a refused registration
 * uses no capacity and leaves no counter row behind. Throws when the
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
      { key: await registrationSourceKey(address, secret), limit: OAUTH_REGISTRATIONS_PER_SOURCE },
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
    for (const [i, { key }] of counters.entries()) {
      const row = rows[i]
      if (row) await ctx.db.patch(row._id, { window_start: windowStart, count: counts[i] + 1 })
      else await ctx.db.insert('machine_rate_limits', { key, window_start: windowStart, count: 1 })
    }
    return { admitted: true, retryAfter: 0 }
  },
})

const CLIENTS_PER_LEG = 100
const COUNTERS_PER_LEG = 500

/** Deletes OAuth clients older than OAUTH_UNUSED_CLIENT_TTL_MS that no
 * consent, token or Qivo connection refers to, a page per leg, oldest first.
 * The daily cron starts it with no arguments; each leg schedules the next.
 * Connections count even when revoked, so a client someone approved stays.
 * The component query, this check and the delete run in one transaction. */
export const sweepClients = internalMutation({
  args: { after: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    const before = Date.now() - OAUTH_UNUSED_CLIENT_TTL_MS
    const page: { clientIds: string[]; last: number | null } = await ctx.runQuery(
      components.betterAuth.oauth.unusedClients,
      { after: args.after ?? 0, before, numItems: CLIENTS_PER_LEG },
    )
    const unused: string[] = []
    for (const clientId of page.clientIds) {
      const connection = await ctx.db
        .query('oauth_connections')
        .withIndex('by_client', (q) => q.eq('client_id', clientId))
        .first()
      if (!connection) unused.push(clientId)
    }
    if (unused.length > 0)
      await ctx.runMutation(components.betterAuth.oauth.deleteUnusedClients, {
        clientIds: unused,
        before,
      })
    if (page.last !== null)
      await ctx.scheduler.runAfter(0, internal.oauthRegistrations.sweepClients, {
        after: page.last,
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
