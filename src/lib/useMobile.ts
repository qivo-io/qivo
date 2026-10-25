import { useEffect, useId, useRef, useSyncExternalStore } from 'react'
import { afterTraversal, stepBack } from './historyIndex'

/* One media query list for the phone breakpoint, and one listener on it,
   however many components ask. Every writable Board card asks through its
   owner picker. The list is made on first use and made again when
   window.matchMedia is another function, as tests stub it. */
let phone: { matchMedia: typeof window.matchMedia; list: MediaQueryList } | null = null
const phoneListeners = new Set<() => void>()
const phoneChanged = () => {
  for (const listener of phoneListeners) listener()
}
function phoneQuery() {
  if (phone?.matchMedia !== window.matchMedia) {
    if (phoneListeners.size) phone?.list.removeEventListener('change', phoneChanged)
    phone = { matchMedia: window.matchMedia, list: window.matchMedia('(max-width: 760px)') }
    if (phoneListeners.size) phone.list.addEventListener('change', phoneChanged)
  }
  return phone.list
}
function subscribePhone(listener: () => void) {
  const list = phoneQuery()
  if (!phoneListeners.size) list.addEventListener('change', phoneChanged)
  phoneListeners.add(listener)
  return () => {
    phoneListeners.delete(listener)
    if (!phoneListeners.size) phone?.list.removeEventListener('change', phoneChanged)
  }
}

/** Keep phone navigation and its full-page layers on the same breakpoint. */
export function useMobile() {
  return useSyncExternalStore(subscribePhone, () => phoneQuery().matches)
}

/* A phone layer marks its Back step with an entry of its own, a copy of
   the page's with `qivoLayer` added. Layers that closed without their Back
   step in this turn, as a finished dialog does, with the state of the
   entry below each one's marker. Once the turn ends the page steps back
   over the ones on top of the history (settle), so the next Back leaves
   the page instead of landing on an entry with the page's own address. */
const closed = new Map<string, unknown>()
// what waits for those markers to go (whenHistorySettled)
let waiting: (() => void)[] = []
// a step back over closed layers' markers on its way
let stepping = false
// who hears that it landed (onHistorySettled)
const settledListeners = new Set<() => void>()

/** Whether the page is stepping back over closed layers' markers, while
    the address is not yet the entry's it lands on (App's url sync). */
export const historyStepping = () => stepping || closed.size > 0

/** Calls `listener` each time the markers of layers that closed are gone,
    once the page's step back over them landed or found none on top.
    Answers a function that stops it. */
export function onHistorySettled(listener: () => void) {
  settledListeners.add(listener)
  return () => {
    settledListeners.delete(listener)
  }
}

/** Runs `fn` once closed layers' markers are gone and the page's moves have
    landed, at once when nothing is on its way, so what it reads of
    history.state is the entry the page is on. */
export function whenHistorySettled(fn: () => void) {
  if (historyStepping()) waiting.push(fn)
  else afterTraversal(fn)
}

/** Notes that layer `id`, whose marker sits over an entry with state
    `below`, closed without its Back step. */
function retire(id: string, below: unknown) {
  if (!closed.size) queueMicrotask(() => afterTraversal(settle))
  closed.set(id, below)
}

/** Steps back over the closed layers' markers on top of the history in
    one move. The address stays the one the page shows, so a change made in
    place over a marker, such as App naming a task that left the board,
    moves down with it. A move of the person's that lands first, such as a
    pick from the browser's Back menu, keeps the page on the entry it
    reached (lib/historyIndex stepBack), which keeps its own address. */
function settle() {
  let steps = 0
  let state = history.state
  while (state?.qivoLayer && closed.has(state.qivoLayer)) {
    const below = closed.get(state.qivoLayer)
    closed.delete(state.qivoLayer)
    state = below
    steps += 1
  }
  // the others are under an entry the page added since, or gone already
  closed.clear()
  const done = () => {
    stepping = false
    for (const listener of settledListeners) listener()
    const ready = waiting
    waiting = []
    // after any layer that closed meanwhile, too
    for (const fn of ready) whenHistorySettled(fn)
  }
  if (!steps) return done()
  stepping = true
  const href = location.href
  void stepBack(steps).then((landed) => {
    if (landed && location.href !== href) history.replaceState(history.state, '', href)
    done()
  })
}

/** Give a phone overlay one Back step without changing its underlying URL.
 * Completion may unmount it directly; the page then steps back over its
 * history marker (settle) once the turn ends, together with every other
 * layer that closed in it.
 * An explicit enabled value keeps a phone layer through landscape rotation.
 * A close repeated while one waits for the page's moves or its Back step is
 * on its way is dropped, so `onClose` runs once and the page takes one Back.
 * `onClose` may return false to stay open (a dialog busy with something that
 * must finish). After a Back step the layer then pushes its marker again, so
 * the next Back still closes the layer instead of leaving the page. `onClose`
 * gets the layer's close, so a close it holds back can run it again later. */
export function useMobileBackLayer(
  open: boolean,
  onClose: (close: () => void) => unknown,
  enabled?: boolean,
) {
  const mobile = useMobile()
  const useHistory = enabled ?? mobile
  const id = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const active = useRef(false)
  const leaving = useRef(false)
  // a close waiting for the page's moves to land (whenHistorySettled)
  const queued = useRef(false)
  const close = () => {
    if (queued.current || leaving.current) return
    queued.current = true
    whenHistorySettled(() => {
      queued.current = false
      if (active.current && history.state?.qivoLayer === id) {
        leaving.current = true
        history.back()
      } else closeRef.current(close)
    })
  }
  useEffect(() => {
    if (!useHistory || !open) return
    let disposed = false
    let registered = false
    // the state of the entry below the marker
    let below: unknown
    const pop = () => {
      if (history.state?.qivoLayer !== id) {
        active.current = false
        leaving.current = false
        if (closeRef.current(close) === false) {
          // refused: restore the marker this Back step used up
          below = history.state
          history.pushState({ ...history.state, qivoLayer: id }, '', location.href)
          active.current = true
        }
      }
    }
    // A task's Plan action mounts Roadmap before App's URL-sync effect runs.
    // Register after that effect so the layer belongs to the destination URL
    // and its marker cannot be covered by the route's own history entry,
    // and after any step on its way, which would undo the push.
    queueMicrotask(() =>
      whenHistorySettled(() => {
        if (disposed) return
        below = history.state
        history.pushState({ ...history.state, qivoLayer: id }, '', location.href)
        active.current = true
        registered = true
        window.addEventListener('popstate', pop)
      }),
    )
    return () => {
      disposed = true
      window.removeEventListener('popstate', pop)
      const backPending = leaving.current
      active.current = false
      leaving.current = false
      // closed without its Back step, as a finished dialog does
      if (registered && !backPending) retire(id, below)
    }
  }, [useHistory, open, id])
  return close
}

/** useMobileBackLayer for a menu whose pick may move the page: `close(then)`
 * runs `then` (the pick) only once the menu and its history marker are gone,
 * so a pick that rewrites the address or opens the next layer lands on the
 * page's own entry rather than racing the pending Back step. Without a layer
 * (off the phone, or `wanted` false) it closes and picks at once. */
export function useMenuBackLayer(open: boolean, onClose: () => void, wanted = true) {
  const pending = useRef<(() => void) | null>(null)
  const close = useMobileBackLayer(
    open,
    () => {
      onClose()
      const then = pending.current
      pending.current = null
      then?.()
    },
    wanted ? undefined : false,
  )
  return (then?: () => void) => {
    if (then) pending.current = then
    close()
  }
}
