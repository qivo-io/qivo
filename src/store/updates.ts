/* The store's observable sections. `health` says whether the live snapshot is
   current (components/SnapshotNotice), so the notice can re-render without
   re-rendering every view. `inbox` carries the Inbox's own state, such as a
   bulk action's progress (P.inboxBulk), so it repaints the Inbox alone. */
const SECTIONS = ['workspace', 'comments', 'teamSync', 'health', 'inbox'] as const
export type PlannerSection = (typeof SECTIONS)[number]
export type StoreVersion = Readonly<{ revision: number }>
type Listener = () => void

export type UpdateChannel = Readonly<{
  subscribe: (listener: Listener) => () => void
  getSnapshot: () => StoreVersion
}>

/** Immutable tokens make the mutable planner facade safe to observe through
 * useSyncExternalStore. Publish every changed token before notifying readers.
 * A workspace emit changes every section; any other emit changes its own. */
export function createPlannerUpdates() {
  let revision = 0
  const listeners: Record<PlannerSection, Set<Listener>> = {
    workspace: new Set(),
    comments: new Set(),
    teamSync: new Set(),
    health: new Set(),
    inbox: new Set(),
  }
  const legacy = new Set<Listener>()
  const initial = Object.freeze({ revision })
  const versions: Record<PlannerSection, StoreVersion> = {
    workspace: initial,
    comments: initial,
    teamSync: initial,
    health: initial,
    inbox: initial,
  }
  const subscribe = (list: Set<Listener>, listener: Listener) => {
    list.add(listener)
    return () => {
      list.delete(listener)
    }
  }
  const channel = (section: PlannerSection): UpdateChannel =>
    Object.freeze({
      subscribe: (listener: Listener) => subscribe(listeners[section], listener),
      getSnapshot: () => versions[section],
    })
  const channels = Object.freeze({
    workspace: channel('workspace'),
    comments: channel('comments'),
    teamSync: channel('teamSync'),
    health: channel('health'),
    inbox: channel('inbox'),
  })
  return {
    channels,
    subscribe: (listener: Listener) => subscribe(legacy, listener),
    emit(section: PlannerSection = 'workspace') {
      const changed = section === 'workspace' ? SECTIONS : [section]
      const version = Object.freeze({ revision: ++revision })
      const notify = new Set(legacy)
      for (const part of changed) {
        versions[part] = version
        for (const listener of listeners[part]) notify.add(listener)
      }
      for (const listener of notify) {
        try {
          listener()
        } catch {
          // One observer must not prevent the remaining views from updating.
        }
      }
    },
  }
}
