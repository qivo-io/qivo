import { v } from 'convex/values'
import { mutation } from './_generated/server'

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
