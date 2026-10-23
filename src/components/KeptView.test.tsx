// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUT_OF_USE } from '@/lib/viewHidden'
import { useDropped } from '@/lib/viewTeardown'
import { KeptView, ViewKeeper } from './KeptView'
import { AnchoredPop } from './qivo'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

// the pop comes with the store, which would connect
vi.mock('@/lib/convex', () => ({
  convex: { mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() },
}))
vi.mock('@/lib/auth', () => ({ armConvexAuth: vi.fn(), authClient: {}, signOut: vi.fn() }))

/* A stand-in Board: it counts its mounts, renders and running effects, and
   can hold an open popover and pop. */
const counts = { mounts: 0, renders: [] as string[], running: 0 }
let bump: () => void = () => {}

function Board({ label, layers = false }: { label: string; layers?: boolean }) {
  counts.renders.push(label)
  // state starts once per mount; effects run again each time it shows
  useState(() => counts.mounts++)
  const [n, setN] = useState(0)
  useEffect(() => {
    bump = () => setN((value) => value + 1)
  })
  useEffect(() => {
    counts.running++
    return () => {
      counts.running--
    }
  }, [])
  return (
    <div data-board={label} data-n={n}>
      <span data-card>Card</span>
      {layers && (
        <>
          <Popover open>
            <PopoverTrigger>Owner</PopoverTrigger>
            <PopoverContent data-menu>People</PopoverContent>
          </Popover>
          <AnchoredPop x={10} y={10} onClose={() => {}}>
            <span data-pop />
          </AnchoredPop>
        </>
      )}
    </div>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // a popover's position follows its trigger's size
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  counts.mounts = 0
  counts.renders.length = 0
  counts.running = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const show = (shown: boolean, label = 'board', layers = false) =>
  act(async () =>
    root.render(
      <KeptView view="kanban" shown={shown} className="view">
        <Board label={label} layers={layers} />
      </KeptView>,
    ),
  )
const view = () => container.firstElementChild as HTMLElement
const board = () => container.querySelector<HTMLElement>('[data-board]')

describe('KeptView', () => {
  it('keeps the view mounted while hidden, out of use, unmarked and inactive', async () => {
    await show(true)
    expect(view().dataset.workspaceView).toBe('kanban')
    expect(counts.running).toBe(1)
    await show(false)
    expect(view().dataset.workspaceView).toBeUndefined()
    expect(view().dataset.hiddenView).toBe('kanban')
    // focus that comes back looks past it; not inert, which would restyle
    // every element when it shows again
    expect(view().matches(OUT_OF_USE)).toBe(true)
    expect(view().hasAttribute('inert')).toBe(false)
    // hidden by the container, which keeps its layout, and not by the
    // display: none Activity gives its elements, which would drop it
    expect(view().className).toContain('[content-visibility:hidden]')
    expect(board()?.style.display).toBe('')
    // Activity stops its effects
    expect(counts.running).toBe(0)
    await show(true)
    expect(view().dataset.workspaceView).toBe('kanban')
    expect(view().matches(OUT_OF_USE)).toBe(false)
    expect(board()?.style.display).toBe('')
    expect(counts.running).toBe(1)
    // shown again, not mounted again
    expect(counts.mounts).toBe(1)
  })

  it('does not render for new props while hidden, and shows the latest ones', async () => {
    await show(true, 'first')
    await show(false, 'first')
    counts.renders.length = 0
    await show(false, 'second')
    expect(counts.renders).toEqual([])
    expect(board()?.dataset.board).toBe('first')
    await show(true, 'second')
    expect(board()?.dataset.board).toBe('second')
  })

  it('applies its own updates made while hidden once it shows', async () => {
    await show(true)
    await show(false)
    await act(async () => bump())
    // the render while hidden does not leave Activity's display: none on
    expect(board()?.style.display).toBe('')
    await show(true)
    expect(board()?.dataset.n).toBe('1')
  })

  it('closes its pop-ups while hidden, and they leave the page', async () => {
    await show(true, 'board', true)
    expect(document.querySelector('[data-menu]')).not.toBeNull()
    expect(document.querySelector('[data-pop]')).not.toBeNull()
    // gone in the switch itself, before React's idle work for hidden trees
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
    flushSync(() =>
      root.render(
        <KeptView view="kanban" shown={false} className="view">
          <Board label="board" layers />
        </KeptView>,
      ),
    )
    expect(document.querySelector('[data-menu]')).toBeNull()
    expect(document.querySelector('[data-pop]')).toBeNull()
    expect(document.querySelector('[data-anchoredpop-backdrop]')).toBeNull()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    await act(async () => {})
    await show(true, 'board', true)
    expect(document.querySelector('[data-menu]')).not.toBeNull()
  })
})

/** A part of a stand-in Board that a leaving view drops (DeferredList's
    blocks in the real one). */
function Part({ n }: { n: number }) {
  const dropped = useDropped()
  return dropped ? null : <span data-part={n} />
}

function Parts({ label, count }: { label: string; count: number }) {
  return (
    <div data-board={label}>
      {Array.from({ length: count }, (_, n) => `${label}-${n}`).map((id, n) => (
        <Part key={id} n={n} />
      ))}
    </div>
  )
}

const keep = (id: string | null, shown: boolean) =>
  act(async () =>
    root.render(
      <ViewKeeper id={id} view="kanban" shown={shown} className="view">
        {id && <Parts label={id} count={10} />}
      </ViewKeeper>,
    ),
  )
const views = () => [...container.children] as HTMLElement[]
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

describe('ViewKeeper', () => {
  it('keeps the view of one id across hides, and takes the old one apart in slices when the id changes', async () => {
    await keep('a', true)
    await keep('a', false)
    await keep('a', true)
    expect(views()).toHaveLength(1)
    await keep('a', false)
    // removals the test sees, one list per commit that removed parts
    const slices: number[] = []
    const watch = new MutationObserver((records) => {
      const removed = records.flatMap((record) => [...record.removedNodes])
      const parts = removed.filter((node) => node instanceof HTMLElement && node.dataset.part)
      if (parts.length) slices.push(parts.length)
    })
    watch.observe(container, { childList: true, subtree: true })
    await keep('b', false)
    // the new id's view first; the old one stays whole, hidden, until a paint
    expect(
      views().map((view) => view.querySelector('[data-board]')?.getAttribute('data-board')),
    ).toEqual(['b', 'a'])
    const old = views()[1]
    expect(old.matches(OUT_OF_USE)).toBe(true)
    expect(old.dataset.workspaceView).toBeUndefined()
    expect(old.querySelectorAll('[data-part]')).toHaveLength(10)
    for (let i = 0; i < 50 && old.isConnected; i++) await wait(20)
    watch.disconnect()
    expect(old.isConnected).toBe(false)
    // the parts went a few at a time, though the view was hidden all along
    expect(slices).toEqual([4, 4, 2])
    expect(views()).toHaveLength(1)
  })

  it('mounts the view of an id anew that comes back while its old view leaves', async () => {
    const keeper = (id: string | null) => (
      <ViewKeeper id={id} view="kanban" shown={id !== null} className="view">
        {id && <Parts label={id} count={10} />}
      </ViewKeeper>
    )
    await act(async () => root.render(keeper('a')))
    // the id goes and comes back in one task, before the old view's first slice
    await act(async () => {
      flushSync(() => root.render(keeper(null)))
      expect(views()).toHaveLength(1)
      root.render(keeper('a'))
    })
    expect(views()).toHaveLength(2)
    expect(views()[0].dataset.workspaceView).toBe('kanban')
    expect(views()[0].querySelectorAll('[data-part]')).toHaveLength(10)
    expect(views()[1].dataset.workspaceView).toBeUndefined()
    for (let i = 0; i < 50 && views().length > 1; i++) await wait(20)
    expect(views()).toHaveLength(1)
    expect(views()[0].dataset.workspaceView).toBe('kanban')
    expect(views()[0].querySelectorAll('[data-part]')).toHaveLength(10)
  })
})
