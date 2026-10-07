'use node'

import { v } from 'convex/values'
import sharp from 'sharp'
import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction } from './_generated/server'
import {
  BACKGROUND_PREVIEW_QUALITY,
  BACKGROUND_PREVIEW_VERSION,
  BACKGROUND_PREVIEW_WIDTH,
  backgroundPreviewArgs,
} from './lib/backgroundPreviews'
import { PANORAMA_MAX_PIXELS } from './lib/panoramaImage'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
  readonly size: number
  readonly type: string
}

/** Fully decode accepted formats, honor camera orientation, strip metadata,
 * retain aspect ratio and produce a small static WebP without enlarging. */
export async function compressedBackgroundPreview(bytes: Uint8Array): Promise<Uint8Array> {
  return sharp(bytes, { limitInputPixels: PANORAMA_MAX_PIXELS, failOn: 'error' })
    .rotate()
    .resize({ width: BACKGROUND_PREVIEW_WIDTH, withoutEnlargement: true })
    .webp({ quality: BACKGROUND_PREVIEW_QUALITY, effort: 4 })
    .toBuffer()
}

export const generate = internalAction({
  args: { ...backgroundPreviewArgs, attempt: v.optional(v.number()) },
  handler: async (
    ctx,
    { attempt = 0, ...args },
  ): Promise<'skipped' | 'ready' | 'discarded' | 'failed'> => {
    let previewId: Id<'_storage'> | undefined
    let demoWork: { id: string; authId: string } | null = null
    try {
      if (!(await ctx.runQuery(internal.backgroundPreviews.source, args))) return 'skipped'
      if (process.env.APP_MODE === 'demo' && args.kind === 'custom') {
        demoWork = await ctx.runMutation(internal.backgroundPreviews.beginDemoWork, args)
        if (!demoWork) return 'skipped'
      }
      const original = await ctx.storage.get(args.storage_id)
      if (!original) return 'skipped'
      const bytes = new Uint8Array(
        await (
          original as Blob & {
            arrayBuffer(): Promise<ArrayBuffer>
          }
        ).arrayBuffer(),
      )
      let preview: Uint8Array
      try {
        preview = await compressedBackgroundPreview(bytes)
      } catch {
        console.warn('Background preview could not decode image', args.kind, args.id)
        return 'failed'
      }
      previewId = await ctx.storage.store(new Blob([preview], { type: 'image/webp' }) as never)
      const retained = await ctx.runMutation(internal.backgroundPreviews.attach, {
        ...args,
        preview_storage_id: previewId,
        preview_version: BACKGROUND_PREVIEW_VERSION,
        ...(demoWork ? { demo_ticket_id: demoWork.id } : {}),
      })
      return retained ? 'ready' : 'discarded'
    } catch {
      // A lost acknowledgment can follow a successful attachment. Reuse the
      // reference-aware cleanup rather than deleting potentially adopted bytes.
      if (previewId)
        await ctx
          .runMutation(internal.panoramaImages.discardImport, {
            storage_id: previewId,
          })
          .catch(() => {})
      if (attempt < 2)
        await ctx.scheduler.runAfter(
          1000 * 2 ** attempt,
          internal.backgroundPreviewProcessor.generate,
          {
            ...args,
            attempt: attempt + 1,
          },
        )
      console.warn('Background preview generation failed', args.kind, args.id)
      return 'failed'
    } finally {
      if (demoWork)
        await ctx
          .runMutation(internal.demoUploads.abandon, {
            id: demoWork.id,
            minter: demoWork.authId,
            storage_id: previewId,
          })
          .catch(() => {})
    }
  },
})
