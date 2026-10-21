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
    now: () => 0,
    observer: null,
  })
  container = document.createElement('div')
  document.body.append(container)
  scheduler.setRoot(container)
  root = createRoot(container)
})

afterEach(async () => {
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

/** A deterministic random source. */
function random(seed: number) {
  let state = seed
  return (n: number) => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state % n
  }
}

describe('DeferredList', () => {
  it('renders every item once, in order, and keeps mounted nodes through random changes', {
    timeout: 60_000,
  }, async () => {
    for (const seed of [1, 7, 42]) {
      const pick = random(seed)
      let next = 0
      let items: Item[] = Array.from({ length: 700 }, () => ({ key: `k${next++}` }))
      await show(items, 40)
      for (let step = 0; step < 120; step++) {
        const before = new Map(nodes().map((node) => [node.dataset.k, node]))
        const op = pick(4)
        let moved: string | null = null
        if (op === 0) await slice()
        else {
          items = [...items]
          if (op === 1) items.splice(pick(items.length + 1), 0, { key: `k${next++}` })
          else if (op === 2 && items.length > 1) items.splice(pick(items.length), 1)
          else {
            const [item] = items.splice(pick(items.length), 1)
            items.splice(pick(items.length + 1), 0, item)
            moved = item.key
          }
          await show(items, 40)
        }
        const keys = nodes().map((node) => node.dataset.k)
        // the mounted items are the first ones, each once, in order
        expect(keys).toEqual(items.slice(0, keys.length).map(keyOf))
        expect(Number(spacer()?.dataset.boardPending ?? 0)).toBe(items.length - keys.length)
        // a mounted item stays mounted while it is in the list
        const present = new Set(items.map(keyOf))
        for (const key of before.keys()) if (present.has(key)) expect(keys).toContain(key)
        // no mounted node changes, but the one a reorder moved
        for (const node of nodes())
          if (node.dataset.k !== moved && before.has(node.dataset.k))
            expect(before.get(node.dataset.k)).toBe(node)
      }
      while (tasks.length) await slice()
      expect(nodes().map((node) => node.dataset.k)).toEqual(items.map(keyOf))
      expect(spacer()).toBeNull()
      await act(async () => root.unmount())
      root = createRoot(container)
    }
  })

  it('renders a list its first screen covers whole, with no waiting space', async () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ key: `k${n}` }))
    await show(items, 30)
    expect(nodes()).toHaveLength(30)
    expect(spacer()).toBeNull()
    expect(tasks).toHaveLength(0)
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
