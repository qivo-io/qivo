import { describe, expect, it } from 'vitest'
import { hasUnsaved, holdUnsaved, installLeaveGuard } from './leaveGuard'

/** Dispatches a cancelable beforeunload and answers whether it was stopped. */
function leave(win: EventTarget) {
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
  win.dispatchEvent(event)
  return event.defaultPrevented
}

describe('leave guard', () => {
  it('warns only while something is unsaved', () => {
    const win = new EventTarget() as Window
    let pending = false
    const remove = installLeaveGuard(() => pending, win)
    expect(leave(win)).toBe(false)
    pending = true
    expect(leave(win)).toBe(true)
    remove()
    expect(leave(win)).toBe(false)
  })

  it('counts each lease on its own', () => {
    const first = holdUnsaved()
    const second = holdUnsaved()
    first()
    first()
    expect(hasUnsaved()).toBe(true)
    second()
    expect(hasUnsaved()).toBe(false)
  })
})
