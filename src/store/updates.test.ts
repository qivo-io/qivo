import { describe, expect, it, vi } from 'vitest'
import { createPlannerUpdates } from './updates'

describe('planner update channels', () => {
  it('keeps immutable stable snapshots until that section changes', () => {
    const updates = createPlannerUpdates()
    const { workspace, comments, teamSync } = updates.channels
    const before = workspace.getSnapshot()
    const thread = comments.getSnapshot()
    expect(Object.isFrozen(thread)).toBe(true)
    expect(comments.getSnapshot()).toBe(thread)
    updates.emit('comments')
    expect(comments.getSnapshot()).not.toBe(thread)
    expect(thread.revision).toBe(0)
    expect(workspace.getSnapshot()).toBe(before)
    expect(teamSync.getSnapshot()).toBe(before)
  })

  it('publishes all workspace tokens before any observer runs and notifies legacy subscribers', () => {
    const updates = createPlannerUpdates()
    const observer = vi.fn(() => {
      expect(updates.channels.comments.getSnapshot()).toBe(updates.channels.workspace.getSnapshot())
      expect(updates.channels.teamSync.getSnapshot()).toBe(updates.channels.workspace.getSnapshot())
    })
    const legacy = vi.fn()
    updates.channels.workspace.subscribe(observer)
    updates.channels.comments.subscribe(observer)
    updates.subscribe(legacy)
    updates.emit()
    expect(observer).toHaveBeenCalledTimes(1)
    expect(legacy).toHaveBeenCalledTimes(1)
    updates.emit('teamSync')
    expect(observer).toHaveBeenCalledTimes(1)
    expect(legacy).toHaveBeenCalledTimes(2)
  })

  it('removes observers and isolates a failing observer from other views', () => {
    const updates = createPlannerUpdates()
    const removed = vi.fn()
    const active = vi.fn()
    const unsubscribe = updates.channels.comments.subscribe(removed)
    updates.channels.comments.subscribe(() => {
      throw new Error('Broken observer')
    })
    updates.channels.comments.subscribe(active)
    unsubscribe()
    updates.emit('comments')
    expect(removed).not.toHaveBeenCalled()
    expect(active).toHaveBeenCalledTimes(1)
  })
})
