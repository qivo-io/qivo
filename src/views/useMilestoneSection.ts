/* The hook that reads one section of milestones from the server for a view:
   the Milestones window's Upcoming and Past (panels/Modals.tsx), and the
   Overview's and the phone Roadmap agenda's (views/useScopeMilestones.ts).
   Its plan of asks and
   what it shows are lib/milestoneSection.ts; this registers each ask with
   the store (P.watchMilestones) from an effect, as the store's other
   milestone readers do, and renders on the store's `views` news.

   It has two modes. The window, which is not a kept page, numbers its
   slots `<prefix>:<n>` across every section and mount and releases every
   slot when it unmounts. A kept page (components/KeptView.tsx) runs its
   effects' cleanups each time it hides, so there the section takes two
   fixed slots it alternates, as the Roadmap's flags do
   (views/roadmap/useRoadmapMilestones.ts): the cleanup only stops the
   reads and keeps their answers, which show again as refreshing on return,
   and the page's release function frees both once App no longer keeps the
   page (P.releaseOverview, P.releaseRoadmap). The fixed slots bound what a
   scope switch leaves behind, as the next mount takes them over. */

import { useEffect, useRef, useState } from 'react'
import { LIMITS } from '../../convex/lib/limits'
import {
  answerOf,
  fromStartPlan,
  MILESTONE_SECTION,
  morePlan,
  retryPlan,
  type SectionAsk,
  type SectionBase,
  type SectionPlan,
  type SectionSizes,
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

/* The number of the next slot a numbered section asks under, across every
   section and mount, so no two asks of a page share a slot. */
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

/** How a section reads beside its base: its sizes, read when it plans
    (MILESTONE_SECTION unless given), and whether its asks are live
    (`active`, true unless given), so a view can stop them and keep their
    answers while another part of its page shows. */
export type SectionOptions = { sizes?: SectionSizes; active?: boolean }

/** A section's slots: a prefix it numbers its slots under, or a kept
    page's pair of fixed slots it alternates. */
export type SectionSlots = string | readonly [string, string]

/** A slot's ask and attempt, as JSON, for its effect. */
type Wanted = { ask: SectionAsk; attempt: number }

/** Registers fixed slot `slot` with `wanted`, its ask and attempt as JSON,
    live while `live` holds and stopped otherwise, or releases it when the
    plan holds no ask there (null): one the plan dropped, or one an earlier
    mount left, whatever its owner. Its cleanup only stops the read, which
    a kept page that hides runs too. Nothing while `slot` is null (a
    numbered section). */
function useFixedSlot(slot: string | null, wanted: string | null, live: boolean, owner: number) {
  useEffect(() => {
    if (slot === null) return
    if (wanted === null) {
      P.releaseMilestones(slot)
      return
    }
    const { ask, attempt } = JSON.parse(wanted) as Wanted
    P.watchMilestones(slot, live ? ask : null, owner, attempt)
    return () => P.watchMilestones(slot, null, owner, attempt)
  }, [slot, wanted, live, owner])
}

/** Reads fixed slot `slot` with `ask`, live while the tab or desktop window
    shows and `active` holds, else stopped with its answer kept, and
    releases the slot while `ask` is null, as a kept page's section does
    with each of its slots: the Overview's one-row read of the next
    milestone. A new `attempt` asks again (Retry, P.watchMilestones).
    Nothing while `slot` is null. */
export function useMilestoneSlot(
  slot: string | null,
  ask: SectionAsk | null,
  active: boolean,
  attempt = 0,
) {
  const { visible } = useViewVisibility()
  const [owner] = useState(() => ++owners)
  const wanted = ask ? JSON.stringify({ ask, attempt } satisfies Wanted) : null
  useFixedSlot(slot, wanted, visible && active, owner)
}

/**
 * Reads the section of milestones `base` names, or nothing while `base` is
 * null (no project held, Past collapsed, All projects), under `slots`
 * (SectionSlots), with the sizes and liveness of `options`. Each ask is a
 * live read of the store while the tab or desktop window shows and the
 * section is active; otherwise every ask stops and keeps its answer, which
 * shows as refreshing on return. A Load more keeps the shown read live
 * under its slot and asks the larger one under another; once that one
 * answers, it shows and the old slot goes. If it fails, the old one stays
 * with a note and Retry, and if it is refused, with the server's sentence
 * and no Retry. A new search, week or base starts the first batch again
 * under another slot and releases the shown one at once, so no rows of
 * another search show. A base of null releases every slot and forgets the
 * search, so a collapsed Past reads afresh when it opens again. A numbered
 * section's slots go when the view unmounts; a kept page's only stop.
 */
export function useMilestoneSection(
  slotsOf: SectionSlots,
  base: SectionBase | null,
  options: SectionOptions = {},
): MilestoneSection {
  const { visible } = useViewVisibility()
  useViewsNews()
  const sizes = options.sizes ?? MILESTONE_SECTION
  const live = visible && (options.active ?? true)
  const fixed = typeof slotsOf === 'string' ? null : slotsOf
  const prefix = typeof slotsOf === 'string' ? slotsOf : ''
  /* The store's slot of plan slot `n`. */
  const slotName = (n: number) => (fixed ? fixed[n] : sectionSlot(prefix, n))
  const [owner] = useState(() => ++owners)
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const key = sectionKey(base)
  const [plan, setPlan] = useState<SectionPlan | null>(null)
  /* The number of a new ask over `from`'s plan: the fixed slot that does
     not show, else the next number. */
  const fresh = (from: SectionPlan | null) =>
    fixed ? (from && from.shown.n === 0 ? 1 : 0) : nextSlot()
  // a base turned null forgets the search with the reads
  if (key === null && text !== '') setText('')
  let next: SectionPlan | null = plan
  if (key === null) next = null
  else if (next === null || next.base !== key || next.search !== search.settled)
    next = startPlan(
      key,
      search.settled,
      fresh(next),
      sizes,
      next?.base === key ? next.past : undefined,
    )
  const askOf = (slot: SectionPlan['shown']) =>
    base && next ? sectionAsk(base, next.search, slot) : null
  let shownRead = next
    ? P.milestoneRead(slotName(next.shown.n), askOf(next.shown) ?? undefined)
    : null
  const pendingRead = next?.pending
    ? P.milestoneRead(slotName(next.pending.n), askOf(next.pending) ?? undefined)
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

  // the asks on screen, which the effects register: the shown slot's and a
  // Load more's on its way
  const wants =
    next && base
      ? [next.shown, ...(next.pending ? [next.pending] : [])].map((slot) => ({
          n: slot.n,
          slot: slotName(slot.n),
          ask: sectionAsk(base, next.search, slot),
          attempt: slot.attempt,
        }))
      : []
  // a numbered section's asks, registered together and released on unmount
  const wanted = fixed ? '' : JSON.stringify(wants)
  const registered = useRef(new Set<string>())
  useEffect(() => {
    if (fixed) return
    const asks = JSON.parse(wanted) as typeof wants
    const keep = new Set(asks.map((w) => w.slot))
    for (const slot of registered.current) if (!keep.has(slot)) P.releaseMilestones(slot, owner)
    for (const w of asks) P.watchMilestones(w.slot, live ? w.ask : null, owner, w.attempt)
    registered.current = keep
  }, [fixed, wanted, live, owner])
  useEffect(
    () => () => {
      for (const slot of registered.current) P.releaseMilestones(slot, owner)
      registered.current = new Set()
    },
    [owner],
  )
  // a kept page's two fixed slots, each with an effect of its own, so a
  // Load more's ask leaves the shown read's effect alone
  const fixedWant = (n: 0 | 1) => {
    const w = fixed ? wants.find((want) => want.n === n) : undefined
    return w ? JSON.stringify({ ask: w.ask, attempt: w.attempt } satisfies Wanted) : null
  }
  useFixedSlot(fixed?.[0] ?? null, fixedWant(0), live, owner)
  useFixedSlot(fixed?.[1] ?? null, fixedWant(1), live, owner)

  // the shown slot and its ask now, for storedOf when asked
  const shownNow = useRef({ slot: '', ask: wants[0]?.ask })
  shownNow.current = { slot: wants[0]?.slot ?? '', ask: wants[0]?.ask }
  const loading: SectionView<MilestoneVM> = {
    state: 'loading',
    rows: [],
    current: false,
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
      if (next && answer) setPlan(morePlan(next, answer, fresh(next), sizes))
    },
    fromStart: () => {
      if (next) setPlan(fromStartPlan(next, fresh(next), sizes))
    },
    retry: () => {
      if (next && view?.retry) setPlan(retryPlan(next, view.retry.shown, view.retry.pending))
    },
    storedOf: (id) => {
      const { slot, ask } = shownNow.current
      if (!slot || !ask) return undefined
      return answerOf(P.milestoneRead(slot, ask))?.stored.get(id)
    },
  }
}
