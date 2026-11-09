/* Convex refuses a function result that holds an array of more than 8,192
 * values. No Convex function sends such lists any more, since the workspace
 * parts that did went. chunkLists stays for the browser benchmark's perf
 * server alone (scripts/perf/server.mjs wireSnapshot), which sends a
 * baseline build's whole snapshot with its long lists in parts, as forMe
 * did. No imports, so the perf server's worker can load this file. */

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
