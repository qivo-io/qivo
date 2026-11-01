/* What the Board asks the server (convex/tasks.ts board) for the selection
   and the filter row on screen: one place builds the arguments, in a fixed
   key order, so equal selections share one subscription and their key
   (useLiveView) and any change asks afresh. */

import { useEffect, useState } from 'react'
import type { BoardFilters, BoardScope } from '../../../convex/lib/board'
import { ISSUE_PRIORITIES, type IssuePriority } from '../../../convex/lib/enums'
import { LIMITS } from '../../../convex/lib/limits'
import { overLimit } from '../../lib/fieldLimits'
import { useViewVisibility } from '../../lib/viewVisibility'
import type { IssueFilters, ScopeInfo } from '../../store/planner'

/** The Board's two faces: the desktop Board, or the phone's task list,
    which reads no text filter. */
export type BoardVariant = 'desktop' | 'phone'

/** The app's Stale threshold in days (src/store/planner.ts isStale). */
export const STALE_DAYS = 120
const DAY = 86_400_000
const HOUR = 3_600_000

/** How long typing rests before the Board asks with a new text filter, as
    the Search palette and Archived tasks wait (SEARCH_DELAY_MS). */
export const BOARD_SEARCH_DELAY_MS = 250

/** The Stale filter's cutoff at `now`, in ms: STALE_DAYS before it, floored
    to the hour, so the arguments stay the same for an hour. Being earlier
    than the live clock's cutoff, every task the server finds stale with it
    is stale on the live clock too (P.isStale), so the app's own check of a
    task the answer holds never disagrees with it. */
export const staleCutoff = (now: number): string =>
  new Date(Math.floor((now - STALE_DAYS * DAY) / HOUR) * HOUR).toISOString()

/** The filter row as the Board applies it on screen: the desktop's as App
    hands it (effFilters), the phone's with no text and, in My view, no
    people filter, as MobileTaskList always read it. */
export function boardFilters(
  info: Pick<ScopeInfo, 'mine'>,
  filters: IssueFilters,
  variant: BoardVariant,
): IssueFilters {
  const search = variant === 'phone' ? '' : filters.search
  return info.mine ? { ...filters, search, mine: true, assignees: [] } : { ...filters, search }
}

/** What the Board asks for. */
export type BoardRequest =
  /** All projects, which the server has no selection for: the Board asks
      to choose a project */
  | { kind: 'choose' }
  /** a text filter past LIMITS.search, which the server refuses */
  | { kind: 'search_limit' }
  /** the arguments, as their key (JSON in a fixed key order) */
  | { kind: 'ask'; key: string }

/**
 * The Board's request for the selection `info` and `filters` (boardFilters
 * applied) in `variant`, with `cutoff` (staleCutoff) as stale_before while
 * Stale is on and `search` as the text to send, which the desktop's typing
 * delays. The people filter is sent deduplicated and sorted, as the server
 * matches each id exactly; the text trimmed, as the server trims it.
 */
export function boardRequest(
  info: Pick<ScopeInfo, 'wide' | 'mine' | 'id'> & { proj: { org: string } | null },
  filters: IssueFilters,
  cutoff: string,
  search: string = filters.search,
): BoardRequest {
  if (info.wide && !info.mine) return { kind: 'choose' }
  const text = search.trim()
  if (overLimit(LIMITS.search, text)) return { kind: 'search_limit' }
  const scope: BoardScope = info.mine
    ? { kind: 'mine' }
    : { kind: 'project', org_id: info.proj?.org ?? '', project_id: info.id }
  const priority = (ISSUE_PRIORITIES as readonly string[]).includes(filters.priority ?? '')
    ? (filters.priority as IssuePriority)
    : null
  const sent: BoardFilters = {
    mine: filters.mine,
    owners: [...new Set(filters.assignees)].sort(),
    priority,
    stale_before: filters.stale ? cutoff : null,
    focus: filters.focus,
    search: text,
  }
  return { kind: 'ask', key: JSON.stringify({ scope, filters: sent }) }
}

/** `value`, once it stayed the same for `ms`; '' at once. */
function useRested(value: string, ms: number): string {
  const [rested, setRested] = useState(value)
  useEffect(() => {
    if (value === '') {
      setRested('')
      return
    }
    const timer = setTimeout(() => setRested(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value === '' ? '' : rested
}

/** The Stale cutoff (staleCutoff) now: taken again each hour, whenever
    the tab shows again and whenever a kept page (components/KeptView)
    shows again, whose hidden effects stopped the hourly timer. */
function useStaleCutoff(): string {
  const { shownAt } = useViewVisibility()
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    const now = Date.now()
    if (staleCutoff(now) !== staleCutoff(tick)) {
      setTick(now)
      return
    }
    const timer = setTimeout(() => setTick(Date.now()), HOUR - (now % HOUR) + 1000)
    return () => clearTimeout(timer)
  }, [tick])
  return staleCutoff(Math.max(tick, shownAt))
}

/**
 * The Board's requests for the selection `info` with the filter row
 * `filters` (boardFilters applied): `want` for the filters on screen, whose
 * answer alone counts, and `send` with the text filter once typing rests
 * (BOARD_SEARCH_DELAY_MS), which the Board subscribes to. A text filter past
 * LIMITS.search sends nothing.
 */
export function useBoardRequest(
  info: Pick<ScopeInfo, 'wide' | 'mine' | 'id'> & { proj: { org: string } | null },
  filters: IssueFilters,
): { want: BoardRequest; send: BoardRequest } {
  const cutoff = useStaleCutoff()
  const rested = useRested(filters.search.trim(), BOARD_SEARCH_DELAY_MS)
  const want = boardRequest(info, filters, cutoff)
  const send = want.kind === 'ask' ? boardRequest(info, filters, cutoff, rested) : want
  return { want, send }
}
