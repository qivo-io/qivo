/* The milestones a scope's page lists from the server in two sections, as
   the Overview (views/overview/OverviewMilestones.tsx) and the phone
   Roadmap's agenda (views/MobileRoadmap.tsx) show them: Upcoming, the
   milestones of the current week and later, nearest first, 10 at first and
   10 more for each Load more, and Past, collapsed until the person opens
   it, newest first, 25 at a time with a search, each one live read
   (views/useMilestoneSection.ts) of convex/milestones.ts section on a kept
   page's two fixed slots. A project or sub-project reads its top-level
   project's milestones, My view reads `mine`, which the server resolves to
   the projects that hold the person's own work, and All projects reads
   none (coordinator, 7 November 2026). The agenda lists the Overview's
   sections, an agent decision of 7 November 2026 that confirms the
   coordinator's assumption of 28 October 2026.

   The Overview also shows the next milestone, Upcoming's first row while
   the section has not moved on, else a one-row read of the same base on a
   slot of its own while it has, so the figure never comes from a row the
   browser picked out of a longer list. */

import { useState } from 'react'
import { weekToISO } from '@/lib/dates'
import {
  OVERVIEW_MILESTONES,
  type SectionBase,
  type SectionView,
  sectionAsk,
} from '../lib/milestoneSection'
import { type MilestoneVM, P, type ScopeInfo } from '../store/planner'
import { type MilestoneSection, useMilestoneSection, useMilestoneSlot } from './useMilestoneSection'

/** What a scope's milestone sections read: its top-level project, or My
    view's projects (`mine`). */
export type ScopeMilestoneBase = { projects: readonly string[] } | { mine: true }

/** The base of `info`'s milestone sections: for a project or sub-project
    its top-level project, `info.metas[0]?.id ?? info.id`, so a sub-project
    whose parent the store does not hold names itself and the server folds
    it, as the Roadmap's flags name it (roadmap/roadmapMilestones.ts
    markerProjects); `mine` for My view, so the app never names My view's
    projects; and none for All projects, which asks to choose a project. */
export function scopeMilestoneBase(
  info: Pick<ScopeInfo, 'id' | 'wide' | 'mine' | 'metas'>,
): ScopeMilestoneBase | null {
  if (info.mine) return { mine: true }
  if (info.wide) return null
  return { projects: [info.metas[0]?.id ?? info.id] }
}

/** The next milestone as the Overview's cell shows it: on its way, given
    (kept from before and refreshing, or current), none scheduled where
    Upcoming is whole and empty, or unavailable where the read failed, was
    refused, names too many projects or stopped before a row, which the
    section below says why. */
export type NextMilestone =
  | { state: 'loading' }
  | { state: 'ok' | 'refreshing'; row: MilestoneVM }
  | { state: 'none' }
  | { state: 'unavailable' }

/** The slots of a page's milestone sections (store/planner.ts
    OVERVIEW_MILESTONE_SLOTS, AGENDA_MILESTONE_SLOTS), with the next
    milestone's where the page shows one. */
export type ScopeMilestoneSlots = {
  upcoming: readonly [string, string]
  past: readonly [string, string]
  next?: string
}

/** A scope's milestone sections, as useScopeMilestones answers them. */
export type ScopeMilestones = {
  base: ScopeMilestoneBase | null
  upcoming: MilestoneSection
  past: MilestoneSection
  pastOpen: boolean
  setPastOpen: (open: boolean) => void
  /** whether Past's disclosure shows: once Upcoming's first answer came or
      failed, unless it says the projects hold no past milestone or the
      read names too many projects or was refused, which Past would be
      too; and always while Past is open */
  showPast: boolean
  /** whether Past shows its search box: once one of its answers had more
      to load, a search was typed or it moved on, as the window's does */
  pastSearchable: boolean
  /** whether the sections stand under a note in place of the task
      sections: once Upcoming's first answer holds a row or says the
      projects hold a past milestone, or Upcoming failed, was refused,
      names too many projects or stopped before a row. Until Upcoming
      answers, and where its whole answer is empty with no past milestone,
      the note is the whole page. */
  stands: boolean
  next: NextMilestone
  /** the row Upcoming shows the next milestone on, for its emphasis */
  nextId: string | null
}

/** The next milestone from Upcoming's view while it has not moved on. */
function nextFromUpcoming(view: SectionView<MilestoneVM>): NextMilestone {
  if (view.state === 'loading') return { state: 'loading' }
  if (view.state === 'failed' || view.state === 'refused' || view.state === 'too_many')
    return { state: 'unavailable' }
  const row = view.rows[0]
  if (row) return { state: view.state === 'refreshing' ? 'refreshing' : 'ok', row }
  return view.whole ? { state: 'none' } : { state: 'unavailable' }
}

/**
 * Reads `info`'s milestone sections under `slots`, live while the page and
 * the tab show and `active` holds; otherwise each read stops and keeps its
 * answer, which shows as refreshing on return. Past reads nothing until
 * the person opens it, and collapsing it releases its reads, so opening it
 * again reads afresh. A new week moves `from` and starts both sections
 * again; an open Past stays open. The page keeps Past's disclosure while
 * it is kept, so a return shows it as the person left it, and a new mount
 * opens it collapsed.
 */
export function useScopeMilestones(
  info: Pick<ScopeInfo, 'id' | 'wide' | 'mine' | 'metas'>,
  slots: ScopeMilestoneSlots,
  active = true,
): ScopeMilestones {
  // the first day of the current week in the app's grid, on each render,
  // so a new week moves the boundary
  const from = weekToISO(P.TODAY_WEEK)
  const base = scopeMilestoneBase(info)
  const upcomingBase: SectionBase | null = base && { ...base, from, side: 'upcoming' }
  const upcoming = useMilestoneSection(slots.upcoming, upcomingBase, {
    sizes: OVERVIEW_MILESTONES.upcoming,
    active,
  })
  const [pastOpen, setPastOpen] = useState(false)
  const past = useMilestoneSection(
    slots.past,
    base && pastOpen ? { ...base, from, side: 'past' } : null,
    { sizes: OVERVIEW_MILESTONES.past, active },
  )
  const [pastSearchable, setPastSearchable] = useState(false)
  if (!pastSearchable && (past.view.next !== null || past.text !== '' || past.view.dropped))
    setPastSearchable(true)
  const view = upcoming.view
  const blocked = view.state === 'too_many' || view.state === 'refused'
  const showPast =
    base !== null && (pastOpen || (view.state !== 'loading' && view.past !== false && !blocked))
  const stands = base !== null && view.state !== 'loading' && !(view.empty && view.past === false)

  // the next milestone's one-row read, only while Upcoming moved on
  const nextAsk =
    slots.next && upcomingBase && view.dropped
      ? sectionAsk(upcomingBase, '', { n: 0, limit: 1, attempt: 0 })
      : null
  useMilestoneSlot(slots.next ?? null, nextAsk, active)
  let next: NextMilestone
  if (!view.dropped) next = nextFromUpcoming(view)
  else {
    const read = nextAsk && slots.next ? P.milestoneRead(slots.next, nextAsk) : null
    const row = read?.state === 'ok' ? read.answer.rows[0] : undefined
    next =
      !read || read.state === 'loading'
        ? { state: 'loading' }
        : read.state !== 'ok'
          ? { state: 'unavailable' }
          : row
            ? { state: read.current ? 'ok' : 'refreshing', row }
            : read.answer.next === null && read.answer.stopped === null
              ? { state: 'none' }
              : { state: 'unavailable' }
  }
  const nextId = !view.dropped && 'row' in next ? next.row.id : null
  return {
    base,
    upcoming,
    past,
    pastOpen,
    setPastOpen,
    showPast,
    pastSearchable,
    stands,
    next,
    nextId,
  }
}
