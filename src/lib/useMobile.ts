import { useEffect, useId, useRef, useState } from 'react'

/** Keep phone navigation and its full-page layers on the same breakpoint. */
export function useMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const change = () => setMobile(media.matches)
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  return mobile
}

/** Give a phone overlay one Back step without changing its underlying URL.
 * Completion may unmount it directly; only its own history marker is cleared.
 * An explicit enabled value keeps a phone layer through landscape rotation.
 * A close repeated before its Back step lands is dropped, never a second Back. */
export function useMobileBackLayer(open: boolean, onClose: () => void, enabled?: boolean) {
  const mobile = useMobile()
  const useHistory = enabled ?? mobile
  const id = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const active = useRef(false)
  const leaving = useRef(false)
  useEffect(() => {
    if (!useHistory || !open) return
    let disposed = false
    let registered = false
    let previous: unknown
    const pop = () => {
      if (history.state?.qivoLayer !== id) {
        active.current = false
        leaving.current = false
        closeRef.current()
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
  return () => {
    if (active.current && history.state?.qivoLayer === id) {
      if (leaving.current) return
      leaving.current = true
      history.back()
    } else closeRef.current()
  }
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
