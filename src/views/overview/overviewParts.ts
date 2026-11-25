/* The parts both Overview pages share (views/Overview.tsx for My view,
   views/overview/ProjectOverview.tsx for a project or sub-project): the
   figures as a page shows them, where a figure that does not fit one
   request can still be read, the actions the page calls, its states, and
   the hook that registers its reads with the store. A section's frame is
   views/overview/OvSection.tsx. */

import { useEffect, useState } from 'react'
import { useViewVisibility } from '@/lib/viewVisibility'
import type {
  FigureView,
  HealthTable,
  ListView,
  NeedsAsk,
  OverviewPage,
  OverviewView,
} from '@/store/overviewLists'
import type { Figure, Missing } from '../../../convex/lib/overview'
import { P, type ScopeInfo } from '../../store/planner'
import { useViewsNews } from '../useViewsNews'
import { overviewRequest } from './overviewArgs'

/* ═══ The figures as the page shows them ════════════════════════════════════
   Each figure is on its way, kept from before and refreshing, given,
   counting, unavailable for a reason, or failed. A figure that is not
   given never shows a number, so a count the server could not read whole
   never reads as a smaller one or as zero. */

/** What a figure's element says of its state (data-ov-figure-state). */
export type FigureState = 'loading' | 'refreshing' | 'ok' | 'counting' | 'unavailable' | 'error'

/** A figure as the page shows it. `scope` is a refusal of the read's whole
    scope, which only the figure shows where the read is not the summary. */
export type Shown<T> =
  | { state: 'loading' | 'error' | 'counting' }
  | { state: 'ok' | 'refreshing'; value: T }
  | { state: 'unavailable'; reason: Exclude<Missing, 'counting'> | 'scope' }

/** The figure `pick` takes from read `read`'s ok answer, as the page shows
    it: refreshing where the answer was kept, not current. */
export function shownOf<A extends { state: string }, F extends object>(
  read: FigureView<A>,
  pick: (ok: Extract<A, { state: 'ok' }>) => Figure<F>,
): Shown<F> {
  if (read === null) return { state: 'loading' }
  if (read.error !== undefined) return { state: 'error' }
  const answer = read.value as A
  if (answer.state !== 'ok') return { state: 'unavailable', reason: 'scope' }
  const figure = pick(answer as Extract<A, { state: 'ok' }>)
  if (figure.state === 'ok') return { state: read.current ? 'ok' : 'refreshing', value: figure }
  if (figure.reason === 'counting') return { state: 'counting' }
  return { state: 'unavailable', reason: figure.reason }
}

/** The value of `figure` where it is given, else null. */
export const given = <T>(figure: Shown<T>): T | null =>
  figure.state === 'ok' || figure.state === 'refreshing' ? figure.value : null

/** The data attributes of figure `name` in `figure`'s state. */
export const figureAttrs = (name: string, figure: Shown<unknown>) => ({
  'data-ov-figure': name,
  'data-ov-figure-state': figure.state satisfies FigureState,
  ...(figure.state === 'unavailable' && figure.reason !== 'scope'
    ? { 'data-ov-reason': figure.reason }
    : {}),
})

/** What a figure cell shows where no number is given: "…" on its way,
    "Counting…" while the counts are not whole, and the dash the page uses
    for a missing value otherwise. */
export const placeholder = (figure: Shown<unknown>) =>
  figure.state === 'loading' ? '…' : figure.state === 'counting' ? 'Counting…' : '—'

/** Where a figure that does not fit one request can still be read: a
    top-level project's sub-projects, My view's projects. */
export const narrower = (info: ScopeInfo) =>
  info.isMeta
    ? ' Open a sub-project to see its figures.'
    : info.mine
      ? ' Open a project to see its figures.'
      : ''

/** Whether every seat of the login that `info` reads is a guest's or an
    organization Viewer's, whose reads see other people's work one person
    at a time (convex/lib/viewLoads.ts verdicts). */
export function onePersonAtATime(info: ScopeInfo): boolean {
  const seats = P.myProfileIds.map((id) => P.user(id)).filter((u) => !!u)
  const read = info.mine ? seats : seats.filter((u) => u.org === info.proj?.org)
  return read.length > 0 && read.every((u) => u.orgRole !== 'admin' && u.orgRole !== 'user')
}

/* the slice of the app's action surface this view calls */
export type OverviewActions = {
  setScope: (id: string) => void
  setView: (view: string) => void
  openIssue: (id: string) => void
  newIssue: (init: { project?: string }) => void
  newProject: (init: { parent?: string; kind?: 'program' }) => void
  newMilestone: (init: { week?: number }) => void
  /** `focusAfterClose` is what takes focus as the Milestones window closes */
  editMilestone: (id: string, focusAfterClose?: () => HTMLElement | null, project?: string) => void
  /** opens Search, on the project `searchIn` names */
  openPalette?: (searchIn?: unknown) => void
}

/** Where the Overview stands, as its root's data-overview-state names it. */
export type OverviewState =
  /** no answer of the summary for these arguments yet */
  | 'loading'
  /** the answers kept for these arguments while the reads stopped, or
      before they arrived again after a reconnect */
  | 'refreshing'
  | 'ok'
  | 'unavailable'
  | 'over_budget'
  /** the summary failed */
  | 'error'

/* How many Overviews mounted, each one's read owner (P.watchOverview). */
let overviewReaders = 0

/** The Overview's reads for `info`, which the page registers with the store
    while it and the tab show, with Try again: for `page` 'classic' (My
    view) the summary, the delays and the two lists, for 'status' (a
    project or sub-project) the summary; its health table `table` (null for
    none) and, on 'status', the kind of the Needs attention list `needs`,
    each registered apart so a new sort, search, kind or Load more asks its
    read alone; the store's answers for the arguments on screen. Renders
    again on the store's `views` news. */
export function useOverviewRead(
  info: ScopeInfo,
  table: HealthTable | null,
  needs: NeedsAsk | null = null,
  page: OverviewPage = 'classic',
) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useState(0)
  // this mounted page, which owns the reads while it asks
  const [owner] = useState(() => ++overviewReaders)
  useViewsNews()
  const request = overviewRequest(info)
  const key = request.key
  const ask = visible ? key : null
  useEffect(() => {
    P.watchOverview(ask, owner, attempt, page)
    return () => P.watchOverview(null, owner, attempt, page)
  }, [ask, owner, attempt, page])
  /* The table and the Needs attention list's kind, registered again after
     each registration of the scope's reads. The store takes them only from
     the page that owns the reads, and a page that mounts while hidden, or
     on a day the store has not reached yet, owns them only once it asks for
     a key. Unchanged ones ask nothing again, so a return keeps the rows
     loaded. Their reads stop with the scope's. */
  const sort = table?.sort
  const dir = table?.dir
  const search = table?.search
  useEffect(() => {
    P.watchOverviewTable(
      sort === undefined || dir === undefined || search === undefined
        ? null
        : { sort, dir, search },
      owner,
    )
  }, [sort, dir, search, owner, ask])
  const kind = needs?.kind
  useEffect(() => {
    P.watchOverviewNeeds(kind === undefined ? null : { kind }, owner)
  }, [kind, owner, ask])
  const view: OverviewView = P.overviewRead()
  // answers count only for the arguments on screen
  const mine = key !== null && view.key === key
  return {
    request,
    view,
    visible,
    summary: mine ? view.summary : null,
    risk: mine ? view.risk : null,
    lists: mine ? { attention: view.attention, paused: view.paused } : null,
    health: mine ? view.health : null,
    needs: mine ? view.needs : null,
    retry: () => setAttempt((n) => n + 1),
  }
}

/** A list before any answer for the arguments on screen. */
export const WAITING: ListView = {
  state: 'loading',
  batches: [],
  dropped: false,
  end: false,
  more: null,
  failed: false,
  reads: 0,
}
