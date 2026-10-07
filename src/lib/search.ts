import { matchesAllWords } from '../../convex/lib/search'

export { matchesAllWords }

/** All fragments must match; a contiguous phrase ranks above reordered
 * fragments, with earlier phrase matches first. Zero means no match. */
export function searchScore(hay: string, query: string): number {
  return compileSearchScore(query)(hay.toLowerCase())
}

/** Compile once per query; callers can retain normalized labels between keystrokes. */
export function compileSearchScore(query: string): (normalized: string) => number {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const words = phrase ? phrase.split(' ') : []
  return (normalized) => {
    if (!words.every((word) => normalized.includes(word))) return 0
    const index = normalized.indexOf(phrase)
    return index < 0 ? 0.25 : 1 - (index / Math.max(1, normalized.length)) * 0.5
  }
}

/** cmdk values can be opaque IDs; its visible names arrive as keywords. */
export function commandSearchFilter(value: string, query: string, keywords: string[] = []): number {
  return Number(matchesAllWords([value, ...keywords].join('\n'), query))
}
