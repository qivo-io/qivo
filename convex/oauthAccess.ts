/* The check that every MCP and REST call made with an OAuth access token
 * runs (machine/mcp.ts, machine/rest.ts), up to three times on one MCP
 * call. A nested call loads every import of its module again, so this
 * module imports none of auth.ts, Better Auth or the adapter's client, and
 * reads Better Auth's rows through queries that load none either
 * (betterAuth/lookups.ts). oauthConnections.ts keeps the consent screen,
 * which calls Better Auth's API, and the functions of token issuance.
 * tests/authTriggers.test.ts holds this module to that. */

import { v } from 'convex/values'
import { components } from './_generated/api'
import type { QueryCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { credentialAccess, findAuthUser, loginBanned, oauthClientLive } from './lib/access'
import { deletionBegun, removedWithOrg } from './lib/billingAccess'
import { byId } from './lib/db'
import { isDemoDeployment } from './lib/demo'

/* The live grant behind an OAuth access token, or why there is none, with
 * `deleting` true when nothing but its organization's running deletion
 * stops it.
 * A revoked token counts as gone, and so does one issued in a browser
 * session before the session ended, such as at sign-out
 * (lib/sessionEnd.ts endSessionAccess). So does a token bound to a DPoP
 * key, whose proof Qivo cannot check (lib/oauthProvider.ts never issues
 * one), and one whose client was disabled or lost its link to the resource
 * (lib/access.ts oauthClientLive). */
async function grantFor(ctx: QueryCtx, tokenHash: string, resource: string) {
  const refused = { deleting: false }
  if (isDemoDeployment()) return refused
  const token = await ctx.runQuery(components.betterAuth.lookups.accessToken, {
    token: tokenHash,
  })
  if (
    !token?.referenceId ||
    token.revoked != null ||
    token.confirmation != null ||
    typeof token.expiresAt !== 'number' ||
    !Number.isFinite(token.expiresAt) ||
    token.expiresAt <= Date.now()
  )
    return refused
  const { sessionId } = token
  if (sessionId) {
    const ended = await ctx.db
      .query('oauth_ended_sessions')
      .withIndex('by_session', (q) => q.eq('session_id', sessionId))
      .first()
    // only a token issued after the end, such as by a refresh, may pass
    if (ended && !(token._creationTime > ended.ended_at)) return refused
  }
  const row = await byId(ctx, 'oauth_connections', token.referenceId)
  if (row === null) {
    // a grant the deletion deleted (removed_access), whose client and login
    // would still let the token through
    if (!(await removedWithOrg(ctx, 'oauth_connections', token.referenceId))) return refused
    if (!(await oauthClientLive(ctx, token.clientId, resource))) return refused
    const user = token.userId == null ? null : await findAuthUser(ctx, token.userId)
    return { deleting: user !== null && !loginBanned(user, Date.now()) }
  }
  if (
    !row.approved_at ||
    row.revoked_at ||
    row.resource !== resource ||
    token.userId !== row.auth_user_id ||
    token.clientId !== row.client_id ||
    token.scopes.some((scope) => !row.scopes.includes(scope))
  )
    return refused
  if (!(await oauthClientLive(ctx, row.client_id, resource))) return refused
  const user = await findAuthUser(ctx, row.auth_user_id)
  const profile = await byId(ctx, 'profiles', row.profile_id)
  if (
    !user ||
    loginBanned(user, Date.now()) ||
    !profile ||
    profile.kind !== 'person' ||
    profile.auth_user_id !== row.auth_user_id ||
    profile.org_id !== row.org_id
  )
    return refused
  // an inactive member's grant, which a running deletion stops first
  if (!profile.active) return { deleting: await deletionBegun(ctx, row.org_id) }
  return {
    connectionId: row.id,
    connectionRowId: row._id,
    profileId: row.profile_id,
    scopes: token.scopes,
    access: credentialAccess({ table: 'oauth_connections', scopes: token.scopes }, profile),
  }
}

/* The live grant behind an OAuth access token, or null (grantFor). `access`
 * is what the token's own scopes allow (lib/access.ts credentialAccess). */
export const lookupAccess = internalQuery({
  args: { tokenHash: v.string(), resource: v.string() },
  handler: async (ctx, args) => {
    const grant = await grantFor(ctx, args.tokenHash, args.resource)
    return 'deleting' in grant ? null : grant
  },
})

/** Whether an access token that lookupAccess refused, or whose grant was
 * gone by the time the call stamped it (touch), stopped only because its
 * organization's deletion has begun, which deleted its grant
 * (removed_access) or stops a member no longer active there first. MCP
 * and REST then refuse it with the deletion's sentence
 * (lib/billingAccess.ts ORG_DELETING), as every call into the
 * organization. Only a refused token pays for this check. */
export const refusedForDeletion = internalQuery({
  args: { tokenHash: v.string(), resource: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const grant = await grantFor(ctx, args.tokenHash, args.resource)
    return 'deleting' in grant && grant.deleting
  },
})

/** Stamps a connection's last use, or answers false when it is gone or
 * revoked, which the call then refuses. */
export const touch = internalMutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const row = await byId(ctx, 'oauth_connections', id)
    if (!row || row.revoked_at) return false
    await ctx.db.patch(row._id, { last_used_at: new Date().toISOString() })
    return true
  },
})
