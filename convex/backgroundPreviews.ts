/* Preview ownership and scheduling live in transactions. The Node processor
 * can finish after replacement/removal, so attachment rechecks the original. */
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { storageIdInUse } from './files'
import {
  BACKGROUND_PREVIEW_VERSION,
  backgroundPreviewArgs,
  vBackgroundKind,
} from './lib/backgroundPreviews'
import { isDemoDeployment } from './lib/demo'
import {
  beginDemoUpload,
  DEMO_PREVIEW_BYTES,
  demoCanRead,
  reserveDemoUpload,
  retainDemoUpload,
} from './model/demoUploads'

async function imageFor(ctx: QueryCtx, kind: 'library' | 'custom', id: string) {
  return kind === 'library'
    ? ctx.db
        .query('panorama_images')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
    : ctx.db
        .query('custom_backgrounds')
        .withIndex('by_uuid', (q) => q.eq('id', id))
        .unique()
}

async function currentSource(
  ctx: QueryCtx,
  args: {
    kind: 'library' | 'custom'
    id: string
    storage_id: Id<'_storage'>
  },
) {
  const image = await imageFor(ctx, args.kind, args.id)
  if (image && 'auth_user_id' in image && !(await demoCanRead(ctx, image.auth_user_id))) return null
  return image &&
    image.storage_id === args.storage_id &&
    (!('status' in image) || image.status !== 'removed') &&
    (await ctx.db.system.get(args.storage_id))
    ? image
    : null
}

async function needsPreview(
  ctx: QueryCtx,
  image: { preview_storage_id?: Id<'_storage'>; preview_version?: number },
) {
  const version = image.preview_version ?? 1
  // An older deployment must leave future versions to their own processor,
  // including recovery of a missing file; attachment refuses any downgrade.
  if (version > BACKGROUND_PREVIEW_VERSION) return false
  return (
    version < BACKGROUND_PREVIEW_VERSION ||
    !image.preview_storage_id ||
    !(await ctx.db.system.get(image.preview_storage_id))
  )
}

export const source = internalQuery({
  args: backgroundPreviewArgs,
  handler: async (ctx, args): Promise<boolean> => {
    const image = await currentSource(ctx, args)
    return !!image && (await needsPreview(ctx, image))
  },
})

export const attach = internalMutation({
  args: {
    ...backgroundPreviewArgs,
    preview_storage_id: v.id('_storage'),
    preview_version: v.number(),
    demo_ticket_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const image = await currentSource(ctx, args)
    const preview = await ctx.db.system.get(args.preview_storage_id)
    if (
      args.preview_version === BACKGROUND_PREVIEW_VERSION &&
      image?.preview_storage_id === args.preview_storage_id &&
      image.preview_version === args.preview_version &&
      preview?.contentType === 'image/webp'
    )
      return true
    const alreadyUsed = await storageIdInUse(ctx, args.preview_storage_id)
    if (
      !image ||
      !preview ||
      args.preview_version !== BACKGROUND_PREVIEW_VERSION ||
      alreadyUsed ||
      preview.contentType !== 'image/webp' ||
      (image.preview_version ?? 1) > args.preview_version ||
      !(await needsPreview(ctx, image))
    ) {
      if (preview && !alreadyUsed) await ctx.storage.delete(args.preview_storage_id)
      return false
    }
    // Keep the previous preview readable until its replacement is adopted in
    // this transaction. A competing generation will observe the new version.
    if (isDemoDeployment() && 'auth_user_id' in image) {
      if (!args.demo_ticket_id) {
        await ctx.storage.delete(args.preview_storage_id)
        return false
      }
      await retainDemoUpload(ctx, args.demo_ticket_id, image.auth_user_id, args.preview_storage_id)
    }
    const previous = image.preview_storage_id
    await ctx.db.patch(image._id, {
      preview_storage_id: args.preview_storage_id,
      preview_version: args.preview_version,
    })
    if (previous && !(await storageIdInUse(ctx, previous)) && (await ctx.db.system.get(previous)))
      await ctx.storage.delete(previous)
    return true
  },
})

/* A bounded, resumable backfill: each page queues missing or outdated derivatives and
 * schedules its successor. Safe to rerun; generation/attachment are idempotent. */
export const backfill = internalMutation({
  args: { kind: vBackgroundKind, cursor: v.optional(v.string()) },
  handler: async (ctx, { kind, cursor }): Promise<{ queued: number; isDone: boolean }> => {
    const page =
      kind === 'library'
        ? await ctx.db.query('panorama_images').paginate({ cursor: cursor ?? null, numItems: 24 })
        : await ctx.db
            .query('custom_backgrounds')
            .paginate({ cursor: cursor ?? null, numItems: 24 })
    let queued = 0
    for (const image of page.page) {
      if (
        !image.storage_id ||
        ('status' in image && image.status === 'removed') ||
        !(await ctx.db.system.get(image.storage_id)) ||
        !(await needsPreview(ctx, image))
      )
        continue
      await ctx.scheduler.runAfter(0, internal.backgroundPreviewProcessor.generate, {
        kind,
        id: image.id,
        storage_id: image.storage_id,
      })
      queued++
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(1000, internal.backgroundPreviews.backfill, {
        kind,
        cursor: page.continueCursor,
      })
    return { queued, isDone: page.isDone }
  },
})

export const beginDemoWork = internalMutation({
  args: backgroundPreviewArgs,
  handler: async (ctx, args): Promise<{ id: string; authId: string } | null> => {
    if (!isDemoDeployment() || args.kind !== 'custom') return null
    const image = await currentSource(ctx, args)
    if (!image || !('auth_user_id' in image) || !(await needsPreview(ctx, image))) return null
    const ticket = await reserveDemoUpload(ctx, {
      authId: image.auth_user_id,
      kind: 'preview',
      targetId: image.id,
      bytes: DEMO_PREVIEW_BYTES,
    })
    await beginDemoUpload(ctx, ticket.id, image.auth_user_id, true)
    return { id: ticket.id, authId: image.auth_user_id }
  },
})
