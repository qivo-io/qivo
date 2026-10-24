// @vitest-environment jsdom
import { act, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RevealRequest, useReveal } from '@/lib/reveal'
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
/* Frames paint only when a test says so (painted, wait): jsdom's own frames
   come on a timer, and on a busy machine one could paint inside an act. */
const frames = new Map<number, FrameRequestCallback>()
let lastFrame = 0
const paint = () => {
  const due = [...frames.values()]
  frames.clear()
  for (const frame of due) frame(performance.now())
}

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
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.set(++lastFrame, frame)
    return lastFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
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

/** Lets the frame paint and the task after it run. */
const painted = () =>
  act(async () => {
    paint()
    await new Promise((resolve) => setTimeout(resolve, 20))
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
const content = () => container.querySelector<HTMLElement>('[data-kept-content]')

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
    expect(content()?.style.display).toBe('')
    // Activity stops its effects
    expect(counts.running).toBe(0)
    await show(true)
    expect(view().dataset.workspaceView).toBe('kanban')
    expect(view().matches(OUT_OF_USE)).toBe(false)
    expect(content()?.style.display).toBe('')
    expect(counts.running).toBe(1)
    // shown again, not mounted again
    expect(counts.mounts).toBe(1)
  })

  it('does not render for new props while hidden, and shows the latest ones after it shows', async () => {
    await show(true, 'first')
    await show(false, 'first')
    counts.renders.length = 0
    await show(false, 'second')
    expect(counts.renders).toEqual([])
    expect(board()?.dataset.board).toBe('first')
    // the task that shows it shows it as it was, without a render
    await show(true, 'second')
    expect(counts.renders).toEqual([])
    expect(board()?.dataset.board).toBe('first')
    await painted()
    expect(counts.renders).toEqual(['second'])
    expect(board()?.dataset.board).toBe('second')
  })

  it('renders new content in the commit that shows it when it was kept for another variant', async () => {
    const tree = (shown: boolean, label: string, layout: string) =>
      act(async () =>
        root.render(
          <KeptView view="kanban" shown={shown} variant={layout} className="view">
            <Board label={label} />
          </KeptView>,
        ),
      )
    await tree(true, 'desktop', 'desktop')
    await tree(false, 'desktop', 'desktop')
    // the layout changes while it hides: it holds the old layout's content
    counts.renders.length = 0
    await tree(false, 'phone', 'phone')
    expect(counts.renders).toEqual([])
    expect(board()?.dataset.board).toBe('desktop')
    await tree(true, 'phone', 'phone')
    expect(board()?.dataset.board).toBe('phone')
    // kept for the layout it shows in, it shows as it was first
    await tree(false, 'phone', 'phone')
    await tree(true, 'phone again', 'phone')
    expect(board()?.dataset.board).toBe('phone')
    await painted()
    expect(board()?.dataset.board).toBe('phone again')
  })

  it('renders new content in the commit that hides it only when that is for another variant', async () => {
    const tree = (shown: boolean, label: string, variant: string) =>
      act(async () =>
        root.render(
          <KeptView view="inbox" shown={shown} variant={variant} className="view">
            <Board label={label} />
          </KeptView>,
        ),
      )
    await tree(true, 'with a task', 'task')
    counts.renders.length = 0
    // the Inbox hides without its task pane
    await tree(false, 'without', '')
    expect(counts.renders).toEqual(['without'])
    expect(board()?.dataset.board).toBe('without')
    expect(counts.mounts).toBe(1)
    // while hidden, and as it hides for the same variant, it does not render
    await tree(false, 'other', '')
    await tree(true, 'other', '')
    await painted()
    counts.renders.length = 0
    await tree(false, 'again', '')
    expect(counts.renders).toEqual([])
    expect(board()?.dataset.board).toBe('other')
  })

  it('marks its blocks to skip their items for good while hidden, and unmarks them as it shows', async () => {
    const idle: IdleRequestCallback[] = []
    vi.stubGlobal('requestIdleCallback', (step: IdleRequestCallback) => idle.push(step))
    vi.stubGlobal('cancelIdleCallback', () => {})
    const tree = (shown: boolean) =>
      act(async () =>
        root.render(
          <KeptView view="kanban" shown={shown} className="view">
            <div className="deferred-block" />
            <div className="deferred-block" />
          </KeptView>,
        ),
      )
    const marked = () => container.querySelectorAll('[data-kept-hidden]').length
    await tree(true)
    await tree(false)
    expect(marked()).toBe(0)
    for (const step of idle.splice(0)) step({ didTimeout: false, timeRemaining: () => 50 })
    expect(marked()).toBe(2)
    // gone in the commit that shows it, before any frame paints
    await tree(true)
    expect(marked()).toBe(0)
  })

  it('applies its own updates made while hidden once it shows', async () => {
    await show(true)
    await show(false)
    await act(async () => bump())
    // the render while hidden does not leave Activity's display: none on
    expect(content()?.style.display).toBe('')
    await show(true)
    expect(board()?.dataset.n).toBe('1')
  })

  it('leaves content that a Suspense inside hid hidden when it shows again', async () => {
    const Never = lazy(() => new Promise<{ default: () => null }>(() => {}))
    const tree = (shown: boolean, waiting: boolean) =>
      act(async () =>
        root.render(
          <KeptView view="kanban" shown={shown} className="view">
            <Suspense fallback={<span data-fallback />}>
              <div data-board="board">{waiting && <Never />}</div>
            </Suspense>
          </KeptView>,
        ),
      )
    await tree(true, false)
    // the view's code for a part is still on its way: Suspense hides the rest
    await tree(true, true)
    expect(board()?.style.display).toBe('none')
    await tree(false, true)
    await tree(true, true)
    expect(content()?.style.display).toBe('')
    expect(board()?.style.display).toBe('none')
    expect(container.querySelector('[data-fallback]')).not.toBeNull()
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

  it('does not take a reveal request again that it took before it hid', async () => {
    const taken: string[] = []
    const mounted: string[] = []
    function Revealer({ request }: { request: RevealRequest | null }) {
      const pane = useRef<HTMLDivElement>(null)
      useReveal(
        request,
        () => taken.push(request?.id ?? ''),
        pane,
        (id) => mounted.push(id),
      )
      return <div ref={pane} />
    }
    const tree = (shown: boolean, request: RevealRequest | null) =>
      act(async () =>
        root.render(
          <KeptView view="kanban" shown={shown} className="view">
            <Revealer request={request} />
          </KeptView>,
        ),
      )
    await tree(true, { id: 'a', n: 1 })
    await painted()
    // it hides before the parent's cleared request reaches it, and comes
    // back for another
    await tree(false, { id: 'a', n: 1 })
    await tree(true, { id: 'b', n: 2 })
    await painted()
    await painted()
    expect(taken).toEqual(['a', 'b'])
    expect(mounted).toEqual(['a', 'b'])
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
/** Lets a frame paint and `ms` pass. */
const wait = (ms: number) =>
  act(async () => {
    paint()
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

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
  it('takes a view apart in a hidden tab, where no frame paints', async () => {
    await keep('a', true)
    await keep('a', false)
    const old = views()[0]
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      // released after a while without input, as the tab sits in the background
      await keep(null, false)
      for (let i = 0; i < 50 && old.isConnected; i++)
        await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    } finally {
      Reflect.deleteProperty(document, 'hidden')
    }
    expect(frames.size).toBe(0)
    expect(old.isConnected).toBe(false)
    expect(views()).toHaveLength(0)
  })
})
