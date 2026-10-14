import { describe, expect, it } from 'vitest'
import { isLabelColor } from '../../convex/model/labels'
import { LABEL_COLORS } from './labelColors'

describe('LABEL_COLORS', () => {
  it('holds only distinct colors the server stores', () => {
    expect(LABEL_COLORS.filter(({ color }) => !isLabelColor(color))).toEqual([])
    expect(new Set(LABEL_COLORS.map(({ color }) => color.toLowerCase())).size).toBe(
      LABEL_COLORS.length,
    )
  })
})
