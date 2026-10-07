/* Account ownership and cleanup shared by settings, the storage gateway,
 * login deletion, and the orphan sweep. No organization seat grants access. */
import { components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { AppearanceMode, ImageSource } from '../lib/enums'
import { forbidden } from '../lib/functions'

export const appearanceFor = (ctx: QueryCtx, authId: string) =>
  ctx.db
    .query('account_appearance')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
    .unique()
export const customBackgroundFor = (ctx: QueryCtx, id: string) =>
  ctx.db
    .query('custom_backgrounds')
    .withIndex('by_uuid', (q) => q.eq('id', id))
    .unique()

export async function appearanceAccountExists(ctx: QueryCtx, authId: string): Promise<boolean> {
  const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: '_id', value: authId }],
  })) as { banned?: boolean; banExpires?: number | null } | null
  return !!user && !(user.banned && (user.banExpires == null || user.banExpires > Date.now()))
}

export async function requireAppearanceAccount(ctx: QueryCtx, authId: string) {
  if (!(await appearanceAccountExists(ctx, authId)))
    throw forbidden('this login is no longer available')
}

export async function customPreviewVersion(ctx: QueryCtx, image: Doc<'custom_backgrounds'>) {
  if (!image.preview_storage_id || !(await ctx.db.system.get(image.preview_storage_id))) return null
  return image.preview_version ?? 1
}

export type AppearanceSettings = {
  mode: AppearanceMode
  image_source: ImageSource
  custom_image: null | {
    id: string
    name: string
    mime: string
    width: number
    height: number
    byte_size: number
    uploaded_at: string
    preview_ready: boolean
    preview_version: number | null
  }
}

export async function appearanceSettings(
  ctx: QueryCtx,
  authId: string,
): Promise<AppearanceSettings> {
  const settings = await appearanceFor(ctx, authId)
  const image = settings?.custom_image_id
    ? await customBackgroundFor(ctx, settings.custom_image_id)
    : null
  const previewVersion =
    image && image.auth_user_id === authId ? await customPreviewVersion(ctx, image) : null
  return {
    mode: !settings || settings.mode === 'image' ? 'blue' : settings.mode,
    image_source: settings?.image_source ?? 'daily',
    custom_image:
      image && image.auth_user_id === authId
        ? {
            id: image.id,
            name: image.name,
            mime: image.mime,
            width: image.width,
            height: image.height,
            byte_size: image.byte_size,
            uploaded_at: image.uploaded_at,
            preview_ready: previewVersion !== null,
            preview_version: previewVersion,
          }
        : null,
  }
}

export async function removeCustomBackground(ctx: MutationCtx, image: Doc<'custom_backgrounds'>) {
  // storageIdInUse prevents another attachment/avatar/background adopting this
  // id for its entire lifetime. The row and its exclusive bytes die together.
  if (await ctx.db.system.get(image.storage_id)) await ctx.storage.delete(image.storage_id)
  if (image.preview_storage_id && (await ctx.db.system.get(image.preview_storage_id)))
    await ctx.storage.delete(image.preview_storage_id)
  await ctx.db.delete(image._id)
}

export async function clearAccountAppearance(ctx: MutationCtx, authId: string) {
  for (const image of await ctx.db
    .query('custom_backgrounds')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
    .collect())
    await removeCustomBackground(ctx, image)
  for (const upload of await ctx.db
    .query('background_uploads')
    .withIndex('by_auth_user', (q) => q.eq('auth_user_id', authId))
    .collect())
    await ctx.db.delete(upload._id)
  const settings = await appearanceFor(ctx, authId)
  if (settings) await ctx.db.delete(settings._id)
}
