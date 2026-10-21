import { describe, expect, it, vi } from 'vitest'
import {
  createUnsentScope,
  DISCARD_MS,
  hasUnsaved,
  holdUnsaved,
  installLeaveGuard,
} from './leaveGuard'

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

describe('unsent scopes', () => {
  it('names what a window holds once each, also in the window around it', () => {
    const task = createUnsentScope()
    const dialog = createUnsentScope(task)
    const comment = task.hold('comment')
    const reason = dialog.hold('reason')
    const again = dialog.hold('reason')
    expect(task.held()).toEqual(['comment', 'reason'])
    expect(dialog.held()).toEqual(['reason'])
    reason()
    reason()
    expect(task.held()).toEqual(['comment', 'reason'])
    again()
    comment()
    expect(task.held()).toEqual([])
    expect(hasUnsaved()).toBe(false)
  })

  it('lets the windows inside a discarded one close too', () => {
    const page = createUnsentScope()
    const note = createUnsentScope(page)
    const release = note.hold('note')
    page.discard()
    expect(note.held()).toEqual([])
    expect(note.discarded()).toBe(true)
    // the close ends the leases, and is still the Discard's own
    release()
    expect(note.discarded()).toBe(true)
    const again = note.hold('note')
    expect(page.discarded()).toBe(false)
    again()
  })

  it('ends a discard after DISCARD_MS', () => {
    vi.useFakeTimers()
    try {
      const scope = createUnsentScope()
      const release = scope.hold('note')
      scope.discard()
      release()
      vi.advanceTimersByTime(DISCARD_MS - 1)
      expect(scope.discarded()).toBe(true)
      vi.advanceTimersByTime(1)
      expect(scope.discarded()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports nothing after a discard until a new lease begins', () => {
    const scope = createUnsentScope()
    scope.discard()
    const title = scope.hold('title')
    expect(scope.held()).toEqual(['title'])
    const comment = scope.hold('comment')
    scope.discard()
    expect(scope.held()).toEqual([])
    title()
    expect(scope.held()).toEqual([])
    const description = scope.hold('description')
    expect(scope.held()).toEqual(['comment', 'description'])
    comment()
    description()
  })
})
