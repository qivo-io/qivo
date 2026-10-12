/* lib/projectKeys.ts — the key rule the browser previews and projects.create
 * applies. */

import { describe, expect, it } from 'vitest'
import { PROJECT_KEY_SHAPE, projectKeyBase, projectKeyCandidate } from '../lib/projectKeys'

describe('projectKeyBase', () => {
  it('takes three characters of one word, else up to four initials', () => {
    expect(projectKeyBase('Test')).toBe('TES')
    expect(projectKeyBase('  testing  ')).toBe('TES')
    expect(projectKeyBase('Mobile App')).toBe('MA')
    expect(projectKeyBase('one two three four five')).toBe('OTTF')
    expect(projectKeyBase('Q3 launch')).toBe('QL')
  })

  it('ignores characters a key cannot hold and falls back to P', () => {
    expect(projectKeyBase('Test!')).toBe('TES')
    expect(projectKeyBase('Ärende')).toBe('REN')
    expect(projectKeyBase('!!! ???')).toBe('P')
    expect(projectKeyBase('')).toBe('P')
  })
})

describe('projectKeyCandidate', () => {
  it('starts with the base, then shortens it to fit the number', () => {
    expect(projectKeyCandidate('TES', 1)).toBe('TES')
    expect(projectKeyCandidate('TES', 2)).toBe('TES2')
    expect(projectKeyCandidate('ABCD', 2)).toBe('ABCD2')
    expect(projectKeyCandidate('ABCD', 10)).toBe('ABC10')
    expect(projectKeyCandidate('TES', 100)).toBe('TE100')
  })

  it('stays a valid key through n = 9999', () => {
    for (const base of ['P', 'TES', 'ABCD']) {
      for (let n = 1; n <= 9999; n++) {
        expect(PROJECT_KEY_SHAPE.test(projectKeyCandidate(base, n))).toBe(true)
      }
    }
  })

  it('is distinct for every n of one base', () => {
    const seen = new Set(Array.from({ length: 9999 }, (_, i) => projectKeyCandidate('TES', i + 1)))
    expect(seen.size).toBe(9999)
  })
})

describe('PROJECT_KEY_SHAPE', () => {
  it('accepts 1-5 uppercase letters or digits only', () => {
    expect(PROJECT_KEY_SHAPE.test('A')).toBe(true)
    expect(PROJECT_KEY_SHAPE.test('TE100')).toBe(true)
    expect(PROJECT_KEY_SHAPE.test('')).toBe(false)
    expect(PROJECT_KEY_SHAPE.test('TES100')).toBe(false)
    expect(PROJECT_KEY_SHAPE.test('tes')).toBe(false)
    expect(PROJECT_KEY_SHAPE.test('TE-1')).toBe(false)
  })
})
