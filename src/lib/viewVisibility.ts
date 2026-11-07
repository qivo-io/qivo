/* The one gate that pauses a view's live reads (lib/liveView.ts, and the
   reads the store owns: the Board's, views/board/useBoardView.ts, the
   Overview's, views/Overview.tsx, the Roadmap's,
   views/roadmap/useRoadmapView.ts, the milestone reads, P.watchMilestones,
   of the Milestones window, panels/Modals.tsx useMilestoneGet for the
   milestone it opened on and a kept editor's, and its Upcoming and Past
   sections, views/useMilestoneSection.ts, of Team sync's opening,
   views/teamSync/TeamOpening.tsx useSyncMilestoneReads, and of the
   Roadmap's flags, views/roadmap/useRoadmapMilestones.ts, and Team sync's
   agenda and last comments, views/teamSync/useSyncMeeting.ts and
   views/TeamSync.tsx) while the tab or the desktop window is hidden. It
   follows document.visibilityState, not focus. A window people can see
   keeps updating while another one has focus, side by side or on another
   monitor, and a minimized or hidden one pauses (the limits plan's "Hidden
   tabs and minimized windows"). The workspace's parts, the unread count and
   notifications do not use it.
   Views read it through useViewVisibility; the store's owner-load cache
   (store/ownerLoadCache.ts) through watchVisibility. */

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

/** The gate outside React: calls `listener` with the visibility now, and
    again each time the page hides or shows. Answers the way to stop. */
export function watchVisibility(listener: (visibility: Visibility) => void): () => void {
  const tell = () => listener(visibility)
  // outside a browser, such as the store's node tests, the page always shows
  const stop = typeof document === 'undefined' ? () => {} : subscribeVisibility(tell)
  tell()
  return stop
}
