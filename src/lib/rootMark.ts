import { useLayoutEffect } from 'react'

/* Data attributes on <html> that say a component is mounted, for a
   stylesheet that would otherwise ask html:has(). A :has() over the whole
   document makes the browser restyle every element whenever any element is
   added or removed anywhere, which on a large Roadmap costs tens of
   milliseconds per change. A mark stays while anything holds it. */
const holders = new Map<string, number>()

/** Sets `data-<name>` on <html> until the returned release runs. Holders
    of one name share the attribute; it goes with the last release. */
export function holdRootMark(name: string): () => void {
  const root = document.documentElement
  holders.set(name, (holders.get(name) ?? 0) + 1)
  root.setAttribute(`data-${name}`, '')
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (holders.get(name) ?? 1) - 1
    if (left > 0) holders.set(name, left)
    else {
      holders.delete(name)
      root.removeAttribute(`data-${name}`)
    }
  }
}

/** Holds the root mark `name` while the calling component is mounted,
    set before the browser paints it. */
export function useRootMark(name: string) {
  useLayoutEffect(() => holdRootMark(name), [name])
}
