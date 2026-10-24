/* One-time migration of the OAuth clients registered on Better Auth 1.6 to
 * the 1.7 client model (betterAuth/oauth.ts walkClients). For every client
 * it maps 1.6's `type` to `applicationType`, keeps tokenEndpointAuthMethod
 * 'none' for public clients only, removes `public` and `type`, which 1.7
 * dropped, links the client to the MCP resource and drops duplicate links,
 * as Better Auth's upgrade guide ("Migrate OAuth client records") says.
 *
 * Until it runs, clients keep working: betterAuth/schema.ts still accepts
 * `public` and `type`, the provider reads neither, and lib/oauthProvider.ts
 * does not require a client's resource link. Once it has run on every
 * deployment, a later change removes the two fields from the schema and
 * this file.
 *
 * Check a deployment before changing it. `remaining` is a query, so it
 * cannot write, and a key that may only run internal queries can run it. It
 * counts what one page of clients would change. Start with
 * `{"cursor": null}` and pass the returned `cursor` back until it is null.
 * With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/oauthClientBackfill:remaining '{"cursor": null}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup first
 * (docs/deployment.md). Read the dry run, which writes nothing, then run it
 * and check again:
 *   "$H" staging npx convex run internal/oauthClientBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/oauthClientBackfill:run '{"dry_run": false}'
 *
 * A `review` count names clients a person must look at, which the run
 * leaves as they are: a 1.6 'user-agent-based' client, or a confidential
 * client whose method is 'none'. Qivo registers neither. The demo runs no
 * OAuth provider and has no clients to migrate.
 *
 * A run that writes adds one platform_audit_log row (action
 * 'oauth_client_backfill', actor 'system') with its counts. The results hold
 * counts only. Running it again is safe, and a migrated deployment reports
 * zeros. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { components } from '../_generated/api'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { mcpResource } from '../lib/oauth'

/** What the backfill found, or changed (betterAuth/oauth.ts ClientBackfillCounts). */
type Counts = {
  legacy: number
  madePublic: number
  linked: number
  duplicates: number
  review: number
}

const auditRef = makeFunctionReference<'mutation', Counts, null>(
  'internal/oauthClientBackfill:audit',
)

/** Counts, without writing, what the backfill would change on one page of
 * clients. Pass the returned `cursor` back until it is null. */
export const remaining = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) =>
    await ctx.runQuery(components.betterAuth.oauth.clientBackfillCheck, {
      cursor,
      resource: mcpResource(),
    }),
})

/** Records a run that wrote, with its counts. */
export const audit = internalMutation({
  args: {
    legacy: v.number(),
    madePublic: v.number(),
    linked: v.number(),
    duplicates: v.number(),
    review: v.number(),
  },
  handler: async (ctx, counts) => {
    await ctx.db.insert('platform_audit_log', {
      ts: new Date().toISOString(),
      actor_email: 'system',
      action: 'oauth_client_backfill',
      detail: counts,
    })
    return null
  },
})

/** Walks every client and reports what it changed, or would change with
 * `dry_run`. Each page is its own transaction. A run that writes ends with
 * its audit row. */
export const run = internalAction({
  args: { dry_run: v.boolean() },
  handler: async (ctx, { dry_run }): Promise<Counts & { dry_run: boolean }> => {
    const counts: Counts = { legacy: 0, madePublic: 0, linked: 0, duplicates: 0, review: 0 }
    const resource = mcpResource()
    let cursor: string | null = null
    do {
      const page: Counts & { cursor: string | null } = dry_run
        ? await ctx.runQuery(components.betterAuth.oauth.clientBackfillCheck, { cursor, resource })
        : await ctx.runMutation(components.betterAuth.oauth.clientBackfillPage, {
            cursor,
            resource,
          })
      for (const key of Object.keys(counts) as (keyof Counts)[]) counts[key] += page[key]
      cursor = page.cursor
    } while (cursor !== null)
    if (!dry_run) await ctx.runMutation(auditRef, counts)
    return { dry_run, ...counts }
  },
})
