import { describe, expect, it } from 'vitest'
import { normalizeEmail, requestSize, urlForHash } from './gravatar'

/* The pure half of the Gravatar module. `prime` needs crypto.subtle and a
   network, so it belongs to scripts/verify-avatars.mjs — which recomputes the
   hash in the browser and compares it against the rendered URL. */

describe('normalizeEmail', () => {
  it('trims and lowercases, because that is what Gravatar hashes', () => {
    expect(normalizeEmail('  Maya@Demo.Local ')).toBe('maya@demo.local')
  })
  it('treats absent, blank and whitespace-only alike', () => {
    expect(normalizeEmail(null)).toBeNull()
    expect(normalizeEmail(undefined)).toBeNull()
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail('   ')).toBeNull()
  })
})

describe('requestSize', () => {
  it('doubles for retina, then rounds up into one of three buckets', () => {
    // every avatar size the app actually draws (17…28 CSS px) lands on 64,
    // so one request per person serves the whole screen
    for (const px of [17, 18, 19, 20, 22, 24, 26, 28, 32]) expect(requestSize(px)).toBe(64)
    expect(requestSize(33)).toBe(128)
    expect(requestSize(44)).toBe(128) // the account page's picture
    expect(requestSize(64)).toBe(128)
    expect(requestSize(65)).toBe(256)
    expect(requestSize(400)).toBe(256) // the ceiling — never asks for more
  })
  it('never asks for a zero or negative size', () => {
    expect(requestSize(0)).toBe(64)
    expect(requestSize(-10)).toBe(64)
  })
})

describe('urlForHash', () => {
  it('builds the documented URL with the transparent default', () => {
    const h = 'f'.repeat(64)
    expect(urlForHash(h, 22)).toBe(`https://gravatar.com/avatar/${h}?s=64&d=blank`)
  })
  it('always uses d=blank — d=404 would log a console error per missing picture', () => {
    expect(urlForHash('abc', 22)).toContain('d=blank')
    expect(urlForHash('abc', 22)).not.toContain('404')
  })
})
