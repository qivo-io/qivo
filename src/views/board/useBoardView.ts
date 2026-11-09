/* What the Board shows, for the desktop Board (views/Kanban.tsx) and the
   phone's task list (components/MobileWorkspace.tsx MobileTaskList): which
   tasks, in which state, from the server's answer for the selection
   (convex/tasks.ts board) and the rows it brings. The workspace holds no
   task, so every card comes from the answer.

   - The store owns the Board's read (P.watchBoard): each variant registers
     its arguments from an effect, or none while its page or the tab is
     hidden (lib/viewVisibility.ts), so a kept page stops its read and reads
     afresh when it shows again. The store names the projects the answer
     names with its project cache (store/planner.ts BOARD_QUERY `projects`),
     so a card's place and rights read their project from the cache, the
     store's only source of projects.
   - The answer decides the Board's groups and their order (`groups`,
     store/scopeGroups.ts): a project selection's sub-projects as the
     answer's `projects` names them, in its order, and My view's top-level
     projects from its held lanes and the cards' sub-projects folded
     through the project cache, home organization first, then by
     organization name and number. Before an answer there are none, and the
     loading frame shows its columns with no groups. A group whose project
     the cache has not answered shows under a loading heading.
   - The answer decides which tasks a Board shows. Each shows as the model
     the store shaped from the answer's row (store/viewRows.ts), painted
     with the person's pending writes, so a card follows every edit at once
     and a drag never snaps back.
   - On top of the answer, the app checks each task again against the
     filter row on screen and the answer's own selection (a project
     selection's `projects`, My view's `only`), so an edit, a move out of
     the selection or a new filter hides a card at once. That only narrows.
     A task shaped from a row has no text or labels, and a group's newest
     activity is the server's, so the text filter and a group's Stale are
     the answer's alone.
     A task the person's own pending writes changed, or a parent they moved
     a task to or from (P.ownPaintedTasks), shows as the rows on screen
     say, both ways, so a new task shows at once, a parent whose last subtask left shows as a task, and a
     refused write takes it away again. The person's new task goes into the
     Board's rows from what its create sent (store/viewRows.ts insert),
     and while the server has not taken it, the Board checks it against
     the whole text filter as the screen shows it, its description and
     labels included (P.createText), as the server will. Edits by others
     wait for the answer.
   - An answer counts only for the arguments it was sent with. Until the
     answer for the arguments on screen arrives, the Board shows the rows
     the store kept for those arguments while the read was stopped, marked
     refreshing, else its loading frame (`frame`): the columns, and the
     lanes or side-boards of the selection's groups, with counts "…" and no
     card. While typing only adds letters or words to the text filter of
     the answer on screen, with every other argument the same, the Board
     narrows that answer's cards by its own text check instead,
     marked refreshing, until the answer for the new text arrives. The
     client's text holds no description or labels, so it can only drop a
     card the server keeps, never show one it drops.
   - The answer brings a row for each task it names, so a whole answer
     names no task the Board cannot show. A row source that brings fewer
     (`missing`) keeps the Board loading, and STALL.ms later says that some
     tasks have not reached it; it never looks empty or complete
     meanwhile.
   - With a text filter, the person's own pending write on a task only the
     answer brings can take away the word the server found it by: its
     title, status, priority or assignee's name, from the Board or the
     task's window, or its description or labels, which only the task
     window changes (P.ownUnsentEdits). The Board knows each field its row
     sends but not the text it does not send (stillMatches): where it
     cannot tell, the card stays and the counts wait (`unsure`) until the
     answer holds the write. */

import { useEffect, useState } from 'react'
import type { BoardAnswer } from '../../../convex/lib/board'
import type { ViewRow } from '../../../convex/lib/viewReads'
import { nameOf } from '../../components/usePeople'
import { matchesAllWords, taskSearchText } from '../../lib/search'
import { useViewVisibility } from '../../lib/viewVisibility'
import { STALL } from '../../store/liveParts'
import {
  type IssueFilters,
  type IssueVM,
  nameUnknown,
  P,
  type ScopeInfo,
} from '../../store/planner'
import { type ScopeGroup, scopeGroups } from '../../store/scopeGroups'
import { useViewsNews } from '../useViewsNews'
import { type BoardVariant, boardFilters, useBoardRequest } from './boardArgs'

/** Where the Board stands, as its root's data-board-state names it. */
export type BoardState =
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
  /** whether the Board shows its loading frame: no answer for these
      arguments yet, so no card and no group, the columns standing, and no
      "Nothing matches" */
  frame: boolean
  /** the Board's groups, from the answer it shows (scopeGroups): a project
      selection's sub-projects, My view's top-level projects, none before
      an answer */
  groups: readonly ScopeGroup[]
  /** a project selection's sub-projects as the answer on screen names
      them, also on a refusal past the Board's limits; null in My view and
      before an answer */
  selection: readonly string[] | null
  /** whether a filter the Clear button clears is on: My tasks outside My
      view, people, priority, Stale or a text filter (trimmed, as the
      server trims it). The scope's own narrowing and Focus are not. */
  clearable: boolean
  /** the filter row as the Board applies it on screen */
  filters: IssueFilters
  /** Whether a lane or side-board of the sub-projects `subIds`, headed by
      project `head`, stays on the Board. */
  holds: (head: string, subIds: readonly string[]) => boolean
  /** Whether the answer says the selection holds no task, for the empty
      states, which an incomplete Board does not take: no clearable filter
      is on and no row still shows. */
  empty: () => boolean
  /** the answer when it is a state the Board shows a message for */
  answer: BoardAnswer | null
  /** Asks the server afresh (Try again). */
  retry: () => void
}

/** Whether a task shows in the Board of `info` with `filters` on screen,
    within `selection`, the answer's own project selection (null in My
    view, which narrows by `info.only`). The text filter is the answer's
    for every task: the server matched the whole text, label and assignee
    names included, which the store cannot read. A group has no newest
    activity of its subtasks here, so the answer decides Stale for it. */
function passes(
  info: ScopeInfo,
  selection: ReadonlySet<string> | null,
  filters: IssueFilters,
  it: IssueVM,
) {
  const local = { ...filters, search: '', stale: filters.stale && !it.isGroup }
  return (
    (selection === null || selection.has(it.project)) &&
    (!info.only || info.only(it)) &&
    P.passesFilters(it, local)
  )
}

/** The Board's group order: a project selection's in the answer's order,
    My view's top-level projects with the home organization first, then by
    organization name and project number, groups whose project loads last. */
export function boardGroups(
  info: ScopeInfo,
  source: {
    projects?: readonly string[]
    tops?: readonly string[]
    subs?: readonly string[]
  } | null,
): ScopeGroup[] {
  const groups = scopeGroups(info, source, P.project)
  if (!info.mine) return groups
  const orgName = (org: string) => P.orgs.find((o) => o.id === org)?.name ?? ''
  const rank = (g: ScopeGroup) => (g.proj === null ? 2 : g.proj.org === P.homeOrg ? 0 : 1)
  return groups
    .slice()
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.proj && b.proj
          ? orgName(a.proj.org).localeCompare(orgName(b.proj.org)) || a.proj.num - b.proj.num
          : 0),
    )
}

/* The search text of task `key` (convex/lib/search.ts taskSearchText)
   from the fields a row of the answer sends: without its description and
   labels, and without the assignee's name while it has not loaded
   (P.person), where the Board cannot tell (nameUnknown). */
export const shownText = (
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
    assigneeName: nameOf(P.person(assignee)),
    labelNames: [],
  })

/** Whether task `it`, which only the answer brings and which the person's
    own pending writes changed, still matches the text filter `search`:
    true, or null where the Board cannot tell. `row` is its row in the
    answer, which the server matched with the whole text, or undefined for
    a task the answer does not name for the filter (a parent it sends as
    a heading). A word matches where the fields shown now hold it. Where
    they do not, and a write changed the description or labels the row
    does not send (`unsent`, P.ownUnsentEdits), it may or may not be
    there. Otherwise it matches where the row's fields did not hold it
    either, since the server found it in the text the row does not send;
    a word only the row's changed fields held may or may not be there. */
function stillMatches(
  it: IssueVM,
  row: ViewRow | undefined,
  search: string,
  unsent: boolean,
): boolean | null {
  const now = shownText(it.key, it, P.isGroup(it), it.assignee)
  const then = row && shownText(it.key, row, row.has_subtasks, row.assignee_id)
  for (const word of search.split(/\s+/).filter(Boolean))
    if (
      !matchesAllWords(now, word) &&
      (unsent || then === undefined || matchesAllWords(then, word))
    )
      return null
  return true
}

/** The words of text filter `search`, lowercased, as the server matches
    them (convex/lib/search.ts allWordsMatcher). */
const wordsOf = (search: string) => search.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Whether the arguments `to` (a key of boardRequest) only narrow the text
 * filter of the arguments `from`: every other argument the same, and each
 * word of `from`'s text inside a word of `to`'s, so whatever the server
 * finds for `to` it finds for `from` too (every word a substring). Typing
 * that adds letters or words does; a deleted letter or another selection
 * does not.
 */
export function narrowsText(from: string, to: string): boolean {
  if (from === to) return false
  type Args = { scope: unknown; filters: { search: string } & Record<string, unknown> }
  let a: Args
  let b: Args
  try {
    a = JSON.parse(from) as Args
    b = JSON.parse(to) as Args
  } catch {
    return false
  }
  const rest = (args: Args) => JSON.stringify([args.scope, { ...args.filters, search: '' }])
  if (rest(a) !== rest(b)) return false
  const next = wordsOf(b.filters.search)
  return wordsOf(a.filters.search).every((word) => next.some((w) => w.includes(word)))
}

/* A task's number, from the key it renders (QN-n). */
const numOf = (it: IssueVM) => Number(it.key.slice(it.key.lastIndexOf('-') + 1))

/** Whether `a` comes before `b` in the answer's order: by number, then
    organization and id (convex/lib/board.ts BoardAnswer). */
export const before = (a: IssueVM, b: IssueVM) =>
  (numOf(a) - numOf(b) || (a.org < b.org ? -1 : a.org > b.org ? 1 : a.uuid < b.uuid ? -1 : 1)) < 0

/** The store's view slot each variant's read and rows live under
    (P.watchBoard, store/viewRows.ts). */
export const BOARD_SLOTS: Record<BoardVariant, string> = {
  desktop: 'board:desktop',
  phone: 'board:phone',
}

/** `active` once it held for STALL.ms under the same `key`. The Roadmap
    waits the same way (views/roadmap/useRoadmapView.ts), and Team sync's
    meeting waits the same way for the tasks its answer names
    (views/teamSync/useSyncMeeting.ts). */
export function useStall(active: boolean, key: string): boolean {
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
    Try again, and whether the view shows its cards' delays. An answer
    whose text filter `key` only narrows (narrowsText) stays with its rows
    until the answer for `key` arrives, so the Board narrows its cards
    meanwhile. Renders again on the store's `views` news
    (views/useViewsNews.ts). */
function useBoardRead(slot: string, key: string | null, delays: boolean) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  // this mounted Board, which owns the read while it asks
  const [owner] = useState(() => ++boardReaders)
  useViewsNews()
  const ask = visible ? key : null
  useEffect(() => {
    const held = P.boardRead(slot)
    const narrows =
      ask !== null && held.key !== null && held.value?.state === 'ok' && narrowsText(held.key, ask)
    P.watchBoard(slot, ask, attempt, owner, delays, narrows)
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
  // the answer for a text filter that the text on screen only narrows
  // (narrowsText): the live one while typing rests before the new text
  // goes out, and the last one until the new text's answer arrives
  const narrowed =
    !mine &&
    wantKey !== null &&
    read.key !== null &&
    read.value?.state === 'ok' &&
    narrowsText(read.key, wantKey)
      ? read.value
      : null
  const shownAnswer = answer?.state === 'ok' ? answer : (kept ?? narrowed)
  // a project selection's sub-projects, from the answer on screen, also a
  // refusal's, which names them; null in My view
  const selectionList = info.mine
    ? null
    : (shownAnswer?.projects ?? (answer && 'projects' in answer ? (answer.projects ?? null) : null))
  const selection = selectionList ? new Set(selectionList) : null
  // a filter the Clear button clears; trimmed, as the server trims the text
  const clearable =
    (!info.mine && filters.mine) ||
    filters.assignees.length > 0 ||
    !!filters.priority ||
    filters.stale ||
    filters.search.trim() !== ''

  // an ok answer joined to the tasks it brings, in its order: the tasks it
  // shows, how many it names that no source can show yet, and how many of
  // the person's own changed tasks it may not match the text filter for
  let joined: { tasks: IssueVM[]; missing: number; unsure: number } | null = null
  if (shownAnswer) {
    // under a text filter, a task whose description or labels a window
    // write changed decides as the person's own changed tasks do
    const unsent = filters.search ? P.ownUnsentEdits() : null
    const own = unsent?.size ? new Set([...P.ownPaintedTasks(), ...unsent]) : P.ownPaintedTasks()
    const modelOf = (uuid: string) => P.viewTask(slot, uuid)
    // the Board's own text check of a narrowed answer, over the fields a
    // row sends
    // A task whose assignee's name has not loaded may match by it, so the
    // check keeps it and the server's answer for the text decides.
    const textOk = (it: IssueVM) =>
      !narrowed ||
      matchesAllWords(shownText(it.key, it, P.isGroup(it), it.assignee), filters.search) ||
      nameUnknown(P.person(it.assignee, it.org))
    const shown = new Set<string>()
    const tasks: IssueVM[] = []
    let missing = 0
    for (const row of shownAnswer.rows) {
      if (own.has(row.id)) continue
      const it = modelOf(row.id)
      if (!it) {
        missing++
        continue
      }
      if (passes(info, selection, filters, it) && textOk(it)) {
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
      if (!it || shown.has(uuid) || !passes(info, selection, filters, it) || !textOk(it)) continue
      // the person's new task on its way, by its whole text as the screen
      // shows it, the writes sent behind its create included
      const created = filters.search ? P.createText(uuid) : null
      if (created !== null && !matchesAllWords(created, filters.search)) continue
      // a task the local check searched by nothing (passes), which the
      // answer matched before the person's writes changed it
      if (answered && created === null) {
        const text = !!unsent?.has(uuid)
        if (stillMatches(it, answered.get(uuid), filters.search, text) === null) unsure++
      }
      shown.add(uuid)
      let at = tasks.length
      while (at > 0 && before(it, tasks[at - 1] as IssueVM)) at--
      tasks.splice(at, 0, it)
    }
    joined = { tasks, missing, unsure }
  }
  const stalled = useStall(joined !== null && joined.missing > 0, wantKey ?? '')

  // the groups of the answer on screen: a project selection's sub-projects,
  // My view's held lanes and the cards' sub-projects folded through the
  // project cache
  const groups = boardGroups(
    info,
    info.mine
      ? shownAnswer
        ? {
            tops: shownAnswer.held_projects,
            subs: (joined?.tasks ?? []).map((it) => it.project),
          }
        : null
      : selectionList
        ? { projects: selectionList }
        : null,
  )
  const base = {
    filters,
    clearable,
    counted: false,
    busy: false,
    frame: false,
    groups,
    selection: selectionList,
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
  /** The lanes an answer `a` keeps: its held projects and the projects of
      the cards on screen. */
  const holdsOf = (a: BoardAnswer & { state: 'ok' }, tasks: readonly IssueVM[]) => {
    const held = new Set(a.held_projects)
    const cardProjects = new Set(tasks.map((it) => it.project))
    return (head: string, subIds: readonly string[]) =>
      held.has(head) || subIds.some((id) => held.has(id) || cardProjects.has(id))
  }
  /** Whether answer `a` says the selection holds no task: no clearable
      filter, and no row still shows (a person's own archive or delete takes
      one away at once). Without a clearable filter its held projects are
      the projects of its rows, except under Focus, which adds the
      sub-projects that hold any active task, so a Focus Board also needs
      none held. */
  const emptyOf = (a: BoardAnswer & { state: 'ok' }) => () => {
    if (clearable || (filters.focus && a.held_projects.length > 0)) return false
    const own = P.ownPaintedTasks()
    return a.rows.every((row) => own.has(row.id) && !P.ownOnScreen(slot, row.id))
  }
  if (want.kind === 'search_limit') return message('search_limit')
  if (current?.error !== undefined) return message('error')
  if (answer === null && (kept ?? narrowed) && joined) {
    // the rows kept for these arguments while the read was stopped, or the
    // live answer narrowed by the text on screen, until the answer for these
    // arguments arrives
    const from = (kept ?? narrowed) as BoardAnswer & { state: 'ok' }
    return {
      ...base,
      state: 'refreshing',
      busy: true,
      tasks: joined.tasks,
      shows: true,
      holds: holdsOf(from, joined.tasks),
      // a narrowed answer says nothing of the new text's matches
      empty: kept ? emptyOf(kept) : () => false,
    }
  }
  if (answer === null) {
    // the loading frame: the columns with no group, as the groups come
    // from the answer, so it shows the one unlabeled lane
    return {
      ...base,
      state: read.answered ? 'refreshing' : 'loading',
      busy: true,
      frame: true,
      tasks: [],
      shows: true,
      holds: () => false,
    }
  }
  if (answer.state !== 'ok') return message(answer.state, { answer })
  const tasks = joined?.tasks ?? []
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
    holds: holdsOf(answer, tasks),
    empty: emptyOf(answer),
  }
}
