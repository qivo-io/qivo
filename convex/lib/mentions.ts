/* The mentions in a task description or comment, read the same way by the
 * server's notify fan-out (model/messages.ts) and the app's save-time check.
 * It imports only the import-free registry, so the app can import it too. */

import { LIMITS } from './limits'

/* extract_mentions (0075:34-49 — the survey quotes 0074's obsolete regex).
 * Code contexts are stripped first (the dialect renders them literally):
 * ``` fences to the closer or EOF, then single-line backtick spans. Then
 * `@[label](user:uuid)` — case-INSENSITIVE (USER: matches, uppercase hex
 * folds), label charset [^][]* (no brackets), dest padding by spaces/tabs.
 * A plain [x](user:...) link is NOT a mention. */
const FENCE_RE = /```[\s\S]*?(```|$)/g
const SPAN_RE = /`[^`\n]*`/g
const MENTION_RE =
  /@\[[^\][]*\]\([ \t]*user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*\)/gi

/** The distinct uuids `text` mentions, lowercase, in order, at most `max`
 * of them. */
export function mentionIds(text: string, max = Infinity): string[] {
  const stripped = (text ?? '').replace(FENCE_RE, ' ').replace(SPAN_RE, ' ')
  const seen = new Set<string>()
  for (const match of stripped.matchAll(MENTION_RE)) {
    if (seen.size >= max) break
    seen.add(match[1].toLowerCase())
  }
  return [...seen]
}

/** Whether `text` mentions more distinct people than LIMITS.mentions
 * allows. A text that does is refused with LIMITS.mentions.refusal, so a
 * comment or description reads at most that many profiles to resolve its
 * mentions. */
export const tooManyMentions = (text: string): boolean =>
  mentionIds(text, LIMITS.mentions.max + 1).length > LIMITS.mentions.max
