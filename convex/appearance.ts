/* Account-owned appearance and the approved weekly Canvas image. Custom files
 * remain private and never enter platform curation. */
import { v } from 'convex/values'
import { internal } from './_generated/api'
import type { MutationCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import { storageIdInUse } from './files'
import { isDemoDeployment } from './lib/demo'
import { vAppearanceMode, vImageSource } from './lib/enums'
import {
  backgroundFileUrl,
  backgroundUploadUrl,
  FILE_TOKEN_TTL_SECONDS,
  mintFileToken,
} from './lib/fileTokens'
import { authedMutation, authedQuery, badRequest, conflict, notFound, rule } from './lib/functions'
import { validateManualImageFile, validatePanoramaDimensions } from './lib/panoramaImage'
import {
  type AppearanceSettings,
  appearanceAccountExists,
  appearanceFor,
  appearanceSettings,
  clearAccountAppearance,
  customBackgroundFor,
  customPreviewVersion,
  removeCustomBackground,
  requireAppearanceAccount,
} from './model/appearance'
import {
  beginDemoUpload,
  DEMO_FILE_BYTES,
  demoCanRead,
  demoFileExpiry,
  demoUploadFor,
  reserveDemoUpload,
  retainDemoUpload,
} from './model/demoUploads'
import { canvasImageForDate } from './panoramaImages'

declare const crypto: { randomUUID(): string }
const UPLOAD_TTL_SECONDS = 15 * 60
const ticketFor = (ctx: MutationCtx, id: string) =>
  ctx.db
    .query('background_uploads')
    .withIndex('by_uuid', (q) => q.eq('id', id))
    .unique()

async function ensureSettings(ctx: MutationCtx, authId: string) {
  const existing = await appearanceFor(ctx, authId)
  if (existing) return existing
  const id = await ctx.db.insert('account_appearance', {
    auth_user_id: authId,
    mode: 'blue',
    image_source: 'daily',
    revision: crypto.randomUUID(),
    updated_at: new Date().toISOString(),
  })
  const row = await ctx.db.get(id)
  if (!row) throw new Error('appearance settings creation failed')
  return row
}

export const get = authedQuery({
  args: {},
  handler: async (ctx): Promise<AppearanceSettings> => {
    await requireAppearanceAccount(ctx, ctx.authUserId)
    return appearanceSettings(ctx, ctx.authUserId)
  },
})

/* This reactive query is the ordinary client's sole weekly-image read. The
 * client advances its UTC selection date at each week boundary; changes to the
 * slot, default, approval or stored file still invalidate it so withdrawal removes an active image. */
export const dailyImage = authedQuery({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    await requireAppearanceAccount(ctx, ctx.authUserId)
    return canvasImageForDate(ctx, date)
  },
})

/* The anonymous HTTP feed reads only shared approved-library display data.
 * It never resolves a caller, a private background, or an organization. */
export const publicCanvas = internalQuery({
  args: { date: v.string() },
  handler: (ctx, { date }) => (isDemoDeployment() ? null : canvasImageForDate(ctx, date)),
})

export const save = authedMutation({
  args: {
    mode: vAppearanceMode,
    image_source: vImageSource,
  },
  handler: async (ctx, choices): Promise<AppearanceSettings> => {
    await requireAppearanceAccount(ctx, ctx.authUserId)
    const settings = await ensureSettings(ctx, ctx.authUserId)
    await ctx.db.patch(settings._id, { ...choices, updated_at: new Date().toISOString() })
    return appearanceSettings(ctx, ctx.authUserId)
  },
})

export const createUpload = authedMutation({
  args: { name: v.string() },
  handler: async (
    ctx,
    { name },
  ): Promise<{ ticket_id: string; upload_url: string; expires_at: number }> => {
    await requireAppearanceAccount(ctx, ctx.authUserId)
    name = name.trim()
    if (!name || name.length > 255 || /[\p{Cc}\\/]/u.test(name))
      throw badRequest(
        'choose an image filename within 255 characters, without paths or control characters',
      )
    const tickets = await ctx.db
      .query('background_uploads')
      .withIndex('by_auth_user', (q) => q.eq('auth_user_id', ctx.authUserId))
      .collect()
    let active = 0
    for (const ticket of tickets) {
      if (ticket.expires_at <= Date.now()) await ctx.db.delete(ticket._id)
      else active++
    }
    if (active >= 5) throw rule('finish or cancel an existing image upload before starting another')
    const settings = await ensureSettings(ctx, ctx.authUserId)
    const id = crypto.randomUUID()
    const exp = await demoFileExpiry(
      ctx,
      ctx.authUserId,
      Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS,
    )
    if (isDemoDeployment())
      await reserveDemoUpload(ctx, {
        authId: ctx.authUserId,
        kind: 'background',
        targetId: id,
        id,
        bytes: DEMO_FILE_BYTES,
        expiresAt: exp * 1000,
      })
    await ctx.db.insert('background_uploads', {
      id,
      auth_user_id: ctx.authUserId,
      name,
      expires_at: exp * 1000,
      expected_revision: settings.revision,
    })
    const token = await mintFileToken({
      kind: 'background_upload',
      id,
      minter: ctx.authUserId,
      exp,
    })
    return {
      ticket_id: id,
      expires_at: exp * 1000,
      upload_url: backgroundUploadUrl({ id, minter: ctx.authUserId, exp, token }),
    }
  },
})

export const cancelUpload = authedMutation({
  args: { ticket_id: v.string() },
  handler: async (ctx, { ticket_id }) => {
    await requireAppearanceAccount(ctx, ctx.authUserId)
    const ticket = await ticketFor(ctx, ticket_id)
    if (!ticket) return null
    if (ticket.auth_user_id !== ctx.authUserId) throw notFound('upload not found')
    if (isDemoDeployment()) {
      const owned = await demoUploadFor(ctx, ticket.id)
      if (owned?.state === 'pending') await ctx.db.delete(owned._id)
    }
    await ctx.db.delete(ticket._id)
    return null
  },
})

export const removeCustom = authedMutation({
  args: {},
  handler: async (ctx): Promise<AppearanceSettings> => {
    await requireAppearanceAccount(ctx, ctx.authUserId)
    const settings = await ensureSettings(ctx, ctx.authUserId)
    const image = settings.custom_image_id
      ? await customBackgroundFor(ctx, settings.custom_image_id)
      : null
    if (image && image.auth_user_id === ctx.authUserId) await removeCustomBackground(ctx, image)
    await ctx.db.patch(settings._id, {
      custom_image_id: undefined,
      image_source: 'daily',
      revision: crypto.randomUUID(),
      updated_at: new Date().toISOString(),
    })
    return appearanceSettings(ctx, ctx.authUserId)
  },
})

/* Like files.mintUrls this is one-shot: time is not a reactive dependency.
 * The returned URL is a short-lived bearer link, never a raw storage URL. */
export const mintCustomUrl = authedQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    url: string
    preview_url: string | null
    expires_at: number
    image_id: string
  } | null> => {
    await requireAppearanceAccount(ctx, ctx.authUserId)
    const settings = await appearanceFor(ctx, ctx.authUserId)
    const image = settings?.custom_image_id
      ? await customBackgroundFor(ctx, settings.custom_image_id)
      : null
    if (
      !image ||
      image.auth_user_id !== ctx.authUserId ||
      !(await ctx.db.system.get(image.storage_id))
    )
      return null
    const exp = await demoFileExpiry(
      ctx,
      ctx.authUserId,
      Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SECONDS,
    )
    const token = await mintFileToken({
      kind: 'background',
      id: image.id,
      minter: ctx.authUserId,
      exp,
    })
    const previewVersion = await customPreviewVersion(ctx, image)
    const previewToken =
      previewVersion !== null
        ? await mintFileToken({
            kind: 'background_preview',
            id: image.id,
            minter: ctx.authUserId,
            exp,
          })
        : null
    return {
      image_id: image.id,
      expires_at: exp * 1000,
      url: backgroundFileUrl({ id: image.id, minter: ctx.authUserId, exp, token }),
      preview_url:
        previewToken && previewVersion !== null
          ? backgroundFileUrl({
              id: image.id,
              minter: ctx.authUserId,
              exp,
              token: previewToken,
              preview: true,
              previewVersion,
            })
          : null,
    }
  },
})

export const uploadContext = internalQuery({
  args: { id: v.string(), minter: v.string(), exp: v.number() },
  handler: async (ctx, { id, minter, exp }): Promise<{ name: string } | null> => {
    const ticket = await ctx.db
      .query('background_uploads')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (
      !ticket ||
      ticket.auth_user_id !== minter ||
      ticket.expires_at !== exp * 1000 ||
      ticket.expires_at <= Date.now() ||
      !(await appearanceAccountExists(ctx, minter)) ||
      !(await demoCanRead(ctx, minter))
    )
      return null
    return { name: ticket.name }
  },
})

/* Only the authenticated-ticket HTTP receiver calls this, after inspecting
 * the actual bytes and storing that new request body itself. No client API
 * accepts a storage id, including for another account's unreferenced upload. */
export const finalizeUpload = internalMutation({
  args: {
    ticket_id: v.string(),
    minter: v.string(),
    storage_id: v.id('_storage'),
    width: v.number(),
    height: v.number(),
  },
  handler: async (
    ctx,
    { ticket_id, minter, storage_id, width, height },
  ): Promise<AppearanceSettings> => {
    await requireAppearanceAccount(ctx, minter)
    if (!(await demoCanRead(ctx, minter))) throw notFound('upload expired')
    const ticket = await ticketFor(ctx, ticket_id)
    if (!ticket || ticket.auth_user_id !== minter || ticket.expires_at <= Date.now())
      throw notFound('upload expired or was cancelled')
    const settings = await appearanceFor(ctx, minter)
    if (!settings || settings.revision !== ticket.expected_revision)
      throw conflict(
        'your custom image changed while this upload was running; choose the image again',
        'appearance_changed',
      )
    const file = await ctx.db.system.get(storage_id)
    if (!file) throw badRequest('the uploaded image is no longer available')
    try {
      validateManualImageFile(file.contentType, file.size)
      validatePanoramaDimensions(width, height)
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : 'choose a valid image')
    }
    if (await storageIdInUse(ctx, storage_id)) throw badRequest('this image file is already in use')
    if (isDemoDeployment()) await retainDemoUpload(ctx, ticket_id, minter, storage_id)
    const old = settings.custom_image_id
      ? await customBackgroundFor(ctx, settings.custom_image_id)
      : null
    const id = crypto.randomUUID(),
      now = new Date().toISOString()
    await ctx.db.insert('custom_backgrounds', {
      id,
      auth_user_id: minter,
      storage_id,
      name: ticket.name,
      mime: file.contentType as string,
      width,
      height,
      byte_size: file.size,
      sha256: file.sha256,
      uploaded_at: now,
    })
    await ctx.db.patch(settings._id, {
      image_source: 'custom',
      custom_image_id: id,
      revision: crypto.randomUUID(),
      updated_at: now,
    })
    await ctx.db.delete(ticket._id)
    if (old && old.auth_user_id === minter) await removeCustomBackground(ctx, old)
    await ctx.scheduler.runAfter(0, internal.backgroundPreviewProcessor.generate, {
      kind: 'custom',
      id,
      storage_id,
    })
    return appearanceSettings(ctx, minter)
  },
})

export const discardUpload = internalMutation({
  args: { storage_id: v.id('_storage') },
  handler: async (ctx, { storage_id }) => {
    if ((await ctx.db.system.get(storage_id)) && !(await storageIdInUse(ctx, storage_id)))
      await ctx.storage.delete(storage_id)
  },
})

export const gatewayCustom = internalQuery({
  args: { id: v.string(), minter: v.string(), preview: v.optional(v.boolean()) },
  handler: async (ctx, { id, minter, preview }) => {
    const image = await customBackgroundFor(ctx, id)
    if (!image || image.auth_user_id !== minter || !(await demoCanRead(ctx, minter))) return null
    const settings = await appearanceFor(ctx, minter)
    if (settings?.custom_image_id !== id || !(await appearanceAccountExists(ctx, minter)))
      return null
    if (preview)
      return image.preview_storage_id
        ? {
            storage_id: image.preview_storage_id,
            name: 'background-preview.webp',
            mime: 'image/webp',
          }
        : null
    return { storage_id: image.storage_id, name: image.name, mime: image.mime }
  },
})

/* Auth API hooks and raw adapter deletion paths share the same cleanup. */
export const clearForDeletedLogin = internalMutation({
  args: { auth_user_id: v.string() },
  handler: async (ctx, { auth_user_id }) => clearAccountAppearance(ctx, auth_user_id),
})

export const beginDemoUploadWork = internalMutation({
  args: { id: v.string(), minter: v.string() },
  handler: async (ctx, { id, minter }) => {
    if (!isDemoDeployment()) return null
    const ticket = await ticketFor(ctx, id)
    if (!ticket || ticket.auth_user_id !== minter) throw notFound('upload not found')
    await beginDemoUpload(ctx, id, minter)
    return null
  },
})
