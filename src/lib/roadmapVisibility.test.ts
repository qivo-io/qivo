import { describe, expect, it } from 'vitest'
import { hideDoneSetting, hidesDone, isRoadmapTaskVisible, withoutDone } from './roadmapVisibility'

describe('roadmap task visibility', () => {
  // Both boundary weeks belong to the visible window.
  const windowStart = 10
  const windowEnd = 17
  // a leaf is done exactly when its status is Done
  const visible = (status: string, start?: number | null, end?: number | null) =>
    isRoadmapTaskVisible(
      { status, isGroup: false, start, end },
      status === 'done',
      windowStart,
      windowEnd,
    )
  const group = (status: string, done: boolean, start?: number | null, end?: number | null) =>
    isRoadmapTaskVisible({ status, isGroup: true, start, end }, done, windowStart, windowEnd)

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
    const done = (start: number, end: number) =>
      isRoadmapTaskVisible({ status: 'done', isGroup: false, start, end }, true, 10, 10)
    expect(done(10, 10)).toBe(true)
    expect(done(9, 11)).toBe(true)
    expect(done(9, 9)).toBe(false)
    expect(done(11, 11)).toBe(false)
  })

  it.each(['backlog', 'todo', 'done'])(
    'never hides a group as %s, since its own status is dormant',
    (status) => {
      expect(group(status, false, 11, 15)).toBe(true)
      expect(group(status, false, 30, 40)).toBe(true)
      expect(group(status, false, null, null)).toBe(true)
    },
  )

  it('treats a group as completed only when the caller says its leaves are done', () => {
    expect(group('backlog', true, 11, 15)).toBe(true)
    expect(group('todo', true, 18, 20)).toBe(false)
    expect(group('progress', true, null, null)).toBe(false)
  })
})

describe('Hide Done in Roadmap', () => {
  it('is on for an account that never chose, also before its appearance loads', () => {
    expect(hidesDone(null)).toBe(true)
    expect(hidesDone(undefined)).toBe(true)
    expect(hidesDone({})).toBe(true)
    expect(hidesDone({ roadmap_hide_done: true })).toBe(true)
    expect(hidesDone({ roadmap_hide_done: false })).toBe(false)
  })

  it('is unknown to the Roadmap only while the appearance loads, and on once its read failed', () => {
    expect(hideDoneSetting({ preferences: null, preferencesState: 'loading' })).toBeNull()
    expect(hideDoneSetting({ preferences: null, preferencesState: 'failed' })).toBe(true)
    expect(hideDoneSetting({ preferences: null, preferencesState: 'retrying' })).toBe(true)
    expect(
      hideDoneSetting({ preferences: { roadmap_hide_done: false }, preferencesState: 'ok' }),
    ).toBe(false)
    // a later failure keeps the answer the provider holds
    expect(
      hideDoneSetting({ preferences: { roadmap_hide_done: false }, preferencesState: 'failed' }),
    ).toBe(false)
  })

  const tasks = [
    { id: 'a', done: false },
    { id: 'b', done: true },
    { id: 'c', done: false },
    { id: 'd', done: true },
  ]
  const ids = (list: readonly { id: string }[]) => list.map((task) => task.id)

  it('gives the Done tasks no row while on, keeping the others in order, and every task one while off', () => {
    const on = withoutDone(tasks, true, (task) => task.done)
    expect(ids(on.shown)).toEqual(['a', 'c'])
    expect(ids(on.hidden)).toEqual(['b', 'd'])
    const off = withoutDone(tasks, false, (task) => task.done)
    expect(ids(off.shown)).toEqual(['a', 'b', 'c', 'd'])
    expect(off.hidden).toEqual([])
  })
})
