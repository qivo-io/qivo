import { v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import { storageIdInUse } from './files'
import {
  DEMO_MAX_SESSIONS,
  demoAdmissionOpen,
  demoForAuth,
  isDemoDeployment,
  requireDemoDeployment,
} from './lib/demo'
import { forbidden } from './lib/functions'
import {
  beginDemoUpload,
  checkStoredFiles,
  demoCanRead,
  demoUploadFor,
  retainDemoUpload,
} from './model/demoUploads'
import { eraseFile } from './model/fileHolds'

/** Only the HTTP auth handler calls this; callers cannot select a window or
 * a limit. Global quotas remain effective with spoofed forwarding headers. */
export const admit = internalMutation({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    requireDemoDeployment()
    if (!demoAdmissionOpen()) return false
    const now = Date.now()
    const windows = [
      { size: 60_000, limit: 10 },
      { size: 86_400_000, limit: 250 },
    ]
    const counters = []
    for (const window of windows) {
      const start = Math.floor(now / window.size) * window.size
      const key = `${window.size}:${start}`
      const row = await ctx.db
        .query('demo_admission')
        .withIndex('by_key', (q) => q.eq('key', key))
        .unique()
      if ((row?.count ?? 0) >= window.limit) return false
      counters.push({ row, key, expires_at: start + window.size, count: (row?.count ?? 0) + 1 })
    }
    // Includes overdue receipts: an unhealthy cleanup service cannot keep
    // growing storage by admitting replacements for expired workspaces.
    if (
      (await ctx.db.query('demo_sessions').take(DEMO_MAX_SESSIONS + 1)).length >= DEMO_MAX_SESSIONS
    )
      return false
    for (const { row, ...value } of counters) {
      if (row) await ctx.db.patch(row._id, { count: value.count })
      else await ctx.db.insert('demo_admission', value)
    }
    return true
  },
})

export const begin = internalMutation({
  args: { id: v.string(), minter: v.string(), exp: v.number() },
  handler: async (ctx, { id, minter, exp }) => {
    const ticket = await demoUploadFor(ctx, id)
    if (
      !ticket ||
      ticket.expires_at !== exp * 1000 ||
      (ticket.kind !== 'attachment' && ticket.kind !== 'avatar')
    )
      throw forbidden('This demo upload has expired.')
    await beginDemoUpload(ctx, id, minter)
    return { maxBytes: ticket.reserved_bytes }
  },
})

export const finish = internalMutation({
  args: { id: v.string(), minter: v.string(), storage_id: v.id('_storage') },
  handler: async (ctx, { id, minter, storage_id }) => {
    if (await storageIdInUse(ctx, storage_id)) throw forbidden('This file is already in use.')
    await retainDemoUpload(ctx, id, minter, storage_id)
    return { storageId: storage_id }
  },
})

export const abandon = internalMutation({
  args: { id: v.string(), minter: v.string(), storage_id: v.optional(v.id('_storage')) },
  handler: async (ctx, { id, minter, storage_id }) => {
    const ticket = await demoUploadFor(ctx, id)
    if (ticket && ticket.auth_user_id !== minter) throw forbidden('Upload owner mismatch.')
    // A lost response can follow a successful finish. Preserve those bytes
    // for the caller's retry or the demo's scheduled cleanup.
    if (ticket?.state === 'stored') return null
    if (storage_id && !(await storageIdInUse(ctx, storage_id))) await eraseFile(ctx, storage_id)
    if (ticket) await ctx.db.delete(ticket._id)
    return null
  },
})

/** The cron's call has no arguments. A leg it schedules passes `after`, the
 * progress it was scheduled for, and does nothing once a later run moved
 * that progress, so one chain continues at most. `cursor` is the argument of
 * a leg the previous release queued, from a scan of all files; the next cron
 * run covers its files, so that leg does nothing. */
export const sweep = internalMutation({
  args: { cursor: v.optional(v.string()), after: v.optional(v.number()) },
  handler: async (ctx, { cursor, after }): Promise<null> => {
    if (!isDemoDeployment() || cursor !== undefined) return null
    const progress = await ctx.db.query('demo_upload_sweeps').first()
    if (after !== undefined && progress?.checked_through !== after) return null
    const now = Date.now()
    for (const row of await ctx.db
      .query('demo_admission')
      .withIndex('by_expiry', (q) => q.lte('expires_at', now))
      .take(100))
      await ctx.db.delete(row._id)
    // Pending/unattached bytes are reclaimed promptly without waiting 24h.
    for (const ticket of await ctx.db
      .query('demo_uploads')
      .withIndex('by_expiry', (q) => q.lte('expires_at', now))
      .take(100)) {
      if (ticket.state === 'receiving' && (ticket.lease_until ?? 0) > now) continue
      if (
        ticket.storage_id &&
        (await storageIdInUse(ctx, ticket.storage_id)) &&
        (await demoCanRead(ctx, ticket.auth_user_id))
      ) {
        const receipt = await demoForAuth(ctx, ticket.auth_user_id)
        if (receipt) await ctx.db.patch(ticket._id, { expires_at: receipt.expires_at })
        continue
      }
      if (ticket.storage_id) await eraseFile(ctx, ticket.storage_id)
      await ctx.db.delete(ticket._id)
    }
    // Storage writes and metadata commits cross an action boundary. A crash
    // there leaves no id in the ledger (model/demoUploads.ts checkStoredFiles).
    const { through, full } = await checkStoredFiles(ctx, progress)
    if (full) await ctx.scheduler.runAfter(1000, internal.demoUploads.sweep, { after: through })
    return null
  },
})
