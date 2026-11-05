/* The private demo's upload ledger. Every upload of a demo, an attachment or
 * description image, a profile picture, a custom background or the preview
 * Qivo makes of one, reserves room in one demo_uploads row before any bytes
 * are sent, and the demo holds at most DEMO_STORAGE_BYTES of stored bytes and
 * pending reservations together (lib/limits.ts). A reservation is the size
 * the app declared, checked against the kind's per-file limit and the free
 * space, and the receivers store at most that many bytes. Nothing is ever
 * deleted to make room. A refusal says how much is free and how to free
 * more, and a demo above the budget admits nothing until enough is freed or
 * it ends. */

import { internal } from '../_generated/api'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { storageIdInUse } from '../files'
import { demoForAuth, isDemoDeployment, requireActiveDemo } from '../lib/demo'
import { forbidden, rule } from '../lib/functions'
import { DEMO_FILE_BYTES, DEMO_STORAGE_BYTES, LIMITS, MIB } from '../lib/limits'
import { uploadSize } from './attachments'
import { eraseFile } from './fileHolds'

declare const crypto: { randomUUID(): string }

export { DEMO_FILE_BYTES, DEMO_STORAGE_BYTES } from '../lib/limits'
/** The most files one demo holds, live ledger rows of every kind. */
export const DEMO_UPLOAD_ROWS = 200
export const DEMO_PREVIEW_BYTES = 1024 * 1024
export const DEMO_UPLOAD_LEASE_MS = 2 * 60 * 1000
export const DEMO_PROCESSOR_LEASE_MS = 11 * 60 * 1000

/* How long a reservation waits for its file unless its caller sets a
 * sooner end. */
const DEMO_RESERVATION_MS = 10 * 60 * 1000

/* The step every refusal of a full demo ends with. The path is the guide's
 * (docs/guide/administration-guard-rails-and-the-demo.md). */
const FREE_SOME =
  'Remove a file, a picture or your background, or delete items for good in Settings → Projects → Deleted items, then try again.'

/* How much of the budget is free, `free` bytes in MiB rounded down to one
 * decimal. */
function freePart(free: number): string {
  if (free <= 0) return 'none of it is free'
  const tenths = Math.floor((free * 10) / MIB)
  return tenths === 0 ? 'less than 0.1 MiB of it is free' : `${tenths / 10} MiB of it is free`
}

/** The refusal of an upload that does not fit in the demo's shared storage,
 * which has `free` bytes left. */
export const demoStorageFull = (free: number): string =>
  `the demo stores at most ${DEMO_STORAGE_BYTES / MIB} MiB of files in total, and ${freePart(free)}. ${FREE_SOME}`

/** The refusal of an upload once the demo holds DEMO_UPLOAD_ROWS files. */
export const DEMO_FILES_FULL = `the demo stores at most ${DEMO_UPLOAD_ROWS} files. ${FREE_SOME}`

/** The refusal of an attachment, description image or background whose
 * declared size is over DEMO_FILE_BYTES. */
export const DEMO_FILE_TOO_LARGE = `a demo file must be at most ${DEMO_FILE_BYTES / MIB} MiB. Choose a smaller file.`

/** The receivers' refusal of a body longer than the size its upload
 * declared (demoBodyRefusal). */
export const DEMO_BODY_TOO_LONG = 'The file is larger than its upload said. Choose it again.'

type UploadKind = Exclude<Doc<'demo_uploads'>['kind'], 'preview'>

/* Each kind's per-file limit and the refusal of a larger declared size. */
const KINDS: Record<UploadKind, { max: number; tooLarge: string }> = {
  attachment: { max: DEMO_FILE_BYTES, tooLarge: DEMO_FILE_TOO_LARGE },
  background: { max: DEMO_FILE_BYTES, tooLarge: DEMO_FILE_TOO_LARGE },
  avatar: { max: LIMITS.avatarSize.max * MIB, tooLarge: LIMITS.avatarSize.refusal },
}

export const demoUploadFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('demo_uploads')
    .withIndex('by_uuid', (q) => q.eq('id', id))
    .unique()

export async function demoCanRead(ctx: QueryCtx, authId: string, orgId?: string) {
  if (!isDemoDeployment()) return true
  const receipt = await ctx.db
    .query('demo_sessions')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
    .unique()
  return (
    !!receipt &&
    receipt.status === 'ready' &&
    receipt.expires_at > Date.now() &&
    (orgId === undefined || receipt.org_id === orgId)
  )
}

export async function demoFileExpiry(ctx: QueryCtx, authId: string, requestedSeconds: number) {
  if (!isDemoDeployment()) return requestedSeconds
  const receipt = await requireActiveDemo(ctx, authId)
  return Math.min(requestedSeconds, Math.floor(receipt.expires_at / 1000))
}

/* What demo `demoId`'s live rows hold: the bytes they store or reserve and
 * how many there are. It deletes the rows that no longer count on the way,
 * a stored row whose file was removed and a pending one past its expiry.
 * The demo never holds more than DEMO_UPLOAD_ROWS rows after a reservation,
 * so the one range reads them all; a longer one counts as full. */
async function demoLedger(
  ctx: MutationCtx,
  demoId: string,
): Promise<{ reserved: number; count: number }> {
  const rows = await ctx.db
    .query('demo_uploads')
    .withIndex('by_demo', (q) => q.eq('demo_id', demoId))
    .take(DEMO_UPLOAD_ROWS + 1)
  let reserved = 0
  let count = 0
  for (const row of rows) {
    // Completed files that were removed no longer consume quota. Pending
    // work retains its reservation until its bounded receiver settles.
    const gone =
      row.state === 'stored' && row.storage_id && !(await ctx.db.system.get(row.storage_id))
    const abandoned = row.state === 'pending' && row.expires_at <= Date.now()
    if (gone || abandoned) await ctx.db.delete(row._id)
    else {
      reserved += row.reserved_bytes
      count++
    }
  }
  if (rows.length > DEMO_UPLOAD_ROWS) count = Math.max(count, DEMO_UPLOAD_ROWS)
  return { reserved, count }
}

/** A reservation, with its ledger row's id, when it expires in epoch
 * milliseconds, and the bytes it holds. */
export type DemoReservation = { id: string; expiresAt: number; bytes: number }

/* Records a pending reservation of `bytes` for `receipt`'s demo. It expires
 * after DEMO_RESERVATION_MS, at `expiresAt` when that is sooner, and never
 * after the demo. */
async function insertReservation(
  ctx: MutationCtx,
  a: {
    receipt: Doc<'demo_sessions'>
    authId: string
    kind: Doc<'demo_uploads'>['kind']
    targetId: string
    bytes: number
    declared?: boolean
    id?: string
    expiresAt?: number
  },
): Promise<DemoReservation> {
  const id = a.id ?? crypto.randomUUID()
  const expiresAt = Math.min(a.expiresAt ?? Date.now() + DEMO_RESERVATION_MS, a.receipt.expires_at)
  await ctx.db.insert('demo_uploads', {
    id,
    demo_id: a.receipt.id,
    auth_user_id: a.authId,
    kind: a.kind,
    target_id: a.targetId,
    reserved_bytes: a.bytes,
    expires_at: expiresAt,
    state: 'pending',
    ...(a.declared ? { declared: true as const } : {}),
  })
  return { id, expiresAt, bytes: a.bytes }
}

/**
 * Reserves room in the private demo of login `authId` for one upload of
 * `kind` to `targetId`, before any bytes are sent, and answers the
 * reservation. `size` is the size the app declared. It must be a whole
 * number of bytes (a bad request otherwise) within the kind's per-file
 * limit, and it must fit in the free space, DEMO_STORAGE_BYTES less what
 * the demo's live rows store or reserve. The row is then `declared`, and
 * the receiver stores at most that many bytes. Without `size`, as from an
 * app loaded before uploads declared one, it reserves the kind's limit or
 * the free space, whichever is smaller, so a small file still fits. It
 * refuses with a `rule` at DEMO_UPLOAD_ROWS files, when nothing is free and
 * when a declared size does not fit, and never deletes a file to make room.
 * Reads one range of at most DEMO_UPLOAD_ROWS + 1 rows under 1 KB each and
 * one stored file for each stored row, inside Convex's limits.
 */
export async function reserveDemoUpload(
  ctx: MutationCtx,
  args: {
    authId: string
    kind: UploadKind
    targetId: string
    size?: number
    id?: string
    expiresAt?: number
  },
): Promise<DemoReservation> {
  const receipt = await requireActiveDemo(ctx, args.authId)
  const { max, tooLarge } = KINDS[args.kind]
  const size = args.size === undefined ? undefined : uploadSize(args.size)
  if (size !== undefined && size > max) throw rule(tooLarge)
  const { reserved, count } = await demoLedger(ctx, receipt.id)
  if (count >= DEMO_UPLOAD_ROWS) throw rule(DEMO_FILES_FULL)
  const free = Math.max(0, DEMO_STORAGE_BYTES - reserved)
  const bytes = size ?? Math.min(max, free)
  if (free === 0 || bytes > free) throw rule(demoStorageFull(free))
  return await insertReservation(ctx, {
    ...args,
    receipt,
    bytes,
    declared: size !== undefined,
  })
}

/**
 * Reserves room for the preview of custom background `targetId` of login
 * `authId`: DEMO_PREVIEW_BYTES or the free space, whichever is smaller.
 * Answers null and reserves nothing when nothing is free or the demo holds
 * DEMO_UPLOAD_ROWS files, so the background shows without a preview instead
 * of the upload failing (backgroundPreviews.ts beginDemoWork). Reads what
 * reserveDemoUpload reads.
 */
export async function reserveDemoPreview(
  ctx: MutationCtx,
  args: { authId: string; targetId: string },
): Promise<DemoReservation | null> {
  const receipt = await requireActiveDemo(ctx, args.authId)
  const { reserved, count } = await demoLedger(ctx, receipt.id)
  const free = Math.max(0, DEMO_STORAGE_BYTES - reserved)
  if (count >= DEMO_UPLOAD_ROWS || free === 0) return null
  return await insertReservation(ctx, {
    ...args,
    receipt,
    kind: 'preview',
    bytes: Math.min(DEMO_PREVIEW_BYTES, free),
  })
}

/** How many demo backgrounds without a preview one sweep checks for room
 * (retrySkippedPreview). Tests lower it. */
export const PREVIEW_RETRY = { checks: 4 }

/**
 * Schedules the preview of one demo background that the demo's storage left
 * without one (schema.ts custom_backgrounds.preview_skipped), once its demo
 * has DEMO_PREVIEW_BYTES free, so the preview's own reservation gets all it
 * may use. The minute sweep (demoUploads.ts sweep) calls it at `now`. It
 * checks the PREVIEW_RETRY.checks backgrounds skipped longest ago. One whose
 * demo still lacks room counts as skipped at `now`, so the next sweep checks
 * others first and none waits behind a demo that stays full. One that is no
 * longer its login's background, or whose demo ended, loses its mark. So
 * does the one scheduled, and the preview's run marks it again if the room
 * is gone by then (backgroundPreviews.ts beginDemoWork). Answers whether it
 * scheduled one. Reads, for each background it checks, what
 * reserveDemoPreview reads and the login's appearance row.
 */
export async function retrySkippedPreview(ctx: MutationCtx, now: number): Promise<boolean> {
  const skipped = await ctx.db
    .query('custom_backgrounds')
    .withIndex('by_preview_skipped', (q) => q.gt('preview_skipped', 0))
    .take(PREVIEW_RETRY.checks)
  for (const image of skipped) {
    const receipt = await demoForAuth(ctx, image.auth_user_id)
    const settings = await ctx.db
      .query('account_appearance')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', image.auth_user_id))
      .first()
    if (
      receipt === null ||
      receipt.status !== 'ready' ||
      receipt.expires_at <= now ||
      settings?.custom_image_id !== image.id
    ) {
      await ctx.db.patch(image._id, { preview_skipped: undefined })
      continue
    }
    const { reserved, count } = await demoLedger(ctx, receipt.id)
    if (count >= DEMO_UPLOAD_ROWS || DEMO_STORAGE_BYTES - reserved < DEMO_PREVIEW_BYTES) {
      await ctx.db.patch(image._id, { preview_skipped: now })
      continue
    }
    await ctx.db.patch(image._id, { preview_skipped: undefined })
    await ctx.scheduler.runAfter(0, internal.backgroundPreviewProcessor.generate, {
      kind: 'custom',
      id: image.id,
      storage_id: image.storage_id,
    })
    return true
  }
  return false
}

/** The receivers' refusal of a body longer than reservation `row`: the
 * declared-size sentence for a declared size, the budget's for a sizeless
 * reservation the free space bounded, and otherwise the kind's per-file
 * sentence. */
export function demoBodyRefusal(row: Doc<'demo_uploads'>): string {
  if (row.declared) return DEMO_BODY_TOO_LONG
  if (row.kind === 'preview') return demoStorageFull(row.reserved_bytes)
  const { max, tooLarge } = KINDS[row.kind]
  return row.reserved_bytes < max ? demoStorageFull(row.reserved_bytes) : tooLarge
}

/** What a receiver reads of reservation `row` once it began: the most bytes
 * it may store, whether that is a declared size, and the refusal of a
 * longer body (demoBodyRefusal). */
export const demoReceipt = (row: Doc<'demo_uploads'>) => ({
  maxBytes: row.reserved_bytes,
  declared: row.declared === true,
  tooLarge: demoBodyRefusal(row),
})

export async function beginDemoUpload(
  ctx: MutationCtx,
  id: string,
  authId: string,
  processor = false,
) {
  const ticket = await demoUploadFor(ctx, id)
  if (
    !ticket ||
    ticket.auth_user_id !== authId ||
    ticket.state !== 'pending' ||
    ticket.expires_at <= Date.now() ||
    !(await demoCanRead(ctx, authId))
  )
    throw forbidden('This demo upload has expired or has already been used.')
  await ctx.db.patch(ticket._id, {
    state: 'receiving',
    started_at: Date.now(),
    lease_until: Date.now() + (processor ? DEMO_PROCESSOR_LEASE_MS : DEMO_UPLOAD_LEASE_MS),
  })
  return ticket
}

/**
 * Records `storageId` as the file of reservation `id`, which the receiver of
 * login `authId` claimed, and shrinks the reservation to the file's size, so
 * a file stored smaller than declared frees the rest. Refuses a file larger
 * than its reservation, and a reservation that expired, lost its claim or
 * whose demo can no longer be read.
 *
 * The row keeps its own expiry, at most 10 minutes after files.uploadUrl or
 * files.avatarUploadUrl, 15 after appearance.createUpload and 10 after a
 * preview's reservation, not the demo's end. Within a minute of it the sweep
 * (demoUploads.ts sweep) moves the expiry of a file in use to the demo's end
 * and erases a file nothing uses with its row, so an upload that never
 * attaches, after a refused attach or a closed tab, stops counting instead
 * of holding its bytes until the demo ends. An attach after the expiry and
 * before the sweep still works, since the row is still stored; after the
 * sweep erased the file, the ownership check (assertDemoFileOwnership)
 * refuses it and the person uploads again. The attach follows the POST
 * within seconds in practice, and the POST itself must come before the
 * expiry (beginDemoUpload).
 */
export async function retainDemoUpload(
  ctx: MutationCtx,
  id: string,
  authId: string,
  storageId: Id<'_storage'>,
) {
  const ticket = await demoUploadFor(ctx, id)
  const meta = await ctx.db.system.get(storageId)
  if (
    !ticket ||
    ticket.auth_user_id !== authId ||
    ticket.state !== 'receiving' ||
    (ticket.lease_until ?? 0) <= Date.now() ||
    ticket.expires_at <= Date.now() ||
    !(await demoCanRead(ctx, authId))
  )
    throw forbidden('This demo upload has expired.')
  if (!meta || meta.size > ticket.reserved_bytes)
    throw rule('this file exceeds the demo upload limit.')
  await ctx.db.patch(ticket._id, {
    state: 'stored',
    storage_id: storageId,
    reserved_bytes: meta.size,
    lease_until: undefined,
  })
}

export async function assertDemoFileOwnership(
  ctx: QueryCtx,
  authId: string,
  storageId: Id<'_storage'>,
  kind: 'attachment' | 'avatar',
  targetId: string,
) {
  if (!isDemoDeployment()) return
  const ticket = await ctx.db
    .query('demo_uploads')
    .withIndex('by_storage', (q) => q.eq('storage_id', storageId))
    .unique()
  if (
    !ticket ||
    ticket.auth_user_id !== authId ||
    ticket.kind !== kind ||
    ticket.target_id !== targetId ||
    ticket.state !== 'stored' ||
    !(await demoCanRead(ctx, authId))
  )
    throw forbidden('This file does not belong to this demo upload.')
}

/** How many stored files one page of checkStoredFiles reads. */
export const CHECK_FILES = 64

/** How far the checks have read stored files (schema.ts demo_upload_sweeps). */
type Checked = Pick<Doc<'demo_upload_sweeps'>, 'checked_through' | 'checked_at'>

/* Up to `count` stored files created before `before` that no check has
 * read, oldest first. Convex does not make _creationTime unique, so a full
 * page can end inside a group of files created at one time. The next read
 * then starts at that time, that time included, and skips the files of the
 * group that checked_at lists. */
async function uncheckedFiles(ctx: QueryCtx, checked: Checked, before: number, count: number) {
  const { checked_through: from, checked_at: seen = [] } = checked
  if (before <= from) return []
  const files = await ctx.db.system
    .query('_storage')
    .withIndex('by_creation_time', (q) => {
      const after = checked.checked_at ? q.gte('_creationTime', from) : q.gt('_creationTime', from)
      return after.lt('_creationTime', before)
    })
    .take(count + seen.length)
  return files.filter((file) => !seen.includes(file._id)).slice(0, count)
}

/* The progress after a check of `files`, the unchecked files read from
 * `checked` on. A page that was not full read every file up to the time of
 * its last one. A full page may end inside a group of files created at one
 * time, so it lists the files of that group it checked. */
function checkedAfter(
  checked: Checked,
  files: readonly { _id: Id<'_storage'>; _creationTime: number }[],
  full: boolean,
): Checked {
  const through = files.at(-1)?._creationTime ?? checked.checked_through
  if (!full) return { checked_through: through }
  const group = files.filter((file) => file._creationTime === through).map((file) => file._id)
  const before = through === checked.checked_through ? (checked.checked_at ?? []) : []
  return { checked_through: through, checked_at: [...before, ...group] }
}

/** Checks the next page of stored files for bytes nothing records, as a
 * receiver that crashed after storing them leaves. Each file is checked
 * once, oldest first: those no check has read yet (demo_upload_sweeps) and
 * created before every receiver that could still claim one started, with
 * 120 seconds for commits to settle. A file that nothing uses and no live
 * ticket keeps is erased (model/fileHolds.ts eraseFile, at once, as on
 * every demo path). One in use or kept by a live ticket then is erased by
 * whatever lets go of it: its ticket's expiry (demoUploads.ts sweep), its
 * demo's purge (drainDemoUploads), or files.ts reapOrphans. Returns the
 * progress after the page and whether the page was full. */
export async function checkStoredFiles(
  ctx: MutationCtx,
  progress: Doc<'demo_upload_sweeps'> | null,
): Promise<{ checked: Checked; full: boolean }> {
  const now = Date.now()
  const checked: Checked = progress ?? { checked_through: 0 }
  const workers = await ctx.db
    .query('demo_uploads')
    .withIndex('by_state_lease', (q) => q.eq('state', 'receiving').gt('lease_until', now))
    .take(1001)
  const safeBefore =
    workers.length === 1001
      ? 0
      : Math.min(now - 120_000, ...workers.map((worker) => worker.started_at ?? 0))
  if (safeBefore <= checked.checked_through) return { checked, full: false }
  const files = await uncheckedFiles(ctx, checked, safeBefore, CHECK_FILES)
  for (const file of files) {
    if (await storageIdInUse(ctx, file._id)) continue
    const ticket = await ctx.db
      .query('demo_uploads')
      .withIndex('by_storage', (q) => q.eq('storage_id', file._id))
      .unique()
    if (ticket && ticket.expires_at > now) continue
    await eraseFile(ctx, file._id)
  }
  const full = files.length === CHECK_FILES
  const next = checkedAfter(checked, files, full)
  // an empty page writes only to drop a group it has now read whole
  if (progress && (files.length || progress.checked_at)) await ctx.db.replace(progress._id, next)
  else if (!progress && files.length) await ctx.db.insert('demo_upload_sweeps', next)
  return { checked: next, full }
}

/** Cleanup keeps the receipt until receiving work finishes or its runtime
 * limit elapses. Late finalizers always refuse missing/expired ownership.
 * Bytes a crashed receiver of the demo left are recorded nowhere. They
 * predate the barrier, so the demo waits until checkStoredFiles has checked
 * every file created before it, and checks pages itself meanwhile. It reads
 * only files no check has read yet, not every stored file. */
export async function drainDemoUploads(ctx: MutationCtx, demoId: string): Promise<boolean> {
  const rows = await ctx.db
    .query('demo_uploads')
    .withIndex('by_demo', (q) => q.eq('demo_id', demoId))
    .take(32)
  let waiting = false
  for (const row of rows) {
    if (row.state === 'receiving' && (row.lease_until ?? 0) > Date.now()) {
      waiting = true
      continue
    }
    if (row.storage_id) await eraseFile(ctx, row.storage_id)
    await ctx.db.delete(row._id)
  }
  if (waiting || rows.length >= 32) return false
  const receipt = await ctx.db
    .query('demo_sessions')
    .withIndex('by_uuid', (q) => q.eq('id', demoId))
    .unique()
  if (!receipt) return true
  if (receipt.cleanup_file_after === undefined) {
    await ctx.db.patch(receipt._id, { cleanup_file_after: Date.now() + 120_000 })
    return false
  }
  if (Date.now() < receipt.cleanup_file_after) return false
  // Files whose creation millisecond is at or before the barrier's start.
  const quietBefore = receipt.cleanup_file_after - 120_000 + 1
  const { checked, full } = await checkStoredFiles(
    ctx,
    await ctx.db.query('demo_upload_sweeps').first(),
  )
  if (!(await uncheckedFiles(ctx, checked, quietBefore, 1)).length) return true
  // A full page continues at once. Otherwise a receiver that could still
  // claim a file, or the settling time, holds the check back.
  if (!full) await ctx.db.patch(receipt._id, { cleanup_file_wait_until: Date.now() + 5000 })
  return false
}
