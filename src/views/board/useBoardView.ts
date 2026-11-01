/* What the Board shows, for the desktop Board (views/Kanban.tsx) and the
   phone's task list (components/MobileWorkspace.tsx MobileTaskList): which
   tasks, in which state, from the server's answer for the selection
   (convex/tasks.ts board) joined to the store's own view models.

   - The answer decides which tasks a Board shows. Each one shows as the
     store's painted view model, found by uuid, so a card follows every
     edit at once and a drag never snaps back. Answer rows are never put
     into the store's rows.
   - On top of the answer, the app checks each task again against the
     filter row on screen and the selection, so an edit or a new filter
     hides a card at once. That only narrows. A task the person's own
     pending writes changed (P.ownPaintedTasks) shows as the rows on screen
     say, both ways, as the task window's sections do, so a new task shows
     at once and a refused write takes it away again. Edits by others wait
     for the answer.
   - An answer counts only for the arguments it was sent with. Until the
     answer for the arguments on screen arrives, the Board shows the store's
     own result for them (provisionalBoard), marked loading or refreshing,
     as long as it holds at most BOARD_TASKS cards.
   - A task the answer names that the store does not hold yet keeps the
     Board loading, and so does a parent heading the desktop Board shows
     above its cards. Once the workspace has loaded, it may stay missing for
     STALL.ms before the Board says that some tasks have not reached it;
     it never looks empty or complete meanwhile. */

import { useEffect, useState } from 'react'
import { api } from '../../../convex/_generated/api'
import type { BoardAnswer } from '../../../convex/lib/board'
import { BOARD_TASKS } from '../../../convex/lib/limits'
import { useLiveView } from '../../lib/liveView'
import { STALL } from '../../store/liveParts'
import { type IssueFilters, type IssueVM, P, type ScopeInfo } from '../../store/planner'
import { type BoardVariant, boardFilters, useBoardRequest } from './boardArgs'

const BOARD_QUERY = api.tasks.board

/** Where the Board stands, as its root's data-board-state names it. */
export type BoardState =
  /** All projects, where the Board asks to choose a project */
  | 'choose'
  /** the first answer for this Board is on its way, or it names tasks the
      store has not received yet */
  | 'loading'
  /** an earlier answer was for other arguments, a hidden tab or a page shown
      again; the answer for these is on its way */
  | 'refreshing'
  | 'ok'
  /** some tasks the answer names did not reach the store in time */
  | 'incomplete'
  | 'over_ceiling'
  | 'over_budget'
  | 'unavailable'
  | 'error'
  /** a text filter past LIMITS.search, which the Board does not send */
  | 'search_limit'

/** What the Board shows. */
export type BoardView = {
  state: BoardState
  /** the tasks the Board shows, groups included, in the store's order;
      empty where a message replaces the Board */
  tasks: IssueVM[]
  /** whether the tasks show; false where a message takes their place */
  shows: boolean
  /** whether the counts are the answer's, so they may show */
  counted: boolean
  /** whether the Board waits for an answer (its root's aria-busy) */
  busy: boolean
  /** the filter row as the Board applies it on screen */
  filters: IssueFilters
  /** Whether a lane or side-board of the sub-projects `subIds`, headed by
      project `head`, stays on the Board. */
  holds: (head: string, subIds: readonly string[]) => boolean
  /** Whether the selection holds no task the store has, for the empty
      states, which an incomplete Board does not take. */
  empty: () => boolean
  /** the answer when it is a state the Board shows a message for */
  answer: BoardAnswer | null
  /** Asks the server afresh (Try again). */
  retry: () => void
}

/** Whether a task shows in the Board of `info` with `filters` on screen. */
const passes = (info: ScopeInfo, filters: IssueFilters, it: IssueVM) =>
  info.subIdSet.has(it.project) && (!info.only || info.only(it)) && P.passesFilters(it, filters)

/** The leaves among `tasks`, the cards the desktop Board shows. */
const cardCount = (tasks: readonly IssueVM[]) => tasks.filter((it) => !P.isGroup(it)).length

/**
 * provisionalBoard: the store's own result for the filter row on screen, as
 * the Board showed it before the server answered Boards, while the answer
 * for these arguments is on its way. The stage that stops loading every
 * task removes this branch with P.scopedIssues.
 */
function provisionalBoard(info: ScopeInfo, filters: IssueFilters) {
  const scoped = P.scopedIssues(info)
  const tasks = scoped.filter((it) => P.passesFilters(it, filters))
  const projects = new Set(scoped.map((it) => it.project))
  return {
    tasks,
    shows: cardCount(tasks) <= BOARD_TASKS,
    holds: (_head: string, subIds: readonly string[]) => subIds.some((id) => projects.has(id)),
    empty: () => scoped.length === 0,
  }
}

/** `active` once it held for STALL.ms under the same `key`. */
function useStall(active: boolean, key: string): boolean {
  const [fired, setFired] = useState<string | null>(null)
  useEffect(() => {
    if (!active) {
      setFired(null)
      return
    }
    const timer = setTimeout(() => setFired(key), STALL.ms)
    return () => clearTimeout(timer)
  }, [active, key])
  return active && fired === key
}

/** What the Board of `info` shows with the filter row `filters` (App's
    effFilters on the desktop, the raw row on the phone) in `variant`. */
export function useBoardView(
  info: ScopeInfo,
  rawFilters: IssueFilters,
  variant: BoardVariant,
): BoardView {
  const filters = boardFilters(info, rawFilters, variant)
  const { want, send } = useBoardRequest(info, filters)
  const live = useLiveView<BoardAnswer>(BOARD_QUERY, send.kind === 'ask' ? send.key : null)
  const wantKey = want.kind === 'ask' ? want.key : null
  const current = wantKey !== null && live.key === wantKey ? live : null
  const answer = current?.value ?? null

  // an ok answer joined to the store's view models: the tasks it shows, and
  // how many it names that the store does not hold
  let joined: { tasks: IssueVM[]; missing: number } | null = null
  if (answer?.state === 'ok') {
    const own = P.ownPaintedTasks()
    const shown = new Set<string>()
    const held = (uuid: string) => {
      const handle = P.handleOf(uuid)
      return handle === null ? undefined : P.issueById[handle]
    }
    let missing = 0
    for (const row of answer.rows) {
      if (own.has(row.id)) continue
      const it = held(row.id)
      if (!it) missing++
      else if (passes(info, filters, it)) shown.add(it.id)
    }
    // the parent headings the desktop Board draws above its cards
    if (variant === 'desktop')
      for (const row of answer.parents) if (!own.has(row.id) && !held(row.id)) missing++
    // the person's own pending writes decide for the tasks they changed
    for (const uuid of own) {
      const handle = P.handleOf(uuid)
      const it = handle === null ? undefined : P.issueById[handle]
      if (it && passes(info, filters, it)) shown.add(it.id)
    }
    joined = { tasks: P.issues.filter((it) => shown.has(it.id)), missing }
  }
  const stalled = useStall(
    joined !== null && joined.missing > 0 && P.stillLoading() === null,
    wantKey ?? '',
  )

  const base = {
    filters,
    counted: false,
    busy: false,
    answer: null,
    retry: live.retry,
    holds: () => false,
    empty: () => false,
  }
  const message = (state: BoardState, extra: Partial<BoardView> = {}): BoardView => ({
    ...base,
    state,
    tasks: [],
    shows: false,
    ...extra,
  })
  if (want.kind === 'choose') return message('choose')
  if (want.kind === 'search_limit') return message('search_limit')
  if (current?.error !== undefined) return message('error')
  if (answer === null) {
    const provisional = provisionalBoard(info, filters)
    return {
      ...base,
      state: live.answered ? 'refreshing' : 'loading',
      busy: true,
      tasks: provisional.shows ? provisional.tasks : [],
      shows: provisional.shows,
      holds: provisional.holds,
      empty: provisional.empty,
    }
  }
  if (answer.state !== 'ok') return message(answer.state, { answer })
  const held = new Set(answer.held_projects)
  const tasks = joined?.tasks ?? []
  const cardProjects = new Set(tasks.map((it) => it.project))
  const missing = (joined?.missing ?? 0) > 0
  return {
    ...base,
    state: missing ? (stalled ? 'incomplete' : 'loading') : 'ok',
    counted: !missing,
    busy: missing && !stalled,
    tasks,
    shows: true,
    holds: (head, subIds) =>
      held.has(head) || subIds.some((id) => held.has(id) || cardProjects.has(id)),
    empty: () => P.scopedIssues(info).length === 0,
  }
}
