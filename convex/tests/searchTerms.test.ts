/* Main Search's words (lib/searchTerms.ts) and the text a description shows
 * (lib/md.ts readableText): how a search text becomes terms, which tasks
 * hold every term, and the order of the scores. lib/mainSearch.ts applies
 * them to the candidates Convex's search indexes return
 * (mainSearch.test.ts). */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { docArb, hostileString, RUNS } from '../../src/lib/md.arb'
import { astToMd } from '../../src/lib/mdSerialize'
import { hidesWords, readableText } from '../lib/md'
import {
  CONVEX_TERMS,
  convexTakesAll,
  convexText,
  matchesTerms,
  type SearchFields,
  scoreOf,
  searchTerms,
  wordsOf,
} from '../lib/searchTerms'

const UUID = '6f1c2a7e-1b2c-4d5e-8f90-123456789abc'

/** Whether a task with these fields holds every term of `text`. */
const finds = (text: string, fields: Partial<SearchFields>) =>
  matchesTerms(searchTerms(text), { title: '', description: '', ...fields })

/** The score of a task with these fields for `text`. */
const score = (text: string, fields: Partial<SearchFields>) =>
  scoreOf(searchTerms(text), { title: '', description: '', ...fields })

describe('searchTerms', () => {
  it('splits a text into words at every character that is no letter or digit', () => {
    expect(searchTerms("Torque-sensor calibration's v2_fix")).toEqual([
      { word: 'torque', text: 'Torque', prefix: false },
      { word: 'sensor', text: 'sensor', prefix: false },
      { word: 'calibration', text: 'calibration', prefix: false },
      { word: 's', text: 's', prefix: false },
      { word: 'v2', text: 'v2', prefix: false },
      { word: 'fix', text: 'fix', prefix: true },
    ])
  })

  it('keeps each term once, in the order it first appears, the last as a prefix', () => {
    expect(searchTerms('sensor torque Sensor').map((t) => [t.word, t.prefix])).toEqual([
      ['sensor', false],
      ['torque', true],
    ])
    expect(searchTerms('Räksmörgås').map((t) => t.word)).toEqual(['räksmörgås'])
  })

  it('reads a whitespace piece that is a task reference as one reference term', () => {
    expect(searchTerms('QN-482 sensor')).toEqual([
      { word: '482', text: '482', num: 482, prefix: false },
      { word: 'sensor', text: 'sensor', prefix: true },
    ])
    expect(searchTerms('qn-12')).toEqual([{ word: '12', text: '12', num: 12, prefix: true }])
    expect(searchTerms('12')).toEqual([{ word: '12', text: '12', num: 12, prefix: true }])
    // a number no task has still finds a word equal to its digits
    expect(searchTerms('QN-0')).toEqual([{ word: '0', text: '0', num: null, prefix: true }])
    expect(searchTerms('99999999999')[0].num).toBeNull()
    // not references: a piece with more than the reference
    expect(searchTerms('#12')).toEqual([{ word: '12', text: '12', prefix: true }])
    expect(searchTerms('QN-12a').map((t) => t.word)).toEqual(['qn', '12a'])
    expect(searchTerms('QN12').map((t) => t.word)).toEqual(['qn12'])
  })

  it('sends Convex each term as the text wrote it, which Convex cuts as it cut the task', () => {
    // the capital dotted I lowercases to i and a combining dot, at which
    // Convex would cut a lowercased term in two
    expect(searchTerms('İstanbul')).toEqual([
      { word: 'i\u0307stanbul', text: 'İstanbul', prefix: true },
    ])
    expect(convexText(searchTerms('İstanbul ΟΔΟΣ'))).toBe('İstanbul ΟΔΟΣ')
    // each word is cut first and lowercased then, so a final sigma stays final
    expect(searchTerms("ΟΔΟΣ'Α").map((t) => t.word)).toEqual(['οδος', 'α'])
  })

  it('has no terms for a blank text or one of punctuation only', () => {
    expect(searchTerms('')).toEqual([])
    expect(searchTerms('   ')).toEqual([])
    expect(searchTerms('-- !! ...')).toEqual([])
  })

  it('leaves out words Convex does not index, of 32 bytes or more', () => {
    const long = 'supercalifragilisticexpialidocious' // 34 bytes
    expect(searchTerms(`${long} report`)).toEqual([
      { word: 'report', text: 'report', prefix: true },
    ])
    expect(searchTerms('x'.repeat(31)).map((t) => t.word)).toEqual(['x'.repeat(31)])
    // 16 two-byte letters are 32 bytes
    expect(searchTerms('ä'.repeat(16))).toEqual([])
    expect(searchTerms('ä'.repeat(15))).toHaveLength(1)
  })

  it('passes Convex at most CONVEX_TERMS terms', () => {
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    expect(searchTerms(many)).toHaveLength(20)
    expect(convexText(searchTerms(many)).split(' ')).toHaveLength(CONVEX_TERMS)
    expect(convexText(searchTerms('QN-12 torque sen'))).toBe('12 torque sen')
    // references go first, so Convex's prefix term is a word, never digits
    expect(convexText(searchTerms('torque QN-12'))).toBe('12 torque')
    // with references only, a word no text holds goes last as the prefix
    const [twelve, last, ...more] = convexText(searchTerms('QN-12')).split(' ')
    expect([twelve, more]).toEqual(['12', []])
    expect(searchTerms(last)).toEqual([{ word: last, text: last, prefix: true }])
    expect(convexTakesAll(searchTerms(many))).toBe(false)
    expect(convexTakesAll(searchTerms('torque sen'))).toBe(true)
  })
})

describe('matchesTerms', () => {
  it('finds a task by its number, as QN-12 and as 12', () => {
    expect(finds('QN-12', { num: 12, title: 'Calibrate' })).toBe(true)
    expect(finds('12', { num: 12, title: 'Calibrate' })).toBe(true)
    expect(finds('QN-13', { num: 12, title: 'Calibrate' })).toBe(false)
  })

  it('finds a reference as a word equal to its digits, never as a prefix', () => {
    expect(finds('12', { num: 7, title: 'Rev 12 board' })).toBe(true)
    expect(finds('12', { num: 7, description: 'see rev 12.' })).toBe(true)
    expect(finds('12', { num: 7, title: 'Rev 120 board' })).toBe(false)
  })

  it('finds every term in the title, the description or split across both', () => {
    const task = { title: 'Calibrate the torque sensor', description: 'Bench rig in lab B.' }
    expect(finds('torque', task)).toBe(true)
    expect(finds('bench', task)).toBe(true)
    expect(finds('torque bench', task)).toBe(true)
    expect(finds('TORQUE Sensor', task)).toBe(true)
    // one term that matches nothing excludes the task
    expect(finds('torque oscilloscope', task)).toBe(false)
  })

  it('matches only the last term as a prefix, and only at the start of a word', () => {
    const task = { title: 'Calibrate the torque sensor' }
    expect(finds('torque sens', task)).toBe(true)
    expect(finds('sens torque', task)).toBe(false)
    expect(finds('cal', task)).toBe(true)
    expect(finds('alibrate', task)).toBe(false)
    expect(finds('cal', { description: 'recalibrate' })).toBe(false)
    expect(finds('torq', { description: 'the torque-sensor' })).toBe(true)
  })

  it('keeps the words of the stored text when it compares lowercase', () => {
    // İstanbul is one word, so none of its parts is a word of its own
    for (const where of ['title', 'description'] as const) {
      expect(finds('stanbul', { [where]: 'trip to İstanbul' })).toBe(false)
      expect(finds('İstanbul', { [where]: 'trip to İstanbul' })).toBe(true)
      expect(finds('istanbul', { [where]: 'trip to İstanbul' })).toBe(false)
      // a capital sigma before an apostrophe and a letter ends its word
      expect(finds('οδος', { [where]: "ΟΔΟΣ'Α plan" })).toBe(true)
      expect(finds('οδοσ', { [where]: "ΟΔΟΣ'Α plan" })).toBe(false)
    }
    // a text without those capitals is lowercased whole
    expect(finds('οδος', { description: 'η οδος.' })).toBe(true)
  })

  it('matches no word Convex does not index, not even by its start', () => {
    const long = 'Supercalifragilisticexpialidocious'
    expect(finds('supercal', { title: long })).toBe(false)
    expect(finds('supercal', { description: `the ${long} plan` })).toBe(false)
    expect(finds('supercal', { description: `the ${long} plan and supercalm` })).toBe(true)
  })

  it('matches nothing without terms', () => {
    expect(finds('', { title: 'Anything' })).toBe(false)
  })
})

describe('scoreOf', () => {
  /* Each list from best to worst. */
  const ranked = (text: string, tasks: Partial<SearchFields>[]) => {
    const scores = tasks.map((task) => score(text, task))
    for (const task of tasks) expect(finds(text, task)).toBe(true)
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThan(scores[i])
  }

  it('ranks the tiers: reference, equal title, phrase, all in title, split, description', () => {
    ranked('12', [
      { num: 12, title: 'Unrelated' },
      { num: 7, title: '12' },
      { num: 8, title: 'Board 12 rev' },
    ])
    ranked('torque sensor', [
      { title: 'Torque sensor' },
      { title: 'Calibrate the torque sensor' },
      { title: 'Sensor for torque' },
      { title: 'Torque rig', description: 'the sensor drifts' },
      { title: 'Calibration', description: 'the torque sensor drifts' },
    ])
  })

  it('ranks within a tier: whole words first, then an earlier phrase, then a shorter title', () => {
    // whole word above a prefix in the same tier
    ranked('sensor', [{ title: 'Sensor housing rev B' }, { title: 'Sensors' }])
    // an earlier phrase first
    ranked('torque sensor', [
      { title: 'Torque sensor drifts on the bench' },
      { title: 'Recheck torque sensor' },
    ])
    // a shorter title first
    ranked('torque', [{ title: 'Torque rig' }, { title: 'Torque rig and bench' }])
  })

  it('does not count the title length of a match only in the description', () => {
    expect(score('bench', { title: 'Short', description: 'bench' })).toBe(
      score('bench', { title: 'A much longer unrelated title', description: 'bench' }),
    )
  })

  it('is an integer, and the description tier stays below every title tier', () => {
    const best = score('bench', { title: '', description: 'bench' })
    const worstTitle = score('x', { title: `x${' y'.repeat(4000)}` })
    expect(Number.isInteger(best)).toBe(true)
    expect(best).toBeLessThan(2e7)
    expect(worstTitle).toBeGreaterThanOrEqual(3e7)
  })
})

describe('readableText', () => {
  it('leaves out mention ids, image sources and link destinations', () => {
    const words = (md: string) => wordsOf(readableText(md))
    expect(words(`@[Nora Lindqvist](user:${UUID}) owns it`)).toEqual([
      'nora',
      'lindqvist',
      'owns',
      'it',
    ])
    expect(words(`![plan](att:${UUID})`)).toEqual(['plan'])
    expect(words('[docs](https://example.com/guide)')).toEqual(['docs'])
  })

  it('keeps text, code, link text, alt text, mention names and bare autolinks', () => {
    const text = readableText(
      `**Bold** \`calibrate()\` [the guide](https://a.io) ![wiring diagram](att:${UUID}) @[Leo](user:${UUID}) see https://example.com/x`,
    )
    for (const word of ['bold', 'calibrate', 'guide', 'wiring', 'leo', 'example'])
      expect(wordsOf(text)).toContain(word)
    expect(wordsOf(text)).not.toContain('user')
    expect(wordsOf(text)).not.toContain('att')
    expect(wordsOf(text)).not.toContain('a')
  })

  it('answers a text with nothing hidden as it is, unparsed', () => {
    const text = '**Bold** and `code` but no link, 1. not a list'
    expect(hidesWords(text)).toBe(false)
    expect(readableText(text)).toBe(text)
  })

  it("leaves out a code fence's language and a numbered list's numbers", () => {
    const words = (md: string) => wordsOf(readableText(md))
    for (const md of ['```kotlin\nfun main()\n```', '  ```kotlin\nfun main()\n```'])
      expect(words(md)).toEqual(['fun', 'main'])
    expect(words('1. first\n2) second\n10. tenth')).toEqual(['first', 'second', 'tenth'])
    // they hide words without a link, so the text is parsed
    expect(hidesWords('```kotlin\nx\n```')).toBe(true)
    expect(hidesWords('1. first')).toBe(true)
  })

  it('holds only words of the stored text, which main Search reads first', () => {
    const subset = (md: string) => {
      const stored = new Set(wordsOf(md))
      for (const word of wordsOf(readableText(md))) expect(stored).toContain(word)
    }
    fc.assert(fc.property(hostileString, subset), { numRuns: RUNS })
    fc.assert(
      fc.property(docArb, (doc) => subset(astToMd(doc))),
      { numRuns: RUNS },
    )
  })
})
