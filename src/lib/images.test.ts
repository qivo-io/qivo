import { describe, expect, it } from 'vitest'
import {
  COMPRESSIBLE,
  fitWithin,
  hasApngMarker,
  MAX_EDGE,
  MIN_BYTES,
  shouldCompress,
  webpName,
} from './images'

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]
/** A PNG head: signature then the named chunk types in order. */
const png = (...chunks: string[]): Uint8Array => {
  const out: number[] = [...SIG]
  for (const c of chunks) {
    out.push(0, 0, 0, 0) // length placeholder — hasApngMarker only reads types
    for (const ch of c) out.push(ch.charCodeAt(0))
  }
  return new Uint8Array(out)
}

const BIG = MIN_BYTES + 1

describe('shouldCompress', () => {
  it('takes the two lossy-worthwhile raster types', () => {
    expect(shouldCompress('image/png', BIG)).toBe(true)
    expect(shouldCompress('image/jpeg', BIG)).toBe(true)
  })

  it('leaves animation, vectors and already-compressed codecs alone', () => {
    // a canvas round-trip would flatten a GIF to its first frame
    expect(shouldCompress('image/gif', BIG)).toBe(false)
    // rasterising a vector makes it bigger AND unscalable
    expect(shouldCompress('image/svg+xml', BIG)).toBe(false)
    expect(shouldCompress('image/webp', BIG)).toBe(false)
    expect(shouldCompress('image/avif', BIG)).toBe(false)
  })

  it('leaves every non-image alone', () => {
    expect(shouldCompress('application/pdf', BIG)).toBe(false)
    expect(shouldCompress('text/markdown', BIG)).toBe(false)
    expect(shouldCompress('text/html', BIG)).toBe(false)
    expect(shouldCompress('application/octet-stream', BIG)).toBe(false)
  })

  it('survives a missing or dressed-up mime type', () => {
    expect(shouldCompress('', BIG)).toBe(false)
    expect(shouldCompress(null, BIG)).toBe(false)
    expect(shouldCompress(undefined, BIG)).toBe(false)
    expect(shouldCompress('IMAGE/PNG', BIG)).toBe(true)
    expect(shouldCompress('image/jpeg; charset=binary', BIG)).toBe(true)
  })

  it('skips small images — the ones most likely to re-encode bigger', () => {
    expect(shouldCompress('image/png', MIN_BYTES - 1)).toBe(false)
    expect(shouldCompress('image/png', MIN_BYTES)).toBe(true)
    expect(shouldCompress('image/png', 0)).toBe(false)
  })

  it('output type is not itself compressible — the idempotence the callers rely on', () => {
    expect((COMPRESSIBLE as readonly string[]).includes('image/webp')).toBe(false)
  })
})

describe('hasApngMarker', () => {
  it('spots an animated PNG — acTL before the first IDAT', () => {
    expect(hasApngMarker(png('IHDR', 'acTL', 'fcTL', 'IDAT'))).toBe(true)
  })

  it('leaves a still PNG alone', () => {
    expect(hasApngMarker(png('IHDR', 'IDAT', 'IEND'))).toBe(false)
    expect(hasApngMarker(png('IHDR', 'pHYs', 'IDAT'))).toBe(false)
  })

  it('does not treat the bytes "acTL" INSIDE pixel data as an animation', () => {
    // acTL is only meaningful before the first IDAT; after it, it is payload
    expect(hasApngMarker(png('IHDR', 'IDAT', 'acTL'))).toBe(false)
  })

  it('copes with a truncated head', () => {
    expect(hasApngMarker(new Uint8Array(SIG))).toBe(false)
    expect(hasApngMarker(new Uint8Array(0))).toBe(false)
  })

  it('never matches inside the signature itself', () => {
    expect(hasApngMarker(new Uint8Array([...SIG, ...SIG]))).toBe(false)
  })
})

describe('fitWithin', () => {
  it('leaves anything inside the box untouched', () => {
    expect(fitWithin(1920, 1080)).toEqual({ w: 1920, h: 1080 })
    expect(fitWithin(MAX_EDGE, 100)).toEqual({ w: MAX_EDGE, h: 100 })
  })

  it('scales the long edge down and keeps the aspect ratio', () => {
    expect(fitWithin(8192, 4096)).toEqual({ w: 4096, h: 2048 })
    expect(fitWithin(4096, 8192)).toEqual({ w: 2048, h: 4096 })
  })

  it('never rounds an edge away to nothing', () => {
    const r = fitWithin(100000, 3, 4096)
    expect(r.w).toBe(4096)
    expect(r.h).toBeGreaterThanOrEqual(1)
  })

  it('refuses to invent dimensions for a broken decode', () => {
    expect(fitWithin(0, 0)).toEqual({ w: 0, h: 0 })
    expect(fitWithin(-5, 10)).toEqual({ w: 0, h: 0 })
    expect(fitWithin(NaN, 10)).toEqual({ w: 0, h: 0 })
  })
})

describe('webpName', () => {
  it('swaps the extension rather than appending one', () => {
    expect(webpName('shot.png')).toBe('shot.webp')
    expect(webpName('photo.JPEG')).toBe('photo.webp')
    expect(webpName('pasted-image-2026-08-02-15-04-11.png')).toBe(
      'pasted-image-2026-08-02-15-04-11.webp',
    )
  })

  it('keeps dots that are part of the name', () => {
    expect(webpName('v1.2.3-diagram.png')).toBe('v1.2.3-diagram.webp')
  })

  it('copes with no extension and with nothing at all', () => {
    expect(webpName('screenshot')).toBe('screenshot.webp')
    expect(webpName('')).toBe('image.webp')
  })
})
