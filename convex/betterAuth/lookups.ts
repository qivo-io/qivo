/* Better Auth rows that every REST and MCP call reads: the caller's login,
 * for its ban (lib/access.ts findAuthUser), and for an OAuth access token,
 * the token (oauthAccess.ts grantFor) and its client and the client's link
 * to the resource (lib/access.ts oauthClientLive). The adapter's findOne
 * (adapter.ts) loads all of Better Auth through auth.ts's options on every
 * call, so this module, like sessions.ts, imports neither. Each query reads
 * the row findOne reads for the same where clause, through the same index,
 * and answers only the fields its caller uses. Better Auth upgrades re-check
 * them against the release's tables (docs/better-auth-upgrade.md). */

import { v } from 'convex/values'
import { query } from './_generated/server'
import { tables } from './schema'

const user = tables.user.validator.fields
const client = tables.oauthClient.validator.fields
const token = tables.oauthAccessToken.validator.fields

/** The ban columns of login `userId`, or null when no login has that id.
 * A string that is no login id answers null too. */
export const userBan = query({
  args: { userId: v.string() },
  returns: v.union(v.null(), v.object({ banned: user.banned, banExpires: user.banExpires })),
  handler: async (ctx, { userId }) => {
    const key = ctx.db.normalizeId('user', userId)
    const row = key ? await ctx.db.get(key) : null
    return row && { banned: row.banned, banExpires: row.banExpires }
  },
})

/** Whether OAuth client `clientId` is disabled, or null when Better Auth no
 * longer has the client. */
export const oauthClient = query({
  args: { clientId: v.string() },
  returns: v.union(v.null(), v.object({ disabled: client.disabled })),
  handler: async (ctx, { clientId }) => {
    const row = await ctx.db
      .query('oauthClient')
      .withIndex('clientId', (q) => q.eq('clientId', clientId))
      .unique()
    return row && { disabled: row.disabled }
  },
})

/** Whether OAuth client `clientId` keeps its link to resource `resourceId`. */
export const clientLinked = query({
  args: { clientId: v.string(), resourceId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { clientId, resourceId }) =>
    (await ctx.db
      .query('oauthClientResource')
      .withIndex('clientId_resourceId', (q) =>
        q.eq('clientId', clientId).eq('resourceId', resourceId),
      )
      .first()) !== null,
})

/** The OAuth access token whose stored hash is `token`, or null. */
export const accessToken = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      _creationTime: v.number(),
      clientId: token.clientId,
      sessionId: token.sessionId,
      userId: token.userId,
      referenceId: token.referenceId,
      expiresAt: token.expiresAt,
      revoked: token.revoked,
      confirmation: token.confirmation,
      scopes: token.scopes,
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('oauthAccessToken')
      .withIndex('token', (q) => q.eq('token', args.token))
      .unique()
    return (
      row && {
        _creationTime: row._creationTime,
        clientId: row.clientId,
        sessionId: row.sessionId,
        userId: row.userId,
        referenceId: row.referenceId,
        expiresAt: row.expiresAt,
        revoked: row.revoked,
        confirmation: row.confirmation,
        scopes: row.scopes,
      }
    )
  },
})
