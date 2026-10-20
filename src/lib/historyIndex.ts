/* Where the page's current entry sits in this tab's session history.

   A popstate cannot be cancelled. When the app refuses a Back or Forward
   (a window holds unsent text, components/DiscardPrompt), it steps back to
   the entry it left with history.go, which keeps the entries on both sides,
   and needs the direction and distance for that. Every entry's state
   carries its position as `qivoAt`, stamped by the pushState and
   replaceState wrappers that installHistoryIndex puts in place at start. */

let at = 0

/** The state `state` with the position `index` added. */
const stamped = (state: unknown, index: number) => ({
  ...(state !== null && typeof state === 'object' ? state : {}),
  qivoAt: index,
})

/** Stamps the current entry and every entry the page adds or replaces from
    now on. Answers a function that removes the wrappers. */
export function installHistoryIndex(h: History = history) {
  const push = h.pushState.bind(h)
  const replace = h.replaceState.bind(h)
  const current: unknown = h.state?.qivoAt
  at = typeof current === 'number' ? current : 0
  replace(stamped(h.state, at), '')
  h.pushState = (state, unused, url) => {
    at += 1
    push(stamped(state, at), unused, url)
  }
  h.replaceState = (state, unused, url) => replace(stamped(state, at), unused, url)
  return () => {
    Reflect.deleteProperty(h, 'pushState')
    Reflect.deleteProperty(h, 'replaceState')
  }
}

/** For a popstate: how many entries the browser moved, negative for Back,
    and records the entry it moved to. Null for an entry without a position,
    such as one a page before this one added. */
export function stepTo(state: unknown): number | null {
  const to = state !== null && typeof state === 'object' ? Reflect.get(state, 'qivoAt') : null
  if (typeof to !== 'number') return null
  const step = to - at
  at = to
  return step
}
