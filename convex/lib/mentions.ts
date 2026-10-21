/* The mentions in a task description or comment, read the same way by the
 * server's notify fan-out (model/messages.ts) and the app's save-time check.
 * No imports, so the app can import this file as it does textLimits.ts.
 *
 * extract_mentions (0075:34-49 — the survey quotes 0074's obsolete regex).
 * Code contexts are stripped first (the dialect renders them literally):
 * ``` fences to the closer or EOF, then single-line backtick spans. Then
 * `@[label](user:uuid)` — case-INSENSITIVE (USER: matches, uppercase hex
 * folds), label charset [^][]* (no brackets), dest padding by spaces/tabs.
 * A plain [x](user:...) link is NOT a mention. */
const FENCE_RE = /```[\s\S]*?(```|$)/g
const SPAN_RE = /`[^`\n]*`/g
const MENTION_RE =
  /@\[[^\][]*\]\([ \t]*user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*\)/gi

/** The most distinct people one text may mention, so a comment or
 * description reads at most this many profiles to resolve its mentions. A
 * text that mentions more is refused with TOO_MANY_MENTIONS. */
export const MENTION_MAX = 100

/** The refusal of a text that mentions more than MENTION_MAX people. A
 * `rule`, so the app shows it; REST and MCP answer it as written. */
export const TOO_MANY_MENTIONS = `a text can mention at most ${MENTION_MAX} people; remove some mentions and save again`

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

/** Whether `text` mentions more than MENTION_MAX distinct people. */
export const tooManyMentions = (text: string): boolean =>
  mentionIds(text, MENTION_MAX + 1).length > MENTION_MAX
