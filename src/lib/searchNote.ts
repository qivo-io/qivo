/* What main Search's palette (panels/Palette.tsx) says under its input
   about a page the server answered (search:page): no results, results
   that might be missing, organizations left out, or a page with nothing
   left to show while more follow. It never calls an unfinished search no
   results (the specification's main Search loading). */

/** How far a search covered what it was asked to, as search:page answers
    it (convex/lib/mainSearch.ts Coverage). */
export type SearchCoverage =
  | { complete: true }
  | {
      complete: false
      stopped: 'projects' | 'reads' | 'candidates' | 'organizations'
      searched: number
      of: number
    }

/** The lines the palette shows for a page, in order, and the label of the
    button that moves to its Search in choice, when the lines offer one. */
export type SearchNote = { lines: string[]; offer: string | null }

/** The owner's note for a search that may have missed matches in what it
    searched (owner decision, 2026-10-28). */
export const MIGHT_BE_MISSING = 'Some results might be missing. Choose a project to search in.'

/** The note for a search of a chosen project that may have missed
    matches: a narrower scope has nothing left to offer but more words. */
export const MIGHT_BE_MISSING_IN_PROJECT =
  'Some results might be missing. Add more words to narrow the search.'

/* A page that holds no rows while more follow: its matches no longer show,
   or its reads ran out before its first row. */
const EMPTY_PAGE = 'Nothing on this page can still be shown. Next goes on with the search.'

/**
 * What the palette says about the page of `text` it shows: its `rows`, its
 * next_cursor `next` and its coverage. A complete search with no rows and
 * no next page has no results; one whose budget, candidate cap or access
 * rule stopped it (`projects`, `reads`, `candidates`) might miss results,
 * with or without rows, and offers a project to search in, or, when the
 * search is of a chosen project (`inProject`), asks for more words; one that
 * left organizations out says so; and a page with no rows that a next page
 * follows says Next goes on. Nothing for a complete page with rows.
 */
export function searchNote(
  text: string,
  {
    rows,
    next,
    coverage,
    inProject = false,
  }: { rows: number; next: string | null; coverage: SearchCoverage; inProject?: boolean },
): SearchNote {
  if (!('stopped' in coverage)) {
    if (rows > 0) return { lines: [], offer: null }
    if (next === null) return { lines: [`No results for “${text}”`], offer: null }
    return { lines: [EMPTY_PAGE], offer: null }
  }
  const missing = coverage.stopped !== 'organizations'
  const left = coverage.searched < coverage.of
  if (missing && inProject) {
    const lines = [MIGHT_BE_MISSING_IN_PROJECT]
    if (rows === 0 && next !== null) lines.push(EMPTY_PAGE)
    return { lines, offer: null }
  }
  const lines = [
    missing && left
      ? 'Some results might be missing, and some organizations were not searched. Choose a project or an organization to search in.'
      : missing
        ? MIGHT_BE_MISSING
        : 'Some organizations were not searched. Choose an organization to search in.',
  ]
  if (rows === 0 && next !== null) lines.push(EMPTY_PAGE)
  return { lines, offer: missing ? 'Choose a project' : 'Choose an organization' }
}
