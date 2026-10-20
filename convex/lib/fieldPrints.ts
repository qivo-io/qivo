/* Field prints: a short fingerprint of one field's value in the form the
 * field check compares (model/expected.ts). The app sends the print of a
 * long text it saw, a task title or description or a comment body, instead
 * of the text, so an edit never carries the text twice. Each task activity
 * row stores the print of every field its write changed
 * (activity_events.field_prints), so a refusal can tell who wrote the value
 * now stored. No imports, so the app can import this file. */

/** The refusal reason of an edit over a field someone else changed
 * (model/expected.ts). It differs from `write_conflict`, which means "send
 * the same request again". */
export const FIELD_CHANGED = 'field_changed'

/** The compare form of a title, a name or a comment body: trimmed, with
 * null for unset. */
export const trimmedForm = (value: unknown): string | null =>
  value == null ? null : String(value).trim()

/** The compare form of a description: an empty one is null, otherwise the
 * text exactly, because descriptions are stored untrimmed. */
export const descriptionForm = (value: unknown): string | null =>
  value == null || value === '' ? null : String(value)

/* cyrb53 (public domain, bryc): a fast 53-bit string hash. It is not
 * cryptographic. A collision could only let a stale edit through, and only
 * by chance, because people write only through paths that log their own
 * activity row. */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** The print of a value already in its compare form: the hash of its JSON,
 * in base 36. Undefined prints as null. */
export const printOf = (value: unknown): string =>
  cyrb53(JSON.stringify(value ?? null)).toString(36)
