type Observer = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>
type Factory = (
  receive: (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void,
  options: IntersectionObserverInit,
) => Observer

/** One observer activates task controls near the scrollport. Activation is
 * permanent for a mounted row, so scrolling never interrupts a drag or menu. */
export function createRowObserver(
  factory: Factory | null = typeof IntersectionObserver === 'undefined'
    ? null
    : (receive, options) => new IntersectionObserver(receive, options),
) {
  const pending = new Map<Element, () => void>()
  let observer: Observer | null = null
  let root: Element | null = null
  let generation = 0

  const activate = (element: Element) => {
    const receive = pending.get(element)
    if (!receive) return
    pending.delete(element)
    observer?.unobserve(element)
    receive()
  }

  return {
    setRoot(next: Element | null) {
      if (root === next) return
      observer?.disconnect()
      observer = null
      root = next
      const current = ++generation
      if (!root) return
      if (!factory) {
        for (const element of pending.keys()) activate(element)
        return
      }
      observer = factory(
        (entries) => {
          if (current !== generation) return
          for (const entry of entries) if (entry.isIntersecting) activate(entry.target)
        },
        { root, rootMargin: '500px' },
      )
      for (const element of pending.keys()) observer.observe(element)
    },
    observe(element: Element, receive: () => void) {
      pending.set(element, receive)
      if (observer) observer.observe(element)
      else if (root && !factory) activate(element)
      return () => {
        pending.delete(element)
        observer?.unobserve(element)
      }
    },
    dispose() {
      generation++
      observer?.disconnect()
      observer = null
      root = null
      pending.clear()
    },
  }
}

export type RowObserver = ReturnType<typeof createRowObserver>
