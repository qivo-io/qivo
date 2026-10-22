import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { imageRefs, shownImages } from '../../convex/lib/imageRefs'
import { TEXT_MAX } from '../../convex/lib/limits'
import type { MdBlock } from './md'
import { astToMd } from './mdSerialize'

const ID = '0b7d6f4e-1c2a-4d3b-9e8f-7a6b5c4d3e2f'
const image = { t: 'image', alt: 'shot', src: `att:${ID}` } as const

describe('description image references', () => {
  it('reads the images the app shows, and keeps every image any att: names', () => {
    for (const text of [
      `![shot](att:${ID})`,
      // code with backticks before the image, as the serializer writes it
      astToMd([
        { t: 'p', children: [{ t: 'code', text: '```' }, { t: 'text', text: ' ' }, image] },
      ]),
      astToMd([
        { t: 'codeblock', text: '```\ninside' },
        { t: 'p', children: [image] },
      ]),
      astToMd([
        {
          t: 'p',
          children: [{ t: 'text', text: 'a ` tick ' }, image, { t: 'text', text: ' and ` one' }],
        },
      ]),
    ]) {
      expect(shownImages(text)).toEqual(new Set([ID]))
      expect(imageRefs(text).has(ID)).toBe(true)
    }
  })

  it('shows no image for an att: in prose or code, though it still keeps it', () => {
    for (const text of [
      `See att:${ID}`,
      `\`![shot](att:${ID})\``,
      `\`\`\`\n![shot](att:${ID})\n\`\`\``,
    ]) {
      expect(shownImages(text).size).toBe(0)
      expect(imageRefs(text).has(ID)).toBe(true)
    }
  })

  it('keeps every image the app shows, whatever code surrounds it', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        const blocks: MdBlock[] = [
          { t: 'p', children: [{ t: 'code', text: before }, image, { t: 'code', text: after }] },
        ]
        const text = astToMd(blocks)
        for (const id of shownImages(text)) expect(imageRefs(text).has(id)).toBe(true)
        expect(shownImages(text).has(ID)).toBe(true)
      }),
    )
  })
})

/* The fastest of five runs of `read`, in milliseconds. */
function fastest(read: () => void): number {
  let best = Number.POSITIVE_INFINITY
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    read()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

describe('description image references in hostile text', () => {
  // Text that made the parser scan ahead to the end at every character,
  // so reading 20,000 of it took about half a second and failed a save.
  const IMAGE = `![shot](att:${ID})`
  const PATTERNS = ['[', '![', '@[', '*[', '**[', '[](', `*${'['.repeat(99)}`]
  const hostile = (pattern: string, length: number) =>
    pattern.repeat(Math.floor((length - IMAGE.length) / pattern.length)) + IMAGE

  it('reads the image a description of 20,000 brackets shows, in time linear in its length', () => {
    let whole = 0
    let eighths = 0
    for (const pattern of PATTERNS) {
      const text = hostile(pattern, TEXT_MAX)
      expect(text.length).toBeLessThanOrEqual(TEXT_MAX)
      expect(shownImages(text)).toEqual(new Set([ID]))
      expect(imageRefs(text)).toEqual(new Set([ID]))
      const eighth = hostile(pattern, TEXT_MAX / 8)
      whole += fastest(() => shownImages(text))
      eighths += fastest(() => {
        for (let piece = 0; piece < 8; piece++) shownImages(eighth)
      })
    }
    // Linear work reads the whole text in about the time of its eight
    // eighths, and quadratic work takes about eight times as long. The
    // quadratic parser took over 6 s for these texts and the linear one tens
    // of milliseconds, so both bounds hold on a loaded machine.
    expect(whole).toBeLessThan(3 * eighths + 25)
    expect(whole).toBeLessThan(1000)
  })
})
