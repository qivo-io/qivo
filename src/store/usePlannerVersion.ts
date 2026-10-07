import { useSyncExternalStore } from 'react'
import { P } from './planner'
import type { PlannerSection } from './updates'

/** Subscribe to one view's data; full workspace changes also reach each view. */
export function usePlannerVersion(section: PlannerSection = 'workspace') {
  const channel = P.updates[section]
  return useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot)
}
