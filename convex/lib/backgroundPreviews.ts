import { v } from 'convex/values'

export const vBackgroundKind = v.union(v.literal('library'), v.literal('custom'))
export const backgroundPreviewArgs = {
  kind: vBackgroundKind,
  id: v.string(),
  storage_id: v.id('_storage'),
}

// Increment when encoding changes so the backfill can replace older previews.
export const BACKGROUND_PREVIEW_VERSION = 2
export const BACKGROUND_PREVIEW_WIDTH = 960
export const BACKGROUND_PREVIEW_QUALITY = 50
