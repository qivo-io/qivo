/* Pure image suitability rules shared by the browser and Convex ingestion.
 * These are limits for the delivered image. Providers may screen originals
 * more strictly before fetching a resized rendition. */
export const PANORAMA_MAX_BYTES = 8 * 1024 * 1024
export const PANORAMA_MIN_WIDTH = 1600
export const PANORAMA_MIN_HEIGHT = 800
export const PANORAMA_MIN_RATIO = 1.3
export const PANORAMA_MAX_RATIO = 3
export const PANORAMA_MAX_PIXELS = 32_000_000
export const PANORAMA_IMAGE_REQUIREMENTS =
  'JPEG, at least 1600 × 800 pixels, landscape ratio 1.3:1–3:1, up to 32 megapixels and 8 MB'
export const MANUAL_IMAGE_REQUIREMENTS =
  'JPEG, PNG or WebP, at least 1600 × 800 pixels, landscape ratio 1.3:1–3:1, up to 32 megapixels and 8 MB, still images only'

export function validateManualImageFile(mime: string | undefined, size: number) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime ?? ''))
    throw new Error('Choose a JPEG, PNG or WebP image.')
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error('The image file is empty or has an invalid size.')
  if (size > PANORAMA_MAX_BYTES) throw new Error('Choose an image no larger than 8 MB.')
}

/* Header inspection bounds the pixels before browser decoding. It does not
 * replace complete decoding or human content/license review. */
export function manualImageDimensions(bytes: Uint8Array, mime: string) {
  validateManualImageFile(mime, bytes.byteLength)
  if (mime === 'image/jpeg') return jpegDimensions(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const signature = (offset: number, value: string) =>
    Array.from(value).every((c, i) => bytes[offset + i] === c.charCodeAt(0))
  let dimensions: { width: number; height: number } | undefined
  if (mime === 'image/png') {
    if (
      bytes.length < 33 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) ||
      view.getUint32(8) !== 13 ||
      !signature(12, 'IHDR')
    )
      throw new Error('The file is not a valid PNG image.')
    dimensions = { width: view.getUint32(16), height: view.getUint32(20) }
    let offset = 8
    let ended = false
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset)
      if (size > bytes.length - offset - 12) throw new Error('The PNG image is truncated.')
      if (signature(offset + 4, 'acTL'))
        throw new Error('Choose a still image. Animated PNG is not supported.')
      if (signature(offset + 4, 'IEND')) {
        if (size !== 0 || offset + 12 !== bytes.length)
          throw new Error('The PNG image has an invalid ending.')
        ended = true
        break
      }
      offset += size + 12
    }
    if (!ended) throw new Error('The PNG image is truncated.')
  } else {
    if (
      bytes.length < 20 ||
      !signature(0, 'RIFF') ||
      !signature(8, 'WEBP') ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      throw new Error('The file is not a valid WebP image.')
    const read24 = (offset: number) =>
      bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16)
    let offset = 12
    let bitstream = false
    while (offset + 8 <= bytes.length) {
      const size = view.getUint32(offset + 4, true)
      const data = offset + 8
      if (size > bytes.length - data) throw new Error('The WebP image is truncated.')
      if (signature(offset, 'ANIM') || signature(offset, 'ANMF'))
        throw new Error('Choose a still image. Animated WebP is not supported.')
      if (signature(offset, 'VP8X')) {
        // The extended header precedes all image data. A later/repeated one
        // must not replace a frame's dimensions with a smaller canvas.
        if (size !== 10 || offset !== 12 || dimensions || bitstream)
          throw new Error('The WebP image has an invalid header.')
        if (bytes[data] & 2)
          throw new Error('Choose a still image. Animated WebP is not supported.')
        dimensions = { width: 1 + read24(data + 4), height: 1 + read24(data + 7) }
        validatePanoramaDimensions(dimensions.width, dimensions.height)
      } else if (signature(offset, 'VP8 ')) {
        if (
          bitstream ||
          size < 10 ||
          bytes[data] & 1 ||
          ![0x9d, 0x01, 0x2a].every((b, i) => bytes[data + 3 + i] === b)
        )
          throw new Error('The WebP image has an invalid frame.')
        const frame = {
          width: view.getUint16(data + 6, true) & 0x3fff,
          height: view.getUint16(data + 8, true) & 0x3fff,
        }
        validatePanoramaDimensions(frame.width, frame.height)
        if (dimensions && (dimensions.width !== frame.width || dimensions.height !== frame.height))
          throw new Error('The WebP image dimensions do not match its frame.')
        dimensions = frame
        bitstream = true
      } else if (signature(offset, 'VP8L')) {
        if (bitstream || size < 5 || bytes[data] !== 0x2f || bytes[data + 4] & 0xe0)
          throw new Error('The WebP image has an invalid lossless frame.')
        const bits = view.getUint32(data + 1, true)
        const frame = { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
        validatePanoramaDimensions(frame.width, frame.height)
        if (dimensions && (dimensions.width !== frame.width || dimensions.height !== frame.height))
          throw new Error('The WebP image dimensions do not match its frame.')
        dimensions = frame
        bitstream = true
      }
      offset = data + size + (size % 2)
    }
    if (!bitstream || offset !== bytes.length) throw new Error('The WebP image has no valid frame.')
  }
  if (!dimensions) throw new Error('The image has no supported frame.')
  validatePanoramaDimensions(dimensions.width, dimensions.height)
  return dimensions
}

export function validatePanoramaFile(mime: string | undefined, size: number) {
  if (mime !== 'image/jpeg')
    throw new Error('Choose a JPEG image. Other formats are not supported.')
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error('The image file is empty or has an invalid size.')
  if (size > PANORAMA_MAX_BYTES) throw new Error('Choose a JPEG no larger than 8 MB.')
}

export function validatePanoramaDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    throw new Error('The image has invalid pixel dimensions.')
  if (width < PANORAMA_MIN_WIDTH || height < PANORAMA_MIN_HEIGHT)
    throw new Error(`This image is ${width} × ${height} pixels; choose at least 1600 × 800 pixels.`)
  const ratio = width / height
  if (ratio < PANORAMA_MIN_RATIO || ratio > PANORAMA_MAX_RATIO)
    throw new Error(
      `This ${width} × ${height} image has an unsuitable aspect ratio; choose a landscape ratio between 1.3:1 and 3:1.`,
    )
  if (width * height > PANORAMA_MAX_PIXELS)
    throw new Error('This image exceeds 32 megapixels. Choose a smaller rendition.')
}

/* Read the actual JPEG frame dimensions rather than trusting a remote MIME
 * header, URL or thumbnail's nominal metadata. SVG/HTML/animated formats do
 * not enter the library. A browser decodes the stored JPEG during review. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('the downloaded file is not a JPEG image')
  }
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('invalid JPEG marker')
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = bytes[offset] * 256 + bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) throw new Error('truncated JPEG image')
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw new Error('invalid JPEG frame')
      const height = bytes[offset + 3] * 256 + bytes[offset + 4]
      const width = bytes[offset + 5] * 256 + bytes[offset + 6]
      validatePanoramaDimensions(width, height)
      return { width, height }
    }
    offset += length
  }
  throw new Error('JPEG image has no supported frame')
}
