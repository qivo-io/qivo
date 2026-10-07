import { describe, expect, it } from 'vitest'
import { nameInitials } from './initials'

/* Keep Unicode initials aligned with the server rule in model/orgs.ts. */
describe('nameInitials — Unicode avatar initials', () => {
  const cases: [string, string][] = [
    ['Erik Holm', 'EH'],
    ['anna fält', 'AF'],
    ['Åsa Öberg', 'ÅÖ'], // the fold has to be Unicode-aware
    ['Jean Luc Picard', 'JL'], // at most two, so the third word is dropped
    ['Testbench', 'T'], // one word gives one letter
    ['  spaced   out  ', 'SO'], // runs of whitespace are one separator
    ['Maya (guest)', 'MG'], // punctuation is skipped, not taken
    ['J. R. R. Tolkien', 'JR'],
    ['3M Company', '3C'], // a digit counts
    ['Мария Иванова', 'МИ'],
    ['日本 語', '日語'],
    ['(((', '?'], // nothing to abbreviate
    // Uppercasing can expand codepoints; truncate after case conversion.
    ['ßeta ßoy', 'SS'],
    ['ﬄip ﬄop', 'FF'],
    ['ßonly', 'SS'],
  ]
  for (const [name, want] of cases) {
    it(`${JSON.stringify(name)} → ${want}`, () => {
      expect(nameInitials(name)).toBe(want)
    })
  }

  it('always returns 1-3 characters accepted by the server', () => {
    for (const [name] of cases) {
      const n = [...nameInitials(name)].length
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(3)
    }
  })

  it('answers for an absent name rather than throwing', () => {
    expect(nameInitials('')).toBe('?')
    expect(nameInitials('   ')).toBe('?')
    expect(nameInitials(null)).toBe('?')
    expect(nameInitials(undefined)).toBe('?')
  })

  it('takes a whole codepoint, never half a surrogate pair', () => {
    // an astral first character must come back intact — [...x] iterates
    // codepoints where x[0] would return a lone high surrogate
    const got = nameInitials('𝐀lpha Beta')
    expect([...got].length).toBe(2)
    expect(got.startsWith('𝐀')).toBe(true)
  })
})
