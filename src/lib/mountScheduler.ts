import { useEffect } from 'react'
import { flushSync } from 'react-dom'

/* Mounts long lists in short slices after their first screen. Each list
   (a DeferredList) registers how many of its items still wait to mount and
   how to mount more. One slice is one posted task: it mounts about 8ms of
   items, lists near the view first, then in document order. Slices follow
   each other within 24ms of a frame's start, then wait for the next frame,
   so input runs between them, the browser renders between frames, and a
   frame stays under about 50ms. The scheduler marks its root while
   anything waits, without a React render. */

/** A list the scheduler mounts. `pending` is how many of its items still
    wait; `grow(n)` mounts the next `n` of them and `mountThrough(key)` the
    ones up to the item `key`. `spacer` is the element standing in for the
    waiting items. */
export type DeferredMount = {
  id: string
  spacer: () => Element | null
  pending: () => number
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
}

/** The time one slice aims to take, the time into a frame after which
    slices wait for the next frame, and a slice's first, least and most
    items. */
const SLICE_MS = 8
const FRAME_MS = 24
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

  const pendingLists = () => [...lists.values()].filter((list) => list.pending() > 0)

  /* The root's marks: pending with aria-busy while any list waits, then
     complete. */
  const mark = () => {
    if (!root) return
    const pending = pendingLists().length > 0
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
    if (mounted > 0) {
      const sample = Math.max(1, elapsed) / mounted
      perItem = perItem === null ? sample : perItem * 0.7 + sample * 0.3
      size = Math.min(MAX_SLICE, size * 2, Math.max(MIN_SLICE, Math.round(SLICE_MS / perItem)))
    }
    changed()
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
    })
  }

  function setRoot(next: HTMLElement | null) {
    if (root === next) return
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
    /** Whether any list still waits. */
    pending: () => pendingLists().length > 0,
    /** Mounts all of the list `id` now. */
    completeList(id: string) {
      const list = lists.get(id)
      if (!list?.pending()) return
      flush(() => list.grow(list.pending()))
      changed()
    },
    /** Mounts the list `id` up to its item `key` now. */
    mountThrough(id: string, key: string) {
      const list = lists.get(id)
      if (!list?.pending()) return
      flush(() => list.mountThrough(key))
      changed()
    },
    /** Mounts every list now, for Find or printing. */
    completeAll() {
      const waiting = pendingLists()
      if (!waiting.length) return
      flush(() => {
        for (const list of waiting) list.grow(list.pending())
      })
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
      const key = event.key.toLowerCase()
      const command = event.ctrlKey || event.metaKey
      if (
        event.key === 'F3' ||
        (command && (key === 'f' || key === 'g')) ||
        (command && key === 'a' && !editable(event.target))
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
