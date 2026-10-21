/* Team sync stamps (lib/teamSync.ts), one sync_stamps row per stamped
 * person. They live outside the profile document because every query a
 * person subscribes reads that person's own profiles (lib/functions.ts
 * loadMemberships), so a stamp patched onto a profile reran all of them.
 *
 * Profiles stamped before the table existed keep their stamp in the retired
 * profiles.sync_at and sync_since until internal/syncStampsBackfill moves it.
 * Until then a person without a row reads those fields. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { SyncStamp } from '../lib/teamSync'

/** The person's sync_stamps row, or null. */
export const stampRow = (ctx: QueryCtx, profileId: string) =>
  ctx.db
    .query('sync_stamps')
    .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
    .unique()

/** A stamp row's stamp, without a `since` it does not hold. */
const stampOfRow = (row: Doc<'sync_stamps'>): SyncStamp =>
  row.since === undefined ? { at: row.at } : { at: row.at, since: row.since }

/** The stamp the retired profile fields hold, or null. */
export const legacyStamp = (
  profile: Pick<Doc<'profiles'>, 'sync_at' | 'sync_since'>,
): SyncStamp | null =>
  profile.sync_at === undefined
    ? null
    : profile.sync_since === undefined
      ? { at: profile.sync_at }
      : { at: profile.sync_at, since: profile.sync_since }

/** The person's stamp: their row, else the retired profile fields. */
export async function stampOf(ctx: QueryCtx, profile: Doc<'profiles'>): Promise<SyncStamp | null> {
  const row = await stampRow(ctx, profile.id)
  return row === null ? legacyStamp(profile) : stampOfRow(row)
}

/** Every stamp row of the organization, by person. One index range. */
export async function stampsOfOrg(ctx: QueryCtx, orgId: string): Promise<Map<string, SyncStamp>> {
  const rows = await ctx.db
    .query('sync_stamps')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  return new Map(rows.map((row) => [row.profile_id, stampOfRow(row)]))
}

/** Stores `stamp` as the person's stamp, and never touches the profile. */
export async function writeStamp(
  ctx: MutationCtx,
  profile: Pick<Doc<'profiles'>, 'id' | 'org_id'>,
  stamp: SyncStamp,
): Promise<void> {
  const row = await stampRow(ctx, profile.id)
  // replace, so an absent `since` is stored absent
  const next = { org_id: profile.org_id, profile_id: profile.id, ...stamp }
  if (row === null) await ctx.db.insert('sync_stamps', next)
  else await ctx.db.replace(row._id, next)
}

/** Deletes the person's stamp row, if any. */
export async function deleteStamp(ctx: MutationCtx, profileId: string): Promise<void> {
  const row = await stampRow(ctx, profileId)
  if (row !== null) await ctx.db.delete(row._id)
}
