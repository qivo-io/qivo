import { matchesAllWords, taskSearchText } from '../../convex/lib/search'

export { matchesAllWords, taskSearchText }

/** cmdk values can be opaque IDs; its visible names arrive as keywords. */
export function commandSearchFilter(value: string, query: string, keywords: string[] = []): number {
  return Number(matchesAllWords([value, ...keywords].join('\n'), query))
}
