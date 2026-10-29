import { matchesAllWords, taskSearchText } from '../../convex/lib/search'

export { matchesAllWords, taskSearchText }

/** cmdk values can be opaque IDs; its visible names arrive as keywords. */
export function commandSearchFilter(value: string, query: string, keywords: string[] = []): number {
  return Number(matchesAllWords([value, ...keywords].join('\n'), query))
}

/** The line under a short list cut to its first matches, for the `more`
 * matches it leaves out (the mention and task pickers). */
export const moreMatches = (more: number): string =>
  `+${more.toLocaleString('en-US')} more, keep typing`
