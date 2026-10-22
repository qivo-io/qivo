/* The server's checks of the registry's limits (lib/limits.ts). Every model
 * write that takes a limited value calls one of these, so the app, REST and
 * MCP refuse it with the same `rule` sentence. */

import { address, asciiEmail } from './email'
import { rule } from './functions'
import { LIMITS, type Limit, outsideWhole, overText, trimMarkdown } from './limits'

/** `raw` trimmed, the text to store. Refuses a text over `limit`. */
export function limitedText(limit: Limit, raw: string): string {
  const text = raw.trim()
  if (overText(limit, text)) throw rule(limit.refusal)
  return text
}

/** `raw` as Markdown text is stored (lib/limits.ts trimMarkdown). Refuses
 * a text over `limit`. */
export function limitedMarkdown(limit: Limit, raw: string): string {
  const text = trimMarkdown(raw)
  if (overText(limit, text)) throw rule(limit.refusal)
  return text
}

/** `n` when it is a whole number within `limit`'s range, else refused. */
export function limitedWhole(limit: Limit, n: number): number {
  if (outsideWhole(limit, n)) throw rule(limit.refusal)
  return n
}

/** `n` when it is a finite number within `limit`'s range, else refused. */
export function limitedNumber(limit: Limit, n: number): number {
  if (!Number.isFinite(n) || n < (limit.min ?? 0) || n > limit.max) throw rule(limit.refusal)
  return n
}

/** The address to store for `raw` (lib/email.ts cleanEmail). Refuses an
 * address longer than LIMITS.email with its sentence and any other address
 * Qivo cannot mail with `notAddress`, the caller's own sentence. */
export function limitedEmail(raw: string, notAddress: string): string {
  const email = asciiEmail(raw)
  if (overText(LIMITS.email, email)) throw rule(LIMITS.email.refusal)
  if (address(email) === null) throw rule(notAddress)
  return email
}
