// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { afterPress, RELEASE_WAIT_MS } from './afterPress'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it('runs work set off during a press whose release never comes after a short wait, and later work at once', () => {
  const work = vi.fn()
  window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7 }))
  afterPress(work)
  vi.advanceTimersByTime(RELEASE_WAIT_MS - 1)
  expect(work).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(work).toHaveBeenCalledTimes(1)
  const later = vi.fn()
  afterPress(later)
  expect(later).toHaveBeenCalledTimes(1)
})
