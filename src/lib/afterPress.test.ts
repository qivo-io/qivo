// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { afterPress, CLICK_WAIT_MS } from './afterPress'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const pointer = (type: string, pointerType: string, buttons: number) =>
  window.dispatchEvent(
    new PointerEvent(type, { pointerId: 3, pointerType, isPrimary: true, button: 0, buttons }),
  )
const mouse = (type: string) =>
  document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))

it('waits through the mouse events a tap sends after its release until its click is handled, or a short time where no click follows', () => {
  const work = vi.fn()
  const doneAtClick: number[] = []
  const onClick = () => doneAtClick.push(work.mock.calls.length)
  document.body.addEventListener('click', onClick)
  pointer('pointerdown', 'touch', 1)
  pointer('pointerup', 'touch', 0)
  vi.advanceTimersByTime(100)
  // the mousedown is where focus moves, and what follows from that waits
  mouse('mousedown')
  afterPress(work)
  mouse('mouseup')
  mouse('click')
  vi.advanceTimersByTime(0)
  document.body.removeEventListener('click', onClick)
  expect(doneAtClick).toEqual([0])
  expect(work).toHaveBeenCalledTimes(1)
  // a long press brings no click
  const held = vi.fn()
  pointer('pointerdown', 'touch', 1)
  afterPress(held)
  pointer('pointerup', 'touch', 0)
  vi.advanceTimersByTime(CLICK_WAIT_MS - 1)
  expect(held).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(held).toHaveBeenCalledTimes(1)
})

it('waits as long as the pointer is down, and ends a press released outside the window at its next move or when the window loses focus', () => {
  const work = vi.fn()
  pointer('pointerdown', 'mouse', 1)
  afterPress(work)
  vi.advanceTimersByTime(60_000)
  expect(work).not.toHaveBeenCalled()
  // back over the page with no button down
  pointer('pointermove', 'mouse', 0)
  expect(work).toHaveBeenCalledTimes(1)
  const left = vi.fn()
  pointer('pointerdown', 'mouse', 1)
  afterPress(left)
  window.dispatchEvent(new FocusEvent('blur'))
  expect(left).toHaveBeenCalledTimes(1)
  const later = vi.fn()
  afterPress(later)
  expect(later).toHaveBeenCalledTimes(1)
})
