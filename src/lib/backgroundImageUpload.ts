import {
  jpegDimensions,
  manualImageDimensions,
  validateManualImageFile,
  validatePanoramaDimensions,
  validatePanoramaFile,
} from '../../convex/lib/panoramaImage'
import { createBackgroundPreview } from './backgroundPreview'
import { type ImageMetadata, readImageMetadata } from './imageMetadata'

type ImageCredits = { title: string; creator: string; location?: string }

/** Validate the original before decoding it. Bulk imports require embedded
 * credits; a filename or another image's edited credits cannot supply them. */
export async function prepareBackgroundImage(
  file: File,
  options: { jpegOnly?: boolean; requireCredits?: boolean; preview?: boolean } = {},
) {
  if (options.jpegOnly) validatePanoramaFile(file.type, file.size)
  else validateManualImageFile(file.type, file.size)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (options.jpegOnly) jpegDimensions(bytes)
  else manualImageDimensions(bytes, file.type)
  const metadata = readImageMetadata(bytes)
  if (options.requireCredits && (!metadata.title || !metadata.creator)) return null
  const url = URL.createObjectURL(file)
  try {
    const decoded = new Image()
    decoded.src = url
    try {
      await decoded.decode()
    } catch {
      throw new Error('This file could not be decoded as an image. Choose another file.')
    }
    validatePanoramaDimensions(decoded.naturalWidth, decoded.naturalHeight)
    return {
      metadata,
      dimensions: { width: decoded.naturalWidth, height: decoded.naturalHeight },
      // A failed encoder leaves a placeholder, never an original-file preview.
      preview: options.preview ? await createBackgroundPreview(decoded).catch(() => null) : null,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export type BackgroundImageBatchResult = {
  added: number
  reused: number
  missingMetadata: string[]
  failed: { name: string; message: string }[]
}

export type BackgroundImageBatchProgress = { current: number; total: number; name: string }

/** Process one original at a time to bound decoded image memory and let a bad
 * file or rejected upload leave the remaining files eligible for import. */
export async function importBackgroundImages(
  files: File[],
  save: (file: File, credits: ImageCredits) => Promise<{ reused: boolean }>,
  onProgress: (progress: BackgroundImageBatchProgress) => void,
  errorMessage: (error: unknown) => string,
): Promise<BackgroundImageBatchResult> {
  const result: BackgroundImageBatchResult = {
    added: 0,
    reused: 0,
    missingMetadata: [],
    failed: [],
  }
  for (const [index, file] of files.entries()) {
    onProgress({ current: index + 1, total: files.length, name: file.name })
    try {
      const prepared = await prepareBackgroundImage(file, { requireCredits: true })
      if (!prepared) {
        result.missingMetadata.push(file.name)
        continue
      }
      const metadata = prepared.metadata as ImageMetadata & ImageCredits
      const saved = await save(file, {
        title: metadata.title.slice(0, 300),
        creator: metadata.creator.slice(0, 300),
        location: metadata.location?.slice(0, 300),
      })
      if (saved.reused) result.reused++
      else result.added++
    } catch (error) {
      result.failed.push({ name: file.name, message: errorMessage(error) })
    }
  }
  return result
}
