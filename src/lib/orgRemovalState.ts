import type { FunctionReturnType } from 'convex/server'
import { api } from '../../convex/_generated/api'
import { useKeptLiveView } from './liveView'

export type OrgRemovalState = FunctionReturnType<typeof api.orgRemovals.state>

/** The admin's view of the organization's last export and pending
 * deletion, with whether it is refreshing. Organization › General's
 * export and deletion sections read it, sharing one live subscription, and
 * it pauses while the tab or window is hidden, as the page's other reads
 * do (lib/viewVisibility.ts). On return it shows its last answer, marked
 * refreshing, until the new one arrives. The irreversible actions stay
 * safe because orgRemovals.request checks the typed address against the
 * server's own slug. A failure shows nothing, as a missing answer does. */
export function useOrgRemovalState(orgId: string): {
  state: OrgRemovalState | null
  refreshing: boolean
} {
  const read = useKeptLiveView<OrgRemovalState>(
    api.orgRemovals.state,
    orgId ? JSON.stringify({ org_id: orgId }) : null,
  )
  const shown = read.state === 'ok' || read.state === 'refreshing'
  return { state: shown ? read.value : null, refreshing: read.state === 'refreshing' }
}
