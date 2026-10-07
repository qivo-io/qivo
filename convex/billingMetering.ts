import { v } from 'convex/values'
import { internalMutation } from './_generated/server'
import { byId } from './lib/db'
import { consumeMachineRequest, MACHINE_INGRESS_LIMIT, recordApiCall } from './model/billingUsage'

/** Shared before-auth fence for REST and MCP. No key/IP material is retained. */
export const ingress = internalMutation({
  args: {},
  handler: (ctx): Promise<boolean> => consumeMachineRequest(ctx, 'ingress', MACHINE_INGRESS_LIMIT),
})

/** OAuth grants have their own credential table but share the person's usage
 * allowance and rate limit with personal MCP tokens. The caller already
 * verified the OAuth bearer; read the connection again for current ownership. */
export const oauthCall = internalMutation({
  args: { connection_id: v.string() },
  handler: async (ctx, { connection_id }): Promise<boolean> => {
    const row = await byId(ctx, 'oauth_connections', connection_id)
    if (!row || row.revoked_at !== undefined) return true
    const profile = await byId(ctx, 'profiles', row.profile_id)
    if (
      !profile?.active ||
      profile.auth_user_id !== row.auth_user_id ||
      profile.org_id !== row.org_id
    )
      return true
    return await recordApiCall(ctx, {
      profile_id: profile.id,
      credential_id: `oauth_connections:${row.id}`,
      credential_name: row.client_name,
    })
  },
})
