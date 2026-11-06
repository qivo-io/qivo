// The files the benchmark page's stand-in server mints (scripts/perf/server.mjs
// mintFiles): https URLs on perf.invalid, which the page serves itself through
// Playwright's routing with the gateway's CORS answer, so the app reads them
// with fetch as it reads the real gateway's (convex/http.ts). A picture is a
// 256-pixel PNG of about 20 KB, as the app's WebP pictures are 10 to 30 KB; a
// description image a 1,200 by 800 photo of about 150 KB; and a big one
// (size=big) 4,096 pixels square, the largest the app uploads, which decodes
// to 64 MiB whatever its bytes. Each answer waits `delayMs` first, so the
// downloads the app keeps in flight at once show in `stats`.
import { deflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/* The CRC-32 a PNG chunk carries. */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/* One PNG chunk of `type` holding `data`. */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

/** A valid RGB PNG of `width` by `height`: a gradient with `noise` (0 to 1)
    of its pixels random, which sets how far it compresses. `seed` varies
    the noise. */
export function pngOf(width, height, noise = 0.1, seed = 1) {
  let state = seed >>> 0 || 1
  const random = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  const row = width * 3 + 1
  const raw = Buffer.alloc(row * height)
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3
      const loud = random() < noise
      raw[at] = loud ? random() * 256 : (x * 255) / width
      raw[at + 1] = loud ? random() * 256 : (y * 255) / height
      raw[at + 2] = loud ? random() * 256 : 128
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The bytes a perf.invalid URL answers: a picture, a description image or
    a big one. */
export function bytesFor(url) {
  const { pathname, searchParams } = new URL(url)
  if (pathname.startsWith('/avatars/')) return pngOf(256, 256, 0.08, 7)
  if (searchParams.get('size') === 'big') return pngOf(4096, 4096, 0.02, 11)
  return pngOf(1200, 800, 0.05, 3)
}

/** Serves `page`'s requests to perf.invalid with generated images and the
    gateway's CORS and cache headers, each after `delayMs`. Answers its
    counts: requests by kind, the most in flight at once of each kind and
    the bytes served. */
export async function routePerfFiles(page, { delayMs = 150 } = {}) {
  const cache = new Map()
  const stats = {
    files: 0,
    avatars: 0,
    inFlight: { files: 0, avatars: 0 },
    mostInFlight: { files: 0, avatars: 0 },
    bytes: 0,
    log: [],
  }
  await page.route('https://perf.invalid/**', async (route) => {
    const request = route.request()
    const url = request.url()
    const kind = new URL(url).pathname.startsWith('/avatars/') ? 'avatars' : 'files'
    const origin = request.headers().origin
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': origin ?? '*',
          'access-control-allow-methods': 'GET',
          vary: 'Origin',
        },
      })
      return
    }
    stats[kind]++
    stats.inFlight[kind]++
    stats.mostInFlight[kind] = Math.max(stats.mostInFlight[kind], stats.inFlight[kind])
    stats.log.push({ kind, url, at: Date.now() })
    try {
      const sizeKey =
        kind === 'avatars' ? 'avatar' : new URL(url).searchParams.get('size') || 'photo'
      let body = cache.get(sizeKey)
      if (!body) {
        body = bytesFor(url)
        cache.set(sizeKey, body)
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      stats.bytes += body.length
      await route.fulfill({
        status: 200,
        body,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'private, max-age=600, immutable',
          'access-control-allow-origin': origin ?? '*',
          vary: 'Origin',
        },
      })
    } finally {
      stats.inFlight[kind]--
    }
  })
  return stats
}
