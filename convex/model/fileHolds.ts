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
 * row records the file with the time it may be erased, and a scheduled
 * erase (files.ts eraseHeldFile) ends the hold at that time. eraseFile
 * erases a file at once. It is for a file that no committed row ever named,
 * such as an upload refused in the same transaction or bytes nobody
 * confirmed, for the public demo and for the operator's panorama library,
 * whose storage URLs are permanent and public (panoramaImages.ts remove, and
 * a replaced library preview in backgroundPreviews.ts attach).
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
 * A restore rewinds file_holds with every other table, but Convex's import
 * leaves system tables alone, so stored files and scheduled functions stay
 * as they are. A file let go after the restored backup therefore loses its
 * hold row but keeps its scheduled erase, and is still erased in time. A
 * file whose row a restore brings back is in use again, and its scheduled
 * erase keeps it.
 *
 * The eraser (files.ts eraseHeldFiles) runs every ERASE_EVERY_MS. It erases
 * the due holds a scheduled erase missed, as after a failed erase or an
 * import into another deployment. It also notices a restore (noteRestore).
 * Files that only rows written after the restored backup named, such as
 * attachments uploaded since, are then named by nothing and have no hold.
 * Until HOLD_MS after a restore is noticed, the orphan sweep holds such
 * files instead of erasing them (restoreHoldEnd), so a second restore, of a
 * backup taken between the first backup and the first restore, still finds
 * them. The first check on a deployment counts as a restore, so the files
 * nothing named then are held for 7 days too. A restore goes unnoticed only
 * when no eraser run fell between the backup and the restore, so within one
 * interval. Files let go in that time are still erased on time, and files
 * that only rows written in that time named go to the weekly sweep, which
 * erases them at once. */

import { type DocumentByName, makeFunctionReference, type SystemDataModel } from 'convex/server'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { isDemoDeployment } from '../lib/demo'

/** How often the eraser runs (crons.ts). */
export const ERASE_EVERY_MS = 30 * 60 * 1000

/** How long a released file is held. Backups are kept 7 days, and the data
 * processing agreement promises that deleted data is gone from backups
 * within 7 days. A file's scheduled erase runs when its hold ends, and if it
 * fails, the next eraser run erases the file. A hold of 7 days less two
 * eraser intervals (1 hour) therefore erases every file at least one
 * interval before 7 days after its release, which leaves room for a late
 * run. It keeps the file for a restore of every backup taken more than an
 * hour before the release. */
export const HOLD_MS = 7 * 24 * 60 * 60 * 1000 - 2 * ERASE_EVERY_MS

/** The most holds one eraser leg handles. Each costs the seven index ranges
 * of storageIdReferenced and a file lookup, so a leg reads about 2,050 of
 * Convex's 4,096 with the page and the first leg's restore check, and writes
 * at most two deletes per hold. Tests lower it. */
export const ERASE_PAGE = { holds: 256 }

/** Whether releaseFile schedules each hold's erase. Always on in a
 * deployment. convex-test runs a scheduled function when its timer fires,
 * and the suites on fake timers that finish their steps by running every
 * timer would also run each erase a week ahead on their clock. They turn it
 * off to see what a deletion holds; fileHolds.test.ts tests the erase. */
export const ERASE_TIMERS = { on: true }

/* How long a restore witness waits before it runs (noteRestore). The eraser
 * replaces it every ERASE_EVERY_MS, so it runs only if the eraser stops for a
 * day, and then does nothing. */
const WITNESS_MS = 24 * 60 * 60 * 1000

const eraseHeldFileRef = makeFunctionReference<'mutation', { storage_id: Id<'_storage'> }, null>(
  'files:eraseHeldFile',
)
const witnessRef = makeFunctionReference<'mutation', Record<string, never>, null>(
  'files:restoreWitness',
)

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
 * file is gone. Otherwise holds it until HOLD_MS from now and schedules its
 * erase for then. A file held already keeps the later of its two times, and
 * a hold the orphan sweep made after a restore becomes this release's. On
 * the demo the file is erased at once.
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
  else if (held.erase_at < erase_at)
    await ctx.db.patch(held._id, { erase_at, after_restore: undefined })
  else return
  if (ERASE_TIMERS.on)
    await ctx.scheduler.runAt(erase_at, eraseHeldFileRef, { storage_id: storageId })
}

/**
 * Holds file `file`, which a restore left named by nothing and unheld, until
 * `erase_at` (epoch milliseconds, restoreHoldEnd). The orphan sweep calls it
 * after a restore instead of erasing the file. It schedules no erase: the
 * eraser erases the file when the hold is due, and a restore that rewinds
 * the hold leaves it to the next sweep.
 */
export async function holdAfterRestore(
  ctx: MutationCtx,
  file: DocumentByName<SystemDataModel, '_storage'>,
  erase_at: number,
): Promise<void> {
  await ctx.db.insert('file_holds', {
    storage_id: file._id,
    size_bytes: file.size,
    erase_at,
    after_restore: true,
  })
}

/* Ends `hold`, the hold on file `storageId` or null when it has none, and
 * erases the file unless a row names it again. */
async function endHold(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  hold: Doc<'file_holds'> | null,
): Promise<'erased' | 'kept'> {
  if (hold !== null) await ctx.db.delete(hold._id)
  if (await storageIdReferenced(ctx, storageId)) return 'kept'
  await eraseFile(ctx, storageId)
  return 'erased'
}

/**
 * The scheduled erase of file `storageId` at `now`, the end of a hold that
 * releaseFile made. Leaves the file to a later erase when a later release
 * moved its hold. Otherwise ends the hold, and erases the file unless a row
 * names it again. A missing hold row does not keep the file, because a
 * restore rewinds the row of a file let go after the backup. Neither does a
 * hold the orphan sweep made after a restore, which lasts longer than the
 * release's.
 */
export async function eraseOnTime(
  ctx: MutationCtx,
  storageId: Id<'_storage'>,
  now: number,
): Promise<'erased' | 'kept' | 'later'> {
  const hold = await holdOf(ctx, storageId)
  if (hold !== null && hold.erase_at > now && hold.after_restore !== true) return 'later'
  return await endHold(ctx, storageId, hold)
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
  for (const hold of due.slice(0, ERASE_PAGE.holds))
    counts[await endHold(ctx, hold.storage_id, hold)] += 1
  return due.length > ERASE_PAGE.holds
}

/* The restore_watch row, its witness, and whether a restore rewound the
 * row: it is missing, or names a witness that a later noteRestore canceled.
 * A witness that ran, after a day without the eraser, still counts. */
async function watch(ctx: QueryCtx) {
  const row = await ctx.db.query('restore_watch').first()
  const witness = row === null ? null : await ctx.db.system.get(row.witness)
  return { row, witness, rewound: witness === null || witness.state.kind === 'canceled' }
}

/**
 * Whether the database went back in time since the last call, as a restore
 * from a backup does, and remembers this call at `now` (epoch milliseconds).
 * The restore_watch row names a scheduled witness, which each call cancels
 * and replaces. A restore rewinds the row but not the scheduler, so the row
 * then names a witness that a later call canceled. A missing row counts as a
 * restore too, so a restore of a backup from before the row is noticed. That
 * also makes the first call on a deployment answer true. On the demo, which
 * keeps no backups, it does nothing and answers false.
 */
export async function noteRestore(ctx: MutationCtx, now: number): Promise<boolean> {
  if (isDemoDeployment()) return false
  const { row, witness, rewound } = await watch(ctx)
  if (witness?.state.kind === 'pending') await ctx.scheduler.cancel(witness._id)
  const next = await ctx.scheduler.runAfter(WITNESS_MS, witnessRef, {})
  const change = rewound ? { witness: next, restored_at: now } : { witness: next }
  if (row === null) await ctx.db.insert('restore_watch', change)
  else await ctx.db.patch(row._id, change)
  return rewound
}

/** What the orphan sweep knows of restores (restoreState). */
export type RestoreState = { rewound: boolean; restored_at?: number }

/**
 * Whether a restore happened that noteRestore has not noticed yet, and when
 * it last noticed one. Reads only. The orphan sweep reads it in every leg,
 * so a run that began before a restore stops erasing once the restore
 * happens. On the demo, which keeps no backups, it knows of none.
 */
export async function restoreState(ctx: QueryCtx): Promise<RestoreState> {
  if (isDemoDeployment()) return { rewound: false }
  const { row, rewound } = await watch(ctx)
  return { rewound, restored_at: row?.restored_at }
}

/**
 * Until when the orphan sweep holds a file nothing names, created at
 * `created` and older than the floor, or null when it erases the file. All
 * times are epoch milliseconds, and `now` is the run's start. A restore not
 * noticed yet holds every such file until HOLD_MS after `now`. Once it is
 * noticed, the run noteRestore started (`restoredRun`) holds every such
 * file, and any other run holds a file created by then, until HOLD_MS after
 * the restore was noticed. A later run therefore holds an upload of the hour
 * before the restore, which the floor kept from the first run, and so does a
 * weekly run that starts while the first one is still going. Every backup
 * that could name such a file has expired when its hold ends. Otherwise the
 * sweep erases the file.
 */
export function restoreHoldEnd(
  restore: RestoreState,
  restoredRun: boolean,
  created: number,
  now: number,
): number | null {
  if (restore.rewound) return now + HOLD_MS
  const at = restore.restored_at
  if (at !== undefined && (restoredRun || (created <= at && now < at + HOLD_MS)))
    return at + HOLD_MS
  return restoredRun ? now + HOLD_MS : null
}
