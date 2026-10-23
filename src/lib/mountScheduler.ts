import { useEffect } from 'react'
import { flushSync } from 'react-dom'

/* Mounts long lists in short slices after their first screen. Each list
   (a DeferredList) registers how many of its items still wait to mount and
   how to mount more. One slice is one posted task: it mounts about 8ms of
   items, lists near the view first, then in document order. Slices follow
   each other within 16ms of a frame's start, then wait for the next frame,
   so input runs between them, the browser renders between frames, and a
   frame stays under about 50ms. The scheduler marks its root while
   anything waits, without a React render. Once nothing waits after it
   mounted items, it has the browser lay out the blocks it skips offscreen
   (DeferredList.css) while the page is idle, so a block that scrolls into
   view later only paints. */

/** A list the scheduler mounts. `pending` is how many of its items still
    wait; `grow(n)` mounts the next `n` of them and `mountThrough(key)` the
    ones up to the item `key`. `spacer` is the element standing in for the
    waiting items. While `holds` answers true, slices leave the list be. */
export type DeferredMount = {
  id: string
  spacer: () => Element | null
  pending: () => number
  holds?: () => boolean
  grow: (n: number) => void
  mountThrough: (key: string) => void
}

type Observer = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>
type ObserverFactory = (
  receive: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void,
  options: IntersectionObserverInit,
) => Observer

type Options = {
  /** runs a task soon, without the clamping nested timers get */
  post?: (task: () => void) => void
  /** runs a callback at the start of the next frame */
  frame?: (callback: () => void) => void
  now?: () => number
  /** commits the React updates `grow` makes inside it before returning */
  flush?: (work: () => void) => void
  observer?: ObserverFactory | null
  /** runs a task when the page is idle, with the time left; none skips
      laying out the offscreen blocks ahead */
  idle?: ((task: (deadline: { timeRemaining: () => number }) => void) => void) | null
}

/** The time one slice aims to take, the time into a frame after which
    slices wait for the next frame, and a slice's first, least and most
    items. */
const SLICE_MS = 8
const FRAME_MS = 16
const FIRST_SLICE = 8
const MIN_SLICE = 1
const MAX_SLICE = 512

/* A MessageChannel task, which the browser does not clamp the way it
   clamps nested timers, so slices follow each other without idle gaps. */
function postMessageTask(task: () => void) {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => {
    channel.port1.close()
    task()
  }
  channel.port2.postMessage(null)
}

const defaultIdle: Options['idle'] =
  typeof requestIdleCallback === 'undefined' ? null : (task) => requestIdleCallback(task)

/* The skipped blocks idle layout reaches, and the time it leaves in an
   idle period for the browser's own work. */
const SKIPPED = '[data-deferred-block]'
const IDLE_SPARE_MS = 2

const defaultObserver: ObserverFactory | null =
  typeof IntersectionObserver === 'undefined'
    ? null
    : (receive, options) => new IntersectionObserver(receive, options)

/** A scheduler for one view. Give it the view's scrolling element with
    `setRoot`, register its lists, and dispose of it when the view goes. */
export function createMountScheduler({
  post = postMessageTask,
  frame = (callback) => requestAnimationFrame(() => callback()),
  now = () => performance.now(),
  flush = flushSync,
  observer: factory = defaultObserver,
  idle = defaultIdle,
}: Options = {}) {
  const lists = new Map<string, DeferredMount>()
  // the lists whose spacer is within 500px of the view
  const near = new Set<string>()
  const watched = new Map<Element, string>()
  let observer: Observer | null = null
  let root: HTMLElement | null = null
  let size = FIRST_SLICE
  // an item's mounting time, averaged over the slices so far
  let perItem: number | null = null
  let scheduled = false
  // when the current frame started, as its frame callback saw it
  let frameStart = Number.NEGATIVE_INFINITY
  let disposed = false
  // the blocks idle layout has laid out, whether a pass is under way, and
  // whether lists mounted items since the last pass began
  const laidOut = new WeakSet<Element>()
  let warming = false
  let mountedSince = false

  // the lists with items waiting, and those of them slices mount
  const waitingLists = () => [...lists.values()].filter((list) => list.pending() > 0)
  const pendingLists = () => waitingLists().filter((list) => !list.holds?.())

  /* The root's marks: pending with aria-busy while any list waits, held
     ones included, then complete. */
  const mark = () => {
    if (!root) return
    const pending = waitingLists().length > 0
    const state = pending ? 'pending' : 'complete'
    const was = root.getAttribute('data-board-mount')
    if (was === state || (!pending && was === null)) return
    root.setAttribute('data-board-mount', state)
    if (pending) root.setAttribute('aria-busy', 'true')
    else root.removeAttribute('aria-busy')
  }

  /* Watches each waiting list's spacer, which a render can replace. */
  const watch = () => {
    if (!observer) return
    const spacers = new Map<Element, string>()
    for (const list of pendingLists()) {
      const spacer = list.spacer()
      if (spacer) spacers.set(spacer, list.id)
    }
    for (const [element, id] of watched)
      if (spacers.get(element) !== id) {
        observer.unobserve(element)
        watched.delete(element)
        near.delete(id)
      }
    for (const [element, id] of spacers)
      if (!watched.has(element)) {
        watched.set(element, id)
        observer.observe(element)
      }
  }

  const schedule = () => {
    if (scheduled || disposed || !root || !pendingLists().length) return
    scheduled = true
    if (now() - frameStart < FRAME_MS) post(slice)
    else
      frame(() => {
        frameStart = now()
        post(slice)
      })
  }

  /* Near lists first, then the rest in document order. */
  const ordered = () =>
    pendingLists().sort((a, b) => {
      const nearness = Number(near.has(b.id)) - Number(near.has(a.id))
      if (nearness) return nearness
      const x = a.spacer()
      const y = b.spacer()
      if (!x || !y || x === y) return 0
      return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })

  function slice() {
    scheduled = false
    if (disposed || !root) return
    const start = now()
    let budget = size
    flush(() => {
      for (const list of ordered()) {
        if (budget <= 0) break
        const n = Math.min(budget, list.pending())
        list.grow(n)
        budget -= n
      }
    })
    const elapsed = now() - start
    // The items this slice mounted, at the time they took, size the next
    // one. The time per item is averaged over slices, so one slice that ran
    // quickly, or found few items left, does not make the next one long; a
    // slice at most doubles.
    const mounted = size - budget
    if (mounted > 0) mountedSince = true
    if (mounted > 0) {
      const sample = Math.max(1, elapsed) / mounted
      perItem = perItem === null ? sample : perItem * 0.7 + sample * 0.3
      size = Math.min(MAX_SLICE, size * 2, Math.max(MIN_SLICE, Math.round(SLICE_MS / perItem)))
    }
    changed()
  }

  /* Lays out, while the page is idle, each block the browser skips that it
     has not laid out yet: reading a box inside a skipped block lays out
     that block alone, and the browser keeps the result, so the frame that
     scrolls it into view only paints it. An idle task reads blocks until
     its idle period has 2ms left, so input waits at most for the rest of
     the period, up to 50ms, and one block. A pass stops when a list waits
     to mount again; the next starts when none does, or when a pass ends,
     if the scheduler mounted items since the last one began: registered
     lists, slices and the mounts it was asked for. Items a list's own
     render adds, at most MOST_AT_ONCE (DeferredList), and a laid out
     block whose items change, lay out when they come into view. */
  const warm = () => {
    if (warming || !mountedSince || !idle || disposed || !root || pendingLists().length) return
    warming = true
    mountedSince = false
    let queue: Element[] | null = null
    const step = (deadline: { timeRemaining: () => number }) => {
      if (disposed || !root || pendingLists().length) {
        warming = false
        return
      }
      queue ??= [...root.querySelectorAll(SKIPPED)].filter((block) => !laidOut.has(block))
      while (queue.length && deadline.timeRemaining() > IDLE_SPARE_MS) {
        const block = queue.shift() as Element
        if (!block.isConnected) continue
        block.firstElementChild?.getBoundingClientRect()
        laidOut.add(block)
      }
      if (queue.length) idle(step)
      else {
        // lists that mounted during the pass may have added blocks
        warming = false
        warm()
      }
    }
    idle(step)
  }

  /** Brings marks, watched spacers and the next slice up to date, once
      for every change in the same task and before the browser paints.
      Lists call it after a render changed what they wait for. */
  let changing = false
  function changed() {
    if (changing) return
    changing = true
    queueMicrotask(() => {
      changing = false
      if (disposed) return
      watch()
      mark()
      schedule()
      warm()
    })
  }

  function setRoot(next: HTMLElement | null) {
    if (root === next) return
    // the marks belong to the waiting lists, not to an element a new
    // layout may leave in the page
    root?.removeAttribute('data-board-mount')
    root?.removeAttribute('aria-busy')
    observer?.disconnect()
    observer = null
    watched.clear()
    near.clear()
    root = next
    if (root && factory)
      observer = factory(
        (entries) => {
          for (const entry of entries) {
            const id = watched.get(entry.target)
            if (id === undefined) continue
            if (entry.isIntersecting) near.add(id)
            else near.delete(id)
          }
        },
        { root, rootMargin: '500px' },
      )
    changed()
  }

  return {
    register(list: DeferredMount) {
      lists.set(list.id, list)
      mountedSince = true
      changed()
      return () => {
        if (lists.get(list.id) !== list) return
        lists.delete(list.id)
        near.delete(list.id)
        changed()
      }
    },
    changed,
    setRoot,
    /** Whether any list still waits, held ones included. */
    pending: () => waitingLists().length > 0,
    /** Mounts all of the list `id` now. */
    completeList(id: string) {
      const list = lists.get(id)
      if (!list?.pending()) return
      flush(() => list.grow(list.pending()))
      mountedSince = true
      changed()
    },
    /** Mounts the list `id` up to its item `key` now. */
    mountThrough(id: string, key: string) {
      const list = lists.get(id)
      if (!list?.pending()) return
      flush(() => list.mountThrough(key))
      mountedSince = true
      changed()
    },
    /** Mounts every list now, for Find or printing. */
    completeAll() {
      const waiting = waitingLists()
      if (!waiting.length) return
      flush(() => {
        for (const list of waiting) list.grow(list.pending())
      })
      mountedSince = true
      changed()
    },
    /** Stops slicing; `revive` starts it again (a remount in development). */
    dispose() {
      disposed = true
      observer?.disconnect()
      observer = null
      watched.clear()
      near.clear()
    },
    revive() {
      if (!disposed) return
      disposed = false
      const current = root
      root = null
      setRoot(current)
    },
  }
}

export type MountScheduler = ReturnType<typeof createMountScheduler>

/* Whether a key press goes to a field, where Ctrl+A selects its text. */
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || !!target.closest('input, textarea, select'))

/** Runs `scheduler` while the calling view is mounted, and mounts all of
    its lists before the browser's Find (Ctrl+F or Cmd+F, Ctrl+G, F3),
    Select all outside a field, or printing, which read the whole page. */
export function useMountGuards(scheduler: MountScheduler) {
  useEffect(() => {
    scheduler.revive()
    const onKey = (event: KeyboardEvent) => {
      if (!scheduler.pending()) return
      // by character, and by physical key for layouts whose letters differ
      const key = (letter: string) =>
        event.key.toLowerCase() === letter || event.code === `Key${letter.toUpperCase()}`
      const command = event.ctrlKey || event.metaKey
      if (
        event.key === 'F3' ||
        (command && (key('f') || key('g'))) ||
        (command && key('a') && !editable(event.target))
      )
        scheduler.completeAll()
    }
    const onPrint = () => scheduler.completeAll()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('beforeprint', onPrint)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('beforeprint', onPrint)
      scheduler.dispose()
    }
  }, [scheduler])
}
