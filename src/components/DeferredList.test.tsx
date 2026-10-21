// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMountScheduler } from '@/lib/mountScheduler'
import { DeferredList } from './DeferredList'

/* A DeferredList under random inserts, deletes, reorders and slices. */

type Item = { key: string }

let container: HTMLDivElement
let root: Root
let tasks: (() => void)[]
let scheduler: ReturnType<typeof createMountScheduler>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  tasks = []
  // a clock that never moves: every slice looks free, so slices grow at once
  scheduler = createMountScheduler({
    post: (task) => tasks.push(task),
    // frames start at once, so every slice is a task the test runs
    frame: (callback) => callback(),
    now: () => 0,
    observer: null,
  })
  container = document.createElement('div')
  document.body.append(container)
  scheduler.setRoot(container)
  root = createRoot(container)
})

afterEach(async () => {
  scheduler.dispose()
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const renderItem = (item: Item) => <div key={item.key} data-k={item.key} />
const keyOf = (item: Item) => item.key
const estimate = () => 40
const label = (n: number) => `Loading ${n} more`

const show = (items: Item[], initial: number) =>
  act(async () =>
    root.render(
      <DeferredList
        id="list"
        items={items}
        keyOf={keyOf}
        render={renderItem}
        estimate={estimate}
        gap={8}
        initial={initial}
        scheduler={scheduler}
        label={label}
      />,
    ),
  )
const nodes = () => [...container.querySelectorAll<HTMLElement>('[data-k]')]
const spacer = () => container.querySelector<HTMLElement>('[data-board-pending]')
const slice = () =>
  act(async () => {
    tasks.shift()?.()
  })

/** A deterministic random source (xorshift32, exact in 32-bit integers). */
function random(seed: number) {
  let state = seed | 0 || 1
  return (n: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
}

describe('DeferredList', () => {
  it('renders every item once, in order, and keeps mounted nodes through random changes', {
    timeout: 180_000,
  }, async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const pick = random(seed)
      let next = 0
      let items: Item[] = Array.from({ length: 400 }, () => ({ key: `k${next++}` }))
      await show(items, 30)
      const ops = [0, 0, 0, 0, 0]
      for (let step = 0; step < 60; step++) {
        const before = new Map(nodes().map((node) => [node.dataset.k, node]))
        const op = pick(5)
        ops[op]++
        let moved: string | null = null
        // the items a filter hid and showed again in this step
        let filtered: Set<string> | null = null
        if (op === 0) await slice()
        else if (op === 4) {
          // a filter that keeps every third item, then cleared
          const kept = items.filter((_, i) => i % 3 === 0)
          filtered = new Set(items.filter((_, i) => i % 3 !== 0).map(keyOf))
          await show(kept, 30)
          await show(items, 30)
        } else {
          items = [...items]
          if (op === 1) items.splice(pick(items.length + 1), 0, { key: `k${next++}` })
          else if (op === 2 && items.length > 1) items.splice(pick(items.length), 1)
          else if (op === 3) {
            const [item] = items.splice(pick(items.length), 1)
            items.splice(pick(items.length + 1), 0, item)
            moved = item.key
          }
          await show(items, 30)
        }
        const keys = nodes().map((node) => node.dataset.k)
        // the mounted items are the first ones, each once, in order
        expect(keys).toEqual(items.slice(0, keys.length).map(keyOf))
        expect(Number(spacer()?.dataset.boardPending ?? 0)).toBe(items.length - keys.length)
        // A mounted item stays mounted while it is in the list, but one a
        // reorder moved far below the mounted ones. Clearing a filter mounts
        // at most 64 new items, so items it kept far down can wait again.
        const present = new Set(items.map(keyOf))
        if (op !== 4)
          for (const key of before.keys())
            if (present.has(key) && key !== moved) expect(keys).toContain(key)
        // no mounted node changes, but the one a reorder moved, or one beside
        // it when a move by one place across a block's edge reads both ways
        const changed = nodes().filter(
          (node) =>
            before.has(node.dataset.k) &&
            !filtered?.has(node.dataset.k ?? '') &&
            before.get(node.dataset.k) !== node,
        )
        expect(changed.filter((node) => node.dataset.k !== moved).length).toBeLessThanOrEqual(
          moved ? 1 : 0,
        )
        // blocks keep their bound; an insert or a move joins the block it lands in
        for (const box of container.querySelectorAll('[data-deferred-block]'))
          expect(box.children.length).toBeLessThanOrEqual(64 + ops[1] + ops[3])
      }
      // every kind of change happened
      expect(ops.every((count) => count >= 5)).toBe(true)
      while (tasks.length) await slice()
      expect(nodes().map((node) => node.dataset.k)).toEqual(items.map(keyOf))
      expect(spacer()).toBeNull()
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('keeps every card mounted when a raised card is followed by an insert', async () => {
    const items = Array.from({ length: 200 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 12)
    while (tasks.length) await slice()
    const raised = [items[199], ...items.slice(0, 199)]
    await show(raised, 12)
    await show([{ key: 'new' }, ...raised.slice(0, 150), { key: 'mid' }, ...raised.slice(150)], 12)
    expect(nodes()).toHaveLength(202)
    expect(spacer()).toBeNull()
  })

  it('brings filtered cards back in blocks of 64 at most', async () => {
    const items = Array.from({ length: 1000 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 12)
    while (tasks.length) await slice()
    await show(items.slice(0, 100), 12)
    await show(items, 12)
    while (tasks.length) await slice()
    expect(nodes()).toHaveLength(1000)
    for (const box of container.querySelectorAll('[data-deferred-block]'))
      expect(box.children.length).toBeLessThanOrEqual(64)
  })

  it('puts what a list that opened whole gains later into bounded boxes', async () => {
    const items = Array.from({ length: 500 }, (_, n) => ({ key: `k${n}` }))
    // a narrow filter: the Board opens whole
    await show(items.slice(0, 30), Number.POSITIVE_INFINITY)
    const first = nodes()
    // the filter is cleared, and the Board now mounts in slices
    await show(items, 12)
    while (tasks.length) await slice()
    expect(nodes()).toHaveLength(500)
    for (const node of first) expect(node.isConnected).toBe(true)
    // the first 30 stay plain; the rest fill boxed blocks of 64 at most
    expect(first.every((node) => !node.parentElement?.hasAttribute('data-deferred-block'))).toBe(
      true,
    )
    const boxes = [...container.querySelectorAll('[data-deferred-block]')]
    expect(boxes.length).toBeGreaterThanOrEqual(470 / 64)
    for (const box of boxes) expect(box.children.length).toBeLessThanOrEqual(64)
  })

  it('keeps its cards when its first screen changes size', async () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ key: `k${n}` }))
    // a short cell on a large Board: its first screen holds all of it
    await show(items, 30)
    const before = nodes()
    // one more card, then the Board falls to 300 cards or fewer
    await show([...items, { key: 'k30' }], 30)
    await show([...items, { key: 'k30' }], Number.POSITIVE_INFINITY)
    for (const node of before) expect(node.isConnected).toBe(true)
  })

  it('keeps the first screen mounted when an item arrives above it before any slice', async () => {
    const items = Array.from({ length: 100 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 10)
    const before = nodes()
    await show([{ key: 'new' }, ...items], 10)
    for (const node of before) expect(node.isConnected).toBe(true)
    expect(nodes()[0].dataset.k).toBe('new')
  })

  it('keeps every card mounted when the last mounted one moves to the top', async () => {
    const items = Array.from({ length: 600 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 12)
    while (tasks.length) await slice()
    expect(nodes()).toHaveLength(600)
    await show([items[599], ...items.slice(0, 599)], 12)
    expect(nodes()).toHaveLength(600)
    expect(spacer()).toBeNull()
  })

  it('moves only the card a reorder takes across blocks', async () => {
    const items = Array.from({ length: 600 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 12)
    while (tasks.length) await slice()
    const before = new Map(nodes().map((node) => [node.dataset.k, node]))
    const boxes = container.querySelectorAll('[data-deferred-block]').length
    await show([items[598], ...items.slice(0, 598), items[599]], 12)
    const changed = nodes().filter((node) => before.get(node.dataset.k) !== node)
    expect(changed.map((node) => node.dataset.k)).toEqual(['k598'])
    // the blocks keep their size
    expect(container.querySelectorAll('[data-deferred-block]').length).toBe(boxes)
    expect(
      Math.max(
        ...[...container.querySelectorAll('[data-deferred-block]')].map((b) => b.children.length),
      ),
    ).toBeLessThanOrEqual(65)
  })

  it('renders a list its first screen covers whole, with no waiting space', async () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ key: `k${n}` }))
    // a Board that renders whole gives every list an unbounded first screen
    await show(items, Number.POSITIVE_INFINITY)
    expect(nodes()).toHaveLength(30)
    expect(spacer()).toBeNull()
    expect(container.querySelector('[data-deferred-block]')).toBeNull()
    expect(tasks).toHaveLength(0)
  })

  it('boxes the blocks of a list that mounts in slices, sized by their estimates', async () => {
    const items = Array.from({ length: 700 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 10)
    // past one block of 64 while items still wait
    while (nodes().length < 280) await slice()
    expect(spacer()).not.toBeNull()
    const boxes = [...container.querySelectorAll<HTMLElement>('[data-deferred-block]')]
    // the first screen's 10 items keep a block of their own, which is on
    // screen; slices fill the next blocks of 64 items. A closed block keeps
    // the size it last rendered at, the open one takes its estimate.
    expect(boxes.length).toBeGreaterThanOrEqual(3)
    expect(boxes[0].children).toHaveLength(10)
    expect(boxes[0].style.containIntrinsicBlockSize).toBe(`auto ${10 * 40 + 9 * 8}px`)
    expect(boxes[1].children).toHaveLength(64)
    expect(boxes[1].style.containIntrinsicBlockSize).toBe(`auto ${64 * 40 + 63 * 8}px`)
    expect(boxes.at(-1)?.style.containIntrinsicBlockSize).toMatch(/^\d+px$/)
    expect(boxes.every((box) => box.getAttribute('role') === 'none')).toBe(true)
  })

  it('stands in for the waiting items at their estimated height', async () => {
    const items = Array.from({ length: 100 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 10)
    expect(nodes()).toHaveLength(10)
    // 90 items of 40px with the 89 gaps between them
    expect(spacer()?.style.height).toBe(`${90 * 40 + 89 * 8}px`)
    expect(spacer()?.getAttribute('aria-label')).toBe('Loading 90 more')
  })

  it('mounts at most 64 more at once when items come back above the boundary', async () => {
    const items = Array.from({ length: 500 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 20)
    await show([items[400]], 20)
    expect(nodes()).toHaveLength(1)
    await show(items, 20)
    expect(nodes().length).toBeLessThanOrEqual(20 + 64)
    expect(spacer()).not.toBeNull()
  })
})
