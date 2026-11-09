/* What the Roadmap shows, for the desktop timeline, the landscape timeline
   and the phone's agenda (views/Roadmap.tsx, views/MobileRoadmap.tsx): which
   tasks, in which state, from the server's answer for the selection, the
   filter row and the window (convex/tasks.ts roadmap), and the arrows and
   Auto-move's inputs from its dependency answer (roadmapDependencies). The
   workspace holds no task, so every row comes from the answer. The
   Board's view (views/board/useBoardView.ts) is the pattern.

   - The store owns both reads (P.watchRoadmap, P.watchRoadmapDependencies).
     The Roadmap registers its arguments from an effect, or none while its
     page or the tab is hidden (lib/viewVisibility.ts), so a kept page stops
     its reads and reads afresh when it shows again. The store names the
     projects the answer names with its project cache (store/planner.ts
     ROADMAP_QUERY `projects`), so a bar's rights and a row's place read
     their project from the cache, the store's only source of projects.
   - The answer decides which tasks a Roadmap shows. Each shows as the
     model the store shaped from the answer's row (store/viewRows.ts), with
     the person's pending writes painted, so a bar follows every edit at
     once and a drag never snaps back. The answer's parents and the shown
     subtasks of its group rows come along, so a group's bar, its stale fade
     and its due mark read the group's family from the answer (`family`).
   - On top of the answer, the app checks each task again against the
     selection, the window on screen and the filter row, so an edit or a
     pan hides a bar at once. That only narrows. A task shaped from a row has
     no text or labels, so the text filter is the answer's alone. The
     planning session's task skips the filter row alone, as the server keeps
     it (`planned`). A task the person's own pending writes changed shows as
     the rows on screen say, both ways (P.ownPaintedTasks).
   - An answer counts only for the arguments it was sent with. While the
     answer for a new window or planned task is on its way, the Roadmap
     keeps the last answer for the same scope and filter row on screen,
     marked refreshing, and so it does while typing only narrows the text
     filter, narrowed by its own text check (roadmapArgs.ts keepsRoadmap).
     A page shown again keeps the rows its read kept, marked refreshing.
     Any other change shows the loading note. No state shows part of a
     selection as the selection. A row with no model to show keeps the
     Roadmap loading, and STALL.ms later says so (`incomplete`).
   - The headings' Remaining comes from the answer's counts in tenths of an
     hour, summed and divided by 10 once, and says counting or unknown,
     never zero, when the counts are not whole or did not fit. */

import { useEffect, useMemo, useState } from 'react'
import { LIMITS } from '../../../convex/lib/limits'
import type {
  AutoMoveInputs,
  DependencyAnswer,
  PlannedTask,
  RoadmapAnswer,
} from '../../../convex/lib/roadmap'
import { limitSentence } from '../../lib/fieldLimits'
import { type GroupSpan, groupSpan, isIssueGroup } from '../../lib/issueGroups'
import { isRoadmapTaskVisible } from '../../lib/roadmapVisibility'
import type { DepPair } from '../../lib/schedule'
import { matchesAllWords } from '../../lib/search'
import { useViewVisibility } from '../../lib/viewVisibility'
import {
  type IssueFilters,
  type IssueVM,
  nameUnknown,
  P,
  ROADMAP_SLOT,
  type ScopeInfo,
} from '../../store/planner'
import { type ScopeGroup, scopeGroups } from '../../store/scopeGroups'
import { before, shownText, useStall } from '../board/useBoardView'
import { useViewsNews } from '../useViewsNews'
import { keepsRoadmap, textChanged, useRoadmapRequest } from './roadmapArgs'

/** Where the Roadmap stands, as its root's data-roadmap-state names it. */
export type RoadmapState =
  /** a text filter past LIMITS.search, which the Roadmap does not send */
  | 'search_limit'
  /** no answer to show for these arguments yet, or a task the answer
      names has no model to show yet */
  | 'loading'
  /** the last answer for the same scope, shown while the answer for a new
      window, planned task or narrower text, or for a page shown again, is
      on its way */
  | 'refreshing'
  | 'ok'
  /** a task the answer names still had no model to show STALL.ms later */
  | 'incomplete'
  | 'over_ceiling'
  | 'over_budget'
  | 'unavailable'
  | 'error'

/** A heading's Remaining: hours, or why there is no figure. */
export type HeadRemaining = number | 'counting' | 'unknown'

/** What the Roadmap reads of a group's family, its subtasks at any depth
    as the answer brings them. */
export type RoadmapFamily = {
  /** every task the shown answer brings, rows, parents and subtasks, by
      handle, as the Roadmap shows them */
  byId: Readonly<Record<string, IssueVM>>
  /** Group `it`'s calculated dates over its family on screen, with
      `datesOf` overriding a leaf's (a drag's drafts), or null where a
      subtask has no model to show, so the caller keeps the group's own
      span from its row. */
  span: (
    it: IssueVM,
    datesOf?: (leaf: IssueVM) => { start: number | null; end: number | null } | undefined,
  ) => GroupSpan | null
  /** Whether task `it` is stale: not Done, and nothing in it or its family
      on screen changed for 120 days (P.isStale's rule). */
  stale: (it: IssueVM) => boolean
  /** Whether group `it` has subtasks outside the reader's view, so its
      plan cannot show it finishing in time. */
  partial: (it: IssueVM) => boolean
}

/** Where the dependency read stands, as data-roadmap-deps names it. */
export type DepsState = 'loading' | 'ok' | 'over_budget' | 'unavailable' | 'error'

/** What the Roadmap reads of its dependency answer. */
export type RoadmapDeps = {
  state: DepsState
  /** the arrows' pairs, by handle, while the answer is ok */
  pairs: DepPair[]
  /** Auto-move's inputs while they are whole, else why not */
  autoMove: { state: 'ok'; inputs: AutoMoveInputs } | { state: Exclude<DepsState, 'ok'> }
}

/** What the Roadmap shows. */
export type RoadmapView = {
  state: RoadmapState
  /** whether the Roadmap waits for an answer (its root's aria-busy) */
  busy: boolean
  /** the tasks the Roadmap shows, groups included, in the answer's order;
      empty where a note takes their place */
  tasks: IssueVM[]
  /** In My view, the sub-projects the shown answer says hold the person's
      tasks; null in a project selection or with no answer shown. */
  held: ReadonlySet<string> | null
  /** the Roadmap's tracks from the answer on screen (store/scopeGroups.ts
      scopeGroups): a project selection's sub-projects, My view's top-level
      projects with their held sub-projects folded through the project
      cache, in the answer's order, which the Roadmap sorts by name; none
      before an answer */
  groups: readonly ScopeGroup[]
  /** a project selection's sub-projects as the answer on screen names
      them, also a refusal's; null in My view and before an answer */
  selection: readonly string[] | null
  /** whether the tasks are the current answer's for the arguments on
      screen, so an empty or no-match note may show */
  current: boolean
  /** the answer when it is a state the Roadmap shows a note for */
  answer: RoadmapAnswer | null
  /** A heading's Remaining over the sub-projects `subIds`. */
  remaining: (subIds: readonly string[]) => HeadRemaining | null
  family: RoadmapFamily
  deps: RoadmapDeps
  /** Asks the server for this Roadmap afresh (Try again). */
  retry: () => void
}

/* How many Roadmaps mounted, each one's read owner (P.watchRoadmap). */
let roadmapReaders = 0

/** The Roadmap's two reads, registered with the store for `key` and
    `deps` while the page shows, with Try again. Renders again on the
    store's `views` news (views/useViewsNews.ts). */
function useRoadmapReads(key: string | null, deps: string | null) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  // this mounted Roadmap, which owns the reads while it asks
  const [owner] = useState(() => ++roadmapReaders)
  useViewsNews()
  const ask = visible ? key : null
  const askDeps = visible ? deps : null
  useEffect(() => {
    const held = P.roadmapRead()
    const keep =
      ask !== null && held.key !== null && held.value?.state === 'ok' && keepsRoadmap(held.key, ask)
    P.watchRoadmap(ask, attempt, owner, keep)
    return () => P.watchRoadmap(null, attempt, owner)
  }, [ask, attempt, owner])
  useEffect(() => {
    P.watchRoadmapDependencies(askDeps, attempt, owner)
    return () => P.watchRoadmapDependencies(null, attempt, owner)
  }, [askDeps, attempt, owner])
  return {
    read: P.roadmapRead(),
    deps: P.roadmapDependenciesRead(),
    retry: () => setAttempt((n) => n + 1),
  }
}

/* The days after which a task is stale (P.isStale). */
const STALE_MS = 120 * 86_400_000

/** The family lookups over `byId` (RoadmapFamily). */
function familyOver(byId: Readonly<Record<string, IssueVM>>): RoadmapFamily {
  /** Whether every subtask under `it`, at any depth, has a model. */
  const whole = (it: IssueVM) => {
    const seen = new Set([it.id])
    const stack = [...(it.children ?? [])]
    while (stack.length) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      const kid = byId[id]
      if (!kid) return false
      stack.push(...(kid.children ?? []))
    }
    return true
  }
  return {
    byId,
    span: (it, datesOf) => (whole(it) ? groupSpan(it, byId, datesOf) : null),
    stale: (it) => {
      if (P.isDone(it) || !it.updatedAt) return false
      let newest = it.updatedAt
      const seen = new Set([it.id])
      const stack = [...(it.children ?? [])]
      while (stack.length) {
        const id = stack.pop() as string
        if (seen.has(id)) continue
        seen.add(id)
        const kid = byId[id]
        if (!kid) continue
        newest = Math.max(newest, kid.updatedAt || 0)
        stack.push(...(kid.children ?? []))
      }
      return Date.now() - newest > STALE_MS
    },
    partial: (it) => {
      if (!isIssueGroup(it)) return false
      const span = groupSpan(it, byId)
      return !!span?.partial
    },
  }
}

/** What the Roadmap of `info` shows in the weeks `w0` to `w1` with the
    filter row `filters` as it applies them on screen (App's roadmapFilters,
    the phone's without a text filter), where `planned` names the task its
    planning session plans, which skips the filter row alone. */
export function useRoadmapView(
  info: ScopeInfo,
  filters: IssueFilters,
  w0: number,
  w1: number,
  planned: PlannedTask | null,
): RoadmapView {
  const { want, send } = useRoadmapRequest(info, filters, { w0, w1 }, planned)
  const asks = send.kind === 'ask' ? send : null
  const { read, deps: depsRead, retry } = useRoadmapReads(asks?.key ?? null, asks?.deps ?? null)
  const wantKey = want.kind === 'ask' ? want.key : null
  // what the read holds for the arguments on screen: its live result, or the
  // rows it kept while it was stopped
  const mine = wantKey !== null && read.key === wantKey
  const current = mine && read.current ? read : null
  const kept = mine && !read.current && read.value?.state === 'ok' ? read.value : null
  const answer = current?.value ?? null
  // the last answer for the same scope and filter row while the one for a
  // new window, planned task or narrower text is on its way
  const lastKey = read.key
  const carried =
    !mine &&
    wantKey !== null &&
    lastKey !== null &&
    read.value?.state === 'ok' &&
    keepsRoadmap(lastKey, wantKey)
      ? read.value
      : null
  const narrowing =
    carried !== null && lastKey !== null && wantKey !== null && textChanged(lastKey, wantKey)
  const shownAnswer = answer?.state === 'ok' ? answer : (kept ?? carried)
  const views = P.updates.views.getSnapshot()
  // a project selection's sub-projects, from the answer on screen, also a
  // refusal's, which names them; null in My view
  const selectionList = info.mine
    ? null
    : (shownAnswer?.projects ??
      (answer && answer.state !== 'ok' && 'projects' in answer ? (answer.projects ?? null) : null))
  const selection = selectionList ? new Set(selectionList) : null
  // the tracks: a selection's sub-projects, My view's held sub-projects
  // folded under their top-level projects through the project cache
  const groups = scopeGroups(
    info,
    info.mine
      ? shownAnswer?.held_sub_projects
        ? { subs: shownAnswer.held_sub_projects }
        : null
      : selectionList
        ? { projects: selectionList }
        : null,
    P.project,
  )

  // the shown answer's tasks by handle, as the Roadmap shows them
  const byId = useMemo(() => {
    const out: Record<string, IssueVM> = {}
    if (!shownAnswer) return out
    for (const row of [...shownAnswer.rows, ...shownAnswer.parents, ...shownAnswer.subtasks]) {
      const it = P.viewTask(ROADMAP_SLOT, row.id)
      if (it) out[it.id] = it
    }
    return out
    // the views' news covers every model and paint the lookup reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownAnswer, views])
  const family = useMemo(() => familyOver(byId), [byId])

  // the text filter is the answer's for every task: the server
  // matched the whole text, label and assignee names included, which the
  // store cannot read, so the store's filters take no text
  const passes = (it: IssueVM) =>
    (selection === null || selection.has(it.project)) &&
    (!info.only || info.only(it)) &&
    isRoadmapTaskVisible(it, P.isDone(it), w0, w1) &&
    (planned?.id === it.uuid || P.passesFilters(it, { ...filters, search: '' }))
  // the Roadmap's own text check of a kept answer while typing narrows it,
  // over the fields a row sends; a task whose assignee's name has not
  // loaded may match by it, so it stays until the answer for the text
  // decides
  const textOk = (it: IssueVM) =>
    !narrowing ||
    planned?.id === it.uuid ||
    matchesAllWords(shownText(it.key, it, P.isGroup(it), it.assignee), filters.search) ||
    nameUnknown(P.person(it.assignee, it.org))

  let joined: { tasks: IssueVM[]; missing: number } | null = null
  if (shownAnswer) {
    const own = P.ownPaintedTasks()
    const shown = new Set<string>()
    const tasks: IssueVM[] = []
    let missing = 0
    for (const row of shownAnswer.rows) {
      if (own.has(row.id)) continue
      const it = P.viewTask(ROADMAP_SLOT, row.id)
      if (!it) {
        missing++
        continue
      }
      if (passes(it) && textOk(it)) {
        shown.add(it.uuid)
        tasks.push(it)
      }
    }
    // the person's own pending writes decide for the tasks they changed,
    // each put in its place in the answer's order
    for (const uuid of own) {
      const it = P.ownOnScreen(ROADMAP_SLOT, uuid)
      if (!it || shown.has(uuid) || !passes(it) || !textOk(it)) continue
      // the person's new task on its way, by its whole text as the screen
      // shows it (P.createText), as the Board checks it
      const created = filters.search ? P.createText(uuid) : null
      if (created !== null && !matchesAllWords(created, filters.search)) continue
      shown.add(uuid)
      let at = tasks.length
      while (at > 0 && before(it, tasks[at - 1] as IssueVM)) at--
      tasks.splice(at, 0, it)
    }
    joined = { tasks, missing }
  }
  const stalled = useStall(joined !== null && joined.missing > 0, wantKey ?? '')

  // the headings' Remaining from the shown answer's counts
  const remaining = (subIds: readonly string[]): HeadRemaining | null => {
    if (!shownAnswer) return null
    const figure = shownAnswer.remaining
    if (figure.state !== 'ok') return figure.reason === 'counting' ? 'counting' : 'unknown'
    let tenths = 0
    for (const id of subIds) {
      const sub = figure.tenths[id]
      // My view's absent key holds none of the person's leaves; a project
      // selection names every selected sub-project, so an absent one is
      // not counted
      if (sub === undefined) {
        if (info.mine) continue
        return 'unknown'
      }
      tenths += sub
    }
    return tenths / 10
  }

  const depsView = useDeps(depsRead, wantKey !== null)
  const base = {
    held: null,
    groups,
    selection: selectionList,
    current: false,
    answer: null,
    remaining: () => null,
    family,
    deps: depsView,
    retry,
  }
  const note = (state: RoadmapState, extra: Partial<RoadmapView> = {}): RoadmapView => ({
    ...base,
    state,
    busy: false,
    tasks: [],
    ...extra,
  })
  const heldOf = (a: RoadmapAnswer & { state: 'ok' }) =>
    a.held_sub_projects ? new Set(a.held_sub_projects) : null
  if (want.kind === 'search_limit') return note('search_limit')
  if (current?.error !== undefined) return note('error')
  if (answer === null && shownAnswer && joined)
    return {
      ...base,
      state: 'refreshing',
      busy: true,
      tasks: joined.tasks,
      held: heldOf(shownAnswer),
      remaining,
    }
  if (answer === null) return note('loading', { busy: true })
  if (answer.state !== 'ok') return note(answer.state, { answer })
  const missing = (joined?.missing ?? 0) > 0
  if (missing) return stalled ? note('incomplete') : note('loading', { busy: true })
  return {
    ...base,
    state: 'ok',
    busy: false,
    current: true,
    tasks: joined?.tasks ?? [],
    held: heldOf(answer),
    remaining,
  }
}

/** The dependency read's state from what the store holds, `read`, while
    the Roadmap asks (`asks`): its pairs by handle and Auto-move's inputs.
    Only the live answer for the scope on screen counts, as a kept one may
    miss a link made meanwhile. */
function useDeps(read: ReturnType<typeof P.roadmapDependenciesRead>, asks: boolean): RoadmapDeps {
  const value: DependencyAnswer | undefined = read.value
  const pairsOf = useMemo(() => {
    if (value?.state !== 'ok') return []
    return value.pairs.map((pair) => ({
      blocker: handleOfUuid(pair.blocker),
      blocked: handleOfUuid(pair.blocked),
    }))
    // handles follow the views' news
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, P.updates.views.getSnapshot()])
  if (!asks) return { state: 'loading', pairs: [], autoMove: { state: 'loading' } }
  if (read.error !== undefined && read.current)
    return { state: 'error', pairs: [], autoMove: { state: 'error' } }
  if (!read.current || value === undefined)
    return { state: 'loading', pairs: [], autoMove: { state: 'loading' } }
  if (value.state !== 'ok')
    return { state: value.state, pairs: [], autoMove: { state: value.state } }
  return {
    state: 'ok',
    pairs: pairsOf,
    autoMove:
      value.auto_move.state === 'ok'
        ? { state: 'ok', inputs: value.auto_move }
        : { state: 'over_budget' },
  }
}

/** The handle task `uuid` shows by on the Roadmap: the one its row in an
    answer opens by, else the uuid itself, which no bar names. */
function handleOfUuid(uuid: string): string {
  return P.viewTask(ROADMAP_SLOT, uuid)?.id ?? uuid
}

/** Why the planning session or a plan request for a task cannot go on
    while the Roadmap shows `view`'s note, a sentence after the task's key,
    or null while it shows tasks or waits. */
export function cannotPlanReason(view: RoadmapView): string | null {
  switch (view.state) {
    case 'search_limit':
      return limitSentence(LIMITS.search)
    case 'over_ceiling':
      return limitSentence(LIMITS.roadmapTasks)
    case 'over_budget':
      return "This selection could not be loaded within the Roadmap's limits."
    case 'unavailable':
      return 'This Roadmap is not available.'
    case 'error':
      return 'The Roadmap could not be loaded.'
    case 'incomplete':
      return 'Some tasks of this Roadmap have not reached this window.'
    default:
      return null
  }
}

/** Auto-move's tooltip where its inputs are not there, by the dependency
    read's state, or null where they are. */
export function autoMoveUnavailable(deps: RoadmapDeps): string | null {
  switch (deps.autoMove.state) {
    case 'ok':
      return null
    case 'over_budget':
      return "Auto-move is unavailable because this selection's dependency chains are too long to read at once."
    case 'loading':
      return 'Auto-move waits for the dependency links to load.'
    case 'unavailable':
      return "Auto-move is unavailable because this selection's dependency links could not be read."
    default:
      return 'Auto-move is unavailable because the dependency links could not be loaded.'
  }
}

/** Why no dependency arrow shows, for the toolbar's line, or null while
    the arrows show. */
export function arrowsMissing(deps: RoadmapDeps): string | null {
  switch (deps.state) {
    case 'ok':
      return null
    case 'loading':
      return 'Loading dependency arrows…'
    case 'over_budget':
      return "Dependency arrows are not shown because this selection's links could not be read within the Roadmap's limits."
    case 'unavailable':
      return "Dependency arrows are not shown because this selection's links could not be read."
    default:
      return 'Dependency arrows are not shown because the links could not be loaded.'
  }
}
