import { describe, expect, it } from 'vitest'
import { commandSearchFilter, matchesAllWords, searchScore } from './search'

const HAY = ['QN-20', 'C-to-C 240W cable spec', 'To Do', 'Medium', 'Anna Fält'].join('\n')

describe('matchesAllWords', () => {
  it('empty and whitespace-only queries match anything', () => {
    expect(matchesAllWords(HAY, '')).toBe(true)
    expect(matchesAllWords(HAY, '   ')).toBe(true)
    expect(matchesAllWords('', '')).toBe(true)
  })

  it('every word must land somewhere — each on any field', () => {
    expect(matchesAllWords(HAY, 'to do cable')).toBe(true) // status + title
    expect(matchesAllWords(HAY, 'anna cable')).toBe(true) // assignee + title
    expect(matchesAllWords(HAY, 'anna wireless')).toBe(false) // one word misses
  })

  it('is case-insensitive both ways', () => {
    expect(matchesAllWords(HAY, 'TO DO CABLE')).toBe(true)
    expect(matchesAllWords(HAY, 'qn-20')).toBe(true)
    expect(matchesAllWords('LOUD TITLE', 'loud')).toBe(true)
  })

  it('word order and repeated separators are irrelevant', () => {
    expect(matchesAllWords(HAY, 'cable do to')).toBe(true)
    expect(matchesAllWords(HAY, '  to \t do\n cable ')).toBe(true)
  })

  it('words are substrings, not whole-word matches', () => {
    expect(matchesAllWords(HAY, 'cab 240')).toBe(true)
    expect(matchesAllWords(HAY, 'spec')).toBe(true)
  })

  it('a single miss fails regardless of the other words', () => {
    expect(matchesAllWords(HAY, 'cable zzz')).toBe(false)
    expect(matchesAllWords('', 'x')).toBe(false)
  })

  it('handles non-ASCII text', () => {
    expect(matchesAllWords(HAY, 'fält')).toBe(true)
    expect(matchesAllWords(HAY, 'FÄLT cable')).toBe(true)
  })

  it.each(['signed firm', 'upd firm', 'add back', 'add rollback', 'and add sign'])(
    'finds the firmware task with "%s"',
    (query) => {
      const task = 'QN-14 Add signed firmware updates and rollback'
      expect(matchesAllWords(task, query)).toBe(true)
      expect(searchScore(task, query)).toBeGreaterThan(0)
    },
  )

  it('keeps literal punctuation and requires contiguous fragments', () => {
    expect(matchesAllWords('Add signed firmware', 'adf')).toBe(false)
    expect(matchesAllWords('Add signed firmware', 'add*firm')).toBe(false)
    expect(matchesAllWords('Literal [tag] + (name)', '(name) [ta')).toBe(true)
  })
})

describe('searchScore', () => {
  it('ranks phrase matches before reordered matches and excludes a missing fragment', () => {
    expect(searchScore('signed firmware', 'signed firm')).toBeGreaterThan(
      searchScore('firmware signed', 'signed firm'),
    )
    expect(searchScore('signed firmware', 'signed mobile')).toBe(0)
    expect(searchScore('signed firmware', 'snfrm')).toBe(0)
  })
})

describe('commandSearchFilter', () => {
  it('matches fragments across the visible name and creator of an opaque-valued image', () => {
    const keywords = ['Alpine mountain lake', 'Anna Fält']
    expect(commandSearchFilter('image-uuid', 'fält mount', keywords)).toBe(1)
    expect(commandSearchFilter('image-uuid', '  ALP\tann ', keywords)).toBe(1)
    expect(commandSearchFilter('image-uuid', 'mount beach', keywords)).toBe(0)
    expect(commandSearchFilter('No image assigned', 'assign no')).toBe(1)
  })
})
