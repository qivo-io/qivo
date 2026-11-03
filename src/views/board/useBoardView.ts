/* What the Board shows, for the desktop Board (views/Kanban.tsx) and the
   phone's task list (components/MobileWorkspace.tsx MobileTaskList): which
   tasks, in which state, from the server's answer for the selection
   (convex/tasks.ts board) and the rows it brings.

   - The store owns the Board's read (P.watchBoard): each variant registers
     its arguments from an effect, or none while its page or the tab is
     hidden (lib/viewVisibility.ts), so a kept page stops its read and reads
     afresh when it shows again.
   - The answer decides which tasks a Board shows. Each shows as the
     workspace's view model where the workspace holds the task, else as the
     model the store shaped from the answer's row (store/viewRows.ts), so a
     card shows before the workspace has received its task. Either is
     painted with the person's pending writes, so a card follows every edit
     at once and a drag never snaps back.
   - On top of the answer, the app checks each task again against the
     filter row on screen and the selection, so an edit or a new filter
     hides a card at once. That only narrows. A task shaped from a row has
     no text or labels, and a group's newest activity is the server's, so
     for those the text filter and a group's Stale are the answer's alone.
     A task the person's own pending writes changed, or a parent they moved
     a task to or from (P.ownPaintedTasks), shows as the rows on screen
     say, both ways, as the task window's sections do, so a new task shows
     at once, a parent whose last subtask left shows as a task, and a
     refused write takes it away again. Edits by others wait for the answer.
   - An answer counts only for the arguments it was sent with. Until the
     answer for the arguments on screen arrives, the Board shows the rows
     the store kept for those arguments while the read was stopped, marked
     refreshing, else the store's own result for them (provisionalBoard),
     marked loading or refreshing, as long as it holds at most BOARD_TASKS
     cards.
   - The answer brings a row for each task it names, so a whole answer
     names no task the Board cannot show. A row source that brings fewer
     (`missing`) keeps the Board loading, and STALL.ms later says that some
     tasks have not reached it; it never looks empty or complete meanwhile.
     While the workspace loads, a subtask it holds whose parent only the
     answer brings counts as missing on the desktop too: its card shows,
     but without its parent's heading until the parent loads.
   - With a text filter, the person's own pending write on a task only the
     answer brings can take away the word the server found it by, its
     status or its assignee's name. The Board knows each field the write
     changes but not the text the row does not send (stillMatches): where
     it cannot tell, the card stays and the counts wait (`unsure`) until
     the answer holds the write. */

import { useEffect, useState } from 'react'
import type { BoardAnswer } from '../../../convex/lib/board'
import { BOARD_TASKS } from '../../../convex/lib/limits'
import type { ViewRow } from '../../../convex/lib/viewReads'
import { matchesAllWords, taskSearchText } from '../../lib/search'
import { useViewVisibility } from '../../lib/viewVisibility'
import { STALL } from '../../store/liveParts'
import { type IssueFilters, type IssueVM, P, type ScopeInfo } from '../../store/planner'
import { useViewsNews } from '../useViewsNews'
import { type BoardVariant, boardFilters, useBoardRequest } from './boardArgs'

/** Where the Board stands, as its root's data-board-state names it. */
export type BoardState =
  /** All projects, where the Board asks to choose a project */
  | 'choose'
  /** the first answer for this Board is on its way, or a task it names has
      no model to show yet (`missing` in useBoardView) */
  | 'loading'
  /** an earlier answer was for other arguments, a hidden tab or a page shown
      again; the answer for these is on its way */
  | 'refreshing'
  | 'ok'
  /** a task the answer names still had no model to show STALL.ms later:
      the fail-safe that keeps the rest from showing as complete */
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
  /** the tasks the Board shows, groups included, in the answer's order (by
      number, then organization and id, the store's order too); empty where
      a message replaces the Board */
  tasks: IssueVM[]
  /** whether the tasks show; false where a message takes their place */
  shows: boolean
  /** whether the counts are the answer's, so they may show */
  counted: boolean
  /** whether the Board waits for an answer (its root's aria-busy) */
  busy: boolean
  /** whether the tasks are the store's own result, shown until the answer
      for these arguments arrives (provisionalBoard), among which tasks a
      staged load still brings land; an answer's tasks are all there */
  provisional: boolean
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

/** Whether a task shows in the Board of `info` with `filters` on screen. A
    task only the answer brings has no text or labels to search, and a
    group of it no newest activity of its subtasks, so the answer decides
    those. */
function passes(info: ScopeInfo, filters: IssueFilters, it: IssueVM) {
  const shaped = P.handleOf(it.uuid) === null
  const local = shaped ? { ...filters, search: '', stale: filters.stale && !it.isGroup } : filters
  return (
    info.subIdSet.has(it.project) && (!info.only || info.only(it)) && P.passesFilters(it, local)
  )
}

/* The search text of task `key` (convex/lib/search.ts taskSearchText)
   from the fields a row of the answer sends: without its description and
   labels. */
const shownText = (
  key: string,
  t: { title: string; status: ViewRow['status']; priority: ViewRow['priority'] },
  group: boolean,
  assignee: string | null | undefined,
) =>
  taskSearchText({
    key,
    title: t.title,
    description: '',
    status: t.status,
    group,
    priority: t.priority,
    assigneeName: assignee ? P.user(assignee)?.name : undefined,
    labelNames: [],
  })

/** Whether task `it`, which only the answer brings and which the person's
    own pending writes changed, still matches the text filter `search`:
    true, or null where the Board cannot tell. `row` is its row in the
    answer, which the server matched with the whole text, or undefined for
    a task the answer does not name for the filter (a parent it sends as
    a heading). A Board write changes the status and the owners only
    (store/planner.ts VIEW_WRITES), never the description or labels the
    row does not send, so a word matches where the fields shown now hold
    it, or where the row's fields did not hold it, since the server found
    it in that text; a word only the row's changed fields held may or may
    not be there. */
function stillMatches(it: IssueVM, row: ViewRow | undefined, search: string): boolean | null {
  const now = shownText(it.key, it, P.isGroup(it), it.assignee)
  const then = row && shownText(it.key, row, row.has_subtasks, row.assignee_id)
  for (const word of search.split(/\s+/).filter(Boolean))
    if (!matchesAllWords(now, word) && (then === undefined || matchesAllWords(then, word)))
      return null
  return true
}

/* A task's number, from the key it renders (QN-n). */
const numOf = (it: IssueVM) => Number(it.key.slice(it.key.lastIndexOf('-') + 1))

/** Whether `a` comes before `b` in the answer's order: by number, then
    organization and id (convex/lib/board.ts BoardAnswer). */
const before = (a: IssueVM, b: IssueVM) =>
  (numOf(a) - numOf(b) || (a.org < b.org ? -1 : a.org > b.org ? 1 : a.uuid < b.uuid ? -1 : 1)) < 0

/** The store's view slot each variant's read and rows live under
    (P.watchBoard, store/viewRows.ts). */
export const BOARD_SLOTS: Record<BoardVariant, string> = {
  desktop: 'board:desktop',
  phone: 'board:phone',
}

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

/* How many Boards mounted, each one's read owner (P.watchBoard). */
let boardReaders = 0

/** The read of the Board's answer that view `slot` registers with the
    store (P.watchBoard) for the arguments `key`, while the page shows, with
    Try again, and whether the view shows its cards' delays. Renders again
    on the store's `views` news (views/useViewsNews.ts). */
function useBoardRead(slot: string, key: string | null, delays: boolean) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  // this mounted Board, which owns the read while it asks
  const [owner] = useState(() => ++boardReaders)
  useViewsNews()
  const ask = visible ? key : null
  useEffect(() => {
    P.watchBoard(slot, ask, attempt, owner, delays)
    return () => P.watchBoard(slot, null, attempt, owner, delays)
  }, [slot, ask, attempt, owner, delays])
  return { ...P.boardRead(slot), retry: () => setAttempt((n) => n + 1) }
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
  const slot = BOARD_SLOTS[variant]
  // the other variant's rows, kept since the layout crossed the phone's
  // width, would stand in for this one's in lookups, writes and delays
  // (store/viewRows.ts), so they go when this variant mounts
  useEffect(() => {
    P.releaseView(BOARD_SLOTS[variant === 'desktop' ? 'phone' : 'desktop'])
  }, [variant])
  // the phone's list draws no delay band (MobileWorkspace.tsx), so it asks
  // for no owner's load
  const read = useBoardRead(slot, send.kind === 'ask' ? send.key : null, variant === 'desktop')
  const wantKey = want.kind === 'ask' ? want.key : null
  // what the read holds for the arguments on screen: its live result, or
  // the rows it kept while it was stopped
  const mine = wantKey !== null && read.key === wantKey
  const current = mine && read.current ? read : null
  const kept = mine && !read.current && read.value?.state === 'ok' ? read.value : null
  const answer = current?.value ?? null
  const shownAnswer = answer?.state === 'ok' ? answer : kept

  // an ok answer joined to the tasks it brings, in its order: the tasks it
  // shows, how many it names that no source can show yet, and how many of
  // the person's own changed tasks it may not match the text filter for
  let joined: { tasks: IssueVM[]; missing: number; unsure: number } | null = null
  if (shownAnswer) {
    const own = P.ownPaintedTasks()
    const modelOf = (uuid: string) => {
      const handle = P.handleOf(uuid)
      return handle === null ? P.viewTask(slot, uuid) : P.issueById[handle]
    }
    const shown = new Set<string>()
    const tasks: IssueVM[] = []
    let missing = 0
    // while the workspace loads, a subtask it holds names no parent it does
    // not hold (store/viewModels.ts), so the desktop Board would file it
    // without the heading of a parent only the answer brings
    const loading = variant === 'desktop' && P.stillLoading() !== null
    for (const row of shownAnswer.rows) {
      if (own.has(row.id)) continue
      const it = modelOf(row.id)
      if (!it) {
        missing++
        continue
      }
      if (
        loading &&
        row.parent_id &&
        P.handleOf(row.id) !== null &&
        P.handleOf(row.parent_id) === null &&
        P.viewTask(slot, row.parent_id)
      )
        missing++
      if (passes(info, filters, it)) {
        shown.add(it.uuid)
        tasks.push(it)
      }
    }
    // the parent headings the desktop Board draws above its cards
    if (variant === 'desktop')
      for (const row of shownAnswer.parents) if (!own.has(row.id) && !modelOf(row.id)) missing++
    // the person's own pending writes decide for the tasks they changed,
    // each put in its place in the answer's order
    let unsure = 0
    const answered = filters.search ? new Map(shownAnswer.rows.map((row) => [row.id, row])) : null
    for (const uuid of own) {
      const it = P.ownOnScreen(slot, uuid)
      if (!it || shown.has(uuid) || !passes(info, filters, it)) continue
      // a task only the answer brings, which the local check searched by
      // nothing (passes)
      if (answered && P.handleOf(uuid) === null) {
        if (stillMatches(it, answered.get(uuid), filters.search) === null) unsure++
      }
      shown.add(uuid)
      let at = tasks.length
      while (at > 0 && before(it, tasks[at - 1] as IssueVM)) at--
      tasks.splice(at, 0, it)
    }
    joined = { tasks, missing, unsure }
  }
  const stalled = useStall(
    joined !== null && joined.missing > 0 && P.stillLoading() === null,
    wantKey ?? '',
  )

  const base = {
    filters,
    counted: false,
    busy: false,
    provisional: false,
    answer: null,
    retry: read.retry,
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
  if (answer === null && kept && joined) {
    // the rows kept for these arguments while the read was stopped, until
    // the fresh answer arrives
    const held = new Set(kept.held_projects)
    const cardProjects = new Set(joined.tasks.map((it) => it.project))
    return {
      ...base,
      state: 'refreshing',
      busy: true,
      tasks: joined.tasks,
      shows: true,
      holds: (head, subIds) =>
        held.has(head) || subIds.some((id) => held.has(id) || cardProjects.has(id)),
      empty: () => kept.rows.length === 0 && P.scopedIssues(info).length === 0,
    }
  }
  if (answer === null) {
    const provisional = provisionalBoard(info, filters)
    return {
      ...base,
      state: read.answered ? 'refreshing' : 'loading',
      busy: true,
      provisional: true,
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
  // a card the Board cannot tell still matches the text filter stays, and
  // the counts wait for the answer that holds the write
  const unsure = (joined?.unsure ?? 0) > 0
  return {
    ...base,
    state: missing ? (stalled ? 'incomplete' : 'loading') : 'ok',
    counted: !missing && !unsure,
    busy: (missing && !stalled) || unsure,
    tasks,
    shows: true,
    holds: (head, subIds) =>
      held.has(head) || subIds.some((id) => held.has(id) || cardProjects.has(id)),
    // no row of the answer still shows a task (a person's own archive or
    // delete takes one away at once), and none of the store's tasks of the
    // selection, which may be still to come while the workspace loads
    empty: () => {
      const own = P.ownPaintedTasks()
      return (
        P.scopedIssues(info).length === 0 &&
        answer.rows.every((row) => own.has(row.id) && !P.ownOnScreen(slot, row.id))
      )
    },
  }
}
