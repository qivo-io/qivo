import { v } from 'convex/values'
import { stream } from 'convex-helpers/server/stream'
import type { Doc } from './_generated/dataModel'
import { type MutationCtx, mutation, type QueryCtx, query } from './_generated/server'
import schema from './schema'

/** Deletes a client and the resource links that name it. Better Auth's own
 * delete would remove the links with the client (they cascade); a direct
 * delete must remove them itself, or they outlive the client. A client has
 * one link for each resource, and Qivo has one resource. */
async function deleteClient(ctx: MutationCtx, client: Doc<'oauthClient'>) {
  const links = await ctx.db
    .query('oauthClientResource')
    .withIndex('clientId_resourceId', (q) => q.eq('clientId', client.clientId))
    .collect()
  for (const link of links) await ctx.db.delete(link._id)
  await ctx.db.delete(client._id)
}

/** Whether a consent or a token still refers to the client. */
async function clientInUse(ctx: QueryCtx, clientId: string): Promise<boolean> {
  const consent = await ctx.db
    .query('oauthConsent')
    .withIndex('clientId_userId', (q) => q.eq('clientId', clientId))
    .first()
  if (consent) return true
  const access = await ctx.db
    .query('oauthAccessToken')
    .withIndex('clientId', (q) => q.eq('clientId', clientId))
    .first()
  if (access) return true
  const refresh = await ctx.db
    .query('oauthRefreshToken')
    .withIndex('clientId', (q) => q.eq('clientId', clientId))
    .first()
  return refresh !== null
}

/** One page of the clients registered before `before`, oldest first, keeping
 * only those no consent or token refers to. A page ends after `numItems`
 * clients or after reading about `maximumBytesRead` bytes of client rows,
 * because rows registered before the metadata cap can each approach 1 MiB.
 * `cursor` holds the index key of the last client read, so clients that share
 * a creation time are not skipped; it is null when no older client is left.
 * Components cannot use the built-in `.paginate()`, so convex-helpers pages
 * the index. The app checks its own connections before it deletes any
 * (oauthRegistrations.ts sweepClients). */
export const unusedClients = query({
  args: {
    cursor: v.union(v.string(), v.null()),
    before: v.number(),
    numItems: v.number(),
    maximumBytesRead: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await stream(ctx.db, schema)
      .query('oauthClient')
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', args.before))
      .paginate({
        cursor: args.cursor,
        numItems: args.numItems,
        maximumBytesRead: args.maximumBytesRead,
      })
    const clientIds: string[] = []
    for (const client of page.page)
      if (!(await clientInUse(ctx, client.clientId))) clientIds.push(client.clientId)
    return { clientIds, cursor: page.isDone ? null : page.continueCursor }
  },
})

/** Deletes each named client that was registered before `before` and that no
 * consent or token refers to. Returns how many it deleted. */
export const deleteUnusedClients = mutation({
  args: { clientIds: v.array(v.string()), before: v.number() },
  handler: async (ctx, args) => {
    let deleted = 0
    for (const clientId of args.clientIds) {
      const client = await ctx.db
        .query('oauthClient')
        .withIndex('clientId', (q) => q.eq('clientId', clientId))
        .first()
      if (!client || client._creationTime >= args.before || (await clientInUse(ctx, clientId)))
        continue
      await deleteClient(ctx, client)
      deleted += 1
    }
    return deleted
  },
})

/** Deletes up to `numItems` of the clients with the given `clientId`, or
 * registered by the given `userId`, with their resource links. `isDone` says
 * whether none is left. For the app's own deletes, which Better Auth's
 * delete path does not run. */
export const deleteClients = mutation({
  args: {
    field: v.union(v.literal('clientId'), v.literal('userId')),
    value: v.string(),
    numItems: v.number(),
  },
  handler: async (ctx, { field, value, numItems }) => {
    const clients = await ctx.db
      .query('oauthClient')
      .withIndex(field, (q) => q.eq(field, value))
      .take(numItems + 1)
    const deleting = clients.slice(0, numItems)
    for (const client of deleting) await deleteClient(ctx, client)
    return { count: deleting.length, isDone: clients.length <= numItems }
  },
})

/** What the Better Auth 1.7 client backfill found on one page, or changed. */
type ClientBackfillCounts = {
  /** Clients that still held 1.6's `public` or `type`. */
  legacy: number
  /** Public clients whose tokenEndpointAuthMethod was not 'none'. */
  madePublic: number
  /** Clients without a link to the resource. */
  linked: number
  /** Extra links for a client and resource that already had one. */
  duplicates: number
  /** Clients a person must look at: a 1.6 'user-agent-based' type, which 1.7
   * has no application type for, or a confidential client whose method is
   * 'none'. The backfill leaves those two fields as they are. */
  review: number
}

/* One page of clients from `cursor`, for the backfill and its check, which
 * share it so both find the same rows. For each client it maps 1.6's `type`
 * to `applicationType` per Better Auth's upgrade guide, keeps
 * tokenEndpointAuthMethod 'none' for public clients only, removes `public`
 * and `type`, links the client to `resource` and drops duplicate links.
 * `write` null counts without writing. */
async function walkClients(
  ctx: QueryCtx,
  cursor: string | null,
  resource: string,
  write: MutationCtx | null,
) {
  const page = await stream(ctx.db, schema)
    .query('oauthClient')
    .withIndex('by_creation_time')
    .paginate({ cursor, numItems: 100, maximumBytesRead: 4 * 1024 * 1024 })
  const counts: ClientBackfillCounts = {
    legacy: 0,
    madePublic: 0,
    linked: 0,
    duplicates: 0,
    review: 0,
  }
  for (const client of page.page) {
    if (client.public != null || client.type != null) {
      counts.legacy += 1
      const patch: Partial<Doc<'oauthClient'>> = { public: undefined, type: undefined }
      if (client.type === 'web' || client.type === 'native') {
        patch.applicationType = client.applicationType ?? client.type
      } else if (client.type != null) counts.review += 1
      if (client.public === true && client.tokenEndpointAuthMethod !== 'none') {
        patch.tokenEndpointAuthMethod = 'none'
        counts.madePublic += 1
      } else if (client.public === false && client.tokenEndpointAuthMethod === 'none') {
        counts.review += 1
      }
      if (write) await write.db.patch(client._id, patch)
    }
    const links = await ctx.db
      .query('oauthClientResource')
      .withIndex('clientId_resourceId', (q) => q.eq('clientId', client.clientId))
      .collect()
    const seen = new Set<string>()
    for (const link of links) {
      if (!seen.has(link.resourceId)) {
        seen.add(link.resourceId)
        continue
      }
      counts.duplicates += 1
      if (write) await write.db.delete(link._id)
    }
    if (!seen.has(resource)) {
      counts.linked += 1
      if (write)
        await write.db.insert('oauthClientResource', {
          clientId: client.clientId,
          resourceId: resource,
          createdAt: Date.now(),
        })
    }
  }
  return { ...counts, cursor: page.isDone ? null : page.continueCursor }
}

const clientBackfillArgs = { cursor: v.union(v.string(), v.null()), resource: v.string() }

/** Counts, without writing, what the client backfill would change on one
 * page (internal/oauthClientBackfill.ts). `cursor` is null when no page is
 * left. */
export const clientBackfillCheck = query({
  args: clientBackfillArgs,
  handler: async (ctx, { cursor, resource }) => await walkClients(ctx, cursor, resource, null),
})

/** Backfills one page of clients for Better Auth 1.7 and counts what it
 * changed (internal/oauthClientBackfill.ts). */
export const clientBackfillPage = mutation({
  args: clientBackfillArgs,
  handler: async (ctx, { cursor, resource }) => await walkClients(ctx, cursor, resource, ctx),
})
