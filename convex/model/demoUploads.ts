import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { storageIdInUse } from '../files'
import { isDemoDeployment, requireActiveDemo } from '../lib/demo'
import { forbidden, rule } from '../lib/functions'
import { eraseFile } from './fileHolds'

declare const crypto: { randomUUID(): string }

export { DEMO_FILE_BYTES } from '../lib/limits'
export const DEMO_STORAGE_BYTES = 50 * 1024 * 1024
export const DEMO_PREVIEW_BYTES = 1024 * 1024
export const DEMO_UPLOAD_LEASE_MS = 2 * 60 * 1000
export const DEMO_PROCESSOR_LEASE_MS = 11 * 60 * 1000

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

export async function reserveDemoUpload(
  ctx: MutationCtx,
  args: {
    authId: string
    kind: Doc<'demo_uploads'>['kind']
    targetId: string
    bytes: number
    id?: string
    expiresAt?: number
  },
) {
  const receipt = await requireActiveDemo(ctx, args.authId)
  const rows = await ctx.db
    .query('demo_uploads')
    .withIndex('by_demo', (q) => q.eq('demo_id', receipt.id))
    .take(201)
  let reserved = 0,
    count = 0
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
  if (count >= 200 || reserved + args.bytes > DEMO_STORAGE_BYTES)
    throw rule('The demo can store up to 50 MiB. Remove a file before uploading another.')
  const id = args.id ?? crypto.randomUUID()
  const expiresAt = Math.min(args.expiresAt ?? Date.now() + 10 * 60 * 1000, receipt.expires_at)
  await ctx.db.insert('demo_uploads', {
    id,
    demo_id: receipt.id,
    auth_user_id: args.authId,
    kind: args.kind,
    target_id: args.targetId,
    reserved_bytes: args.bytes,
    expires_at: expiresAt,
    state: 'pending',
  })
  return { id, expiresAt }
}

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
    throw rule('This file exceeds the demo upload limit.')
  const receipt = await requireActiveDemo(ctx, authId)
  await ctx.db.patch(ticket._id, {
    state: 'stored',
    storage_id: storageId,
    reserved_bytes: meta.size,
    lease_until: undefined,
    expires_at: receipt.expires_at,
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
