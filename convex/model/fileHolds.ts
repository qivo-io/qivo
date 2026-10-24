/* What happens to a stored file once no row needs it. Production's backups
 * leave file contents out, and a restore from such a backup leaves the
 * deployment's stored files as they are. A record a restore brings back
 * therefore finds its file only if the file was not erased in the meantime.
 * So a file a committed row named is held for HOLD_MS before it is erased.
 *
 * releaseFile is the one way to let go of such a file: an attachment removed
 * or deleted for good, a replaced or removed picture, background or preview,
 * a removed person's picture, a removed login's backgrounds and an
 * organization's deletion all call it, after the row stops naming the file.
 * A file that another row still names stays as it is. Otherwise a file_holds
 * row records the file with the time it may be erased. eraseFile erases a
 * file at once. It is for a file that no committed row ever named, such as an
 * upload refused in the same transaction or bytes nobody confirmed, for the
 * public demo and for the operator's panorama library (panoramaImages.ts
 * remove).
 *
 * The public demo keeps no backups and promises deletion 24 hours after a
 * demo starts, so on the demo (lib/demo.ts isDemoDeployment) releaseFile
 * erases at once as well.
 *
 * Nothing in Qivo reads a held file. No row names it, so the /files,
 * /avatars, /backgrounds and /background-previews gateways, REST, MCP,
 * Deleted items, the organization export and the storage totals all miss it,
 * since each reads a file through the row that names it. storageIdInUse
 * counts a hold as a use, so no attach, picture or background can take a
 * held file, and the orphan sweep (files.ts reapOrphans) keeps it.
 *
 * The eraser (files.ts eraseHeldFiles) runs every ERASE_EVERY_MS. It reads
 * the holds that are due through by_erase_at and erases each file unless a
 * row names it again, as a restore or an import can, in which case it drops
 * the hold and keeps the file. */

import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { isDemoDeployment } from '../lib/demo'

/** How often the eraser runs (crons.ts). */
export const ERASE_EVERY_MS = 60 * 60 * 1000

/** How long a released file is held. Backups are kept 7 days, and the data
 * processing agreement promises that deleted data is gone from backups
 * within 7 days. A hold of 7 days less one eraser interval erases every file
 * by 7 days after its release, and keeps it for a restore of every backup
 * taken more than one interval before the release. */
export const HOLD_MS = 7 * 24 * 60 * 60 * 1000 - ERASE_EVERY_MS

/** The most holds one eraser leg handles. Each costs at most the seven
 * index ranges of storageIdReferenced and a file lookup, so a leg reads
 * about 2,100 of Convex's 4,096, and writes at most two deletes per hold.
 * Tests lower it. */
export const ERASE_PAGE = { holds: 256 }

/** The hold on file `storageId`, or null. */
export const holdOf = (ctx: QueryCtx, storageId: Id<'_storage'>) =>
  ctx.db
    .query('file_holds')
    .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
    .unique()

/** Whether any row names file `storageId`: an attachment, live or in
 * Deleted items, a profile picture, a panorama image or a custom background,
 * or the preview of either. A hold is not a row; storageIdInUse adds it. The
 * live attachments are read first, so a file a live attachment names costs
 * one read. */
export async function storageIdReferenced(
  ctx: QueryCtx,
  storageId: Id<'_storage'>,
): Promise<boolean> {
  const att = await ctx.db
    .query('issue_attachments')
    .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
    .first()
  if (att !== null) return true
  const trashed = await ctx.db
    .query('deleted_rows')
    .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
    .first()
  if (trashed !== null) return true
  const prof = await ctx.db
    .query('profiles')
    .withIndex('by_avatar', (q) => q.eq('avatar_storage_id', storageId))
    .first()
  if (prof !== null) return true
  const panorama =
    (await ctx.db
      .query('panorama_images')
      .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
      .first()) !== null
  if (panorama) return true
  if (
    await ctx.db
      .query('panorama_images')
      .withIndex('by_preview_storage', (q) => q.eq('preview_storage_id', storageId))
      .first()
  )
    return true
  if (
    await ctx.db
      .query('custom_backgrounds')
      .withIndex('by_preview_storage', (q) => q.eq('preview_storage_id', storageId))
      .first()
  )
    return true
  return (
    (await ctx.db
      .query('custom_backgrounds')
      .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
      .first()) !== null
  )
}

/* The cross-tenant byte-destruction fence (0089 §3's vector, reborn as
 * storage ids): a file a row names (storageIdReferenced) must never gain a
 * second referent, because the second row's delete would let go of the
 * first row's bytes. A held file counts too, so nobody can adopt a file
 * that was deleted. The same answer keeps files.ts reapOrphans and the demo
 * sweepers away from trashed and held bytes. */
export async function storageIdInUse(ctx: QueryCtx, storageId: Id<'_storage'>): Promise<boolean> {
  return (await storageIdReferenced(ctx, storageId)) || (await holdOf(ctx, storageId)) !== null
}

/** Erases file `storageId` at once. A file already gone is left alone. */
export async function eraseFile(ctx: MutationCtx, storageId: Id<'_storage'>): Promise<void> {
  if ((await ctx.db.system.get(storageId)) !== null) await ctx.storage.delete(storageId)
}

/**
 * Lets go of file `storageId`, which a committed row named, once that row no
 * longer does. Call it after the row is deleted or patched in the same
 * transaction. Does nothing when another row still names the file or the
 * file is gone. Otherwise holds it until HOLD_MS from now, and a file held
 * already keeps the later of its two times. On the demo the file is erased
 * at once.
 */
export async function releaseFile(
  ctx: MutationCtx,
  storageId: Id<'_storage'> | undefined,
): Promise<void> {
  if (storageId === undefined || (await storageIdReferenced(ctx, storageId))) return
  if (isDemoDeployment()) return await eraseFile(ctx, storageId)
  const file = await ctx.db.system.get(storageId)
  if (file === null) return
  const erase_at = Date.now() + HOLD_MS
  const held = await holdOf(ctx, storageId)
  if (held === null)
    await ctx.db.insert('file_holds', { storage_id: storageId, size_bytes: file.size, erase_at })
  else if (held.erase_at < erase_at) await ctx.db.patch(held._id, { erase_at })
}

/** What one eraser run did: files erased, and files kept because a row
 * names them again. */
export type EraseCounts = { erased: number; kept: number }

/**
 * Handles up to ERASE_PAGE.holds of the holds due at `now` (epoch
 * milliseconds), adding to `counts`. Each hold is deleted, and its file is
 * erased unless a row names it again. Answers whether more due holds are
 * left for another leg.
 */
export async function eraseDueFiles(
  ctx: MutationCtx,
  now: number,
  counts: EraseCounts,
): Promise<boolean> {
  const due = await ctx.db
    .query('file_holds')
    .withIndex('by_erase_at', (q) => q.lte('erase_at', now))
    .take(ERASE_PAGE.holds + 1)
  for (const hold of due.slice(0, ERASE_PAGE.holds)) {
    await ctx.db.delete(hold._id)
    if (await storageIdReferenced(ctx, hold.storage_id)) counts.kept += 1
    else {
      await eraseFile(ctx, hold.storage_id)
      counts.erased += 1
    }
  }
  return due.length > ERASE_PAGE.holds
}
