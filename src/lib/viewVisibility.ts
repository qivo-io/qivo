/* The one gate that pauses a view's live reads (lib/liveView.ts) while the
   tab or the desktop window is hidden. It follows document.visibilityState,
   not focus. A window people can see keeps updating while another one has
   focus, side by side or on another monitor, and a minimized or hidden one
   pauses (the limits plan's "Hidden tabs and minimized windows"). The
   workspace's parts, the unread count and notifications do not use it. */

import { useSyncExternalStore } from 'react'

/** Whether the page shows, and since when, in ms: the last time it became
    visible, or when the app loaded. */
export type Visibility = { visible: boolean; shownAt: number }

const readVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

let visibility: Visibility = { visible: readVisible(), shownAt: Date.now() }
const listeners = new Set<() => void>()

/* Takes in the page's visibility now, telling the listeners when it
   changed. */
function takeVisibility(tell: boolean) {
  const visible = readVisible()
  if (visible === visibility.visible) return
  visibility = { visible, shownAt: visible ? Date.now() : visibility.shownAt }
  if (tell) for (const listener of listeners) listener()
}

const onVisibilityChange = () => takeVisibility(true)

function subscribeVisibility(listener: () => void) {
  if (listeners.size === 0) document.addEventListener('visibilitychange', onVisibilityChange)
  listeners.add(listener)
  // the page may have hidden or shown while nothing listened; React reads
  // the state again once it subscribed
  takeVisibility(false)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

const currentVisibility = () => visibility

/** The page's visibility, which a view read pauses on. */
export function useViewVisibility(): Visibility {
  return useSyncExternalStore(subscribeVisibility, currentVisibility, currentVisibility)
}
