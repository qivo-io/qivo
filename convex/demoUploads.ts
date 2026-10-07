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
import { beginDemoUpload, demoCanRead, demoUploadFor, retainDemoUpload } from './model/demoUploads'

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
    if (
      storage_id &&
      (await ctx.db.system.get(storage_id)) &&
      !(await storageIdInUse(ctx, storage_id))
    )
      await ctx.storage.delete(storage_id)
    if (ticket) await ctx.db.delete(ticket._id)
    return null
  },
})

export const sweep = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }): Promise<null> => {
    if (!isDemoDeployment()) return null
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
      if (ticket.storage_id && (await ctx.db.system.get(ticket.storage_id)))
        await ctx.storage.delete(ticket.storage_id)
      await ctx.db.delete(ticket._id)
    }
    // Storage writes and metadata commits cross an action boundary. A crash
    // there leaves no id in the ledger, so enumerate bounded storage pages.
    const workers = await ctx.db
      .query('demo_uploads')
      .withIndex('by_state_lease', (q) => q.eq('state', 'receiving').gt('lease_until', now))
      .take(1001)
    const safeBefore =
      workers.length === 1001
        ? 0
        : Math.min(now - 120_000, ...workers.map((worker) => worker.started_at ?? 0))
    const page = await ctx.db.system
      .query('_storage')
      .paginate({ cursor: cursor ?? null, numItems: 64 })
    for (const file of page.page) {
      if (file._creationTime >= safeBefore || (await storageIdInUse(ctx, file._id))) continue
      const ticket = await ctx.db
        .query('demo_uploads')
        .withIndex('by_storage', (q) => q.eq('storage_id', file._id))
        .unique()
      if (ticket && ticket.expires_at > now) continue
      await ctx.storage.delete(file._id)
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(1000, internal.demoUploads.sweep, {
        cursor: page.continueCursor,
      })
    return null
  },
})
