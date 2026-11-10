/* The one gate that pauses a view's live reads while the tab or the desktop
   window is hidden, and the register of how the app suspends them
   (design-spec §9.2, "Hidden tabs and minimized windows"). It
   follows document.visibilityState, not focus. A window people can see
   keeps updating while another one has focus, side by side or on another
   monitor, and a minimized or hidden one pauses.

   Three paths lead onto the gate:
   - A view's own read: useLiveView, useLiveViews and useKeptLiveView
     (lib/liveView.ts) and the paged list engine (lib/pagedList.ts) read it
     through useViewVisibility. Settings pages read this way, Billing's
     details, the subscriber popover's roster and Organization › General's
     export and deletion state (lib/orgRemovalState.ts) among them.
   - A store-owned read, through watchVisibility: the owner-load cache
     (store/ownerLoadCache.ts), the project cache (store/projectCache.ts),
     the roster cache (store/profileCache.ts) and the file and picture loads
     (store/planner.ts watchFileVisibility). The view read registry follows its
     views' asks instead, and each view withdraws its read through
     useViewVisibility (the Board's, views/board/useBoardView.ts, the
     Overview's, views/Overview.tsx, the Roadmap's,
     views/roadmap/useRoadmapView.ts, the milestone reads, P.watchMilestones,
     of the Milestones window, panels/Modals.tsx useMilestoneGet for the
     milestone it opened on and a kept editor's, and its Upcoming and Past
     sections, views/useMilestoneSection.ts, of the Overview's and the phone
     agenda's sections, views/useScopeMilestones.ts, of Team sync's opening,
     views/teamSync/TeamOpening.tsx useSyncMilestoneReads, and of the
     Roadmap's flags, views/roadmap/useRoadmapMilestones.ts, and Team sync's
     agenda and last comments, views/teamSync/useSyncMeeting.ts and
     views/TeamSync.tsx).
   - The live parts' view sides, the open task window's thread, history,
     task, links, attachments, reference read and inbox item
     (store/liveParts.ts VIEW_SIDES), which the store pauses through the
     registry from one watch (store/planner.ts watchWindowVisibility). The
     read on open waits with the item, so news that arrived while hidden
     stays unread until the page shows.

   Reads that stay outside the gate, each for a reason:
   - The workspace's root part, which carries the caller's seats,
     organizations and own profiles, the shared values the active app
     needs (store/liveParts.ts).
   - The unread summary and the feed of new unread events, the summary and
     feed sides, and the desktop alert leader's beat, claims and its watch
     of notifications.settings (lib/notificationLeader.ts), since the owner's
     rule keeps the unread count and notifications running while nobody
     looks.
   - The deferred items' watches of a restore a person started
     (store/planner.ts watchDeferred), which gate the restore's writes.
   - billing.status, the read-only banner over every main page
     (components/BillingNotice.tsx), a small app-wide value like the
     theme, which must be right the moment a page shows.
   - The provider's appearance.get and the week's image while shown
     (AppearanceProvider.tsx), the theme and background the app paints;
     the weekly image's read and the custom lease pause by their own watch.
   - demo.current (DemoGate.tsx), the demo's lifecycle.

   One path per query. A query a view reads on the live transport is never
   also held through convex.onUpdate (lib/liveQueries.ts), and
   store/guard/liveRoutes.test.ts holds the app to that. src/hiddenReads.test.tsx
   holds a hidden page to this list.
   Views read the gate through useViewVisibility; the store through
   watchVisibility. */

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
