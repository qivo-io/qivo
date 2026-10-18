import { v } from 'convex/values'
import { mutation, type QueryCtx, query } from './_generated/server'

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

/** Up to `numItems` clients registered after `after` and before `before`,
 * oldest first, keeping only those no consent or token refers to. `last` is
 * the creation time to pass as the next `after`, or null when no older
 * client is left. Components cannot paginate, so the creation time is the
 * cursor. The app checks its own connections before it deletes any
 * (oauthRegistrations.ts sweepClients). */
export const unusedClients = query({
  args: { after: v.number(), before: v.number(), numItems: v.number() },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('oauthClient')
      .withIndex('by_creation_time', (q) =>
        q.gt('_creationTime', args.after).lt('_creationTime', args.before),
      )
      .take(args.numItems)
    const clientIds: string[] = []
    for (const client of page)
      if (!(await clientInUse(ctx, client.clientId))) clientIds.push(client.clientId)
    const last = page.length === args.numItems ? page[page.length - 1]._creationTime : null
    return { clientIds, last }
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
