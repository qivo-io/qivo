/* The words of main Search (search.ts, lib/mainSearch.ts): the terms of a
 * search text, whether a task's number, title and readable description hold
 * every one of them, and the score that ranks the matches. The project
 * results of main Search score a project's name as a title, on the same
 * scale. It has no server-only imports, so the app can import it to read a
 * search text the same way. */

/* A word as Convex's search index cuts it from a text: a run of letters
 * (Unicode Alphabetic, which takes in the vowel signs and other marks that
 * are part of a letter) and digits (Unicode Number). Every other character,
 * a hyphen, an apostrophe, an underscore, an accent left combining after its
 * letter, ends a word, as in Tantivy's SimpleTokenizer, which Convex uses.
 * A local backend probe (2026-10-29) split "torque-sensor", "Nora's",
 * "snake_case" and "QN-482", kept "rev2board" as one word, and kept a text
 * without spaces, such as Japanese, as one word. */
const WORD = /[\p{Alphabetic}\p{N}]+/gu

/** A task reference as the search box takes it, QN-482 or a bare 482, when
 * it is one whitespace-separated piece of the text. */
const TASK_REF = /^(?:QN-)?(\d+)$/i

/* The highest task number, as task references elsewhere read them
 * (lib/core.ts parseIssueRef). */
const NUM_MAX = 2_147_483_647

/** How many terms Convex's search takes in one query. A text with more
 * passes the first ones to Convex, and the server's own check still
 * requires every term (matchesTerms). */
export const CONVEX_TERMS = 16

/** One term of a search text. `word` is the term as a word of a text
 * matches it (wordOf). A reference term (`num` present) is the digits of a
 * task reference and matches the task with that number, null for a number
 * no task can have, or a word equal to its digits. Every other term matches
 * a word equal to it, or one that starts with it when it is the text's last
 * term (`prefix`). */
export type SearchTerm = { word: string; prefix: boolean; num?: number | null }

/** `word` as search compares it: lowercase, as Convex compares words.
 * Convex does not fold accents ("cafe" does not find "café", checked on a
 * local backend), so neither does this, or the server would accept words
 * Convex never returns. */
export const wordOf = (word: string): string => word.toLowerCase()

/** The words of `text` as search compares them (wordOf), in order. */
export const wordsOf = (text: string): string[] =>
  Array.from(text.matchAll(WORD), (m) => wordOf(m[0]))

/**
 * The terms of search text `text`, distinct, in the order they first
 * appear. A whitespace-separated piece that is a task reference (QN-482 or
 * 482) is one reference term, and every other piece adds its words
 * (wordsOf). The last term is marked as a prefix. A text with no word, such
 * as one of punctuation only, has no terms.
 */
export function searchTerms(text: string): SearchTerm[] {
  const out: SearchTerm[] = []
  const seen = new Set<string>()
  const add = (term: Omit<SearchTerm, 'prefix'>) => {
    const key = `${term.num === undefined ? 'w' : 'n'}:${term.word}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ ...term, prefix: false })
  }
  for (const piece of text.split(/\s+/)) {
    const ref = TASK_REF.exec(piece)
    if (ref !== null) {
      const num = Number(ref[1])
      add({ word: ref[1], num: num >= 1 && num <= NUM_MAX ? num : null })
      continue
    }
    for (const word of wordsOf(piece)) add({ word })
  }
  if (out.length > 0) out[out.length - 1].prefix = true
  return out
}

/** The text a Convex search query takes for `terms`: the first
 * CONVEX_TERMS of them, each as its word, so a reference term finds a word
 * equal to its digits, and the last as Convex's prefix term. */
export const convexText = (terms: readonly SearchTerm[]): string =>
  terms
    .slice(0, CONVEX_TERMS)
    .map((term) => term.word)
    .join(' ')

/** What search reads of one task, or of a project by its name as `title`:
 * its number, its title and its readable description (lib/md.ts
 * readableText). */
export type SearchFields = { num?: number; title: string; description: string }

/* A word character, as WORD reads one. */
const LETTER = '[\\p{Alphabetic}\\p{N}]'

/* The patterns that find `word` in a lowercased text: as a whole word, and
 * as the start of one. A word holds letters and digits only, so it needs no
 * escaping. Kept per word, as one call tests many texts. */
const patterns = new Map<string, { whole: RegExp; start: RegExp }>()
function patternsOf(word: string): { whole: RegExp; start: RegExp } {
  let known = patterns.get(word)
  if (known === undefined) {
    known = {
      whole: new RegExp(`(?<!${LETTER})${word}(?!${LETTER})`, 'u'),
      start: new RegExp(`(?<!${LETTER})${word}`, 'u'),
    }
    if (patterns.size > 256) patterns.clear()
    patterns.set(word, known)
  }
  return known
}

/* How one term matches a task: by its number or in its title, which rank
 * alike, or only in its description, and whether only as a prefix there. */
type Place = { where: 'title' | 'description'; whole: boolean }

/* Whether `words` holds a word `term` matches, and whether whole. */
function inWords(term: SearchTerm, words: readonly string[]): { whole: boolean } | null {
  let started = false
  for (const word of words) {
    if (word === term.word) return { whole: true }
    if (term.prefix && term.num === undefined && word.startsWith(term.word)) started = true
  }
  return started ? { whole: false } : null
}

/* inWords over `text`, lowercased, without splitting it into words, which
 * costs a description of 20,000 characters about 20 times as much. A
 * character whose lowercase adds a mark that is no letter, such as the
 * dotted capital I, can end a word here inside a word Convex keeps whole. */
function inText(term: SearchTerm, text: string): { whole: boolean } | null {
  const { whole, start } = patternsOf(term.word)
  if (whole.test(text)) return { whole: true }
  return term.prefix && term.num === undefined && start.test(text) ? { whole: false } : null
}

/* The words of a task's title and its lowercased description, which every
 * term reads. */
type Prepared = { num?: number; title: string[]; description: string }

const prepare = (fields: SearchFields): Prepared => ({
  num: fields.num,
  title: wordsOf(fields.title),
  description: fields.description.toLowerCase(),
})

/* Where `term` matches `fields`, the best place first, or null. */
function placeOf(term: SearchTerm, fields: Prepared): Place | null {
  if (term.num != null && term.num === fields.num) return { where: 'title', whole: true }
  const title = inWords(term, fields.title)
  if (title?.whole) return { where: 'title', whole: true }
  const description = inText(term, fields.description)
  if (description?.whole && title === null) return { where: 'description', whole: true }
  if (title !== null) return { where: 'title', whole: false }
  return description === null ? null : { where: 'description', whole: description.whole }
}

/**
 * Whether `fields` holds every one of `terms`. A word term matches a whole
 * word of the title or the readable description, or the start of one when
 * it is the last term; a reference term matches the task's number or a
 * word equal to its digits. Convex's search matches any term, so the server
 * checks every candidate with this. It compares words as Convex does
 * (wordsOf), with one difference. Convex leaves every word of 32 bytes or
 * more (UTF-8) out of its index and its queries, so such a word never draws
 * a candidate, where this still finds it in a candidate another term drew.
 */
export function matchesTerms(terms: readonly SearchTerm[], fields: SearchFields): boolean {
  const prepared = prepare(fields)
  return terms.length > 0 && terms.every((term) => placeOf(term, prepared) !== null)
}

/* The tiers of scoreOf, best last. */
const TIER = {
  /** every term is only in the description */
  description: 1,
  /** the terms are split between the title (or the number) and the
   * description */
  split: 2,
  /** every term is in the title or is the number */
  title: 3,
  /** the title holds the terms as a phrase, in order */
  phrase: 4,
  /** the title is the terms, nothing more */
  equal: 5,
  /** the whole text is the task's reference */
  reference: 6,
}

/* Where the terms start as a phrase in `title`, the last allowed to be a
 * prefix, or -1. */
function phraseAt(terms: readonly SearchTerm[], title: readonly string[]): number {
  const last = terms.length - 1
  for (let at = 0; at + terms.length <= title.length; at++) {
    const fits = terms.every((term, i) =>
      i === last && term.prefix && term.num === undefined
        ? title[at + i].startsWith(term.word)
        : title[at + i] === term.word,
    )
    if (fits) return at
  }
  return -1
}

/**
 * The score of a match of `terms` in `fields` (matchesTerms holds), higher
 * first. The tier comes first: the whole text is the task's reference
 * (reference); the title is the text (equal); the title holds the terms as
 * a phrase in order (phrase); every term is in the title or is the number
 * (title); the terms are split between the title or number and the
 * description (split); every term is only in the description (description).
 * Within a tier a match with no term matched only as a prefix comes first,
 * then a phrase earlier in the title, then a shorter title, counted in
 * characters. The description tier does not count the
 * title's length, as main Search ranks such a match before it reads the
 * task's title. An integer below 10^8: tier × 10^7 + whole × 10^6 +
 * (99 − phrase start) × 10^4 + (9,999 − title length).
 */
export function scoreOf(terms: readonly SearchTerm[], fields: SearchFields): number {
  const prepared = prepare(fields)
  const places = terms.map((term) => placeOf(term, prepared))
  const inTitle = places.filter((place) => place?.where === 'title').length
  const whole = places.every((place) => place?.whole) ? 1 : 0
  let tier: number = TIER.split
  let start = 0
  if (terms.length === 1 && terms[0].num != null && terms[0].num === fields.num)
    tier = TIER.reference
  else if (inTitle === 0) tier = TIER.description
  else if (inTitle === terms.length) {
    const at = phraseAt(terms, prepared.title)
    if (at < 0) tier = TIER.title
    else if (
      prepared.title.length === terms.length &&
      terms.every((term, i) => prepared.title[i] === term.word)
    )
      tier = TIER.equal
    else {
      tier = TIER.phrase
      start = at
    }
  }
  const length = tier === TIER.description ? 9_999 : Math.min(fields.title.length, 9_999)
  return tier * 1e7 + whole * 1e6 + (99 - Math.min(start, 99)) * 1e4 + (9_999 - length)
}
