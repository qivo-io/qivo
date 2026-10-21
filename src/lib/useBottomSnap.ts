import { type RefObject, useEffect } from 'react'

/* Keep a scroller pinned to its bottom whenever `key` changes — the working
   end of a chat-ordered thread. Shared by the inbox thread and the task
   window's spine so the claim "they read the same" is true in code rather
   than by convention; two copies of this would drift.
   A null key means there is nothing to snap to (the task window stays mounted
   with no task open). */
export function useBottomSnap(ref: RefObject<HTMLElement>, key: string | null) {
  useEffect(() => {
    const el = ref.current
    if (!el || key === null) return
    el.scrollTop = el.scrollHeight
    // inline images load after the snap and grow the content below the
    // viewport — chase them (img load doesn't bubble; capture catches it)
    // for a few seconds, then leave the user's scroll alone. A reader who
    // scrolls meanwhile is left alone at once, after a wheel or touch scroll
    // or any move up, which the snap itself never makes. Otherwise the
    // avatars of earlier comments loaded above would pull them back to the end.
    let chasing = true
    let top = el.scrollTop
    // `top` is where the last scroll left the reader. Each snap sets it
    // too, since its own scroll event can run after the reader has moved.
    const onLoad = () => {
      if (!chasing) return
      el.scrollTop = el.scrollHeight
      top = el.scrollTop
    }
    const onScroll = () => {
      if (el.scrollTop < top) chasing = false
      top = el.scrollTop
    }
    const onReader = () => {
      chasing = false
    }
    el.addEventListener('load', onLoad, true)
    el.addEventListener('scroll', onScroll)
    el.addEventListener('wheel', onReader, { passive: true })
    el.addEventListener('touchstart', onReader, { passive: true })
    const stop = () => {
      el.removeEventListener('load', onLoad, true)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onReader)
      el.removeEventListener('touchstart', onReader)
    }
    const t = setTimeout(() => {
      chasing = false
      stop()
    }, 4000)
    return () => {
      clearTimeout(t)
      stop()
    }
  }, [key]) // eslint-disable-line
}
