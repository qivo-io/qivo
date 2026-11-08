/* What the Overview asks the server (convex/overview.ts) for the scope on
   screen: the scope, and the client's day and weeks the figures are judged
   by. The store builds each query's arguments from them in a fixed key
   order (store/overviewLists.ts overviewArgs), so equal arguments share
   one subscription, and a new local day, a moved week grid or a new scope
   gives new ones. */

import type { OverviewScope } from '../../../convex/lib/overview'
import {
  OVERVIEW_WEEKS,
  type OverviewBase,
  type OverviewClock,
  overviewKey,
} from '../../store/overviewLists'
import { P, type ScopeInfo } from '../../store/planner'

/** The Overview's scope for `info`: My view, or a top-level project or one
    sub-project, as views/board/boardArgs.ts boardRequest builds the
    Board's. */
export function overviewScope(
  info: Pick<ScopeInfo, 'mine' | 'id'> & { proj: { org: string } | null },
): OverviewScope {
  if (info.mine) return { kind: 'mine' }
  return { kind: 'project', org_id: info.proj?.org ?? '', project_id: info.id }
}

/** The client's day and weeks on the store's timeline now: its day, the
    first day of its week, the instants its last OVERVIEW_WEEKS local weeks
    began at, this one last, and the instant the next one begins at
    (convex/lib/viewLoads.ts clockOf). The store's rebuild moves them at
    local midnight, after sleep and when the week grid moves. */
export function overviewClock(): OverviewClock {
  return {
    day: P.TODAY_ISO,
    week: P.isoFromDate(P.weekToDate(P.TODAY_WEEK)),
    week_starts: Array.from({ length: OVERVIEW_WEEKS }, (_, i) =>
      P.weekToDate(P.TODAY_WEEK - (OVERVIEW_WEEKS - 1) + i).getTime(),
    ),
    week_end: P.weekToDate(P.TODAY_WEEK + 1).getTime(),
  }
}

/** What the Overview of `info` asks for: the scope and the clock, and
    their key (store/overviewLists.ts overviewKey). */
export type OverviewRequest = { kind: 'ask'; base: OverviewBase; key: string }

/** The Overview's request for the scope `info`, on the clock now. */
export function overviewRequest(
  info: Pick<ScopeInfo, 'mine' | 'id'> & { proj: { org: string } | null },
): OverviewRequest {
  const scope = overviewScope(info)
  const base = { scope, clock: overviewClock() }
  return { kind: 'ask', base, key: overviewKey(base) }
}
