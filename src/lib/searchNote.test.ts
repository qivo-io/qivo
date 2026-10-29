import { describe, expect, it } from 'vitest'
import { MIGHT_BE_MISSING, type SearchCoverage, searchNote } from './searchNote'

/* What the Search palette says about a page (searchNote): one case for each
   line, and never "No results" for a search that did not cover everything
   or a page that more follow. */

const COMPLETE: SearchCoverage = { complete: true }
const stopped = (
  why: 'projects' | 'reads' | 'candidates' | 'organizations',
  searched = 1,
  of = 1,
): SearchCoverage => ({ complete: false, stopped: why, searched, of })
const EMPTY_PAGE = 'Nothing on this page can still be shown. Next goes on with the search.'
const LEFT_OUT = 'Some organizations were not searched. Choose an organization to search in.'
const BOTH =
  'Some results might be missing, and some organizations were not searched. Choose a project or an organization to search in.'

describe('searchNote', () => {
  it('says no results only for a complete search with no rows and no next page', () => {
    expect(searchNote('firmware', { rows: 0, next: null, coverage: COMPLETE })).toEqual({
      lines: ['No results for “firmware”'],
      offer: null,
    })
  })

  it('says nothing for a complete page with rows, with or without a next page', () => {
    for (const next of [null, 's1~next'])
      expect(searchNote('firmware', { rows: 3, next, coverage: COMPLETE })).toEqual({
        lines: [],
        offer: null,
      })
  })

  it('says that Next goes on for a page with no rows that more follow', () => {
    expect(searchNote('firmware', { rows: 0, next: 's1~next', coverage: COMPLETE })).toEqual({
      lines: [EMPTY_PAGE],
      offer: null,
    })
  })

  it('says results might be missing, and offers a project, for every stop in what it searched', () => {
    for (const why of ['projects', 'reads', 'candidates'] as const) {
      for (const rows of [0, 4])
        expect(searchNote('the', { rows, next: null, coverage: stopped(why) }), why).toEqual({
          lines: [MIGHT_BE_MISSING],
          offer: 'Choose a project',
        })
      expect(searchNote('the', { rows: 0, next: 's1~next', coverage: stopped(why) })).toEqual({
        lines: [MIGHT_BE_MISSING, EMPTY_PAGE],
        offer: 'Choose a project',
      })
    }
  })

  it('says organizations were not searched, and offers one, when seats were left out', () => {
    expect(
      searchNote('the', { rows: 0, next: null, coverage: stopped('organizations', 2, 3) }),
    ).toEqual({ lines: [LEFT_OUT], offer: 'Choose an organization' })
    expect(searchNote('the', { rows: 2, next: null, coverage: stopped('reads', 1, 3) })).toEqual({
      lines: [BOTH],
      offer: 'Choose a project',
    })
  })

  it('never says no results for a search that did not cover everything or a page more follow', () => {
    const cases: { rows: number; next: string | null; coverage: SearchCoverage }[] = [
      { rows: 0, next: null, coverage: stopped('projects') },
      { rows: 0, next: null, coverage: stopped('reads') },
      { rows: 0, next: null, coverage: stopped('candidates') },
      { rows: 0, next: null, coverage: stopped('organizations', 1, 2) },
      { rows: 0, next: 's1~next', coverage: COMPLETE },
    ]
    for (const page of cases)
      expect(searchNote('the', page).lines.join(' '), JSON.stringify(page)).not.toMatch(
        /no results/i,
      )
  })
})
