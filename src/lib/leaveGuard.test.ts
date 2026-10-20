import { describe, expect, it } from 'vitest'
import { createUnsentScope, hasUnsaved, holdUnsaved, installLeaveGuard } from './leaveGuard'

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
