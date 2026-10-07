/* Re-encode large PNG/JPEG uploads to WebP only when the result is smaller.
   APNG, GIF and SVG pass through to preserve animation/vector content; other
   formats are untouched. Decode, canvas or codec failures keep the original.
   Preserve dimensions below MAX_EDGE so ordinary screenshots stay readable.
   Pure decisions are separate from browser encoding for hermetic tests. */

/** Types worth re-encoding. Order is irrelevant; membership is the contract. */
export const COMPRESSIBLE = ['image/png', 'image/jpeg'] as const

/** WebP quality. 0.82 is where UI screenshots stop shrinking usefully and
    start showing ringing around text. */
export const WEBP_QUALITY = 0.82

/** Longest edge kept as-is. Beyond this a capture is a full-page or
    multi-monitor grab, where a resize wins more than it costs. */
export const MAX_EDGE = 4096

/** Below this, re-encoding is noise — and small PNGs are the ones most
    likely to come back bigger. */
export const MIN_BYTES = 16 * 1024

/** Does this file get re-encoded at all? Pure — the whole gate in one place.
    Note this is the MIME half only; PNG needs the APNG check below too. */
export function shouldCompress(type: string | null | undefined, size: number): boolean {
  const t = (type || '').toLowerCase().split(';')[0].trim()
  return (COMPRESSIBLE as readonly string[]).includes(t) && size >= MIN_BYTES
}

/** Offset of a PNG chunk type in the head of a file, or -1. Starts past the
    8-byte signature so the search cannot match it. */
function findChunk(bytes: Uint8Array, type: string, from = 8): number {
  const a = type.charCodeAt(0),
    b = type.charCodeAt(1),
    c = type.charCodeAt(2),
    d = type.charCodeAt(3)
  for (let i = from; i + 3 < bytes.length; i++) {
    if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return i
  }
  return -1
}

/** APNG shares PNG's MIME type but must bypass canvas to preserve animation.
    Its required acTL chunk precedes the first IDAT; inspect that ordering. */
export function hasApngMarker(bytes: Uint8Array): boolean {
  const actl = findChunk(bytes, 'acTL')
  if (actl < 0) return false
  const idat = findChunk(bytes, 'IDAT')
  return idat < 0 || actl < idat
}

/** Target dimensions: identity below MAX_EDGE, else scaled to fit with the
    aspect ratio preserved. Pure. Never returns a zero edge. */
export function fitWithin(
  w: number,
  h: number,
  maxEdge: number = MAX_EDGE,
): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 }
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { w, h }
  const scale = maxEdge / longest
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) }
}

/** Re-extension for the WebP that comes out. Keeps the stem (the description
    editor already gave clipboard images a readable name) and never doubles up
    a suffix. Pure. */
export function webpName(name: string): string {
  const stem = (name || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return `${stem || 'image'}.webp`
}

/** Encode a bitmap to a WebP blob, preferring OffscreenCanvas and falling
    back to a detached <canvas>. Resolves null if the browser will not emit
    WebP (the caller then keeps the original). */
async function encodeWebp(bitmap: ImageBitmap, w: number, h: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(w, h)
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await off.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY })
    return blob && blob.type === 'image/webp' ? blob : null
  }
  if (typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, w, h)
  return await new Promise<Blob | null>((resolve) => {
    cv.toBlob((b) => resolve(b && b.type === 'image/webp' ? b : null), 'image/webp', WEBP_QUALITY)
  })
}

/* ---- profile pictures ------------------------------------------------- */

/** Types the picture picker accepts. WebP is here (unlike COMPRESSIBLE) because
    an avatar is re-encoded for its SIZE, not its codec, so one that arrives
    already-WebP still gets scaled down. */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Longest edge kept for a profile picture. Avatars are drawn between 17 and
    28 CSS px, so 256 covers every size at 4x and leaves room to grow; the
    result is normally 10–30 KB, which matters because these are fetched on
    essentially every screen. */
export const AVATAR_EDGE = 256

/** Re-encode a profile picture: scaled to fit AVATAR_EDGE, WebP, always.
    Deliberately unlike `compressImage` on two points, both because an avatar
    is a 22-pixel circle rather than something someone attached on purpose:

      · no MIN_BYTES floor — the point is the pixel size, not the byte size, so
        even a small file gets scaled down to the avatar bound.
      · GIF goes in. `compressImage` excludes it to protect its animation;
        here a still first frame IS the desired output, and passing a 2 MB
        animated GIF through to be drawn on every card is the worse outcome.

    Keeps the module's other rule: never hand back something bigger than what
    arrived, and never throw — any failure resolves to the original file, which
    the caller uploads as-is (Storage caps the bucket at 2 MB regardless). */
export async function avatarImage(file: File): Promise<File> {
  if (!file) return file
  const type = (file.type || '').toLowerCase().split(';')[0].trim()
  if (!(AVATAR_TYPES as readonly string[]).includes(type)) return file
  if (typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap | null = null
  try {
    // from-image so a phone JPEG's EXIF rotation is baked in rather than lost
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const { w, h } = fitWithin(bitmap.width, bitmap.height, AVATAR_EDGE)
    if (!w || !h) return file
    const blob = await encodeWebp(bitmap, w, h)
    if (!blob) return file
    // a scale-down is worth keeping even when the bytes went up (a tiny
    // lossless icon can); an unscaled re-encode is not
    const resized = w !== bitmap.width || h !== bitmap.height
    if (!resized && blob.size >= file.size) return file
    return new File([blob], webpName(file.name), {
      type: 'image/webp',
      lastModified: file.lastModified,
    })
  } catch {
    return file
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close()
  }
}

/** Re-encode one file, or hand back exactly what came in. Safe to call more
    than once on the same file: the output is WebP, which is not compressible,
    so a second pass is a no-op. `addAttachment` compresses before checking
    the organization limit and uploading. */
export async function compressImage(file: File): Promise<File> {
  if (!file || !shouldCompress(file.type, file.size)) return file
  if (typeof createImageBitmap !== 'function') return file
  // APNG arrives as image/png and would come back as a still — 64 KB is far
  // past where acTL can legally sit (it precedes the first IDAT, and the
  // chunks before it are tiny), so this reads a fraction of the file
  if (file.type.toLowerCase().startsWith('image/png')) {
    try {
      if (hasApngMarker(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()))) return file
    } catch {
      /* unreadable head: fall through, the encode guards itself */
    }
  }
  let bitmap: ImageBitmap | null = null
  try {
    // from-image so a phone JPEG's EXIF rotation is baked in rather than lost
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const { w, h } = fitWithin(bitmap.width, bitmap.height)
    if (!w || !h) return file
    const blob = await encodeWebp(bitmap, w, h)
    // never hand back something bigger than what arrived
    if (!blob || blob.size >= file.size) return file
    return new File([blob], webpName(file.name), {
      type: 'image/webp',
      lastModified: file.lastModified,
    })
  } catch {
    return file
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close()
  }
}
