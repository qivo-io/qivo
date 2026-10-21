import { useSyncExternalStore } from 'react'

/** The drag data type a Board card's drag carries, holding the task's id.
    The Board accepts only drags that carry it. */
export const BOARD_TASK_TYPE = 'application/x-qivo-board-task'

/** The key of the one Board cell a drag would drop into, or null. Cells
    subscribe to their own key, so a drag moving between cells renders only
    the cell it left and the cell it entered, never the Board or its cards. */
export function createDropOver() {
  let current: string | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(key: string | null) {
      if (key === current) return
      current = key
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type DropOver = ReturnType<typeof createDropOver>

/** Whether the drag is over the cell `key` of `store`. */
export function useDropOver(store: DropOver, key: string) {
  return useSyncExternalStore(store.subscribe, () => store.get() === key)
}
