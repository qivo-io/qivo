/* What Team sync asks the server (convex/teamSync.ts agenda) for the place
   on screen: the home organization, the scope and the client's day and
   weeks, as views/board/boardArgs.ts and views/overview/overviewArgs.ts
   build theirs, in a fixed key order (lib/teamSync.ts syncAgendaKey), so
   equal arguments share one subscription and a new local day, a moved
   week grid or a new scope gives new ones. The clock is the Overview's
   (overviewClock), which the parity test sends too. A place that names no
   scope, or a project an address names that the app cannot resolve, asks
   for nothing, and the page asks to choose. Nothing here checks whether a
   team or project is visible, live or of the home organization: the
   server decides, alike for every reason, and never answers another
   scope. */

import { agendaScopeOf, parseSyncScope, syncAgendaKey } from '../../lib/teamSync'
import { P } from '../../store/planner'
import { overviewClock } from '../overview/overviewArgs'

/** What Team sync asks for. */
export type SyncRequest =
  /** nothing to ask: no scope named (`none`), or an address's project the
      app cannot resolve (`unresolved`) */
  | { kind: 'choose'; why: 'none' | 'unresolved' }
  /** the agenda's arguments' key (lib/teamSync.ts syncAgendaKey) */
  | { kind: 'ask'; key: string }

/** Team sync's request for the scope key `scopeKey` (lib/teamSync.ts
    parseSyncScope), on the clock now. */
export function syncRequest(scopeKey: string): SyncRequest {
  const scope = parseSyncScope(scopeKey)
  if (scope.kind === 'none' || scope.kind === 'unresolved')
    return { kind: 'choose', why: scope.kind }
  return {
    kind: 'ask',
    key: syncAgendaKey({ org_id: P.homeOrg, scope: agendaScopeOf(scope), ...overviewClock() }),
  }
}
