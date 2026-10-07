/* Deployment-key-only cleanup for scripts/oauth-smoke.mjs. This is deliberately
 * limited to a uniquely named smoke client on an exact localhost deployment;
 * real connections retain their replay tombstones until profile removal. */
import { v } from 'convex/values'
import { components } from '../_generated/api'
import { internalMutation } from '../_generated/server'
import { require, rule } from '../lib/functions'

export const cleanup = internalMutation({
  args: {
    expected_site_url: v.string(),
    client_id: v.string(),
    client_name: v.string(),
  },
  handler: async (ctx, args) => {
    const url = new URL(args.expected_site_url)
    require(process.env.SITE_URL === args.expected_site_url &&
      args.expected_site_url.startsWith('http://') &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.origin === args.expected_site_url, rule(
      'OAuth smoke cleanup requires the exact localhost development deployment.',
    ))
    require(/^Qivo OAuth smoke [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      args.client_name,
    ), rule('OAuth smoke cleanup requires a uniquely named smoke client.'))
    const client = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'oauthClient',
      where: [{ field: 'clientId', value: args.client_id }],
    })
    require(client !== null && client.name === args.client_name, rule(
      'OAuth smoke client does not match.',
    ))
    const connections = await ctx.db
      .query('oauth_connections')
      .filter((q) => q.eq(q.field('client_id'), args.client_id))
      .collect()
    require(connections.every((row) => row.client_name === args.client_name), rule(
      'OAuth smoke connection ownership changed.',
    ))
    for (const row of connections) {
      const uses = await ctx.db
        .query('oauth_credential_uses')
        .withIndex('by_connection', (q) => q.eq('connection_id', row.id))
        .collect()
      for (const use of uses) await ctx.db.delete(use._id)
      await ctx.db.delete(row._id)
    }
    for (const model of [
      'oauthAccessToken',
      'oauthRefreshToken',
      'oauthConsent',
      'oauthClient',
    ] as const) {
      let cursor: string | null = null
      for (;;) {
        const result: { isDone: boolean; continueCursor: string } = await ctx.runMutation(
          components.betterAuth.adapter.deleteMany,
          {
            input: { model, where: [{ field: 'clientId', value: args.client_id }] },
            paginationOpts: { numItems: 100, cursor },
          },
        )
        if (result.isDone) break
        cursor = result.continueCursor
      }
    }
    return true
  },
})
