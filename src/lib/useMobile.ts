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

/** Give a phone overlay one Back step without changing its underlying URL.
 * Completion may unmount it directly; only its own history marker is cleared.
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
    queueMicrotask(() => {
      if (disposed) return
      previous = history.state
      history.pushState({ ...history.state, qivoLayer: id }, '', location.href)
      active.current = true
      registered = true
      window.addEventListener('popstate', pop)
    })
    return () => {
      disposed = true
      window.removeEventListener('popstate', pop)
      active.current = false
      leaving.current = false
      if (registered && history.state?.qivoLayer === id)
        history.replaceState(previous, '', location.href)
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
