/* Convex refuses a function result that holds an array of more than 8,192
 * values, so the snapshot (convex/snapshot.ts forMe) of an organization with
 * more tasks, or any other list past that, failed for every member. The
 * snapshot sends its long lists through chunkLists and the app joins them
 * back with joinLists. No imports, so the app can import this file as it
 * does textLimits.ts. */

/** The most values one array in a function result may hold. A mutable
 * object, so tests can lower it. */
export const ARRAY_LIMIT = { max: 8192 }

/** The lists past their first ARRAY_LIMIT.max values, in arrays of at most
 * that many, by list name. */
export type MoreRows<L extends Record<string, unknown[]>> = { [K in keyof L]?: L[K][] }

/**
 * `lists` with each list cut to its first ARRAY_LIMIT.max values, and
 * `more` holding the rest of each longer list in arrays of at most that
 * many. `more` is absent while every list fits, so the result is then the
 * lists as they were. App builds from before `more` read only the first
 * part of a longer list.
 */
export function chunkLists<L extends Record<string, unknown[]>>(
  lists: L,
): L & { more?: MoreRows<L> } {
  const { max } = ARRAY_LIMIT
  const heads: Record<string, unknown[]> = {}
  const more: Record<string, unknown[][]> = {}
  for (const [name, rows] of Object.entries(lists)) {
    if (rows.length <= max) {
      heads[name] = rows
      continue
    }
    heads[name] = rows.slice(0, max)
    const rest: unknown[][] = []
    for (let from = max; from < rows.length; from += max) rest.push(rows.slice(from, from + max))
    more[name] = rest
  }
  const out = Object.keys(more).length === 0 ? heads : { ...heads, more }
  return out as L & { more?: MoreRows<L> }
}

/** `result` with the rows chunkLists moved to `more` joined back onto their
 * lists, in order, and `more` dropped. */
export function joinLists<R extends { more?: Record<string, unknown[][] | undefined> }>(
  result: R,
): Omit<R, 'more'> {
  const { more, ...rest } = result
  if (more === undefined) return rest
  const lists: Record<string, unknown> = rest
  for (const [name, chunks] of Object.entries(more)) {
    const head = lists[name]
    if (chunks === undefined || !Array.isArray(head)) continue
    lists[name] = head.concat(...chunks)
  }
  return rest
}
