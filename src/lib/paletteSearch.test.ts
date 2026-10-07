import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createPaletteSearch } from './paletteSearch'

// Independent reference: the previous stable full-sort algorithm and scoring rule.
function score(label: string, query: string) {
  const normalized = label.toLowerCase()
  if (
    !query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((word) => normalized.includes(word))
  )
    return 0
  const phrase = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const index = normalized.indexOf(phrase)
  return index < 0 ? 0.25 : 1 - (index / Math.max(1, normalized.length)) * 0.5
}
const projects = [
  { id: 'meta', name: 'Firmware program', type: 'meta' },
  { id: 'sub', name: 'Firmware work', type: 'project', parent: 'meta' },
  { id: 'hidden', name: 'Private firmware', type: 'meta' },
]

describe('palette search', () => {
  it('matches stable full-sort rankings, ties, punctuation and Unicode', () => {
    const fragment = fc.constantFrom(
      'signed',
      'firmware',
      'FÄLT',
      'İ',
      '[tag]',
      '+',
      '',
      '  ',
      '\n',
      'QN-',
    )
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fragment, { maxLength: 6 }).map((parts) => parts.join(' ')),
          { maxLength: 250 },
        ),
        fc.array(fragment, { maxLength: 4 }).map((parts) => parts.join(' ')),
        (titles, query) => {
          const tasks = titles.map((title, index) => ({
            id: String(index),
            key: `QN-${index + 1}`,
            title,
            project: index % 7 ? 'sub' : 'hidden',
          }))
          const result = createPaletteSearch(projects, tasks, (id) => id !== 'hidden')(query)
          const expected = query.trim()
            ? tasks
                .filter((task) => task.project === 'sub')
                .map((issue) => ({ issue, score: score(`${issue.key} ${issue.title}`, query) }))
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 9)
            : []
          expect(result.issues).toEqual(expected)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('rebuilds for renames, deleted tasks and revoked project access', () => {
    const task = { id: 'a', key: 'QN-1', title: 'firmware', project: 'sub' }
    expect(createPaletteSearch(projects, [task], () => true)('firm').issues).toHaveLength(1)
    expect(
      createPaletteSearch(projects, [{ ...task, title: 'hardware' }], () => true)('firm').issues,
    ).toHaveLength(0)
    expect(createPaletteSearch(projects, [], () => true)('firm').issues).toHaveLength(0)
    expect(createPaletteSearch(projects, [task], () => false)('firm')).toEqual({
      projects: [],
      issues: [],
    })
  })

  it('retains all matching projects and returns no suggestions for whitespace', () => {
    const search = createPaletteSearch(projects, [], (id) => id !== 'hidden')
    expect(search('firm').projects.map((item) => item.project.id)).toEqual(['meta', 'sub'])
    expect(search(' \t ')).toEqual({ projects: [], issues: [] })
  })
})
