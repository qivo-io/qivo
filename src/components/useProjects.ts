/* Names the projects a component shows with the store's project cache
   (store/planner.ts P.nameProjects), for a reader outside the view slots
   and the task window, which name theirs in the store: the sidebar's open
   row menu and expanded parents, the Milestones window's project, Team
   sync's scope trigger and notes, the Move window's chosen target, a
   project's Settings page and the plan panel's items. It names them while
   the component is mounted and the page shows (lib/viewVisibility.ts), so a
   kept page hidden by Activity releases them and names them again on show,
   as usePeople does. The cache reads them by id and every lookup of them
   answers from it. It answers a Retry for the projects it names, which
   reads them again where the cache's read failed or was not checked. */

import { useCallback, useEffect, useState } from 'react'
import { useViewVisibility } from '../lib/viewVisibility'
import { P } from '../store/planner'

/* Tells each mounted host's owner key apart. */
let hosts = 0

/** Names `ids` (empty and missing ones skipped, each once) with the project
    cache while the component is mounted and the page shows, and answers
    the Retry of those projects (P.retryProjects), which does nothing while
    it names none. */
export function useProjects(ids: readonly (string | null | undefined)[]): () => void {
  const [owner] = useState(() => `useProjects:${++hosts}`)
  const { visible } = useViewVisibility()
  const key = [...new Set(ids.filter((id): id is string => !!id))].join('\n')
  useEffect(() => {
    if (!visible || key === '') return
    P.nameProjects(owner, key.split('\n'))
    return () => P.nameProjects(owner, [])
  }, [owner, key, visible])
  return useCallback(() => P.retryProjects(owner), [owner])
}
