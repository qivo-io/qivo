import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginUpdateBlock, isUpdateBlocked, subscribeUpdateSafety } from './updateSafety'

describe('update safety across editors and pending writes', () => {
  const cleanup: (() => void)[] = []

  afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose()
    expect(isUpdateBlocked()).toBe(false)
  })

  function block() {
    const release = beginUpdateBlock()
    cleanup.push(release)
    return release
  }

  it('waits for every independent editor or request to finish', () => {
    expect(isUpdateBlocked()).toBe(false)
    const finishDescription = block()
    const finishReply = block()
    const finishSave = block()
    expect(isUpdateBlocked()).toBe(true)

    finishReply()
    finishDescription()
    expect(isUpdateBlocked()).toBe(true)
    finishSave()
    expect(isUpdateBlocked()).toBe(false)
  })

  it('makes release idempotent so repeated cleanup cannot unblock another draft', () => {
    const finishDescription = block()
    finishDescription()
    const finishNewTask = block()
    finishDescription()
    finishDescription()
    expect(isUpdateBlocked()).toBe(true)
    finishNewTask()
    expect(isUpdateBlocked()).toBe(false)
  })

  it('notifies subscribers when work starts and when the final block is released', () => {
    const states: boolean[] = []
    cleanup.push(subscribeUpdateSafety(() => states.push(isUpdateBlocked())))
    const finishDraft = block()
    expect(states.at(-1)).toBe(true)
    const finishSave = block()
    finishDraft()
    expect(isUpdateBlocked()).toBe(true)
    finishSave()
    expect(states.at(-1)).toBe(false)
  })

  it('removes a subscriber without affecting other observers or active blocks', () => {
    const removed = vi.fn()
    const remaining = vi.fn()
    const unsubscribe = subscribeUpdateSafety(removed)
    cleanup.push(unsubscribe, subscribeUpdateSafety(remaining))
    unsubscribe()
    unsubscribe()
    removed.mockClear()
    remaining.mockClear()

    const finishDraft = block()
    finishDraft()
    expect(removed).not.toHaveBeenCalled()
    expect(remaining).toHaveBeenCalled()
    expect(isUpdateBlocked()).toBe(false)
  })
})
