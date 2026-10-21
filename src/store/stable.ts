/* Identity for unchanged view models. rebuild() shapes every view model again
   from the rows, and a view that compares by identity (React.memo) would
   then render everything again. These helpers hand back the previous object
   when the new one holds the same data, so a memoized view skips exactly
   what did not change. */

/** Whether `a` and `b` hold the same data: plain objects and arrays compared
    member by member, Maps and Sets entry by entry, Dates by time, and
    everything else with Object.is. An object member set to undefined counts
    as absent. */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((item, i) => sameData(item, other[i]))
  }
  if (a instanceof Date) return a.getTime() === (b as Date).getTime()
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>
    if (a.size !== other.size) return false
    for (const [key, value] of a) {
      if (!other.has(key) || !sameData(value, other.get(key))) return false
    }
    return true
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>
    return a.size === other.size && [...a].every((item) => other.has(item))
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const key in x) if (!sameData(x[key], y[key])) return false
  for (const key in y) if (!(key in x) && y[key] !== undefined) return false
  return true
}

/** `prev` when it holds the same data as `next`, else `next`. */
export function keep<T>(prev: T, next: T): T {
  return sameData(prev, next) ? prev : next
}

/** `next` with each item that holds the same data as the item of the same
    id in `prev` replaced by that item, and `prev` itself when every item and
    the order stayed. */
export function keepItems<T extends { id: string }>(prev: readonly T[], next: T[]): T[] {
  const before = new Map(prev.map((item) => [item.id, item]))
  let same = prev.length === next.length
  const kept = next.map((item, i) => {
    const old = before.get(item.id)
    const reused = old !== undefined && sameData(old, item) ? old : item
    if (reused !== prev[i]) same = false
    return reused
  })
  return same ? (prev as T[]) : kept
}
