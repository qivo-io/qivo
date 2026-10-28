/* The name key is the form of a name that name-ordered lists sort and search
 * by (schema.ts `name_key` on profiles, teams, projects and the rows that
 * copy a profile's or a team's, and on agent keys, personal tokens, connected
 * apps and the usage rows that name a credential). Lists order by the key's bytes, as Convex
 * orders strings in an index (UTF-8), with an id to break ties, so the order
 * differs slightly from the browser's localeCompare for some scripts. It has
 * no server-only imports, so the app can import it to normalize a search term
 * the same way. */

/* The combining diacritical marks that act as accents, in their five
 * Unicode blocks. Other marks, such as Devanagari vowel signs or the kana
 * voicing marks, make another letter, so they stay. */
const ACCENTS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g

/** `name` as lists sort and match it. It takes Unicode NFKD, removes the
 * accents (ACCENTS), so "Café" and "Cafe" compare equal, lowercases, turns
 * every run of whitespace into one space and trims. Applying it to a key
 * gives the same key. */
export function nameKey(name: string): string {
  return name.normalize('NFKD').replace(ACCENTS, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** `name` with its key, as a row that stores both writes them. */
export const named = (name: string): { name: string; name_key: string } => ({
  name,
  name_key: nameKey(name),
})
