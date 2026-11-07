/* What the Roadmap reads of its milestone flags, and what it draws of them
   (views/Roadmap.tsx). The flags come from the server's range read
   (convex/milestones.ts between) for the weeks on screen, from the first
   day of the window's first week to the first day after its last week in
   the app's week grid, over the scope's top-level project, or in My view
   over the top-level projects of its tracks. The Roadmap never reads the
   workspace's milestones. The hook that registers the asks with the store
   and renders on its news is roadmap/useRoadmapMilestones.ts; this module
   is the pure part.

   - A project or sub-project names its top-level project. My view names
     the top-level projects that hold a sub-project its Roadmap's answer
     names, before the toolbar's filters prune them, so typing a filter
     never asks again, and the last answer's projects hold while the
     Roadmap's answer reloads for the same scope. All projects names none,
     as it asks to choose a project.
   - A read lives under one of two fixed slots. A new window or a new set
     of projects asks under the other slot while the shown answer stays
     live, and its flags show for the weeks both windows cover. Once the
     new answer is ok it shows and the old slot goes, so the Roadmap holds
     at most two answers and never shows an answer for another window.
   - A read that is not whole (a wait, a failure, a refusal, more projects
     than one read names, an answer that stopped at its budget) never
     draws as whole. Its state says so, and the line beside the toolbar
     says what is missing (markerLine). A shorter window narrows a range
     read, unlike the Roadmap's tasks, so a read that stopped offers it.

   The module imports nothing from store/planner.ts. From the store it
   takes only structural types, so it is tested on its own
   (roadmapMilestones.test.ts). */

import { LIMITS } from '../../../convex/lib/limits'
import { isoToWeek, weekToISO } from '../../lib/dates'
import { limitSentence } from '../../lib/fieldLimits'
import type { MilestoneAsk } from '../../store/milestoneRows'

/** The Roadmap's ask, a range of days over top-level projects. */
export type MarkerAsk = Extract<MilestoneAsk, { kind: 'between' }>

/** A milestone as a read's answer shows it, in the app's week grid
    (store/planner.ts MilestoneVM). */
export type Marker = { id: string; project: string; name: string; week: number }

/** One answer of a range read as the store holds it (store/planner.ts
    MilestoneAnswer): its rows, each one's stored name and day, and the
    stored day the read stopped at when its budget ran out first. */
export type MarkerAnswer<R extends Marker> = {
  rows: readonly R[]
  stored: ReadonlyMap<string, { name: string; week: string }>
  stopped: string | null
}

/** What one slot holds (store/planner.ts MilestoneRead). */
export type MarkerRead<R extends Marker> =
  | { state: 'loading' }
  | { state: 'too_many' }
  | { state: 'refused'; reason: string; sentence: string; kept: MarkerAnswer<R> | null }
  | { state: 'failed'; kept: MarkerAnswer<R> | null }
  | { state: 'ok'; current: boolean; answer: MarkerAnswer<R> }

/** One slot's ask: its slot, 0 or 1, its arguments and their key, and the
    attempt Retry raises. */
export type MarkerSlot = { n: 0 | 1; ask: MarkerAsk; key: string; attempt: number }

/** The Roadmap's plan of reads: the slot that shows, and the slot of a
    new window or set of projects on its way. */
export type MarkerPlan = { shown: MarkerSlot; pending: MarkerSlot | null }

/** The scope a Roadmap shows, as store/planner.ts scopeInfo gives it. */
type MarkerScope = {
  wide: boolean
  mine: boolean
  id: string
  metas: readonly { id: string }[]
}
/** A track of the scope: its project and the sub-projects it groups. */
type MarkerTrack = { proj: { id: string }; subIds: readonly string[] }

/**
 * The projects the Roadmap's read names, once each and sorted, or null for
 * none. A project or sub-project names its top-level project as the store
 * holds it, else its own id, which the server folds to its top-level
 * project. My view names the top-level projects of the scope's `tracks`
 * that hold a sub-project of `held`, the sub-projects its Roadmap's answer
 * names, before the toolbar's filters prune them; while its Roadmap's
 * answer reloads (`held` null) it names `kept`, the projects it named last
 * for the same scope, if any. All projects names none.
 */
export function markerProjects(
  scope: MarkerScope,
  tracks: readonly MarkerTrack[],
  held: ReadonlySet<string> | null,
  kept: readonly string[] | null = null,
): string[] | null {
  if (!scope.wide) return [scope.metas[0]?.id ?? scope.id]
  if (!scope.mine) return null
  if (!held) return kept && kept.length > 0 ? [...kept] : null
  const named = new Set<string>()
  for (const track of tracks) if (track.subIds.some((id) => held.has(id))) named.add(track.proj.id)
  return named.size > 0 ? [...named].sort() : null
}

/** The range read of `projects` for the weeks `w0` to `w1` of the app's
    week grid, from the first day of week `w0` to the first day after week
    `w1`, so the range is exactly the weeks on screen. */
export function markerAsk(projects: readonly string[], w0: number, w1: number): MarkerAsk {
  return {
    kind: 'between',
    projects: [...new Set(projects)].sort(),
    from: weekToISO(w0),
    to: weekToISO(w1 + 1),
  }
}

/** The key of `ask`, its projects once each and sorted. */
export const markerKey = (ask: MarkerAsk): string =>
  JSON.stringify([[...new Set(ask.projects)].sort(), ask.from, ask.to])

/**
 * The plan after the Roadmap asks `ask` on screen, or `plan` itself. No ask
 * (null) keeps the plan, whose reads then stop and keep their answers. The
 * first ask goes under slot 0. An ask equal to the shown one drops a
 * pending one; one equal to the pending one keeps it. Any other ask goes
 * under the other slot while the shown answer stays, or in place of the
 * shown one when it holds no answer to keep showing (`answered` false).
 */
export function nextPlan(
  plan: MarkerPlan | null,
  ask: MarkerAsk | null,
  answered: boolean,
): MarkerPlan | null {
  if (ask === null) return plan
  const key = markerKey(ask)
  if (plan === null) return { shown: { n: 0, ask, key, attempt: 0 }, pending: null }
  if (key === plan.shown.key) return plan.pending === null ? plan : { ...plan, pending: null }
  if (plan.pending?.key === key) return plan
  if (!answered) return { shown: { n: plan.shown.n, ask, key, attempt: 0 }, pending: null }
  const n = plan.shown.n === 0 ? 1 : 0
  return { ...plan, pending: { n, ask, key, attempt: 0 } }
}

/** The plan once the pending read answered. Its slot shows, and the one
    it replaced goes. */
export function swapPlan(plan: MarkerPlan): MarkerPlan {
  return plan.pending === null ? plan : { shown: plan.pending, pending: null }
}

/** The plan after Retry, with a new attempt for each slot `retry` names. */
export function retryPlan(plan: MarkerPlan, retry: { shown: boolean; pending: boolean }) {
  const again = (slot: MarkerSlot): MarkerSlot => ({ ...slot, attempt: slot.attempt + 1 })
  return {
    shown: retry.shown ? again(plan.shown) : plan.shown,
    pending: retry.pending && plan.pending ? again(plan.pending) : plan.pending,
  }
}

/** The answer a read shows, its current or kept answer, also beside a
    failure or refusal, or null. */
export function answerOf<R extends Marker>(read: MarkerRead<R> | null): MarkerAnswer<R> | null {
  if (!read) return null
  if (read.state === 'ok') return read.answer
  return read.state === 'failed' || read.state === 'refused' ? read.kept : null
}

/** Where the Roadmap's flags stand, as its root's data-roadmap-milestones
    names it:
    - `none`, nothing asked: All projects, or My view without tracks;
    - `loading`, no answer to show yet;
    - `refreshing`, the answer shown is kept, or a new window's or set of
      projects' read is on its way;
    - `ok`, the current answer for the window and projects on screen;
    - `partial`, an answer that stopped at its budget, whose flags show up
      to the day it stopped at;
    - `failed` and `refused`, the latest read failed or was refused, its
      kept flags shown;
    - `too_many`, more top-level projects than one read names, so nothing
      was asked and no flag shows. */
export type MarkerState =
  | 'none'
  | 'loading'
  | 'refreshing'
  | 'ok'
  | 'partial'
  | 'failed'
  | 'refused'
  | 'too_many'

/** What the Roadmap draws of its flags (markerView). */
export type MarkerView<R extends Marker> = {
  state: MarkerState
  /** whether a read is on its way, so the header band is busy */
  busy: boolean
  /** whether a new window's or set of projects' read is on its way while
      the shown answer read none of the weeks or projects on screen, so the
      line says the flags are loading. A read that shares a week and a
      project with the shown one is no such wait, whether a flag of the
      shown answer shows or none does. */
  waiting: boolean
  /** the flags to draw, in the window and of a project named now, in the
      server's order */
  rows: readonly R[]
  /** each row's stored name and day, from the answer it came from */
  stored: ReadonlyMap<string, { name: string; week: string }>
  /** the stored day a `partial` answer stopped at */
  stopped: string | null
  /** a refusal's reason and its sentence in the server's words */
  refusal: { reason: string; sentence: string } | null
  /** the reads Retry asks again, for a failure */
  retry: { shown: boolean; pending: boolean } | null
}

const NO_STORED: ReadonlyMap<string, { name: string; week: string }> = new Map()

/**
 * What the Roadmap draws for `plan`, from its shown slot's read and its
 * pending slot's (null when none is on its way), for the weeks `w0` to
 * `w1` and the projects named now (null for none). The rows are the shown
 * answer's, also one kept beside a failure or refusal, each in the window
 * and in the weeks the shown ask covers, so while a new window's read is
 * on its way the shown answer shows only for the weeks both windows cover.
 * While the shown ask names other projects than those named now, only the
 * rows of a project named now show. Otherwise every row shows, as the
 * server answers a sub-project the store holds without its parent for
 * that top-level project. The shown read's failure, refusal or limit comes
 * first, then the pending one's.
 */
export function markerView<R extends Marker>(
  plan: MarkerPlan | null,
  shown: MarkerRead<R> | null,
  pending: MarkerRead<R> | null,
  w0: number,
  w1: number,
  projects: readonly string[] | null,
): MarkerView<R> {
  const empty: MarkerView<R> = {
    state: 'none',
    busy: false,
    waiting: false,
    rows: [],
    stored: NO_STORED,
    stopped: null,
    refusal: null,
    retry: null,
  }
  if (plan === null || shown === null || projects === null) return empty
  if (shown.state === 'too_many' || pending?.state === 'too_many')
    return { ...empty, state: 'too_many' }
  const answer = answerOf(shown)
  const named = new Set(projects)
  // whether the shown ask names the projects named now
  const sameProjects = markerKey({ ...plan.shown.ask, projects: [...projects] }) === plan.shown.key
  // the weeks the shown answer read, in the app's week grid now
  const from = Math.max(w0, isoToWeek(plan.shown.ask.from))
  const to = Math.min(w1, isoToWeek(plan.shown.ask.to) - 1)
  const rows = (answer?.rows ?? []).filter(
    (row) => row.week >= from && row.week <= to && (sameProjects || named.has(row.project)),
  )
  const base = {
    ...empty,
    rows,
    stored: answer?.stored ?? NO_STORED,
    stopped: answer?.stopped ?? null,
  }
  const failing = (read: MarkerRead<R> | null, isShown: boolean): MarkerView<R> | null => {
    if (read?.state === 'failed')
      return {
        ...base,
        state: 'failed',
        retry: { shown: isShown, pending: !isShown || pending?.state === 'failed' },
      }
    if (read?.state === 'refused')
      return {
        ...base,
        state: 'refused',
        refusal: { reason: read.reason, sentence: read.sentence },
      }
    return null
  }
  const note = failing(shown, true) ?? failing(pending, false)
  if (note) return note
  if (shown.state !== 'ok') return { ...base, state: 'loading', busy: true }
  const busy = !shown.current || pending !== null
  // the shown answer read none of the weeks on screen, or none of the
  // projects named now, so it holds no answer for what the screen shows
  const waiting =
    pending !== null &&
    (from > to || (!sameProjects && !plan.shown.ask.projects.some((p) => named.has(p))))
  if (shown.answer.stopped !== null) return { ...base, state: 'partial', busy, waiting }
  return { ...base, state: busy ? 'refreshing' : 'ok', busy, waiting }
}

/** What the line beside the Roadmap's toolbar says for `view`, in My view
    (`mine`) or a project, with `day` formatting a stored day, or null when
    the flags are whole or on their way beside an answer that read what is
    on screen. A wait with no answer to show says so at once, as the
    dependency line does, also while a new window's or set of projects'
    read is on its way and the shown answer read none of the weeks or
    projects on screen (`waiting`), as after a window change that shares no
    week with the one before. A pan that shares weeks says nothing, so the
    line does not come and go on each step. */
export function markerLine(
  view: Pick<MarkerView<Marker>, 'state' | 'waiting' | 'stopped' | 'refusal'>,
  mine: boolean,
  day: (iso: string) => string,
): string | null {
  const openOne = 'Open a project to see its milestones.'
  // markerView says a read waits only beside a refreshing or partial
  // answer that read none of the weeks or projects on screen
  if (view.waiting) return 'Loading milestones…'
  switch (view.state) {
    case 'loading':
      return 'Loading milestones…'
    case 'failed':
      return "Couldn't load milestones."
    case 'refused':
      if (!view.refusal) return null
      // a project's read names one project, so only My view's read too
      // large for one request offers opening one
      return mine && view.refusal.reason === 'milestone_read_too_large'
        ? `${view.refusal.sentence} ${openOne}`
        : view.refusal.sentence
    case 'too_many':
      return `${limitSentence(LIMITS.milestoneProjects)} ${openOne}`
    case 'partial':
      return view.stopped === null
        ? null
        : `Milestones from ${day(view.stopped)} on may be missing. Choose a shorter window${mine ? ' or open a project' : ''}.`
    default:
      return null
  }
}
