/* Standalone operator uploads. Source and credit are supplied by the operator;
 * no provider lookup or image download occurs. New files await human review. */
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { storageIdInUse } from './files'
import {
  badRequest,
  conflict,
  forbidden,
  platformAction,
  platformMutation,
  rule,
} from './lib/functions'
import { parseUnsplashReference } from './lib/panoramaCuration'
import { panoramaFilename } from './lib/panoramaFilename'
import {
  manualImageDimensions,
  validateManualImageFile,
  validatePanoramaDimensions,
} from './lib/panoramaImage'
import { audit } from './model/admin'
import { ensureState, imageRow, operatorEmail } from './panoramaImages'

declare const crypto: { randomUUID(): string }

const uploadArgs = {
  storage_id: v.id('_storage'),
  title: v.string(),
  location: v.optional(v.string()),
  creator: v.string(),
  rights_confirmed: v.boolean(),
  source_url: v.optional(v.string()),
}
type Upload = {
  storage_id: Id<'_storage'>
  title: string
  location?: string
  creator: string
  rights_confirmed: boolean
  source_url?: string
}
type UploadResult = { image: Awaited<ReturnType<typeof imageRow>>; reused: boolean }

function validateDetails(args: Upload) {
  if (!args.rights_confirmed)
    throw badRequest('confirm that you have permission to use this image in Qivo')
  const title = args.title.trim()
  const creator = args.creator.trim()
  const location = args.location?.trim() || undefined
  if (!title || title.length > 300 || !creator || creator.length > 300)
    throw badRequest('provide the image title and creator, each within 300 characters')
  if (location && location.length > 300)
    throw badRequest('keep the image location within 300 characters')
  let source_url = args.source_url?.trim() || ''
  let source_id: string | undefined
  if (source_url) {
    if (source_url.length > 2048 || !/^https:\/\/[^\s/@:?#]+(?:[/?#][^\s]*)?$/.test(source_url))
      throw badRequest('use an HTTPS source URL or leave the source blank')
    let url: URL
    try {
      url = new URL(source_url)
    } catch {
      throw badRequest('use a valid HTTPS source URL')
    }
    if (url.hostname === 'unsplash.com' || url.hostname === 'www.unsplash.com') {
      const source = parseUnsplashReference(source_url)
      source_url = source.source_url
      source_id = source.source_id
    }
  }
  return { title, location, creator, source_url, source_id }
}

async function requireOperator(ctx: MutationCtx, authId: string) {
  if (
    !(await ctx.db
      .query('platform_admins')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
      .first())
  )
    throw forbidden('not a platform operator')
}

export const uploadUrl = platformMutation({
  args: {},
  handler: (ctx) => ctx.storage.generateUploadUrl(),
})

export const addFile = platformAction({
  args: uploadArgs,
  handler: async (ctx, args): Promise<UploadResult> => {
    try {
      validateDetails(args)
      const file = await ctx.storage.get(args.storage_id)
      if (!file) throw badRequest('the uploaded image file is no longer available')
      let dimensions: { width: number; height: number }
      try {
        validateManualImageFile(file.type, file.size)
        const bytes = new Uint8Array(
          await (file as Blob & { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer(),
        )
        dimensions = manualImageDimensions(bytes, file.type)
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : 'choose a valid image')
      }
      return await ctx.runMutation(internal.panoramaUploads.retainFile, {
        ...args,
        ...dimensions,
        auth_user_id: ctx.operator.auth_user_id,
      })
    } catch (error) {
      // A committed upload can outlive a lost acknowledgment. Reference-aware
      // cleanup must never delete a file already used elsewhere.
      await ctx
        .runMutation(internal.panoramaImages.discardImport, { storage_id: args.storage_id })
        .catch(() => {})
      throw error
    }
  },
})

export const retainFile = internalMutation({
  args: {
    ...uploadArgs,
    width: v.number(),
    height: v.number(),
    auth_user_id: v.string(),
  },
  handler: async (ctx, args): Promise<UploadResult> => {
    await requireOperator(ctx, args.auth_user_id)
    const details = validateDetails(args)
    const file = await ctx.db.system.get(args.storage_id)
    if (!file) throw badRequest('the uploaded image file is no longer available')
    try {
      validateManualImageFile(file.contentType, file.size)
      validatePanoramaDimensions(args.width, args.height)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'choose a valid image')
    }
    if (await storageIdInUse(ctx, args.storage_id)) throw badRequest('this file is already in use')
    const source_id = details.source_id ?? `upload:${file.sha256}`
    const bySource = await ctx.db
      .query('panorama_images')
      .withIndex('by_source', (q) => q.eq('source_id', source_id))
      .first()
    const byHash = await ctx.db
      .query('panorama_images')
      .withIndex('by_hash', (q) => q.eq('sha256', file.sha256))
      .first()
    // Both identities matter: a removed file cannot be smuggled in by pairing
    // it with a different, still-active source record.
    if (bySource?.status === 'removed' || byHash?.status === 'removed')
      throw rule('this image was previously removed by a human reviewer')
    const existing = bySource ?? byHash
    const email = await operatorEmail(ctx, args.auth_user_id)
    if (existing) {
      if (existing.sha256 !== file.sha256)
        throw conflict(
          'a different file is already stored for this source image',
          'source_file_changed',
        )
      if (!existing.storage_id || !(await ctx.db.system.get(existing.storage_id)))
        throw rule('the existing image file is no longer available')
      await ctx.storage.delete(args.storage_id)
      await ctx.scheduler.runAfter(0, internal.backgroundPreviewProcessor.generate, {
        kind: 'library',
        id: existing.id,
        storage_id: existing.storage_id,
      })
      await audit(ctx, {
        actor_auth_id: args.auth_user_id,
        actor_email: email,
        action: 'panorama_manual_image_added',
        detail: { image_id: existing.id, reused: true },
      })
      return { image: await imageRow(ctx, existing), reused: true }
    }
    const now = new Date().toISOString()
    const filename = panoramaFilename(details.title, details.creator, file.contentType)
    const id = await ctx.db.insert('panorama_images', {
      id: crypto.randomUUID(),
      source_id,
      source_url: details.source_url,
      download_url: '',
      title: details.title,
      location: details.location,
      creator: details.creator,
      filename,
      license: 'Permission confirmed by uploader',
      license_url: '',
      attribution: `${details.title} — ${details.creator}. ${details.source_url ? `${details.source_url}. ` : ''}Display may crop to fit.`,
      source_metadata: JSON.stringify({
        acquisition: 'operator_upload',
        source_url: details.source_url || undefined,
        rights_confirmed_by: args.auth_user_id,
        rights_confirmed_at: now,
        content_type: file.contentType,
        title: details.title,
        location: details.location,
        creator: details.creator,
        filename,
      }),
      storage_id: args.storage_id,
      sha256: file.sha256,
      byte_size: file.size,
      width: args.width,
      height: args.height,
      imported_at: now,
      status: 'pending',
    })
    const state = await ensureState(ctx)
    await ctx.db.patch(state._id, { pending: state.pending + 1 })
    const image = await ctx.db.get(id)
    if (!image) throw new Error('image registration failed')
    await ctx.scheduler.runAfter(0, internal.backgroundPreviewProcessor.generate, {
      kind: 'library',
      id: image.id,
      storage_id: args.storage_id,
    })
    await audit(ctx, {
      actor_auth_id: args.auth_user_id,
      actor_email: email,
      action: 'panorama_manual_image_added',
      detail: { image_id: image.id, source_url: details.source_url || null, reused: false },
    })
    return { image: await imageRow(ctx, image), reused: false }
  },
})
