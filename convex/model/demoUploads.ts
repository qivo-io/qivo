import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { storageIdInUse } from '../files'
import { isDemoDeployment, requireActiveDemo } from '../lib/demo'
import { forbidden, rule } from '../lib/functions'

declare const crypto: { randomUUID(): string }
export const DEMO_FILE_BYTES = 5 * 1024 * 1024
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

/** Cleanup keeps the receipt until receiving work finishes or its runtime
 * limit elapses. Late finalizers always refuse missing/expired ownership. */
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
    if (row.storage_id && (await ctx.db.system.get(row.storage_id)))
      await ctx.storage.delete(row.storage_id)
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
  const quietBefore = receipt.cleanup_file_after - 120_000
  // An unknown orphan may belong to another receiving request. Only sweep
  // the settled interval: newer jobs/files fall outside this receipt's scan.
  const workers = await ctx.db
    .query('demo_uploads')
    .withIndex('by_state_lease', (q) => q.eq('state', 'receiving').gt('lease_until', Date.now()))
    .take(1001)
  if (
    workers.length === 1001 ||
    workers.some((worker) => (worker.started_at ?? 0) <= quietBefore)
  ) {
    await ctx.db.patch(receipt._id, { cleanup_file_wait_until: Date.now() + 5000 })
    return false
  }
  const page = await ctx.db.system
    .query('_storage')
    .paginate({ cursor: receipt.cleanup_file_cursor ?? null, numItems: 64 })
  for (const file of page.page) {
    if (Math.floor(file._creationTime) > quietBefore || (await storageIdInUse(ctx, file._id)))
      continue
    const owner = await ctx.db
      .query('demo_uploads')
      .withIndex('by_storage', (q) => q.eq('storage_id', file._id))
      .unique()
    if (owner) continue
    await ctx.storage.delete(file._id)
  }
  if (!page.isDone)
    await ctx.db.patch(receipt._id, {
      cleanup_file_cursor: page.continueCursor,
      cleanup_file_wait_until: undefined,
    })
  return page.isDone
}
