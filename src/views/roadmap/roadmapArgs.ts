/* What the Roadmap asks the server (convex/tasks.ts roadmap and
   roadmapDependencies) for the selection, the filter row and the window on
   screen: one place builds the arguments, in a fixed key order, so equal
   selections share one subscription and their key (the store's reads,
   P.watchRoadmap and P.watchRoadmapDependencies), and any change asks
   afresh. The Board's request (views/board/boardArgs.ts) is the pattern. */

import { ISSUE_PRIORITIES, type IssuePriority } from '../../../convex/lib/enums'
import { LIMITS } from '../../../convex/lib/limits'
import type {
  PlannedTask,
  RoadmapFilters,
  RoadmapScope,
  RoadmapWindow,
} from '../../../convex/lib/roadmap'
import { weekToISO } from '../../lib/dates'
import { overLimit } from '../../lib/fieldLimits'
import { useRested } from '../../lib/useRested'
import type { IssueFilters, ScopeInfo } from '../../store/planner'
import { BOARD_SEARCH_DELAY_MS } from '../board/boardArgs'

/** What the Roadmap asks for. */
export type RoadmapRequest =
  /** a text filter past LIMITS.search, which the server refuses */
  | { kind: 'search_limit' }
  /** the Roadmap read's arguments as their key (JSON in a fixed key
      order), and the dependency read's, its scope alone */
  | { kind: 'ask'; key: string; deps: string }

/** The arguments of a Roadmap read as its key holds them. */
type RoadmapArgs = {
  scope: RoadmapScope
  filters: RoadmapFilters
  window: RoadmapWindow
  planned_task?: PlannedTask
}

/**
 * The Roadmap's request for the selection `info`, the filter row `filters`
 * as the Roadmap applies it on screen (App's roadmapFilters, the phone's
 * without a text filter), the window `win` of weeks on the grid of now
 * (resolveWin's capped weeks) and the planning session's task `planned`,
 * with `search` as the text to send, which the desktop's typing delays.
 * The people filter is sent deduplicated and sorted, as the server matches
 * each id exactly; the text trimmed, as the server trims it; the window as
 * the first days of its first and last weeks on the grid (weekToISO), so a
 * grid that moves (P.gridEpoch) asks afresh.
 */
export function roadmapRequest(
  info: Pick<ScopeInfo, 'mine' | 'id'> & { proj: { org: string } | null },
  filters: IssueFilters,
  win: { w0: number; w1: number },
  planned: PlannedTask | null,
  search: string = filters.search,
): RoadmapRequest {
  const text = search.trim()
  if (overLimit(LIMITS.search, text)) return { kind: 'search_limit' }
  const scope: RoadmapScope = info.mine
    ? { kind: 'mine' }
    : { kind: 'project', org_id: info.proj?.org ?? '', project_id: info.id }
  const priority = (ISSUE_PRIORITIES as readonly string[]).includes(filters.priority ?? '')
    ? (filters.priority as IssuePriority)
    : null
  // My view is the person's own tasks: My tasks adds nothing, and the
  // people filter is hidden there (App's effFilters)
  const sent: RoadmapFilters = {
    mine: info.mine || filters.mine,
    owners: info.mine ? [] : [...new Set(filters.assignees)].sort(),
    priority,
    search: text,
  }
  const args: RoadmapArgs = {
    scope,
    filters: sent,
    window: { from: weekToISO(win.w0), to: weekToISO(win.w1) },
    ...(planned ? { planned_task: { id: planned.id, project_id: planned.project_id } } : {}),
  }
  return { kind: 'ask', key: JSON.stringify(args), deps: JSON.stringify({ scope }) }
}

/** The words of text filter `search`, lowercased, as the server matches
    them (convex/lib/search.ts allWordsMatcher). */
const wordsOf = (search: string) => search.toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Whether the Roadmap keeps the answer for the arguments `from` (a key of
 * roadmapRequest) on screen, marked refreshing, while the answer for `to`
 * is on its way. It keeps it for the same scope and filter row with
 * another window or planned task (the coordinator's rule of 5 November
 * 2026), and for typing that only narrows the text filter, every other
 * filter the same, so the Roadmap's own check of what it shows can only
 * drop a task the server keeps (the Board's rule,
 * views/board/useBoardView.ts narrowsText). Any other change shows the
 * loading frame.
 */
export function keepsRoadmap(from: string, to: string): boolean {
  if (from === to) return false
  let a: RoadmapArgs
  let b: RoadmapArgs
  try {
    a = JSON.parse(from) as RoadmapArgs
    b = JSON.parse(to) as RoadmapArgs
  } catch {
    return false
  }
  if (JSON.stringify(a.scope) !== JSON.stringify(b.scope)) return false
  const rest = (f: RoadmapFilters) => JSON.stringify({ ...f, search: '' })
  if (rest(a.filters) !== rest(b.filters)) return false
  if (a.filters.search === b.filters.search) return true
  const next = wordsOf(b.filters.search)
  return wordsOf(a.filters.search).every((word) => next.some((w) => w.includes(word)))
}

/** Whether the arguments `to` change the text filter of `from`, so the
    Roadmap narrows a kept answer by its own text check. */
export function textChanged(from: string, to: string): boolean {
  try {
    const a = JSON.parse(from) as RoadmapArgs
    const b = JSON.parse(to) as RoadmapArgs
    return a.filters.search !== b.filters.search
  } catch {
    return true
  }
}

/**
 * The Roadmap's requests for `info` with the filter row `filters`, the
 * window `win` and the planned task `planned` (roadmapRequest): `want` for
 * the arguments on screen, whose answer alone counts, and `send` with the
 * text filter once typing rests (BOARD_SEARCH_DELAY_MS), which the Roadmap
 * subscribes to. A text filter past LIMITS.search sends nothing. The phone
 * has no text filter, so it sends none.
 */
export function useRoadmapRequest(
  info: Pick<ScopeInfo, 'mine' | 'id'> & { proj: { org: string } | null },
  filters: IssueFilters,
  win: { w0: number; w1: number },
  planned: PlannedTask | null,
): { want: RoadmapRequest; send: RoadmapRequest } {
  const rested = useRested(filters.search.trim(), BOARD_SEARCH_DELAY_MS)
  const want = roadmapRequest(info, filters, win, planned)
  const send = want.kind === 'ask' ? roadmapRequest(info, filters, win, planned, rested) : want
  return { want, send }
}
