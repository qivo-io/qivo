import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import fixture from './fixtures/background-windows-exif.json'
import { readImageMetadata } from './imageMetadata'

const originalApp1 = Uint8Array.from(atob(fixture.app1Base64), (char) => char.charCodeAt(0))
const originalTiff = originalApp1.subarray(10) // marker, length, Exif\0\0
const jpeg = (...segments: Uint8Array[]) =>
  new Uint8Array([0xff, 0xd8, ...segments.flatMap((segment) => [...segment]), 0xff, 0xd9])

function app1(tiff: Uint8Array): Uint8Array {
  const length = tiff.length + 8
  return new Uint8Array([0xff, 0xe1, length >> 8, length & 255, 69, 120, 105, 102, 0, 0, ...tiff])
}

/** Small TIFF with literal four-byte inline values, in either byte order. */
function inlineTiff(littleEndian: boolean, windows = false): Uint8Array {
  const bytes = new Uint8Array(38)
  bytes.set(littleEndian ? [73, 73] : [77, 77])
  const view = new DataView(bytes.buffer)
  view.setUint16(2, 42, littleEndian)
  view.setUint32(4, 8, littleEndian)
  view.setUint16(8, 2, littleEndian)
  for (const [index, tag] of (windows ? [0x9c9b, 0x9c9d] : [0x010e, 0x013b]).entries()) {
    const offset = 10 + index * 12
    view.setUint16(offset, tag, littleEndian)
    view.setUint16(offset + 2, windows ? 1 : 2, littleEndian)
    view.setUint32(offset + 4, 4, littleEndian)
    bytes.set(windows ? [197, 0, 0, 0] : [65, 110, 110, 0], offset + 8)
  }
  return bytes
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + payload.length)
  new DataView(bytes.buffer).setUint32(0, payload.length)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(payload, 8)
  return bytes
}

function webpChunk(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length + (payload.length % 2))
  new DataView(bytes.buffer).setUint32(4, payload.length, true)
  bytes.set(new TextEncoder().encode(type))
  bytes.set(payload, 8)
  return bytes
}

function webp(...chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  bytes.set(new TextEncoder().encode('RIFF'))
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  bytes.set(new TextEncoder().encode('WEBP'), 8)
  let offset = 12
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

describe('readImageMetadata', () => {
  it('prefills the Windows Title, Subject and Authors from the supplied Sam Lim JPEG', () => {
    expect(readImageMetadata(jpeg(originalApp1))).toEqual(fixture.expected)
  })

  it('reads the actual TIFF metadata inside PNG and WebP containers', () => {
    const png = new Uint8Array([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      ...pngChunk('eXIf', originalTiff),
      ...pngChunk('IEND', new Uint8Array()),
    ])
    expect(readImageMetadata(png)).toEqual(fixture.expected)
    expect(
      readImageMetadata(
        webp(webpChunk('JUNK', new Uint8Array([0])), webpChunk('EXIF', originalTiff)),
      ),
    ).toEqual(fixture.expected)
    expect(readImageMetadata(webp(webpChunk('EXIF', originalApp1.subarray(4))))).toEqual(
      fixture.expected,
    )
  })

  it('respects a typed-array subview when reading offsets', () => {
    const bytes = new Uint8Array([1, 2, 3, ...jpeg(originalApp1), 4, 5, 6])
    expect(readImageMetadata(bytes.subarray(3, bytes.length - 3))).toEqual(fixture.expected)
  })

  it.each([true, false])('reads inline values with littleEndian=%s', (littleEndian) => {
    expect(readImageMetadata(jpeg(app1(inlineTiff(littleEndian))))).toEqual({
      title: 'Ann',
      creator: 'Ann',
    })
    // Windows Unicode always uses UTF-16LE, independent of TIFF byte order.
    expect(readImageMetadata(jpeg(app1(inlineTiff(littleEndian, true))))).toEqual({
      title: 'Å',
      creator: 'Å',
    })
  })

  it('uses Windows fields before conventional EXIF fallbacks', () => {
    const bytes = originalTiff.slice()
    const view = new DataView(bytes.buffer)
    const count = view.getUint16(8)
    for (let index = 0; index < count; index++) {
      const entry = 10 + index * 12
      if (view.getUint16(entry) === 0x010e) bytes[view.getUint32(entry + 8)] = 88
      if (view.getUint16(entry) === 0x013b) bytes[view.getUint32(entry + 8)] = 88
    }
    expect(readImageMetadata(jpeg(app1(bytes)))).toEqual(fixture.expected)
  })

  it('skips invalid individual fields while keeping valid fields and fallbacks', () => {
    const bytes = originalTiff.slice()
    const view = new DataView(bytes.buffer)
    const count = view.getUint16(8)
    for (let index = 0; index < count; index++) {
      const entry = 10 + index * 12
      if (view.getUint16(entry) === 0x9c9b) view.setUint32(entry + 8, 0xffffffff)
      if (view.getUint16(entry) === 0x9c9f) view.setUint32(entry + 4, 3)
    }
    expect(readImageMetadata(jpeg(app1(bytes)))).toEqual({
      title: fixture.expected.title,
      creator: fixture.expected.creator,
    })
  })

  it('omits empty fields and preserves markup as plain text', () => {
    const bytes = inlineTiff(true)
    bytes.set([32, 32, 32, 0], 18)
    bytes.set([60, 120, 62, 0], 30)
    expect(readImageMetadata(jpeg(app1(bytes)))).toEqual({ creator: '<x>' })
  })

  it('does not search pixel data or bytes beyond container boundaries for metadata', () => {
    expect(readImageMetadata(jpeg(new Uint8Array([0xff, 0xda, 0, 2]), originalApp1))).toEqual({})
    const bytes = webp(webpChunk('EXIF', originalTiff))
    new DataView(bytes.buffer).setUint32(4, 4, true)
    expect(readImageMetadata(bytes)).toEqual({})
  })

  it('never throws on truncated files, malformed TIFF offsets, or arbitrary bytes', () => {
    const bytes = jpeg(originalApp1)
    for (let length = 0; length < bytes.length; length++) {
      expect(() => readImageMetadata(bytes.subarray(0, length))).not.toThrow()
    }
    const brokenTiff = originalTiff.slice()
    new DataView(brokenTiff.buffer).setUint32(4, 0xffffffff)
    expect(readImageMetadata(jpeg(app1(brokenTiff)))).toEqual({})
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (randomBytes) => {
        expect(() => readImageMetadata(randomBytes)).not.toThrow()
      }),
    )
  })
})
