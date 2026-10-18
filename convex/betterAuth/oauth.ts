import { v } from 'convex/values'
import { stream } from 'convex-helpers/server/stream'
import { mutation, type QueryCtx, query } from './_generated/server'
import schema from './schema'

const guardField = v.union(
  v.literal('id'),
  v.literal('token'),
  v.literal('clientId'),
  v.literal('userId'),
  v.literal('referenceId'),
  v.literal('sessionId'),
  v.literal('revoked'),
)

// Provider rotation requires revoked == null; the Convex adapter stores a
// never-revoked optional value as absent. This one atomic compare-and-set
// preserves every original equality predicate while matching that absence.
export const claimRefreshToken = mutation({
  args: {
    where: v.array(v.object({ field: guardField, value: v.union(v.string(), v.null()) })),
    revokedAt: v.number(),
  },
  handler: async (ctx, { where, revokedAt }) => {
    if (
      !Number.isFinite(revokedAt) ||
      where.filter((guard) => guard.field === 'id').length !== 1 ||
      where.filter((guard) => guard.field === 'revoked' && guard.value === null).length !== 1
    )
      return null
    const rawId = where.find((guard) => guard.field === 'id')?.value
    if (typeof rawId !== 'string') return null
    const id = ctx.db.normalizeId('oauthRefreshToken', rawId)
    if (!id) return null
    const row = await ctx.db.get(id)
    if (!row) return null
    for (const guard of where) {
      const actual = guard.field === 'id' ? row._id : row[guard.field]
      if (guard.field === 'revoked' && guard.value === null) {
        if (actual !== undefined && actual !== null) return null
      } else if (actual !== guard.value) return null
    }
    await ctx.db.patch(row._id, { revoked: revokedAt })
    const { _id, _creationTime: _, ...fields } = row
    return { ...fields, id: _id, revoked: revokedAt }
  },
})

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
      await ctx.db.delete(client._id)
      deleted += 1
    }
    return deleted
  },
})
