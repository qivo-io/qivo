import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { imageRefs, shownImages } from '../../convex/lib/imageRefs'
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
