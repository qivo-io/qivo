/* The hook that reads the Roadmap's milestone flags from the server for the
   weeks on screen (views/Roadmap.tsx). Its plan of asks and what it draws
   are roadmap/roadmapMilestones.ts; this registers each ask with the store
   (P.watchMilestones) from an effect, under the two fixed slots it
   alternates (ROADMAP_MILESTONE_SLOTS), and renders on the store's `views`
   news.

   A kept page (components/KeptView.tsx) runs its effects' cleanups each
   time it hides, so the cleanup only stops the reads and keeps their
   answers, which show again as refreshing on return, as the Roadmap's own
   reads do (useRoadmapView.ts). App releases them once the page is no
   longer kept (P.releaseRoadmap). The fixed slots bound what a scope
   switch leaves behind, as a new Roadmap takes them over. */

import { useEffect, useRef, useState } from 'react'
import { useViewVisibility } from '../../lib/viewVisibility'
import { type MilestoneVM, P, ROADMAP_MILESTONE_SLOTS } from '../../store/planner'
import { useViewsNews } from '../useViewsNews'
import {
  answerOf,
  type MarkerAsk,
  type MarkerPlan,
  type MarkerSlot,
  type MarkerView,
  markerAsk,
  markerView,
  nextPlan,
  retryPlan,
  swapPlan,
} from './roadmapMilestones'

/* How many Roadmaps mounted, each one's read owner (P.watchMilestones). */
let owners = 0

/** The Roadmap's flags, as useRoadmapMilestones answers them: what it
    draws, Retry, and each row's stored name and day as the shown answer
    holds them when asked, for a drag that sends what it showed. */
export type RoadmapMilestones = {
  view: MarkerView<MilestoneVM>
  retry: () => void
  storedOf: (id: string) => { name: string; week: string } | undefined
}

/** The store's slot of plan slot `n`. */
const slotName = (n: 0 | 1) => ROADMAP_MILESTONE_SLOTS[n]

/** Registers store slot `slot` with `wanted`, its ask and attempt as JSON,
    live while `live` holds and stopped otherwise, or releases it when the
    plan holds no ask there (null): one the plan dropped, or one an earlier
    Roadmap left. Its cleanup only stops the read, which a kept page that
    hides runs too. */
function useMarkerSlot(slot: string, wanted: string | null, live: boolean, owner: number) {
  useEffect(() => {
    if (wanted === null) {
      P.releaseMilestones(slot)
      return
    }
    const { ask, attempt } = JSON.parse(wanted) as { ask: MarkerAsk; attempt: number }
    P.watchMilestones(slot, live ? ask : null, owner, attempt)
    return () => P.watchMilestones(slot, null, owner, attempt)
  }, [slot, wanted, live, owner])
}

/**
 * Reads the milestones of `projects` (roadmapMilestones.ts markerProjects)
 * for the weeks `w0` to `w1`. Each ask is a live read of the store while the
 * tab or desktop window shows and `active` holds; otherwise, or while
 * `projects` is null, every ask stops and keeps its answer, never released.
 * A new window or set of projects asks under the other slot while the shown
 * read stays live; once its answer is ok it shows and the old slot goes.
 */
export function useRoadmapMilestones(
  projects: readonly string[] | null,
  w0: number,
  w1: number,
  active: boolean,
): RoadmapMilestones {
  const { visible } = useViewVisibility()
  useViewsNews()
  const [owner] = useState(() => ++owners)
  const [plan, setPlan] = useState<MarkerPlan | null>(null)
  // the ask on screen, again each render, so a new week or grid asks anew
  const ask = projects ? markerAsk(projects, w0, w1) : null
  const readOf = (slot: MarkerSlot) => P.milestoneRead(slotName(slot.n), slot.ask)
  let next = nextPlan(plan, ask, !!answerOf(plan ? readOf(plan.shown) : null))
  let shownRead = next ? readOf(next.shown) : null
  const pendingRead = next?.pending ? readOf(next.pending) : null
  // the new window's read answered, so it shows from now on
  if (next && pendingRead?.state === 'ok') {
    next = swapPlan(next)
    shownRead = pendingRead
  }
  if (next !== plan) setPlan(next)
  const view = markerView(next, shownRead, next?.pending ? pendingRead : null, w0, w1, projects)

  // each slot's ask in the plan, which its effect registers, live or
  // stopped, so a new window's ask leaves the shown read's effect alone
  const wantOf = (n: 0 | 1) => {
    const slot = next && [next.shown, next.pending].find((s) => s?.n === n)
    return slot ? JSON.stringify({ ask: slot.ask, attempt: slot.attempt }) : null
  }
  const live = visible && active && ask !== null
  useMarkerSlot(slotName(0), wantOf(0), live, owner)
  useMarkerSlot(slotName(1), wantOf(1), live, owner)

  // the shown slot and its ask now, for storedOf when asked
  const shownNow = useRef<{ slot: string; ask: MarkerAsk } | null>(null)
  shownNow.current = next ? { slot: slotName(next.shown.n), ask: next.shown.ask } : null
  return {
    view,
    retry: () => {
      if (next && view.retry) setPlan(retryPlan(next, view.retry))
    },
    storedOf: (id) => {
      const now = shownNow.current
      if (!now) return undefined
      return answerOf(P.milestoneRead(now.slot, now.ask))?.stored.get(id)
    },
  }
}
