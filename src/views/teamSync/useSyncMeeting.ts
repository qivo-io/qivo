/* What Team sync shows (views/TeamSync.tsx): the meeting the server's agenda
   answers for the place on screen (convex/teamSync.ts agenda), as
   views/board/useBoardView.ts gives the Board its tasks. The page never
   reads the workspace's task lists, so it opens without every task and
   asks for none.

   - The store owns the read (P.watchSync). The page registers its
     arguments from an effect, or none while it or the tab is hidden
     (lib/viewVisibility.ts), so a kept page stops its read and reads afresh
     when it shows again.
   - The answer decides which tasks the page can show: its rows, its asks
     and its Done tasks, each once, as the workspace's model where the
     workspace holds the task, else as the model the store shaped from the
     answer's row (P.syncTask). Either is painted with the person's pending
     writes, so the page's rules (lib/teamSync.ts) move a task between its
     sections at once, while nothing the answer does not name appears. A
     task whose project the projects part no longer shows (P.canSee) drops
     at once, which only narrows. A task the answer names with no model yet
     keeps the page loading, the meeting shown without its counts, and
     STALL.ms later a note above it says some tasks have not arrived, so a
     meeting with tasks left out never shows as whole.
   - The walk's people, their stamps and weeks, each row's blockers and
     verdict are the answer's, never the workspace's. A person's week is
     the answer's with the person's own pending edits re-counted by task
     (P.syncLoadChanges), rounded once, so nothing counts twice. An
     organization Viewer's agenda reads no load, so the people on screen
     are read through the owner-load cache (useSyncFigures).
   - An answer counts only for its arguments. While the answer for the
     arguments on screen is on its way, the page shows the answer the read
     kept for them, or the same meeting's answer of another day or week
     grid, marked refreshing; a meeting whose live answer stops fitting
     (over_ceiling, over_budget) or whose read fails keeps its last ok
     answer under the refusal's note, marked stale, so cards keep their
     unsent text, also while Try again asks afresh, when the page is busy
     until the answer arrives; unavailable shows the picker. */

import { useEffect, useState } from 'react'
import { roundTenths } from '../../../convex/lib/numbers'
import { syncSince } from '../../../convex/lib/teamSync'
import type { AgendaAnswer, AgendaRow } from '../../../convex/lib/teamSyncAgenda'
import type { ViewRow } from '../../../convex/lib/viewReads'
import { isoToWeek } from '../../lib/dates'
import {
  type LoadFigure,
  loadFigure,
  type SyncLoad,
  type SyncPerson,
  type SyncVerdict,
  syncClockOf,
  syncMeetingOf,
  syncRows,
  syncWalk,
} from '../../lib/teamSync'
import { useViewVisibility } from '../../lib/viewVisibility'
import { plannableHoursOf } from '../../lib/workload'
import { type IssueVM, P } from '../../store/planner'
import { useStall } from '../board/useBoardView'
import { useViewsNews } from '../useViewsNews'
import { syncRequest } from './syncArgs'

/** Where the page stands, as its root's data-sync-state names it. */
export type SyncState =
  /** no scope to ask for: nothing chosen, or an address the app cannot resolve */
  | 'choose'
  /** the first answer for this meeting is on its way, or a task it names
      has no model to show yet: the meeting shows without its counts */
  | 'loading'
  /** the meeting the read kept, or the same meeting's answer of another
      day, while the answer for these arguments is on its way */
  | 'refreshing'
  | 'ok'
  /** a meeting that stopped fitting or failed to read, shown as it last
      fitted under the note (`note`) */
  | 'stale'
  /** a task the answer names still had no model to show STALL.ms later:
      the meeting shows without its counts under a note that says so */
  | 'incomplete'
  | 'over_ceiling'
  | 'over_budget'
  /** the server cannot honour the scope: the page asks to choose */
  | 'unavailable'
  | 'error'

/** The words of a task control a stale meeting turns off, by what stopped
    it (SyncMeeting note): past its limits it asks for a smaller scope, and
    after a failed read it points to the note's Try again, as that note
    does (views/teamSync/SyncNote.tsx StaleNote). */
export function stoppedTitle(note: SyncMeeting['note']): string {
  return note === 'error'
    ? 'This meeting stopped updating. Try again from the note above.'
    : 'This meeting stopped updating. Choose a smaller team or project.'
}

/** An ok agenda. */
export type SyncAgenda = Extract<AgendaAnswer, { state: 'ok' }>

/** What the page shows for its place. */
export type SyncMeeting = {
  state: SyncState
  /** why the page asks to choose, for `choose`: nothing named or an
      address's project the app cannot resolve */
  why: 'none' | 'unresolved' | null
  /** the note above a stale meeting: the refusal or the failure */
  note: 'over_ceiling' | 'over_budget' | 'error' | null
  /** the sentence an unavailable answer carries (access_unchecked) */
  message: string | null
  /** whether the page waits for an answer (its root's aria-busy) */
  busy: boolean
  /** whether a meeting shows, as ok, refreshing or stale, and as loading
      or incomplete while a task the answer names has no model yet */
  shows: boolean
  /** whether the meeting's counts may show, as every task the answer
      names has a model, so the opening's figures and the footer's total
      are whole */
  counted: boolean
  /** when a stale meeting stopped being the server's current answer (ms),
      the earliest of its read stopping, its connection going and the
      refusal or failure arriving (P.syncRead fitted.until) */
  stoppedAt: number | null
  /** Asks the server afresh (Try again), keeping the meeting on screen,
      busy, until the answer arrives (P.watchSync). */
  retry: () => void
  /** the answer whose meeting shows, or null */
  answer: SyncAgenda | null
  /** the scope's sub-projects and top-level projects (answer.sub_projects,
      answer.top_projects) */
  subIds: Set<string>
  metaIds: Set<string>
  /** every task of the answer's rows, asks and Done tasks, once, as the
      page shows it */
  tasks: IssueVM[]
  /** the walk's rows among them (lib/teamSync.ts syncRows) */
  rows: IssueVM[]
  humans: SyncPerson[]
  agents: SyncPerson[]
  /** whether the answer reads no load for the person, an organization
      Viewer (`hidden` own_only) */
  viewer: boolean
  /** the keys of a row's open blockers the answer names, the same array
      while they stay the same, less those the page shows Done */
  blockedBy: (uuid: string) => readonly string[]
  /** a row's verdict as the answer gives it */
  verdict: (uuid: string) => SyncVerdict
  /** a person's week as the answer gives it, with the person's own pending
      edits counted once */
  load: (person: Pick<SyncPerson, 'id' | 'week' | 'plannableHours' | 'isAgent'>) => SyncLoad
  /** a person's reading point (ms) from the answer's stamp */
  since: (person: Pick<SyncPerson, 'stamp'>) => number
}

const NO_KEYS: readonly string[] = []
const NO_TASKS: IssueVM[] = []
const NO_PEOPLE: SyncPerson[] = []

/* What one shown answer gives the page, built once per answer. */
type Shown = {
  subIds: Set<string>
  metaIds: Set<string>
  humans: SyncPerson[]
  agents: SyncPerson[]
  rowById: Map<string, AgendaRow>
  /** the answer's rows, asks and Done tasks as it sent them, by uuid */
  saved: Map<string, ViewRow>
  /** the week index the answer's clock names */
  week: number
}
const shownOf = new WeakMap<SyncAgenda, Shown>()

/** What answer `answer`, for the arguments `key`, gives the page. */
function shown(answer: SyncAgenda, key: string): Shown {
  const known = shownOf.get(answer)
  if (known) return known
  const people: SyncPerson[] = answer.people.map((p) => ({
    id: p.id,
    name: p.name,
    isAgent: p.kind === 'agent',
    active: p.active,
    plannableHours: p.plannable_hours,
    stamp: p.stamp,
    week: p.week,
  }))
  const saved = new Map<string, ViewRow>()
  for (const row of [...answer.rows, ...answer.asks, ...answer.done]) saved.set(row.id, row)
  const clock = syncClockOf(key)
  const out: Shown = {
    subIds: new Set(answer.sub_projects),
    metaIds: new Set(answer.top_projects),
    ...syncWalk(people),
    rowById: new Map(answer.rows.map((row) => [row.id, row])),
    saved,
    week: clock ? isoToWeek(clock.week) : P.TODAY_WEEK,
  }
  shownOf.set(answer, out)
  return out
}

/* A row's blockers less those the page shows Done, kept while they stay the
   same, so a card's memo holds. */
const openBlockers = new WeakMap<readonly string[], { done: string; keys: readonly string[] }>()

/** A person's plannable hours as the strip divides by. */
const capacityOf = (p: Pick<SyncPerson, 'plannableHours' | 'isAgent'>) =>
  plannableHoursOf({ plannableHours: p.plannableHours, isAgent: p.isAgent })

/** The figure of `hours` this week for person `p`. */
export const figureOf = (
  p: Pick<SyncPerson, 'plannableHours' | 'isAgent'>,
  hours: number,
): LoadFigure => loadFigure(hours, capacityOf(p))

/* How many mounted pages read the agenda, each one's read owner. */
let syncReaders = 0

/** The read Team sync registers with the store for the arguments `key`,
    while the page and the tab show, with Try again. Renders again on the
    store's `views` news. */
function useSyncRead(key: string | null) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  const [owner] = useState(() => ++syncReaders)
  useViewsNews()
  const ask = visible ? key : null
  useEffect(() => {
    P.watchSync(ask, owner, attempt)
    return () => P.watchSync(null, owner, attempt)
  }, [ask, owner, attempt])
  return { read: P.syncRead(), retry: () => setAttempt((n) => n + 1) }
}

/** What Team sync shows for the scope key `scopeKey` at `now` (ms). */
export function useSyncMeeting(scopeKey: string, now: number): SyncMeeting {
  const request = syncRequest(scopeKey)
  const key = request.kind === 'ask' ? request.key : null
  const { read, retry } = useSyncRead(key)
  const meeting = key === null ? null : syncMeetingOf(key)
  // the read's result for these arguments, or for the same meeting on
  // another day or week grid (watchView hold), else none
  const same = key !== null && read.key === key
  const sameMeeting = same || (read.key !== null && syncMeetingOf(read.key) === meeting)
  const current = same && read.current
  const value = sameMeeting ? (read.value ?? null) : null
  const failed = sameMeeting && read.error !== undefined
  const fitted =
    read.fitted && meeting !== null && syncMeetingOf(read.fitted.key) === meeting
      ? read.fitted
      : null
  const refused =
    failed || value?.state === 'over_ceiling' || value?.state === 'over_budget'
      ? failed
        ? ('error' as const)
        : (value?.state as 'over_ceiling' | 'over_budget')
      : null
  // the ok answer whose meeting shows: the result's own, else the last that
  // fitted under a refusal or failure
  const okAnswer = value?.state === 'ok' ? value : refused && fitted ? fitted.value : null
  const okKey = value?.state === 'ok' ? (read.key ?? '') : (fitted?.key ?? '')
  const stale = !!refused && !!fitted

  const facts = okAnswer ? shown(okAnswer, okKey) : null
  // each task the answer names, once, as the page shows it
  let tasks = NO_TASKS
  let missing = 0
  if (okAnswer) {
    tasks = []
    const own = P.ownPaintedTasks()
    for (const uuid of facts?.saved.keys() ?? []) {
      const it = P.syncTask(uuid)
      if (!it) {
        if (!own.has(uuid)) missing++
        continue
      }
      // the projects part follows access live: a task whose project the
      // person no longer sees goes at once
      if (P.canSee(it.project)) tasks.push(it)
    }
  }
  const stalled = useStall(!!okAnswer && missing > 0, key ?? '')
  const rows = facts ? syncRows(tasks, facts.subIds) : NO_TASKS
  // the person's own pending edits, by owner, in the shown answer's week
  const changes = okAnswer && facts ? P.syncLoadChanges(facts.saved, facts.week) : null
  // the display keys of the tasks the page shows Done that the answer does
  // not: a blocker the person moved to Done stops blocking at once
  const doneNow = tasks
    .filter((it) => it.status === 'done' && facts?.saved.get(it.uuid)?.status !== 'done')
    .map((it) => it.key)
  const doneSig = doneNow.join(',')
  const doneKeys = new Set(doneNow)

  const base = {
    why: null,
    note: null,
    message: null,
    stoppedAt: null,
    retry,
    answer: null,
    subIds: facts?.subIds ?? new Set<string>(),
    metaIds: facts?.metaIds ?? new Set<string>(),
    tasks: NO_TASKS,
    rows: NO_TASKS,
    humans: NO_PEOPLE,
    agents: NO_PEOPLE,
    viewer: false,
    blockedBy: () => NO_KEYS,
    verdict: () => null,
    load: () => ({ state: 'unknown' }) as const,
    since: (person: Pick<SyncPerson, 'stamp'>) =>
      syncSince(person.stamp, now, P.org.weekStart ?? 1),
  } satisfies Omit<SyncMeeting, 'state' | 'busy' | 'shows' | 'counted'>
  const note = (state: SyncState, extra: Partial<SyncMeeting> = {}): SyncMeeting => ({
    ...base,
    state,
    busy: !current,
    shows: false,
    counted: false,
    ...extra,
  })

  if (request.kind === 'choose') return note('choose', { why: request.why, busy: false })
  if (!sameMeeting || (!value && !failed)) return note('loading', { busy: true })
  if (!okAnswer || !facts) {
    if (failed) return note('error')
    if (value?.state === 'unavailable')
      return note('unavailable', { message: value.message ?? null })
    if (value?.state === 'over_ceiling' || value?.state === 'over_budget') return note(value.state)
    return note('loading', { busy: true })
  }
  const blockedBy = (uuid: string): readonly string[] => {
    const keys = facts.rowById.get(uuid)?.blocked_by ?? NO_KEYS
    if (!doneKeys.size || !keys.some((k) => doneKeys.has(k))) return keys
    const was = openBlockers.get(keys)
    if (was?.done === doneSig) return was.keys
    const open = keys.filter((k) => !doneKeys.has(k))
    openBlockers.set(keys, { done: doneSig, keys: open })
    return open
  }
  const meetingOf = (state: SyncState, busy: boolean): SyncMeeting => ({
    ...base,
    state,
    busy,
    shows: true,
    counted: missing === 0,
    note: stale ? refused : null,
    stoppedAt: stale ? (fitted?.until ?? now) : null,
    answer: okAnswer,
    tasks,
    rows,
    humans: facts.humans,
    agents: facts.agents,
    viewer: okAnswer.hidden === 'own_only',
    blockedBy,
    verdict: (uuid) => facts.rowById.get(uuid)?.delay ?? null,
    load: (person) =>
      person.week.state === 'ok'
        ? {
            state: 'ok',
            figure: figureOf(
              person,
              roundTenths(person.week.hours + (changes?.get(person.id) ?? 0)),
            ),
          }
        : { state: 'unknown' },
  })
  if (stale) return meetingOf('stale', !current)
  if (missing > 0) return meetingOf(stalled ? 'incomplete' : 'loading', !stalled)
  return meetingOf(current ? 'ok' : 'refreshing', !current)
}

/** The week and the verdicts the page shows for the people on screen,
    `owners` (the person of a person step and of the steps beside it, or
    the expanded agents). For staff they are the meeting's. An organization
    Viewer's agenda reads no load, so their loads come from the owner-load
    cache (P.watchSyncPeople, live while the page and the tab show), from
    the projects the Viewer can see: a person's week (P.syncPersonLoad),
    "…" while it is on its way, and their rows' verdicts the agenda left
    unknown (P.syncViewerVerdicts); everyone else's stay unknown. */
export function useSyncFigures(meeting: SyncMeeting, owners: readonly string[]) {
  const { visible } = useViewVisibility()
  const viewer = meeting.shows && meeting.viewer
  const ownerKey = viewer ? owners.join(',') : ''
  useEffect(() => {
    const list = ownerKey ? ownerKey.split(',') : []
    P.watchSyncPeople(list, visible)
    return () => P.watchSyncPeople(list, false)
  }, [ownerKey, visible])
  if (!viewer) return { verdict: meeting.verdict, load: meeting.load }
  const on = new Set(owners)
  const unknown = meeting.rows
    .filter((it) => on.has(it.owner) && meeting.verdict(it.uuid) === 'unknown')
    .map((it) => it.uuid)
  const judged = P.syncViewerVerdicts(unknown)
  return {
    // a judged null is no mark while the load is on its way, never the
    // agenda's unknown
    verdict: (uuid: string): SyncVerdict =>
      judged.has(uuid) ? (judged.get(uuid) ?? null) : meeting.verdict(uuid),
    load: (person: Pick<SyncPerson, 'id' | 'week' | 'plannableHours' | 'isAgent'>): SyncLoad => {
      if (!on.has(person.id)) return meeting.load(person)
      const load = P.syncPersonLoad(person.id)
      return load.state === 'ok'
        ? { state: 'ok', figure: figureOf(person, load.hours) }
        : { state: load.state }
    },
  }
}
