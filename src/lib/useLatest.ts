import { useCallback, useLayoutEffect, useRef } from 'react'

/** A function that keeps its identity for the component's lifetime and
    calls the `fn` of the latest committed render. Hand it to memoized
    children in place of a callback that changes every render, such as one
    from a parent's actions object. */
export function useLatest<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  return useCallback((...args: A) => latest.current(...args), [])
}
