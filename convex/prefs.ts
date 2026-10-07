/* user_prefs (phase 5): one opaque view-state blob per profile (0036).
 *
 * Strictly self-service, and deliberately OUTSIDE the snapshot: prefs are
 * written on every roadmap pan, and echoing those self-writes back through
 * a reactive query would be pure churn for data nobody else can see. The
 * client boots with ONE `get`, never subscribes, and keeps its 600 ms
 * debounce + flush + warn-only failure handling.
 *
 * The blob is NOT validated beyond being a Convex value — the server never
 * reads prefs (0036's rule); `save` stamps updated_at. */

import { v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { authedMutation, authedQuery, notFound } from './lib/functions'

/* The is_my_profile successor: the subject must be one of the caller's own
 * (active) seats; anything else reads a uniform not-found. */
const isMine = (myProfiles: Map<string, Doc<'profiles'>>, profileId: string): boolean => {
  for (const p of myProfiles.values()) if (p.id === profileId) return true
  return false
}

/* One-shot boot read. With no explicit profile, choose the home seat exactly
 * as snapshot adoption does. Boot can request these alongside the snapshot
 * without waiting for its roster; explicit reads retain the own-seat fence. */
export const get = authedQuery({
  args: { profile_id: v.optional(v.string()) },
  handler: async (ctx, { profile_id }) => {
    const mine = [...ctx.myProfiles.values()]
    const profileId =
      profile_id ?? (mine.find((profile) => profile.org_role !== 'guest') || mine[0])?.id
    if (profileId === undefined) return null
    if (!isMine(ctx.myProfiles, profileId)) throw notFound('profile not found')
    const row = await ctx.db
      .query('user_prefs')
      .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
      .unique()
    if (row === null) return null
    const { _id, _creationTime, ...pub } = row
    return pub
  },
})

/* P.saveUI's debounced write — upsert by profile. Warn-only on the client;
 * a refusal here is never toasted. */
export const save = authedMutation({
  args: { profile_id: v.string(), prefs: v.any() },
  handler: async (ctx, { profile_id, prefs }) => {
    const now = new Date().toISOString()
    if (!isMine(ctx.myProfiles, profile_id)) throw notFound('profile not found')
    const row = await ctx.db
      .query('user_prefs')
      .withIndex('by_profile', (q) => q.eq('profile_id', profile_id))
      .unique()
    if (row === null) await ctx.db.insert('user_prefs', { profile_id, prefs, updated_at: now })
    else await ctx.db.patch(row._id, { prefs, updated_at: now })
    return null
  },
})
