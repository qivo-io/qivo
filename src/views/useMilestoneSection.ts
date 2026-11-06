/* The hook that reads one section of milestones from the server for a view:
   the Milestones window's Upcoming and Past (panels/Modals.tsx), and later
   the Overview's. Its plan of asks and what it shows are lib/
   milestoneSection.ts; this registers each ask with the store
   (P.watchMilestones) from an effect, as the store's other milestone
   readers do, and renders on the store's `views` news. */

import { useEffect, useRef, useState } from 'react'
import { LIMITS } from '../../convex/lib/limits'
import {
  answerOf,
  fromStartPlan,
  morePlan,
  retryPlan,
  type SectionBase,
  type SectionPlan,
  type SectionView,
  sectionAsk,
  sectionKey,
  sectionSlot,
  sectionView,
  startPlan,
  swapPlan,
} from '../lib/milestoneSection'
import { useSettledSearch } from '../lib/pagedList'
import { useViewVisibility } from '../lib/viewVisibility'
import { type MilestoneVM, P } from '../store/planner'
import { useViewsNews } from './useViewsNews'

/* The number of the next slot a section asks under, across every section
   and mount, so no two asks of a page share a slot. */
let slots = 0
const nextSlot = () => ++slots
/* How many sections mounted, each one's read owner (P.watchMilestones). */
let owners = 0

/** One section a view shows, as useMilestoneSection answers it: what it
    shows, its search box's text and the search it asks with, and its
    actions. `storedOf` answers a row's stored name and day as the answer
    on screen holds them when asked, for an editor that sends what it
    showed (MilestoneAnswer.stored). */
export type MilestoneSection = {
  view: SectionView<MilestoneVM>
  text: string
  setText: (text: string) => void
  tooLong: boolean
  settled: string
  more: () => void
  fromStart: () => void
  retry: () => void
  storedOf: (id: string) => { name: string; week: string } | undefined
}

/**
 * Reads the section of milestones `base` names, or nothing while `base` is
 * null (no project held, Past collapsed), under slots `<prefix>:<n>`. Each
 * ask is a live read of the store while the tab or desktop window shows;
 * while it hides every ask stops and keeps its answer, which shows as
 * refreshing on return. A Load more keeps the shown read live under its
 * slot and asks the larger one under the next; once that one answers, it
 * shows and the old slot goes, and if it fails or is refused the old one
 * stays with a note and Retry. A new search, week or base releases every
 * slot at once and starts the first batch again, so no rows of another
 * search show. A base of null also forgets the search. Every slot goes
 * when the view unmounts.
 */
export function useMilestoneSection(prefix: string, base: SectionBase | null): MilestoneSection {
  const { visible } = useViewVisibility()
  useViewsNews()
  const [owner] = useState(() => ++owners)
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const key = sectionKey(base)
  const [plan, setPlan] = useState<SectionPlan | null>(null)
  // a base turned null forgets the search with the reads
  if (key === null && text !== '') setText('')
  let next: SectionPlan | null = plan
  if (key === null) next = null
  else if (next === null || next.base !== key || next.search !== search.settled)
    next = startPlan(key, search.settled, nextSlot(), next?.base === key ? next.past : undefined)
  const askOf = (slot: SectionPlan['shown']) =>
    base && next ? sectionAsk(base, next.search, slot) : null
  let shownRead = next
    ? P.milestoneRead(sectionSlot(prefix, next.shown.n), askOf(next.shown) ?? undefined)
    : null
  const pendingRead = next?.pending
    ? P.milestoneRead(sectionSlot(prefix, next.pending.n), askOf(next.pending) ?? undefined)
    : null
  // the Load more's read answered: it shows from now on
  if (next && pendingRead?.state === 'ok') {
    next = swapPlan(next)
    shownRead = pendingRead
  }
  const view =
    next && shownRead ? sectionView(next, shownRead, next.pending ? pendingRead : null) : null
  if (next && view && view.past !== next.past) next = { ...next, past: view.past }
  if (next !== plan) setPlan(next)

  // the asks on screen, which the effect registers: the shown slot's and a
  // Load more's on its way
  const wants =
    next && base
      ? [next.shown, ...(next.pending ? [next.pending] : [])].map((slot) => ({
          slot: sectionSlot(prefix, slot.n),
          ask: sectionAsk(base, next.search, slot),
          attempt: slot.attempt,
        }))
      : []
  const wanted = JSON.stringify(wants)
  const registered = useRef(new Set<string>())
  useEffect(() => {
    const asks = JSON.parse(wanted) as typeof wants
    const keep = new Set(asks.map((w) => w.slot))
    for (const slot of registered.current) if (!keep.has(slot)) P.releaseMilestones(slot, owner)
    for (const w of asks) P.watchMilestones(w.slot, visible ? w.ask : null, owner, w.attempt)
    registered.current = keep
  }, [wanted, visible, owner])
  useEffect(
    () => () => {
      for (const slot of registered.current) P.releaseMilestones(slot, owner)
      registered.current = new Set()
    },
    [owner],
  )

  // the shown slot and its ask now, for storedOf when asked
  const live = useRef({ slot: '', ask: wants[0]?.ask })
  live.current = { slot: wants[0]?.slot ?? '', ask: wants[0]?.ask }
  const loading: SectionView<MilestoneVM> = {
    state: 'loading',
    rows: [],
    answered: false,
    next: null,
    stopped: null,
    past: undefined,
    whole: false,
    dropped: false,
    more: null,
    note: null,
    retry: null,
    empty: false,
    count: null,
  }
  return {
    view: view ?? loading,
    text,
    setText,
    tooLong: search.tooLong,
    settled: search.settled,
    more: () => {
      const answer = answerOf(shownRead)
      if (next && answer) setPlan(morePlan(next, answer, nextSlot()))
    },
    fromStart: () => {
      if (next) setPlan(fromStartPlan(next, nextSlot()))
    },
    retry: () => {
      if (next && view?.retry) setPlan(retryPlan(next, view.retry.shown, view.retry.pending))
    },
    storedOf: (id) => {
      const { slot, ask } = live.current
      if (!slot || !ask) return undefined
      return answerOf(P.milestoneRead(slot, ask))?.stored.get(id)
    },
  }
}
