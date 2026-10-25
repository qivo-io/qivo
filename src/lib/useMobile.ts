import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { type BackLayer, closeLayer, finishLayer, openLayer } from './pageHistory'

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

/** Give a phone overlay one Back step without changing its underlying URL
 * (lib/pageHistory). The layers open over a page share one marker entry, and
 * the system Back closes the top one. Its own close, and an unmount, close it
 * at once and take no history step: once no layer over the page is open,
 * their marker stays as a spare, which the next page or layer takes over, and
 * a Back from it goes on. An explicit enabled value keeps a phone layer
 * through landscape rotation.
 * A close repeated while one is deciding, or after the layer closed, is
 * dropped, so `onClose` runs once. `onClose` closes the layer or returns
 * false to stay open (a dialog busy with something that must finish, or one
 * that asks first); after a Back the layer then gets its marker again, so the
 * next Back still closes it instead of leaving the page. `onClose` gets the
 * layer's close, so a close it holds back can run it again later. */
export function useMobileBackLayer(
  open: boolean,
  onClose: (close: () => void) => unknown,
  enabled?: boolean,
) {
  const mobile = useMobile()
  const useHistory = enabled ?? mobile
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const layer = useRef<BackLayer | null>(null)
  const close = () => {
    const mine = layer.current
    if (mine) closeLayer(mine)
    else closeRef.current(close)
  }
  // a layout effect, so an unmount frees the marker before the address sync
  // of the same commit, which then takes its place
  useLayoutEffect(() => {
    if (!useHistory || !open) return
    const mine = openLayer(() => closeRef.current(close))
    layer.current = mine
    return () => {
      finishLayer(mine)
      if (layer.current === mine) layer.current = null
    }
  }, [useHistory, open])
  return close
}

/** useMobileBackLayer for a menu whose pick may move the page: `close(then)`
 * closes the menu and then runs `then` (the pick). A pick that opens a page
 * takes the menu's spare, one that opens a layer reuses it, and one that
 * closes a window steps past it. Without a layer (off the phone, or `wanted`
 * false) the same. */
export function useMenuBackLayer(open: boolean, onClose: () => void, wanted = true) {
  const close = useMobileBackLayer(open, () => onClose(), wanted ? undefined : false)
  return (then?: () => void) => {
    close()
    then?.()
  }
}
