/* The milestones a scope's page lists from the server in two sections, as
   the Overview (views/overview/overviewRows.tsx MilestonesPanel) and the phone
   Roadmap's agenda (views/MobileRoadmap.tsx) show them: Upcoming, the
   milestones of the current week and later, nearest first, 10 at first and
   10 more for each Load more, and Past, collapsed until the person opens
   it, newest first, 25 at a time with a search, each one live read
   (views/useMilestoneSection.ts) of convex/milestones.ts section on a kept
   page's two fixed slots. A project or sub-project reads its top-level
   project's milestones, and My view reads `mine`, which the server
   resolves to the projects that hold the person's own work. The agenda
   lists the Overview's sections. The Overview emphasises the next
   milestone, Upcoming's first row while the section has not moved on. */

import { useState } from 'react'
import { weekToISO } from '@/lib/dates'
import { OVERVIEW_MILESTONES, type SectionBase, type SectionView } from '../lib/milestoneSection'
import { type MilestoneVM, P, type ScopeInfo } from '../store/planner'
import { type MilestoneSection, useMilestoneSection } from './useMilestoneSection'

/** What a scope's milestone sections read: its top-level project, or My
    view's projects (`mine`). */
export type ScopeMilestoneBase = { projects: readonly string[] } | { mine: true }

/** The base of `info`'s milestone sections: for a project or sub-project
    its top-level project, `info.topId ?? info.id`, so a sub-project whose
    facts the project cache does not know yet names itself and the server
    folds it, as the Roadmap's flags name it (roadmap/roadmapMilestones.ts
    markerProjects); and `mine` for My view, so the app never names My
    view's projects. */
export function scopeMilestoneBase(
  info: Pick<ScopeInfo, 'id' | 'mine' | 'topId'>,
): ScopeMilestoneBase {
  if (info.mine) return { mine: true }
  return { projects: [info.topId ?? info.id] }
}

/** The slots of a page's milestone sections (store/planner.ts
    OVERVIEW_MILESTONE_SLOTS, AGENDA_MILESTONE_SLOTS). */
export type ScopeMilestoneSlots = {
  upcoming: readonly [string, string]
  past: readonly [string, string]
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
      too; and always while Past is open. While Upcoming loads again for
      the same base, the last answer's or failure's decision holds. */
  showPast: boolean
  /** whether Past shows its search box: once one of its answers had more
      to load, a search was typed or it moved on, as the window's does */
  pastSearchable: boolean
  /** whether the sections stand under a note in place of the task
      sections: once Upcoming's first answer holds a row or says the
      projects hold a past milestone, or Upcoming failed, was refused,
      names too many projects or stopped before a row. Until Upcoming
      answers, and where its whole answer is empty with no past milestone,
      the note is the whole page. While Upcoming loads again for the same
      base, after Retry, Show from the start or a new week, the last
      answer's or failure's decision holds, so the section stays and keeps
      the focus that Retry or Show from the start leaves in it. */
  stands: boolean
  /** the row Upcoming shows the next milestone on, for its emphasis */
  nextId: string | null
}

/** The next milestone's row in Upcoming's view while it has not moved on.
    A Load more that failed or was refused leaves the answer shown, whose
    first row is still the next milestone; a failure, refusal or too-many
    of the read shown leaves none. */
function nextIdOf(view: SectionView<MilestoneVM>): string | null {
  if (view.state === 'loading' || view.dropped) return null
  const { note } = view
  if (note && (note.kind === 'too_many' || !note.more)) return null
  return view.rows[0]?.id ?? null
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
  info: Pick<ScopeInfo, 'id' | 'mine' | 'topId'>,
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
  // what Upcoming's answer or failure decides for this base, whether the
  // sections stand under a note and whether Past's disclosure shows
  const key = base && JSON.stringify(base)
  const decided =
    key !== null && view.state !== 'loading'
      ? {
          key,
          stands: !(view.empty && view.past === false),
          past: view.past !== false && view.state !== 'too_many' && view.state !== 'refused',
        }
      : null
  // the last decision (stood), kept while Upcoming loads again for the
  // same base and dropped for a new one, whose first answer decides afresh
  const [stood, setStood] = useState<typeof decided>(null)
  if (
    decided &&
    (stood?.key !== decided.key || stood.stands !== decided.stands || stood.past !== decided.past)
  )
    setStood(decided)
  const holds = decided ?? (stood?.key === key ? stood : null)
  const showPast = base !== null && (pastOpen || holds?.past === true)
  const stands = holds?.stands === true

  const nextId = nextIdOf(view)
  return {
    base,
    upcoming,
    past,
    pastOpen,
    setPastOpen,
    showPast,
    pastSearchable,
    stands,
    nextId,
  }
}
