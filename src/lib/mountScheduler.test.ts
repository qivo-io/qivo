// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createMountScheduler, type DeferredMount } from './mountScheduler'

/* The scheduler with its tasks, frames, clock and observer in the test's
   hands. Frames start at once unless `frames` collects them. */
function setup({ frames }: { frames?: (() => void)[] } = {}) {
  const tasks: (() => void)[] = []
  let time = 0
  let report: ((entries: { target: Element; isIntersecting: boolean }[]) => void) | null = null
  const scheduler = createMountScheduler({
    post: (task) => tasks.push(task),
    frame: (callback) => (frames ? frames.push(callback) : callback()),
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
    /** Moves the clock on by `ms`. */
    wait: (ms: number) => {
      time += ms
    },
    list,
    settle,
    run,
    near: (spacer: Element, isIntersecting = true) =>
      report?.([{ target: spacer, isIntersecting }]),
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
    expect(a.state.grown).toEqual([8])
    while (s.tasks.length) await s.run()
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
    // 1ms an item keeps each slice at 8 items
    const a = s.list('a', 100, 0, 1)
    const b = s.list('b', 100, 0, 1)
    const c = s.list('c', 100, 0, 1)
    await s.settle()
    s.near(c.spacer)
    await s.run()
    expect([a.state.mounted, b.state.mounted, c.state.mounted]).toEqual([0, 0, 8])
    s.near(c.spacer, false)
    await s.run()
    expect([a.state.mounted, b.state.mounted, c.state.mounted]).toEqual([8, 0, 8])
  })

  it('sizes each slice to about 8ms, between 1 and 512 items', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    // 4ms an item: the first 8 take 32ms, so the next slice is 2 items
    const slow = s.list('slow', 1000, 0, 4)
    await s.settle()
    await s.run()
    await s.run()
    expect(slow.state.grown).toEqual([8, 2])
    slow.unregister()
    // free items: slices grow as the averaged time per item falls, never
    // more than double, up to 512
    const fast = s.list('fast', 100_000)
    await s.settle()
    for (let n = 0; n < 40; n++) await s.run()
    const grown = fast.state.grown
    expect(grown[0]).toBeLessThanOrEqual(4)
    expect(grown.every((n, i) => i === 0 || n <= grown[i - 1] * 2)).toBe(true)
    expect(grown.at(-1)).toBe(512)
  })

  it('does not take a slice that found few items left for a cheap one', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    // 1ms an item: 8 take 8ms, then the last 1 takes 1ms
    const a = s.list('a', 9, 0, 1)
    await s.settle()
    await s.run()
    await s.run()
    expect(a.state.grown).toEqual([8, 1])
    // one item in 1ms is the same rate: the next list gets 8, not 64
    const b = s.list('b', 1000, 0, 1)
    await s.settle()
    await s.run()
    expect(b.state.grown).toEqual([8])
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
    expect(a.state.mounted).toBe(8)
  })

  it('runs slices within 16ms of a frame, then waits for the next frame', async () => {
    const frames: (() => void)[] = []
    const s = setup({ frames })
    s.scheduler.setRoot(s.root)
    // 1ms an item: a first slice of 8 takes 8ms, the next of 8 takes 8ms more
    const a = s.list('a', 10_000, 0, 1)
    await s.settle()
    // the first slice waits for a frame
    expect(s.tasks).toHaveLength(0)
    expect(frames).toHaveLength(1)
    frames.shift()?.()
    await s.run()
    // 8ms into the frame: the next slice follows at once
    expect(s.tasks).toHaveLength(1)
    expect(frames).toHaveLength(0)
    await s.run()
    // 16ms into the frame: the next slice waits for the next frame
    expect(a.state.grown.reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(16)
    expect(s.tasks).toHaveLength(0)
    expect(frames).toHaveLength(1)
  })

  it('leaves no marks on a root it no longer uses', async () => {
    const s = setup()
    s.scheduler.setRoot(s.root)
    s.list('a', 100)
    await s.settle()
    expect(s.root.getAttribute('aria-busy')).toBe('true')
    // another layout's pane takes over while cards still wait
    const pane = document.createElement('div')
    document.body.append(pane)
    s.scheduler.setRoot(pane)
    await s.settle()
    expect(s.root.hasAttribute('aria-busy')).toBe(false)
    expect(s.root.hasAttribute('data-board-mount')).toBe(false)
    expect(pane.getAttribute('data-board-mount')).toBe('pending')
  })
})
