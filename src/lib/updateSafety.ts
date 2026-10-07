import { useLayoutEffect } from 'react'

// Drafts and operations each own a lease. One editor finishing must never
// release another editor's draft or an overlapping save/upload.
const blockers = new Set<symbol>()
const listeners = new Set<() => void>()

export const isUpdateBlocked = () => blockers.size > 0
export function subscribeUpdateSafety(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function beginUpdateBlock() {
  const token = Symbol()
  blockers.add(token)
  for (const listener of listeners) listener()
  return () => {
    if (!blockers.delete(token)) return
    for (const listener of listeners) listener()
  }
}

export function useUpdateBlocker(blocked: boolean) {
  useLayoutEffect(() => {
    if (blocked) return beginUpdateBlock()
  }, [blocked])
}
