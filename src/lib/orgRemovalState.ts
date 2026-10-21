import type { FunctionReturnType } from 'convex/server'
import { useEffect, useState } from 'react'
import { api } from '../../convex/_generated/api'
import { convex } from './convex'

export type OrgRemovalState = FunctionReturnType<typeof api.orgRemovals.state>

/** The admin's view of the organization's last export and pending deletion. */
export function useOrgRemovalState(orgId: string): OrgRemovalState | null {
  const [state, setState] = useState<OrgRemovalState | null>(null)
  useEffect(() => {
    if (!orgId) return
    return convex.onUpdate(api.orgRemovals.state, { org_id: orgId }, setState, () => setState(null))
  }, [orgId])
  return state
}
