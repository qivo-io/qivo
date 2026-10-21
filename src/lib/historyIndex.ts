/* Where the page's current entry sits in this tab's session history.

   A popstate cannot be cancelled. When the app refuses a Back or Forward
   (a window holds unsent text, lib/popRefusal), it steps back to the entry
   it left with history.go, which keeps the entries on both sides, and needs
   the direction and distance for that. Every entry's state carries its
   position as `qivoAt`, stamped by the pushState and replaceState wrappers
   that installHistoryIndex puts in place at start. Its own popstate
   listener, the page's first, records each move, also while no view that
   reads it is mounted. */

let at = 0
let moved: number | null = null

/** The position `state` carries, or null. */
const positionIn = (state: unknown) => {
  const to = state !== null && typeof state === 'object' ? Reflect.get(state, 'qivoAt') : null
  return typeof to === 'number' ? to : null
}

/** The state `state` with the position `index` added. */
const stamped = (state: unknown, index: number) => ({
  ...(state !== null && typeof state === 'object' ? state : {}),
  qivoAt: index,
})

/** Stamps the current entry and every entry the page adds or replaces from
    now on, and records each popstate's move. Answers a function that
    removes the wrappers and the listener. */
export function installHistoryIndex(win: Window = window) {
  const h = win.history
  const push = h.pushState.bind(h)
  const replace = h.replaceState.bind(h)
  at = positionIn(h.state) ?? 0
  replace(stamped(h.state, at), '')
  h.pushState = (state, unused, url) => {
    at += 1
    push(stamped(state, at), unused, url)
  }
  h.replaceState = (state, unused, url) => replace(stamped(state, at), unused, url)
  const record = () => {
    const to = positionIn(h.state)
    moved = to === null ? null : to - at
    if (to !== null) at = to
  }
  win.addEventListener('popstate', record)
  return () => {
    Reflect.deleteProperty(h, 'pushState')
    Reflect.deleteProperty(h, 'replaceState')
    win.removeEventListener('popstate', record)
  }
}

/** For a popstate listener: how many entries this popstate moved, negative
    for Back, or null for an entry without a position, such as one a page
    before this one added. */
export const lastStep = () => moved

/** The current entry's position. */
export const position = () => at
