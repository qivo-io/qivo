/* Team sync stamps (lib/teamSync.ts), one sync_stamps row per stamped
 * person. They live outside the profile document because every query a
 * person subscribes reads that person's own profiles (lib/functions.ts
 * loadMemberships), so a stamp patched onto a profile reran all of them. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { uncountedWriter } from '../lib/demo'
import type { SyncStamp } from '../lib/teamSync'

/** The person's sync_stamps row, or null. */
export const stampRow = (ctx: QueryCtx, profileId: string) =>
  ctx.db
    .query('sync_stamps')
    .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
    .unique()

/** A stamp row's stamp, without a `since` it does not hold. */
export const stampOfRow = (row: Doc<'sync_stamps'>): SyncStamp =>
  row.since === undefined ? { at: row.at } : { at: row.at, since: row.since }

/** The person's stamp, or null. */
export async function stampOf(ctx: QueryCtx, profileId: string): Promise<SyncStamp | null> {
  const row = await stampRow(ctx, profileId)
  return row === null ? null : stampOfRow(row)
}

/** Every stamp row of the organization, by person. One index range. */
export async function stampsOfOrg(ctx: QueryCtx, orgId: string): Promise<Map<string, SyncStamp>> {
  const rows = await ctx.db
    .query('sync_stamps')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  return new Map(rows.map((row) => [row.profile_id, stampOfRow(row)]))
}

/** Stores `stamp` as the person's stamp, and never touches the profile.
 * The demo's record limit does not count a first stamp's row: there is at
 * most one per person, and the stamp lived on the profile before, so a demo
 * at its limit can still run a Team sync. */
export async function writeStamp(
  ctx: MutationCtx,
  profile: Pick<Doc<'profiles'>, 'id' | 'org_id'>,
  stamp: SyncStamp,
): Promise<void> {
  const row = await stampRow(ctx, profile.id)
  // replace, so an absent `since` is stored absent
  const next = { org_id: profile.org_id, profile_id: profile.id, ...stamp }
  if (row === null) await uncountedWriter(ctx.db).insert('sync_stamps', next)
  else await ctx.db.replace(row._id, next)
}

/** Deletes the person's stamp row, if any. */
export async function deleteStamp(ctx: MutationCtx, profileId: string): Promise<void> {
  const row = await stampRow(ctx, profileId)
  if (row !== null) await ctx.db.delete(row._id)
}
