/* How a view whose read the store owns renders its answers: the Board
   (views/board/useBoardView.ts), the Overview (views/Overview.tsx), the
   Roadmap (views/roadmap/useRoadmapView.ts), the Milestones window's reads
   of a milestone (panels/Modals.tsx useMilestoneGet) and of its sections
   (views/useMilestoneSection.ts), and Team sync's opening and agenda
   (views/teamSync/TeamOpening.tsx useSyncMilestoneReads,
   views/teamSync/useSyncMeeting.ts). */

import { useEffect, useState } from 'react'
import { P } from '../store/planner'

/** Renders again on each change the store's `views` section publishes on
    its own, such as a view's answer, in a task of React's after the one
    that brought it, as a view's own read rendered before the store held
    it. A store hook (useSyncExternalStore) would render the whole view
    inside the transport's task, after the store took the answer, as one
    long task. A workspace publish changes `views` too and renders a view
    that shows through App's own subscription, so this asks nothing more
    for it, and a kept page that hides (components/KeptView.tsx) does not
    render for the workspace's deliveries. */
export function useViewsNews() {
  const { views, workspace } = P.updates
  const [, setSeen] = useState(views.getSnapshot)
  useEffect(() => {
    const take = () => {
      const now = views.getSnapshot()
      if (now !== workspace.getSnapshot()) setSeen(now)
    }
    // what the store published between the render and this effect
    take()
    return views.subscribe(take)
  }, [views, workspace])
}
