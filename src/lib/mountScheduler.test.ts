// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createMountScheduler, type DeferredMount } from './mountScheduler'

/* The scheduler with its tasks, clock and observer in the test's hands. */
function setup() {
  const tasks: (() => void)[] = []
  let time = 0
  let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null
  const scheduler = createMountScheduler({
    post: (task) => tasks.push(task),
    now: () => time,
    flush: (work) => work(),
    observer: (receive) => {
      report = receive
      return { observe() {}, unobserve() {}, disconnect() {} }
    },
  })
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  /** A list of `total` items, `mounted` of them in, `cost` ms per item mounted. */
  const list = (id: string, total: number, mounted = 0, cost = 0) => {
    const spacer = document.createElement('div')
    root.append(spacer)
    const state = { mounted, grown: [] as number[] }
    const entry: DeferredMount = {
      id,
      spacer: () => (state.mounted < total ? spacer : null),
      pending: () => total - state.mounted,
      grow: (n) => {
        state.grown.push(n)
        state.mounted += n
        time += n * cost
      },
      mountThrough: () => {},
    }
    return { state, spacer, unregister: scheduler.register(entry) }
  }
  const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))
  /** Runs the next posted slice and lets its update land. */
  const run = async () => {
    tasks.shift()?.()
    await settle()
  }
  return {
    scheduler,
    root,
    tasks,
    list,
    settle,
    run,
    near: (spacer: Element, isIntersecting = true) => report?.([{ target: spacer, isIntersecting }]),
  }
}

describe('createMountScheduler', () => {
  it('marks its root busy while a list waits, and complete after', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    const a = s.list('a', 40)
    await s.settle()
    expect(s.root.getAttribute('data-board-mount')).toBe('pending')
    expect(s.root.getAttribute('aria-busy')).toBe('true')
    await s.run()
    expect(a.state.grown).toEqual([32])
    await s.run()
    expect(a.state.mounted).toBe(40)
    expect(s.root.getAttribute('data-board-mount')).toBe('complete')
    expect(s.root.hasAttribute('aria-busy')).toBe(false)
    expect(s.tasks).toHaveLength(0)
  })

  it('leaves a root with nothing to wait for unmarked', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    s.list('a', 10, 10)
    await s.settle()
    expect(s.root.hasAttribute('data-board-mount')).toBe(false)
    expect(s.tasks).toHaveLength(0)
  })

  it('mounts lists near the view first, then in document order', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    // 0.25ms an item keeps each slice at 32 items
    const a = s.list('a', 100, 0, 0.25)
    const b = s.list('b', 100, 0, 0.25)
    const c = s.list('c', 100, 0, 0.25)
    await s.settle()
    s.near(c.spacer)
    await s.run()
    expect([a.state.mounted, b.state.mounted, c.state.mounted]).toEqual([0, 0, 32])
    s.near(c.spacer, false)
    await s.run()
    expect([a.state.mounted, b.state.mounted, c.state.mounted]).toEqual([32, 0, 32])
  })

  it('sizes each slice to about 8ms, between 8 and 512 items', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    // 1ms an item: 32 take 32ms, so the next slice is 8 items
    const slow = s.list('slow', 1000, 0, 1)
    await s.settle()
    await s.run()
    await s.run()
    expect(slow.state.grown).toEqual([32, 8])
    await s.run()
    expect(slow.state.grown[2]).toBe(8)
    slow.unregister()
    // free items: from the 8 it came down to, eightfold per slice to 512 at most
    const fast = s.list('fast', 100_000)
    await s.settle()
    for (let n = 0; n < 5; n++) await s.run()
    expect(fast.state.grown).toEqual([8, 64, 512, 512, 512])
  })

  it('mounts one list or all of them at once', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    const a = s.list('a', 300)
    const b = s.list('b', 300)
    await s.settle()
    s.scheduler.completeList('b')
    expect([a.state.mounted, b.state.mounted]).toEqual([0, 300])
    expect(s.scheduler.pending()).toBe(true)
    s.scheduler.completeAll()
    expect(a.state.mounted).toBe(300)
    expect(s.scheduler.pending()).toBe(false)
    await s.settle()
    expect(s.root.getAttribute('data-board-mount')).toBe('complete')
  })

  it('posts nothing after it is disposed, and slices again when revived', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    const a = s.list('a', 100)
    await s.settle()
    s.scheduler.dispose()
    await s.run()
    expect(a.state.mounted).toBe(0)
    s.list('b', 100)
    await s.settle()
    expect(s.tasks).toHaveLength(0)
    s.scheduler.revive()
    await s.settle()
    await s.run()
    expect(a.state.mounted).toBe(32)
  })
})
