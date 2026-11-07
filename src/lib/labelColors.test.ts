import { describe, expect, it } from 'vitest'
import { LABEL_COLORS, labelColorFor } from './labelColors'

/* A new label's color from its id (labelColorFor): the same for an id, a
   palette color always, and spread over the whole palette. */

describe('labelColorFor', () => {
  const palette = LABEL_COLORS.map((c) => c.color)

  it('answers the same palette color for the same id', () => {
    const id = '7f0c1a52-3b9e-4c1d-8e2f-5a6b7c8d9e01'
    expect(labelColorFor(id)).toBe(labelColorFor(id))
    expect(palette).toContain(labelColorFor(id))
    // another id may take another color, and every answer is the palette's
    expect(palette).toContain(labelColorFor(`${id}x`))
  })

  it('spreads 1,000 random ids over every palette color', () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 1000; i++) {
      const color = labelColorFor(crypto.randomUUID())
      counts.set(color, (counts.get(color) ?? 0) + 1)
    }
    expect([...counts.keys()].sort()).toEqual([...palette].sort())
    // no color takes most of them: each holds between a third and three
    // times its share
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(1000 / palette.length / 3)
      expect(n).toBeLessThan((1000 / palette.length) * 3)
    }
  })
})
