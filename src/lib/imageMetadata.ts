/** The editable credits carried by Windows' Title, Subject and Authors fields. */
export type ImageMetadata = {
  title?: string
  location?: string
  creator?: string
}

const EXIF_HEADER = 'Exif\0\0'
const PNG_HEADER = '\x89PNG\r\n\x1a\n'

function startsWith(bytes: Uint8Array, value: string, offset = 0): boolean {
  return [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
}

/** Only inspect the main TIFF directory. Thumbnail and camera maker-note
 * directories cannot supply credits, so their offsets never need following. */
function readExif(bytes: Uint8Array): ImageMetadata {
  if (startsWith(bytes, EXIF_HEADER)) bytes = bytes.subarray(EXIF_HEADER.length)
  if (bytes.length < 8) return {}
  const littleEndian = startsWith(bytes, 'II')
  if (!littleEndian && !startsWith(bytes, 'MM')) return {}
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(2, littleEndian) !== 42) return {}
  const directory = view.getUint32(4, littleEndian)
  if (directory < 8 || directory + 2 > bytes.length) return {}
  const count = view.getUint16(directory, littleEndian)
  const metadata: ImageMetadata = {}
  const fallback: ImageMetadata = {}
  for (let index = 0; index < count; index++) {
    const entry = directory + 2 + index * 12
    if (entry + 12 > bytes.length) break
    const tag = view.getUint16(entry, littleEndian)
    const field =
      tag === 0x9c9b || tag === 0x010e
        ? 'title'
        : tag === 0x9c9f
          ? 'location'
          : tag === 0x9c9d || tag === 0x013b
            ? 'creator'
            : undefined
    if (!field) continue
    const windows = tag >= 0x9c9b
    const format = view.getUint16(entry + 2, littleEndian)
    // XP fields are BYTE arrays containing UTF-16LE, even in big-endian TIFF.
    // Conventional ImageDescription and Artist are null-terminated ASCII.
    if (format !== (windows ? 1 : 2)) continue
    const length = view.getUint32(entry + 4, littleEndian)
    const offset = length <= 4 ? entry + 8 : view.getUint32(entry + 8, littleEndian)
    if (!length || offset + length > bytes.length || (windows && length % 2 !== 0)) continue
    try {
      const value = new TextDecoder(windows ? 'utf-16le' : 'utf-8', { fatal: true })
        .decode(bytes.subarray(offset, offset + length))
        .replace(/\0.*$/s, '')
        .trim()
      if (value) (windows ? metadata : fallback)[field] = value
    } catch {
      // Invalid text in one field must not discard the remaining credits.
    }
  }
  return { ...fallback, ...metadata }
}

/** Read EXIF credits from JPEG, PNG and WebP without decoding their pixels.
 * Metadata is optional: malformed/truncated chunks return whatever valid fields
 * were already found, and never prevent the operator from uploading an image.
 * Windows XP tags take precedence over ImageDescription/Artist fallbacks.
 * Text stays plain data; nothing from the image is interpreted as markup. */
export function readImageMetadata(bytes: Uint8Array): ImageMetadata {
  const metadata: ImageMetadata = {}
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (startsWith(bytes, '\xff\xd8')) {
      let offset = 2
      while (offset + 1 < bytes.length && bytes[offset] === 0xff) {
        while (bytes[offset] === 0xff) offset++
        const marker = bytes[offset++]
        // The compressed scan cannot contain metadata segments.
        if (marker === 0xda || marker === 0xd9) break
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
        if (offset + 2 > bytes.length) break
        const length = view.getUint16(offset)
        if (length < 2 || offset + length > bytes.length) break
        const payload = bytes.subarray(offset + 2, offset + length)
        if (marker === 0xe1 && startsWith(payload, EXIF_HEADER)) {
          Object.assign(metadata, readExif(payload))
        }
        offset += length
      }
    } else if (startsWith(bytes, PNG_HEADER)) {
      let offset = 8
      while (offset + 12 <= bytes.length) {
        const length = view.getUint32(offset)
        if (offset + 12 + length > bytes.length) break
        if (startsWith(bytes, 'eXIf', offset + 4)) {
          Object.assign(metadata, readExif(bytes.subarray(offset + 8, offset + 8 + length)))
        }
        if (startsWith(bytes, 'IEND', offset + 4)) break
        offset += length + 12 // length, type, payload and CRC
      }
    } else if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8)) {
      const end = Math.min(bytes.length, view.getUint32(4, true) + 8)
      let offset = 12
      while (offset + 8 <= end) {
        const length = view.getUint32(offset + 4, true)
        if (offset + 8 + length > end) break
        if (startsWith(bytes, 'EXIF', offset)) {
          Object.assign(metadata, readExif(bytes.subarray(offset + 8, offset + 8 + length)))
        }
        offset += 8 + length + (length % 2) // RIFF chunks have even-byte padding
      }
    }
  } catch {
    // Prefilling is a convenience, never an upload prerequisite.
  }
  return metadata
}
