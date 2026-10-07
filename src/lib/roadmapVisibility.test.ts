import { describe, expect, it } from 'vitest'
import { isRoadmapTaskVisible } from './roadmapVisibility'

describe('roadmap task visibility', () => {
  // Both boundary weeks belong to the visible window.
  const windowStart = 10
  const windowEnd = 17
  const visible = (status: string, start?: number | null, end?: number | null) =>
    isRoadmapTaskVisible({ status, start, end }, windowStart, windowEnd)

  it.each([
    [11, 15],
    [7, 10],
    [17, 20],
    [7, 20],
    [7, 9],
    [18, 20],
    [null, null],
    [undefined, undefined],
  ])('keeps backlog off the roadmap regardless of its plan (%s–%s)', (start, end) => {
    expect(visible('backlog', start, end)).toBe(false)
  })

  it.each([
    [11, 15],
    [10, 17],
    [7, 12],
    [15, 20],
    [7, 20],
    [7, 10],
    [17, 20],
    [10, 10],
    [17, 17],
  ])('keeps a completed period with visible weeks (%i–%i)', (start, end) => {
    expect(visible('done', start, end)).toBe(true)
  })

  it.each([
    [7, 9],
    [18, 20],
    [-10, 3],
    [24, 40],
  ])('hides a completed period entirely outside the window (%i–%i)', (start, end) => {
    expect(visible('done', start, end)).toBe(false)
  })

  it.each([
    [null, null],
    [undefined, undefined],
    [10, null],
    [null, 17],
    [10, undefined],
    [undefined, 17],
  ])('hides completed work without a complete planned period (%s–%s)', (start, end) => {
    expect(visible('done', start, end)).toBe(false)
  })

  it.each(['todo', 'progress', 'review'])(
    'preserves %s tasks regardless of their plan',
    (status) => {
      for (const [start, end] of [
        [11, 15],
        [7, 9],
        [18, 20],
        [7, 20],
      ]) {
        expect(visible(status, start, end)).toBe(true)
      }
      expect(visible(status, null, null)).toBe(true)
      expect(visible(status)).toBe(true)
      expect(visible(status, 10)).toBe(true)
      expect(visible(status, undefined, 17)).toBe(true)
    },
  )

  it('uses inclusive overlap even when only one week is visible', () => {
    expect(isRoadmapTaskVisible({ status: 'done', start: 10, end: 10 }, 10, 10)).toBe(true)
    expect(isRoadmapTaskVisible({ status: 'done', start: 9, end: 11 }, 10, 10)).toBe(true)
    expect(isRoadmapTaskVisible({ status: 'done', start: 9, end: 9 }, 10, 10)).toBe(false)
    expect(isRoadmapTaskVisible({ status: 'done', start: 11, end: 11 }, 10, 10)).toBe(false)
  })
})
