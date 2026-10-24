import { useEffect, useId, useRef, useSyncExternalStore } from 'react'

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

/* The history marker of a layer that closed without its Back step, as a
   finished dialog does, until the page steps back over it. A layer that
   opens meanwhile takes its entry over instead (useMobileBackLayer). */
let retired: { id: string; previous: unknown; marked: string } | null = null
// a step back over a retired marker that has not landed yet
let stepping: Promise<void> | null = null

/** Steps back over layer `id`'s marker, pushed at address `marked` over an
    entry with state `previous`, once the layers opening in the same turn
    had their chance to take it over, so the next Back leaves the page
    instead of landing on an entry with the page's own address. An address
    changed in place meanwhile is not the entry's below, so the marker then
    becomes the page's own entry, as it did before. */
function retire(id: string, previous: unknown, marked: string) {
  retired = { id, previous, marked }
  setTimeout(() => {
    if (retired?.id !== id) return
    retired = null
    if (history.state?.qivoLayer !== id) return
    if (location.href !== marked) {
      history.replaceState(previous, '', location.href)
      return
    }
    stepping = new Promise<void>((resolve) =>
      window.addEventListener('popstate', () => resolve(), { once: true }),
    ).then(() => {
      stepping = null
    })
    history.back()
  }, 0)
}

/** Give a phone overlay one Back step without changing its underlying URL.
 * Completion may unmount it directly; the page then steps back over its
 * history marker (retire), or the next layer takes the marker's entry over.
 * An explicit enabled value keeps a phone layer through landscape rotation.
 * A close repeated before its Back step lands is dropped, never a second Back.
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
  const close = () => {
    if (active.current && history.state?.qivoLayer === id) {
      if (leaving.current) return
      leaving.current = true
      history.back()
    } else closeRef.current(close)
  }
  useEffect(() => {
    if (!useHistory || !open) return
    let disposed = false
    let registered = false
    let previous: unknown
    const pop = () => {
      if (history.state?.qivoLayer !== id) {
        active.current = false
        leaving.current = false
        if (closeRef.current(close) === false) {
          // refused: restore the marker this Back step used up
          history.pushState({ ...history.state, qivoLayer: id }, '', location.href)
          active.current = true
        }
      }
    }
    // A task's Plan action mounts Roadmap before App's URL-sync effect runs.
    // Register after that effect so the layer belongs to the destination URL
    // and its marker cannot be covered by the route's own history entry.
    let marked = ''
    const register = () => {
      if (disposed) return
      if (stepping) {
        // after the step back over a retired marker, which would undo a push
        void stepping.then(register)
        return
      }
      marked = location.href
      // the marker of a layer that just closed without its Back step
      const left = retired && history.state?.qivoLayer === retired.id ? retired : null
      if (left) retired = null
      if (left?.marked === marked) {
        previous = left.previous
        history.replaceState({ ...history.state, qivoLayer: id }, '', marked)
      } else {
        // one whose address changed in place is the page's own entry now
        if (left) history.replaceState(left.previous, '', marked)
        previous = history.state
        history.pushState({ ...history.state, qivoLayer: id }, '', marked)
      }
      active.current = true
      registered = true
      window.addEventListener('popstate', pop)
    }
    queueMicrotask(register)
    return () => {
      disposed = true
      window.removeEventListener('popstate', pop)
      const backPending = leaving.current
      active.current = false
      leaving.current = false
      // closed without its Back step, as a finished dialog does
      if (registered && history.state?.qivoLayer === id && !backPending)
        retire(id, previous, marked)
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
